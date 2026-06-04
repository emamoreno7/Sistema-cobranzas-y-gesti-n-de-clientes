-- Caja propia de Marcos: ingresos y egresos propios (capital, retiros, habilitación de créditos). Sin proveedor ni comisiones.

create table if not exists public.caja_propia_movimientos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  fecha date not null default current_date,
  tipo text not null check (tipo in ('entrada', 'salida')),
  monto integer not null check (monto > 0),
  descripcion text not null,
  nota text,
  registrado_por text,
  solicitud_fondo_id uuid references public.solicitudes_fondo_credito(id) on delete set null,
  caja_referencia_id uuid references public.caja(id) on delete set null
);

create index if not exists idx_caja_propia_fecha on public.caja_propia_movimientos (fecha desc, created_at desc);
create index if not exists idx_caja_propia_tipo on public.caja_propia_movimientos (tipo, created_at desc);

alter table public.caja_propia_movimientos enable row level security;

drop policy if exists caja_propia_select_auth on public.caja_propia_movimientos;
create policy caja_propia_select_auth
  on public.caja_propia_movimientos for select to authenticated using (true);

drop policy if exists caja_propia_insert_auth on public.caja_propia_movimientos;
create policy caja_propia_insert_auth
  on public.caja_propia_movimientos for insert to authenticated with check (true);

drop policy if exists caja_propia_update_auth on public.caja_propia_movimientos;
create policy caja_propia_update_auth
  on public.caja_propia_movimientos for update to authenticated using (true) with check (true);
