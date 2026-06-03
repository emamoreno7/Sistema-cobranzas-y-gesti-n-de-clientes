-- Cheques: foto + datos obligatorios; aprobación solo Marcos; retención 7/90 días.

create table if not exists public.cheques (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  solicitante text not null,
  fecha_vencimiento date not null,
  importe numeric(14, 2) not null check (importe > 0),
  numero_cheque text not null,
  foto_url text,
  foto_path text,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'aceptado', 'rechazado')),
  creado_por text,
  revisado_por text,
  revisado_at timestamptz,
  eliminar_en timestamptz,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists idx_cheques_estado on public.cheques (estado, created_at desc);
create index if not exists idx_cheques_numero on public.cheques (numero_cheque);
create index if not exists idx_cheques_solicitante on public.cheques (solicitante);
create index if not exists idx_cheques_eliminar_en on public.cheques (eliminar_en) where eliminar_en is not null;

create or replace function public.es_usuario_marcos_jwt()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(auth.jwt() ->> 'email', ''))) = 'emamoreno7@hotmail.com';
$$;

create or replace function public.limpiar_cheques_expirados()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.cheques
  where eliminar_en is not null and eliminar_en < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.limpiar_cheques_expirados() to authenticated;

alter table public.cheques enable row level security;

drop policy if exists cheques_select_auth on public.cheques;
create policy cheques_select_auth
  on public.cheques for select to authenticated using (true);

drop policy if exists cheques_insert_auth on public.cheques;
create policy cheques_insert_auth
  on public.cheques for insert to authenticated
  with check (
    btrim(solicitante) <> ''
    and fecha_vencimiento is not null
    and importe > 0
    and btrim(numero_cheque) <> ''
    and estado = 'pendiente'
  );

drop policy if exists cheques_update_marcos on public.cheques;
create policy cheques_update_marcos
  on public.cheques for update to authenticated
  using (public.es_usuario_marcos_jwt())
  with check (public.es_usuario_marcos_jwt());

drop policy if exists cheques_delete_marcos on public.cheques;
create policy cheques_delete_marcos
  on public.cheques for delete to authenticated
  using (public.es_usuario_marcos_jwt());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'cheques-fotos',
  'cheques-fotos',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'cheques_fotos_select_public'
  ) then
    create policy cheques_fotos_select_public
      on storage.objects for select
      using (bucket_id = 'cheques-fotos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'cheques_fotos_insert_auth'
  ) then
    create policy cheques_fotos_insert_auth
      on storage.objects for insert
      with check (bucket_id = 'cheques-fotos' and auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'cheques_fotos_update_auth'
  ) then
    create policy cheques_fotos_update_auth
      on storage.objects for update
      using (bucket_id = 'cheques-fotos' and auth.role() = 'authenticated')
      with check (bucket_id = 'cheques-fotos' and auth.role() = 'authenticated');
  end if;
end $$;
