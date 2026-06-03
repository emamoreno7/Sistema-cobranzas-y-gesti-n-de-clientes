-- Tablas gastos y cuotas (si no corrió 012 o schema base incompleto).

create table if not exists public.gastos (
  id text primary key,
  fecha date not null default current_date,
  categoria text not null default 'Otros',
  monto numeric not null default 0,
  nota text,
  cobrador_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_gastos_fecha on public.gastos (fecha);
create index if not exists idx_gastos_cobrador on public.gastos (cobrador_id);

alter table public.gastos enable row level security;

drop policy if exists gastos_select_auth on public.gastos;
create policy gastos_select_auth
  on public.gastos for select to authenticated using (true);

drop policy if exists gastos_insert_auth on public.gastos;
create policy gastos_insert_auth
  on public.gastos for insert to authenticated with check (true);

drop policy if exists gastos_update_auth on public.gastos;
create policy gastos_update_auth
  on public.gastos for update to authenticated using (true) with check (true);

drop policy if exists gastos_delete_auth on public.gastos;
create policy gastos_delete_auth
  on public.gastos for delete to authenticated using (true);

-- Cuotas (sin FK estricta para no fallar si clientes/créditos tienen tipos mixtos)
create table if not exists public.cuotas (
  id uuid primary key default gen_random_uuid(),
  credito_id uuid not null,
  cliente_id uuid not null,
  nro_cuota integer not null check (nro_cuota > 0),
  fecha_vencimiento date not null,
  monto integer not null check (monto >= 0),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado')),
  pago_id uuid,
  pagado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cuotas_credito_nro_unique unique (credito_id, nro_cuota)
);

create index if not exists idx_cuotas_credito_estado_vto on public.cuotas (credito_id, estado, fecha_vencimiento);

alter table public.cuotas enable row level security;

drop policy if exists cuotas_select_auth on public.cuotas;
create policy cuotas_select_auth
  on public.cuotas for select to authenticated using (true);

drop policy if exists cuotas_insert_auth on public.cuotas;
create policy cuotas_insert_auth
  on public.cuotas for insert to authenticated with check (true);

drop policy if exists cuotas_update_auth on public.cuotas;
create policy cuotas_update_auth
  on public.cuotas for update to authenticated using (true) with check (true);

drop policy if exists cuotas_delete_auth on public.cuotas;
create policy cuotas_delete_auth
  on public.cuotas for delete to authenticated using (true);
