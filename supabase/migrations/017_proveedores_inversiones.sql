-- Proveedores / inversores externos: ingreso en caja, 7% a 32 días, rol proveedor.

alter table public.usuarios drop constraint if exists usuarios_rol_check;
alter table public.usuarios add constraint usuarios_rol_check
  check (rol in ('super', 'admin', 'cobrador', 'vendedor', 'proveedor', 'root'));

create table if not exists public.proveedores (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  login text not null unique,
  auth_email text not null unique,
  auth_user_id uuid,
  telefono text,
  activo boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists idx_proveedores_login on public.proveedores (login);
create index if not exists idx_proveedores_auth_email on public.proveedores (auth_email);

create table if not exists public.inversiones_proveedor (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid not null references public.proveedores(id) on delete restrict,
  monto integer not null check (monto > 0),
  fecha_ingreso date not null default current_date,
  tasa_interes numeric not null default 7,
  plazo_dias integer not null default 32,
  monto_interes integer not null check (monto_interes >= 0),
  monto_total_devolver integer not null check (monto_total_devolver >= monto),
  fecha_vencimiento date not null,
  estado text not null default 'activa' check (estado in ('activa', 'liquidada')),
  registrado_por text,
  nota text,
  created_at timestamptz not null default now()
);

create index if not exists idx_inversiones_proveedor on public.inversiones_proveedor (proveedor_id, estado, fecha_ingreso desc);

-- Tabla caja (por si la migración 012 no se ejecutó aún en este proyecto).
create table if not exists public.caja (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('entrada', 'salida')),
  monto integer not null check (monto >= 0),
  descripcion text,
  cobrador_id text not null,
  cliente_id uuid,
  ficha_id uuid,
  pago_id uuid
);

create index if not exists idx_caja_created_at on public.caja (created_at desc);
create index if not exists idx_caja_cobrador_created_at on public.caja (cobrador_id, created_at desc);

alter table public.caja add column if not exists proveedor_id uuid references public.proveedores(id) on delete set null;
alter table public.caja add column if not exists inversion_id uuid references public.inversiones_proveedor(id) on delete set null;

alter table public.caja enable row level security;

drop policy if exists "caja_select_authenticated" on public.caja;
create policy "caja_select_authenticated"
  on public.caja for select to authenticated using (true);

drop policy if exists "caja_insert_authenticated" on public.caja;
create policy "caja_insert_authenticated"
  on public.caja for insert to authenticated with check (true);

-- Helpers RLS
create or replace function public.es_admin_sesion()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') in ('emamoreno7@hotmail.com', 'root@emd.com')
    or lower(coalesce(auth.jwt() ->> 'email', '')) like '%admin%',
    false
  );
$$;

create or replace function public.proveedor_id_sesion()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.proveedores p
  where lower(p.auth_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and p.activo = true
  limit 1;
$$;

alter table public.proveedores enable row level security;
alter table public.inversiones_proveedor enable row level security;

drop policy if exists "proveedores_select" on public.proveedores;
create policy "proveedores_select"
  on public.proveedores for select to authenticated
  using (public.es_admin_sesion() or id = public.proveedor_id_sesion());

drop policy if exists "proveedores_insert" on public.proveedores;
create policy "proveedores_insert"
  on public.proveedores for insert to authenticated
  with check (public.es_admin_sesion());

drop policy if exists "proveedores_update" on public.proveedores;
create policy "proveedores_update"
  on public.proveedores for update to authenticated
  using (public.es_admin_sesion());

drop policy if exists "inversiones_proveedor_select" on public.inversiones_proveedor;
create policy "inversiones_proveedor_select"
  on public.inversiones_proveedor for select to authenticated
  using (public.es_admin_sesion() or proveedor_id = public.proveedor_id_sesion());

drop policy if exists "inversiones_proveedor_insert" on public.inversiones_proveedor;
create policy "inversiones_proveedor_insert"
  on public.inversiones_proveedor for insert to authenticated
  with check (public.es_admin_sesion());

drop policy if exists "inversiones_proveedor_update" on public.inversiones_proveedor;
create policy "inversiones_proveedor_update"
  on public.inversiones_proveedor for update to authenticated
  using (public.es_admin_sesion());
