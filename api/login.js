// /api/login.js
// ═══════════════════════════════════════════════════════════════════════════
// Vercel serverless function. Runs on Vercel's server, never in the browser
// — that's what makes it safe to hold SUPABASE_SERVICE_ROLE_KEY, a key that
// bypasses RLS entirely. NEVER put that key behind a VITE_ prefix or
// anywhere it could end up in the shipped JS bundle.
//
// WHAT THIS ENDPOINT DOES, AND — IMPORTANT — WHAT IT DOESN'T:
// It does NOT log the person in. It only checks their old password and, if
// correct, makes sure a Supabase Auth account exists for them with that
// same password. The actual sign-in happens back in the browser afterward,
// via the normal `supabase.auth.signInWithPassword()` call using the public
// anon key — the same call Supabase's own docs use everywhere. This
// endpoint's only job is the one-time bridge from "old bcrypt row" to
// "real Supabase Auth account", so this function should only be needed
// once per person, ever.
//
// CLIENT-SIDE LOGIN FLOW THIS SUPPORTS (built in Phase 3):
//   1. Try supabase.auth.signInWithPassword() directly first (cheap, no
//      server hop, works for anyone already migrated).
//   2. If that fails, POST here. If this succeeds, retry step 1 — it will
//      succeed now, since the Auth account exists.
//   3. If this also fails, the credentials are genuinely wrong.
//
// FIX (Phase 5 hardening):
//   - Error detail is now logged server-side only (console.error, visible
//     in Vercel's function logs) instead of returned to the client — the
//     detailed messages were essential for debugging tonight, but leaving
//     them client-visible in the shipped app hands real internal detail to
//     anyone probing the login form.
//   - Real server-side rate limiting via the cc_login_attempts table. The
//     old lockout was purely a client-side localStorage counter — we
//     personally proved it's trivial to bypass with an incognito window
//     during tonight's debugging, and worse, this endpoint itself had zero
//     throttling of its own, so a script could brute-force any Employee
//     ID's password directly with no limit at all. This closes that gap
//     independent of anything the browser does.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const supabaseAdmin = createClient(
  process.env.SUPA_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only env var — no VITE_ prefix
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const AUTH_EMAIL_DOMAIN = "transithub.internal";
const authEmailFor = (empId) => `${empId.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { empId, password } = req.body || {};
  if (!empId || !password) return res.status(400).json({ error: "Employee ID and password required" });

  try {
    // ─── Server-side rate limit check ──────────────────────────────────────
    const { data: attemptRow } = await supabaseAdmin
      .from("cc_login_attempts")
      .select("attempts, locked_until")
      .eq("emp_id", empId)
      .maybeSingle();

    if (attemptRow?.locked_until && new Date(attemptRow.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(attemptRow.locked_until).getTime() - Date.now()) / 60000);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.` });
    }

    const recordFailure = async () => {
      const attempts = (attemptRow?.attempts || 0) + 1;
      const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
      await supabaseAdmin
        .from("cc_login_attempts")
        .upsert({ emp_id: empId, attempts, locked_until: lockedUntil }, { onConflict: "emp_id" })
        .then(() => {}, () => {});
      return { attempts, lockedUntil };
    };

    const clearFailures = async () => {
      await supabaseAdmin.from("cc_login_attempts").delete().eq("emp_id", empId).then(() => {}, () => {});
    };

    // 1. Look up the legacy row. This uses the service-role key, so it
    // bypasses RLS entirely — this endpoint IS the one deliberate, narrow
    // exception to "you can only read your own row" from Phase 1, and it's
    // safe only because it never returns the row's contents to the caller,
    // only a yes/no.
    const { data: user, error } = await supabaseAdmin
      .from("cc_users")
      .select("id, emp_id, password, auth_id")
      .eq("emp_id", empId)
      .maybeSingle();

    if (error) {
      console.error("api/login: database error looking up user:", error.message);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
    if (!user) {
      const { attempts } = await recordFailure();
      const remaining = MAX_ATTEMPTS - attempts;
      if (remaining <= 0) return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
      return res.status(401).json({ error: `Invalid Employee ID or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` });
    }

    // 2. Verify against whatever's actually stored — bcrypt hash (the
    // normal case) or, for any row that somehow never migrated off plain
    // text, a direct compare. Same logic your client-side verifyPw() used.
    const stored = user.password;
    const isHashed = typeof stored === "string" && stored.startsWith("$2");
    const passwordOk = isHashed ? await bcrypt.compare(password, stored) : password === stored;

    if (!passwordOk) {
      const { attempts } = await recordFailure();
      const remaining = MAX_ATTEMPTS - attempts;
      if (remaining <= 0) return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
      return res.status(401).json({ error: `Invalid Employee ID or password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` });
    }

    await clearFailures();

    const authEmail = authEmailFor(user.emp_id);

    // 3. They just proved they know the password. If they don't have a
    // Supabase Auth account yet, create one now with the password we just
    // verified — this is the only moment that plaintext password exists
    // anywhere; it's handed straight to Supabase Auth's own hashing and
    // never stored by us.
    if (!user.auth_id) {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: authEmail,
        password,
        email_confirm: true, // already verified via the legacy check above
      });
      if (createErr) {
        console.error("api/login: Supabase Auth account creation failed:", createErr.message);
        return res.status(500).json({ error: "Could not complete sign-in. Please try again." });
      }
      const { error: linkErr } = await supabaseAdmin
        .from("cc_users")
        .update({ auth_id: created.user.id })
        .eq("id", user.id);
      if (linkErr) {
        console.error("api/login: linking auth_id failed:", linkErr.message);
        return res.status(500).json({ error: "Could not complete sign-in. Please try again." });
      }
    }

    // 4. Tell the browser what email to use for the real sign-in call.
    // Deliberately not returning a session here — the browser does that
    // itself via signInWithPassword, using the public anon key.
    return res.status(200).json({ ok: true, authEmail });
  } catch (e) {
    console.error("api/login: unexpected error:", e?.message || e);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
