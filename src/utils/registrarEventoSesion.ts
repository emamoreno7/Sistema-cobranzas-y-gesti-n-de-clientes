import { supabase } from '../supabaseClient';

export async function obtenerIpPublicaCliente(): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    window.clearTimeout(t);
    if (!res.ok) return '';
    const json = (await res.json()) as { ip?: string };
    return String(json.ip ?? '').trim();
  } catch {
    return '';
  }
}

export async function registrarEventoSesion(params: {
  username?: string | null;
  email?: string | null;
  accion: string;
  detalle?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const ip = await obtenerIpPublicaCliente();
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 500) : '';
    await supabase.from('eventos_sesion').insert([{
      username: params.username ? String(params.username).slice(0, 120) : null,
      email: params.email ? String(params.email).slice(0, 200) : null,
      accion: String(params.accion).slice(0, 80),
      ip: ip || null,
      user_agent: ua || null,
      detalle: params.detalle ? String(params.detalle).slice(0, 2000) : null,
      meta: params.meta ?? {},
    } as never]);
  } catch {
    /* no bloquear login */
  }
}
