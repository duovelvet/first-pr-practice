-- MultiLote: retirar anuncios (vendido / archivado) mediante tareas `delete` en sync_queue.

-- Marca el artículo como vendido o archivado y encola la retirada en cada marketplace
-- donde esté publicado. SECURITY DEFINER a propósito: retirar un anuncio debe funcionar
-- aunque el plan haya caducado (evita dobles ventas), a diferencia de publicar.
create or replace function public.retire_listing(p_listing_id uuid, p_status listing_status default 'sold')
returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_status not in ('sold', 'archived') then
    raise exception 'invalid status: %', p_status;
  end if;

  update public.listings set status = p_status
   where id = p_listing_id and user_id = auth.uid();
  if not found then
    raise exception 'listing not found';
  end if;

  -- Las publicaciones aún sin empezar dejan de tener sentido.
  update public.sync_queue
     set status = 'failed', completed_at = now(), last_error = 'Cancelada: artículo retirado'
   where listing_id = p_listing_id and user_id = auth.uid()
     and status = 'pending' and action <> 'delete';

  insert into public.sync_queue (user_id, listing_id, marketplace, action)
  select auth.uid(), p.listing_id, p.marketplace, 'delete'
    from public.publications p
   where p.listing_id = p_listing_id and p.user_id = auth.uid() and p.status = 'published'
  on conflict (listing_id, marketplace, action) where status in ('pending', 'processing') do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.retire_listing(uuid, listing_status) from public, anon;
grant execute on function public.retire_listing(uuid, listing_status) to authenticated;

-- Si una publicación terminó DESPUÉS de retirar el artículo (tarea en curso en ese momento),
-- se encola automáticamente su retirada. Resto de la función igual que en 0002.
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
  l_status listing_status;
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

      select status into l_status from public.listings where id = j.listing_id;
      if l_status in ('sold', 'archived') then
        insert into public.sync_queue (user_id, listing_id, marketplace, action)
        values (j.user_id, j.listing_id, j.marketplace, 'delete')
        on conflict (listing_id, marketplace, action) where status in ('pending', 'processing') do nothing;
      end if;
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

-- Retirar anuncios nunca se bloquea por plan caducado (evita dobles ventas):
-- solo publicar/actualizar exige plan activo o prueba.
drop policy "sync_queue_insert_own" on public.sync_queue;
create policy "sync_queue_insert_own" on public.sync_queue
  for insert with check (
    user_id = auth.uid()
    and (action = 'delete' or public.has_active_plan())
    and exists (select 1 from public.listings l where l.id = listing_id and l.user_id = auth.uid())
  );
