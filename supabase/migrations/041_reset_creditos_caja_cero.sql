-- =============================================================================
-- Poner en CERO: créditos, cobranzas, caja de cobradores y caja propia.
-- ⚠️ IRREVERSIBLE. Ejecutar en Supabase → SQL Editor (rol postgres / service).
--
-- SE CONSERVA: clientes, usuarios, configuración, proveedores/inversiones, cheques, Auth.
-- SE BORRA: créditos, pagos, cuotas, caja, caja propia, solicitudes fondo, gastos, rendiciones, fichas.
-- =============================================================================

begin;

do $wipe$
declare
  sql_trunc text;
  tablas constant text[] := array[
    'caja_propia_movimientos',
    'solicitudes_fondo_credito',
    'caja',
    'cuotas',
    'liquidaciones_comision_vendedor',
    'rendiciones',
    'gastos',
    'pagos',
    'creditos',
    'fichas'
  ];
begin
  select 'truncate table '
    || string_agg(format('public.%I', table_name), ', ')
    || ' restart identity cascade'
  into sql_trunc
  from information_schema.tables
  where table_schema = 'public'
    and table_name = any (tablas);

  if sql_trunc is not null and btrim(sql_trunc) <> '' then
    execute sql_trunc;
    raise notice 'Ejecutado: %', sql_trunc;
  end if;
end $wipe$;

do $notif$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'notificaciones'
  ) then
    execute 'delete from public.notificaciones';
  end if;
end $notif$;

do $reset_clientes$
declare
  set_parts text[] := array[]::text[];
  sql_upd text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clientes' and column_name = 'saldo'
  ) then
    set_parts := array_append(set_parts, 'saldo = 0');
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clientes' and column_name = 'saldo_pendiente'
  ) then
    set_parts := array_append(set_parts, 'saldo_pendiente = 0');
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clientes' and column_name = 'saldo_debitado'
  ) then
    set_parts := array_append(set_parts, 'saldo_debitado = 0');
  end if;
  if coalesce(array_length(set_parts, 1), 0) > 0 then
    sql_upd := 'update public.clientes set ' || array_to_string(set_parts, ', ');
    execute sql_upd;
    raise notice 'Clientes: %', sql_upd;
  end if;
end $reset_clientes$;

do $reset_usuarios$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'usuarios' and column_name = 'comision_acumulada'
  ) then
    execute $sql$
      update public.usuarios
      set comision_acumulada = 0
      where coalesce(comision_acumulada, 0) <> 0
    $sql$;
  end if;
end $reset_usuarios$;

commit;
