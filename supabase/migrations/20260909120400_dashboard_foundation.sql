create extension if not exists pgcrypto;

create type public.operator_role as enum ('admin','operator','viewer');
create type public.integration_state as enum ('pending','succeeded','failed');

create table public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug in ('wagoo','2avendas')),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_normalized text generated always as (lower(trim(email))) stored,
  display_name text,
  phone text,
  status text not null default 'active' check (status in ('active','inactive','deleted')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_normalized_uidx on public.users(email_normalized) where email_normalized is not null;

create table public.operator_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  role public.operator_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_product_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  external_user_id text not null,
  organization_id text,
  external_status text,
  external_role text,
  external_plan text,
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, external_user_id),
  unique(user_id, product_id, organization_id)
);

create table public.user_activity_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  account_id uuid references public.user_product_accounts(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id,event_id)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  account_id uuid references public.user_product_accounts(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  organization_id text,
  plan text,
  status text not null default 'unknown',
  current_period_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id),
  account_id uuid references public.user_product_accounts(id) on delete set null,
  stripe_event_id text not null unique,
  stripe_object_id text,
  event_type text not null,
  amount bigint,
  currency text,
  status text,
  organization_id text,
  plan text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.access_links (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  account_id uuid references public.user_product_accounts(id) on delete set null,
  kind text not null check (kind in ('promo','complimentary')),
  idempotency_key text not null unique,
  url text not null,
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id),
  event_type text not null,
  external_event_id text,
  state public.integration_state not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index integration_events_external_uidx on public.integration_events(product_id,external_event_id) where external_event_id is not null;

create table public.integration_commands (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  account_id uuid references public.user_product_accounts(id) on delete set null,
  action text not null check (action in ('role.set','status.set','plan.set','access.grant','user.delete')),
  idempotency_key text not null unique,
  state public.integration_state not null default 'pending',
  request jsonb not null default '{}'::jsonb,
  response jsonb,
  requested_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null default 'info' check (severity in ('info','warning','error','success')),
  title text not null,
  body text,
  product_id uuid references public.products(id),
  user_id uuid references public.users(id) on delete set null,
  account_id uuid references public.user_product_accounts(id) on delete set null,
  source_event_id text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  signature_timestamp timestamptz,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider,event_id)
);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  state public.integration_state not null default 'pending',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  cursor text,
  records_seen integer not null default 0,
  records_changed integer not null default 0,
  divergences integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_auth_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  product_id uuid references public.products(id),
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_product_accounts_user_idx on public.user_product_accounts(user_id);
create index user_product_accounts_org_idx on public.user_product_accounts(product_id,organization_id);
create index user_activity_events_time_idx on public.user_activity_events(product_id,occurred_at desc);
create index subscriptions_status_idx on public.subscriptions(product_id,status);
create index payment_events_created_idx on public.payment_events(created_at desc);
create index notifications_feed_idx on public.notifications(archived_at,created_at desc);
create index integration_commands_state_idx on public.integration_commands(state,created_at);
create index audit_logs_actor_idx on public.audit_logs(actor_auth_user_id,created_at desc);

create or replace function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['products','users','operator_profiles','user_product_accounts','user_activity_events','subscriptions','payment_events','access_links','integration_events','integration_commands','notifications','webhook_deliveries','sync_runs','audit_logs']
  loop execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',t); end loop;
