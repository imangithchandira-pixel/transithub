// /api/password-reset.js
// ═══════════════════════════════════════════════════════════════════════════
// Handles both steps of "forgot password" server-side, because — as flagged
// in the Phase 1 SQL — reading a stranger's email and writing an OTP to
// their row is something RLS correctly refuses to allow from the browser.
// This is the other deliberate exception, alongside /api/login.js, and for
// the same reason: it only runs on Vercel's server, holds the service-role
// key, and never returns more than the minimum needed (a masked email, a
// yes/no).
//
// ONE THING TO SET UP BEFORE THIS WORKS: your current EMAILJS_SERVICE_ID /
// TEMPLATE_ID / PUBLIC_KEY are for the @emailjs/browser package, which is
// built to run in a browser tab (it partly trusts the browser's origin).
// Calling EmailJS from a server needs their separate @emailjs/nodejs
// package instead, which authenticates with a PRIVATE key from your EmailJS
// dashboard (Account → API Keys) rather than the public one. Grab that key
// and set it as EMAILJS_PRIVATE_KEY below — this is a five-minute setup step
// on EmailJS's site, not something I can generate for you.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import { send } from "@emailjs/nodejs";

const supabaseAdmin = createClient(
  process.env.SUPA_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const AUTH_EMAIL_DOMAIN = "transithub.internal";
const authEmailFor = (empId) => `${empId.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

const maskEmail = (email) => {
  if (!email || !email.includes("@")) return email || "";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}${"*".repeat(Math.max(name.length - 2, 2))}@${domain}`;
};

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { step, empId, otp, newPassword } = req.body || {};

  try {
    // ─── Step 1: "request" — look up the account, email them a code ──────
    if (step === "request") {
      if (!empId) return res.status(400).json({ error: "Employee ID required" });

      const { data: user, error } = await supabaseAdmin
        .from("cc_users")
        .select("id, name, email")
        .eq("emp_id", empId)
        .maybeSingle();

      // Deliberately vague on "not found" vs "no email on file" would leak
      // less, but this app's existing UX already distinguishes them, so we
      // keep that behavior rather than changing product behavior as a
      // side-effect of the security fix.
      // FIX: same distinction as api/login.js — a real DB/connection error
      // now surfaces differently from a genuine "no such account."
      if (error) return res.status(500).json({ error: "Database error: " + error.message });
      if (!user) return res.status(404).json({ error: "No account found with that Employee ID." });
      if (!user.email) return res.status(400).json({ error: "No email is on file for this account. Ask your Admin/Team Leader to reset it for you." });

      const code = genCode();
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error: otpErr } = await supabaseAdmin
        .from("cc_users")
        .update({ reset_otp: code, reset_otp_expires: expires })
        .eq("id", user.id);
      if (otpErr) return res.status(500).json({ error: "Could not start reset: " + otpErr.message });

      // FIX: wrap the EmailJS send specifically, since its errors don't
      // always have a normal .message property — without this, a failure
      // here surfaced as the unhelpful "Unexpected error: undefined".
      try {
        await send(
          process.env.EMAILJS_SERVICE_ID,
          process.env.EMAILJS_TEMPLATE_ID,
          { to_email: user.email, to_name: user.name, otp_code: code },
          { publicKey: process.env.EMAILJS_PUBLIC_KEY, privateKey: process.env.EMAILJS_PRIVATE_KEY }
        );
      } catch (emailErr) {
        const detail = emailErr?.message || emailErr?.text || emailErr?.status || JSON.stringify(emailErr) || "unknown error";
        return res.status(500).json({ error: "Could not send email: " + detail });
      }

      return res.status(200).json({ ok: true, maskedEmail: maskEmail(user.email) });
    }

    // ─── Step 2: "verify" — check the code, set the new password ─────────
    if (step === "verify") {
      if (!empId || !otp || !newPassword) return res.status(400).json({ error: "Missing fields" });
      if (newPassword.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });

      const { data: user, error } = await supabaseAdmin
        .from("cc_users")
        .select("id, emp_id, auth_id, reset_otp, reset_otp_expires")
        .eq("emp_id", empId)
        .maybeSingle();

      if (error || !user || !user.reset_otp) {
        return res.status(400).json({ error: "Code expired or not found. Please request a new one." });
      }
      if (user.reset_otp !== otp) {
        return res.status(400).json({ error: "Incorrect code." });
      }
      if (new Date(user.reset_otp_expires).getTime() < Date.now()) {
        return res.status(400).json({ error: "Code expired. Please request a new one." });
      }

      const authEmail = authEmailFor(user.emp_id);
      let authId = user.auth_id;

      if (authId) {
        // Already has a Supabase Auth account — just change its password.
        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: newPassword });
        if (updateErr) return res.status(500).json({ error: "Failed: " + updateErr.message });
      } else {
        // Never logged in since the migration, so no Auth account exists
        // yet — create it directly with the new password.
        const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
          email: authEmail,
          password: newPassword,
          email_confirm: true,
        });
        if (createErr) return res.status(500).json({ error: "Failed: " + createErr.message });
        authId = created.user.id;
      }

      // Clear the OTP and link auth_id, same "one write, both fields" shape
      // as the old DB.setPassword helper.
      const { error: clearErr } = await supabaseAdmin
        .from("cc_users")
        .update({ auth_id: authId, reset_otp: null, reset_otp_expires: null })
        .eq("id", user.id);
      if (clearErr) return res.status(500).json({ error: "Failed: " + clearErr.message });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown step" });
  } catch (e) {
    // FIX: fall back gracefully when the caught value doesn't have a normal
    // .message (some SDKs throw plain objects/strings) — this is what was
    // previously showing up as the unhelpful "Unexpected error: undefined".
    const detail = e?.message || (typeof e === "string" ? e : JSON.stringify(e)) || "unknown error";
    return res.status(500).json({ error: "Unexpected error: " + detail });
  }
}
