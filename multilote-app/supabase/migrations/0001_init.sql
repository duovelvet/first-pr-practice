-- MultiLote: esquema inicial

create type listing_status as enum ('draft', 'active', 'sold', 'archived');
create type marketplace as enum ('wallapop', 'vinted', 'milanuncios');
create type publication_status as enum ('pending', 'published', 'sold', 'removed', 'error');

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title text not null check (char_length(title) between 3 and 120),
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  category text,
  brand text,
  size text,
  condition text,
  photos text[] not null default '{}', -- rutas en el bucket listing-photos
  status listing_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  marketplace marketplace not null,
  external_url text,
  status publication_status not null default 'pending',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (listing_id, marketplace)
);

create index listings_user_idx on public.listings (user_id, created_at desc);
create index publications_listing_idx on public.publications (listing_id);

create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger listings_touch before update on public.listings
  for each row execute function public.touch_updated_at();

-- RLS: cada usuario solo ve y modifica lo suyo
alter table public.listings enable row level security;
alter table public.publications enable row level security;

create policy "listings_own" on public.listings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "publications_own" on public.publications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Storage: bucket privado, carpeta por usuario (<user_id>/<archivo>)
insert into storage.buckets (id, name, public)
values ('listing-photos', 'listing-photos', false)
on conflict (id) do nothing;

create policy "photos_select_own" on storage.objects
  for select using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos_insert_own" on storage.objects
  for insert with check (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos_delete_own" on storage.objects
  for delete using (bucket_id = 'listing-photos' and (storage.foldername(name))[1] = auth.uid()::text);
