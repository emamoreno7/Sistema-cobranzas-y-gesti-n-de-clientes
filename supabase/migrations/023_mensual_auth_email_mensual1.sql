-- Auth interno del módulo mensual: mensual1@emd.com (mensual@emd.com lo rechaza Supabase).

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
        or em_local in ('mensual', 'mensual1')
      )
  ) then
    return 'mensual';
  end if;
  return 'principal';
end;
$$;
