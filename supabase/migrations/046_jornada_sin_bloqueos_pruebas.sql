-- Root: activar/desactivar modo pruebas sin bloqueo de jornada (cobros, cierres, ruta).

alter table public.configuracion
  add column if not exists jornada_sin_bloqueos_pruebas boolean not null default false;

comment on column public.configuracion.jornada_sin_bloqueos_pruebas is
  'true = cobradores/vendedores sin bloqueo post-rendición ni cierre de ruta (solo para pruebas; control Root).';
