-- Columnas que usa Ajustes (intereses M/P, empresa, mora, WhatsApp admin, comisión vendedor).
-- Ejecutar en Supabase SQL Editor si la app reporta: column 'interes_credito_m' not found.

create table if not exists public.configuracion (
  id text primary key,
  porcentaje_interes numeric,
  interes_credito_m numeric,
  interes_credito_p numeric,
  porcentaje_comision_vendedor numeric default 5,
  nombre_empresa text,
  telefono_empresa text,
  direccion_empresa text,
  ruc text,
  moneda text,
  simbolo_moneda text,
  mora_porciento numeric,
  numero_whatsapp_admin text,
  modo_exterior boolean default false,
  updated_at timestamptz not null default now()
);

alter table public.configuracion
  add column if not exists porcentaje_interes numeric,
  add column if not exists interes_credito_m numeric,
  add column if not exists interes_credito_p numeric,
  add column if not exists porcentaje_comision_vendedor numeric default 5,
  add column if not exists nombre_empresa text,
  add column if not exists telefono_empresa text,
  add column if not exists direccion_empresa text,
  add column if not exists ruc text,
  add column if not exists moneda text,
  add column if not exists simbolo_moneda text,
  add column if not exists mora_porciento numeric,
  add column if not exists numero_whatsapp_admin text,
  add column if not exists modo_exterior boolean default false,
  add column if not exists updated_at timestamptz default now();

alter table public.configuracion
  alter column updated_at set default now();

insert into public.configuracion (
  id,
  porcentaje_interes,
  interes_credito_m,
  interes_credito_p,
  porcentaje_comision_vendedor,
  nombre_empresa,
  moneda,
  simbolo_moneda,
  mora_porciento,
  modo_exterior
)
values (
  'global_config',
  20,
  30,
  20,
  5,
  'DotCom Gestión',
  'ARS',
  '$',
  2,
  false
)
on conflict (id) do nothing;

alter table public.configuracion enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'configuracion' and policyname = 'configuracion_select_authenticated'
  ) then
    create policy configuracion_select_authenticated
      on public.configuracion for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'configuracion' and policyname = 'configuracion_insert_authenticated'
  ) then
    create policy configuracion_insert_authenticated
      on public.configuracion for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'configuracion' and policyname = 'configuracion_update_authenticated'
  ) then
    create policy configuracion_update_authenticated
      on public.configuracion for update
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;