end $$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create or replace function private.is_dashboard_operator() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.operator_profiles where auth_user_id = auth.uid())
$$;
create or replace function private.has_dashboard_role(required_roles public.operator_role[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.operator_profiles where auth_user_id = auth.uid() and role = any(required_roles))
$$;
revoke all on function private.is_dashboard_operator() from public, anon;
revoke all on function private.has_dashboard_role(public.operator_role[]) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_dashboard_operator() to authenticated;
grant execute on function private.has_dashboard_role(public.operator_role[]) to authenticated;

do $$ declare t text; begin
  foreach t in array array['products','users','operator_profiles','user_product_accounts','user_activity_events','subscriptions','payment_events','access_links','integration_events','integration_commands','notifications','webhook_deliveries','sync_runs','audit_logs']
  loop execute format('alter table public.%I enable row level security',t); end loop;
end $$;

do $$ declare t text; begin
  foreach t in array array['products','users','operator_profiles','user_product_accounts','user_activity_events','subscriptions','payment_events','access_links','integration_events','integration_commands','notifications','webhook_deliveries','sync_runs','audit_logs']
  loop execute format('create policy operator_select on public.%I for select to authenticated using (private.is_dashboard_operator())',t); end loop;
end $$;
create policy operator_notification_update on public.notifications for update to authenticated
  using (private.is_dashboard_operator())
  with check (private.is_dashboard_operator());

revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant update(read_at,archived_at) on public.notifications to authenticated;

create or replace view public.dashboard_metrics_summary with (security_invoker=true) as
select p.slug as product,
 coalesce(a.accounts,0) as accounts,
 coalesce(a.active_accounts,0) as active_accounts,
 coalesce(s.active_subscriptions,0) as active_subscriptions,
 coalesce(pe.successful_payment_amount,0) as successful_payment_amount
from public.products p
left join lateral (
  select count(*) accounts, count(*) filter(where external_status='active') active_accounts
  from public.user_product_accounts where product_id=p.id
) a on true
left join lateral (
  select count(*) filter(where status in ('active','trialing')) active_subscriptions
  from public.subscriptions where product_id=p.id
) s on true
left join lateral (
  select sum(amount) filter(where status in ('paid','succeeded')) successful_payment_amount
  from public.payment_events where product_id=p.id
) pe on true;

create or replace view public.dashboard_unified_users with (security_invoker=true) as
select
 u.id,
 u.email,
 u.display_name as name,
 u.status,
 u.created_at,
 activity.last_login_at,
 accounts.product_accounts,
 accounts.products,
 accounts.plan,
 billing.payment_status,
 accounts.last_synced_at
from public.users u
left join lateral (
 select
   coalesce(
     jsonb_agg(
       jsonb_build_object(
         'id', a.id,
         'user_id', a.user_id,
         'product_id', a.product_id,
         'product_slug', p.slug,
         'external_user_id', a.external_user_id,
         'organization_id', a.organization_id,
         'role', a.external_role,
         'status', a.external_status,
         'plan', a.external_plan,
         'last_login_at', la.last_login_at,
         'last_synced_at', a.last_synced_at,
         'metadata', a.metadata
       )
       order by p.slug
     ),
     '[]'::jsonb
   ) as product_accounts,
   coalesce(array_agg(distinct p.slug) filter (where p.slug is not null), '{}'::text[]) as products,
   (array_agg(a.external_plan order by a.updated_at desc) filter (where a.external_plan is not null))[1] as plan,
   max(a.last_synced_at) as last_synced_at
 from public.user_product_accounts a
 join public.products p on p.id = a.product_id
 left join lateral (
   select max(e.occurred_at) as last_login_at
   from public.user_activity_events e
   where e.account_id = a.id and e.event_type in ('user.first_login','session.started')
 ) la on true
 where a.user_id = u.id
) accounts on true
left join lateral (
 select max(e.occurred_at) as last_login_at
 from public.user_activity_events e
 where e.user_id = u.id and e.event_type in ('user.first_login','session.started')
) activity on true
left join lateral (
 select s.status as payment_status
 from public.subscriptions s
 join public.user_product_accounts a on a.id = s.account_id
 where a.user_id = u.id
 order by s.updated_at desc
 limit 1
) billing on true;
grant select on public.dashboard_metrics_summary,public.dashboard_unified_users to authenticated;
revoke all on public.dashboard_metrics_summary,public.dashboard_unified_users from anon;

create or replace function public.get_dashboard_metrics() returns setof public.dashboard_metrics_summary
language sql stable security invoker set search_path='' as $$ select * from public.dashboard_metrics_summary $$;
revoke all on function public.get_dashboard_metrics() from public, anon;
grant execute on function public.get_dashboard_metrics() to authenticated;

create or replace function public.dashboard_metrics(
  period_start timestamptz,
  period_end timestamptz,
  product_slug text default null
) returns jsonb
language sql stable security invoker set search_path = ''
as $$
with selected_products as (
  select p.id, p.slug
  from public.products p
  where product_slug is null or p.slug = product_slug
),
payments as (
  select
    coalesce(sum(pe.amount) filter (
      where pe.status in ('paid','succeeded')
        and pe.created_at >= period_start and pe.created_at < period_end
    ), 0) as amount_cents
  from public.payment_events pe
  join selected_products sp on sp.id = pe.product_id
),
wagoo_accounts as (
  select count(*) filter (where a.external_status = 'active') as total
  from public.user_product_accounts a
  join public.products p on p.id = a.product_id and p.slug = 'wagoo'
  where product_slug is null or product_slug = 'wagoo'
),
avendas_sales as (
  select count(*) as total
  from public.payment_events pe
  join public.products p on p.id = pe.product_id and p.slug = '2avendas'
  where pe.status in ('paid','succeeded')
    and pe.created_at >= period_start and pe.created_at < period_end
    and (product_slug is null or product_slug = '2avendas')
),
wagoo_daily as (
  select coalesce(
    jsonb_agg(jsonb_build_object('data', metric_day, 'receita', amount) order by metric_day),
    '[]'::jsonb
  ) as rows
  from (
    select pe.created_at::date as metric_day, round(coalesce(sum(pe.amount),0)::numeric / 100, 2) as amount
    from public.payment_events pe
    join public.products p on p.id = pe.product_id and p.slug = 'wagoo'
    where pe.status in ('paid','succeeded')
      and pe.created_at >= period_start and pe.created_at < period_end
      and (product_slug is null or product_slug = 'wagoo')
    group by pe.created_at::date
  ) d
),
avendas_daily as (
  select coalesce(
    jsonb_agg(jsonb_build_object('data', metric_day, 'volume', volume) order by metric_day),
    '[]'::jsonb
  ) as rows
  from (
    select pe.created_at::date as metric_day, count(*) as volume
    from public.payment_events pe
    join public.products p on p.id = pe.product_id and p.slug = '2avendas'
    where pe.status in ('paid','succeeded')
      and pe.created_at >= period_start and pe.created_at < period_end
      and (product_slug is null or product_slug = '2avendas')
    group by pe.created_at::date
  ) d
),
recent_events as (
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', e.event_id,
      'app', p.slug,
      'status', case when e.event_type = 'payment.failed' then 'degraded' else 'online' end,
      'message', e.event_type,
      'timestamp', e.occurred_at
    ) order by e.occurred_at desc),
    '[]'::jsonb
  ) as rows
  from (
    select *
    from public.user_activity_events
    where occurred_at >= period_start and occurred_at < period_end
    order by occurred_at desc
    limit 60
  ) e
  join public.products p on p.id = e.product_id
  where product_slug is null or p.slug = product_slug
)
select jsonb_build_object(
  'ok', true,
  'gerado_em', now(),
  'kpis', jsonb_build_object(
    'receita_total', round((select amount_cents from payments)::numeric / 100, 2),
    'assinaturas_ativas_wagoo', (select total from wagoo_accounts),
    'volume_vendas_2avendas', (select total from avendas_sales),
    'uptime_medio', 100
  ),
  'wagoo', jsonb_build_object('receita_por_dia', (select rows from wagoo_daily)),
  'dois_avendas', jsonb_build_object('volume_por_dia', (select rows from avendas_daily)),
  'eventos_recentes', (select rows from recent_events),
  'ui', '{}'::jsonb
)
$$;
revoke all on function public.dashboard_metrics(timestamptz,timestamptz,text) from public, anon;
grant execute on function public.dashboard_metrics(timestamptz,timestamptz,text) to authenticated;

insert into public.products(slug,name) values ('wagoo','Wagoo'),('2avendas','2AVendas') on conflict(slug) do update set name=excluded.name;

do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.integration_commands;
exception when duplicate_object then null; end $$;
