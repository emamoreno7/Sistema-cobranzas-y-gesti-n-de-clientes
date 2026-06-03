-- Consola técnica Root: sesiones con IP, tickets, lectura de logs/errores.
-- IMPORTANTE: ejecutar TODO el archivo (no solo la parte de políticas).

-- 1) Tablas (todas primero)
create table if not exists public.debug_errors (
  id bigint generated always as identity primary key,
  context text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_debug_errors_created_at on public.debug_errors (created_at desc);

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

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor text,
  accion text not null,
  detalle text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);

create table if not exists public.eventos_sesion (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  username text,
  email text,
  accion text not null,
  ip text,
  user_agent text,
  detalle text,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists idx_eventos_sesion_created_at on public.eventos_sesion (created_at desc);
create index if not exists idx_eventos_sesion_accion on public.eventos_sesion (accion);

create table if not exists public.tickets_soporte (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  titulo text not null,
  descripcion text,
  prioridad text not null default 'media'
    check (prioridad in ('baja', 'media', 'alta', 'critica')),
  estado text not null default 'abierto'
    check (estado in ('abierto', 'en_progreso', 'resuelto', 'cerrado')),
  reportado_por text,
  origen text default 'root_console',
  meta jsonb not null default '{}'::jsonb
);
create index if not exists idx_tickets_soporte_estado on public.tickets_soporte (estado, created_at desc);

-- 2) Función helper Root
create or replace function public.es_usuario_root_jwt()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(auth.jwt() ->> 'email', ''))) = 'root@emd.com';
$$;

-- 3) RLS
alter table public.debug_errors enable row level security;
alter table public.logs_auditoria enable row level security;
alter table public.audit_logs enable row level security;
alter table public.eventos_sesion enable row level security;
alter table public.tickets_soporte enable row level security;

-- 4) Políticas debug_errors / logs / audit
drop policy if exists debug_errors_insert_authenticated on public.debug_errors;
create policy debug_errors_insert_authenticated
  on public.debug_errors for insert to authenticated with check (true);

drop policy if exists debug_errors_select_root on public.debug_errors;
create policy debug_errors_select_root
  on public.debug_errors for select to authenticated
  using (public.es_usuario_root_jwt());

drop policy if exists logs_auditoria_insert_authenticated on public.logs_auditoria;
create policy logs_auditoria_insert_authenticated
  on public.logs_auditoria for insert to authenticated with check (true);

drop policy if exists logs_auditoria_select_root on public.logs_auditoria;
create policy logs_auditoria_select_root
  on public.logs_auditoria for select to authenticated
  using (public.es_usuario_root_jwt());

drop policy if exists audit_logs_insert_auth on public.audit_logs;
create policy audit_logs_insert_auth
  on public.audit_logs for insert to authenticated with check (true);

drop policy if exists audit_logs_select_root on public.audit_logs;
create policy audit_logs_select_root
  on public.audit_logs for select to authenticated
  using (public.es_usuario_root_jwt());

-- 5) Políticas consola Root
drop policy if exists eventos_sesion_insert_auth on public.eventos_sesion;
create policy eventos_sesion_insert_auth
  on public.eventos_sesion for insert to authenticated with check (true);

drop policy if exists eventos_sesion_select_root on public.eventos_sesion;
create policy eventos_sesion_select_root
  on public.eventos_sesion for select to authenticated
  using (public.es_usuario_root_jwt());

drop policy if exists tickets_soporte_root_all on public.tickets_soporte;
create policy tickets_soporte_root_all
  on public.tickets_soporte for all to authenticated
  using (public.es_usuario_root_jwt())
  with check (public.es_usuario_root_jwt());
