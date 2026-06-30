import React, { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import emailjs from "@emailjs/browser";
import bcrypt from "bcryptjs";

// ─── EmailJS config ───────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = "service_bq4x4x5";
const EMAILJS_TEMPLATE_ID = "template_a32sv1q";
const EMAILJS_PUBLIC_KEY  = "qKocC8xi1FyxVNJMl";

// ─── Supabase REST client ─────────────────────────────────────────────────────
// FIX: credentials now read from Vercel environment variables first,
// falling back to the hardcoded values so the app still works if env vars
// haven't been set up yet.
const SUPA_URL  = import.meta.env.VITE_SUPA_URL  || "https://atdnqqwezsmvnpzfzkep.supabase.co";
const SUPA_ANON = import.meta.env.VITE_SUPA_ANON || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0ZG5xcXdlenNtdm5wemZ6a2VwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MjM1NjksImV4cCI6MjA5NzE5OTU2OX0.zGAHiI11hH8_9-JXoMOKVkI1xaRBZf73O469CJlKtTk";
const HEADERS = {
  "Content-Type": "application/json",
  "apikey": SUPA_ANON,
  "Authorization": `Bearer ${SUPA_ANON}`,
};

// ─── Password helpers ─────────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 10;
const isHashed    = (pw) => typeof pw === "string" && pw.startsWith("$2");
const hashPw      = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);
const verifyPw    = async (plain, stored) => {
  // FIX: handles both hashed (new) and plain-text (legacy) passwords.
  // On successful plain-text match, we return a signal to migrate the hash.
  if (isHashed(stored)) return { ok: await bcrypt.compare(plain, stored), needsMigration: false };
  const ok = plain === stored;
  return { ok, needsMigration: ok }; // plain match → needs upgrading
};

// ─── Login attempt lockout ────────────────────────────────────────────────────
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes
const LockoutStore  = {
  key: (empId) => `cc_lock_${empId.toLowerCase()}`,
  get: (empId) => { try { return JSON.parse(localStorage.getItem(LockoutStore.key(empId))) || { attempts: 0, lockedUntil: 0 }; } catch { return { attempts: 0, lockedUntil: 0 }; } },
  set: (empId, data) => localStorage.setItem(LockoutStore.key(empId), JSON.stringify(data)),
  clear: (empId) => localStorage.removeItem(LockoutStore.key(empId)),
  isLocked: (empId) => {
    const { lockedUntil } = LockoutStore.get(empId);
    return lockedUntil > Date.now();
  },
  lockedSecondsLeft: (empId) => {
    const { lockedUntil } = LockoutStore.get(empId);
    return Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
  },
  recordFail: (empId) => {
    const data = LockoutStore.get(empId);
    data.attempts = (data.attempts || 0) + 1;
    if (data.attempts >= MAX_ATTEMPTS) data.lockedUntil = Date.now() + LOCKOUT_MS;
    LockoutStore.set(empId, data);
    return data.attempts;
  },
};

// ─── Submission cutoff checker ────────────────────────────────────────────────
// Rules:
//   Morning shifts (6AM-3PM, 8AM-5PM)  → must apply by 8:00 PM the DAY BEFORE
//   Evening shifts (3PM-12AM, 11AM-8PM) → must apply by 6:00 PM same day
//   Night shift   (7PM-6AM)             → must apply by 9:00 PM same day
//   Admins (role === "admin")           → always bypass cutoff
const MORNING_SHIFTS = ["6AM - 3PM", "8AM - 5PM"];
const EVENING_SHIFTS = ["3PM - 12AM", "11AM - 8PM"];
const NIGHT_SHIFTS   = ["7PM - 6AM"];

const checkSubmissionCutoff = (date, shift) => {
  if (!date || !shift) return { blocked: false };
  const today = todayStr();
  const now   = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  // Past dates always blocked for new submissions
  if (date < today) return {
    blocked: true,
    reason: "Applications for past dates are not allowed.",
    deadline: null,
  };

  if (date === today) {
    if (MORNING_SHIFTS.includes(shift)) return {
      blocked: true,
      reason: "Morning shift applications must be submitted by 8:00 PM the previous day. The deadline has passed.",
      deadline: "8:00 PM previous day",
    };
    if (EVENING_SHIFTS.includes(shift) && nowMins >= 18 * 60) return {
      blocked: true,
      reason: "Applications for this shift closed at 6:00 PM today.",
      deadline: "6:00 PM today",
    };
    if (NIGHT_SHIFTS.includes(shift) && nowMins >= 21 * 60) return {
      blocked: true,
      reason: "Applications for the 7PM-6AM shift closed at 9:00 PM today.",
      deadline: "9:00 PM today",
    };
  }

  if (date > today) {
    // For future dates, morning shifts: deadline is 8PM the day before (i.e. today if tomorrow)
    if (MORNING_SHIFTS.includes(shift)) {
      const shiftDay  = new Date(date);
      const prevDay   = new Date(shiftDay);
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = prevDay.toISOString().split("T")[0];
      if (prevDayStr < today) return {
        blocked: true,
        reason: "The application deadline for this morning shift has already passed (8:00 PM the previous day).",
        deadline: "8:00 PM previous day",
      };
      if (prevDayStr === today && nowMins >= 20 * 60) return {
        blocked: true,
        reason: "Applications for tomorrow's morning shift closed at 8:00 PM today.",
        deadline: "8:00 PM today",
      };
    }
  }

  // Not blocked — calculate time remaining for info display
  let deadline = null;
  if (date === today) {
    if (EVENING_SHIFTS.includes(shift)) deadline = "6:00 PM today";
    if (NIGHT_SHIFTS.includes(shift))   deadline = "9:00 PM today";
  }
  if (date > today && MORNING_SHIFTS.includes(shift)) deadline = "8:00 PM the day before";

  return { blocked: false, deadline };
};

const supa = async (method, table, { filter = "", body = null, single = false } = {}) => {
  const url = `${SUPA_URL}/rest/v1/${table}${filter ? "?" + filter : ""}`;
  const h = { ...HEADERS };
  if (single) h["Accept"] = "application/vnd.pgrst.object+json";
  else h["Accept"] = "application/json";
  if (method === "POST" || method === "PATCH") h["Prefer"] = "return=representation";
  if (method === "POST" && single) h["Prefer"] = "return=representation,resolution=merge-duplicates";
  const res = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok && res.status !== 406) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${table}: ${err}`);
  }
  if (res.status === 204 || res.status === 406) return null;
  return res.json();
};

// ─── Session ──────────────────────────────────────────────────────────────────
const Session = {
  get: () => { try { return JSON.parse(localStorage.getItem("cc_session")); } catch { return null; } },
  set: (v) => localStorage.setItem("cc_session", JSON.stringify(v)),
  clear: () => localStorage.removeItem("cc_session"),
};

const uid = () => Math.random().toString(36).slice(2, 9);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const nowYear = () => new Date().getFullYear();
const nowMonth = () => new Date().getMonth() + 1;

// ─── DB helpers ───────────────────────────────────────────────────────────────
const DB = {
  getUsers: async () => {
    const d = await supa("GET", "cc_users", { filter: "select=*" });
    return (d || []);
  },
  getUserById: async (id) => {
    const d = await supa("GET", "cc_users", { filter: `select=*&id=eq.${id}`, single: true });
    return d;
  },
  getUserByEmpId: async (empId) => {
    const d = await supa("GET", "cc_users", { filter: `select=*&emp_id=eq.${encodeURIComponent(empId)}`, single: true });
    return d;
  },
  createUser: async (u) => {
    await supa("POST", "cc_users", { body: dbUser(u) });
  },
  updateUser: async (u) => {
    await supa("PATCH", "cc_users", { filter: `id=eq.${u.id}`, body: dbUser(u) });
  },
  getApps: async () => {
    const d = await supa("GET", "cc_apps", { filter: "select=*&order=submitted_at.desc" });
    return (d || []).map(appFromDb);
  },
  getUserApps: async (userId) => {
    const d = await supa("GET", "cc_apps", { filter: `select=*&user_id=eq.${userId}&order=submitted_at.desc` });
    return (d || []).map(appFromDb);
  },
  createApp: async (a) => {
    await supa("POST", "cc_apps", { body: dbApp(a) });
  },
  deleteApp: async (id) => {
    await supa("DELETE", "cc_apps", { filter: `id=eq.${id}` });
  },
  updateApp: async (id, fields) => {
    await supa("PATCH", "cc_apps", { filter: `id=eq.${id}`, body: fields });
  },
  getAdminWhitelist: async () => {
    const d = await supa("GET", "cc_settings", { filter: "select=value&key=eq.admin_whitelist", single: true });
    try { return JSON.parse(d?.value || "[]"); } catch { return []; }
  },
  setAdminWhitelist: async (list) => {
    await supa("POST", "cc_settings", { body: { key: "admin_whitelist", value: JSON.stringify(list) }, single: true });
  },
  getAdmins: async () => {
    const d = await supa("GET", "cc_users", { filter: "select=*&role=eq.admin&order=created_at.desc" });
    return (d || []).map(userFromDb);
  },
  // FIX: forgot-password OTP helpers
  setResetOtp: async (id, code, expiresAt) => {
    await supa("PATCH", "cc_users", { filter: `id=eq.${id}`, body: { reset_otp: code, reset_otp_expires: expiresAt } });
  },
  setPassword: async (id, password) => {
    // resets password and clears any pending OTP in one step
    await supa("PATCH", "cc_users", { filter: `id=eq.${id}`, body: { password, reset_otp: null, reset_otp_expires: null } });
  },
  deleteUser: async (id) => {
    await supa("DELETE", "cc_users", { filter: `id=eq.${id}` });
  },
  // FIX: lightweight activity timestamp update — used on login and on request submission
  touchActivity: async (id) => {
    try {
      await supa("PATCH", "cc_users", { filter: `id=eq.${id}`, body: { last_active: new Date().toISOString() } });
    } catch (e) {
      console.warn("touchActivity failed:", e.message);
    }
  },
  // FIX: deletes employee accounts (never admins) inactive for 30+ days.
  // "Inactive" = no login and no transport/dinner submission in 30 days.
  // Falls back to created_at if last_active was never set (e.g. registered but never logged in).
  cleanupInactiveEmployees: async () => {
    try {
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const rawUsers = await DB.getUsers();
      const stale = rawUsers.filter(u => {
        if (u.role === "admin") return false; // never auto-delete admins/team leaders
        const ref = u.last_active || u.created_at;
        if (!ref) return false;
        return new Date(ref).getTime() < cutoff;
      });
      for (const u of stale) {
        // clean up their submissions too, then the account itself
        await supa("DELETE", "cc_apps", { filter: `user_id=eq.${u.id}` }).catch(() => {});
        await supa("DELETE", "cc_users", { filter: `id=eq.${u.id}` }).catch(() => {});
      }
      return stale.length;
    } catch (e) {
      console.warn("cleanupInactiveEmployees failed:", e.message);
      return 0;
    }
  },
  // FIX: auto-delete transport/dinner submissions older than 90 days
  // and remove roster months older than 60 days from every user's roster_data.
  // Keeps the database lean without any manual intervention.
  cleanupOldData: async () => {
    try {
      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
      const SIXTY_DAYS_MS  = 60 * 24 * 60 * 60 * 1000;

      // 1. Delete cc_apps submissions older than 90 days
      const submissionCutoff = new Date(Date.now() - NINETY_DAYS_MS);
      const submissionCutoffStr = submissionCutoff.toISOString().split("T")[0];
      await supa("DELETE", "cc_apps", { filter: `date=lt.${submissionCutoffStr}` }).catch(() => {});

      // 2. Strip roster months older than 60 days from every user's roster_data
      const rosterCutoff = new Date(Date.now() - SIXTY_DAYS_MS);
      const rosterCutoffKey = `${rosterCutoff.getFullYear()}-${String(rosterCutoff.getMonth() + 1).padStart(2, "0")}`;
      const rawUsers = await DB.getUsers();
      for (const u of rawUsers) {
        const rd = u.roster_data || {};
        const keys = Object.keys(rd);
        const freshKeys = keys.filter(k => k >= rosterCutoffKey);
        if (freshKeys.length < keys.length) {
          const trimmed = {};
          freshKeys.forEach(k => { trimmed[k] = rd[k]; });
          await supa("PATCH", "cc_users", {
            filter: `id=eq.${u.id}`,
            body: { roster_data: trimmed }
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("cleanupOldData failed:", e.message);
    }
  },
  getSetting: async (key) => {
    const d = await supa("GET", "cc_settings", { filter: `select=value&key=eq.${key}`, single: true });
    return d?.value;
  },
  setSetting: async (key, val) => {
    await supa("POST", "cc_settings", { body: { key, value: val }, single: true });
  },
  // FIX: cutoff enforcement toggle — stored as "true"/"false" in cc_settings
  getCutoffEnabled: async () => {
    const d = await supa("GET", "cc_settings", { filter: "select=value&key=eq.cutoff_enabled", single: true });
    return d?.value !== "false"; // defaults to enabled if not set
  },
  setCutoffEnabled: async (enabled) => {
    await supa("POST", "cc_settings", { body: { key: "cutoff_enabled", value: String(enabled) }, single: true });
  },
  seedAdmin: async () => {
    try {
      const d = await supa("GET", "cc_users", { filter: "select=id&emp_id=eq.ADMIN", single: true }).catch(() => null);
      if (!d) {
        await supa("POST", "cc_users", {
          body: {
            id: uid(), name: "Administrator", emp_id: "ADMIN", password: "admin123",
            role: "admin", phone: "", addresses: [], roster_data: {}, created_at: todayStr()
          }
        });
      }
    } catch (e) {
      console.warn("seedAdmin failed (tables may not exist yet):", e.message);
    }
  },
};

// ─── Shape converters ─────────────────────────────────────────────────────────
const dbUser = (u) => ({
  id: u.id, name: u.name, emp_id: u.empId, password: u.password,
  role: u.role, phone: u.phone || "", email: u.email || "",
  addresses: u.addresses || [], roster_data: u.rosterData || {},
  created_at: u.createdAt || todayStr(),
  last_active: u.lastActive || new Date().toISOString(),
});
const userFromDb = (r) => ({
  id: r.id, name: r.name, empId: r.emp_id, password: r.password,
  role: r.role, phone: r.phone || "", email: r.email || "",
  addresses: r.addresses || [], rosterData: r.roster_data || {},
  createdAt: r.created_at, lastActive: r.last_active,
});
const dbApp = (a) => ({
  id: a.id, user_id: a.userId, emp_id: a.empId, emp_name: a.empName,
  date: a.date, phone: a.phone || "", shift: a.shift,
  pick_drop: a.pickDrop, address: a.address, maps_link: a.mapsLink || "",
  route: a.route, wants_dinner: a.wantsDinner || false,
  dinner_meal: a.dinnerMeal || "", entry_mode: a.entryMode || "manual",
  submitted_at: a.submittedAt || new Date().toISOString(),
});
const appFromDb = (r) => ({
  id: r.id, userId: r.user_id, empId: r.emp_id, empName: r.emp_name,
  date: r.date, phone: r.phone || "", shift: r.shift,
  pickDrop: r.pick_drop, address: r.address, mapsLink: r.maps_link || "",
  route: r.route, wantsDinner: r.wants_dinner || false,
  dinnerMeal: r.dinner_meal || "", entryMode: r.entry_mode,
  submittedAt: r.submitted_at,
});

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  deepTeal: "#0D3D56", midTeal: "#1A6B8A", cyan: "#00B4D8", cyanLight: "#E0F7FF",
  ice: "#F0F9FF", white: "#FFFFFF", text: "#1E293B", muted: "#64748B",
  border: "#CBD5E1", borderLight: "#E2E8F0",
  red: "#E03B2E", redLight: "#FEE2E0",
  green: "#0F9B6E", greenLight: "#D1FAE5",
  orange: "#D97706", orangeLight: "#FEF3C7",
  purple: "#7C3AED", purpleLight: "#EDE9FE",
  pink: "#DB2777", pinkLight: "#FCE7F3",
  grey0: "#F8FAFC", grey1: "#E2E8F0",
};

const SHIFT_MAP = {
  "06-15": { label: "6AM - 3PM",   color: C.orange, bg: C.orangeLight, ms: "6AM"  },
  "6-15":  { label: "6AM - 3PM",   color: C.orange, bg: C.orangeLight, ms: "6AM"  },
  "08-17": { label: "8AM - 5PM",   color: C.cyan,   bg: C.cyanLight,   ms: "8AM"  },
  "8-17":  { label: "8AM - 5PM",   color: C.cyan,   bg: C.cyanLight,   ms: "8AM"  },
  "11-20": { label: "11AM - 8PM",  color: C.green,  bg: C.greenLight,  ms: "11AM" },
  "15-00": { label: "3PM - 12AM",  color: C.midTeal,bg: C.cyanLight,   ms: "3PM"  },
  "19-06": { label: "7PM - 6AM",   color: C.purple, bg: C.purpleLight, ms: "7PM"  },
  "19-6":  { label: "7PM - 6AM",   color: C.purple, bg: C.purpleLight, ms: "7PM"  },
};
const SHIFT_LABELS  = ["6AM - 3PM","8AM - 5PM","3PM - 12AM","7PM - 6AM","11AM - 8PM","Other"];
const ROUTES        = ["Kandy Road","Negombo Road","Galle Road","High Level Road","Athurugiriya Road","Piliyandala Route"];
const MONTHS        = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DINNER_MEALS  = ["Chicken","Vegetable","Fish","Egg"];
const DINNER_SHIFTS = ["3PM - 12AM","7PM - 6AM","11AM - 8PM"];

const getDinnerMode = (shift) => {
  if (DINNER_SHIFTS.includes(shift)) return "eligible";
  return "none";
};

const parseShiftCode = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  const lower = s.toLowerCase().replace(/\s+/g, "");
  if (lower === "off" || lower === "roff" || lower.startsWith("off") || lower.endsWith("off")) {
    const isRest = lower.includes("r");
    return { label: isRest ? "Rest Day (OFF)" : "Day Off", off: true, color: C.muted, bg: C.grey1 };
  }
  const key = s.replace(/\s/g, "");
  if (SHIFT_MAP[key]) return { ...SHIFT_MAP[key], off: false };
  const m = key.match(/^(\d{1,2})-(\d{2})$/);
  if (m) {
    const hr = parseInt(m[1]);
    for (const [k, v] of Object.entries(SHIFT_MAP)) {
      if (k.startsWith(String(hr).padStart(2, "0")) || k.startsWith(String(hr))) return { ...v, off: false };
    }
    return { label: s, off: false, color: C.cyan, bg: C.cyanLight };
  }
  for (const lbl of SHIFT_LABELS) {
    if (lbl.toLowerCase().replace(/\s/g, "") === lower) return { label: lbl, off: false, color: C.cyan, bg: C.cyanLight };
  }
  return null;
};

const parseOrdinal = (s) => {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[^0-9]/g, ""));
  return isNaN(n) ? null : n;
};

const buildDate = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap'); *,*::before,*::after{box-sizing:border-box;margin:0;padding:0} html,body{font-family:'Plus Jakarta Sans',sans-serif;background:${C.ice};color:${C.text};font-size:14px} input,select,textarea,button{font-family:inherit} .shell{display:flex;min-height:100vh} .sidebar{width:232px;flex-shrink:0;background:linear-gradient(180deg,${C.deepTeal} 0%,${C.midTeal} 100%);display:flex;flex-direction:column} .main-area{flex:1;overflow-y:auto;padding:28px 30px;min-height:100vh} .sb-logo{display:flex;align-items:center;gap:10px;padding:22px 18px 14px} .sb-logo-icon{width:36px;height:36px;background:rgba(0,180,216,.22);border-radius:10px;display:flex;align-items:center;justify-content:center} .sb-logo-title{color:#fff;font-weight:800;font-size:15px} .sb-logo-sub{color:rgba(255,255,255,.45);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em} .sb-user{margin:0 10px 6px;background:rgba(255,255,255,.09);border-radius:10px;padding:10px 12px} .sb-user-name{color:#fff;font-weight:700;font-size:13px} .sb-user-id{color:rgba(255,255,255,.45);font-size:11px;margin-top:2px} .sb-div{height:1px;background:rgba(255,255,255,.08);margin:6px 0} .sb-nav{padding:0 8px;display:flex;flex-direction:column;gap:2px} .sb-item{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;color:rgba(255,255,255,.6);cursor:pointer;border:none;background:transparent;width:100%;text-align:left;transition:all .15s} .sb-item:hover{background:rgba(255,255,255,.09);color:#fff} .sb-item.active{background:rgba(0,180,216,.3);color:#fff} .sb-spacer{flex:1} .sb-bottom{padding:8px 8px 16px} .card{background:${C.white};border-radius:14px;box-shadow:0 1px 12px rgba(13,61,86,.07);padding:20px} .card-0{background:${C.white};border-radius:14px;box-shadow:0 1px 12px rgba(13,61,86,.07);overflow:hidden} .page-title{font-size:20px;font-weight:800;color:${C.text};margin-bottom:3px} .page-sub{font-size:13px;color:${C.muted};margin-bottom:22px} .sec-title{font-size:14px;font-weight:700;color:${C.text};margin-bottom:14px} .label{display:block;font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px} .req{color:${C.red};margin-left:2px} .input{width:100%;padding:10px 13px;border:1.5px solid ${C.border};border-radius:9px;font-size:13px;color:${C.text};outline:none;transition:border .15s} .input:focus{border-color:${C.cyan};box-shadow:0 0 0 3px rgba(0,180,216,.13)} .input::placeholder{color:${C.border}} .input-auto{border-color:${C.cyan};background:${C.cyanLight}} .input-ro{background:${C.ice};color:${C.muted};cursor:default} .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;border:none;transition:all .15s} .btn-cyan{background:${C.cyan};color:#fff}.btn-cyan:hover{background:#0099bb} .btn-red{background:${C.red};color:#fff;width:100%;justify-content:center;padding:13px;font-size:14px} .btn-outline{background:transparent;border:1.5px solid ${C.cyan};color:${C.cyan}}.btn-outline:hover{background:${C.cyanLight}} .btn-ghost{background:${C.grey0};color:${C.muted};border:1.5px solid ${C.grey1}}.btn-ghost:hover{background:${C.grey1}} .btn-sm{padding:5px 11px;font-size:11px;border-radius:7px} .btn:disabled{opacity:.38;cursor:not-allowed;pointer-events:none} .alert{padding:10px 14px;border-radius:9px;font-size:13px;font-weight:500;margin-bottom:14px} .alert-err{background:${C.redLight};color:${C.red};border-left:3px solid ${C.red}} .alert-ok{background:${C.greenLight};color:${C.green};border-left:3px solid ${C.green}} .alert-info{background:${C.cyanLight};color:${C.midTeal};border-left:3px solid ${C.cyan}} .alert-warn{background:${C.orangeLight};color:${C.orange};border-left:3px solid ${C.orange}} .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700} .badge-cyan{background:${C.cyanLight};color:${C.midTeal}} .badge-green{background:${C.greenLight};color:${C.green}} .badge-orange{background:${C.orangeLight};color:${C.orange}} .badge-red{background:${C.redLight};color:${C.red}} .badge-purple{background:${C.purpleLight};color:${C.purple}} .badge-grey{background:${C.grey1};color:${C.muted}} .tbl{width:100%;border-collapse:collapse;font-size:13px} .tbl th{background:${C.ice};color:${C.muted};font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:10px 14px;text-align:left} .tbl td{padding:11px 14px;border-bottom:1px solid ${C.grey1};vertical-align:middle} .tbl tr:last-child td{border-bottom:none} .tbl tr:hover td{background:${C.ice}} .g2{display:grid;grid-template-columns:1fr 1fr;gap:14px} .g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px} .g4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px} .col2{grid-column:1/-1} .stack{display:flex;flex-direction:column;gap:18px} .stack-sm{display:flex;flex-direction:column;gap:10px} .flex-b{display:flex;justify-content:space-between;align-items:center} .flex-g{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .tab-row{display:flex;border-bottom:2px solid ${C.grey1};margin-bottom:18px} .tab-btn{padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;border:none;background:transparent;color:${C.muted};border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s} .tab-btn.active{color:${C.cyan};border-bottom-color:${C.cyan}} .upload-zone{border:2px dashed ${C.border};border-radius:12px;padding:28px;text-align:center;cursor:pointer;transition:all .15s} .upload-zone:hover,.upload-zone.drag{border-color:${C.cyan};background:${C.cyanLight}} .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px} .cal-header{text-align:center;font-size:10px;font-weight:800;color:${C.muted};text-transform:uppercase;padding:4px 0} .cal-day{border-radius:10px;padding:7px 4px;text-align:center;border:1.5px solid ${C.grey1};transition:all .15s;min-height:52px} .cal-day.today{border-color:${C.cyan};box-shadow:0 0 0 2px rgba(0,180,216,.25)} .cal-day.off-day{background:${C.grey0};opacity:.65} .cal-day.work-day{background:${C.white};cursor:pointer}.cal-day.work-day:hover{border-color:${C.cyan};background:${C.cyanLight}} .cal-day.selected{border-color:${C.cyan};background:${C.cyanLight}} .cal-day.empty{border-color:transparent;background:transparent;min-height:0} .cal-day-num{font-size:13px;font-weight:800;color:${C.text}} .cal-shift-chip{font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;line-height:1.4;margin-top:3px;display:inline-block} .radio-group{display:flex;flex-direction:column;gap:7px} .radio-opt{display:flex;align-items:center;gap:10px;padding:9px 13px;border:1.5px solid ${C.grey1};border-radius:9px;cursor:pointer;transition:all .15s} .radio-opt:hover{border-color:${C.cyan};background:${C.cyanLight}} .radio-opt.sel{border-color:${C.cyan};background:${C.cyanLight};color:${C.deepTeal};font-weight:700} .radio-opt.disabled{opacity:.4;cursor:not-allowed;pointer-events:none} .radio-dot{width:17px;height:17px;border-radius:50%;border:2px solid ${C.border};flex-shrink:0;display:flex;align-items:center;justify-content:center} .radio-dot.on{border-color:${C.cyan};background:${C.cyan}} .radio-inner{width:6px;height:6px;border-radius:50%;background:#fff} .addr-card{border:1.5px solid ${C.grey1};border-radius:10px;padding:14px;cursor:pointer;transition:all .15s} .addr-card:hover{border-color:${C.cyan}} .addr-card.sel{border-color:${C.cyan};background:${C.cyanLight}} .route-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;background:${C.cyanLight};color:${C.midTeal};margin-top:6px} ::-webkit-scrollbar{width:5px;height:5px} ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}`;

