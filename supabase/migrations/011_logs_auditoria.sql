-- Auditoría de fallos al guardar cobros y créditos (payload del intento en JSON).
create table if not exists public.logs_auditoria (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('cobro', 'credito')),
  contexto text not null,
  mensaje_error text,
  datos_enviados jsonb not null default '{}'::jsonb,
  actor text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists idx_logs_auditoria_created_at on public.logs_auditoria (created_at desc);
create index if not exists idx_logs_auditoria_tipo on public.logs_auditoria (tipo);

comment on table public.logs_auditoria is 'Fallos al persistir cobros/créditos; datos_enviados conserva el payload enviado o reconstruido.';
comment on column public.logs_auditoria.meta is 'Detalle extra serializable (p. ej. código Supabase, stack acotado).';

alter table public.logs_auditoria enable row level security;

drop policy if exists "logs_auditoria_insert_authenticated" on public.logs_auditoria;
create policy "logs_auditoria_insert_authenticated"
  on public.logs_auditoria
  for insert
  to authenticated
  with check (true);

drop policy if exists "logs_auditoria_select_marcosp_global" on public.logs_auditoria;
create policy "logs_auditoria_select_marcosp_global"
  on public.logs_auditoria
  for select
  to authenticated
  using (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'emamoreno7@hotmail.com'
  );
