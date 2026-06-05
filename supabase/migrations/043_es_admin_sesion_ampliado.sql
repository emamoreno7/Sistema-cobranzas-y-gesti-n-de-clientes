-- Alinea es_admin_sesion() con los administradores de la app (Marcos, root, prueba, usuarios rol admin/root/super).

create or replace function public.es_admin_sesion()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') in (
      'emamoreno7@hotmail.com',
      'root@emd.com',
      'prueba@emd.com'
    )
    or lower(coalesce(auth.jwt() ->> 'email', '')) like '%admin%'
    or exists (
      select 1
      from public.usuarios u
      where u.activo = true
        and u.rol in ('admin', 'root', 'super')
        and lower(u.username) = lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1))
    ),
    false
  );
$$;