// ─── Icons ────────────────────────────────────────────────────────────────────
const Ico = ({ n, s = 16, c = "currentColor" }) => {
  const paths = {
    bus:      "M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 001 1h1a1 1 0 001-1v-1h4v1a1 1 0 001 1h1a1 1 0 001-1v-1.78c.61-.55 1-1.34 1-2.22V5c0-2-2-4-6-4S4 3 4 5v11zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM12 10H6V5h6v5zm2 0V5h2l2 5h-4z",
    user:     "M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z",
    cal:      "M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z",
    form:     "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM16 13H8v-2h8v2zm0 4H8v-2h8v2z",
    upload:   "M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z",
    logout:   "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
    plus:     "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    check:    "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    trash:    "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    pin:      "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z",
    download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
    route:    "M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9l1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z",
    edit:     "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    team:     "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
    settings: "M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a6.98 6.98 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4c-.25 0-.46.18-.49.42l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.63 8.48a.48.48 0 00.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.37 1.04.7 1.62.94l.36 2.54c.05.24.26.42.5.42h4c.25 0 .46-.18.49-.42l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    dinner:   "M18.06 22.99h1.66c.84 0 1.53-.64 1.63-1.46L23 5.05h-5V1h-1.97v4.05h-4.97l.3 2.34c1.71.47 3.31 1.32 4.27 2.26 1.44 1.42 2.43 2.89 2.43 5.29v8.05zM1 21.99V21h15.03v.99c0 .55-.45 1-1.01 1H2.01c-.56 0-1.01-.45-1.01-1zm15.03-7c0-4.5-6.72-5-8.99-5-2.28 0-9.01.5-9.01 5h18z",
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill={c}><path d={paths[n] || ""} /></svg>;
};

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════
// FIX: masks an email for display, e.g. "jo***@gmail.com"
const maskEmail = (email) => {
  if (!email || !email.includes("@")) return email || "";
  const [name, domain] = email.split("@");
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(name.length - 2, 2))}@${domain}`;
};

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // login | register | forgot
  const [f, setF] = useState({ name: "", empId: "", phone: "", email: "", password: "", confirm: "" });
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isWhitelisted, setIsWhitelisted] = useState(false);
  const upd = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // FIX: registration OTP state
  const [regStep,       setRegStep]       = useState("form"); // form | verify
  const [regOtp,        setRegOtp]        = useState("");
  const [regOtpCode,    setRegOtpCode]    = useState("");
  const [regOtpExpiry,  setRegOtpExpiry]  = useState(0);
  const [regResendCD,   setRegResendCD]   = useState(0);
  const [regPending,    setRegPending]    = useState(null); // holds user object pending creation

  useEffect(() => {
    if (regResendCD <= 0) return;
    const t = setTimeout(() => setRegResendCD(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [regResendCD]);

  // FIX: forgot-password flow state
  const [fgStep, setFgStep] = useState("request"); // request | verify | done
  const [fgEmpId, setFgEmpId] = useState("");
  const [fgUser, setFgUser] = useState(null);
  const [fgOtp, setFgOtp] = useState("");
  const [fgNewPw, setFgNewPw] = useState("");
  const [fgConfirmPw, setFgConfirmPw] = useState("");
  const [fgMsg, setFgMsg] = useState(null);
  const [fgLoading, setFgLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  useEffect(() => {
    if (!f.empId || f.empId.length < 2) { setIsWhitelisted(false); return; }
    const timer = setTimeout(async () => {
      const list = await DB.getAdminWhitelist();
      setIsWhitelisted(list.map(x => x.toLowerCase()).includes(f.empId.toLowerCase()));
    }, 400);
    return () => clearTimeout(timer);
  }, [f.empId]);

  const doRegister = async () => {
    if (!f.name || !f.empId || !f.email || !f.password) return setMsg({ t: "err", m: "Name, Employee ID, Email and password are required." });
    if (!f.email.includes("@") || !f.email.includes(".")) return setMsg({ t: "err", m: "Please enter a valid email address." });
    if (!f.email.toLowerCase().endsWith("@mobitel.lk")) return setMsg({ t: "err", m: "Only @mobitel.lk email addresses are allowed." });
    if (f.password !== f.confirm) return setMsg({ t: "err", m: "Passwords do not match." });
    if (f.password.length < 4) return setMsg({ t: "err", m: "Password must be at least 4 characters." });
    setLoading(true);
    try {
      const existing = await DB.getUserByEmpId(f.empId);
      if (existing) { setLoading(false); return setMsg({ t: "err", m: "Employee ID already registered." }); }
      // FIX: send OTP to email before creating account
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiry = Date.now() + 10 * 60 * 1000;
      await sendOtpEmail(f.email, f.name, code);
      const hashedPassword = await hashPw(f.password);
      setRegPending({
        id: uid(), name: f.name, empId: f.empId, phone: f.phone, email: f.email,
        password: hashedPassword,
        role: isWhitelisted ? "admin" : "employee", addresses: [], rosterData: {}, createdAt: todayStr()
      });
      setRegOtpCode(code);
      setRegOtpExpiry(expiry);
      setRegOtp("");
      setRegResendCD(30);
      setRegStep("verify");
      setMsg({ t: "ok", m: `Verification code sent to ${maskEmail(f.email)}. Valid for 10 minutes.` });
    } catch (e) {
      setMsg({ t: "err", m: "Registration failed: " + e.message });
    }
    setLoading(false);
  };

  const verifyRegOtp = async () => {
    if (!regOtp) return setMsg({ t: "err", m: "Enter the code sent to your email." });
    if (regOtp !== regOtpCode) return setMsg({ t: "err", m: "Incorrect code. Please try again." });
    if (Date.now() > regOtpExpiry) return setMsg({ t: "err", m: "Code expired. Please go back and try again." });
    setLoading(true);
    try {
      await DB.createUser(regPending);
      setLoading(false);
      setMsg({ t: "ok", m: "Account created! Sign in below." });
      setMode("login");
      setRegStep("form");
      setRegPending(null);
      setF({ name: "", empId: "", phone: "", email: "", password: "", confirm: "" });
    } catch (e) {
      setLoading(false);
      setMsg({ t: "err", m: "Failed to create account: " + e.message });
    }
  };

  const resendRegOtp = async () => {
    if (regResendCD > 0 || !regPending) return;
    setLoading(true);
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiry = Date.now() + 10 * 60 * 1000;
      await sendOtpEmail(regPending.email, regPending.name, code);
      setRegOtpCode(code);
      setRegOtpExpiry(expiry);
      setRegResendCD(30);
      setMsg({ t: "ok", m: "New code sent." });
    } catch (e) {
      setMsg({ t: "err", m: "Could not resend: " + e.message });
    }
    setLoading(false);
  };

  const doLogin = async () => {
    // FIX: check lockout before even hitting the database
    if (LockoutStore.isLocked(f.empId)) {
      const secs = LockoutStore.lockedSecondsLeft(f.empId);
      const mins = Math.ceil(secs / 60);
      return setMsg({ t: "err", m: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.` });
    }
    setLoading(true);
    try {
      const raw = await DB.getUserByEmpId(f.empId);
      if (!raw) {
        LockoutStore.recordFail(f.empId);
        setLoading(false);
        return setMsg({ t: "err", m: "Invalid Employee ID or password." });
      }
      const { ok, needsMigration } = await verifyPw(f.password, raw.password);
      if (!ok) {
        const attempts = LockoutStore.recordFail(f.empId);
        const remaining = MAX_ATTEMPTS - attempts;
        setLoading(false);
        if (remaining <= 0) return setMsg({ t: "err", m: `Too many failed attempts. Account locked for 15 minutes.` });
        return setMsg({ t: "err", m: `Invalid Employee ID or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` });
      }
      // FIX: auto-migrate plain-text password to bcrypt hash on first successful login
      if (needsMigration) {
        const hashed = await hashPw(f.password);
        await DB.setPassword(raw.id, hashed);
      }
      LockoutStore.clear(f.empId); // FIX: clear lockout on successful login
      const user = userFromDb(raw);
      Session.set({ userId: user.id });
      DB.touchActivity(user.id);
      setLoading(false);
      onLogin(user);
    } catch (e) {
      setLoading(false);
      setMsg({ t: "err", m: "Login failed: " + e.message });
    }
  };

  // FIX: forgot-password handlers
  const switchToForgot = () => {
    setMode("forgot"); setMsg(null);
    setFgStep("request"); setFgEmpId(""); setFgUser(null);
    setFgOtp(""); setFgNewPw(""); setFgConfirmPw(""); setFgMsg(null);
    setResendCooldown(0);
  };

  const backToLogin = () => {
    setMode("login"); setFgMsg(null);
  };

  const sendOtpEmail = async (toEmail, toName, code) => {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: toEmail,
      to_name: toName,
      otp_code: code,
    }, EMAILJS_PUBLIC_KEY);
  };

  const requestReset = async () => {
    if (!fgEmpId) return setFgMsg({ t: "err", m: "Enter your Employee ID." });
    setFgLoading(true);
    try {
      const raw = await DB.getUserByEmpId(fgEmpId);
      if (!raw) { setFgLoading(false); return setFgMsg({ t: "err", m: "No account found with that Employee ID." }); }
      if (!raw.email) {
        setFgLoading(false);
        return setFgMsg({ t: "err", m: "No email is on file for this account. Please ask your Admin/Team Leader to reset your password instead." });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await DB.setResetOtp(raw.id, code, expires);
      await sendOtpEmail(raw.email, raw.name, code);
      setFgUser(raw);
      setFgStep("verify");
      setResendCooldown(30);
      setFgMsg({ t: "ok", m: `Code sent to ${maskEmail(raw.email)}. Check your inbox (and spam folder) — it's valid for 10 minutes.` });
    } catch (e) {
      setFgMsg({ t: "err", m: "Could not send code: " + e.message });
    }
    setFgLoading(false);
  };

  const resendCode = async () => {
    if (resendCooldown > 0 || !fgUser) return;
    setFgLoading(true);
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await DB.setResetOtp(fgUser.id, code, expires);
      await sendOtpEmail(fgUser.email, fgUser.name, code);
      setResendCooldown(30);
      setFgMsg({ t: "ok", m: "New code sent." });
    } catch (e) {
      setFgMsg({ t: "err", m: "Could not resend: " + e.message });
    }
    setFgLoading(false);
  };

  const verifyAndReset = async () => {
    if (!fgOtp) return setFgMsg({ t: "err", m: "Enter the code sent to your email." });
    if (!fgNewPw || !fgConfirmPw) return setFgMsg({ t: "err", m: "Enter and confirm your new password." });
    if (fgNewPw.length < 4) return setFgMsg({ t: "err", m: "New password must be at least 4 characters." });
    if (fgNewPw !== fgConfirmPw) return setFgMsg({ t: "err", m: "Passwords do not match." });
    setFgLoading(true);
    try {
      const fresh = await DB.getUserByEmpId(fgEmpId); // re-check the latest OTP straight from the DB
      if (!fresh || !fresh.reset_otp) { setFgLoading(false); return setFgMsg({ t: "err", m: "Code expired or not found. Please request a new one." }); }
      if (fresh.reset_otp !== fgOtp) { setFgLoading(false); return setFgMsg({ t: "err", m: "Incorrect code." }); }
      if (new Date(fresh.reset_otp_expires).getTime() < Date.now()) { setFgLoading(false); return setFgMsg({ t: "err", m: "Code expired. Please request a new one." }); }
      // FIX: hash new password before saving
      const hashed = await hashPw(fgNewPw);
      await DB.setPassword(fresh.id, hashed);
      setFgStep("done");
      setFgMsg(null);
    } catch (e) {
      setFgMsg({ t: "err", m: "Failed: " + e.message });
    }
    setFgLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(135deg,${C.deepTeal} 0%,${C.midTeal} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,.1)", borderRadius: 14, padding: "12px 20px" }}>
            <Ico n="bus" s={26} c={C.cyan} />
            <div style={{ textAlign: "left" }}>
              <div style={{ color: "#fff", fontWeight: 800, fontSize: 17 }}>TransitHub</div>
              <div style={{ color: "rgba(255,255,255,.5)", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>Contact Center Transport</div>
            </div>
          </div>
        </div>
        <div className="card">
          {mode !== "forgot" && (
            <div className="tab-row">
              {[["login", "Sign In"], ["register", "Create Account"]].map(([m, lbl]) => (
                <button key={m} className={`tab-btn${mode === m ? " active" : ""}`} onClick={() => { setMode(m); setMsg(null); }}>{lbl}</button>
              ))}
            </div>
          )}

          {mode !== "forgot" && msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}

          {mode === "login" && (
            <div className="stack-sm">
              <div><label className="label">Employee ID</label><input className="input" placeholder="e.g. EMP001" value={f.empId} onChange={upd("empId")} /></div>
              <div><label className="label">Password</label><input className="input" type="password" placeholder="••••••••" value={f.password} onChange={upd("password")} onKeyDown={e => e.key === "Enter" && doLogin()} /></div>
              <button className="btn btn-cyan" style={{ width: "100%", justifyContent: "center", padding: 12, marginTop: 4 }} onClick={doLogin} disabled={loading}>{loading ? "Signing in…" : "Sign In"}</button>
              <div style={{ textAlign: "center", marginTop: 4 }}>
                <button onClick={switchToForgot} style={{ background: "none", border: "none", cursor: "pointer", color: C.cyan, fontSize: 12, fontWeight: 700 }}>Forgot password?</button>
              </div>
            </div>
          )}

          {mode === "register" && regStep === "form" && (
            <div className="stack-sm">
              <div><label className="label">Full Name<span className="req">*</span></label><input className="input" placeholder="Your full name" value={f.name} onChange={upd("name")} /></div>
              <div className="g2">
                <div>
                  <label className="label">Employee ID<span className="req">*</span></label>
                  <input className="input" placeholder="EMP001" value={f.empId} onChange={upd("empId")} />
                  {isWhitelisted && (
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: C.cyan }}>
                      <Ico n="check" s={13} c={C.cyan} /> Admin access granted for this ID
                    </div>
                  )}
                </div>
                <div><label className="label">Contact No.</label><input className="input" placeholder="+94 77 000 0000" value={f.phone} onChange={upd("phone")} /></div>
              </div>
              <div>
                <label className="label">Email<span className="req">*</span></label>
                <input className="input" type="email" placeholder="yourname@mobitel.lk" value={f.email} onChange={upd("email")} />
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Must be your @mobitel.lk company email. Used for verification.</div>
              </div>
              <div><label className="label">Password<span className="req">*</span></label><input className="input" type="password" placeholder="••••••••" value={f.password} onChange={upd("password")} /></div>
              <div><label className="label">Confirm Password<span className="req">*</span></label><input className="input" type="password" placeholder="••••••••" value={f.confirm} onChange={upd("confirm")} /></div>
              <button className="btn btn-cyan" style={{ width: "100%", justifyContent: "center", padding: 12, marginTop: 4 }} onClick={doRegister} disabled={loading}>{loading ? "Sending code…" : "Create Account"}</button>
            </div>
          )}

          {mode === "register" && regStep === "verify" && (
            <div className="stack-sm">
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                <div style={{ fontSize: 32, marginBottom: 6 }}>📧</div>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Verify your email</div>
                <div style={{ fontSize: 12, color: C.muted }}>Enter the 6-digit code sent to <b>{maskEmail(f.email)}</b></div>
              </div>
              <div>
                <label className="label">Verification Code</label>
                <input className="input" placeholder="••••••" maxLength={6} value={regOtp}
                  onChange={e => setRegOtp(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={e => e.key === "Enter" && verifyRegOtp()}
                  style={{ textAlign: "center", fontSize: 22, fontWeight: 800, letterSpacing: 8 }} />
              </div>
              <button className="btn btn-cyan" style={{ width: "100%", justifyContent: "center", padding: 12 }} onClick={verifyRegOtp} disabled={loading}>
                {loading ? "Verifying…" : "Verify & Create Account"}
              </button>
              <div style={{ textAlign: "center" }}>
                <button onClick={resendRegOtp} disabled={regResendCD > 0 || loading}
                  style={{ background: "none", border: "none", cursor: regResendCD > 0 ? "default" : "pointer", color: regResendCD > 0 ? C.muted : C.cyan, fontSize: 12, fontWeight: 700 }}>
                  {regResendCD > 0 ? `Resend code in ${regResendCD}s` : "Resend code"}
                </button>
              </div>
              <div style={{ textAlign: "center" }}>
                <button onClick={() => { setRegStep("form"); setMsg(null); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 12, fontWeight: 700 }}>
                  ← Back to form
                </button>
              </div>
            </div>
          )}

          {mode === "forgot" && (
            <div className="stack-sm">
              <div className="sec-title" style={{ marginBottom: 4 }}>🔑 Reset Password</div>
              {fgMsg && <div className={`alert alert-${fgMsg.t === "err" ? "err" : "ok"}`}>{fgMsg.m}</div>}

              {fgStep === "request" && (
                <>
                  <div><label className="label">Employee ID</label><input className="input" placeholder="e.g. EMP001" value={fgEmpId} onChange={e => setFgEmpId(e.target.value)} onKeyDown={e => e.key === "Enter" && requestReset()} /></div>
                  <button className="btn btn-cyan" style={{ width: "100%", justifyContent: "center", padding: 12, marginTop: 4 }} onClick={requestReset} disabled={fgLoading}>{fgLoading ? "Sending…" : "Send Code"}</button>
                </>
              )}

              {fgStep === "verify" && (
                <>
                  <div><label className="label">6-Digit Code</label><input className="input" placeholder="••••••" maxLength={6} value={fgOtp} onChange={e => setFgOtp(e.target.value.replace(/\D/g, ""))} /></div>
                  <div><label className="label">New Password</label><input className="input" type="password" placeholder="••••••••" value={fgNewPw} onChange={e => setFgNewPw(e.target.value)} /></div>
                  <div><label className="label">Confirm New Password</label><input className="input" type="password" placeholder="••••••••" value={fgConfirmPw} onChange={e => setFgConfirmPw(e.target.value)} onKeyDown={e => e.key === "Enter" && verifyAndReset()} /></div>
                  <button className="btn btn-cyan" style={{ width: "100%", justifyContent: "center", padding: 12, marginTop: 4 }} onClick={verifyAndReset} disabled={fgLoading}>{fgLoading ? "Resetting…" : "Reset Password"}</button>
                  <div style={{ textAlign: "center" }}>
                    <button onClick={resendCode} disabled={resendCooldown > 0 || fgLoading} style={{ background: "none", border: "none", cursor: resendCooldown > 0 ? "default" : "pointer", color: resendCooldown > 0 ? C.muted : C.cyan, fontSize: 12, fontWeight: 700 }}>
                      {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Resend code"}
                    </button>
                  </div>
                </>
              )}

              {fgStep === "done" && (
                <div style={{ textAlign: "center", padding: "12px 0" }}>
                  <div style={{ width: 52, height: 52, borderRadius: "50%", background: C.greenLight, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                    <Ico n="check" s={26} c={C.green} />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Password updated!</div>
                  <div style={{ fontSize: 13, color: C.muted }}>You can now sign in with your new password.</div>
                </div>
              )}

              <div style={{ textAlign: "center", marginTop: 4 }}>
                <button onClick={backToLogin} style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 12, fontWeight: 700 }}>← Back to Sign In</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ROSTER PARSER
// ════════════════════════════════════════════════════════════════════════════
const parseRosterExcel = (wb, year, month) => {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (rows.length < 2) throw new Error("File appears empty.");
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    if (rows[i].filter(c => String(c).trim()).length >= 3) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h).trim());
  const dayCol  = headers.findIndex((h, i) => i === 0 || h.toLowerCase().includes("day"));
  const dateCol = headers.findIndex((h, i) => i === 1 || h.toLowerCase().includes("date"));
  const empCols = [];
  for (let c = Math.max(dayCol, dateCol) + 1; c < headers.length; c++) {
    const h = headers[c];
    if (!h) continue;
    let empId = null;
    const bracketMatch = h.match(/\(([^)]+?)\s*\)/);
    if (bracketMatch) {
      empId = bracketMatch[1].trim();
    } else {
      const parts = h.trim().split(/\s+/);
      empId = parts[parts.length - 1];
    }
    empCols.push({ col: c, empId, header: h });
  }
  const result = {};
  empCols.forEach(e => { if (e.empId) result[e.empId] = {}; });
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !c)) continue;
    const rawDate = row[dateCol];
    const dayNum = parseOrdinal(String(rawDate).replace(/st|nd|rd|th/gi, ""));
    if (!dayNum || dayNum < 1 || dayNum > 31) continue;
    const dateStr = buildDate(year, month, dayNum);
    empCols.forEach(({ col, empId }) => {
      if (!empId) return;
      const rawShift = String(row[col] || "").trim();
      if (!rawShift) return;
      const shiftInfo = parseShiftCode(rawShift);
      if (!result[empId]) result[empId] = {};
      result[empId][dateStr] = { shiftRaw: rawShift, shiftInfo };
    });
  }
  return { empCols, result };
};

