create table if not exists public.usuarios (
  id uuid primary key default gen_random_uuid(),
  username text unique not null,
  password text not null,
  rol text not null check (rol in ('super', 'admin', 'cobrador', 'vendedor', 'proveedor', 'root')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.clientes (
  id text primary key,
  nombre text not null,
  telefono text not null,
  direccion text not null default '',
  lat double precision,
  lng double precision,
  coordenadaErr text,
  saldo numeric not null default 0,
  quota numeric not null default 0,
  frecuencia text not null default 'semanal',
  fechaAlta text not null,
  activo boolean not null default true,
  ultimaVisita text,
  notas text,
  promesaPago text,
  promesaFecha text,
  ultimoMontoRecibido numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.pagos (
  id text primary key,
  clienteId text not null,
  fichaId text not null,
  fecha text not null,
  monto numeric not null default 0,
  dia integer not null default 0,
  tipo text not null,
  observaciones text,
  lat double precision,
  lng double precision,
  userId text,
  created_at timestamptz not null default now()
);

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

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor text,
  accion text not null,
  detalle text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);

create table if not exists public.creditos (
  id uuid primary key default gen_random_uuid(),
  cliente_id text not null,
  usuario_id uuid,
  creado_por text,
  tipo text not null check (tipo in ('M', 'P')),
  monto_solicitado numeric not null default 0,
  detalle_mercaderia text,
  fecha_inicio date not null default current_date,
  plazo_unidad text not null check (plazo_unidad in ('Días', 'Semanas', 'Meses')),
  plazo_cantidad integer not null default 1,
  total_con_interes numeric not null default 0,
  estado text not null default 'PENDIENTE' check (estado in ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'ACTIVO', 'VIGENTE', 'FINALIZADO', 'pendiente_aprobacion')),
  interes_aplicado numeric not null default 20,
  created_at timestamptz not null default now()
);

create index if not exists idx_creditos_cliente on public.creditos (cliente_id);
create index if not exists idx_creditos_estado on public.creditos (estado);

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  mensaje text not null,
  destinatario_rol text,
  destinatario_usuario text,
  leido boolean not null default false,
  accion text,
  created_at timestamptz not null default now()
);

create index if not exists idx_notificaciones_destinatario_rol on public.notificaciones (destinatario_rol);
create index if not exists idx_notificaciones_destinatario_usuario on public.notificaciones (destinatario_usuario);

create table if not exists public.fichas (
  id text primary key,
  cliente_id text not null,
  tipo text not null default 'venta',
  monto_total numeric not null,
  precio_venta numeric not null,
  costo numeric,
  ganancia numeric,
  saldo numeric,
  cuotas integer default 1,
  cuotas_pagas integer default 0,
  cuota_monto numeric,
  total_pagado numeric default 0,
  producto text,
  fecha_inicio text,
  fecha text not null,
  estado text not null default 'activa',
  plan_pago text default 'Mensual',
  mora numeric default 0,
  mora_porciento numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_fichas_cliente on public.fichas (cliente_id);
create index if not exists idx_fichas_estado on public.fichas (estado);

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

insert into storage.buckets (id, name, public)
values ('clientes-documentos', 'clientes-documentos', true)
on conflict (id) do update set public = true;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_documentos_select_public'
  ) then
    create policy clientes_documentos_select_public
    on storage.objects for select
    using (bucket_id = 'clientes-documentos');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_documentos_insert_authenticated'
  ) then
    create policy clientes_documentos_insert_authenticated
    on storage.objects for insert
    with check (bucket_id = 'clientes-documentos' and auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_documentos_update_authenticated'
  ) then
    create policy clientes_documentos_update_authenticated
    on storage.objects for update
    using (bucket_id = 'clientes-documentos' and auth.role() = 'authenticated')
    with check (bucket_id = 'clientes-documentos' and auth.role() = 'authenticated');
  end if;
end $$;

