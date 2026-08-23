// /api/admin-action.js
// ═══════════════════════════════════════════════════════════════════════════
// Handles the two employee-account operations that only an admin should be
// able to perform on SOMEONE ELSE'S behalf: creating a Team Leader account,
// and resetting an employee's password. Both need the service-role key (to
// create/update a Supabase Auth identity that isn't the caller's own — a
// browser can never safely do that without hijacking its own session), so
// both have to live here.
//
// SECURITY: this endpoint verifies the caller is a real, currently-admin
// user via their own Supabase Auth access token (requireAdmin, below) — it
// never trusts anything the client claims about itself. A missing, invalid,
// expired, or non-admin token is rejected before anything else runs.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPA_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const AUTH_EMAIL_DOMAIN = "transithub.internal";
const authEmailFor = (empId) => `${empId.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

async function requireAdmin(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { ok: false, error: "Not signed in." };

  const { data: { user: authUser }, error: tokenErr } = await supabaseAdmin.auth.getUser(token);
  if (tokenErr || !authUser) return { ok: false, error: "Session invalid or expired." };

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("cc_users")
    .select("id, role, emp_id")
    .eq("auth_id", authUser.id)
    .maybeSingle();
  if (profileErr || !profile || profile.role !== "admin") {
    return { ok: false, error: "Admin access required." };
  }
  return { ok: true, caller: profile };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAdmin(req);
  if (!auth.ok) return res.status(403).json({ error: auth.error });

  const { action } = req.body || {};

  try {
    // ─── Create a new Team Leader account ─────────────────────────────────
    if (action === "create_tl") {
      const { name, empId, password, email } = req.body;
      if (!name || !empId || !password) {
        return res.status(400).json({ error: "Name, Employee ID and password are required." });
      }

      const { data: existing } = await supabaseAdmin.from("cc_users").select("id").eq("emp_id", empId).maybeSingle();
      if (existing) return res.status(400).json({ error: "Employee ID already exists." });

      // Add to the whitelist first, so the existing role-assignment trigger
      // (enforce_cc_users_role, from the Phase 1 SQL) correctly marks this
      // account as admin on insert. Reuses the same mechanism
      // self-registration already relies on, rather than a second, separate
      // way to grant admin access that the trigger doesn't know about.
      const { data: wl } = await supabaseAdmin.from("cc_settings").select("value").eq("key", "admin_whitelist").maybeSingle();
      let list = [];
      try { list = JSON.parse(wl?.value || "[]"); } catch {}
      if (!list.map(x => String(x).toUpperCase()).includes(empId.toUpperCase())) {
        list.push(empId);
        await supabaseAdmin.from("cc_settings").upsert({ key: "admin_whitelist", value: JSON.stringify(list) }, { onConflict: "key" });
      }

      const authEmail = authEmailFor(empId);
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: authEmail, password, email_confirm: true,
      });
      if (createErr) return res.status(500).json({ error: "Failed to create account: " + createErr.message });

      const { error: insertErr } = await supabaseAdmin.from("cc_users").insert({
        // FIX: was missing an id — cc_users.id has no default, same bug
        // caught earlier in the browser-side registration insert.
        id: Math.random().toString(36).slice(2, 9),
        auth_id: created.user.id, name, emp_id: empId, phone: "", email: email || "",
        // FIX: set explicitly rather than relying on the whitelist-reading
        // DB trigger (enforce_cc_users_role, from the Phase 1 SQL) — that
        // trigger deliberately hasn't been applied yet (RLS/Phase 1 is
        // still on hold until Phase 4 is fully tested), so nothing would
        // have set this otherwise, and the account silently ended up as a
        // plain employee. This endpoint has already independently verified
        // the caller is a real admin (requireAdmin, above), so it's correct
        // to set this directly — and once the trigger does exist later, the
        // whitelist entry added just above keeps this consistent with it too.
        role: "admin",
        addresses: [], roster_data: {}, created_at: new Date().toISOString().split("T")[0],
        last_active: new Date().toISOString(),
      });
      if (insertErr) return res.status(500).json({ error: "Failed to create profile: " + insertErr.message });

      return res.status(200).json({ ok: true });
    }

    // ─── Reset an employee's password ──────────────────────────────────────
    if (action === "reset_password") {
      const { targetUserId, newPassword } = req.body;
      if (!targetUserId || !newPassword) return res.status(400).json({ error: "Missing fields." });
      if (newPassword.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });

      const { data: target, error: targetErr } = await supabaseAdmin
        .from("cc_users").select("id, emp_id, auth_id").eq("id", targetUserId).maybeSingle();
      if (targetErr || !target) return res.status(404).json({ error: "Employee not found." });

      let authId = target.auth_id;
      if (authId) {
        // Already migrated — just change the existing Auth password.
        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: newPassword });
        if (updateErr) return res.status(500).json({ error: "Failed: " + updateErr.message });
      } else {
        // Never logged in since the Supabase Auth migration — create the
        // Auth account directly with the new password.
        const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email: authEmailFor(target.emp_id), password: newPassword, email_confirm: true,
        });
        if (createErr) return res.status(500).json({ error: "Failed: " + createErr.message });
        authId = created.user.id;
      }

      const { error: linkErr } = await supabaseAdmin
        .from("cc_users")
        .update({ auth_id: authId, reset_otp: null, reset_otp_expires: null })
        .eq("id", target.id);
      if (linkErr) return res.status(500).json({ error: "Failed: " + linkErr.message });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error: " + e.message });
  }
}
