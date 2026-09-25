// supabase/functions/send-appointment-notifications/index.ts
//
// Rulează la fiecare minut (vezi cron.schedule din migrarea SQL).
// Caută în scheduled_notifications rândurile "pending" a căror scheduled_send_at
// a trecut deja, trimite un Web Push pentru fiecare, și actualizează statusul
// la "sent" sau "missed".
//
// Secrete necesare (setează-le o singură dată, vezi instrucțiunile de deploy):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tu@exemplu.ro
// SUPABASE_URL și SUPABASE_SERVICE_ROLE_KEY sunt injectate automat de Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Cât timp după ora țintă mai încercăm trimiterea, înainte s-o marcăm "missed"
// (util dacă job-ul cron a fost întrerupt câteva minute, ex. la deploy).
const MISSED_GRACE_MINUTES = 10;

Deno.serve(async (_req: Request) => {
  const now = new Date();

  const { data: due, error } = await supabase
    .from("scheduled_notifications")
    .select(
      "id, appointment_id, employee_id, scheduled_send_at, appointments(start_time, status, clients(name), services(name))"
    )
    .eq("status", "pending")
    .lte("scheduled_send_at", now.toISOString());

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let sent = 0;
  let missed = 0;
  let skipped = 0;

  for (const row of due ?? []) {
    const appt = (row as any).appointments;

    // Programarea a fost ștearsă, anulată sau deja finalizată între timp: nu mai trimitem.
    // Statusul "unconfirmed" NU mai e exclus — trimitem și pentru el, doar marcăm în text.
    if (!appt || appt.status === "cancelled" || appt.status === "completed") {
      await supabase
        .from("scheduled_notifications")
        .update({ status: "cancelled" })
        .eq("id", row.id);
      skipped++;
      continue;
    }

    const isUnconfirmed = appt.status === "unconfirmed";

    const graceLimit = new Date(row.scheduled_send_at);
    graceLimit.setMinutes(graceLimit.getMinutes() + MISSED_GRACE_MINUTES);
    const isTooLate = now > graceLimit;

    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("employee_id", row.employee_id);

    if (!subs || subs.length === 0) {
      // Angajata n-a activat notificările pe niciun dispozitiv.
      if (isTooLate) {
        await supabase
          .from("scheduled_notifications")
          .update({ status: "missed" })
          .eq("id", row.id);
        missed++;
      }
      continue;
    }

    const payload = JSON.stringify({
      title: isUnconfirmed ? "Programare neconfirmată în curând!" : "Programare în curând!",
      body: `${appt.clients?.name || "Clientă"} — ${appt.services?.name || "programare"} la ${new Date(
        appt.start_time
      ).toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })}${
        isUnconfirmed ? " · Încă neconfirmată" : ""
      }`,
      tag: `appt-${row.appointment_id}`,
      appointmentId: row.appointment_id,
    });

    let anySuccess = false;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        anySuccess = true;
      } catch (err: any) {
        // Abonament expirat/invalid (dispozitiv dezinstalat etc.) — îl curățăm.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        }
      }
    }

    if (anySuccess) {
      await supabase
        .from("scheduled_notifications")
        .update({ status: "sent", sent_at: now.toISOString() })
        .eq("id", row.id);
      sent++;
    } else if (isTooLate) {
      await supabase
        .from("scheduled_notifications")
        .update({ status: "missed" })
        .eq("id", row.id);
      missed++;
    }
  }

  return new Response(
    JSON.stringify({ processed: due?.length ?? 0, sent, missed, skipped }),
    { headers: { "Content-Type": "application/json" } }
  );
});
