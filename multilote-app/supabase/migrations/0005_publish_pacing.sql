-- MultiLote: anti-baneo. Cadencia por marketplace con jitter y protección nocturna (Europe/Madrid).
--
-- Parámetros (cambiarlos = editar esta migración / una nueva):
--   · separación entre publicaciones del mismo usuario+marketplace: 2 min + 0..40 s aleatorios
--   · franja prohibida: 22:30 – 08:30 hora de Madrid
-- Las acciones `delete` NO se espacian ni se bloquean de noche: retirar rápido evita dobles ventas.

-- Reloj único del sistema. Existe para poder simular la hora en las pruebas.
create or replace function public.sync_now() returns timestamptz
language sql stable as $$ select now() $$;

create or replace function public.is_quiet_hour(p_ts timestamptz) returns boolean
language sql stable as $$
  select (p_ts at time zone 'Europe/Madrid')::time >= time '22:30'
      or (p_ts at time zone 'Europe/Madrid')::time <  time '08:30';
$$;

-- Si p_ts cae en la franja nocturna, lo empuja a las 08:30 (Madrid) que corresponda + 0..40 s.
create or replace function public.apply_quiet_hours(p_ts timestamptz) returns timestamptz
language plpgsql stable as $$
declare
  local_ts timestamp := p_ts at time zone 'Europe/Madrid';
  d date := local_ts::date;
begin
  if not public.is_quiet_hour(p_ts) then
    return p_ts;
  end if;
  if local_ts::time >= time '22:30' then
    d := d + 1; -- tras las 22:30 => mañana; antes de las 08:30 => hoy
  end if;
  return ((d + time '08:30') at time zone 'Europe/Madrid') + random() * interval '40 seconds';
end;
$$;

-- ---------------------------------------------------------------------------
-- Al encolar un publish: fija run_after según la cadencia del marketplace y la hora.
-- Siempre sobrescribe el run_after que mande el cliente.
-- ---------------------------------------------------------------------------
create or replace function public.schedule_publish_job() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t timestamptz := public.sync_now();
  latest timestamptz;
begin
  if new.action <> 'publish' then
    return new;
  end if;

  -- Serializa encolados concurrentes del mismo usuario+marketplace (si no, dos lotes simultáneos
  -- verían el mismo "último run_after" y saldrían a la vez).
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.marketplace::text, 0));

  -- Último turno ocupado: publicaciones activas (su run_after) o terminadas hace menos de 2 min.
  select max(case when status = 'done' then completed_at else run_after end)
    into latest
    from public.sync_queue
   where user_id = new.user_id
     and marketplace = new.marketplace
     and action = 'publish'
     and (status in ('pending', 'processing')
          or (status = 'done' and completed_at > t - interval '2 minutes'));

  if latest is null then
    new.run_after := t; -- nadie delante: sale ya (los 3 marketplaces a la vez)
  else
    new.run_after := greatest(t, latest + interval '2 minutes' + random() * interval '40 seconds');
  end if;

  new.run_after := public.apply_quiet_hours(new.run_after);
  return new;
end;
$$;

create trigger sync_queue_schedule_publish
  before insert on public.sync_queue
  for each row execute function public.schedule_publish_job();

-- ---------------------------------------------------------------------------
-- claim_sync_jobs: además de run_after, hace cumplir las reglas en el momento de reclamar.
-- run_after se calcula al encolar, pero si la extensión estuvo cerrada, varias tareas pueden
-- vencer a la vez o a las 4 de la mañana. Por eso, al reclamar un publish:
--   · no se reclama dentro de la franja nocturna
--   · como mucho uno por marketplace, y el más antiguo
--   · no si hay otro publish del marketplace en curso o terminado hace menos de 2 min
-- ---------------------------------------------------------------------------
create or replace function public.claim_sync_jobs(p_limit int default 3, p_worker text default null)
returns setof public.sync_queue
language plpgsql security definer set search_path = public as $$
declare
  t timestamptz := public.sync_now();
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Serializa reclamos del mismo usuario (p. ej. dos perfiles de Chrome a la vez).
  perform pg_advisory_xact_lock(hashtextextended('claim:' || auth.uid()::text, 0));

  -- Tareas colgadas (>10 min en processing): reintentar o dar por falladas.
  update public.sync_queue
     set status = case when attempts >= max_attempts then 'failed'::sync_job_status else 'pending'::sync_job_status end,
         last_error = case when attempts >= max_attempts then 'Tiempo de espera agotado' else last_error end,
         locked_at = null,
         locked_by = null
   where user_id = auth.uid()
     and status = 'processing'
     and locked_at < t - interval '10 minutes';

  return query
  update public.sync_queue q
     set status = 'processing',
         locked_at = t,
         locked_by = p_worker,
         attempts = q.attempts + 1
   where q.id in (
     select s.id from public.sync_queue s
      where s.user_id = auth.uid()
        and s.status = 'pending'
        and s.run_after <= t
        and (
          s.action <> 'publish'
          or (
            not public.is_quiet_hour(t)
            and not exists (
              select 1 from public.sync_queue x
               where x.user_id = s.user_id and x.marketplace = s.marketplace
                 and x.action = 'publish' and x.id <> s.id
                 and (x.status = 'processing'
                      or (x.status = 'done' and x.completed_at > t - interval '2 minutes')))
            and not exists (
              select 1 from public.sync_queue y
               where y.user_id = s.user_id and y.marketplace = s.marketplace
                 and y.action = 'publish' and y.status = 'pending' and y.run_after <= t
                 and (y.run_after, y.created_at, y.id) < (s.run_after, s.created_at, s.id))
          )
        )
      order by s.created_at
      limit greatest(1, least(coalesce(p_limit, 3), 10))
      for update skip locked
   )
  returning q.*;
end;
$$;

revoke all on function public.claim_sync_jobs(int, text) from public, anon;
grant execute on function public.claim_sync_jobs(int, text) to authenticated;
