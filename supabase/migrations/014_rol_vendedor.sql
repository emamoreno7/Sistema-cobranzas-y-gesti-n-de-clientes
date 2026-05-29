-- Rol vendedor en tabla usuarios (mismas restricciones de visibilidad que cobrador en la app).
alter table public.usuarios drop constraint if exists usuarios_rol_check;
alter table public.usuarios add constraint usuarios_rol_check
  check (rol in ('super', 'admin', 'cobrador', 'vendedor', 'root'));