// ════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ════════════════════════════════════════════════════════════════════════════
function MonthCalendar({ year, month, rosterMonth, onSelectDate, selectedDate }) {
  const today       = todayStr();
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow    = new Date(year, month - 1, 1).getDay();
  const startOffset = firstDow === 0 ? 6 : firstDow - 1;
  const DAY_NAMES   = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return (
    <div>
      <div className="cal-grid" style={{ marginBottom: 4 }}>
        {DAY_NAMES.map(d => <div key={d} className="cal-header">{d}</div>)}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} className="cal-day empty" />;
          const dateStr = buildDate(year, month, d);
          const entry   = rosterMonth?.[dateStr];
          const isToday = dateStr === today;
          const isOff   = entry?.shiftInfo?.off;
          const isSel   = dateStr === selectedDate;
          const isWork  = entry && !isOff;
          let cls = "cal-day";
          if (isOff) cls += " off-day";
          else if (isWork) cls += " work-day";
          if (isToday) cls += " today";
          if (isSel)   cls += " selected";
          return (
            <div key={d} className={cls} onClick={() => isWork && onSelectDate && onSelectDate(dateStr, entry)}>
              <div className="cal-day-num" style={{ color: isOff ? C.muted : isToday ? C.cyan : C.text }}>{d}</div>
              {entry && (
                <div className="cal-shift-chip" style={{ background: entry.shiftInfo?.bg || C.grey1, color: entry.shiftInfo?.color || C.muted }}>
                  {isOff ? "OFF" : (entry.shiftInfo?.ms || entry.shiftRaw)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ROSTER PAGE
// ════════════════════════════════════════════════════════════════════════════
function RosterPage({ user, onUserUpdate }) {
  const [selYear,  setSelYear]  = useState(nowYear());
  const [selMonth, setSelMonth] = useState(nowMonth());
  const [dragging, setDragging] = useState(false);
  const [msg,      setMsg]      = useState(null);
  const [preview,  setPreview]  = useState(null);
  const [pendingData, setPendingData] = useState(null);
  const fileRef    = useRef();
  const rosterData = user.rosterData || {};
  const monthKey   = `${selYear}-${String(selMonth).padStart(2, "0")}`;
  const rosterMonth = rosterData[monthKey] || {};

  const processFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "binary", cellDates: false });
        const { result } = parseRosterExcel(wb, selYear, selMonth);
        const myData = result[user.empId];
        if (!myData || Object.keys(myData).length === 0)
          return setMsg({ t: "err", m: `No column found matching your Employee ID (${user.empId}). Check the file format.` });
        const count    = Object.keys(myData).length;
        const workDays = Object.values(myData).filter(v => !v.shiftInfo?.off).length;
        setPendingData(myData);
        setPreview({ count, workDays });
        setMsg({ t: "ok", m: `Found ${count} days (${workDays} working). Click Import to confirm.` });
      } catch (err) {
        setMsg({ t: "err", m: "Could not read file: " + err.message });
      }
    };
    reader.readAsBinaryString(file);
  };

  const importData = async () => {
    const next    = { ...rosterData, [monthKey]: pendingData };
    const updated = { ...user, rosterData: next };
    await DB.updateUser(updated);
    onUserUpdate(updated);
    setPendingData(null); setPreview(null);
    setMsg({ t: "ok", m: `${Object.keys(pendingData).length} days imported for ${MONTHS[selMonth - 1]} ${selYear}.` });
  };

  const clearMonth = async () => {
    const next = { ...rosterData };
    delete next[monthKey];
    const updated = { ...user, rosterData: next };
    await DB.updateUser(updated);
    onUserUpdate(updated);
    setPendingData(null); setPreview(null);
    setMsg({ t: "ok", m: "Month cleared." });
  };

  const shiftCounts = Object.values(rosterMonth).reduce((acc, v) => {
    const lbl = v.shiftInfo?.off ? "OFF" : (v.shiftInfo?.label || v.shiftRaw);
    acc[lbl] = (acc[lbl] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="stack">
      <div>
        <div className="page-title">My Roster</div>
        <div className="page-sub">Upload your monthly Excel file — your column is matched by Employee ID.</div>
      </div>
      <div className="card">
        <div className="sec-title">📋 Upload Roster</div>
        <div className="g2" style={{ marginBottom: 16 }}>
          <div>
            <label className="label">Month<span className="req">*</span></label>
            <select className="input" value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Year<span className="req">*</span></label>
            <select className="input" value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
              {[nowYear() - 1, nowYear(), nowYear() + 1].map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
        </div>
        {msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}
        <div
          className={`upload-zone${dragging ? " drag" : ""}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); }}
          onClick={() => fileRef.current?.click()}
        >
          <div style={{ fontSize: 30, marginBottom: 8 }}>📊</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>Drop your roster Excel here</div>
          <div style={{ fontSize: 12, color: C.muted }}>Format: Day | Date | <b>Your Name ({user.empId})</b> | … · .xlsx or .xls</div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => processFile(e.target.files[0])} />
        </div>
        {preview && pendingData && (
          <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center" }}>
            <div style={{ flex: 1, fontSize: 13, color: C.muted }}>
              <b style={{ color: C.text }}>{preview.count} days</b> found — <b style={{ color: C.green }}>{preview.workDays} working</b>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => { setPendingData(null); setPreview(null); setMsg(null); }}>Discard</button>
            <button className="btn btn-cyan btn-sm" onClick={importData}><Ico n="check" s={13} />Import</button>
          </div>
        )}
      </div>
      <div className="card">
        <div className="flex-b" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="sec-title" style={{ margin: 0 }}>{MONTHS[selMonth - 1]} {selYear}</div>
            {Object.keys(rosterMonth).length > 0 && (() => {
              const workDays = Object.values(rosterMonth).filter(v => !v.shiftInfo?.off).length;
              const offDays  = Object.values(rosterMonth).filter(v =>  v.shiftInfo?.off).length;
              return (
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, background: C.greenLight, color: C.green, padding: "3px 9px", borderRadius: 20 }}>{workDays} working</span>
                  <span style={{ fontSize: 11, fontWeight: 700, background: C.grey1, color: C.muted, padding: "3px 9px", borderRadius: 20 }}>{offDays} off</span>
                </div>
              );
            })()}
          </div>
          {Object.keys(rosterMonth).length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={clearMonth} style={{ color: C.red }}>Clear month</button>
          )}
        </div>
        {Object.keys(shiftCounts).length > 0 && (
          <div className="flex-g" style={{ marginBottom: 14, flexWrap: "wrap" }}>
            {Object.entries(shiftCounts).map(([lbl, cnt]) => {
              const info = Object.values(SHIFT_MAP).find(s => s.label === lbl) || { color: C.muted, bg: C.grey1 };
              return (
                <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: info.bg, border: `1px solid ${info.color}` }} />
                  <span style={{ color: C.muted }}>{lbl}</span>
                  <span style={{ color: C.text, fontWeight: 800 }}>{cnt}</span>
                </div>
              );
            })}
          </div>
        )}
        {Object.keys(rosterMonth).length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 20px", color: C.muted }}>
            No roster for {MONTHS[selMonth - 1]} {selYear}. Upload your file above.
          </div>
        ) : (
          <MonthCalendar year={selYear} month={selMonth} rosterMonth={rosterMonth} />
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PROFILE PAGE
// ════════════════════════════════════════════════════════════════════════════
function ProfilePage({ user, onUpdate }) {
  const [phone,   setPhone]   = useState(user.phone || "");
  const [addrs,   setAddrs]   = useState(user.addresses || []);
  const [editing, setEditing] = useState(null);
  const [af,      setAf]      = useState({ label: "", street: "", city: "", district: "", zip: "", mapsLink: "", route: "" });
  const [msg,     setMsg]     = useState(null);
  const a = k => e => setAf(p => ({ ...p, [k]: e.target.value }));

  // FIX: change password OTP state
  const [curPw,     setCurPw]     = useState("");
  const [newPw,     setNewPw]     = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwMsg,     setPwMsg]     = useState(null);
  const [pwLoading, setPwLoading] = useState(false);
  const [pwStep,    setPwStep]    = useState("form"); // form | verify
  const [pwOtp,     setPwOtp]     = useState("");
  const [pwOtpCode, setPwOtpCode] = useState("");
  const [pwOtpExpiry, setPwOtpExpiry] = useState(0);
  const [pwResendCD,  setPwResendCD]  = useState(0);

  useEffect(() => {
    if (pwResendCD <= 0) return;
    const t = setTimeout(() => setPwResendCD(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [pwResendCD]);

  const changePassword = async () => {
    if (!curPw || !newPw || !confirmPw) return setPwMsg({ t: "err", m: "All fields are required." });
    if (newPw.length < 4) return setPwMsg({ t: "err", m: "New password must be at least 4 characters." });
    if (newPw !== confirmPw) return setPwMsg({ t: "err", m: "New passwords do not match." });
    setPwLoading(true);
    try {
      const { ok } = await verifyPw(curPw, user.password);
      if (!ok) { setPwLoading(false); return setPwMsg({ t: "err", m: "Current password is incorrect." }); }
      const { ok: sameAsCurrent } = await verifyPw(newPw, user.password);
      if (sameAsCurrent) { setPwLoading(false); return setPwMsg({ t: "err", m: "New password must be different from the current one." }); }
      if (!user.email) { setPwLoading(false); return setPwMsg({ t: "err", m: "No email on file — ask your Admin to reset your password." }); }
      // FIX: send OTP to their registered email before allowing password change
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiry = Date.now() + 10 * 60 * 1000;
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
        to_email: user.email, to_name: user.name, otp_code: code,
      }, EMAILJS_PUBLIC_KEY);
      setPwOtpCode(code);
      setPwOtpExpiry(expiry);
      setPwOtp("");
      setPwResendCD(30);
      setPwStep("verify");
      setPwMsg({ t: "ok", m: `Verification code sent to ${maskEmail(user.email)}. Valid for 10 minutes.` });
    } catch (e) {
      setPwMsg({ t: "err", m: "Failed: " + e.message });
    }
    setPwLoading(false);
  };

  const verifyPwOtp = async () => {
    if (!pwOtp) return setPwMsg({ t: "err", m: "Enter the code sent to your email." });
    if (pwOtp !== pwOtpCode) return setPwMsg({ t: "err", m: "Incorrect code. Please try again." });
    if (Date.now() > pwOtpExpiry) return setPwMsg({ t: "err", m: "Code expired. Please start over." });
    setPwLoading(true);
    try {
      const hashed = await hashPw(newPw);
      await DB.setPassword(user.id, hashed);
      onUpdate({ ...user, password: hashed });
      setCurPw(""); setNewPw(""); setConfirmPw(""); setPwOtp("");
      setPwStep("form");
      setPwMsg({ t: "ok", m: "Password changed successfully." });
    } catch (e) {
      setPwMsg({ t: "err", m: "Failed: " + e.message });
    }
    setPwLoading(false);
  };

  const resendPwOtp = async () => {
    if (pwResendCD > 0) return;
    setPwLoading(true);
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiry = Date.now() + 10 * 60 * 1000;
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
        to_email: user.email, to_name: user.name, otp_code: code,
      }, EMAILJS_PUBLIC_KEY);
      setPwOtpCode(code);
      setPwOtpExpiry(expiry);
      setPwResendCD(30);
      setPwMsg({ t: "ok", m: "New code sent." });
    } catch (e) {
      setPwMsg({ t: "err", m: "Could not resend: " + e.message });
    }
    setPwLoading(false);
  };

  const savePhone = async () => {
    const updated = { ...user, phone };
    await DB.updateUser(updated);
    onUpdate(updated);
    setMsg({ t: "ok", m: "Saved." });
  };

  const openNew = () => {
    if (addrs.length >= 3) return setMsg({ t: "err", m: "Max 3 addresses." });
    setAf({ label: "", street: "", city: "", district: "", zip: "", mapsLink: "", route: "" });
    setEditing("new");
  };

  const openEdit = i => { setAf({ ...addrs[i] }); setEditing(i); };

  const saveAddr = async () => {
    if (!af.label || !af.street || !af.city || !af.route) return setMsg({ t: "err", m: "Label, street, city and route are required." });
    const next    = editing === "new" ? [...addrs, { ...af, id: uid() }] : addrs.map((a, i) => i === editing ? { ...af, id: a.id } : a);
    setAddrs(next);
    const updated = { ...user, addresses: next };
    await DB.updateUser(updated);
    onUpdate(updated);
    setEditing(null);
    setMsg({ t: "ok", m: "Address saved." });
  };

  const delAddr = async i => {
    const next    = addrs.filter((_, idx) => idx !== i);
    setAddrs(next);
    const updated = { ...user, addresses: next };
    await DB.updateUser(updated);
    onUpdate(updated);
  };

  return (
    <div className="stack">
      <div><div className="page-title">My Profile</div><div className="page-sub">Contact info and saved addresses for quick transport requests.</div></div>
      {msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}
      <div className="card">
        <div className="sec-title">Contact Information</div>
        <div className="g2">
          <div><label className="label">Full Name</label><input className="input input-ro" readOnly value={user.name} /></div>
          <div><label className="label">Employee ID</label><input className="input input-ro" readOnly value={user.empId} /></div>
          <div>
            <label className="label">Email</label>
            <input className="input input-ro" readOnly value={user.email || "Not set — used for password recovery"} />
          </div>
          <div>
            <label className="label">Contact Number<span className="req">*</span></label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" placeholder="+94 77 000 0000" value={phone} onChange={e => setPhone(e.target.value)} />
              <button className="btn btn-cyan" onClick={savePhone}><Ico n="check" s={13} />Save</button>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="sec-title">🔒 Change Password</div>
        {pwMsg && <div className={`alert alert-${pwMsg.t === "err" ? "err" : "ok"}`}>{pwMsg.m}</div>}
        {pwStep === "form" && (
          <div className="g2">
            <div className="col2">
              <label className="label">Current Password<span className="req">*</span></label>
              <input className="input" type="password" placeholder="••••••••" value={curPw} onChange={e => setCurPw(e.target.value)} />
            </div>
            <div>
              <label className="label">New Password<span className="req">*</span></label>
              <input className="input" type="password" placeholder="••••••••" value={newPw} onChange={e => setNewPw(e.target.value)} />
            </div>
            <div>
              <label className="label">Confirm New Password<span className="req">*</span></label>
              <input className="input" type="password" placeholder="••••••••" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
            </div>
            <div className="col2">
              <button className="btn btn-cyan" onClick={changePassword} disabled={pwLoading}>
                <Ico n="check" s={13} />{pwLoading ? "Sending code…" : "Change Password"}
              </button>
            </div>
          </div>
        )}
        {pwStep === "verify" && (
          <div className="stack-sm">
            <div style={{ textAlign: "center", padding: "4px 0 8px" }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📧</div>
              <div style={{ fontSize: 13, color: C.muted }}>Enter the 6-digit code sent to <b>{maskEmail(user.email)}</b></div>
            </div>
            <div>
              <label className="label">Verification Code</label>
              <input className="input" placeholder="••••••" maxLength={6} value={pwOtp}
                onChange={e => setPwOtp(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => e.key === "Enter" && verifyPwOtp()}
                style={{ textAlign: "center", fontSize: 22, fontWeight: 800, letterSpacing: 8 }} />
            </div>
            <button className="btn btn-cyan" onClick={verifyPwOtp} disabled={pwLoading}>
              <Ico n="check" s={13} />{pwLoading ? "Verifying…" : "Confirm & Change Password"}
            </button>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={() => { setPwStep("form"); setPwMsg(null); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: 12, fontWeight: 700 }}>← Back</button>
              <button onClick={resendPwOtp} disabled={pwResendCD > 0 || pwLoading}
                style={{ background: "none", border: "none", cursor: pwResendCD > 0 ? "default" : "pointer", color: pwResendCD > 0 ? C.muted : C.cyan, fontSize: 12, fontWeight: 700 }}>
                {pwResendCD > 0 ? `Resend in ${pwResendCD}s` : "Resend code"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <div className="flex-b" style={{ marginBottom: 14 }}>
          <div className="sec-title" style={{ margin: 0 }}>Saved Addresses <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>({addrs.length}/3)</span></div>
          <button className="btn btn-cyan btn-sm" onClick={openNew} disabled={addrs.length >= 3}><Ico n="plus" s={13} />Add Address</button>
        </div>
        {editing !== null && (
          <div style={{ background: C.ice, border: `1.5px solid ${C.cyan}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div className="sec-title">{editing === "new" ? "New Address" : "Edit Address"}</div>
            <div className="g2">
              <div className="col2"><label className="label">Label (e.g. "Home")</label><input className="input" placeholder="Home" value={af.label} onChange={a("label")} /></div>
              <div className="col2"><label className="label">Street<span className="req">*</span></label><input className="input" placeholder="123 Main St" value={af.street} onChange={a("street")} /></div>
              <div><label className="label">City<span className="req">*</span></label><input className="input" placeholder="Colombo" value={af.city} onChange={a("city")} /></div>
              <div><label className="label">District</label><input className="input" placeholder="Western" value={af.district} onChange={a("district")} /></div>
              <div><label className="label">ZIP</label><input className="input" placeholder="00100" value={af.zip} onChange={a("zip")} /></div>
              <div><label className="label">Google Maps Pin URL</label><input className="input" placeholder="https://maps.app.goo.gl/…" value={af.mapsLink} onChange={a("mapsLink")} /></div>
              <div className="col2">
                <label className="label">Route<span className="req">*</span></label>
                <select className="input" value={af.route} onChange={a("route")}>
                  <option value="">— Select the route for this address —</option>
                  {ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="flex-g" style={{ marginTop: 12 }}>
              <button className="btn btn-cyan btn-sm" onClick={saveAddr}><Ico n="check" s={13} />Save Address</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
        {addrs.length === 0 && editing === null ? (
          <div style={{ color: C.muted, textAlign: "center", padding: 24 }}>No saved addresses yet. Add one above.</div>
        ) : (
          <div className="g3">
            {addrs.map((addr, i) => (
              <div key={addr.id} className="addr-card">
                <div className="flex-b" style={{ marginBottom: 7 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}><Ico n="pin" s={12} c={C.cyan} /> {addr.label}</span>
                  <div style={{ display: "flex", gap: 5 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(i)}><Ico n="edit" s={11} /></button>
                    <button className="btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => delAddr(i)}><Ico n="trash" s={11} /></button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
                  {addr.street}<br />{addr.city}{addr.district ? `, ${addr.district}` : ""}{addr.zip ? ` ${addr.zip}` : ""}
                  {addr.route && (
                    <div className="route-badge"><Ico n="route" s={11} c={C.midTeal} />{addr.route}</div>
                  )}
                  {addr.mapsLink && <div style={{ marginTop: 4 }}><a href={addr.mapsLink} target="_blank" rel="noreferrer" style={{ color: C.cyan, fontSize: 11 }}>📍 Maps link</a></div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// AUTO TAG
// ════════════════════════════════════════════════════════════════════════════
function AutoTag({ show }) {
  if (!show) return null;
  return <span style={{ fontSize: 10, fontWeight: 700, color: C.cyan, background: C.cyanLight, padding: "2px 7px", borderRadius: 20, marginLeft: 7 }}>AUTO</span>;
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSPORT FORM
// ════════════════════════════════════════════════════════════════════════════
function TransportForm({ user }) {
  const [lu, setLu] = useState(user);
  useEffect(() => {
    DB.getUserById(user.id).then(raw => { if (raw) setLu(userFromDb(raw)); });
  }, [user.id]);

  // FIX: cutoff enforcement state
  const [cutoffEnabled, setCutoffEnabled] = useState(true);
  useEffect(() => { DB.getCutoffEnabled().then(setCutoffEnabled); }, []);
  const isAdmin = user.role === "admin"; // admins bypass cutoff

  const [mode,       setMode]       = useState("auto");
  const [selYear,    setSelYear]    = useState(nowYear());
  const [selMonth,   setSelMonth]   = useState(nowMonth());
  const [selDate,    setSelDate]    = useState(null);
  const [autoFields, setAutoFields] = useState({});
  const [selAddr,    setSelAddr]    = useState(null);
  const [form,       setForm]       = useState({
    date: "", phone: user.phone || "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", wantsDinner: null, dinnerMeal: ""
  });
  const [msg,       setMsg]       = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [dayUsage,  setDayUsage]  = useState({ hasPick: false, hasDrop: false, hasDinner: false });
  // FIX: track submitted form data for the success screen
  const [submittedForm, setSubmittedForm] = useState(null);

  // FIX: compute cutoff status whenever date or shift changes
  const cutoffStatus = (cutoffEnabled && !isAdmin)
    ? checkSubmissionCutoff(form.date, form.shift)
    : { blocked: false, deadline: null };

  const rosterData  = lu.rosterData || {};
  const monthKey    = `${selYear}-${String(selMonth).padStart(2, "0")}`;
  const rosterMonth = rosterData[monthKey] || {};

  const set = (k, v) => {
    setForm(p => ({ ...p, [k]: v }));
    setAutoFields(p => ({ ...p, [k]: false }));
  };

  useEffect(() => {
    if (!form.date) { setDayUsage({ hasPick: false, hasDrop: false, hasDinner: false }); return; }
    DB.getUserApps(user.id).then(apps => {
      const dayApps = apps.filter(a => a.date === form.date);
      setDayUsage({
        hasPick:   dayApps.some(a => a.pickDrop === "PICK"),
        hasDrop:   dayApps.some(a => a.pickDrop === "DROP"),
        hasDinner: dayApps.some(a => a.dinnerMeal),
      });
    });
  }, [form.date, user.id]);

  const switchMode = (m) => {
    setMode(m); setMsg(null);
    setSelDate(null); setAutoFields({});
    setForm({ date: "", phone: lu.phone || "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", wantsDinner: null, dinnerMeal: "" });
  };

  const pickDate = (dateStr, entry) => {
    if (entry?.shiftInfo?.off) {
      setMsg({ t: "warn", m: `${dateStr} is a day off — no transport needed.` });
      return;
    }
    setMsg(null);
    setSelDate(dateStr);
    const addr    = lu.addresses?.[selAddr ?? 0];
    const newAuto = { date: true };
    const newForm = { ...form, date: dateStr };
    if (entry?.shiftInfo?.label) { newForm.shift = entry.shiftInfo.label; newAuto.shift = true; }
    if (addr) {
      newForm.address  = `${addr.street}, ${addr.city}${addr.district ? ", " + addr.district : ""}${addr.zip ? " " + addr.zip : ""}`;
      newForm.mapsLink = addr.mapsLink || "";
      newForm.route    = addr.route || "";
      newAuto.address  = true;
      if (addr.mapsLink) newAuto.mapsLink = true;
      if (addr.route)    newAuto.route    = true;
    }
    setAutoFields(newAuto);
    setForm(newForm);
  };

  const pickAddress = (addr, i) => {
    setSelAddr(i);
    const newForm = {
      ...form,
      address:  `${addr.street}, ${addr.city}${addr.district ? ", " + addr.district : ""}${addr.zip ? " " + addr.zip : ""}`,
      mapsLink: addr.mapsLink || "",
      route:    addr.route || "",
    };
    setForm(newForm);
    setAutoFields(p => ({ ...p, address: true, mapsLink: !!addr.mapsLink, route: !!addr.route }));
  };

  const handlePickDrop = (val) => {
    if (val === "PICK" && dayUsage.hasPick) {
      setMsg({ t: "err", m: "You already have a PICK request for this date." });
      return;
    }
    if (val === "DROP" && dayUsage.hasDrop) {
      setMsg({ t: "err", m: "You already have a DROP request for this date." });
      return;
    }
    setMsg(null);
    set("pickDrop", val);
  };

  const submit = async () => {
    if (!form.date)  return setMsg({ t: "err", m: "Date is required." });
    if (!form.phone) return setMsg({ t: "err", m: "Contact number is required." });
    if (!form.shift) return setMsg({ t: "err", m: "Shift is required." });
    // FIX: enforce submission cutoff (admins bypass this check)
    if (cutoffEnabled && !isAdmin) {
      const { blocked, reason } = checkSubmissionCutoff(form.date, form.shift);
      if (blocked) return setMsg({ t: "err", m: `⏰ Submission closed — ${reason}` });
    }
    const isDinnerOnly = mode === "dinner";
    if (isDinnerOnly) {
      if (getDinnerMode(form.shift) === "none")
        return setMsg({ t: "err", m: "Dinner is not available for this shift. Only 3PM-12AM, 7PM-6AM, 11AM-8PM shifts qualify." });
      if (!form.dinnerMeal)
        return setMsg({ t: "err", m: "Please select a meal." });
      if (dayUsage.hasDinner)
        return setMsg({ t: "err", m: "Already submitted a dinner request for this date." });
    } else {
      if (!form.pickDrop) return setMsg({ t: "err", m: "Select Pick or Drop." });
      if (!form.address)  return setMsg({ t: "err", m: "Address is required." });
      if (!form.route)    return setMsg({ t: "err", m: "Route is required." });
      const dinnerMode = getDinnerMode(form.shift);
      if (dinnerMode !== "none") {
        if (form.wantsDinner === null)
          return setMsg({ t: "err", m: "Please confirm your dinner preference — select Yes and choose a meal, or No dinner today." });
        if (form.wantsDinner === true && !form.dinnerMeal)
          return setMsg({ t: "err", m: "Please select a meal for dinner, or choose No dinner today." });
      }
      if (form.pickDrop === "PICK" && dayUsage.hasPick) return setMsg({ t: "err", m: "Already submitted a PICK for this date." });
      if (form.pickDrop === "DROP" && dayUsage.hasDrop) return setMsg({ t: "err", m: "Already submitted a DROP for this date." });
      if (form.wantsDinner === true && dayUsage.hasDinner) return setMsg({ t: "err", m: "Already submitted a dinner request for this date." });
    }
    const app = {
      id: uid(), userId: user.id, empId: user.empId, empName: user.name,
      date: form.date, phone: form.phone, shift: form.shift,
      // FIX: use "DINNER_ONLY" consistently for the pickDrop field when dinner mode
      pickDrop: isDinnerOnly ? "DINNER_ONLY" : form.pickDrop,
      address:  isDinnerOnly ? "" : form.address,
      mapsLink: isDinnerOnly ? "" : form.mapsLink,
      route:    isDinnerOnly ? "" : form.route,
      wantsDinner: isDinnerOnly ? true : (form.wantsDinner === true),
      dinnerMeal:  isDinnerOnly ? form.dinnerMeal : (form.wantsDinner === true ? form.dinnerMeal : ""),
      entryMode: mode, submittedAt: new Date().toISOString()
    };
    await DB.createApp(app);
    DB.touchActivity(user.id); // FIX: mark submission activity (resets 30-day inactivity timer)
    // FIX: save form snapshot for success screen before resetting
    setSubmittedForm({ ...form, isDinnerOnly });
    setSubmitted(true);
    setMsg(null);
  };

  const reset = () => {
    setSelDate(null); setSelAddr(null); setAutoFields({});
    setForm({ date: "", phone: lu.phone || "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", wantsDinner: null, dinnerMeal: "" });
    setSubmitted(false);
    setSubmittedForm(null);
    setMsg(null);
  };

  // FIX: success screen now uses submittedForm snapshot — no stale state issues
  if (submitted && submittedForm) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: "60px 20px" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: C.greenLight, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Ico n="check" s={32} c={C.green} />
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>Request Submitted!</div>
        <div style={{ color: C.muted, fontSize: 14 }}>
          {submittedForm.isDinnerOnly
            ? <span>Dinner only request for <b>{submittedForm.date}</b> · <b>{submittedForm.shift}</b></span>
            : <span>Transport request for <b>{submittedForm.date}</b> · <b>{submittedForm.shift}</b> · <b>{submittedForm.pickDrop}</b></span>
          }
        </div>
        {!submittedForm.isDinnerOnly && <div style={{ marginTop: 6, fontSize: 13, color: C.muted }}>Route: <b style={{ color: C.text }}>{submittedForm.route}</b></div>}
        {(submittedForm.wantsDinner || submittedForm.isDinnerOnly) && submittedForm.dinnerMeal && (
          <div style={{ marginTop: 6, fontSize: 13, color: C.muted }}>🍽 Dinner: <b style={{ color: C.text }}>{submittedForm.dinnerMeal}</b></div>
        )}
        <div style={{ marginTop: 8 }}>
          <span className={`badge ${mode === "auto" ? "badge-cyan" : mode === "dinner" ? "badge-purple" : "badge-orange"}`}>
            {mode === "auto" ? "Auto-filled" : mode === "dinner" ? "Dinner Only" : "Manual entry"}
          </span>
        </div>
      </div>
      <button className="btn btn-cyan" onClick={reset}>Submit Another</button>
    </div>
  );

  const FormFields = () => (
    <div className="stack">
      {/* 1. Date */}
      <div>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <label className="label" style={{ margin: 0 }}>1. Date</label>
          <AutoTag show={autoFields.date} />
        </div>
        <input className={`input${autoFields.date ? " input-auto" : ""}`} type="date" value={form.date} onChange={e => set("date", e.target.value)} />
      </div>

      {/* 2. Contact */}
      <div>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <label className="label" style={{ margin: 0 }}>2. Contact Number<span className="req">*</span></label>
          {lu.phone && <AutoTag show={true} />}
        </div>
        <input className={`input${form.phone ? " input-auto" : ""}`} placeholder="+94 77 000 0000" value={form.phone} onChange={e => set("phone", e.target.value)} />
      </div>

      {/* 3. Shift */}
      <div>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <label className="label" style={{ margin: 0 }}>3. Shift<span className="req">*</span></label>
          <AutoTag show={autoFields.shift} />
        </div>
        {autoFields.shift && form.shift && (() => {
          const info = Object.values(SHIFT_MAP).find(s => s.label === form.shift);
          return info ? (
            <div style={{ marginBottom: 8, padding: "8px 14px", borderRadius: 9, border: `1.5px solid ${info.color}`, background: info.bg, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: info.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, color: info.color, fontSize: 14 }}>{info.label}</span>
              <span style={{ fontSize: 11, color: C.muted, marginLeft: "auto" }}>✦ from roster · tap below to change</span>
            </div>
          ) : null;
        })()}
        <div className="radio-group">
          {SHIFT_LABELS.map(opt => {
            const on   = form.shift === opt;
            const info = Object.values(SHIFT_MAP).find(s => s.label === opt);
            return (
              <div key={opt} className={`radio-opt${on ? " sel" : ""}`} onClick={() => set("shift", opt)}
                style={on && info ? { borderColor: info.color, background: info.bg } : {}}>
                <div className={`radio-dot${on ? " on" : ""}`} style={on && info ? { borderColor: info.color, background: info.color } : {}}>{on && <div className="radio-inner" />}</div>
                <span style={{ flex: 1, color: on && info ? info.color : C.text, fontWeight: on ? 700 : 500 }}>{opt}</span>
                {info && <div style={{ width: 8, height: 8, borderRadius: "50%", background: info.color, opacity: .5 }} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Pick / Drop */}
      <div>
        <label className="label">4. Transport Type<span className="req">*</span></label>
        {form.date && (dayUsage.hasPick || dayUsage.hasDrop) && (
          <div className="alert alert-info" style={{ marginBottom: 8, fontSize: 12 }}>
            {dayUsage.hasPick && dayUsage.hasDrop
              ? "⚠ You've already submitted both PICK and DROP for this date."
              : dayUsage.hasPick
              ? "✓ PICK submitted — you can still add a DROP."
              : "✓ DROP submitted — you can still add a PICK."}
          </div>
        )}
        <div className="radio-group">
          {[["PICK", C.green, C.greenLight], ["DROP", C.red, C.redLight]].map(([opt, col, bg]) => {
            const on         = form.pickDrop === opt;
            const isDisabled = (opt === "PICK" && dayUsage.hasPick) || (opt === "DROP" && dayUsage.hasDrop);
            return (
              <div key={opt}
                className={`radio-opt${on ? " sel" : ""}${isDisabled ? " disabled" : ""}`}
                onClick={() => !isDisabled && handlePickDrop(opt)}
                style={on ? { borderColor: col, background: bg } : isDisabled ? { opacity: .4, cursor: "not-allowed" } : {}}>
                <div className={`radio-dot${on ? " on" : ""}`} style={on ? { borderColor: col, background: col } : {}}>{on && <div className="radio-inner" />}</div>
                <span style={{ flex: 1, fontWeight: on ? 700 : 500, color: on ? col : C.text }}>{opt}</span>
                {isDisabled && <span style={{ fontSize: 11, color: C.muted }}>Already submitted</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 5. Address */}
      <div>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <label className="label" style={{ margin: 0 }}>5. Address<span className="req">*</span></label>
          <AutoTag show={autoFields.address} />
        </div>
        {lu.addresses?.length > 0 && (
          <div className="flex-g" style={{ marginBottom: 9 }}>
            {lu.addresses.map((addr, i) => (
              <button key={addr.id} className={`btn btn-sm ${selAddr === i ? "btn-cyan" : "btn-outline"}`} onClick={() => pickAddress(addr, i)}>
                <Ico n="pin" s={11} />{addr.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: C.muted }}>← tap to switch</span>
          </div>
        )}
        <textarea className={`input${autoFields.address ? " input-auto" : ""}`} rows={2}
          placeholder="Enter full pickup/drop address"
          value={form.address} onChange={e => set("address", e.target.value)} style={{ resize: "vertical" }} />
        {form.route ? (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>Route:</span>
            <div className="route-badge"><Ico n="route" s={11} c={C.midTeal} />{form.route}</div>
            {autoFields.route && <span style={{ fontSize: 10, color: C.muted }}>— from your saved address</span>}
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 12, color: C.orange }}>
            ⚠ No route linked — save this address in your Profile with a route first, or select manually below.
          </div>
        )}
        {!autoFields.route && (
          <div style={{ marginTop: 8 }}>
            <label className="label">Route<span className="req">*</span></label>
            <select className="input" value={form.route} onChange={e => set("route", e.target.value)}>
              <option value="">— Select route —</option>
              {ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* 6. Maps Link */}
      <div>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <label className="label" style={{ margin: 0 }}>6. Pin &amp; Share Location</label>
          <AutoTag show={autoFields.mapsLink} />
        </div>
        <div style={{ fontSize: 12, marginBottom: 6 }}>
          <a href="https://google.com/maps/" target="_blank" rel="noreferrer" style={{ color: C.cyan }}>Open Google Maps →</a>
        </div>
        <input className={`input${autoFields.mapsLink ? " input-auto" : ""}`}
          placeholder="Paste your Google Maps pin link"
          value={form.mapsLink} onChange={e => set("mapsLink", e.target.value)} />
      </div>

      {/* 7. Dinner */}
      {(() => {
        const dinnerMode = getDinnerMode(form.shift);
        if (dinnerMode === "none") return null;
        const hasDinnerToday = dayUsage.hasDinner;
        const wantsYes = form.wantsDinner === true || form.wantsDinner === null;
        return (
          <div style={{ border: `1.5px solid ${C.purple}`, borderRadius: 12, padding: 14, background: C.purpleLight }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 16 }}>🍽</span>
              <label className="label" style={{ margin: 0 }}>7. Dinner Request<span className="req">*</span></label>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: "rgba(124,58,237,.15)", padding: "2px 8px", borderRadius: 20 }}>
                Required for your shift
              </span>
            </div>
            {hasDinnerToday ? (
              <div className="alert alert-info" style={{ marginBottom: 0, fontSize: 12 }}>
                ✓ You already have a dinner request for this date.
              </div>
            ) : (
              <>
                <div className="radio-group" style={{ marginBottom: 12 }}>
                  {[[true, "Yes, I want dinner 🍽"], [false, "No dinner today"]].map(([val, lbl]) => {
                    const on = val === true ? wantsYes : form.wantsDinner === false;
                    return (
                      <div key={String(val)} className={`radio-opt${on ? " sel" : ""}`}
                        onClick={() => setForm(p => ({ ...p, wantsDinner: val, dinnerMeal: val ? p.dinnerMeal : "" }))}
                        style={on ? { borderColor: C.purple, background: "rgba(124,58,237,.12)" } : {}}>
                        <div className={`radio-dot${on ? " on" : ""}`} style={on ? { borderColor: C.purple, background: C.purple } : {}}>{on && <div className="radio-inner" />}</div>
                        <span style={{ fontWeight: on ? 700 : 500, color: on ? C.purple : C.text }}>{lbl}</span>
                      </div>
                    );
                  })}
                </div>
                {wantsYes && form.wantsDinner !== false && (
                  <div>
                    <label className="label" style={{ marginBottom: 6 }}>
                      Select Meal<span className="req">*</span>
                      {!form.dinnerMeal && <span style={{ marginLeft: 8, fontSize: 11, color: C.orange, fontWeight: 600 }}>← Please select a meal to continue</span>}
                    </label>
                    <div className="radio-group">
                      {DINNER_MEALS.map(meal => {
                        const on    = form.dinnerMeal === meal;
                        const emoji = { Chicken: "🍗", Vegetable: "🥦", Fish: "🐟", Egg: "🥚" }[meal] || "";
                        return (
                          <div key={meal} className={`radio-opt${on ? " sel" : ""}`}
                            onClick={() => setForm(p => ({ ...p, dinnerMeal: meal, wantsDinner: true }))}
                            style={on ? { borderColor: C.purple, background: "rgba(124,58,237,.12)" } : {}}>
                            <div className={`radio-dot${on ? " on" : ""}`} style={on ? { borderColor: C.purple, background: C.purple } : {}}>{on && <div className="radio-inner" />}</div>
                            <span style={{ flex: 1, fontWeight: on ? 700 : 500, color: on ? C.purple : C.text }}>{emoji} {meal}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* Summary */}
      {(form.date || form.shift || form.pickDrop || form.route) && (
        <div style={{ background: C.ice, borderRadius: 10, padding: 14, border: `1px solid ${C.borderLight}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12 }}>
            {[
              ["Date",      form.date,     autoFields.date],
              ["Contact",   form.phone,    !!lu.phone],
              ["Shift",     form.shift,    autoFields.shift],
              ["Pick/Drop", form.pickDrop, false],
              ["Route",     form.route,    autoFields.route],
              ["Address",   form.address,  autoFields.address],
              ["Dinner",    form.wantsDinner === true && form.dinnerMeal ? form.dinnerMeal : form.wantsDinner === false ? "No dinner" : "", false],
            ].map(([lbl, val, isAuto]) => val ? (
              <div key={lbl} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <span style={{ color: C.muted, minWidth: 70, fontSize: 11, fontWeight: 700, paddingTop: 1 }}>{lbl}</span>
                <span style={{ fontWeight: 600, flex: 1, fontSize: 12 }}>{val}</span>
                {isAuto && <span style={{ fontSize: 9, color: C.cyan, background: C.cyanLight, padding: "1px 5px", borderRadius: 10 }}>AUTO</span>}
              </div>
            ) : null)}
          </div>
        </div>
      )}

      {/* FIX: cutoff deadline info / blocked banner */}
      {cutoffEnabled && !isAdmin && form.date && form.shift && (() => {
        const { blocked, reason, deadline } = checkSubmissionCutoff(form.date, form.shift);
        if (blocked) return (
          <div style={{ background: "#FEE2E0", border: `1.5px solid ${C.red}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontWeight: 800, color: C.red, fontSize: 14, marginBottom: 4 }}>⏰ Submissions Closed</div>
            <div style={{ fontSize: 13, color: C.red }}>{reason}</div>
          </div>
        );
        if (deadline) return (
          <div style={{ background: C.orangeLight, border: `1.5px solid ${C.orange}`, borderRadius: 10, padding: "12px 16px" }}>
            <div style={{ fontWeight: 700, color: C.orange, fontSize: 13 }}>⏰ Deadline: {deadline}</div>
            <div style={{ fontSize: 12, color: C.orange, marginTop: 2 }}>Submit before the deadline or your request won't be accepted.</div>
          </div>
        );
        return null;
      })()}

      <button className="btn btn-red" onClick={submit}
        disabled={cutoffEnabled && !isAdmin && form.date && form.shift && checkSubmissionCutoff(form.date, form.shift).blocked}>
        Submit Request
      </button>
    </div>
  );

  return (
    <div className="stack">
      <div>
        <div className="page-title">Contact Center Transport Request</div>
        <div className="page-sub">Hi, {user.name}. Choose how you'd like to fill your request.</div>
      </div>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 0, background: C.grey0, borderRadius: 12, padding: 4, border: `1px solid ${C.grey1}` }}>
        <button onClick={() => switchMode("auto")} style={{ flex: 1, padding: "10px 16px", borderRadius: 9, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13, transition: "all .15s", background: mode === "auto" ? C.cyan : "transparent", color: mode === "auto" ? "#fff" : C.muted, boxShadow: mode === "auto" ? "0 2px 8px rgba(0,180,216,.3)" : "none" }}>
          ⚡ Auto-fill
        </button>
        <button onClick={() => switchMode("manual")} style={{ flex: 1, padding: "10px 16px", borderRadius: 9, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13, transition: "all .15s", background: mode === "manual" ? C.deepTeal : "transparent", color: mode === "manual" ? "#fff" : C.muted, boxShadow: mode === "manual" ? "0 2px 8px rgba(13,61,86,.25)" : "none" }}>
          ✏️ Manual
        </button>
        <button onClick={() => switchMode("dinner")} style={{ flex: 1, padding: "10px 16px", borderRadius: 9, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13, transition: "all .15s", background: mode === "dinner" ? C.purple : "transparent", color: mode === "dinner" ? "#fff" : C.muted, boxShadow: mode === "dinner" ? "0 2px 8px rgba(124,58,237,.3)" : "none" }}>
          🍽 Dinner Only
        </button>
      </div>

      {mode === "auto" && (
        <div className="alert alert-info" style={{ marginBottom: 0 }}>
          <b>Auto mode</b> — Tap a working day on the calendar. Date, shift and address fill automatically.
        </div>
      )}
      {mode === "manual" && (
        <div className="alert alert-warn" style={{ marginBottom: 0 }}>
          <b>Manual mode</b> — Fill in all fields yourself. Use this if your roster isn't uploaded yet.
        </div>
      )}
      {mode === "dinner" && (
        <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}`, borderRadius: 9, padding: "10px 14px", fontSize: 13, color: C.purple, fontWeight: 500 }}>
          <b>Dinner Only</b> — No transport needed. Just select your date, shift and meal.
        </div>
      )}

      {msg && <div className={`alert alert-${msg.t === "warn" ? "warn" : msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}

      {mode === "auto" && (
        <>
          <div className="card">
            <div className="flex-b" style={{ marginBottom: 14 }}>
              <div className="sec-title" style={{ margin: 0 }}>📅 Step 1 — Pick Your Shift Date</div>
              <div className="flex-g">
                <select className="input" style={{ width: "auto", padding: "6px 10px", fontSize: 13 }} value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select className="input" style={{ width: "auto", padding: "6px 10px", fontSize: 13 }} value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
                  {[nowYear() - 1, nowYear(), nowYear() + 1].map(y => <option key={y}>{y}</option>)}
                </select>
              </div>
            </div>
            {Object.keys(rosterMonth).length === 0 ? (
              <div className="alert alert-info" style={{ margin: 0 }}>
                No roster for {MONTHS[selMonth - 1]} {selYear}. Go to <b>My Roster</b> and upload your Excel file first.
              </div>
            ) : (
              <>
                <MonthCalendar year={selYear} month={selMonth} rosterMonth={rosterMonth} onSelectDate={pickDate} selectedDate={selDate} />
                {!selDate && <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: C.muted }}>Tap a coloured working day to auto-fill the form ↓</div>}
              </>
            )}
          </div>
          {selDate && (
            <div className="card">
              <div className="flex-b" style={{ marginBottom: 16 }}>
                <div className="sec-title" style={{ margin: 0 }}>📝 Step 2 — Review &amp; Submit</div>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.cyan, background: C.cyanLight, padding: "4px 10px", borderRadius: 20 }}>AUTO fields filled from roster</span>
              </div>
              <FormFields />
            </div>
          )}
        </>
      )}

      {mode === "manual" && (
        <div className="card">
          <div className="sec-title">🚌 Transport Request Form</div>
          <FormFields />
        </div>
      )}

      {mode === "dinner" && (
        <div className="card">
          <div className="sec-title">🍽 Dinner Only Request</div>
          <div className="stack">
            <div>
              <label className="label">1. Date<span className="req">*</span></label>
              <input className="input" type="date" value={form.date} onChange={e => set("date", e.target.value)} />
            </div>
            <div>
              <label className="label">2. Contact Number<span className="req">*</span></label>
              <input className="input" placeholder="+94 77 000 0000" value={form.phone} onChange={e => set("phone", e.target.value)} />
            </div>
            <div>
              <label className="label">3. Shift<span className="req">*</span></label>
              <div className="radio-group">
                {["3PM - 12AM","7PM - 6AM","11AM - 8PM"].map(opt => {
                  const on   = form.shift === opt;
                  const info = Object.values(SHIFT_MAP).find(s => s.label === opt);
                  return (
                    <div key={opt} className={`radio-opt${on ? " sel" : ""}`}
                      onClick={() => set("shift", opt)}
                      style={on && info ? { borderColor: info.color, background: info.bg } : {}}>
                      <div className={`radio-dot${on ? " on" : ""}`} style={on && info ? { borderColor: info.color, background: info.color } : {}}>{on && <div className="radio-inner" />}</div>
                      <span style={{ flex: 1, fontWeight: on ? 700 : 500, color: on && info ? info.color : C.text }}>{opt}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {form.shift && getDinnerMode(form.shift) !== "none" && (
              <div>
                <label className="label">4. Select Meal<span className="req">*</span></label>
                {dayUsage.hasDinner ? (
                  <div className="alert alert-info">✓ You already have a dinner request for this date.</div>
                ) : (
                  <div className="radio-group">
                    {DINNER_MEALS.map(meal => {
                      const on    = form.dinnerMeal === meal;
                      const emoji = { Chicken: "🍗", Vegetable: "🥦", Fish: "🐟", Egg: "🥚" }[meal] || "";
                      return (
                        <div key={meal} className={`radio-opt${on ? " sel" : ""}`}
                          onClick={() => setForm(p => ({ ...p, dinnerMeal: meal, wantsDinner: true }))}
                          style={on ? { borderColor: C.purple, background: C.purpleLight } : {}}>
                          <div className={`radio-dot${on ? " on" : ""}`} style={on ? { borderColor: C.purple, background: C.purple } : {}}>{on && <div className="radio-inner" />}</div>
                          <span style={{ flex: 1, fontWeight: on ? 700 : 500, color: on ? C.purple : C.text }}>{emoji} {meal}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {(form.date || form.shift || form.dinnerMeal) && (
              <div style={{ background: C.ice, borderRadius: 10, padding: 14, border: `1px solid ${C.borderLight}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>Summary</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12 }}>
                  {[["Date", form.date], ["Contact", form.phone], ["Shift", form.shift], ["Meal", form.dinnerMeal]].map(([lbl, val]) => val ? (
                    <div key={lbl} style={{ display: "flex", gap: 6 }}>
                      <span style={{ color: C.muted, minWidth: 60, fontSize: 11, fontWeight: 700 }}>{lbl}</span>
                      <span style={{ fontWeight: 600 }}>{val}</span>
                    </div>
                  ) : null)}
                </div>
              </div>
            )}
            <button className="btn" style={{ background: C.purple, color: "#fff", width: "100%", justifyContent: "center", padding: 13, fontSize: 14 }} onClick={submit}>
              Submit Dinner Request
            </button>
          </div>
        </div>
      )}

      {/* FIX: pass userId so list refreshes after a new submission */}
      <MyApplications userId={user.id} refreshTrigger={submitted} />
    </div>
  );
}

// FIX: added refreshTrigger prop so the list reloads after a new submission
function MyApplications({ userId, refreshTrigger }) {
  const [apps, setApps] = useState([]);
  useEffect(() => { DB.getUserApps(userId).then(setApps); }, [userId, refreshTrigger]);
  if (!apps.length) return null;
  return (
    <div className="card-0">
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.grey1}` }}>
        <div className="sec-title" style={{ margin: 0 }}>My Submissions ({apps.length})</div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Date</th><th>Shift</th><th>Type</th><th>Dinner</th><th>Route</th><th>Submitted</th></tr></thead>
          <tbody>
            {apps.map(a => (
              <tr key={a.id}>
                <td style={{ fontWeight: 700 }}>{a.date}</td>
                <td><span className="badge badge-cyan">{a.shift}</span></td>
                <td><span className={`badge ${a.pickDrop === "PICK" ? "badge-green" : a.pickDrop === "DINNER_ONLY" ? "badge-purple" : "badge-orange"}`}>{a.pickDrop === "DINNER_ONLY" ? "🍽 Dinner" : a.pickDrop}</span></td>
                <td>{a.dinnerMeal ? <span className="badge badge-purple">{a.dinnerMeal}</span> : <span style={{ color: C.border, fontSize: 11 }}>—</span>}</td>
                <td style={{ fontSize: 12 }}>{a.route || "—"}</td>
                <td style={{ fontSize: 11, color: C.muted }}>{new Date(a.submittedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — ROSTER IMPORT
// ════════════════════════════════════════════════════════════════════════════
function AdminRosterImport() {
  const [selYear,  setSelYear]  = useState(nowYear());
  const [selMonth, setSelMonth] = useState(nowMonth());
  const [dragging, setDragging] = useState(false);
  const [msg,      setMsg]      = useState(null);
  const [results,  setResults]  = useState(null);
  const fileRef = useRef();

  const processFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const wb       = XLSX.read(e.target.result, { type: "binary", cellDates: false });
        const { empCols, result } = parseRosterExcel(wb, selYear, selMonth);
        const rawUsers = await DB.getUsers();
        const monthKey = `${selYear}-${String(selMonth).padStart(2, "0")}`;
        const matched = [], unmatched = [];
        for (const { empId, header } of empCols) {
          if (!empId) continue;
          const raw = rawUsers.find(u => u.emp_id === empId);
          if (raw && result[empId]) matched.push({ user: raw, data: result[empId], name: header, empId });
          else unmatched.push({ empId, name: header });
        }
        // FIX: merge roster_data properly so existing months for other employees aren't lost
        await Promise.all(matched.map(async m => {
          const existingRosterData = m.user.roster_data || {};
          const updated = userFromDb({
            ...m.user,
            roster_data: { ...existingRosterData, [monthKey]: m.data }
          });
          await DB.updateUser(updated);
        }));
        setResults({ matched, unmatched, monthKey });
        setMsg({ t: "ok", m: `Imported roster for ${matched.length} employee(s) for ${MONTHS[selMonth - 1]} ${selYear}.` });
      } catch (err) {
        setMsg({ t: "err", m: "Error: " + err.message });
      }
    };
    reader.readAsBinaryString(file);
  };

  return (
    <div className="stack">
      <div>
        <div className="page-title">Import Team Roster</div>
        <div className="page-sub">Upload the full team roster — all employee columns matched automatically.</div>
      </div>
      <div className="card">
        <div className="sec-title">📋 Upload Full Team Roster</div>
        <div className="alert alert-info" style={{ marginBottom: 14 }}>
          Expected format: <b>Day | Date | Name1 (EmpID1) | Name2 (EmpID2) | …</b><br />
          Employee IDs in parentheses are matched to registered accounts automatically.
        </div>
        <div className="g2" style={{ marginBottom: 14 }}>
          <div>
            <label className="label">Month</label>
            <select className="input" value={selMonth} onChange={e => setSelMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Year</label>
            <select className="input" value={selYear} onChange={e => setSelYear(Number(e.target.value))}>
              {[nowYear() - 1, nowYear(), nowYear() + 1].map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
        </div>
        {msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}
        <div
          className={`upload-zone${dragging ? " drag" : ""}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); }}
          onClick={() => fileRef.current?.click()}
        >
          <div style={{ fontSize: 30, marginBottom: 8 }}>📊</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>Drop full team roster here</div>
          <div style={{ fontSize: 12, color: C.muted }}>All employee columns parsed at once · .xlsx or .xls</div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => processFile(e.target.files[0])} />
        </div>
        {results && (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {results.matched.length > 0 && (
              <div>
                <div className="sec-title" style={{ color: C.green }}>✓ Matched & Imported ({results.matched.length})</div>
                <div className="flex-g" style={{ flexWrap: "wrap" }}>
                  {results.matched.map(m => (
                    <div key={m.empId} style={{ background: C.greenLight, borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600 }}>
                      {m.name} <span style={{ opacity: .7 }}>({m.empId})</span> · {Object.keys(m.data).length} days
                    </div>
                  ))}
                </div>
              </div>
            )}
            {results.unmatched.length > 0 && (
              <div>
                <div className="sec-title" style={{ color: C.orange }}>⚠ No matching account ({results.unmatched.length})</div>
                <div className="flex-g">
                  {results.unmatched.map(u => (
                    <div key={u.empId} style={{ background: C.orangeLight, borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 600 }}>
                      {u.name || "?"} ({u.empId})
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — ROUTE VIEW
// ════════════════════════════════════════════════════════════════════════════
function AdminRouteView({ apps, user }) {
  const [selDate,  setSelDate]  = useState(todayStr());
  const [selShift, setSelShift] = useState("All");
  const [selRoute, setSelRoute] = useState("All");

  // FIX: Add Transport Request form state
  const [showAddForm,  setShowAddForm]  = useState(false);
  const [addForm,      setAddForm]      = useState({ empId: "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", phone: "" });
  const [addLoading,   setAddLoading]   = useState(false);
  const [addMsg,       setAddMsg]       = useState(null);

  const addTransportEntry = async () => {
    if (!addForm.empId)    return setAddMsg({ t: "err", m: "Employee ID is required." });
    if (!addForm.shift)    return setAddMsg({ t: "err", m: "Please select a shift." });
    if (!addForm.pickDrop) return setAddMsg({ t: "err", m: "Please select Pick or Drop." });
    if (!addForm.address)  return setAddMsg({ t: "err", m: "Address is required." });
    if (!addForm.route)    return setAddMsg({ t: "err", m: "Please select a route." });
    setAddLoading(true);
    setAddMsg(null);
    try {
      const raw = await DB.getUserByEmpId(addForm.empId);
      if (!raw) { setAddLoading(false); return setAddMsg({ t: "err", m: `No employee found with ID "${addForm.empId}".` }); }
      const emp = userFromDb(raw);
      const newApp = {
        id: uid(), userId: emp.id, empId: emp.empId, empName: emp.name,
        date: selDate, phone: addForm.phone || emp.phone || "", shift: addForm.shift,
        pickDrop: addForm.pickDrop, address: addForm.address, mapsLink: addForm.mapsLink || "",
        route: addForm.route, wantsDinner: false, dinnerMeal: "",
        entryMode: "admin", submittedAt: new Date().toISOString(),
      };
      await DB.createApp(newApp);
      setAddMsg({ t: "ok", m: `${addForm.pickDrop} request added for ${emp.name} on ${selDate}.` });
      setAddForm({ empId: "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", phone: "" });
      // FIX: reload apps to show new entry immediately
      window.location.reload();
    } catch(e) {
      setAddMsg({ t: "err", m: "Failed: " + e.message });
    }
    setAddLoading(false);
  };

  const dayApps = apps.filter(a => {
    if (a.date !== selDate) return false;
    if (selShift !== "All" && a.shift !== selShift) return false;
    if (selRoute !== "All" && a.route !== selRoute) return false;
    // FIX: exclude dinner-only entries from route view
    if (a.pickDrop === "DINNER_ONLY" || !a.pickDrop) return false;
    return true;
  });

  const routeGroups   = ROUTES.reduce((acc, r) => { const e = dayApps.filter(a => a.route === r); if (e.length) acc[r] = e; return acc; }, {});
  const shiftsToday   = ["All", ...new Set(apps.filter(a => a.date === selDate).map(a => a.shift).filter(Boolean))];
  const totalDay      = dayApps.length;
  const pickCount     = dayApps.filter(a => a.pickDrop === "PICK").length;
  const dropCount     = dayApps.filter(a => a.pickDrop === "DROP").length;

  const exportTransportXLSX = () => {
    const wb = XLSX.utils.book_new();
    const H  = ["#", "Emp ID", "Name", "Contact", "Shift", "Pick/Drop", "Address", "Maps Link"];
    const approvedBy = user ? `${user.name} (${user.empId})` : "—";
    const exportedAt = new Date().toLocaleString();
    let hasAny = false;
    ROUTES.forEach(route => {
      const entries = dayApps.filter(a => a.route === route);
      if (!entries.length) return;
      hasAny = true;
      const rows = entries
        .sort((a, b) => a.shift.localeCompare(b.shift) || a.empName.localeCompare(b.empName))
        .map((a, i) => [i + 1, a.empId, a.empName, a.phone || "", a.shift, a.pickDrop, a.address, a.mapsLink || ""]);
      const signOff = [
        [],
        [],
        ["Approved by:", approvedBy],
        ["Exported on:", exportedAt],
      ];
      const ws = XLSX.utils.aoa_to_sheet([H, ...rows, ...signOff]);
      ws["!cols"] = [4, 10, 18, 14, 12, 10, 30, 30].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, route.replace("Route", "Rt").replace("Road", "Rd").slice(0, 31));
    });
    if (!hasAny) return;
    XLSX.writeFile(wb, `Transport_${selDate}.xlsx`);
  };

  const routeColor = {
    "Kandy Road":        { color: C.orange,  bg: C.orangeLight },
    "Negombo Road":      { color: C.cyan,    bg: C.cyanLight   },
    "Galle Road":        { color: C.green,   bg: C.greenLight  },
    "High Level Road":   { color: C.purple,  bg: C.purpleLight },
    "Athurugiriya Road": { color: C.red,     bg: C.redLight    },
    "Piliyandala Route": { color: C.midTeal, bg: C.cyanLight   },
  };

  return (
    <div className="stack">
      <div>
        <div className="page-title">Route View</div>
        <div className="page-sub">Select a date to see all transport requests grouped by route.</div>
      </div>
      <div className="card">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div><label className="label">Date</label><input className="input" type="date" value={selDate} onChange={e => setSelDate(e.target.value)} /></div>
          <div>
            <label className="label">Shift</label>
            <select className="input" value={selShift} onChange={e => setSelShift(e.target.value)}>
              {shiftsToday.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Route</label>
            <select className="input" value={selRoute} onChange={e => setSelRoute(e.target.value)}>
              <option>All</option>
              {ROUTES.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
          {[["Total", totalDay, C.cyan], ["Pick Up", pickCount, C.green], ["Drop Off", dropCount, C.orange], ["Routes Active", Object.keys(routeGroups).length, C.purple]].map(([lbl, val, col]) => (
            <div key={lbl} style={{ background: C.ice, borderRadius: 10, padding: "12px 14px", border: `1px solid ${C.grey1}` }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".05em" }}>{lbl}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: col }}>{val}</div>
            </div>
          ))}
        </div>
        {totalDay > 0 && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button className="btn btn-outline btn-sm" onClick={exportTransportXLSX}>
              <Ico n="download" s={13} />🚌 Transport Excel — {selDate}
            </button>
          </div>
        )}
      </div>

      {/* Add Transport Request card */}
      <div className="card">
        <div className="flex-b" style={{ marginBottom: showAddForm ? 16 : 0 }}>
          <div>
            <div className="sec-title" style={{ margin: 0 }}>➕ Add Transport Request</div>
            {!showAddForm && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>Manually add a transport entry for any employee.</div>}
          </div>
          <button
            className={`btn btn-sm ${showAddForm ? "btn-ghost" : "btn-cyan"}`}
            onClick={() => { setShowAddForm(p => !p); setAddMsg(null); setAddForm({ empId: "", shift: "", pickDrop: "", address: "", mapsLink: "", route: "", phone: "" }); }}>
            {showAddForm ? "✕ Cancel" : <><Ico n="plus" s={13} />Add Request</>}
          </button>
        </div>
        {showAddForm && (
          <div>
            {addMsg && <div className={`alert alert-${addMsg.t === "err" ? "err" : "ok"}`}>{addMsg.m}</div>}
            <div className="g3" style={{ marginBottom: 14 }}>
              <div>
                <label className="label">Employee ID<span className="req">*</span></label>
                <input className="input" placeholder="e.g. EMP001" value={addForm.empId}
                  onChange={e => setAddForm(p => ({ ...p, empId: e.target.value }))} />
              </div>
              <div>
                <label className="label">Shift<span className="req">*</span></label>
                <select className="input" value={addForm.shift}
                  onChange={e => setAddForm(p => ({ ...p, shift: e.target.value }))}>
                  <option value="">— Select shift —</option>
                  {SHIFT_LABELS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Pick / Drop<span className="req">*</span></label>
                <select className="input" value={addForm.pickDrop}
                  onChange={e => setAddForm(p => ({ ...p, pickDrop: e.target.value }))}>
                  <option value="">— Select —</option>
                  <option value="PICK">PICK</option>
                  <option value="DROP">DROP</option>
                </select>
              </div>
              <div>
                <label className="label">Route<span className="req">*</span></label>
                <select className="input" value={addForm.route}
                  onChange={e => setAddForm(p => ({ ...p, route: e.target.value }))}>
                  <option value="">— Select route —</option>
                  {ROUTES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Contact No.</label>
                <input className="input" placeholder="+94 77 000 0000" value={addForm.phone}
                  onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))} />
              </div>
              <div>
                <label className="label">Maps Link</label>
                <input className="input" placeholder="https://maps.app.goo.gl/…" value={addForm.mapsLink}
                  onChange={e => setAddForm(p => ({ ...p, mapsLink: e.target.value }))} />
              </div>
              <div className="col2" style={{ gridColumn: "1/-1" }}>
                <label className="label">Address<span className="req">*</span></label>
                <input className="input" placeholder="Full pickup/drop address" value={addForm.address}
                  onChange={e => setAddForm(p => ({ ...p, address: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-cyan" onClick={addTransportEntry} disabled={addLoading}>
                <Ico n="check" s={14} />{addLoading ? "Adding…" : "Confirm & Add"}
              </button>
              <span style={{ fontSize: 12, color: C.muted }}>
                Date: <b style={{ color: C.text }}>{selDate}</b>
              </span>
            </div>
          </div>
        )}
      </div>

      {totalDay === 0 && (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🚌</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>No transport requests for {selDate}</div>
          <div style={{ color: C.muted, fontSize: 13 }}>
            {selShift !== "All" || selRoute !== "All" ? "Try adjusting your filters above." : "No submissions have been made for this date yet."}
          </div>
        </div>
      )}

      {(selRoute === "All" ? ROUTES : [selRoute]).map(route => {
        const entries = routeGroups[route];
        if (!entries) return null;
        const rc    = routeColor[route] || { color: C.cyan, bg: C.cyanLight };
        const picks = entries.filter(a => a.pickDrop === "PICK").length;
        const drops = entries.filter(a => a.pickDrop === "DROP").length;
        return (
          <div key={route} className="card-0">
            <div style={{ padding: "14px 20px", background: `linear-gradient(135deg,${rc.bg} 0%,${C.white} 100%)`, borderBottom: `2px solid ${rc.color}20`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 4, height: 36, borderRadius: 4, background: rc.color, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15, color: rc.color }}>{route}</div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 1 }}>
                    <span style={{ fontWeight: 700, color: C.green }}>{picks} PICK</span>
                    <span style={{ margin: "0 6px", color: C.border }}>·</span>
                    <span style={{ fontWeight: 700, color: C.orange }}>{drops} DROP</span>
                    <span style={{ margin: "0 6px", color: C.border }}>·</span>
                    <span style={{ fontWeight: 700, color: C.text }}>{entries.length} total</span>
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[...new Set(entries.map(e => e.shift))].map(s => (
                  <span key={s} className="badge badge-cyan" style={{ fontSize: 10 }}>{s}</span>
                ))}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr><th>#</th><th>Emp ID</th><th>Name</th><th>Contact</th><th>Shift</th><th>Type</th><th>Dinner</th><th>Address</th><th>Maps</th></tr>
                </thead>
                <tbody>
                  {entries.sort((a, b) => a.shift.localeCompare(b.shift) || a.empName.localeCompare(b.empName)).map((a, i) => (
                    <tr key={a.id}>
                      <td style={{ color: C.muted, fontWeight: 700, fontSize: 12 }}>{i + 1}</td>
                      <td style={{ fontWeight: 700 }}>{a.empId}</td>
                      <td style={{ fontWeight: 600 }}>{a.empName}</td>
                      <td style={{ fontSize: 12 }}>{a.phone || "—"}</td>
                      <td><span className="badge badge-cyan" style={{ fontSize: 10 }}>{a.shift}</span></td>
                      <td><span className={`badge ${a.pickDrop === "PICK" ? "badge-green" : "badge-orange"}`}>{a.pickDrop}</span></td>
                      <td>{a.dinnerMeal ? <span className="badge badge-purple">{a.dinnerMeal}</span> : <span style={{ color: C.border, fontSize: 11 }}>—</span>}</td>
                      <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address}</td>
                      <td>{a.mapsLink ? <a href={a.mapsLink} target="_blank" rel="noreferrer" style={{ color: C.cyan, fontSize: 12 }}>📍 Map</a> : <span style={{ color: C.border, fontSize: 11 }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — DINNER MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
function AdminDinnerView({ apps, setApps, user }) {
  const [selDate,      setSelDate]      = useState(todayStr());
  const [editingId,    setEditingId]    = useState(null);
  const [editMeal,     setEditMeal]     = useState("");
  const [saving,       setSaving]       = useState(false);
  const [msg,          setMsg]          = useState(null);
  const [showAddForm,  setShowAddForm]  = useState(false);
  const [addForm,      setAddForm]      = useState({ empId: "", meal: "", shift: "" });
  const [addLoading,   setAddLoading]   = useState(false);
  const [addMsg,       setAddMsg]       = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const dinnerApps = apps
    .filter(a => a.dinnerMeal && a.date === selDate)
    .sort((a, b) => a.empName.localeCompare(b.empName));

  const mealCounts = DINNER_MEALS.map(m => ({
    meal: m,
    count: dinnerApps.filter(a => a.dinnerMeal === m).length,
    emoji: { Chicken:"🍗", Vegetable:"🥦", Fish:"🐟", Egg:"🥚" }[m] || ""
  }));

  const totalDinner = dinnerApps.length;

  const exportDinnerXLSX = async () => {
    if (!dinnerApps.length) return;
    const supplier   = await DB.getSetting("supplier") || "PICKME Food";
    const printTime  = new Date().toTimeString().slice(0, 8);
    const exportedAt = new Date().toLocaleString();
    const approvedBy = user ? `${user.name} (${user.empId})` : "—";
    const mealRows   = mealCounts.filter(x => x.count > 0);
    const data = [
      ["Food Request Manager —–– Daily Report"],
      [],
      [`Total Dinner Orders : ${dinnerApps.length}`, "", "Current Date", `: ${selDate}`],
      [],
      ["Printed time:", printTime],
      [],
      ["Meal Plan Name", "Count"],
      ...mealRows.map(({ meal, count }) => [meal, count]),
      [],
      ["Supplier Name", "Count"],
      [supplier, dinnerApps.length],
      [],
      ["Employee Number", "Emp Name", "Required Date", "Req: time", "Meal Plan"],
      ...dinnerApps.map(a => [
        a.empId, a.empName, selDate,
        new Date(a.submittedAt).toTimeString().slice(0, 8),
        a.dinnerMeal
      ]),
      [],
      [],
      ["Approved by:", approvedBy],
      ["Exported on:", exportedAt],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [18, 22, 16, 12, 12].map(w => ({ wch: w }));
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Daily Report");
    XLSX.writeFile(wb, `Dinner_Report_${selDate}.xlsx`);
  };

  const startEdit = (app) => {
    setEditingId(app.id);
    setEditMeal(app.dinnerMeal);
    setMsg(null);
  };

  const saveEdit = async (app) => {
    if (!editMeal) return;
    setSaving(true);
    await DB.updateApp(app.id, { dinner_meal: editMeal });
    setApps(prev => prev.map(a => a.id === app.id ? { ...a, dinnerMeal: editMeal } : a));
    setEditingId(null);
    setSaving(false);
    setMsg({ t: "ok", m: `Meal updated to ${editMeal} for ${app.empName}.` });
  };

  const removeDinner = async (app) => {
    await DB.updateApp(app.id, { dinner_meal: "", wants_dinner: false });
    setApps(prev => prev.map(a => a.id === app.id ? { ...a, dinnerMeal: "", wantsDinner: false } : a));
    setConfirmRemove(null);
    setMsg({ t: "ok", m: `Dinner removed for ${app.empName}.` });
  };

  const addDinnerEntry = async () => {
    if (!addForm.empId) return setAddMsg({ t: "err", m: "Employee ID is required." });
    if (!addForm.meal)  return setAddMsg({ t: "err", m: "Please select a meal." });
    if (!addForm.shift) return setAddMsg({ t: "err", m: "Please select a shift." });
    setAddLoading(true);
    setAddMsg(null);
    try {
      const raw = await DB.getUserByEmpId(addForm.empId);
      if (!raw) {
        setAddLoading(false);
        return setAddMsg({ t: "err", m: `No employee found with ID "${addForm.empId}".` });
      }
      const emp = userFromDb(raw);
      const existing = apps.find(a => a.empId === addForm.empId && a.date === selDate && a.dinnerMeal);
      if (existing) {
        setAddLoading(false);
        return setAddMsg({ t: "err", m: `${emp.name} already has a dinner request for ${selDate}.` });
      }
      const existingApp = apps.find(a => a.empId === addForm.empId && a.date === selDate);
      if (existingApp) {
        await DB.updateApp(existingApp.id, { dinner_meal: addForm.meal, wants_dinner: true });
        setApps(prev => prev.map(a => a.id === existingApp.id
          ? { ...a, dinnerMeal: addForm.meal, wantsDinner: true }
          : a
        ));
      } else {
        const newApp = {
          id: uid(), userId: emp.id, empId: emp.empId, empName: emp.name,
          date: selDate, phone: emp.phone || "", shift: addForm.shift,
          pickDrop: "DINNER_ONLY", address: "", mapsLink: "",
          route: "", wantsDinner: true, dinnerMeal: addForm.meal,
          entryMode: "admin", submittedAt: new Date().toISOString(),
        };
        await DB.createApp(newApp);
        setApps(prev => [newApp, ...prev]);
      }
      setAddMsg({ t: "ok", m: `Dinner (${addForm.meal}) added for ${emp.name} on ${selDate}.` });
      setAddForm({ empId: "", meal: "", shift: "" });
    } catch(e) {
      setAddMsg({ t: "err", m: "Failed: " + e.message });
    }
    setAddLoading(false);
  };

  const mealColor = { Chicken: C.orange, Vegetable: C.green, Fish: C.cyan, Egg: C.purple };
  const mealBg    = { Chicken: C.orangeLight, Vegetable: C.greenLight, Fish: C.cyanLight, Egg: C.purpleLight };

  return (
    <div className="stack">
      <div>
        <div className="page-title">🍽 Dinner Management</div>
        <div className="page-sub">View, edit and export daily dinner requests.</div>
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <label className="label">Date</label>
            <input className="input" type="date" value={selDate} onChange={e => { setSelDate(e.target.value); setMsg(null); }} />
          </div>
          <button className="btn btn-sm" style={{ background: C.purpleLight, color: C.purple, border: `1.5px solid ${C.purple}` }}
            onClick={exportDinnerXLSX} disabled={!dinnerApps.length}>
            <Ico n="download" s={13} c={C.purple} />Export Excel
          </button>
        </div>

        {totalDinner > 0 && (
          <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ background: C.ice, border: `1px solid ${C.grey1}`, borderRadius: 10, padding: "10px 16px", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 80 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.purple }}>{totalDinner}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: "uppercase" }}>Total</div>
            </div>
            {mealCounts.filter(x => x.count > 0).map(({ meal, count, emoji }) => (
              <div key={meal} style={{ background: mealBg[meal] || C.ice, border: `1.5px solid ${mealColor[meal] || C.border}`, borderRadius: 10, padding: "10px 16px", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 80 }}>
                <div style={{ fontSize: 18, marginBottom: 2 }}>{emoji}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: mealColor[meal] || C.text }}>{count}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: mealColor[meal] || C.muted }}>{meal}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}

      <div className="card">
        <div className="flex-b" style={{ marginBottom: showAddForm ? 16 : 0 }}>
          <div>
            <div className="sec-title" style={{ margin: 0 }}>➕ Add Dinner Request</div>
            {!showAddForm && <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>Manually add a dinner entry for any employee.</div>}
          </div>
          <button
            className={`btn btn-sm ${showAddForm ? "btn-ghost" : "btn-cyan"}`}
            onClick={() => { setShowAddForm(p => !p); setAddMsg(null); setAddForm({ empId: "", meal: "", shift: "" }); }}>
            {showAddForm ? "✕ Cancel" : <><Ico n="plus" s={13} />Add Dinner</>}
          </button>
        </div>
        {showAddForm && (
          <div>
            {addMsg && <div className={`alert alert-${addMsg.t === "err" ? "err" : "ok"}`}>{addMsg.m}</div>}
            <div className="g3" style={{ marginBottom: 14 }}>
              <div>
                <label className="label">Employee ID<span className="req">*</span></label>
                <input className="input" placeholder="e.g. 11383" value={addForm.empId}
                  onChange={e => setAddForm(p => ({ ...p, empId: e.target.value }))} />
              </div>
              <div>
                <label className="label">Shift<span className="req">*</span></label>
                <select className="input" value={addForm.shift}
                  onChange={e => setAddForm(p => ({ ...p, shift: e.target.value }))}>
                  <option value="">— Select shift —</option>
                  {SHIFT_LABELS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Meal<span className="req">*</span></label>
                <select className="input" value={addForm.meal}
                  onChange={e => setAddForm(p => ({ ...p, meal: e.target.value }))}>
                  <option value="">— Select meal —</option>
                  {DINNER_MEALS.map(m => (
                    <option key={m} value={m}>
                      {{ Chicken:"🍗", Vegetable:"🥦", Fish:"🐟", Egg:"🥚" }[m]} {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn btn-cyan" onClick={addDinnerEntry} disabled={addLoading}>
                <Ico n="check" s={14} />{addLoading ? "Adding…" : "Confirm & Add"}
              </button>
              <span style={{ fontSize: 12, color: C.muted }}>
                Date: <b style={{ color: C.text }}>{selDate}</b>
              </span>
            </div>
          </div>
        )}
      </div>

      {dinnerApps.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🍽</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>No dinner requests for {selDate}</div>
          <div style={{ color: C.muted, fontSize: 13 }}>No employees have submitted dinner requests for this date.</div>
        </div>
      ) : (
        <div className="card-0">
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.grey1}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="sec-title" style={{ margin: 0 }}>Dinner Requests — {selDate}</div>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.purple, background: C.purpleLight, padding: "4px 12px", borderRadius: 20 }}>{totalDinner} orders</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th><th>Emp ID</th><th>Name</th><th>Shift</th><th>Meal</th><th>Submitted</th><th>Edit Meal</th><th>Remove</th>
                </tr>
              </thead>
              <tbody>
                {dinnerApps.map((a, i) => (
                  <tr key={a.id}>
                    <td style={{ color: C.muted, fontWeight: 700, fontSize: 12 }}>{i + 1}</td>
                    <td style={{ fontWeight: 700 }}>{a.empId}</td>
                    <td style={{ fontWeight: 600 }}>{a.empName}</td>
                    <td><span className="badge badge-cyan" style={{ fontSize: 10 }}>{a.shift}</span></td>
                    <td>
                      {editingId === a.id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <select className="input" style={{ padding: "4px 8px", fontSize: 12, width: "auto" }}
                            value={editMeal} onChange={e => setEditMeal(e.target.value)}>
                            {DINNER_MEALS.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                          <button className="btn btn-sm btn-cyan" onClick={() => saveEdit(a)} disabled={saving}>
                            <Ico n="check" s={11} />{saving ? "…" : "Save"}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>✕</button>
                        </div>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: mealBg[a.dinnerMeal] || C.grey1, color: mealColor[a.dinnerMeal] || C.text }}>
                          {({ Chicken:"🍗", Vegetable:"🥦", Fish:"🐟", Egg:"🥚" })[a.dinnerMeal]} {a.dinnerMeal}
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>
                      {new Date(a.submittedAt).toLocaleString()}
                    </td>
                    <td>
                      {editingId !== a.id && (
                        <button className="btn btn-ghost btn-sm" onClick={() => startEdit(a)}>
                          <Ico n="edit" s={12} /> Edit
                        </button>
                      )}
                    </td>
                    <td>
                      {confirmRemove === a.id ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>Sure?</span>
                          <button className="btn btn-sm" style={{ background: C.red, color: "#fff", padding: "3px 8px" }}
                            onClick={() => removeDinner(a)}>Yes</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRemove(null)}>No</button>
                        </div>
                      ) : (
                        <button className="btn btn-ghost btn-sm" style={{ color: C.red }}
                          onClick={() => setConfirmRemove(a.id)}>
                          <Ico n="trash" s={12} c={C.red} /> Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN WHITELIST MANAGER
// ════════════════════════════════════════════════════════════════════════════
function AdminWhitelist() {
  const [list,    setList]    = useState([]);
  const [newId,   setNewId]   = useState("");
  const [msg,     setMsg]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    DB.getAdminWhitelist().then(l => { setList(l); setLoading(false); });
  }, []);

  const addId = async () => {
    const trimmed = newId.trim().toUpperCase();
    if (!trimmed) return setMsg({ t: "err", m: "Enter an Employee ID." });
    if (list.map(x => x.toUpperCase()).includes(trimmed))
      return setMsg({ t: "err", m: "This ID is already in the whitelist." });
    const next = [...list, trimmed];
    await DB.setAdminWhitelist(next);
    setList(next);
    setNewId("");
    setMsg({ t: "ok", m: `${trimmed} added to whitelist.` });
  };

  const removeId = async (id) => {
    const next = list.filter(x => x.toUpperCase() !== id.toUpperCase());
    await DB.setAdminWhitelist(next);
    setList(next);
    setMsg({ t: "ok", m: `${id} removed.` });
  };

  if (loading) return <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>;

  return (
    <div>
      {msg && <div className={`alert alert-${msg.t === "err" ? "err" : "ok"}`}>{msg.m}</div>}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input
          className="input"
          placeholder="Enter Employee ID (e.g. TL001)"
          value={newId}
          onChange={e => setNewId(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addId()}
          style={{ flex: 1 }}
        />
        <button className="btn btn-cyan" onClick={addId}>
          <Ico n="plus" s={13} /> Add
        </button>
      </div>
      {list.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 13, padding: "10px 0" }}>
          No IDs whitelisted yet. Add emp IDs above to grant admin access on registration.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {list.map(id => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 6, background: C.cyanLight, border: `1.5px solid ${C.cyan}`, borderRadius: 8, padding: "5px 10px" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: C.deepTeal }}>{id}</span>
              <button
                onClick={() => removeId(id)}
                style={{ background: "none", border: "none", cursor: "pointer", color: C.red, padding: 0, display: "flex", alignItems: "center" }}>
                <Ico n="trash" s={13} c={C.red} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
function AdminDashboard({ user, onLogout }) {
  const [tab,         setTab]         = useState("apps");
  const [apps,        setApps]        = useState([]);
  const [filter,      setFilter]      = useState("All");
  const [search,      setSearch]      = useState("");
  const [loadingApps, setLoadingApps] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [admins,       setAdmins]     = useState([]);
  const [adminForm,    setAdminForm]  = useState({ name: "", empId: "", password: "" });
  const [adminMsg,     setAdminMsg]   = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [confirmDeleteAdmin, setConfirmDeleteAdmin] = useState(null);
  const [supplier,     setSupplier]    = useState("PICKME Food");
  const [supplierEdit, setSupplierEdit]= useState(false);
  const [supplierDraft,setSupplierDraft]=useState("PICKME Food");
  // FIX: cutoff toggle state for Super Admin
  const [cutoffOn,     setCutoffOn]    = useState(true);
  const [cutoffSaving, setCutoffSaving]= useState(false);
  const [users,        setUsers]       = useState([]);
  // FIX: admin "Reset Password" fallback state
  const [resetPwUserId, setResetPwUserId] = useState(null);
  const [resetPwValue,  setResetPwValue]  = useState("");
  const [resetPwMsg,    setResetPwMsg]    = useState(null);
  // FIX: track admin's own user state so roster/profile updates persist in session
  const [adminUser,    setAdminUser]   = useState(user);

  useEffect(() => { DB.getApps().then(data => { setApps(data); setLoadingApps(false); }); }, []);
  useEffect(() => { if (tab === "apps" || tab === "routes") DB.getApps().then(setApps); }, [tab]);
  useEffect(() => { DB.getSetting("supplier").then(v => { if (v) { setSupplier(v); setSupplierDraft(v); } }); }, []);
  useEffect(() => { DB.getCutoffEnabled().then(setCutoffOn); }, []);
  useEffect(() => { DB.getAdmins().then(setAdmins); }, []);
  useEffect(() => { DB.getUsers().then(raw => setUsers(raw.map(userFromDb).filter(u => u.empId !== "ADMIN").sort((a, b) => {
    if (a.role === "admin" && b.role !== "admin") return -1;
    if (a.role !== "admin" && b.role === "admin") return 1;
    return a.name.localeCompare(b.name);
  }))); }, []);

  const saveSupplier = async () => {
    await DB.setSetting("supplier", supplierDraft);
    setSupplier(supplierDraft);
    setSupplierEdit(false);
  };

  const filtered = apps
    .filter(a => filter === "All" || a.pickDrop === filter)
    .filter(a => !search || a.empName?.toLowerCase().includes(search.toLowerCase()) || a.empId?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  const deleteApp = async (id) => {
    await DB.deleteApp(id);
    setApps(prev => prev.filter(a => a.id !== id));
    setConfirmDelete(null);
  };

  const createAdmin = async () => {
    if (!adminForm.name || !adminForm.empId || !adminForm.password)
      return setAdminMsg({ t: "err", m: "All fields are required." });
    setAdminLoading(true);
    try {
      const existing = await DB.getUserByEmpId(adminForm.empId);
      if (existing) { setAdminLoading(false); return setAdminMsg({ t: "err", m: "Employee ID already exists." }); }
      const newAdmin = {
        id: uid(), name: adminForm.name, empId: adminForm.empId, password: adminForm.password,
        role: "admin", phone: "", addresses: [], rosterData: {}, createdAt: todayStr()
      };
      await DB.createUser(newAdmin);
      setAdmins(prev => [newAdmin, ...prev]);
      setAdminForm({ name: "", empId: "", password: "" });
      setAdminMsg({ t: "ok", m: `Team Leader "${adminForm.name}" created successfully.` });
    } catch (e) {
      setAdminMsg({ t: "err", m: "Failed: " + e.message });
    }
    setAdminLoading(false);
  };

  const deleteAdmin = async (id) => {
    await DB.deleteUser(id);
    setAdmins(prev => prev.filter(a => a.id !== id));
    setConfirmDeleteAdmin(null);
  };

  // FIX: admin can directly set a new password for an employee — no email/OTP needed.
  // This is the fallback path when an employee's reset email never arrives.
  const resetEmployeePassword = async (u) => {
    if (!resetPwValue || resetPwValue.length < 4) {
      setResetPwMsg({ t: "err", m: "Password must be at least 4 characters." });
      return;
    }
    try {
      // FIX: hash before saving, same as all other password paths
      const hashed = await hashPw(resetPwValue);
      await DB.setPassword(u.id, hashed);
      setResetPwMsg({ t: "ok", m: `Password reset for ${u.name}.` });
      setResetPwUserId(null);
      setResetPwValue("");
    } catch (e) {
      setResetPwMsg({ t: "err", m: "Failed: " + e.message });
    }
  };

  const exportCSV = () => {
    const H = ["App ID", "Emp ID", "Name", "Date", "Shift", "Pick/Drop", "Address", "Maps", "Route", "Contact", "Submitted"];
    const R = filtered.map(a => [a.id, a.empId, a.empName, a.date, a.shift, a.pickDrop, a.address, a.mapsLink || "", a.route, a.phone || "", a.submittedAt]);
    const csv = [H, ...R].map(r => r.map(v => `"${String(v || "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "transport_applications.csv" }).click();
  };

  const stat = (lbl, val, col) => (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: ".05em" }}>{lbl}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: col, marginTop: 4 }}>{val}</div>
    </div>
  );

  const isSuperAdmin = user?.empId === "ADMIN";
  const TABS = [
    ["apply",     "Apply",          "bus"     ],
    ["roster",    "My Roster",      "cal"     ],
    ["profile",   "My Profile",     "user"    ],
    ["apps",      "Applications",   "form"    ],
    ["routes",    "Route View",     "route"   ],
    ["dinner",    "Dinner",         "dinner"  ],
    ["import",    "Import Roster",  "upload"  ],
    ["employees", "Employees",      "team"    ],
    ["settings",  "Settings",       "settings"],
  ];

  return (
    <div className="shell">
      <div className="sidebar">
        <div className="sb-logo">
          <div className="sb-logo-icon"><Ico n="bus" s={20} c={C.cyan} /></div>
          <div><div className="sb-logo-title">TransitHub</div><div className="sb-logo-sub">Admin</div></div>
        </div>
        <div className="sb-user">
          <div className="sb-user-name">{adminUser?.name || "Administrator"}</div>
          <div className="sb-user-id">{adminUser?.empId || "ADMIN"}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", marginTop: 2, fontWeight: 600 }}>
            {isSuperAdmin ? "Super Admin" : "Team Leader"}
          </div>
        </div>
        <div className="sb-div" />
        <div className="sb-nav">
          <div style={{ fontSize: 9, fontWeight: 800, color: "rgba(255,255,255,.3)", textTransform: "uppercase", letterSpacing: ".08em", padding: "6px 12px 2px" }}>My Transport</div>
          {TABS.filter(([id]) => ["apply","roster","profile"].includes(id)).map(([id, lbl, icon]) => (
            <button key={id} className={`sb-item${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
              <Ico n={icon} s={15} />{lbl}
            </button>
          ))}
          <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: "6px 0" }} />
          <div style={{ fontSize: 9, fontWeight: 800, color: "rgba(255,255,255,.3)", textTransform: "uppercase", letterSpacing: ".08em", padding: "4px 12px 2px" }}>Admin</div>
          {TABS.filter(([id]) => ["apps","routes","dinner","import","employees","settings"].includes(id)).map(([id, lbl, icon]) => (
            <button key={id} className={`sb-item${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
              <Ico n={icon} s={15} />{lbl}
            </button>
          ))}
        </div>
        <div className="sb-spacer" />
        <div className="sb-bottom">
          <button className="sb-item" onClick={onLogout}><Ico n="logout" s={15} />Sign Out</button>
          <div style={{ padding: "10px 12px 4px", fontSize: 10, color: "rgba(255,255,255,.25)", textAlign: "center", letterSpacing: ".04em" }}>© 2026 SACI. All Rights Reserved.</div>
        </div>
      </div>
      <div className="main-area">
        {/* FIX: pass adminUser state and updater so roster/profile changes persist */}
        {tab === "apply"   && <TransportForm user={adminUser} />}
        {tab === "roster"  && <RosterPage user={adminUser} onUserUpdate={setAdminUser} />}
        {tab === "profile" && <ProfilePage user={adminUser} onUpdate={setAdminUser} />}
        {tab === "dinner"  && <AdminDinnerView apps={apps} setApps={setApps} user={adminUser} />}
        {tab === "import"  && <AdminRosterImport />}
        {tab === "routes"  && <AdminRouteView apps={apps} user={adminUser} />}
        {tab === "apps" && (
          <div className="stack">
            <div><div className="page-title">Transport Applications</div><div className="page-sub">All submitted transport requests.</div></div>
            <div className="g4">
              {stat("Total", apps.length, C.cyan)}
              {stat("Pick Up", apps.filter(a => a.pickDrop === "PICK").length, C.green)}
              {stat("Drop Off", apps.filter(a => a.pickDrop === "DROP").length, C.orange)}
              {stat("Employees", users.length, C.purple)}
            </div>
            <div className="card-0">
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.grey1}`, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input className="input" placeholder="Search name or ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
                <div style={{ display: "flex", gap: 6 }}>
                  {["All", "PICK", "DROP"].map(f => (
                    <button key={f} className={`btn btn-sm ${filter === f ? "btn-cyan" : "btn-ghost"}`} onClick={() => setFilter(f)}>{f}</button>
                  ))}
                </div>
                <button className="btn btn-outline btn-sm" style={{ marginLeft: "auto" }} onClick={exportCSV}><Ico n="download" s={13} />Export CSV</button>
              </div>
              {filtered.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: C.muted }}>{loadingApps ? "Loading…" : "No applications."}</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl">
                    <thead><tr><th>Emp ID</th><th>Name</th><th>Date</th><th>Shift</th><th>Type</th><th>Dinner</th><th>Route</th><th>Address</th><th>Maps</th><th>Contact</th><th>Submitted</th><th>Action</th></tr></thead>
                    <tbody>
                      {filtered.map(a => (
                        <tr key={a.id}>
                          <td style={{ fontWeight: 700 }}>{a.empId}</td>
                          <td>{a.empName}</td>
                          <td style={{ fontWeight: 600 }}>{a.date}</td>
                          <td><span className="badge badge-cyan">{a.shift}</span></td>
                          <td><span className={`badge ${a.pickDrop === "PICK" ? "badge-green" : a.pickDrop === "DINNER_ONLY" ? "badge-purple" : "badge-orange"}`}>{a.pickDrop === "DINNER_ONLY" ? "🍽 Dinner" : a.pickDrop}</span></td>
                          <td>{a.dinnerMeal ? <span className="badge badge-purple">{a.dinnerMeal}</span> : <span style={{ color: C.border, fontSize: 11 }}>—</span>}</td>
                          <td style={{ fontSize: 12 }}>{a.route || "—"}</td>
                          <td style={{ fontSize: 11, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.address || "—"}</td>
                          <td>{a.mapsLink ? <a href={a.mapsLink} target="_blank" rel="noreferrer" style={{ color: C.cyan, fontSize: 12 }}>📍</a> : "—"}</td>
                          <td style={{ fontSize: 12 }}>{a.phone}</td>
                          <td style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{new Date(a.submittedAt).toLocaleString()}</td>
                          <td>
                            {confirmDelete === a.id ? (
                              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>Sure?</span>
                                <button className="btn btn-sm" style={{ background: C.red, color: "#fff", padding: "3px 8px" }} onClick={() => deleteApp(a.id)}>Yes</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(null)}>No</button>
                              </div>
                            ) : (
                              <button className="btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => setConfirmDelete(a.id)}>
                                <Ico n="trash" s={12} c={C.red} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
        {tab === "employees" && (
          <div className="stack">
            <div><div className="page-title">Employees</div><div className="page-sub">{users.filter(u => u.role !== "admin").length} employee(s) · {users.filter(u => u.role === "admin").length} team leader(s)</div></div>
            {resetPwMsg && <div className={`alert alert-${resetPwMsg.t === "err" ? "err" : "ok"}`}>{resetPwMsg.m}</div>}
            <div className="card-0">
              <table className="tbl">
                <thead><tr><th>Emp ID</th><th>Name</th><th>Contact</th><th>Email</th><th>Saved Addresses</th><th>Roster Months</th><th>Joined</th><th>Action</th></tr></thead>
                <tbody>
                  {users.map(u => {
                    const isTL = u.role === "admin";
                    return (
                    <tr key={u.id} style={isTL ? { background: "#EDE9FE" } : {}}>
                      <td style={{ fontWeight: 700 }}>
                        {u.empId}
                        {isTL && <span className="badge badge-purple" style={{ marginLeft: 6, fontSize: 10 }}>TL</span>}
                      </td>
                      <td>{u.name}</td>
                      <td style={{ fontSize: 12 }}>{u.phone || "—"}</td>
                      <td style={{ fontSize: 12 }}>{u.email || <span style={{ color: C.border }}>Not set</span>}</td>
                      <td>{(u.addresses || []).map(a => <span key={a.id} className="badge badge-cyan" style={{ marginRight: 4 }}>{a.label}</span>)}</td>
                      <td>{Object.keys(u.rosterData || {}).map(mk => <span key={mk} className="badge badge-grey" style={{ marginRight: 4 }}>{mk}</span>)}</td>
                      <td style={{ fontSize: 12, color: C.muted }}>{u.createdAt}</td>
                      <td>
                        {isSuperAdmin && !isTL && (
                          resetPwUserId === u.id ? (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <input className="input" type="password" placeholder="New password" style={{ padding: "4px 8px", fontSize: 12, width: 110 }}
                                value={resetPwValue} onChange={e => setResetPwValue(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && resetEmployeePassword(u)} autoFocus />
                              <button className="btn btn-sm btn-cyan" onClick={() => resetEmployeePassword(u)}><Ico n="check" s={11} /></button>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setResetPwUserId(null); setResetPwValue(""); }}>✕</button>
                            </div>
                          ) : (
                            <button className="btn btn-ghost btn-sm" onClick={() => { setResetPwUserId(u.id); setResetPwValue(""); setResetPwMsg(null); }}>
                              <Ico n="edit" s={11} /> Reset Password
                            </button>
                          )
                        )}
                        {(!isSuperAdmin || isTL) && <span style={{ fontSize: 11, color: C.border }}>—</span>}
                      </td>
                    </tr>
                    );
                  })}
                  {!users.length && <tr><td colSpan={8} style={{ textAlign: "center", color: C.muted, padding: 24 }}>No employees registered yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {tab === "settings" && (
          <div className="stack">
            <div><div className="page-title">Settings</div><div className="page-sub">System configuration for TransitHub.</div></div>

            {isSuperAdmin && (
              <div className="card">
                <div className="sec-title">🔐 Admin Whitelist</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
                  Only Employee IDs in this list will see the <b>"Admin access granted"</b> badge when registering — and their account will be created as Admin automatically.
                </div>
                <AdminWhitelist />
              </div>
            )}

            <div className="card">
              <div className="sec-title">👥 Team Leader Accounts</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
                Create admin accounts for team leaders — they get full access to the dashboard.
              </div>
              <div style={{ background: C.ice, borderRadius: 12, padding: 16, marginBottom: 16, border: `1.5px solid ${C.borderLight}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 12 }}>➕ Create New Team Leader</div>
                {adminMsg && <div className={`alert alert-${adminMsg.t === "err" ? "err" : "ok"}`}>{adminMsg.m}</div>}
                <div className="g3" style={{ marginBottom: 12 }}>
                  <div>
                    <label className="label">Full Name<span className="req">*</span></label>
                    <input className="input" placeholder="e.g. John Silva" value={adminForm.name}
                      onChange={e => setAdminForm(p => ({ ...p, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label">Employee ID<span className="req">*</span></label>
                    <input className="input" placeholder="e.g. TL001" value={adminForm.empId}
                      onChange={e => setAdminForm(p => ({ ...p, empId: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label">Password<span className="req">*</span></label>
                    <input className="input" type="password" placeholder="••••••••" value={adminForm.password}
                      onChange={e => setAdminForm(p => ({ ...p, password: e.target.value }))} />
                  </div>
                </div>
                <button className="btn btn-cyan" onClick={createAdmin} disabled={adminLoading}>
                  <Ico n="plus" s={14} />{adminLoading ? "Creating…" : "Create Team Leader"}
                </button>
              </div>
              <div className="sec-title" style={{ marginBottom: 10 }}>Current Admin Accounts ({admins.length})</div>
              {admins.length === 0 ? (
                <div style={{ color: C.muted, fontSize: 13, padding: "12px 0" }}>No team leader accounts yet.</div>
              ) : (
                <div className="card-0">
                  <table className="tbl">
                    <thead><tr><th>Emp ID</th><th>Name</th><th>Created</th><th>Action</th></tr></thead>
                    <tbody>
                      {admins.map(a => (
                        <tr key={a.id}>
                          <td style={{ fontWeight: 700 }}>{a.empId}</td>
                          <td>{a.name}</td>
                          <td style={{ fontSize: 12, color: C.muted }}>{a.createdAt}</td>
                          <td>
                            {a.empId === "ADMIN" ? (
                              <span style={{ fontSize: 11, color: C.muted }}>Super Admin</span>
                            ) : confirmDeleteAdmin === a.id ? (
                              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>Sure?</span>
                                <button className="btn btn-sm" style={{ background: C.red, color: "#fff", padding: "3px 8px" }} onClick={() => deleteAdmin(a.id)}>Yes</button>
                                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteAdmin(null)}>No</button>
                              </div>
                            ) : (
                              <button className="btn btn-ghost btn-sm" style={{ color: C.red }} onClick={() => setConfirmDeleteAdmin(a.id)}>
                                <Ico n="trash" s={12} c={C.red} /> Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* FIX: Submission cutoff toggle — Super Admin only */}
            {isSuperAdmin && (
              <div className="card">
                <div className="sec-title">⏰ Submission Cutoff</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
                  When enabled, employees must submit transport requests before the following deadlines:
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {[
                      ["6AM-3PM / 8AM-5PM", "8:00 PM the day before"],
                      ["3PM-12AM / 11AM-8PM", "6:00 PM same day"],
                      ["7PM-6AM", "9:00 PM same day"],
                    ].map(([shift, deadline]) => (
                      <div key={shift} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 10px", background: C.ice, borderRadius: 8 }}>
                        <span style={{ fontWeight: 700, color: C.text }}>{shift}</span>
                        <span style={{ color: C.muted }}>{deadline}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: C.cyan }}>Admins and Team Leaders always bypass the cutoff.</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div
                    onClick={async () => {
                      if (cutoffSaving) return;
                      setCutoffSaving(true);
                      const next = !cutoffOn;
                      await DB.setCutoffEnabled(next);
                      setCutoffOn(next);
                      setCutoffSaving(false);
                    }}
                    style={{
                      width: 52, height: 28, borderRadius: 14, cursor: "pointer",
                      background: cutoffOn ? C.green : C.border,
                      position: "relative", transition: "background .2s",
                      flexShrink: 0,
                    }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: "50%", background: "#fff",
                      position: "absolute", top: 3,
                      left: cutoffOn ? 27 : 3,
                      transition: "left .2s",
                      boxShadow: "0 1px 4px rgba(0,0,0,.2)",
                    }} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: cutoffOn ? C.green : C.muted }}>
                      {cutoffSaving ? "Saving…" : cutoffOn ? "Cutoff Enabled" : "Cutoff Disabled"}
                    </div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {cutoffOn ? "Employees cannot submit after the deadline." : "Employees can submit at any time."}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="card">
              <div className="sec-title">🍽 Dinner Supplier</div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>This name appears on the daily dinner report Excel under "Supplier Name".</div>
              {!supplierEdit ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ flex: 1, padding: "10px 14px", background: C.ice, borderRadius: 9, border: `1.5px solid ${C.grey1}`, fontWeight: 700, fontSize: 14 }}>{supplier}</div>
                  <button className="btn btn-outline" onClick={() => { setSupplierDraft(supplier); setSupplierEdit(true); }}><Ico n="edit" s={14} />Change</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input className="input" style={{ flex: 1 }} value={supplierDraft} onChange={e => setSupplierDraft(e.target.value)}
                    placeholder="e.g. PICKME Food" autoFocus onKeyDown={e => e.key === "Enter" && saveSupplier()} />
                  <button className="btn btn-cyan" onClick={saveSupplier}><Ico n="check" s={14} />Save</button>
                  <button className="btn btn-ghost" onClick={() => setSupplierEdit(false)}>Cancel</button>
                </div>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>Current supplier: <b style={{ color: C.text }}>{supplier}</b></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// EMPLOYEE SHELL
// ════════════════════════════════════════════════════════════════════════════
function EmployeeShell({ user: init, onLogout }) {
  const [page, setPage] = useState("apply");
  const [user, setUser] = useState(init);
  const NAV = [["apply", "Apply", "form"], ["roster", "My Roster", "cal"], ["profile", "My Profile", "user"]];
  return (
    <div className="shell">
      <div className="sidebar">
        <div className="sb-logo">
          <div className="sb-logo-icon"><Ico n="bus" s={20} c={C.cyan} /></div>
          <div><div className="sb-logo-title">TransitHub</div><div className="sb-logo-sub">Employee</div></div>
        </div>
        <div className="sb-user"><div className="sb-user-name">{user.name}</div><div className="sb-user-id">{user.empId}</div></div>
        <div className="sb-div" />
        <div className="sb-nav">
          {NAV.map(([id, lbl, icon]) => (
            <button key={id} className={`sb-item${page === id ? " active" : ""}`} onClick={() => setPage(id)}>
              <Ico n={icon} s={15} />{lbl}
            </button>
          ))}
        </div>
        <div className="sb-spacer" />
        <div className="sb-bottom">
          <button className="sb-item" onClick={onLogout}><Ico n="logout" s={15} />Sign Out</button>
          <div style={{ padding: "10px 12px 4px", fontSize: 10, color: "rgba(255,255,255,.25)", textAlign: "center", letterSpacing: ".04em" }}>© 2026 SACI. All Rights Reserved.</div>
        </div>
      </div>
      <div className="main-area">
        {page === "apply"   && <TransportForm user={user} />}
        {page === "roster"  && <RosterPage user={user} onUserUpdate={setUser} />}
        {page === "profile" && <ProfilePage user={user} onUpdate={setUser} />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ROOT
// ════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [user,     setUser]     = useState(null);
  const [booting,  setBooting]  = useState(true);
  const [dbError,  setDbError]  = useState(null);

  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS;
    document.head.appendChild(el);

    let done = false;
    const finish = (err = null) => {
      if (done) return;
      done = true;
      if (err) setDbError(err);
      setBooting(false);
    };

    const timer = setTimeout(() => finish("Connection timed out. Check your Supabase project is active."), 8000);

    (async () => {
      try {
        await DB.seedAdmin();
        const s = Session.get();
        if (s?.userId) {
          const raw = await DB.getUserById(s.userId);
          if (raw) setUser(userFromDb(raw));
        }
        clearTimeout(timer);
        finish();
      } catch (e) {
        clearTimeout(timer);
        finish(e.message);
      }
    })();

    // FIX: run cleanup checks at most once every 24h (throttled via localStorage)
    try {
      const CLEANUP_KEY = "cc_last_cleanup_check";
      const last = Number(localStorage.getItem(CLEANUP_KEY) || 0);
      if (Date.now() - last > 24 * 60 * 60 * 1000) {
        Promise.all([
          DB.cleanupInactiveEmployees(),  // deletes accounts inactive 30+ days
          DB.cleanupOldData(),            // deletes submissions & roster months older than 40 days
        ]).then(() => {
          localStorage.setItem(CLEANUP_KEY, String(Date.now()));
        });
      }
    } catch (e) { /* localStorage unavailable — skip cleanup silently */ }

    return () => { document.head.removeChild(el); clearTimeout(timer); };
  }, []);

  const logout = () => { Session.set({}); setUser(null); };

  if (booting) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0D3D56" }}>
      <div style={{ textAlign: "center", color: "#fff" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🚌</div>
        <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 6 }}>TransitHub</div>
        <div style={{ fontSize: 13, opacity: .6 }}>Connecting to database…</div>
      </div>
    </div>
  );

  if (dbError) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0D3D56", padding: 20 }}>
      <div style={{ textAlign: "center", color: "#fff", maxWidth: 420 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
        <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 10 }}>Database Unreachable</div>
        <div style={{ fontSize: 13, opacity: .7, marginBottom: 20, lineHeight: 1.7 }}>
          Could not connect to Supabase.<br />
          Make sure the <b>cc_users</b>, <b>cc_apps</b>, and <b>cc_settings</b> tables exist and RLS policies allow anonymous access.<br /><br />
          <span style={{ opacity: .5, fontSize: 12 }}>{dbError}</span>
        </div>
        <button
          onClick={() => { setDbError(null); setBooting(true); window.location.reload(); }}
          style={{ background: "#00B4D8", color: "#fff", border: "none", borderRadius: 9, padding: "10px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          Retry
        </button>
      </div>
    </div>
  );

  if (!user) return <AuthScreen onLogin={setUser} />;
  if (user.role === "admin") return <AdminDashboard user={user} onLogout={logout} />;
  return <EmployeeShell user={user} onLogout={logout} />;
}
