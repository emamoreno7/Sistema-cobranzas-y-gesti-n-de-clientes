import { supabase } from './supabaseClient';

export const TASA_INVERSION_PROVEEDOR = 7;
export const PLAZO_INVERSION_PROVEEDOR_DIAS = 32;
export const CP_PROVEEDOR_TOKEN_KEY = 'cp_proveedor_token';

export type Proveedor = {
  id: string;
  nombre: string;
  login: string;
  auth_email: string;
  auth_user_id?: string | null;
  telefono?: string | null;
  activo: boolean;
};

export type InversionProveedor = {
  id: string;
  proveedor_id: string;
  monto: number;
  fecha_ingreso: string;
  tasa_interes: number;
  plazo_dias: number;
  monto_interes: number;
  monto_total_devolver: number;
  fecha_vencimiento: string;
  estado: 'activa' | 'liquidada';
  registrado_por?: string | null;
  nota?: string | null;
  proveedor?: Proveedor;
};

export type ProveedorLoginOk = {
  token: string;
  proveedor_id: string;
  nombre: string;
  login: string;
};

export function slugLoginProveedor(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28);
  return base || `prov_${Date.now().toString(36)}`;
}

export function generarPasswordProveedor(longitud = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < longitud; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export function calcularMontosInversion(
  monto: number,
  fechaIngreso: string,
  tasaPct = TASA_INVERSION_PROVEEDOR,
  plazoDias = PLAZO_INVERSION_PROVEEDOR_DIAS,
) {
  const capital = Math.round(Number(monto) || 0);
  const interes = Math.round(capital * (tasaPct / 100));
  const total = capital + interes;
  const d = new Date(`${fechaIngreso}T12:00:00`);
  d.setDate(d.getDate() + plazoDias);
  const fechaVencimiento = d.toISOString().split('T')[0];
  return { capital, interes, total, fechaVencimiento, tasaPct, plazoDias };
}

export function diasRestantesInversion(fechaVencimiento: string, ref?: string): number {
  const hoyStr = ref || new Date().toISOString().split('T')[0];
  const ms = new Date(`${fechaVencimiento}T12:00:00`).getTime() - new Date(`${hoyStr}T12:00:00`).getTime();
  return Math.ceil(ms / 86400000);
}

export function mapProveedorRow(r: Record<string, unknown>): Proveedor {
  return {
    id: String(r.id ?? ''),
    nombre: String(r.nombre ?? ''),
    login: String(r.login ?? ''),
    auth_email: String(r.auth_email ?? ''),
    auth_user_id: r.auth_user_id != null ? String(r.auth_user_id) : null,
    telefono: r.telefono != null ? String(r.telefono) : null,
    activo: r.activo !== false,
  };
}

export function mapInversionRow(r: Record<string, unknown>): InversionProveedor {
  return {
    id: String(r.id ?? ''),
    proveedor_id: String(r.proveedor_id ?? ''),
    monto: Number(r.monto ?? 0),
    fecha_ingreso: String(r.fecha_ingreso ?? '').slice(0, 10),
    tasa_interes: Number(r.tasa_interes ?? TASA_INVERSION_PROVEEDOR),
    plazo_dias: Number(r.plazo_dias ?? PLAZO_INVERSION_PROVEEDOR_DIAS),
    monto_interes: Number(r.monto_interes ?? 0),
    monto_total_devolver: Number(r.monto_total_devolver ?? 0),
    fecha_vencimiento: String(r.fecha_vencimiento ?? '').slice(0, 10),
    estado: (r.estado === 'liquidada' ? 'liquidada' : 'activa') as 'activa' | 'liquidada',
    registrado_por: r.registrado_por != null ? String(r.registrado_por) : null,
    nota: r.nota != null ? String(r.nota) : null,
  };
}

export async function loginProveedorLocal(login: string, clave: string): Promise<ProveedorLoginOk | null> {
  const { data, error } = await supabase.rpc('proveedor_login', {
    p_login: login.trim(),
    p_clave: clave,
  });
  if (error || !data) return null;
  const d = data as Record<string, unknown>;
  const token = String(d.token ?? '');
  if (!token) return null;
  return {
    token,
    proveedor_id: String(d.proveedor_id ?? ''),
    nombre: String(d.nombre ?? ''),
    login: String(d.login ?? login),
  };
}

export async function validarTokenProveedor(token: string): Promise<Proveedor | null> {
  const { data, error } = await supabase.rpc('proveedor_validar_token', { p_token: token });
  if (error || !data) return null;
  return mapProveedorRow(data as Record<string, unknown>);
}

export async function fetchInversionesProveedorToken(token: string): Promise<InversionProveedor[]> {
  const { data, error } = await supabase.rpc('proveedor_inversiones', { p_token: token });
  if (error || !Array.isArray(data)) return [];
  return data.map(r => mapInversionRow(r as Record<string, unknown>));
}

export async function crearProveedorAdminRpc(params: {
  nombre: string;
  login: string;
  clave: string;
  telefono?: string;
  createdBy?: string;
}): Promise<{ ok: true; proveedor: Proveedor } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('crear_proveedor_admin', {
    p_nombre: params.nombre,
    p_login: params.login,
    p_clave: params.clave,
    p_telefono: params.telefono ?? null,
    p_created_by: params.createdBy ?? null,
  });
  if (error) {
    const msg = String((error as { message?: string }).message ?? error);
    return { ok: false, error: msg };
  }
  return { ok: true, proveedor: mapProveedorRow(data as Record<string, unknown>) };
}
