/**
 * Pegar en la consola del navegador (F12) después de ejecutar
 * supabase/migrations/026_reset_datos_entrega_cliente.sql en Supabase.
 * Conserva sesión y porcentajes de interés / tasas mensuales.
 *
 * Storage (DNI/videos): con sesión Marcos en la app:
 *   await dotcomLimpiarStorageEntrega()
 */
(function limpiarCacheEntregaDotCom() {
  const conservar = new Set([
    'cp_session',
    'cp_last_login_user',
    'cp_interes_credito_m',
    'cp_interes_credito_p',
    'cp_ajuste_tasa_mensual_pct',
    'cp_tasas_mensual_por_mes',
  ]);
  const explicitas = [
    'cp_data_v2',
    'cp_fic',
    'cp_gas',
    'cp_aud',
    'cp_cartones_credito',
    'cp_cobros_pendientes_v1',
    'cp_auditoria_cola_v1',
    'cp_cobrador_uuid_labels_v1',
  ];
  const borradas = [];
  for (const k of explicitas) {
    if (localStorage.getItem(k) != null) {
      localStorage.removeItem(k);
      borradas.push(k);
    }
  }
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k || conservar.has(k)) continue;
    if (k.startsWith('cp_') && !conservar.has(k)) {
      localStorage.removeItem(k);
      borradas.push(k);
    }
  }
  console.log('[DotCom] Caché local borrada:', [...new Set(borradas)]);
  console.log('[DotCom] Recargá la página (F5).');
})();
