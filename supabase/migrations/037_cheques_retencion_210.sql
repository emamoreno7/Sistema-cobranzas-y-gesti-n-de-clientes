-- Documentación: retención de cheques aceptados = 210 días (lógica en app, VistaCheques).

comment on table public.cheques is
  'Cheques con foto; aprobación Marcos. Aceptados: eliminar_en +210 días; rechazados: +7 días.';
