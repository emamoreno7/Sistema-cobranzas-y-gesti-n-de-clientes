-- Comisiones acumulativas por ventas de crédito (vendedores). Liquidación semanal (corte sábado).

alter table public.configuracion
  add column if not exists porcentaje_comision_vendedor numeric default 5;

alter table public.usuarios
  add column if not exists comision_acumulada numeric not null default 0;

alter table public.creditos
  add column if not exists vendedor_id text,
  add column if not exists comision_vendedor numeric not null default 0,
  add column if not exists comision_liquidada boolean not null default false;

create index if not exists idx_creditos_vendedor_comision
  on public.creditos (vendedor_id, comision_liquidada)
  where vendedor_id is not null and comision_vendedor > 0;

create table if not exists public.liquidaciones_comision_vendedor (
  id uuid primary key default gen_random_uuid(),
  vendedor_id text not null,
  vendedor_username text,
  semana_corte date not null,
  monto_total numeric not null default 0,
  cantidad_creditos integer not null default 0,
  pagado_por text not null,
  notas text,
  created_at timestamptz not null default now()
);

create index if not exists idx_liq_comision_vendedor on public.liquidaciones_comision_vendedor (vendedor_id, created_at desc);

-- Vendedor demo (Auth: cobrador2@emd.com). Ajustá password en Supabase Auth aparte.
insert into public.usuarios (username, password, rol, activo, comision_acumulada)
values ('cobrador2', '—', 'vendedor', true, 0)
on conflict (username) do update set rol = 'vendedor', activo = true;
