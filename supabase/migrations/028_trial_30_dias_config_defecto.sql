-- Licencia de prueba 30 días + ajustes por defecto (sin datos de otro cliente).

alter table public.configuracion
  add column if not exists trial_fin timestamptz;

comment on column public.configuracion.trial_fin is
  'Fin del período de prueba; tras esta fecha la app bloquea operaciones.';

insert into public.configuracion (
  id,
  porcentaje_interes,
  interes_credito_m,
  interes_credito_p,
  porcentaje_comision_vendedor,
  nombre_empresa,
  telefono_empresa,
  direccion_empresa,
  ruc,
  moneda,
  simbolo_moneda,
  mora_porciento,
  numero_whatsapp_admin,
  modo_exterior,
  trial_fin
)
values (
  'global_config',
  20,
  30,
  20,
  5,
  'DotCom Sistema de Gestión',
  '',
  'Calle Principal 123',
  '00-00000000-0',
  'ARS',
  '$',
  2,
  '',
  false,
  now() + interval '30 days'
)
on conflict (id) do update set
  nombre_empresa = excluded.nombre_empresa,
  telefono_empresa = excluded.telefono_empresa,
  direccion_empresa = excluded.direccion_empresa,
  ruc = excluded.ruc,
  numero_whatsapp_admin = excluded.numero_whatsapp_admin,
  interes_credito_m = excluded.interes_credito_m,
  interes_credito_p = excluded.interes_credito_p,
  mora_porciento = excluded.mora_porciento,
  porcentaje_comision_vendedor = excluded.porcentaje_comision_vendedor,
  trial_fin = coalesce(public.configuracion.trial_fin, excluded.trial_fin);
