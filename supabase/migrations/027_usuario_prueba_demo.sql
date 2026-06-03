-- Usuario demo "prueba" con rol root (acceso administrativo completo en la app).
--
-- PASO OBLIGATORIO en Supabase → Authentication → Users → Add user:
--   Email:    prueba@emd.com
--   Password: prueba
--   ✓ Auto Confirm User
--
-- Luego ejecutar este SQL (o ya estará si corrés la migración).

insert into public.usuarios (username, password, rol, activo, comision_acumulada)
values ('prueba', '—', 'root', true, 0)
on conflict (username) do update
  set rol = 'root', activo = true;
