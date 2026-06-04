-- Solicitud de ingreso en caja (Marcos) cuando el cobrador/vendedor crea crédito sin recaudado previo.

create table if not exists public.solicitudes_fondo_credito (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  credito_id uuid not null references public.creditos(id) on delete cascade,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  cobrador_id text not null,
  solicitante_email text,
  solicitante_nombre text,
  monto integer not null check (monto > 0),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'fondado', 'cancelado')),
  fondado_at timestamptz,
  constraint solicitudes_fondo_credito_credito_unique unique (credito_id)
);

create index if not exists idx_solicitudes_fondo_estado on public.solicitudes_fondo_credito (estado, created_at desc);
create index if not exists idx_solicitudes_fondo_cobrador on public.solicitudes_fondo_credito (cobrador_id, estado);

alter table public.solicitudes_fondo_credito enable row level security;

drop policy if exists solicitudes_fondo_select_auth on public.solicitudes_fondo_credito;
create policy solicitudes_fondo_select_auth
  on public.solicitudes_fondo_credito for select to authenticated using (true);

drop policy if exists solicitudes_fondo_insert_auth on public.solicitudes_fondo_credito;
create policy solicitudes_fondo_insert_auth
  on public.solicitudes_fondo_credito for insert to authenticated with check (true);

drop policy if exists solicitudes_fondo_update_auth on public.solicitudes_fondo_credito;
create policy solicitudes_fondo_update_auth
  on public.solicitudes_fondo_credito for update to authenticated using (true) with check (true);
