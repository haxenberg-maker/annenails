-- ============================================================================
-- Notificări Push în fundal — migrare completă
-- Rulează acest script O SINGURĂ DATĂ în Supabase → SQL Editor.
-- Presupune că employees.notif_lead_minutes există deja (ai adăugat-o deja).
-- ============================================================================

-- 1) Abonamentele push ale fiecărui dispozitiv, per angajată
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_key unique (endpoint)
);

create index if not exists idx_push_subscriptions_employee
  on public.push_subscriptions using btree (employee_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "authenticated can manage push_subscriptions" on public.push_subscriptions;
create policy "authenticated can manage push_subscriptions"
on public.push_subscriptions
for all
to authenticated
using (true)
with check (true);


-- 2) Urmărirea statusului notificării pentru fiecare programare
create table if not exists public.scheduled_notifications (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  scheduled_send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'missed', 'cancelled')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint scheduled_notifications_appointment_key unique (appointment_id)
);

create index if not exists idx_scheduled_notifications_due
  on public.scheduled_notifications using btree (status, scheduled_send_at);

alter table public.scheduled_notifications enable row level security;

drop policy if exists "authenticated can manage scheduled_notifications" on public.scheduled_notifications;
create policy "authenticated can manage scheduled_notifications"
on public.scheduled_notifications
for all
to authenticated
using (true)
with check (true);


-- 3) Ține scheduled_notifications sincronizat automat cu appointments:
--    creează/actualizează/anulează rândul de tracking la fiecare schimbare.
create or replace function public.sync_scheduled_notification()
returns trigger
language plpgsql
security definer
as $$
declare
  lead_minutes int;
  send_at timestamptz;
begin
  if (TG_OP = 'DELETE') then
    delete from public.scheduled_notifications where appointment_id = old.id;
    return old;
  end if;

  if (new.status <> 'confirmed') then
    update public.scheduled_notifications
      set status = 'cancelled'
      where appointment_id = new.id and status = 'pending';
    return new;
  end if;

  select coalesce(notif_lead_minutes, 30) into lead_minutes
  from public.employees where id = new.employee_id;

  send_at := new.start_time - (coalesce(lead_minutes, 30) || ' minutes')::interval;

  insert into public.scheduled_notifications (appointment_id, employee_id, scheduled_send_at, status)
  values (new.id, new.employee_id, send_at, 'pending')
  on conflict (appointment_id) do update
    set employee_id = excluded.employee_id,
        scheduled_send_at = excluded.scheduled_send_at,
        status = case
          when public.scheduled_notifications.status = 'sent' then public.scheduled_notifications.status
          else 'pending'
        end,
        sent_at = case
          when public.scheduled_notifications.status = 'sent' then public.scheduled_notifications.sent_at
          else null
        end;

  return new;
end;
$$;

drop trigger if exists trg_sync_scheduled_notification on public.appointments;
create trigger trg_sync_scheduled_notification
after insert or delete or update of start_time, employee_id, status
on public.appointments
for each row execute function public.sync_scheduled_notification();


-- 4) Dacă o angajată își schimbă intervalul de anunț, recalculăm din mers
--    programările viitoare care încă n-au fost trimise.
create or replace function public.resync_pending_notifications_for_employee()
returns trigger
language plpgsql
security definer
as $$
begin
  if (new.notif_lead_minutes is distinct from old.notif_lead_minutes) then
    update public.scheduled_notifications sn
      set scheduled_send_at = a.start_time - (coalesce(new.notif_lead_minutes, 30) || ' minutes')::interval
      from public.appointments a
      where sn.appointment_id = a.id
        and sn.employee_id = new.id
        and sn.status = 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_resync_pending_notifications on public.employees;
create trigger trg_resync_pending_notifications
after update of notif_lead_minutes on public.employees
for each row execute function public.resync_pending_notifications_for_employee();


-- 5) Extensiile necesare pentru a rula funcția Edge automat, o dată pe minut.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 6) Programează apelul periodic. ÎNLOCUIEȘTE cele două valori de mai jos:
--    - <project-ref>       → ex: mvsgyaojvrlrhvvetzeh (din SUPABASE_URL)
--    - <service-role-key>  → Project Settings → API → service_role secret
-- Rulează acest bloc SEPARAT, după ce ai făcut deploy la Edge Function.
select cron.schedule(
  'send-appointment-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.functions.supabase.co/send-appointment-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <service-role-key>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Ca să verifici ulterior sau să oprești job-ul cron:
--   select * from cron.job;
--   select cron.unschedule('send-appointment-notifications');
