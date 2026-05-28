/**
 * En producción (p. ej. Vercel), silencia console.log / info / debug / warn
 * para reducir ruido propio y de librerías. Los fallos críticos deben usar console.error.
 */
export function installProdConsoleSilence(): void {
  if (!import.meta.env.PROD || typeof console === 'undefined') return;
  const noop = (): void => {};
  const c = console as Console & { log: typeof noop };
  c.log = noop;
  c.debug = noop;
  c.info = noop;
  c.warn = noop;
}
