-- Marcos / admin: eliminar créditos y revertir cobros, caja y solicitudes de fondo.

drop policy if exists creditos_delete_admin on public.creditos;
create policy creditos_delete_admin
  on public.creditos for delete to authenticated
  using (public.es_admin_sesion());

drop policy if exists pagos_delete_admin on public.pagos;
create policy pagos_delete_admin
  on public.pagos for delete to authenticated
  using (public.es_admin_sesion());

drop policy if exists caja_delete_admin on public.caja;
create policy caja_delete_admin
  on public.caja for delete to authenticated
  using (public.es_admin_sesion());

drop policy if exists solicitudes_fondo_delete_admin on public.solicitudes_fondo_credito;
create policy solicitudes_fondo_delete_admin
  on public.solicitudes_fondo_credito for delete to authenticated
  using (public.es_admin_sesion());

drop policy if exists caja_propia_delete_admin on public.caja_propia_movimientos;
create policy caja_propia_delete_admin
  on public.caja_propia_movimientos for delete to authenticated
  using (public.es_admin_sesion());
