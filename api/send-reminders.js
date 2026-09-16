// /api/send-reminders.js
// ═══════════════════════════════════════════════════════════════════════════
// Once a day, checks every subscribed employee's roster for tomorrow's
// shift. If they have one and haven't submitted a transport request for
// that date yet, sends a push notification letting them know — so they see
// it the evening before, with time to actually apply, rather than a
// last-minute deadline warning.
//
// TRIGGERED TWO WAYS, BOTH LANDING HERE:
//   1. A real Vercel Cron job (see vercel.json) — the reliable path, runs
//      once daily regardless of whether anyone opens the app.
//   2. A fallback call from the client on app load (belt-and-suspenders, in
//      case the cron job isn't set up yet or misfires).
// Either way, this only actually sends once per calendar day — guarded by
// the reminders_last_run date check below, not a rolling time window.
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const supabaseAdmin = createClient(
  process.env.SUPA_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

webpush.setVapidDetails(
  "mailto:no-reply@transithub.internal",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const getSetting = async (key, fallback) => {
  const { data } = await supabaseAdmin.from("cc_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? fallback;
};

export default async function handler(req, res) {
  try {
    // ─── Only once per calendar day, no matter how often this is called ───
    const lastRunStr = await getSetting("reminders_last_run", null);
    const today = dateStr(new Date());
    if (lastRunStr && lastRunStr.slice(0, 10) === today) {
      return res.status(200).json({ ok: true, skipped: "already sent today" });
    }
    await supabaseAdmin.from("cc_settings").upsert({ key: "reminders_last_run", value: new Date().toISOString() }, { onConflict: "key" });

    const tomorrow = dateStr(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const [{ data: users }, { data: subs }] = await Promise.all([
      supabaseAdmin.from("cc_users").select("id, role, roster_data"),
      supabaseAdmin.from("cc_push_subscriptions").select("*"),
    ]);
    if (!users?.length || !subs?.length) return res.status(200).json({ ok: true, sent: 0 });

    const subsByUser = {};
    subs.forEach((s) => { (subsByUser[s.user_id] ||= []).push(s); });

    let sent = 0;
    for (const u of users) {
      if (u.role === "admin") continue; // TLs/Super Admin don't need this reminder
      const mySubs = subsByUser[u.id];
      if (!mySubs?.length) continue;

      const rd = u.roster_data || {};
      const entry = rd[tomorrow.slice(0, 7)]?.[tomorrow];
      if (!entry || entry.shiftInfo?.off) continue; // no shift tomorrow, or it's a day off

      const { data: existing } = await supabaseAdmin
        .from("cc_apps").select("id").eq("user_id", u.id).eq("date", tomorrow).limit(1);
      if (existing?.length) continue; // already applied for tomorrow

      const shiftLabel = entry.shiftInfo?.label || entry.shiftRaw;
      const payload = JSON.stringify({
        title: "Shift tomorrow — don't forget to apply",
        body: `You're on ${shiftLabel} tomorrow (${tomorrow}). Open TransitHub to submit your transport request.`,
        url: "/",
      });

      for (const s of mySubs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++;
        } catch (e) {
          // Subscription no longer valid — clean it up so future runs don't keep retrying it.
          if (e.statusCode === 404 || e.statusCode === 410) {
            await supabaseAdmin.from("cc_push_subscriptions").delete().eq("id", s.id);
          } else {
            console.error("send-reminders: push send failed:", e.message);
          }
        }
      }
    }

    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    console.error("send-reminders: unexpected error:", e?.message || e);
    return res.status(500).json({ error: "Failed" });
  }
}
