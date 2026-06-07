type SessionPayload = {
  active: boolean;
  lastActivity: number;
};

export type AuditAction =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'PIN_CAMBIO'
  | 'SYNC_ONLINE'
  | 'SYNC_OFFLINE'
  | 'CLIENTE_EDITADO'
  | 'CLIENTE_CREADO'
  | 'CLIENTE_ELIMINADO'
  | 'FICHA_CREADA'
  | 'PAGO_REGISTRADO'
  | 'PAGO_ELIMINADO'
  | 'VISITA_FALLIDA'
  | 'GASTO_CREADO'
  | 'GASTO_ELIMINADO'
  | 'CIERRE_JORNADA'
  | 'CIERRE_DIA_RUTA'
  | 'RENDICION_ACEPTADA'
  | 'CONFIG_CAMBIO'
  | 'CREDITO_ELIMINADO'
  | 'ASIGNAR_COBRADOR_FICHA';

type AuditItem = {
  id: string;
  fecha: string;
  hora: string;
  accion: AuditAction;
  usuario: string;
  detalle: string;
  gps?: { lat: number; lng: number };
};

const PIN_KEY = 'cp_pin_hash';
const SESSION_KEY = 'cp_pin_session';
const AUDIT_KEY = 'cp_audit_log';
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const now = () => Date.now();
const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

function getSession(): SessionPayload {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return { active: false, lastActivity: 0 };
  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    return {
      active: Boolean(parsed.active),
      lastActivity: Number(parsed.lastActivity) || 0,
    };
  } catch {
    return { active: false, lastActivity: 0 };
  }
}

function setSession(payload: SessionPayload) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
}

export function setPin(pin: string): void {
  localStorage.setItem(PIN_KEY, btoa(pin));
}

export function verifyPin(pin: string): boolean {
  const saved = localStorage.getItem(PIN_KEY);
  return saved === btoa(pin);
}

export function isPinSet(): boolean {
  return Boolean(localStorage.getItem(PIN_KEY));
}

export function isSessionActive(): boolean {
  const session = getSession();
  return session.active && !isSessionExpired();
}

export function activateSession(): void {
  setSession({ active: true, lastActivity: now() });
}

export function resetSession(): void {
  setSession({ active: false, lastActivity: 0 });
}

export function setLastActivity(): void {
  const session = getSession();
  setSession({ active: session.active, lastActivity: now() });
}

export function isSessionExpired(): boolean {
  const session = getSession();
  if (!session.active || !session.lastActivity) return true;
  return now() - session.lastActivity > SESSION_TIMEOUT_MS;
}

export function registrarAuditoria(
  accion: AuditAction,
  detalle: string,
  gps?: { lat: number; lng: number }
): void {
  const list = getAuditoria();
  const d = new Date();
  const entry: AuditItem = {
    id: genId(),
    fecha: d.toISOString().slice(0, 10),
    hora: d.toLocaleTimeString('es-AR'),
    accion,
    usuario: (() => {
      const raw = localStorage.getItem('cp_session');
      if (!raw) return 'sistema';
      try {
        const parsed = JSON.parse(raw) as { username?: string };
        return parsed.username || 'sistema';
      } catch {
        return 'sistema';
      }
    })(),
    detalle,
    gps,
  };
  localStorage.setItem(AUDIT_KEY, JSON.stringify([entry, ...list].slice(0, 1000)));
}

export function getAuditoria(): AuditItem[] {
  const raw = localStorage.getItem(AUDIT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AuditItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function exportarAuditoria(): string {
  const rows = getAuditoria();
  const headers = ['id', 'fecha', 'hora', 'accion', 'usuario', 'detalle', 'gps_lat', 'gps_lng'];
  const csvRows = rows.map((r) =>
    [
      r.id,
      r.fecha,
      r.hora,
      r.accion,
      r.usuario,
      `"${(r.detalle || '').replace(/"/g, '""')}"`,
      r.gps?.lat ?? '',
      r.gps?.lng ?? '',
    ].join(',')
  );
  return [headers.join(','), ...csvRows].join('\n');
}

/** Solo dígitos (sin espacios, +, guiones, paréntesis, etc.). */
export function soloDigitosTelefono(str: string): string {
  return String(str ?? '').replace(/\D/g, '');
}

/**
 * Celular AR para guardar en BD y para `wa.me`: cadena numérica con prefijo **549**.
 * Si el usuario borró el prefijo, se antepone al normalizar.
 */
export function normalizarTelefonoArg549(str: string): string {
  let d = soloDigitosTelefono(str);
  if (!d) return '';
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) {
    const rest = d.slice(2).replace(/^0+/, '');
    return `549${rest}`;
  }
  return `549${d.replace(/^0+/, '')}`;
}

/** Alias histórico: mismo criterio que `normalizarTelefonoArg549` (enlace WhatsApp). */
export function formatearNumeroWhatsApp(numero: string): string {
  return normalizarTelefonoArg549(numero);
}

export function generarLinkWhatsApp(numero: string, mensaje: string): string {
  const limpio = normalizarTelefonoArg549(numero);
  const text = encodeURIComponent(mensaje);
  return `https://wa.me/${limpio}?text=${text}`;
}
