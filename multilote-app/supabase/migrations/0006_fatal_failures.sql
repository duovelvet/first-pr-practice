-- MultiLote: fallos definitivos (sin reintento) para resultados ambiguos.
--
-- Si la extensión ya envió la petición de crear un anuncio y no puede confirmar el resultado
-- (error 5xx, corte de red, respuesta ilegible, pestaña cerrada tras pulsar «publicar»…), un reintento
-- automático podría publicar el anuncio DOS veces. En ese caso la extensión marca p_fatal = true:
-- la tarea pasa directamente a `failed` y la publicación a `error`, para que lo revise una persona.
--
-- Cambia la firma (añade un parámetro con valor por defecto): hay que eliminar la anterior para que
-- las llamadas con 4 argumentos no sean ambiguas. El resto del cuerpo es el de 0003.

drop function if exists public.complete_sync_job(uuid, boolean, text, text);

create or replace function public.complete_sync_job(
  p_job_id uuid,
  p_success boolean,
  p_external_url text default null,
  p_error text default null,
  p_fatal boolean default false
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

  elsif p_fatal or j.attempts >= j.max_attempts then
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

revoke all on function public.complete_sync_job(uuid, boolean, text, text, boolean) from public, anon;
grant execute on function public.complete_sync_job(uuid, boolean, text, text, boolean) to authenticated;
