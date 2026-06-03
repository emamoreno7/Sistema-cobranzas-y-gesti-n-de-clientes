-- Trial de 30 días SOLO para usuario demo `prueba` (no afecta a Marcos, cobradores, etc.).
-- Al vencer: marca demo_bloqueado y desactiva el usuario en BD (no puede re-login aunque borre caché).

alter table public.usuarios
  add column if not exists trial_fin timestamptz,
  add column if not exists demo_bloqueado boolean not null default false;

comment on column public.usuarios.trial_fin is
  'Fin del trial del usuario demo (solo username prueba).';
comment on column public.usuarios.demo_bloqueado is
  'true = demo consumida; login bloqueado en servidor hasta reactivación manual.';

update public.usuarios
set
  trial_fin = coalesce(trial_fin, now() + interval '30 days'),
  demo_bloqueado = false,
  activo = true,
  rol = 'root'
where username = 'prueba';

-- El trial global en configuracion no bloquea a otros usuarios.
update public.configuracion
set trial_fin = null
where id = 'global_config';

create or replace function public.verificar_acceso_demo_prueba(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.usuarios%rowtype;
  uname text := lower(trim(coalesce(p_username, '')));
begin
  if uname <> 'prueba' then
    return jsonb_build_object('ok', true, 'es_demo', false);
  end if;

  select * into u from public.usuarios where lower(username) = 'prueba' limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'es_demo', true, 'motivo', 'usuario_no_existe');
  end if;

  if u.demo_bloqueado or u.activo = false then
    return jsonb_build_object('ok', false, 'es_demo', true, 'motivo', 'demo_bloqueada');
  end if;

  if u.trial_fin is not null and u.trial_fin < now() then
    update public.usuarios
    set demo_bloqueado = true, activo = false
    where id = u.id;
    return jsonb_build_object(
      'ok', false,
      'es_demo', true,
      'motivo', 'trial_vencido',
      'trial_fin', u.trial_fin
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'es_demo', true,
    'trial_fin', u.trial_fin,
    'dias_restantes', greatest(0, (u.trial_fin::date - current_date))
  );
end;
$$;

grant execute on function public.verificar_acceso_demo_prueba(text) to authenticated;
