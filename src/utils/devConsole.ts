/** Avisos no críticos solo en desarrollo (evita ruido en build de producción). */
export function devWarn(...args: unknown[]): void {
  if (import.meta.env.DEV) console.warn(...args);
}
