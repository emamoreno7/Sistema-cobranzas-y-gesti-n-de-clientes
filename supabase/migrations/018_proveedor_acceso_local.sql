-- Acceso local de proveedores (usuario + clave en BD, sin Supabase Auth).

create extension if not exists pgcrypto with schema extensions;

alter table public.proveedores
  add column if not exists clave_acceso_hash text,
  add column if not exists token_sesion uuid,
  add column if not exists token_expira timestamptz;

alter table public.proveedores alter column auth_email drop not null;

-- Alta de proveedor (solo admin autenticado en Supabase Auth).
create or replace function public.crear_proveedor_admin(
  p_nombre text,
  p_login text,
  p_clave text,
  p_telefono text default null,
  p_created_by text default null
)
returns public.proveedores
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_login text;
  v_row public.proveedores;
begin
  if not public.es_admin_sesion() then
    raise exception 'Solo el administrador puede crear proveedores';
  end if;
  v_login := lower(trim(regexp_replace(p_login, '[^a-zA-Z0-9_]', '_', 'g')));
  if v_login = '' or length(v_login) < 2 then
    raise exception 'Usuario inválido';
  end if;
  if length(trim(p_clave)) < 4 then
    raise exception 'La contraseña debe tener al menos 4 caracteres';
  end if;
  if v_login in ('marcos', 'matias', 'vendedor', 'root', 'admin', 'cobrador1', 'cobrador2') then
    raise exception 'Ese nombre de usuario está reservado';
  end if;
  if exists (select 1 from public.proveedores where login = v_login) then
    raise exception 'Ya existe un proveedor con ese usuario';
  end if;

  insert into public.proveedores (
    nombre, login, auth_email, clave_acceso_hash, telefono, created_by, activo
  )
  values (
    trim(p_nombre),
    v_login,
    v_login || '@proveedor.local',
    extensions.crypt(trim(p_clave), extensions.gen_salt('bf')),
    nullif(trim(coalesce(p_telefono, '')), ''),
    nullif(trim(coalesce(p_created_by, '')), ''),
    true
  )
  returning * into v_row;

  insert into public.usuarios (username, password, rol, activo)
  values (v_login, '—', 'proveedor', true)
  on conflict (username) do update set rol = 'proveedor', activo = true;

  return v_row;
end;
$$;

-- Login proveedor: devuelve token de sesión (30 días).
create or replace function public.proveedor_login(p_login text, p_clave text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.proveedores;
  v_token uuid;
begin
  select * into v_row
  from public.proveedores
  where login = lower(trim(p_login))
    and activo = true
    and clave_acceso_hash is not null
    and clave_acceso_hash = extensions.crypt(trim(p_clave), clave_acceso_hash);

  if not found then
    raise exception 'Credenciales incorrectas';
  end if;

  v_token := gen_random_uuid();
  update public.proveedores
  set token_sesion = v_token, token_expira = now() + interval '30 days'
  where id = v_row.id;

  return jsonb_build_object(
    'token', v_token,
    'proveedor_id', v_row.id,
    'nombre', v_row.nombre,
    'login', v_row.login
  );
end;
$$;

create or replace function public.proveedor_validar_token(p_token uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'nombre', p.nombre,
    'login', p.login,
    'auth_email', coalesce(p.auth_email, p.login || '@proveedor.local')
  )
  from public.proveedores p
  where p.token_sesion = p_token
    and p.token_expira > now()
    and p.activo = true
  limit 1;
$$;

create or replace function public.proveedor_inversiones(p_token uuid)
returns setof public.inversiones_proveedor
language sql
security definer
set search_path = public
as $$
  select i.*
  from public.inversiones_proveedor i
  inner join public.proveedores p on p.id = i.proveedor_id
  where p.token_sesion = p_token
    and p.token_expira > now()
    and p.activo = true
  order by i.fecha_ingreso desc;
$$;

grant execute on function public.crear_proveedor_admin(text, text, text, text, text) to authenticated;
grant execute on function public.proveedor_login(text, text) to anon, authenticated;
grant execute on function public.proveedor_validar_token(uuid) to anon, authenticated;
grant execute on function public.proveedor_inversiones(uuid) to anon, authenticated;

-- Reparar proveedor creado antes de 018 (sin clave): select admin_establecer_clave_proveedor('usuario', 'clave123');
create or replace function public.admin_establecer_clave_proveedor(p_login text, p_clave text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.es_admin_sesion() then
    raise exception 'Solo administrador';
  end if;
  if length(trim(p_clave)) < 4 then
    raise exception 'Clave muy corta';
  end if;
  update public.proveedores
  set clave_acceso_hash = extensions.crypt(trim(p_clave), extensions.gen_salt('bf'))
  where login = lower(trim(p_login));
  if not found then
    raise exception 'Proveedor no encontrado';
  end if;
end;
$$;

grant execute on function public.admin_establecer_clave_proveedor(text, text) to authenticated;
