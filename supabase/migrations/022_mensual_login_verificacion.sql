-- Verificación de clave del módulo mensual (tabla usuarios) antes de provisionar Supabase Auth.

create or replace function public.verificar_clave_modulo_mensual(p_login text, p_clave text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.usuarios u
    where u.activo = true
      and u.rol = 'mensual'
      and lower(trim(u.username)) = lower(trim(coalesce(p_login, '')))
      and u.password = coalesce(p_clave, '')
  );
$$;

revoke all on function public.verificar_clave_modulo_mensual(text, text) from public;
grant execute on function public.verificar_clave_modulo_mensual(text, text) to anon, authenticated;

comment on function public.verificar_clave_modulo_mensual(text, text) is
  'Valida usuario/clave del módulo mensual en public.usuarios (login sin Supabase Auth previo).';
