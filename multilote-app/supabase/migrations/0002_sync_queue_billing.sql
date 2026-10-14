-- MultiLote: cola de sincronización (sync_queue), RPC para la extensión y suscripciones.

create type sync_action as enum ('publish', 'update', 'delete');
create type sync_job_status as enum ('pending', 'processing', 'done', 'failed');
create type plan_type as enum ('monthly', 'founder');

-- ---------------------------------------------------------------------------
-- Suscripciones (17,90 €/mes) y pago único de fundador (69 €).
-- Solo las escribe el webhook de Stripe con la service role.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan plan_type not null,
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text unique,
  current_period_end timestamptz, -- null = sin caducidad (fundador)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
create policy "subscriptions_select_own" on public.subscriptions
  for select using (user_id = auth.uid());

create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- Plan activo, o cuenta dentro del periodo de prueba (7 días desde el registro).
create or replace function public.has_active_plan(p_user uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = p_user
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  ) or exists (
    select 1 from auth.users u
    where u.id = p_user and u.created_at > now() - interval '7 days'
  );
$$;

-- ---------------------------------------------------------------------------
-- Cola de tareas
-- ---------------------------------------------------------------------------
create table public.sync_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  marketplace marketplace not null,
  action sync_action not null default 'publish',
  status sync_job_status not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  external_url text,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Una sola tarea activa por artículo + marketplace + acción (evita duplicados).
create unique index sync_queue_active_uniq
  on public.sync_queue (listing_id, marketplace, action)
  where status in ('pending', 'processing');

create index sync_queue_claim_idx on public.sync_queue (user_id, status, run_after);
create index sync_queue_listing_idx on public.sync_queue (listing_id, created_at desc);

alter table public.sync_queue enable row level security;

create policy "sync_queue_select_own" on public.sync_queue
  for select using (user_id = auth.uid());

-- Encolar requiere plan activo o prueba, y que el artículo sea del usuario.
-- No hay políticas de update/delete: el estado solo cambia vía RPC.
create policy "sync_queue_insert_own" on public.sync_queue
  for insert with check (
    user_id = auth.uid()
    and public.has_active_plan()
    and exists (select 1 from public.listings l where l.id = listing_id and l.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- RPC: la extensión reclama tareas pendientes (SKIP LOCKED => sin dobles reclamos)
-- ---------------------------------------------------------------------------
create or replace function public.claim_sync_jobs(p_limit int default 3, p_worker text default null)
returns setof public.sync_queue
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Tareas colgadas (>10 min en processing): reintentar o dar por falladas.
  update public.sync_queue
     set status = case when attempts >= max_attempts then 'failed'::sync_job_status else 'pending'::sync_job_status end,
         last_error = case when attempts >= max_attempts then 'Tiempo de espera agotado' else last_error end,
         locked_at = null,
         locked_by = null
   where user_id = auth.uid()
     and status = 'processing'
     and locked_at < now() - interval '10 minutes';

  return query
  update public.sync_queue q
     set status = 'processing',
         locked_at = now(),
         locked_by = p_worker,
         attempts = q.attempts + 1
   where q.id in (
     select id from public.sync_queue
      where user_id = auth.uid()
        and status = 'pending'
        and run_after <= now()
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 3), 10))
      for update skip locked
   )
  returning q.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: la extensión informa del resultado. Éxito => actualiza publications.
-- Fallo => reintento con backoff exponencial hasta max_attempts.
-- ---------------------------------------------------------------------------
create or replace function public.complete_sync_job(
  p_job_id uuid,
  p_success boolean,
  p_external_url text default null,
  p_error text default null
)
returns public.sync_queue
language plpgsql security definer set search_path = public as $$
declare
  j public.sync_queue;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into j
    from public.sync_queue
   where id = p_job_id and user_id = auth.uid() and status = 'processing'
   for update;
  if not found then
    raise exception 'job not found or not processing';
  end if;

  if p_success then
    update public.sync_queue
       set status = 'done', completed_at = now(), external_url = p_external_url,
           last_error = null, locked_at = null, locked_by = null
     where id = j.id
    returning * into j;

    if j.action = 'delete' then
      update public.publications
         set status = 'removed'
       where listing_id = j.listing_id and marketplace = j.marketplace;
    else
      insert into public.publications (listing_id, user_id, marketplace, external_url, status, published_at)
      values (j.listing_id, j.user_id, j.marketplace, p_external_url, 'published', now())
      on conflict (listing_id, marketplace) do update
        set status = 'published',
            external_url = coalesce(excluded.external_url, public.publications.external_url),
            published_at = now();
    end if;

  elsif j.attempts >= j.max_attempts then
    update public.sync_queue
       set status = 'failed', completed_at = now(), last_error = p_error,
           locked_at = null, locked_by = null
     where id = j.id
    returning * into j;

    if j.action = 'publish' then
      insert into public.publications (listing_id, user_id, marketplace, status)
      values (j.listing_id, j.user_id, j.marketplace, 'error')
      on conflict (listing_id, marketplace) do update set status = 'error';
    end if;

  else
    update public.sync_queue
       set status = 'pending', last_error = p_error,
           run_after = now() + make_interval(mins => power(2, j.attempts)::int),
           locked_at = null, locked_by = null
     where id = j.id
    returning * into j;
  end if;

  return j;
end;
$$;

revoke all on function public.claim_sync_jobs(int, text) from public, anon;
revoke all on function public.complete_sync_job(uuid, boolean, text, text) from public, anon;
revoke all on function public.has_active_plan(uuid) from public, anon;
grant execute on function public.claim_sync_jobs(int, text) to authenticated;
grant execute on function public.complete_sync_job(uuid, boolean, text, text) to authenticated;
grant execute on function public.has_active_plan(uuid) to authenticated;
