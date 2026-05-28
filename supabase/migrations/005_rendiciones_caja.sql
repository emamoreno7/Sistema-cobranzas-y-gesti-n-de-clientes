-- Rendiciones / cierre de jornada por cobrador (00:00–00:00 fecha local en cliente; fecha_jornada = día calendario).
-- Montos en pesos enteros (consistente con la app).

create table if not exists public.rendiciones (
  id uuid primary key default gen_random_uuid(),
  fecha_jornada date not null,
  cobrador_id text not null,
  cobrador_nombre text,
  total_cobrado integer not null default 0,
  total_gastos integer not null default 0,
  neto_entregar integer not null default 0,
  monto_fisico_declarado integer,
  diferencia integer,
  km_fin numeric,
  novedades text,
  validado boolean not null default false,
  validado_at timestamptz,
  validado_por text,
  ingreso_caja_central integer not null default 0,
  gps_lat double precision,
  gps_lng double precision,
  created_at timestamptz not null default now(),
  constraint rendiciones_cobrador_fecha_unique unique (cobrador_id, fecha_jornada)
);

create index if not exists idx_rendiciones_validado on public.rendiciones (validado);
create index if not exists idx_rendiciones_fecha on public.rendiciones (fecha_jornada desc);

alter table public.rendiciones enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'rendiciones' and policyname = 'rendiciones_select_authenticated'
  ) then
    create policy rendiciones_select_authenticated
      on public.rendiciones for select
      using (auth.role() = 'authenticated');
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'rendiciones' and policyname = 'rendiciones_insert_authenticated'
  ) then
    create policy rendiciones_insert_authenticated
      on public.rendiciones for insert
      with check (auth.role() = 'authenticated');
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'rendiciones' and policyname = 'rendiciones_update_authenticated'
  ) then
    create policy rendiciones_update_authenticated
      on public.rendiciones for update
      using (auth.role() = 'authenticated');
  end if;
end $$;
