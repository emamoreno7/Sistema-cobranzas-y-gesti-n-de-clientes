-- =============================================================================
-- ENTREGA AL CLIENTE: borrar TODOS los datos operativos y empezar de cero.
-- ⚠️ IRREVERSIBLE. Ejecutar solo en Supabase → SQL Editor (como postgres).
--
-- SE CONSERVA:
--   • public.usuarios (logins, roles, % comisión configurado)
--   • public.configuracion (ajustes de empresa, intereses, WhatsApp admin)
--   • Usuarios de Supabase Auth (no se tocan)
--
-- SE BORRA:
--   clientes, créditos, pagos, cuotas, caja, gastos, rendiciones, notificaciones,
--   fichas legacy, proveedores/inversiones, liquidaciones de comisión, auditoría.
--
-- Storage (documentos/videos): Supabase NO permite DELETE en storage.objects.
--   Opción A — Dashboard: Storage → vaciar buckets manualmente.
--   Opción B — Con sesión Marcos en la app, consola (F12):
--             await dotcomLimpiarStorageEntrega()
-- =============================================================================

begin;

do $truncate$
declare
  sql_trunc text;
  tablas_wipe constant text[] := array[
    'caja',
    'cuotas',
    'liquidaciones_comision_vendedor',
    'rendiciones',
    'gastos',
    'pagos',
    'notificaciones',
    'creditos',
    'fichas',
    'clientes',
    'inversiones_proveedor',
    'proveedores',
    'logs_auditoria',
    'audit_logs',
    'debug_errors'
  ];
begin
  select 'truncate table '
    || string_agg(format('public.%I', table_name), ', ')
    || ' restart identity cascade'
  into sql_trunc
  from information_schema.tables
  where table_schema = 'public'
    and table_name = any (tablas_wipe);

  if sql_trunc is not null and btrim(sql_trunc) <> '' then
    execute sql_trunc;
    raise notice 'Ejecutado: %', sql_trunc;
  else
    raise notice 'No hay tablas operativas para truncar.';
  end if;
end $truncate$;

update public.usuarios
set comision_acumulada = 0
where coalesce(comision_acumulada, 0) <> 0;

commit;

-- Paso 2: scripts/limpiar-localstorage-entrega.js en consola del navegador → F5.
-- Paso 3 (opcional): await dotcomLimpiarStorageEntrega() en consola (logueado como Marcos).
