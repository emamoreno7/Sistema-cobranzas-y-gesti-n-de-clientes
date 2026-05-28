-- Errores críticos desde la app (p. ej. fallo al crear crédito) para diagnóstico.
create table if not exists public.debug_errors (
  id bigint generated always as identity primary key,
  context text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_debug_errors_created_at on public.debug_errors (created_at desc);

comment on table public.debug_errors is 'Logs enviados por la app en fallos críticos (payload JSON del intento).';

alter table public.debug_errors enable row level security;

drop policy if exists "debug_errors_insert_authenticated" on public.debug_errors;
create policy "debug_errors_insert_authenticated"
  on public.debug_errors
  for insert
  to authenticated
  with check (true);
