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
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const supabaseAdmin = createClient(
  process.env.SUPA_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only env var — no VITE_ prefix
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Supabase Auth needs an email-shaped identifier even though the app logs
// in by Employee ID. This is never shown to the user and is unrelated to
// their real contact email (the `email` column on cc_users) — it only
// exists so Supabase Auth has something to key on.
const AUTH_EMAIL_DOMAIN = "transithub.internal";
const authEmailFor = (empId) => `${empId.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { empId, password } = req.body || {};
  if (!empId || !password) return res.status(400).json({ error: "Employee ID and password required" });

  try {
    const { data: user, error } = await supabaseAdmin
      .from("cc_users")
      .select("id, emp_id, password, auth_id")
      .eq("emp_id", empId)
      .maybeSingle();

    // FIX: distinguish a real Supabase/connection error from a genuine
    // "no such Employee ID" — these were previously conflated into the same
    // generic message, which makes a broken SUPA_URL/service-role key
    // indistinguishable from a real wrong-password attempt.
    if (error) {
      return res.status(500).json({ error: "Database error: " + error.message });
    }
    if (!user) {
      return res.status(401).json({ error: "Invalid Employee ID or password" });
    }

    const stored = user.password;
    const isHashed = typeof stored === "string" && stored.startsWith("$2");
    const passwordOk = isHashed ? await bcrypt.compare(password, stored) : password === stored;

    if (!passwordOk) {
      return res.status(401).json({ error: "Invalid Employee ID or password" });
    }

    const authEmail = authEmailFor(user.emp_id);

    if (!user.auth_id) {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: authEmail,
        password,
        email_confirm: true,
      });
      if (createErr) {
        return res.status(500).json({ error: "Migration failed: " + createErr.message });
      }
      const { error: linkErr } = await supabaseAdmin
        .from("cc_users")
        .update({ auth_id: created.user.id })
        .eq("id", user.id);
      if (linkErr) {
        return res.status(500).json({ error: "Migration failed: " + linkErr.message });
      }
    }

    return res.status(200).json({ ok: true, authEmail });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error: " + e.message });
  }
}
