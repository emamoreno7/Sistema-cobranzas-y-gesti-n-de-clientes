-- Ejecutá ESTE archivo si 030 falló con "debug_errors does not exist".
-- Crea la tabla y políticas; después podés correr 030 completo o solo lo que falte.

create table if not exists public.debug_errors (
  id bigint generated always as identity primary key,
  context text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_debug_errors_created_at on public.debug_errors (created_at desc);

create or replace function public.es_usuario_root_jwt()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(auth.jwt() ->> 'email', ''))) = 'root@emd.com';
$$;

alter table public.debug_errors enable row level security;

drop policy if exists debug_errors_insert_authenticated on public.debug_errors;
create policy debug_errors_insert_authenticated
  on public.debug_errors for insert to authenticated with check (true);

drop policy if exists debug_errors_select_root on public.debug_errors;
create policy debug_errors_select_root
  on public.debug_errors for select to authenticated
  using (public.es_usuario_root_jwt());
