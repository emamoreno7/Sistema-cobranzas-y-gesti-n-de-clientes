import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://hdgnsonvsqipxcxwashp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_aJa1D1IcGOyZ0eXz8QmfJQ_0tPyv_7i';

export { SUPABASE_URL, SUPABASE_ANON_KEY };

const nativeFetch = globalThis.fetch.bind(globalThis);

/** Lanzada cuando la sesión no es válida (401 / refresh token inválido); el formulario muestra el mensaje al usuario. */
export class SesionExpiradaSupabaseError extends Error {
  constructor() {
    super('SESION_EXPIRADA_SUPABASE');
    this.name = 'SesionExpiradaSupabaseError';
  }
}

/** Errores de Auth o PostgREST que indican JWT/sesión inválida o expirada. */
export function esErrorSesionSupabase(error: unknown): boolean {
  if (error == null) return false;
  const e = error as Record<string, unknown>;
  const msg = String(e.message ?? '').toLowerCase();
  const code = String(e.code ?? '').toLowerCase();
  const status = typeof e.status === 'number' ? e.status : undefined;
  const esAuthGoTrue = e.__isAuthError === true;
  if (status === 401) return true;
  if (code === 'session_not_found' || code === 'pgrst301') return true;
  if (msg.includes('invalid refresh token')) return true;
  if (msg.includes('refresh token not found')) return true;
  if (msg.includes('jwt expired')) return true;
  if (msg.includes('invalid jwt')) return true;
  if (msg.includes('auth session missing')) return true;
  if (esAuthGoTrue && (status === 400 || status === 401) && (msg.includes('refresh') || msg.includes('jwt'))) {
    return true;
  }
  return false;
}

let supabaseRef: SupabaseClient | null = null;

/**
 * Si la API devuelve 401, intenta un refresco de sesión y repite la petición una vez
 * (p. ej. INSERT/UPDATE con access token recién expirado).
 */
async function fetchConReintento401(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let res = await nativeFetch(input, init);
  if (res.status !== 401 || !supabaseRef) return res;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (url.includes('/auth/v1/')) return res;
  const { data, error } = await supabaseRef.auth.refreshSession();
  if (error || !data.session?.access_token) return res;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${data.session.access_token}`);
  res = await nativeFetch(input, { ...init, headers });
  return res;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'cp-supabase-auth',
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  },
  global: {
    fetch: fetchConReintento401,
  },
});

supabaseRef = supabase;

/**
 * Refresca la sesión antes de escrituras en BD para reducir 401 por token al límite.
 * Devuelve `null` si el refresh falla por token inválido/expirado (el caller debe pedir re-login).
 */
export async function asegurarSesionEscritura() {
  const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
  if (refreshErr && esErrorSesionSupabase(refreshErr)) {
    return null;
  }
  const session = refreshed.session ?? (await supabase.auth.getSession()).data.session;
  if (!session?.access_token) return null;
  return session;
}
