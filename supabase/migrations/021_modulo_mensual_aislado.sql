-- Módulo mensual aislado: usuario `mensual`, datos con ambito `mensual` vs `principal`.

alter table public.clientes add column if not exists ambito text not null default 'principal';
alter table public.creditos add column if not exists ambito text not null default 'principal';
alter table public.pagos add column if not exists ambito text not null default 'principal';

create index if not exists idx_clientes_ambito on public.clientes (ambito);
create index if not exists idx_creditos_ambito on public.creditos (ambito);
create index if not exists idx_pagos_ambito on public.pagos (ambito);

alter table public.usuarios drop constraint if exists usuarios_rol_check;
alter table public.usuarios add constraint usuarios_rol_check
  check (rol in ('super', 'admin', 'cobrador', 'vendedor', 'proveedor', 'root', 'mensual'));

insert into public.usuarios (username, password, rol, activo)
values ('mensual', 'Emamoreno7', 'mensual', true)
on conflict (username) do update
  set rol = 'mensual', activo = true, password = excluded.password;

-- Ámbito según rol del usuario autenticado (tabla usuarios + email Auth).
create or replace function public.sesion_ambito_datos()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  em_local text := lower(trim(split_part(coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json->>'email', ''
  ), '@', 1)));
begin
  if exists (
    select 1 from public.usuarios u
    where u.activo = true
      and u.rol = 'mensual'
      and (
        (uid is not null and u.id = uid)
        or lower(u.username) = em_local
        or lower(u.username) = 'mensual'
      )
  ) then
    return 'mensual';
  end if;
  return 'principal';
end;
$$;

revoke all on function public.sesion_ambito_datos() from public;
grant execute on function public.sesion_ambito_datos() to authenticated;

-- Clientes
drop policy if exists "clientes_select_authenticated" on public.clientes;
drop policy if exists "clientes_insert_authenticated" on public.clientes;
drop policy if exists "clientes_update_authenticated" on public.clientes;

create policy "clientes_select_ambito"
  on public.clientes for select to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "clientes_insert_ambito"
  on public.clientes for insert to authenticated
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "clientes_update_ambito"
  on public.clientes for update to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos())
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

-- Créditos
drop policy if exists "creditos_select_authenticated" on public.creditos;
drop policy if exists "creditos_insert_authenticated" on public.creditos;
drop policy if exists "creditos_update_authenticated" on public.creditos;

create policy "creditos_select_ambito"
  on public.creditos for select to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "creditos_insert_ambito"
  on public.creditos for insert to authenticated
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "creditos_update_ambito"
  on public.creditos for update to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos())
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

-- Pagos
alter table public.pagos enable row level security;

drop policy if exists "pagos_select_authenticated" on public.pagos;
drop policy if exists "pagos_insert_authenticated" on public.pagos;
drop policy if exists "pagos_update_authenticated" on public.pagos;

create policy "pagos_select_ambito"
  on public.pagos for select to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "pagos_insert_ambito"
  on public.pagos for insert to authenticated
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

create policy "pagos_update_ambito"
  on public.pagos for update to authenticated
  using (coalesce(ambito, 'principal') = public.sesion_ambito_datos())
  with check (coalesce(ambito, 'principal') = public.sesion_ambito_datos());

comment on column public.clientes.ambito is 'principal = cartera diaria/semanal; mensual = módulo autónomo de créditos mensuales.';

-- Crear en Supabase Auth: mensual1@emd.com / Emamoreno7 (Authentication → Users → Add user).
-- Nota: mensual@emd.com lo rechaza Supabase como email inválido; usar mensual1@emd.com.
