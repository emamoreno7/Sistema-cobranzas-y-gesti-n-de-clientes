-- Habilita Supabase Realtime en tablas que usa la app (actualización sin recargar).
-- NOTA: La pestaña "Replication" del dashboard es para réplicas de lectura, NO para esto.
-- Tras ejecutar: Database → Publications → supabase_realtime debe listar estas tablas.

do $$
declare
  t text;
  tablas text[] := array[
    'clientes',
    'creditos',
    'pagos',
    'cuotas',
    'gastos',
    'caja',
    'caja_propia_movimientos',
    'rendiciones',
    'solicitudes_fondo_credito',
    'cheques',
    'notificaciones',
    'configuracion',
    'proveedores',
    'inversiones_proveedor'
  ];
begin
  foreach t in array tablas loop
    if exists (
      select 1 from pg_tables
      where schemaname = 'public' and tablename = t
    ) then
      execute format('alter table public.%I replica identity full', t);
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end if;
  end loop;
end $$;
