-- Comisión por vendedor (%) y aprobación admin antes de que el vendedor pueda cobrarla.

alter table public.usuarios
  add column if not exists porcentaje_comision numeric;

comment on column public.usuarios.porcentaje_comision is
  'Porcentaje de comisión sobre capital para este vendedor. NULL = usar configuración global.';

alter table public.creditos
  add column if not exists comision_aprobada_admin boolean not null default false,
  add column if not exists porcentaje_comision_credito numeric;

comment on column public.creditos.comision_aprobada_admin is
  'True cuando el admin aprobó la comisión; el vendedor solo suma a cobrar tras esta aprobación.';

-- Créditos con comisión ya registrada: considerarlos aprobados (compatibilidad).
update public.creditos
set comision_aprobada_admin = true
where comision_vendedor > 0;
