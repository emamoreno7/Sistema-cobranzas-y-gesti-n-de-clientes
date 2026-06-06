import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Options as Html2CanvasOptions } from 'html2canvas';
import type { jsPDF as JsPDFDocument } from 'jspdf';
import { LogOut, Shield } from 'lucide-react';
import {
  // Auth
  resetSession,
  // Audit
  registrarAuditoria, exportarAuditoria,
  type AuditAction,
  // WhatsApp / teléfonos
  generarLinkWhatsApp,
  normalizarTelefonoArg549,
  soloDigitosTelefono,
} from './utils/exports';
import {
  supabase,
  asegurarSesionEscritura,
  esErrorSesionSupabase,
  SesionExpiradaSupabaseError,
} from './supabaseClient';
import { BrandingFooter } from './components/BrandingFooter';
import { TrialBloqueoOverlay } from './components/TrialBloqueoOverlay';
import { TrialCountdownBadge } from './components/TrialCountdownBadge';
import { VistaRapidaSistemaModal } from './components/VistaRapidaSistemaModal';
import { PanelRootTecnico } from './components/PanelRootTecnico';
import { VistaCheques } from './components/VistaCheques';
import { registrarEventoSesion } from './utils/registrarEventoSesion';
import { CONFIG_DEFECTO, configDesdeCacheLocal, configDesdeSupabase } from './utils/configEntrega';
import {
  MSG_TRIAL_EXPIRADO,
  mensajeBloqueoDemoPrueba,
  parseResultadoAccesoDemo,
  trialExpirado,
} from './utils/trialLicencia';
import { devWarn } from './utils/devConsole';
import {
  type Proveedor,
  type InversionProveedor,
  TASA_INVERSION_PROVEEDOR,
  PLAZO_INVERSION_PROVEEDOR_DIAS,
  CP_PROVEEDOR_TOKEN_KEY,
  slugLoginProveedor,
  generarPasswordProveedor,
  calcularMontosInversion,
  diasRestantesInversion,
  loginProveedorLocal,
  validarTokenProveedor,
  fetchInversionesProveedorToken,
  crearProveedorAdminRpc,
  mapProveedorRow,
  mapInversionRow,
} from './proveedoresInversion';

const MSJ_SESION_EXPIRADA_CLIENTE =
  'Tu sesión ha expirado. Por favor, vuelve a iniciar sesión para guardar los cambios.';

class ErrorSubidaDniCliente extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorSubidaDniCliente';
  }
}

declare global {
  interface Window {
    Html5Qrcode?: any;
  }
}

// ==========================================
// TIPOS
// ==========================================
interface Cliente {
  id: string; nombre: string; telefono: string; direccion: string;
  apellido?: string; dni?: string;
  fechaNacimiento?: string;
  dniFrenteUrl?: string; dniDorsoUrl?: string;
  /** Video corto del negocio (máx. 30 s); retención 30 días en storage. */
  videoVerificacionUrl?: string;
  videoVerificacionPath?: string;
  videoVerificacionSubidoAt?: string;
  videoVerificacionExpiraAt?: string;
  lat?: number; lng?: number; coordenadaErr?: string;
  saldo: number; quota: number; frecuencia: 'diaria' | 'semanal' | 'quincenal' | 'mensual';
  fechaAlta: string; activo: boolean; ultimaVisita?: string;
  notas?: string; promesaPago?: string; promesaFecha?: string;
  ultimoMontoRecibido?: number;
  /** Prioridad en hoja de ruta (menor = antes). Solo editable por admin en ficha cliente. */
  orden_ruta?: number | null;
  /** Columna BD; útil para depurar visibilidad por cobrador / RLS. */
  cobrador_id?: string | null;
  /** principal | mensual — aislamiento de cartera. */
  ambito?: string;
}

function esUuidClienteId(v: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}

/** UUID normalizado en minúsculas (PostgREST). */
function normalizarUuidPostgrest(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return esUuidClienteId(s) ? s : null;
}

/** Enteros seguros para columnas `integer` (clientes.saldo_*, montos). */
function intPgSaldo(n: number): number {
  const x = redondearPesos(Number(n));
  const v = Number.isFinite(x) ? Math.trunc(x) : 0;
  return Math.min(Math.max(0, v), 2147483647);
}

function dbgSupabaseTbl(tabla: string, operacion: string, detalle?: Record<string, unknown>) {
  console.log(`[Supabase tabla=${tabla}] ${operacion}`, detalle ?? '');
}

const LS_COBROS_PENDIENTES_V1 = 'cp_cobros_pendientes_v1';

/** Mensaje amable cuando el cobro queda en el teléfono por red caída. */
const MSJ_COBRO_LOCAL_SIN_RED = '¡Cobro registrado! Se subirá solo cuando tengas mejor señal';

type CobroPendienteLocalV1 = {
  v: 1;
  ts: number;
  pagoDb: Record<string, unknown>;
};

function appendCobroPendienteLocal(entry: CobroPendienteLocalV1) {
  try {
    const raw = localStorage.getItem(LS_COBROS_PENDIENTES_V1);
    let arr: CobroPendienteLocalV1[] = [];
    if (raw) {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) arr = p as CobroPendienteLocalV1[];
    }
    arr.push(entry);
    localStorage.setItem(LS_COBROS_PENDIENTES_V1, JSON.stringify(arr));
  } catch (e) {
    console.error('appendCobroPendienteLocal:', e);
  }
}

function leerCobrosPendientesLocalRaw(): CobroPendienteLocalV1[] {
  try {
    const raw = localStorage.getItem(LS_COBROS_PENDIENTES_V1);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? (p as CobroPendienteLocalV1[]) : [];
  } catch {
    return [];
  }
}

function escribirCobrosPendientesLocal(arr: CobroPendienteLocalV1[]) {
  try {
    if (!arr.length) {
      localStorage.removeItem(LS_COBROS_PENDIENTES_V1);
      return;
    }
    localStorage.setItem(LS_COBROS_PENDIENTES_V1, JSON.stringify(arr));
  } catch (e) {
    console.error('escribirCobrosPendientesLocal:', e);
  }
}

/** Quita de la cola offline el mismo cobro que ya confirmó el servidor (ficha + cliente + nro cuota). */
function quitarCobrosPendientesLocalesResueltos(match: { ficha_id: string; cliente_id: string; cuota_numero: number }) {
  try {
    const fid = fichaIdUuid(match.ficha_id);
    const cid = String(match.cliente_id ?? '').trim();
    const nCuota = Math.round(Number(match.cuota_numero));
    const arr = leerCobrosPendientesLocalRaw();
    const next = arr.filter(e => {
      const pd = e.pagoDb as Record<string, unknown>;
      const ef = fichaIdUuid(String(pd.ficha_id ?? ''));
      const ecid = String(pd.cliente_id ?? '').trim();
      const ecuota = Math.round(Number(pd.cuota_numero ?? NaN));
      return !(ef === fid && ecid === cid && ecuota === nCuota);
    });
    escribirCobrosPendientesLocal(next);
  } catch (e) {
    console.error('quitarCobrosPendientesLocalesResueltos:', e);
  }
}

/** Texto del banner de cola offline, o null si ya no queda nada pendiente. */
function siguienteMensajeBannerColaCobrosPendientes(): string | null {
  const rest = leerCobrosPendientesLocalRaw();
  if (rest.length === 0) return null;
  return `Hay ${rest.length} cobro(s) guardado(s) en este dispositivo pendientes de sincronización con el servidor.`;
}

const LS_AUDITORIA_COLA_V1 = 'cp_auditoria_cola_v1';
const AUDITORIA_COLA_MAX_ITEMS = 200;

type FilaLogAuditoriaInsert = {
  tipo: 'cobro' | 'credito';
  contexto: string;
  mensaje_error: string;
  datos_enviados: Record<string, unknown>;
  actor: string | null;
  meta: Record<string, unknown>;
};

function encolarLogAuditoriaLocal(fila: FilaLogAuditoriaInsert) {
  try {
    const raw = localStorage.getItem(LS_AUDITORIA_COLA_V1);
    let arr: FilaLogAuditoriaInsert[] = [];
    if (raw) {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) arr = p.filter(x => x && typeof x === 'object') as FilaLogAuditoriaInsert[];
    }
    arr.push(fila);
    while (arr.length > AUDITORIA_COLA_MAX_ITEMS) arr.shift();
    localStorage.setItem(LS_AUDITORIA_COLA_V1, JSON.stringify(arr));
  } catch {
    /* jamás debe afectar al cobrador */
  }
}

async function flushColaLogsAuditoriaSupabase(): Promise<void> {
  for (;;) {
    let arr: FilaLogAuditoriaInsert[] = [];
    try {
      const raw = localStorage.getItem(LS_AUDITORIA_COLA_V1);
      if (!raw) break;
      const p = JSON.parse(raw) as unknown;
      arr = Array.isArray(p) ? (p.filter(x => x && typeof x === 'object') as FilaLogAuditoriaInsert[]) : [];
    } catch {
      try {
        localStorage.removeItem(LS_AUDITORIA_COLA_V1);
      } catch {
        /**/
      }
      break;
    }
    if (arr.length === 0) {
      try {
        localStorage.removeItem(LS_AUDITORIA_COLA_V1);
      } catch {
        /**/
      }
      break;
    }
    const fila = arr[0];
    const rowPayload = {
      tipo: fila.tipo,
      contexto: String(fila.contexto).slice(0, 500),
      mensaje_error: String(fila.mensaje_error).slice(0, 4000),
      datos_enviados: fila.datos_enviados as any,
      actor: fila.actor != null ? String(fila.actor).slice(0, 500) : null,
      meta: fila.meta as any,
    };
    const { error } = await supabase.from('logs_auditoria').insert([rowPayload as any]);
    if (error) break;
    arr.shift();
    try {
      if (arr.length) localStorage.setItem(LS_AUDITORIA_COLA_V1, JSON.stringify(arr));
      else localStorage.removeItem(LS_AUDITORIA_COLA_V1);
    } catch {
      break;
    }
  }
}

type CobranzaAtomicaRow = {
  pago_id?: string | null;
  cuota_actualizada?: boolean | null;
  saldo_pendiente?: number | null;
  saldo_debitado?: number | null;
  modo_fallback_simple?: boolean;
} & Record<string, unknown>;

type ParamsRegistroCobranzaDirectaSupabase = {
  ficha_id: string;
  cliente_id: string;
  cobrador_id: string;
  monto: number;
  fecha_pago: string;
  cuota_numero: number;
  es_registro_no_pago?: boolean;
  ambito?: string;
};

async function insertarDebugErrorSupabase(context: string, payload: unknown) {
  try {
    const row = { context: String(context).slice(0, 500), payload: payload as Record<string, unknown> };
    const { error } = await supabase.from('debug_errors').insert([row as any]);
    if (error) console.error('insertarDebugErrorSupabase:', error);
  } catch (e) {
    console.error('insertarDebugErrorSupabase excepción:', e);
  }
}

function sanitizarJsonAuditoria(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(
      JSON.stringify(obj, (_k, v) => (typeof v === 'function' || typeof v === 'symbol' ? undefined : v)),
    ) as Record<string, unknown>;
  } catch {
    return { _serializacion: 'fallida' };
  }
}

function serializarErrorParaAuditoria(err: unknown): { mensaje: string; meta: Record<string, unknown> } {
  if (err instanceof Error) {
    return {
      mensaje: err.message || String(err),
      meta: {
        name: err.name,
        ...(err.stack ? { stack: String(err.stack).slice(0, 4000) } : {}),
      },
    };
  }
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const msg = String(
      o.message ?? o.error_description ?? o.details ?? o.hint ?? 'Error',
    ).slice(0, 2000);
    const meta: Record<string, unknown> = {};
    for (const k of ['code', 'details', 'hint', 'status']) {
      if (k in o) meta[k] = o[k];
    }
    return { mensaje: msg || 'Error desconocido', meta };
  }
  return { mensaje: String(err), meta: {} };
}

async function insertarLogAuditoriaSupabase(params: {
  tipo: 'cobro' | 'credito';
  contexto: string;
  mensaje_error: string;
  datos_enviados: Record<string, unknown>;
  actor?: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    const fila: FilaLogAuditoriaInsert = {
      tipo: params.tipo,
      contexto: String(params.contexto).slice(0, 500),
      mensaje_error: String(params.mensaje_error).slice(0, 4000),
      datos_enviados: sanitizarJsonAuditoria(params.datos_enviados),
      actor: params.actor != null ? String(params.actor).slice(0, 500) : null,
      meta: sanitizarJsonAuditoria({ ...(params.meta ?? {}) }),
    };
    const row = {
      tipo: fila.tipo,
      contexto: fila.contexto,
      mensaje_error: fila.mensaje_error,
      datos_enviados: fila.datos_enviados as any,
      actor: fila.actor,
      meta: fila.meta as any,
    };
    const { error } = await supabase.from('logs_auditoria').insert([row as any]);
    if (error) encolarLogAuditoriaLocal(fila);
  } catch {
    try {
      encolarLogAuditoriaLocal({
        tipo: params.tipo,
        contexto: String(params.contexto).slice(0, 500),
        mensaje_error: String(params.mensaje_error).slice(0, 4000),
        datos_enviados: sanitizarJsonAuditoria(params.datos_enviados),
        actor: params.actor != null ? String(params.actor).slice(0, 500) : null,
        meta: sanitizarJsonAuditoria({ ...(params.meta ?? {}) }),
      });
    } catch {
      /* sin salida al usuario */
    }
  }
}

/** Registro de cobro vía REST únicamente (`pagos`, `cuotas`, opcional `clientes`, `caja`). */
async function registrarCobranzaDirectaSupabase(
  params: ParamsRegistroCobranzaDirectaSupabase,
): Promise<{ ok: true; data: CobranzaAtomicaRow } | { ok: false; error: unknown }> {
  const clienteUuid = normalizarUuidPostgrest(params.cliente_id);
  const creditoUuid = normalizarUuidPostgrest(params.ficha_id);
  if (!clienteUuid || !creditoUuid) {
    return { ok: false, error: new Error('cliente_id o ficha_id (crédito) no son UUID válidos') };
  }

  const montoRound = intPgSaldo(params.monto);
  const nCuota = Math.max(1, Math.round(Number(params.cuota_numero) || 1));
  const rowInsert = {
    ficha_id: creditoUuid,
    cliente_id: clienteUuid,
    cobrador_id: String(params.cobrador_id ?? '').trim() || 'sin_usuario',
    monto: montoRound,
    fecha_pago: params.fecha_pago,
    cuota_numero: nCuota,
    es_registro_no_pago: Boolean(params.es_registro_no_pago),
    ambito: String(params.ambito ?? AMBITO_DATOS_PRINCIPAL).trim() || AMBITO_DATOS_PRINCIPAL,
  };

  dbgSupabaseTbl('pagos', 'insert', { cliente_id: clienteUuid, ficha_id: creditoUuid, cuota_numero: nCuota });
  const { data: inserted, error: eIns } = await supabase.from('pagos').insert([rowInsert as any]).select('*').single();
  const pagoId = normalizarUuidPostgrest((inserted as Record<string, unknown> | null)?.id) ?? '';
  if (eIns || !pagoId) return { ok: false, error: eIns ?? new Error('Directa: insert en pagos sin id') };

  if (Boolean(params.es_registro_no_pago) === false && montoRound > 0) {
    dbgSupabaseTbl('cuotas', 'sync_estado_por_pagos', { credito_id: creditoUuid, nro_cuota: nCuota, pago_id: pagoId });
    const cuotaActualizada = await aplicarEstadoCuotasSegunPagosCredito(creditoUuid);
    if (!cuotaActualizada) {
      const nowIso = new Date().toISOString();
      const { error: eCu } = await supabase
        .from('cuotas')
        .update({
          estado: 'pagado',
          pago_id: pagoId,
          pagado_at: params.fecha_pago,
          updated_at: nowIso,
        } as any)
        .eq('credito_id', creditoUuid)
        .eq('nro_cuota', nCuota)
        .neq('estado', 'pagado')
        .select('id');
      if (eCu) {
        void insertarLogAuditoriaSupabase({
          tipo: 'cobro',
          contexto: 'cobro_cuotas_update_fallido',
          mensaje_error: String((eCu as { message?: string })?.message ?? eCu).slice(0, 2000),
          datos_enviados: {
            credito_id: creditoUuid,
            cliente_id: clienteUuid,
            nro_cuota: nCuota,
            pago_id: pagoId,
            code: (eCu as { code?: string })?.code,
          },
          actor: null,
        });
      }
    }

    let saldoPendiente: number | undefined;
    let saldoDebitado: number | undefined;
    dbgSupabaseTbl('clientes', 'select saldos', { id: clienteUuid });
    const { data: cli, error: eCliSel } = await supabase
      .from('clientes')
      .select('saldo_pendiente, saldo_debitado, saldo')
      .eq('id', clienteUuid)
      .maybeSingle();

    if (eCliSel) {
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'cobro_clientes_select_fallido',
        mensaje_error: String((eCliSel as { message?: string })?.message ?? eCliSel).slice(0, 2000),
        datos_enviados: { cliente_id: clienteUuid, pago_id: pagoId },
        actor: null,
      });
    } else if (cli != null && typeof cli === 'object') {
      const c = cli as Record<string, unknown>;
      const baseSP = redondearPesos(Number(c.saldo_pendiente ?? 0));
      const baseSD = redondearPesos(Number(c.saldo_debitado ?? 0));
      const baseSal = redondearPesos(Number(c.saldo ?? 0));
      const sp = intPgSaldo(baseSP - montoRound);
      const sd = intPgSaldo(baseSD + montoRound);
      const sal = intPgSaldo(baseSal - montoRound);

      const patchNumerico = {
        saldo_pendiente: sp,
        saldo_debitado: sd,
        saldo: sal,
      };
      const patchCompleto = {
        ...patchNumerico,
        ultimo_monto_recibido: montoRound,
        ultima_visita: hoy(),
      } as Record<string, unknown>;

      dbgSupabaseTbl('clientes', 'update (completo)', { id: clienteUuid, patch: patchCompleto });
      let { data: cli2, error: eCliUp } = await supabase
        .from('clientes')
        .update(patchCompleto as any)
        .eq('id', clienteUuid)
        .select('saldo_pendiente, saldo_debitado')
        .maybeSingle();

      if (eCliUp) {
        dbgSupabaseTbl('clientes', 'update (solo montos)', { id: clienteUuid, patch: patchNumerico });
        const r2 = await supabase
          .from('clientes')
          .update(patchNumerico as any)
          .eq('id', clienteUuid)
          .select('saldo_pendiente, saldo_debitado')
          .maybeSingle();
        cli2 = r2.data;
        eCliUp = r2.error;
      }

      if (eCliUp) {
        void insertarLogAuditoriaSupabase({
          tipo: 'cobro',
          contexto: 'cobro_clientes_update_fallido',
          mensaje_error: String((eCliUp as { message?: string })?.message ?? eCliUp).slice(0, 2000),
          datos_enviados: {
            cliente_id: clienteUuid,
            pago_id: pagoId,
            patchIntentado: patchCompleto,
            code: (eCliUp as { code?: string })?.code,
          },
          actor: null,
        });
      } else if (cli2 != null && typeof cli2 === 'object') {
        const c2 = cli2 as Record<string, unknown>;
        saldoPendiente = intPgSaldo(Number(c2.saldo_pendiente ?? 0));
        saldoDebitado = intPgSaldo(Number(c2.saldo_debitado ?? 0));
      }
    }

    dbgSupabaseTbl('caja', 'insert', { cliente_id: clienteUuid, ficha_id: creditoUuid, pago_id: pagoId });
    const { error: eCaja } = await supabase.from('caja').insert([{
      tipo: 'entrada',
      monto: montoRound,
      descripcion: 'Cobranza directa',
      cobrador_id: rowInsert.cobrador_id,
      cliente_id: clienteUuid,
      ficha_id: creditoUuid,
      pago_id: pagoId,
    } as any]);
    if (eCaja) {
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'cobro_caja_insert_fallido',
        mensaje_error: String((eCaja as { message?: string })?.message ?? eCaja).slice(0, 2000),
        datos_enviados: {
          cliente_id: clienteUuid,
          ficha_id: creditoUuid,
          pago_id: pagoId,
          monto: montoRound,
          code: (eCaja as { code?: string })?.code,
        },
        actor: null,
      });
      devWarn('Caja no insertada (cobro ya en pagos):', eCaja);
    }

    return {
      ok: true,
      data: {
        pago_id: pagoId,
        cuota_actualizada: cuotaActualizada,
        saldo_pendiente: saldoPendiente ?? null,
        saldo_debitado: saldoDebitado ?? null,
        modo_fallback_simple: true,
      },
    };
  }

  dbgSupabaseTbl('clientes', 'select saldos_post_no_pago', { id: clienteUuid });
  const { data: cliRest, error: eCliR } = await supabase
    .from('clientes')
    .select('saldo_pendiente, saldo_debitado')
    .eq('id', clienteUuid)
    .maybeSingle();
  if (eCliR) {
    void insertarLogAuditoriaSupabase({
      tipo: 'cobro',
      contexto: 'cobro_clientes_select_fallido_post_nopago',
      mensaje_error: String((eCliR as { message?: string })?.message ?? eCliR).slice(0, 2000),
      datos_enviados: { cliente_id: clienteUuid },
      actor: null,
    });
  }
  let spR: number | null = null;
  let sdR: number | null = null;
  if (!eCliR && cliRest != null && typeof cliRest === 'object') {
    const cr = cliRest as Record<string, unknown>;
    spR = intPgSaldo(Number(cr.saldo_pendiente ?? 0));
    sdR = intPgSaldo(Number(cr.saldo_debitado ?? 0));
  }

  return {
    ok: true,
    data: {
      pago_id: pagoId,
      cuota_actualizada: false,
      saldo_pendiente: spR,
      saldo_debitado: sdR,
      modo_fallback_simple: true,
    },
  };
}

async function registrarCobranzaDirectaConReintentos(
  params: ParamsRegistroCobranzaDirectaSupabase,
  maxIntentos = 3,
): Promise<{ ok: true; data: CobranzaAtomicaRow } | { ok: false; error: unknown }> {
  let lastErr: unknown;
  for (let i = 0; i < maxIntentos; i++) {
    const r = await registrarCobranzaDirectaSupabase(params);
    if (r.ok) return r;
    lastErr = r.error;
    if (esErrorSesionSupabase(r.error)) return { ok: false, error: r.error };
    if (i < maxIntentos - 1) await new Promise(rT => setTimeout(rT, 450 * (i + 1)));
  }
  return { ok: false, error: lastErr };
}

function errorColumnaCreditoFaltante(err: unknown): string | null {
  const msg = String((err as { message?: string })?.message ?? '');
  const m = msg.match(/Could not find the '([^']+)' column of 'creditos'/i);
  return m?.[1] ?? null;
}

function filaCreditoSinColumna(row: Record<string, unknown>, col: string): Record<string, unknown> {
  const { [col]: _omit, ...rest } = row;
  return rest;
}

async function insertarCreditoConReintentos(
  row: Record<string, unknown>,
  maxIntentos = 3,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: unknown }> {
  let lastErr: unknown;
  let fila = { ...row };
  for (let i = 0; i < maxIntentos; i++) {
    const { data, error } = await supabase.from('creditos').insert([fila as any]).select('*').single();
    const id = String((data as Record<string, unknown> | null)?.id ?? '').trim();
    if (!error && esUuidClienteId(id)) return { ok: true, data: data as Record<string, unknown> };
    const colFalta = errorColumnaCreditoFaltante(error);
    if (colFalta && fila[colFalta] !== undefined) {
      fila = filaCreditoSinColumna(fila, colFalta);
      lastErr = error;
      continue;
    }
    lastErr = error ?? new Error('Respuesta sin id de crédito');
    if (esErrorSesionSupabase(error)) return { ok: false, error };
    if (i < maxIntentos - 1) await new Promise(r => setTimeout(r, 450 * (i + 1)));
  }
  return { ok: false, error: lastErr };
}

async function actualizarCreditoEstadoConReintentos(
  idCredito: string,
  cambios: Record<string, unknown>,
  maxIntentos = 3,
): Promise<{ ok: true; data: Record<string, unknown> | null } | { ok: false; error: unknown }> {
  let lastErr: unknown;
  for (let i = 0; i < maxIntentos; i++) {
    const { data, error } = await supabase.from('creditos').update(cambios as any).eq('id', idCredito).select('*').single();
    if (!error) {
      const id = String((data as Record<string, unknown> | null)?.id ?? '').trim();
      if (esUuidClienteId(id)) return { ok: true, data: data as Record<string, unknown> };
      const { data: row2, error: e2 } = await supabase.from('creditos').select('*').eq('id', idCredito).maybeSingle();
      const id2 = String((row2 as Record<string, unknown> | null)?.id ?? '').trim();
      if (!e2 && esUuidClienteId(id2)) return { ok: true, data: row2 as Record<string, unknown> };
    }
    lastErr = error ?? new Error('Respuesta nula al actualizar crédito');
    if (esErrorSesionSupabase(error)) return { ok: false, error };
    if (i < maxIntentos - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  return { ok: false, error: lastErr };
}

type OpcionesGuardarCliente = { dniFiles?: { frente?: File; dorso?: File }; videoNegocio?: File };

const BUCKET_VIDEO_VERIFICACION_CLIENTE = 'clientes-videos-verificacion';
const BUCKETS_ENTREGA_STORAGE = ['clientes-documentos', BUCKET_VIDEO_VERIFICACION_CLIENTE] as const;

/** Vacía buckets de documentos/videos (Storage API; no se puede borrar por SQL en Supabase). */
async function vaciarBucketStorageRecursivo(bucket: string, prefijo = ''): Promise<number> {
  let eliminados = 0;
  const { data, error } = await supabase.storage.from(bucket).list(prefijo, { limit: 1000 });
  if (error) throw error;
  if (!data?.length) return 0;
  const rutasArchivo: string[] = [];
  for (const item of data) {
    const ruta = prefijo ? `${prefijo}/${item.name}` : item.name;
    if (item.metadata != null) {
      rutasArchivo.push(ruta);
    } else {
      eliminados += await vaciarBucketStorageRecursivo(bucket, ruta);
    }
  }
  if (rutasArchivo.length > 0) {
    const { error: errRm } = await supabase.storage.from(bucket).remove(rutasArchivo);
    if (errRm) throw errRm;
    eliminados += rutasArchivo.length;
  }
  return eliminados;
}

async function limpiarStorageEntregaDotCom(): Promise<{ total: number; detalle: Record<string, number> }> {
  const detalle: Record<string, number> = {};
  let total = 0;
  for (const bucket of BUCKETS_ENTREGA_STORAGE) {
    try {
      const n = await vaciarBucketStorageRecursivo(bucket);
      detalle[bucket] = n;
      total += n;
    } catch (e) {
      devWarn(`limpiarStorage bucket ${bucket}:`, e);
      detalle[bucket] = 0;
    }
  }
  return { total, detalle };
}

const DIAS_RETENCION_VIDEO_CLIENTE = 30;
const MAX_DURACION_VIDEO_CLIENTE_SEG = 30;
const MAX_BYTES_VIDEO_CLIENTE = 25 * 1024 * 1024;

class ErrorSubidaVideoCliente extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorSubidaVideoCliente';
  }
}

async function obtenerDuracionVideoSegundos(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la duración del video.'));
    };
    video.src = url;
  });
}

function videoVerificacionClienteVigente(cliente: Partial<Cliente> | null | undefined): boolean {
  const url = String(cliente?.videoVerificacionUrl || '').trim();
  if (!url) return false;
  const exp = cliente?.videoVerificacionExpiraAt;
  if (!exp) return true;
  return new Date(String(exp)).getTime() >= Date.now();
}

/** Plan de vencimientos impreso en el dorso de la ficha / PDF. */
type PlanPago = 'Diario' | 'Quincenal' | 'Mensual';
interface Ficha {
  id: string; clienteId: string; tipo: 'venta' | 'prestamo';
  nro_ficha?: string;
  montoTotal: number; precioVenta: number; costo: number; ganancia: number;
  saldo: number; cuotas: number; cuotasPagas: number; cuotaMonto: number;
  total_pagado?: number;
  producto?: string;
  fecha_inicio?: string;
  fecha: string; estado: 'pendiente' | 'activa' | 'cancelada' | 'vencida';
  plan_pago?: PlanPago;
  pagos: { fecha: string; monto: number; dia: number; tipo: 'completo' | 'parcial' | 'mora'; observaciones?: string }[];
  Mora: number; moraPorciento: number;
}
interface Gasto { id: string; fecha: string; categoria: string; monto: number; nota: string; userId: string; sync: boolean; timestamp: number; }
interface MovimientoCaja {
  id: string;
  createdAt: string;
  tipo: 'entrada' | 'salida';
  monto: number;
  descripcion: string;
  cobradorId: string;
  clienteId?: string | null;
  fichaId?: string | null;
  pagoId?: string | null;
}
type FilaMovimientoControl = {
  id: string;
  ts: number;
  tipo: 'entrada' | 'salida';
  monto: number;
  descripcion: string;
  cobradorId: string;
  origen: 'caja' | 'pago' | 'gasto' | 'credito';
};
interface Cierre {
  id: string;
  fecha: string;
  userId: string;
  username: string;
  totalSistema: number;
  /** Gastos operativos declarados en la jornada (cobrador). */
  totalGastos?: number;
  /** Total cobrado − gastos; efectivo teórico a entregar. */
  netoEntregar?: number;
  montoFisico: number;
  diferencia: number;
  kmFin?: number;
  novedades: string;
  validado: boolean;
  validadoAt?: string;
  validadoPor?: string;
  /** Monto que ingresa a caja central al aceptar la rendición. */
  ingresoCajaCentral?: number;
  sync: boolean;
  timestamp: number;
  lat?: number;
  lng?: number;
}
interface LogEntry { id: string; fecha: string; hora: string; accion: string; usuario: string; detalle: string; }
type LogAuditoriaRemoto = {
  id: number;
  created_at: string;
  tipo: 'cobro' | 'credito' | string;
  contexto: string;
  mensaje_error: string | null;
  actor: string | null;
  datos_enviados: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
};
interface Config {
  moneda: string; simboloMoneda: string; moraPorciento: number; nombreEmpresa: string; telefonoEmpresa: string; direccionEmpresa: string; ruc: string; numeroWhatsappAdmin: string; interesCreditoM: number; interesCreditoP: number;
  porcentajeComisionVendedor: number;
  modoExterior: boolean;
  trialFin?: string | null;
  cierreCajaMarcosAt?: string | null;
}
interface VisitaFallida { clienteId: string; fecha: string; hora: string; motivo: 'no_domicilio' | 'sin_dinero' | 'promesa_pago' | 'local_cerrado'; lat: number; lng: number; observaciones?: string; promesaFecha?: string; }
interface Credito {
  id: string;
  nro_carton?: string;
  cliente_id: string;
  usuario_id?: string | null;
  creado_por?: string | null;
  tipo?: 'M' | 'P';
  monto_solicitado: number;
  monto_total?: number;
  detalle_mercaderia: string | null;
  fecha_inicio: string;
  cuotas?: number;
  /** Columna real en BD; valores típicos: Diario, Semanal, Mensual. */
  plan?: string;
  cobrador_id?: string | null;
  /** Derivado en app desde `plan` (no se persiste en Supabase). */
  plazo_unidad?: 'Días' | 'Semanas' | 'Meses' | string;
  plazo_cantidad: number;
  total_con_interes: number;
  estado: 'PENDIENTE' | 'PENDIENTE_APROBACION' | 'ACTIVO' | 'VIGENTE' | 'APROBADO' | 'RECHAZADO' | 'FINALIZADO';
  interes_aplicado: number;
  created_at?: string;
  /** Referencia administrativa; cuotas en ruta desde día siguiente a la aprobación (A_FECHA). */
  inicio_cuotas_modo?: 'A_FECHA' | 'POST_FECHA' | string;
  fecha_inicio_cuotas_post?: string | null;
  cobrador_notif_email?: string | null;
  /** Auditoría: solicitud con fecha pasada (admin/root). */
  es_retroactivo?: boolean;
  /** UUID/auth del vendedor que originó la venta (rol vendedor). */
  vendedor_id?: string | null;
  /** Comisión generada al aprobar el crédito. */
  comision_vendedor?: number;
  comision_liquidada?: boolean;
  /** Admin autorizó la comisión para que el vendedor la vea en «a cobrar». */
  comision_aprobada_admin?: boolean;
  porcentaje_comision_credito?: number;
}
interface VendedorComisionResumen {
  id: string;
  username: string;
  comision_acumulada: number;
  creditos_pendientes: number;
  porcentaje_comision: number;
  total_pendiente_aprobacion: number;
  ventas_pendientes_aprobacion: Credito[];
  ventas_aprobadas_pendientes: Credito[];
}
interface PagoRegistro {
  id: string;
  clienteId: string;
  /** Id de crédito/ficha (uuid en BD). En insert/select usar `fichaIdUuid` para minúsculas. */
  fichaId?: string | null;
  fecha: string;
  monto: number;
  dia: number;
  tipo: string;
  observaciones?: string;
  lat?: number | null;
  lng?: number | null;
  userId?: string | null;
  cobradorId?: string | null;
  fechaPago?: string;
  /** Registro automático $0 cierre de día; no reduce saldo ni cuenta como cuota cobrada. */
  esRegistroNoPago?: boolean;
  cuotaNumero?: number | null;
}

/** Pago que reduce saldo: monto positivo y no es registro automático (`pagos.es_registro_no_pago`). */
function esPagoEfectivo(p: PagoRegistro): boolean {
  if (p.esRegistroNoPago === true) return false;
  return redondearPesos(Number(p.monto) || 0) > 0;
}

/** Heurística sobre observaciones (no hay columna dedicada en BD): transferencias vs efectivo en mano. */
function esPagoTransferenciaPorObservaciones(p: PagoRegistro): boolean {
  const o = String(p.observaciones || '').toLowerCase();
  return /\b(transfer|transferencia|transf\.?|cbu|cvu|alias|mercado\s*pago|^mp\b|deposito|depósito|banco virtual)\b/i.test(o);
}

function pagosEfectivosCredito(pagos: PagoRegistro[], creditoId: string): PagoRegistro[] {
  const fid = fichaIdUuid(creditoId);
  return [...pagos]
    .filter(p => fichaIdUuid(p.fichaId) === fid && esPagoEfectivo(p))
    .sort((a, b) => String(a.fechaPago || a.fecha || '').localeCompare(String(b.fechaPago || b.fecha || '')));
}

/** Cuota actual, faltante y progreso según monto acumulado (admite parciales y adelantos). */
function contextoCobroCredito(credito: Credito, pagos: PagoRegistro[]) {
  const planilla = generarPlanillaCredito(credito);
  const montoTotal = redondearPesos(Number(credito.monto_total ?? credito.total_con_interes) || 0);
  const totalPagado = redondearPesos(
    pagosEfectivosCredito(pagos, credito.id).reduce((s, p) => s + redondearPesos(Number(p.monto) || 0), 0),
  );
  let acum = 0;
  let cuotasCompletas = 0;
  let cuotaActualNro: number | null = null;
  let montoCuotaActual = 0;
  let montoFaltanteCuotaActual = 0;
  for (const cuo of planilla) {
    const montoCuo = redondearPesos(Number(cuo.monto) || 0);
    if (totalPagado >= acum + montoCuo) {
      acum += montoCuo;
      cuotasCompletas += 1;
    } else {
      cuotaActualNro = cuo.nro;
      montoCuotaActual = montoCuo;
      montoFaltanteCuotaActual = redondearPesos(acum + montoCuo - totalPagado);
      break;
    }
  }
  const creditoFinalizado = cuotasCompletas >= planilla.length || totalPagado >= montoTotal;
  if (!creditoFinalizado && cuotaActualNro == null && planilla.length > 0) {
    const next = planilla[cuotasCompletas];
    if (next) {
      cuotaActualNro = next.nro;
      montoCuotaActual = redondearPesos(Number(next.monto) || 0);
      montoFaltanteCuotaActual = montoCuotaActual;
    }
  }
  return {
    totalPagado,
    planilla,
    cuotasCompletas,
    cuotaActualNro,
    montoCuotaActual,
    montoFaltanteCuotaActual: creditoFinalizado ? 0 : montoFaltanteCuotaActual,
    saldoCredito: Math.max(0, montoTotal - totalPagado),
    creditoFinalizado,
  };
}

type FilaRecaudacionCampo = {
  cobrador: string;
  cobrado: number;
  gastos: number;
  neto: number;
  cantCobros: number;
  cantGastos: number;
};

function calcularRecaudacionCampoHoy(
  pagos: PagoRegistro[],
  gastosList: Gasto[],
  fecha = hoy(),
): {
  ingresosCampoHoy: number;
  egresosCampoHoy: number;
  cobradoAcumuladoCampo: number;
  porUsuarioCampo: FilaRecaudacionCampo[];
} {
  const pagosCampoHoy = pagos.filter(p => {
    const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
    return (
      fd === fecha
      && esPagoEfectivo(p)
      && redondearPesos(Number(p.monto) || 0) > 0
      && esMovimientoUsuarioCampo(p.cobradorId ?? p.userId)
    );
  });
  const gastosCampoHoy = gastosList.filter(
    g =>
      g
      && String(g.fecha || '').slice(0, 10) === fecha
      && esMovimientoUsuarioCampo(g.userId),
  );
  const ingresosCampoHoy = redondearPesos(
    pagosCampoHoy.reduce((s, p) => s + (Number(p.monto) || 0), 0),
  );
  const egresosCampoHoy = redondearPesos(
    gastosCampoHoy.reduce((s, g) => s + (Number(g.monto) || 0), 0),
  );
  const porUsuarioCampo = new Map<string, FilaRecaudacionCampo>();
  const touchCampo = (rawId: string) => {
    const cobrador = String(rawId || 'sin_usuario').trim() || 'sin_usuario';
    const actual = porUsuarioCampo.get(cobrador) || {
      cobrador,
      cobrado: 0,
      gastos: 0,
      neto: 0,
      cantCobros: 0,
      cantGastos: 0,
    };
    porUsuarioCampo.set(cobrador, actual);
    return actual;
  };
  pagosCampoHoy.forEach(p => {
    const item = touchCampo(String(p.cobradorId ?? p.userId ?? 'sin_usuario'));
    item.cobrado += redondearPesos(Number(p.monto) || 0);
    item.cantCobros += 1;
  });
  gastosCampoHoy.forEach(g => {
    const item = touchCampo(String(g.userId || 'sin_usuario'));
    item.gastos += redondearPesos(Number(g.monto) || 0);
    item.cantGastos += 1;
  });
  porUsuarioCampo.forEach(item => {
    item.neto = redondearPesos(item.cobrado - item.gastos);
  });
  return {
    ingresosCampoHoy,
    egresosCampoHoy,
    cobradoAcumuladoCampo: redondearPesos(ingresosCampoHoy - egresosCampoHoy),
    porUsuarioCampo: Array.from(porUsuarioCampo.values()).sort((a, b) => b.neto - a.neto),
  };
}

/** Marca cuotas pagadas/pendientes según el monto acumulado real en `pagos`. */
async function aplicarEstadoCuotasSegunPagosCredito(creditoUuid: string): Promise<boolean> {
  const { data: cuotasDb, error: eCuotas } = await supabase
    .from('cuotas')
    .select('nro_cuota, monto')
    .eq('credito_id', creditoUuid)
    .order('nro_cuota', { ascending: true });
  if (eCuotas || !Array.isArray(cuotasDb) || cuotasDb.length === 0) return false;
  const { data: pagosDb, error: ePagos } = await supabase
    .from('pagos')
    .select('monto')
    .eq('ficha_id', creditoUuid)
    .eq('es_registro_no_pago', false);
  if (ePagos) return false;
  const totalPagado = redondearPesos(
    (pagosDb ?? []).reduce((s, p) => s + redondearPesos(Number((p as { monto?: number }).monto) || 0), 0),
  );
  let acum = 0;
  const nowIso = new Date().toISOString();
  let algunaActualizada = false;
  for (const row of cuotasDb) {
    const nro = Math.max(1, Math.round(Number((row as { nro_cuota?: number }).nro_cuota) || 1));
    const montoCuo = redondearPesos(Number((row as { monto?: number }).monto) || 0);
    const pagada = totalPagado >= acum + montoCuo;
    acum += montoCuo;
    const patchPagada = {
      estado: 'pagado',
      pagado_at: nowIso,
      updated_at: nowIso,
    };
    const patchPendiente = {
      estado: 'pendiente',
      pago_id: null,
      pagado_at: null,
      updated_at: nowIso,
    };
    const { data: up, error: eUp } = await supabase
      .from('cuotas')
      .update((pagada ? patchPagada : patchPendiente) as any)
      .eq('credito_id', creditoUuid)
      .eq('nro_cuota', nro)
      .select('id');
    if (!eUp && Array.isArray(up) && up.length > 0) algunaActualizada = true;
  }
  return algunaActualizada;
}

/** Días corridos desde el vencimiento de la primera cuota aún impaga (0 si la próxima cuota es futura). */
function diasSinPagoDesdePrimeraCuotaImpaga(credito: Credito, pagos: PagoRegistro[]): number {
  const planilla = generarPlanillaCredito(credito);
  const ctx = contextoCobroCredito(credito, pagos);
  const pend = planilla[ctx.cuotasCompletas];
  if (!pend) return 0;
  const vto = String(pend.vencimiento).slice(0, 10);
  if (vto > hoy()) return 0;
  return Math.max(0, diffDias(hoy(), vto));
}

function ordenHistorialCartonCronologico(credito: Credito, pagos: PagoRegistro[]): PagoRegistro[] {
  const fid = fichaIdUuid(credito.id);
  return [...pagos]
    .filter(p => fichaIdUuid(p.fichaId) === fid)
    .sort((a, b) => String(a.fechaPago || a.fecha || '').localeCompare(String(b.fechaPago || b.fecha || '')));
}
interface ComprobantePagoImagen {
  cliente: Cliente;
  ficha: Ficha;
  monto: number;
  saldoRestante: number;
  fechaPago: string;
  cobradorId: string;
}
interface CartonSharePayload {
  credito: Credito;
  cliente: Cliente;
  nroCarton: string;
}
interface CuotaPlanilla {
  nro: number;
  vencimiento: string;
  monto: number;
  saldo: number;
  vencida?: boolean;
  pagada?: boolean;
  /** Solo plan Diario: vencimiento cae en domingo (mostrar tachado en UI/PDF). */
  esDomingo?: boolean;
}
interface EstadoCuentaPagoRow {
  fecha: string;
  cobrador: string;
  montoCobrado: number;
  saldoRestante: number;
}
interface Notificacion {
  id: string;
  titulo: string;
  mensaje: string;
  destinatario_rol?: string | null;
  destinatario_usuario?: string | null;
  leido: boolean;
  accion?: string | null;
  created_at?: string;
}

/** Admin que autoriza ingresos en caja para créditos sin recaudado previo. */
const EMAIL_ADMIN_MARCOS_CAJA = 'emamoreno7@hotmail.com';

/** Identificador lógico de la caja propia de Marcos (no es un usuario de campo). */
interface MovimientoCajaPropia {
  id: string;
  createdAt: string;
  fecha: string;
  tipo: 'entrada' | 'salida';
  monto: number;
  descripcion: string;
  nota: string | null;
  registradoPor: string | null;
  solicitudFondoId: string | null;
  cajaReferenciaId: string | null;
  rendicionId: string | null;
}

interface SolicitudFondoCredito {
  id: string;
  created_at: string;
  credito_id: string;
  cliente_id: string;
  cobrador_id: string;
  solicitante_email: string | null;
  solicitante_nombre: string | null;
  monto: number;
  estado: 'pendiente' | 'fondado' | 'cancelado';
  fondado_at: string | null;
}

/** Metadatos guardados en cp_data_v2 (clientes/fichas/gastos van aparte en cp_cli, cp_fic, cp_gas). */
interface AppMeta {
  cierres: Cierre[];
  logs: LogEntry[];
  config: Config;
  cierresJornada: Cierre[];
  visitasFallidas: VisitaFallida[];
}

// ==========================================
// UTILIDADES
// ==========================================
const genId = () => `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
/** Identidad fija DotCom (tickets, WA automáticos, login/nav). `nombreEmpresa` en config sigue personalizable para textos al cliente. */
const MARCA_PRIMARIA = 'DotCom';
const MARCA_DESCRIPTOR = 'Sistema de Gestión';
const MARCA_COMPLETA = `${MARCA_PRIMARIA} ${MARCA_DESCRIPTOR}`;
const M: Config = { ...CONFIG_DEFECTO, nombreEmpresa: MARCA_COMPLETA };
const PLAN_SEMANAL_OPCIONES = [4, 6, 8, 10, 12, 17, 44];
const PLAN_DIARIO_OPCIONES = [26, 39, 52, 65, 78, 117, 286];
/** Cuotas mensuales ofrecidas en el módulo mensual (sin 7 ni 9 meses). */
const PLAN_MENSUAL_OPCIONES = [1, 2, 3, 4, 5, 6, 8, 10, 12];
const LS_AJUSTE_TASA_MENSUAL_PCT = 'cp_ajuste_tasa_mensual_pct';
const LS_TASAS_MENSUAL_PERSONALIZADAS = 'cp_tasas_mensual_por_mes';
/** Tasa por defecto (%) según cantidad de meses (mes correlativo). */
const TASA_INTERES_MENSUAL_DEFECTO_POR_MES: Record<number, number> = {
  1: 30,
  2: 45,
  3: 70,
  4: 90,
  5: 110,
  6: 135,
  7: 175,
  8: 175,
  10: 195,
  12: 210,
};

type ConfigTasasMensual = {
  ajusteGlobalPct: number;
  tasasPersonalizadas: Record<number, number>;
};

const CONFIG_TASAS_MENSUAL_VACIO: ConfigTasasMensual = { ajusteGlobalPct: 0, tasasPersonalizadas: {} };

function leerAjusteTasaMensualPct(): number {
  try {
    const v = localStorage.getItem(LS_AJUSTE_TASA_MENSUAL_PCT);
    const n = parseFloat(v ?? '0');
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function leerTasasPersonalizadasMensual(): Record<number, number> {
  try {
    const raw = localStorage.getItem(LS_TASAS_MENSUAL_PERSONALIZADAS);
    if (!raw) return {};
    const obj = JSON.parse(raw) as Record<string, number>;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      const meses = Number(k);
      const pct = Number(v);
      if (Number.isFinite(meses) && meses > 0 && Number.isFinite(pct) && pct >= 0) out[meses] = Math.round(pct);
    }
    return out;
  } catch {
    return {};
  }
}

function leerConfigTasasMensual(): ConfigTasasMensual {
  return {
    ajusteGlobalPct: leerAjusteTasaMensualPct(),
    tasasPersonalizadas: leerTasasPersonalizadasMensual(),
  };
}

function guardarConfigTasasMensual(config: ConfigTasasMensual): void {
  localStorage.setItem(LS_AJUSTE_TASA_MENSUAL_PCT, String(config.ajusteGlobalPct));
  localStorage.setItem(LS_TASAS_MENSUAL_PERSONALIZADAS, JSON.stringify(config.tasasPersonalizadas));
}

function tasaDefectoMensualPorMeses(meses: number): number {
  return TASA_INTERES_MENSUAL_DEFECTO_POR_MES[meses] ?? TASA_INTERES_MENSUAL_DEFECTO_POR_MES[1] ?? 30;
}

function tasaBaseMensualPorMeses(meses: number, tasasPersonalizadas: Record<number, number>): number {
  if (tasasPersonalizadas[meses] != null) return tasasPersonalizadas[meses];
  return tasaDefectoMensualPorMeses(meses);
}

function tasaInteresMensualPorMeses(meses: number, config: ConfigTasasMensual = CONFIG_TASAS_MENSUAL_VACIO): number {
  const base = tasaBaseMensualPorMeses(meses, config.tasasPersonalizadas);
  return Math.max(0, Math.round(base + config.ajusteGlobalPct));
}

function listadoPlanMensualPlazoTasa(config: ConfigTasasMensual = CONFIG_TASAS_MENSUAL_VACIO): Array<{ meses: number; tasaPct: number }> {
  return PLAN_MENSUAL_OPCIONES.map(meses => ({
    meses,
    tasaPct: tasaInteresMensualPorMeses(meses, config),
  }));
}

function cantidadTasasMensualPersonalizadas(config: ConfigTasasMensual): number {
  return Object.keys(config.tasasPersonalizadas).length;
}
const AMBITO_DATOS_PRINCIPAL = 'principal';
const AMBITO_DATOS_MENSUAL = 'mensual';
const PAGINAS_MODULO_MENSUAL = new Set([
  'dashboard', 'clientes', 'creditos', 'ruta', 'simulador_mensual', 'recibos_mensuales', 'cheques',
]);

function opcionesCantidadPlazoCredito(plazoUnidad: 'Días' | 'Semanas' | 'Meses'): number[] {
  if (plazoUnidad === 'Días') return PLAN_DIARIO_OPCIONES;
  if (plazoUnidad === 'Meses') return PLAN_MENSUAL_OPCIONES;
  return PLAN_SEMANAL_OPCIONES;
}

function redondearPesos(n: number): number {
  return Math.round(Number(n) || 0);
}

/** Reparte `total` en `n` cuotas enteras que suman exactamente el total redondeado; la última cuota absorbe la diferencia. */
function distribuirMontoEnCuotas(totalBruto: number, cantidad: number): number[] {
  const n = Math.max(1, Math.floor(Number(cantidad) || 1));
  const total = redondearPesos(totalBruto);
  if (total <= 0) return Array.from({ length: n }, () => 0);
  if (n === 1) return [total];
  const porCuota = Math.round(total / n);
  const montos = Array.from({ length: n }, () => porCuota);
  const suma = porCuota * n;
  montos[n - 1] = redondearPesos(montos[n - 1] + (total - suma));
  return montos;
}

/** Monto típico de cuota (primera fila del plan) para mostrar en cartón / fichas. */
function montoCuotaCreditoDesdeTotal(totalCredito: number, cantCuotas: number): number {
  const dist = distribuirMontoEnCuotas(totalCredito, cantCuotas);
  return dist[0] ?? 0;
}

/** Todos los identificadores de la sesión (UUID, email, login, usernameBd, alias). */
function idsEmparejamientoCobradorSesion(
  authId: string | null | undefined,
  username: string | null | undefined,
  email: string | null | undefined,
): Set<string> {
  const perfil = resolverPerfilDesdeAuthEmail(email) || resolverPerfilDesdeEntradaLogin(username);
  const raw = [
    ...cobradorIdsParaFiltroSesion({
      user: { id: authId ?? undefined, email: email ?? undefined },
    }),
    ...idsReferenciaPerfil(perfil),
    String(username ?? '').trim(),
    String(email ?? '').trim(),
    perfil?.login,
    perfil?.usernameBd,
    perfil?.authEmail,
  ];
  const set = new Set<string>();
  for (const r of raw) {
    const t = String(r ?? '').trim();
    if (!t) continue;
    set.add(t);
    set.add(t.toLowerCase());
    const canon = ALIAS_LOGIN_USUARIO[t.toLowerCase()] ?? t.toLowerCase();
    set.add(canon);
  }
  return set;
}

function cobradorIdCoincideConSesion(
  rawCobradorId: string | null | undefined,
  authId: string | null,
  username: string | null,
  email: string | null,
): boolean {
  const cid = String(rawCobradorId ?? '').trim();
  if (!cid) return false;
  const set = idsEmparejamientoCobradorSesion(authId, username, email);
  const variants = new Set<string>([
    cid,
    cid.toLowerCase(),
    ALIAS_LOGIN_USUARIO[cid.toLowerCase()] ?? cid.toLowerCase(),
  ]);
  if (cid.includes('@')) variants.add(normalizarEmail(cid));
  for (const v of variants) {
    if (set.has(v) || set.has(v.toLowerCase())) return true;
  }
  return false;
}

function esRegistroDelCobrador(
  p: { cobradorId?: string | null; userId?: string | null },
  authId: string | null,
  username: string | null,
  email: string | null,
) {
  return cobradorIdCoincideConSesion(p.cobradorId ?? p.userId, authId, username, email);
}

function esGastoDelCobrador(g: Gasto, authId: string | null, username: string | null, email: string | null) {
  return cobradorIdCoincideConSesion(g.userId, authId, username, email);
}

/** ID estable para guardar en pagos/gastos (prioriza UUID de auth). */
function cobradorIdCanonicoDesdeSesionActiva(
  authUserId: string | null | undefined,
  username: string | null | undefined,
  loginEmail: string | null | undefined,
): string {
  const ids = cobradorIdsParaFiltroSesion({
    user: { id: authUserId ?? undefined, email: loginEmail ?? undefined },
  });
  const uuid = ids.find(x => esUuidClienteId(x));
  if (uuid) return String(uuid).trim();
  const perfil = resolverPerfilDesdeAuthEmail(loginEmail) || resolverPerfilDesdeEntradaLogin(username);
  if (perfil?.login) return perfil.login;
  return String(username || loginEmail || authUserId || 'sin_usuario').trim();
}

/** Marcos / admin: no cuenta en recaudación en vivo de campo. */
function esReferenciaMarcosOAdmin(rawId: string | null | undefined): boolean {
  const cid = String(rawId ?? '').trim();
  if (!cid) return false;
  const lower = cid.toLowerCase();
  if (['marcos', 'emamoreno7', 'marcosp', 'root', 'admin', 'prueba'].includes(lower)) return true;
  const email = normalizarEmail(lower);
  if (['emamoreno7@hotmail.com', 'root@emd.com', 'prueba@emd.com'].includes(email)) return true;
  const mapped = MAPA_USUARIO_POR_ID[lower];
  if (mapped) {
    const r = (mapped.rol || '').toLowerCase();
    if (r === 'admin' || r === 'root' || r === 'super') return true;
  }
  const canon = ALIAS_LOGIN_USUARIO[lower] ?? lower;
  return canon === 'marcos' || canon === 'root';
}

/** Cobrador / vendedor en campo (recaudación visible para Marcos sin cierre de caja). */
function esMovimientoUsuarioCampo(rawId: string | null | undefined): boolean {
  const cid = String(rawId ?? '').trim();
  if (!cid || cid === 'sin_usuario' || cid === 'sistema') return false;
  if (esReferenciaMarcosOAdmin(cid)) return false;
  const lower = cid.toLowerCase();
  const canon = ALIAS_LOGIN_USUARIO[lower] ?? lower;
  if (canon === 'matias' || canon === 'vendedor' || canon === 'cobrador1' || canon === 'cobrador2') return true;
  const perfilEmail = resolverPerfilDesdeAuthEmail(cid);
  const perfilLogin = resolverPerfilDesdeEntradaLogin(cid);
  const perfil = perfilEmail || perfilLogin;
  if (perfil && (perfil.rolDefecto === 'cobrador' || perfil.rolDefecto === 'vendedor')) return true;
  const mapped = MAPA_USUARIO_POR_ID[lower];
  if (mapped) {
    const r = (mapped.rol || '').toLowerCase();
    return r === 'cobrador' || r === 'vendedor';
  }
  if (esUuidReferenciaUsuario(lower)) return true;
  if (lower.includes('@') && !lower.includes('marcos') && !lower.includes('emamoreno')) {
    const pe = resolverPerfilDesdeAuthEmail(lower);
    if (pe && (pe.rolDefecto === 'cobrador' || pe.rolDefecto === 'vendedor')) return true;
  }
  return !lower.includes('marcos') && !lower.includes('emamoreno');
}

function rendicionEsDelUsuarioActual(c: Cierre, authId: string | null, username: string | null) {
  const uid = String(c.userId || '').trim();
  if (authId && uid === authId) return true;
  if (username && uid === username) return true;
  return false;
}

function mapRowRendicionDb(r: Record<string, unknown>): Cierre {
  const created = r.created_at != null ? new Date(String(r.created_at)).getTime() : Date.now();
  return {
    id: String(r.id ?? genId()),
    fecha: String(r.fecha_jornada ?? hoy()).slice(0, 10),
    userId: String(r.cobrador_id ?? ''),
    username: String(r.cobrador_nombre ?? r.cobrador_id ?? ''),
    totalSistema: redondearPesos(Number(r.total_cobrado ?? 0)),
    totalGastos: redondearPesos(Number(r.total_gastos ?? 0)),
    netoEntregar: redondearPesos(Number(r.neto_entregar ?? 0)),
    montoFisico: redondearPesos(Number(r.monto_fisico_declarado ?? 0)),
    diferencia: redondearPesos(Number(r.diferencia ?? 0)),
    kmFin: r.km_fin != null && r.km_fin !== '' ? Number(r.km_fin) : undefined,
    novedades: String(r.novedades ?? ''),
    validado: Boolean(r.validado),
    validadoAt: r.validado_at != null ? String(r.validado_at) : undefined,
    validadoPor: r.validado_por != null ? String(r.validado_por) : undefined,
    ingresoCajaCentral: redondearPesos(Number(r.ingreso_caja_central ?? 0)),
    sync: true,
    timestamp: Number.isFinite(created) ? created : Date.now(),
    lat: r.gps_lat != null ? Number(r.gps_lat) : undefined,
    lng: r.gps_lng != null ? Number(r.gps_lng) : undefined,
  };
}

function fmt(n: number) { return `${M.simboloMoneda} ${redondearPesos(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function hoy() { return new Date().toISOString().split('T')[0]; }

async function consultarPermisoGeolocalizacion(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    if (typeof navigator === 'undefined') return 'unknown';
    const perms = navigator.permissions as { query?: (q: { name: PermissionName }) => Promise<PermissionStatus> } | undefined;
    if (!perms?.query) return 'unknown';
    const status = await perms.query({ name: 'geolocation' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unknown';
  }
}

function textoInstruccionesGPSDenegadoNavegador(): string {
  if (typeof navigator === 'undefined') return 'Activá la ubicación para este sitio en el navegador y recargá la página.';
  const ua = navigator.userAgent || '';
  const esChrome = /chrome|crios|edg/i.test(ua) && !/opr\//i.test(ua);
  const esSafari = /safari/i.test(ua) && !/chrome|crios|crwebview/i.test(ua);
  if (esChrome) {
    return 'Chrome: tocá el candado o el ícono junto a la URL → Ubicación / Sitio → Permitir. Recargá la pestaña y volvé a «Capturar GPS».';
  }
  if (esSafari) {
    return 'Safari (iPhone/iPad): Ajustes → Safari → Ubicaciones → esta web → Permitir. En Mac: Safari → Ajustes para [sitio] → Ubicación → Permitir. Recargá si hace falta.';
  }
  return 'Ubicación bloqueada: abrí los permisos del sitio (candado o menú del navegador), elegí Permitir y recargá la página.';
}

function mensajeErrorGeolocalizacion(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const geo = err as GeolocationPositionError;
    const nombres: Record<number, string> = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };
    const nombre = nombres[Number(geo.code)] ?? `code_${String(geo.code)}`;
    return `${nombre}: ${String(geo.message || '').trim() || 'sin mensaje'}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Una fila de `clientes` (Supabase) → modelo de la app (mismo criterio que `fetchData`). */
function mapClienteFilaSupabase(c: Record<string, unknown> | null | undefined): Cliente {
  const row = c && typeof c === 'object' ? c : {};
  return {
    id: String(row.id ?? '').trim(),
    nombre: String(row.nombre ?? ''),
    apellido: row.apellido != null ? String(row.apellido) : '',
    dni: row.dni != null ? String(row.dni) : '',
    fechaNacimiento: String(row.fecha_nacimiento ?? row.fechaNacimiento ?? ''),
    telefono: normalizarTelefonoArg549(String(row.telefono ?? '')),
    direccion: String(row.direccion ?? ''),
    dniFrenteUrl: String(row.dni_frente_url ?? row.dniFrenteUrl ?? ''),
    dniDorsoUrl: String(row.dni_dorso_url ?? row.dniDorsoUrl ?? ''),
    videoVerificacionUrl: String(row.video_verificacion_url ?? row.videoVerificacionUrl ?? ''),
    videoVerificacionPath: row.video_verificacion_path != null ? String(row.video_verificacion_path) : '',
    videoVerificacionSubidoAt: row.video_verificacion_subido_at != null ? String(row.video_verificacion_subido_at) : undefined,
    videoVerificacionExpiraAt: row.video_verificacion_expira_at != null ? String(row.video_verificacion_expira_at) : undefined,
    lat: row.lat != null ? Number(row.lat) : row.gps_lat != null ? Number(row.gps_lat) : undefined,
    lng: row.lng != null ? Number(row.lng) : row.gps_lng != null ? Number(row.gps_lng) : undefined,
    saldo: Number(row.saldo ?? 0),
    quota: Number(row.quota ?? 0),
    frecuencia: (row.frecuencia ?? 'semanal') as Cliente['frecuencia'],
    fechaAlta: String(row.fecha_alta ?? row.fechaalta ?? row.fechaAlta ?? hoy()),
    activo: Boolean(row.activo ?? true),
    ultimaVisita: (row.ultima_visita ?? row.ultimaVisita) as string | undefined,
    notas: row.notas != null ? String(row.notas) : '',
    promesaPago: String(row.promesa_pago ?? row.promesaPago ?? ''),
    promesaFecha: String(row.promesa_fecha ?? row.promesaFecha ?? ''),
    ultimoMontoRecibido: Number(row.ultimo_monto_recibido ?? row.ultimoMontoRecibido ?? 0),
    orden_ruta: row.orden_ruta != null && Number.isFinite(Number(row.orden_ruta)) ? Number(row.orden_ruta) : null,
    cobrador_id: row.cobrador_id != null ? String(row.cobrador_id) : row.creado_por != null ? String(row.creado_por) : null,
  };
}

/** Si un refetch aún no trae el alta (p. ej. réplica/RLS), conserva el objeto del `.select().single()` arriba de todo. */
function mergeClienteAlInicioSiFalta(list: Cliente[], row: Cliente): Cliente[] {
  const id = String(row.id || '').trim();
  if (!esUuidClienteId(id)) return list;
  if (list.some(c => c.id === id)) return list;
  return [row, ...list];
}

/** Siguiente prioridad manual de ruta para clientes del mismo cobrador (max + 1). */
function siguienteOrdenRutaCobrador(clientesLista: Cliente[], cobradorId: string): number {
  const cid = String(cobradorId || '').trim();
  const subset = cid
    ? clientesLista.filter(c => String(c.cobrador_id ?? '').trim() === cid)
    : clientesLista;
  const src = subset.length > 0 ? subset : clientesLista;
  let max = 0;
  for (const c of src) {
    const o = c.orden_ruta;
    if (o != null && Number.isFinite(Number(o))) max = Math.max(max, Math.round(Number(o)));
  }
  return max + 1;
}

function clienteTieneCreditoActivoEnRuta(clienteId: string, creditos: Credito[], pagos: PagoRegistro[]): boolean {
  const id = normalizarId(clienteId);
  for (const c of creditos) {
    if (normalizarId(c.cliente_id) !== id) continue;
    if (!esCreditoActivo(c)) continue;
    if (resumenCuotasRutaCredito(c, pagos).enRuta) return true;
  }
  return false;
}

/** Crédito ficticio solo UI: permite listar en Ruta del Día al cliente de alta hoy sin crédito ACTIVO en planilla. */
function creditoPlaceholderCaptacion(cli: Cliente): Credito {
  const h = hoy();
  const tail = normalizarId(cli.id).replace(/-/g, '').padEnd(12, '0').slice(0, 12);
  return {
    id: `00000000-0000-4000-8000-${tail}`,
    nro_carton: '',
    cliente_id: cli.id,
    monto_solicitado: 0,
    monto_total: 0,
    total_con_interes: 0,
    detalle_mercaderia: 'Alta del día (pendiente de crédito activo en ruta)',
    fecha_inicio: h,
    cuotas: 1,
    plazo_cantidad: 1,
    plan: 'Diario',
    estado: 'ACTIVO',
    interes_aplicado: 0,
  };
}

function nombreCompletoCliente(cliente?: Partial<Cliente> | null) {
  const nombre = String(cliente?.nombre || '').trim();
  const apellido = String(cliente?.apellido || '').trim();
  return `${nombre} ${apellido}`.trim() || nombre || apellido || 'Cliente';
}

function apellidoClienteFalta(cliente?: Partial<Cliente> | null) {
  return !String(cliente?.apellido ?? '').trim();
}

function AvisoApellidoIncompleto({ cliente }: { cliente?: Partial<Cliente> | null }) {
  if (!cliente || !apellidoClienteFalta(cliente)) return null;
  return (
    <p className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2 py-1.5">
      Falta el apellido: completalo en la ficha del cliente.
    </p>
  );
}

/** Comprobante / capturas: mismo criterio que la UI visible. */
function numeroFichaComprobante(ficha: Ficha) {
  const numero = String(ficha.nro_ficha || '').trim();
  if (numero) return numero.startsWith('#') ? numero : `#${numero}`;
  const corto = String(ficha.id || '').replace(/[^\w]/g, '').slice(-5).toUpperCase();
  return `#${corto || 'FICHA'}`;
}

function fechaComprobanteDDMMAAAA(fecha?: string) {
  if (!fecha) return '--/--/----';
  const soloFecha = fecha.slice(0, 10);
  const partes = soloFecha.split('-');
  if (partes.length === 3) return `${partes[2]}/${partes[1]}/${partes[0]}`;
  return new Date(fecha).toLocaleDateString('es-AR');
}

const COLOR_TEXTO_HTML2CANVAS_SEGURO = '#111827';
const COLOR_FONDO_HTML2CANVAS_SEGURO = '#ffffff';

/** Evita fallos de html2canvas con colores modernos (oklab/oklch) heredados del tema o Tailwind. */
function sanearColoresClonHtml2canvas(clonedRoot: HTMLElement) {
  const win = clonedRoot.ownerDocument?.defaultView;
  if (!win) return;
  const sospechoso = (v: string) => !!v && /oklab|oklch|lab\(|lch\(/i.test(v);
  const nodos = [clonedRoot, ...Array.from(clonedRoot.querySelectorAll<HTMLElement>('*'))];
  for (const el of nodos) {
    const cs = win.getComputedStyle(el);
    if (sospechoso(cs.color)) el.style.color = COLOR_TEXTO_HTML2CANVAS_SEGURO;
    const bg = cs.backgroundColor;
    if (sospechoso(bg)) el.style.backgroundColor = clonedRoot === el ? '#f8fafc' : COLOR_FONDO_HTML2CANVAS_SEGURO;
    if (sospechoso(cs.borderColor)) el.style.borderColor = '#e2e8f0';
  }
}

function html2canvasOpcionesSeguras(backgroundColor: string): Partial<Html2CanvasOptions> {
  return {
    backgroundColor,
    scale: 2,
    useCORS: true,
    logging: false,
    foreignObjectRendering: false,
    onclone: (clonedDoc, element) => {
      clonedDoc.documentElement.style.setProperty('color-scheme', 'light');
      if (clonedDoc.body) {
        clonedDoc.body.style.setProperty('color-scheme', 'light');
        clonedDoc.body.style.setProperty('background-color', backgroundColor);
      }
      sanearColoresClonHtml2canvas(element);
    },
  };
}

/** Monto mínimo por cuota para planes 286 días / 44 semanas. */
const MONTO_CUOTA_MIN_PLAN_ESPECIAL = 40;

const PALETA_TEXTO_PLAN_ESPECIAL = '#ca8a04';

/** Deep link tipo SPA: `?id=<uuid_credito>` junto a la ruta actual (p. ej. al compartir o notificación). */
function getCreditoIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search).get('id');
  return q && String(q).trim() ? String(q).trim() : null;
}

function setCreditoIdEnUrl(id: string | null) {
  if (typeof window === 'undefined') return;
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('id', id);
  else u.searchParams.delete('id');
  window.history.replaceState({}, '', `${u.pathname}${u.search}${u.hash}`);
}

function ComprobantePagoTicketVista({
  comprobante,
  nombreEmpresaDisplay,
}: {
  comprobante: ComprobantePagoImagen;
  nombreEmpresaDisplay: string;
}) {
  const ffSans = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  void nombreEmpresaDisplay;
  return (
    <div
      style={{
        background: '#ffffff',
        color: '#111827',
        border: '1px solid #e5e7eb',
        borderRadius: 24,
        boxShadow: '0 18px 45px rgba(15, 23, 42, 0.16)',
        margin: '0 auto',
        maxWidth: 360,
        padding: 24,
        position: 'relative',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 280,
      }}
    >
      <div
        style={{
          background: '#111827',
          borderRadius: 999,
          color: '#ffffff',
          fontSize: 13,
          fontWeight: 900,
          letterSpacing: 0.4,
          padding: '7px 11px',
          position: 'absolute',
          right: 18,
          top: 18,
        }}
      >
        {numeroFichaComprobante(comprobante.ficha)}
      </div>
      <div style={{ textAlign: 'center', fontFamily: ffSans }}>
        <h2 style={{ fontSize: 21, fontWeight: 900, lineHeight: 1.15, margin: 0, letterSpacing: '-0.02em', color: '#0f172a', textTransform: 'uppercase' }}>
          PAGO CONFIRMADO - {MARCA_PRIMARIA}
        </h2>
        <p style={{ color: '#64748b', fontSize: 14, fontWeight: 300, margin: '8px 0 0', letterSpacing: '0.06em' }}>
          {MARCA_DESCRIPTOR}
        </p>
      </div>

      <div style={{ borderTop: '1px dashed #cbd5e1', margin: '18px 0' }} />

      <div style={{ display: 'grid', gap: 9, fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Fecha</span>
          <strong>{new Date(comprobante.fechaPago).toLocaleDateString('es-AR')}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Hora</span>
          <strong>{new Date(comprobante.fechaPago).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Inicio del Crédito</span>
          <strong>{fechaComprobanteDDMMAAAA(comprobante.ficha.fecha_inicio || comprobante.ficha.fecha)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Cliente</span>
          <strong style={{ textAlign: 'right' }}>{nombreCompletoCliente(comprobante.cliente)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Ficha</span>
          <strong style={{ textAlign: 'right' }}>{numeroFichaComprobante(comprobante.ficha)}</strong>
        </div>
      </div>

      <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 18, margin: '20px 0', padding: 18, textAlign: 'center' }}>
        <p style={{ color: '#047857', fontSize: 12, fontWeight: 800, letterSpacing: 0.8, margin: 0, textTransform: 'uppercase' }}>Monto cobrado</p>
        <p style={{ color: '#065f46', fontSize: 34, fontWeight: 950, lineHeight: 1, margin: '8px 0 0' }}>{fmt(comprobante.monto)}</p>
      </div>

      <div style={{ display: 'grid', gap: 9, fontSize: 13 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Saldo restante</span>
          <strong>{fmt(comprobante.saldoRestante)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: '#64748b' }}>Recibido por</span>
          <strong style={{ textAlign: 'right' }}>{etiquetaCobradorMovimiento(comprobante.cobradorId || 'Sin informar')}</strong>
        </div>
      </div>

      <div style={{ borderTop: '1px dashed #cbd5e1', margin: '18px 0' }} />
      <p style={{ color: '#334155', fontSize: 12, fontWeight: 700, margin: 0, textAlign: 'center' }}>Gracias por su pago.</p>
      <p style={{ color: '#64748b', fontSize: 11, margin: '5px 0 0', textAlign: 'center' }}>Conserve este comprobante.</p>
      <BrandingFooter align="center" variant="light" marcaPrimaria={MARCA_PRIMARIA} descriptor={MARCA_DESCRIPTOR} />
    </div>
  );
}

function addDias(fecha: string, dias: number) {
  const d = new Date(fecha); d.setDate(d.getDate() + dias);
  return d.toISOString().split('T')[0];
}
function diffDias(a: string, b: string) {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

/** Admin y Root (y super legacy) comparten permisos elevados. */
function isAdminOrRoot(rol: string | null | undefined) {
  const v = (rol || '').toLowerCase();
  return ['admin', 'root', 'super'].includes(v);
}

/** Solo admin/root puede modificar el % de interés al crear o simular créditos. */
function puedeEditarInteresCredito(rol: string | null | undefined): boolean {
  return isAdminOrRoot(rol);
}

function interesAplicadoOficialCredito(
  tipo: 'M' | 'P',
  rol: string | null | undefined,
  config: { interesCreditoM?: number; interesCreditoP?: number },
  plazoCantidad?: number,
  configTasasMensual: ConfigTasasMensual = CONFIG_TASAS_MENSUAL_VACIO,
): number {
  if (esUsuarioMensualSesion(rol)) {
    return tasaInteresMensualPorMeses(Math.max(1, Number(plazoCantidad) || 1), configTasasMensual);
  }
  if (String(rol || '').toLowerCase() === 'cobrador') return 30;
  const base = tipo === 'M' ? Number(config.interesCreditoM) : Number(config.interesCreditoP);
  return Number.isFinite(base) && base > 0 ? base : 30;
}
/** Root y super: auditoría y funciones de nivel superior. */
function isRootLike(rol: string | null | undefined) {
  const v = (rol || '').toLowerCase();
  return v === 'root' || v === 'super';
}

/** Carga retroactiva: mismos roles elevados que el panel (admin, root, super). Cobrador: fechas limitadas. */
function puedeCargaRetroactivaCredito(rol: string | null | undefined) {
  return isAdminOrRoot(rol);
}

const MAX_DIAS_FUTURO_FECHA_INICIO_DIARIO = 7;
const MAX_DIAS_FUTURO_FECHA_INICIO_SEMANAL = 12;

function maxDiasFuturoFechaInicioCredito(plazoUnidad?: 'Días' | 'Semanas' | 'Meses' | string): number {
  const u = normalizarPlazoUnidad(plazoUnidad ?? 'Días');
  return u === 'Semanas' ? MAX_DIAS_FUTURO_FECHA_INICIO_SEMANAL : MAX_DIAS_FUTURO_FECHA_INICIO_DIARIO;
}

/** Validación al crear crédito: máx. 7 días (diario/mensual) o 12 días (semanal) hacia adelante desde hoy. */
function validarFechaInicioCredito(
  fecha: string,
  puedeRetro: boolean,
  plazoUnidad?: 'Días' | 'Semanas' | 'Meses' | string,
): string | null {
  const f = String(fecha || '').slice(0, 10);
  if (!f) return 'Indicá la fecha de inicio del crédito.';
  const h = hoy();
  const maxDias = maxDiasFuturoFechaInicioCredito(plazoUnidad);
  const maxFut = addDias(h, maxDias);
  if (!puedeRetro && f < h) return 'La fecha de inicio no puede ser anterior a hoy.';
  if (f > h && f > maxFut) return `La fecha de inicio no puede ser más de ${maxDias} días en el futuro.`;
  return null;
}

/**
 * Referencia para armar vencimientos de cuotas (no es la fecha de inicio del formulario salvo retroactivo).
 * Cobro en ruta: primera cuota = día siguiente al alta/aprobación (fechaActivacion al aprobar).
 */
function fechaBasePlanCuotasCredito(credito: Credito, fechaActivacion?: string): string {
  if (credito.es_retroactivo) {
    return String(credito.fecha_inicio || hoy()).slice(0, 10);
  }
  if (fechaActivacion) return String(fechaActivacion).slice(0, 10);
  if (credito.created_at) return String(credito.created_at).slice(0, 10);
  return hoy();
}
function rolNormalizadoDb(r: string | null | undefined) {
  const v = (r || '').trim().toLowerCase();
  if (v === 'admin' || v === 'cobrador' || v === 'vendedor' || v === 'proveedor' || v === 'super' || v === 'root' || v === 'mensual') return v;
  return 'cobrador';
}
function esUsuarioMensualSesion(rol: string | null | undefined) {
  return rolNormalizadoDb(rol) === 'mensual';
}
function ambitoDatosSesion(rol: string | null | undefined): typeof AMBITO_DATOS_PRINCIPAL | typeof AMBITO_DATOS_MENSUAL {
  return esUsuarioMensualSesion(rol) ? AMBITO_DATOS_MENSUAL : AMBITO_DATOS_PRINCIPAL;
}
function esProveedorSesion(rol: string | null | undefined) {
  return (rol || '').toLowerCase() === 'proveedor';
}
/** Cobrador o vendedor: ven solo su cartera / datos propios (no panel global como admin). */
function esRolCampoRestringido(rol: string | null | undefined) {
  const v = (rol || '').toLowerCase();
  return v === 'cobrador' || v === 'vendedor';
}
function esVendedorSesion(rol: string | null | undefined) {
  return (rol || '').toLowerCase() === 'vendedor';
}
function esUsuarioVendedorPorIdentidad(params: {
  loginEmail: string | null | undefined;
  usernameState: string | null | undefined;
  rol: string | null | undefined;
  authUser?: AuthMetaInput;
}): boolean {
  if (esVendedorSesion(params.rol)) return true;
  const perfil = resolverPerfilDesdeSesion(params);
  if (perfil?.rolDefecto === 'vendedor') return true;
  const email = normalizarEmail(params.loginEmail);
  return email.startsWith('vendedor@');
}

function idsReferenciaVendedor(v: { id: string; username: string; email?: string }): string[] {
  const raw = [v.id, v.username, v.email, `${v.username}@emd.com`];
  return [...new Set(raw.map(x => String(x ?? '').trim()).filter(Boolean))];
}
/** Sábado de corte de la semana en curso (liquidación semanal). */
function sabadoCorteSemana(ref?: string): string {
  const base = ref || hoy();
  const d = new Date(`${base}T12:00:00`);
  const dow = d.getDay();
  const diasAtras = dow === 6 ? 0 : dow + 1;
  return addDias(base, -diasAtras);
}
function proximoSabadoDesde(ref?: string): string {
  const base = ref || hoy();
  const d = new Date(`${base}T12:00:00`);
  const dow = d.getDay();
  if (dow === 6) return base;
  return addDias(base, 6 - dow);
}
function calcularComisionVentaVendedor(montoSolicitado: number, porcentaje: number): number {
  const capital = redondearPesos(Number(montoSolicitado) || 0);
  const pct = Number(porcentaje) || 0;
  if (capital <= 0 || pct <= 0) return 0;
  return redondearPesos(capital * (pct / 100));
}
function porcentajeComisionEfectivoVendedor(pctPersonal: number | null | undefined, pctGlobal: number): number {
  const p = pctPersonal != null && Number.isFinite(Number(pctPersonal)) ? Number(pctPersonal) : Number(pctGlobal);
  return Number.isFinite(p) && p >= 0 ? p : 5;
}
function creditoComisionPendienteAprobacionAdmin(c: Credito): boolean {
  return esCreditoActivo(c)
    && Number(c.comision_vendedor) > 0
    && !Boolean(c.comision_aprobada_admin);
}
function creditoComisionAprobadaPendienteCobro(c: Credito): boolean {
  return esCreditoActivo(c)
    && Number(c.comision_vendedor) > 0
    && Boolean(c.comision_aprobada_admin)
    && !Boolean(c.comision_liquidada);
}
function creditoPerteneceAVendedor(c: Credito, vendedorIds: string[]): boolean {
  const vid = String(c.vendedor_id ?? c.cobrador_id ?? c.creado_por ?? '').trim();
  if (!vid) return false;
  const set = new Set(vendedorIds.map(x => x.toLowerCase()));
  if (set.has(vid.toLowerCase())) return true;
  const emailNotif = String(c.cobrador_notif_email ?? '').trim().toLowerCase();
  if (emailNotif && set.has(emailNotif)) return true;
  const localNotif = emailNotif.includes('@') ? emailNotif.split('@')[0] : '';
  if (localNotif && set.has(localNotif)) return true;
  return false;
}
async function buscarUsuarioVendedorEnBd(vendedorAuthId: string, usernameHint: string) {
  const local = String(usernameHint || '').trim().toLowerCase();
  const id = String(vendedorAuthId || '').trim();
  let q = supabase.from('usuarios').select('id, username, comision_acumulada, porcentaje_comision').eq('rol', 'vendedor').eq('activo', true);
  if (id && local) q = q.or(`id.eq.${id},username.eq.${local}`);
  else if (id) q = q.eq('id', id);
  else if (local) q = q.eq('username', local);
  else return null;
  const { data } = await q.limit(1).maybeSingle();
  return data as { id: string; username: string; comision_acumulada: number; porcentaje_comision: number | null } | null;
}
async function incrementarComisionAcumuladaVendedor(vendedorAuthId: string, usernameHint: string, monto: number) {
  const usr = await buscarUsuarioVendedorEnBd(vendedorAuthId, usernameHint);
  if (!usr) return;
  const nueva = redondearPesos(Number(usr.comision_acumulada) + monto);
  await supabase.from('usuarios').update({ comision_acumulada: nueva }).eq('id', usr.id);
}

async function decrementarComisionAcumuladaVendedor(vendedorAuthId: string, usernameHint: string, monto: number) {
  const usr = await buscarUsuarioVendedorEnBd(vendedorAuthId, usernameHint);
  if (!usr) return;
  const nueva = redondearPesos(Math.max(0, Number(usr.comision_acumulada) - monto));
  await supabase.from('usuarios').update({ comision_acumulada: nueva }).eq('id', usr.id);
}
function normalizarEmail(email: string | null | undefined) {
  return String(email ?? '').trim().toLowerCase();
}
function normalizarLoginUsuario(raw: string | null | undefined) {
  return String(raw ?? '').trim().toLowerCase();
}

type AuthMetaInput = { user_metadata?: Record<string, unknown> } | null | undefined;

/** Perfiles del sistema: login visible + correo interno de Supabase Auth. */
type PerfilUsuarioSistema = {
  login: string;
  authEmail: string;
  nombre: string;
  rolDefecto: 'root' | 'admin' | 'cobrador' | 'vendedor' | 'mensual';
  esAdmin?: boolean;
  accesoRapido?: boolean;
  /** Username en tabla `usuarios` (puede diferir del login). */
  usernameBd?: string;
};

const USUARIOS_SISTEMA: PerfilUsuarioSistema[] = [
  { login: 'marcos', authEmail: 'emamoreno7@hotmail.com', nombre: 'Marcos', rolDefecto: 'root', esAdmin: true, accesoRapido: true, usernameBd: 'emamoreno7' },
  { login: 'matias', authEmail: 'cobrador1@emd.com', nombre: 'Matias', rolDefecto: 'cobrador', accesoRapido: true, usernameBd: 'cobrador1' },
  { login: 'vendedor', authEmail: 'cobrador2@emd.com', nombre: 'Vendedor', rolDefecto: 'vendedor', accesoRapido: true, usernameBd: 'cobrador2' },
  { login: 'root', authEmail: 'root@emd.com', nombre: 'Root', rolDefecto: 'root', esAdmin: true, accesoRapido: true, usernameBd: 'root' },
  { login: 'mensual', authEmail: 'mensual1@emd.com', nombre: 'Mensual', rolDefecto: 'mensual', accesoRapido: true, usernameBd: 'mensual' },
  { login: 'prueba', authEmail: 'prueba@emd.com', nombre: 'Prueba Demo', rolDefecto: 'root', esAdmin: true, accesoRapido: true, usernameBd: 'prueba' },
];

/** Alias legacy (correos viejos, MatiasM/MarcosP, cobrador1…) → login canónico. */
const ALIAS_LOGIN_USUARIO: Record<string, string> = {
  cobrador1: 'matias',
  cobrador2: 'vendedor',
  emamoreno7: 'marcos',
  marcosp: 'marcos',
  matiasm: 'matias',
  mensaul: 'mensual',
};

const ETIQUETA_USUARIO_POR_EMAIL: Record<string, string> = Object.fromEntries(
  USUARIOS_SISTEMA.map(u => [normalizarEmail(u.authEmail), u.nombre]),
);

const ETIQUETA_USUARIO_POR_LOCAL: Record<string, string> = Object.fromEntries(
  USUARIOS_SISTEMA.flatMap(u => {
    const filas: [string, string][] = [[u.login, u.nombre]];
    if (u.usernameBd) filas.push([u.usernameBd.toLowerCase(), u.nombre]);
    return filas;
  }),
);

/** Textos guardados en BD con nombres anteriores. */
const ETIQUETA_USUARIO_LEGACY: Record<string, string> = {
  matiasm: 'Matias',
  marcosp: 'Marcos',
  cobrador1: 'Matias',
  cobrador2: 'Vendedor',
  emamoreno7: 'Marcos',
};

/** id de `usuarios` / Supabase Auth → nombre y rol para listados (Control, caja, etc.). */
const MAPA_USUARIO_POR_ID: Record<string, { nombre: string; rol: string }> = {};

const CP_COBRADOR_LABELS_KEY = 'cp_cobrador_uuid_labels_v1';

function registrarEtiquetaCobradorReferencia(
  clave: string | null | undefined,
  nombre: string | null | undefined,
  rol?: string | null,
) {
  const k = String(clave ?? '').trim().toLowerCase();
  const nombreRaw = String(nombre ?? '').trim();
  if (!k || !nombreRaw || nombreRaw === k) return;
  const nombreLegible = etiquetaCobradorMovimientoDesdeClave(nombreRaw);
  const rolEt = etiquetaRolUsuarioLegible(rol) || 'Cobrador';
  if (esUuidReferenciaUsuario(k)) {
    MAPA_USUARIO_POR_ID[k] = { nombre: nombreLegible, rol: rolEt };
    try {
      const prev = JSON.parse(localStorage.getItem(CP_COBRADOR_LABELS_KEY) || '{}') as Record<string, { nombre: string; rol: string }>;
      prev[k] = { nombre: nombreLegible, rol: rolEt };
      localStorage.setItem(CP_COBRADOR_LABELS_KEY, JSON.stringify(prev));
    } catch {
      /* quota / modo privado */
    }
  }
}

function registrarEtiquetasCobradorDesdePersistencia() {
  try {
    const prev = JSON.parse(localStorage.getItem(CP_COBRADOR_LABELS_KEY) || '{}') as Record<string, { nombre?: string; rol?: string }>;
    for (const [id, row] of Object.entries(prev)) {
      if (row?.nombre) registrarEtiquetaCobradorReferencia(id, row.nombre, row.rol);
    }
  } catch {
    /* ignore */
  }
}

function registrarEtiquetasDesdeRendicionRows(rows: Array<{ cobrador_id?: unknown; cobrador_nombre?: unknown }> | null | undefined) {
  for (const row of rows ?? []) {
    registrarEtiquetaCobradorReferencia(
      String(row.cobrador_id ?? ''),
      String(row.cobrador_nombre ?? ''),
    );
  }
}

function registrarEtiquetasDesdeCierres(cierres: Cierre[] | null | undefined) {
  for (const c of cierres ?? []) {
    registrarEtiquetaCobradorReferencia(c.userId, c.username);
  }
}

function etiquetaRolUsuarioLegible(rol: string | null | undefined): string {
  const r = rolNormalizadoDb(String(rol ?? ''));
  if (r === 'vendedor') return 'Vendedor';
  if (r === 'cobrador') return 'Cobrador';
  if (r === 'mensual') return 'Mensual';
  if (r === 'proveedor') return 'Proveedor';
  if (r === 'admin' || r === 'root' || r === 'super') return 'Administración';
  return '';
}

function registrarMapaUsuariosEtiquetas(rows: Array<{ id?: string; username?: string; rol?: string }>) {
  for (const row of rows) {
    const username = String(row.username ?? '').trim();
    const rolEt = etiquetaRolUsuarioLegible(row.rol);
    const nombre = etiquetaCobradorMovimientoDesdeClave(username || String(row.id ?? ''));
    const idNorm = normalizarUuidPostgrest(row.id);
    if (idNorm) registrarEtiquetaCobradorReferencia(idNorm, nombre, rolEt);
    if (username) registrarEtiquetaCobradorReferencia(username, nombre, rolEt);
  }
}

function esUuidReferenciaUsuario(v: unknown): boolean {
  return esUuidClienteId(v);
}

function etiquetaCobradorMovimientoDesdeClave(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  const lower = s.toLowerCase();
  if (lower.includes('@')) {
    const n = normalizarEmail(s);
    return ETIQUETA_USUARIO_POR_EMAIL[n] || (s.includes('@') ? s.split('@')[0] : s);
  }
  if (ETIQUETA_USUARIO_POR_LOCAL[lower]) return ETIQUETA_USUARIO_POR_LOCAL[lower];
  if (ETIQUETA_USUARIO_LEGACY[lower]) return ETIQUETA_USUARIO_LEGACY[lower];
  const perfil = resolverPerfilDesdeEntradaLogin(s);
  if (perfil?.nombre) return perfil.nombre;
  return s;
}

function etiquetaRolUsuario(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  const lower = s.toLowerCase();
  if (esUuidReferenciaUsuario(lower)) {
    return MAPA_USUARIO_POR_ID[lower]?.rol || 'Cobrador';
  }
  const perfil = resolverPerfilDesdeEntradaLogin(s);
  if (perfil) return etiquetaRolUsuarioLegible(perfil.rolDefecto);
  return 'Cobrador';
}

function resolverPerfilDesdeLoginCanonico(login: string): PerfilUsuarioSistema | null {
  const k = normalizarLoginUsuario(login);
  if (!k) return null;
  const canon = ALIAS_LOGIN_USUARIO[k] ?? k;
  return USUARIOS_SISTEMA.find(u => u.login === canon) ?? null;
}

function resolverPerfilDesdeAuthEmail(email: string | null | undefined): PerfilUsuarioSistema | null {
  const e = normalizarEmail(email);
  if (!e) return null;
  return USUARIOS_SISTEMA.find(u => normalizarEmail(u.authEmail) === e) ?? null;
}

function resolverPerfilDesdeEntradaLogin(input: string | null | undefined): PerfilUsuarioSistema | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return resolverPerfilDesdeAuthEmail(raw);
  return resolverPerfilDesdeLoginCanonico(raw);
}

function resolverPerfilDesdeSesion(params: {
  loginEmail: string | null | undefined;
  usernameState: string | null | undefined;
}): PerfilUsuarioSistema | null {
  return resolverPerfilDesdeAuthEmail(params.loginEmail)
    || resolverPerfilDesdeEntradaLogin(params.usernameState)
    || null;
}

function loginDesdeAlmacenado(stored: string | null | undefined): string {
  if (!stored) return '';
  const perfil = resolverPerfilDesdeEntradaLogin(stored);
  if (perfil) return perfil.login;
  const s = stored.trim();
  return s.includes('@') ? s.split('@')[0] : s;
}

function esUsuarioAdminLogin(stored: string | null | undefined): boolean {
  const perfil = resolverPerfilDesdeEntradaLogin(String(stored ?? ''));
  if (perfil?.esAdmin) return true;
  const e = normalizarEmail(stored);
  return e.includes('admin');
}

function idsReferenciaPerfil(perfil: PerfilUsuarioSistema | null): string[] {
  if (!perfil) return [];
  const local = perfil.authEmail.split('@')[0] || '';
  return [...new Set([perfil.login, perfil.authEmail, local, perfil.usernameBd ?? ''].filter(Boolean))];
}

/** Vendedores conocidos (Auth/demo) aunque no existan aún en tabla `usuarios`. */
const PERFILES_VENDEDOR_SISTEMA: { email: string; username: string }[] = USUARIOS_SISTEMA
  .filter(u => u.rolDefecto === 'vendedor')
  .map(u => ({ email: u.authEmail, username: u.usernameBd ?? u.login }));

/** Accesos rápidos en login: admin ve todos; cobrador/vendedor solo el suyo. */
function accesosRapidosLoginVisibles(): { label: string; login: string }[] {
  const todos = USUARIOS_SISTEMA
    .filter(u => u.accesoRapido && u.login !== 'root')
    .map(u => ({ label: u.nombre, login: u.login }));
  if (typeof localStorage === 'undefined') return [];
  const lastRaw = localStorage.getItem('cp_last_login_user');
  const lastLogin = loginDesdeAlmacenado(lastRaw);
  if (!lastLogin) return [];
  if (esUsuarioAdminLogin(lastRaw) || esUsuarioAdminLogin(lastLogin)) return todos;
  return todos.filter(a => a.login === lastLogin);
}

/** Nombre para saludo y cabecera: metadata Supabase, mapa demo, o parte local del correo. */
function nombreParaMostrarSesion(params: {
  loginEmail: string | null | undefined;
  usernameState: string | null | undefined;
  authUser?: AuthMetaInput;
}): string {
  const emailNorm = normalizarEmail(params.loginEmail);
  if (emailNorm && ETIQUETA_USUARIO_POR_EMAIL[emailNorm]) return ETIQUETA_USUARIO_POR_EMAIL[emailNorm];
  const um = params.authUser?.user_metadata;
  if (um && typeof um.full_name === 'string' && um.full_name.trim()) return um.full_name.trim();
  if (um && typeof um.name === 'string' && um.name.trim()) return um.name.trim();
  if (um && typeof um.display_name === 'string' && um.display_name.trim()) return um.display_name.trim();
  const loc = String(params.usernameState ?? '').trim().toLowerCase();
  if (loc && ETIQUETA_USUARIO_POR_LOCAL[loc]) return ETIQUETA_USUARIO_POR_LOCAL[loc];
  if (emailNorm.includes('@')) {
    const part = emailNorm.split('@')[0];
    return (part && ETIQUETA_USUARIO_POR_LOCAL[part]) || part || 'Usuario';
  }
  const u = String(params.usernameState ?? '').trim();
  return u || 'Usuario';
}

function esUsuarioPruebaSesion(usernameState: string | null | undefined, loginEmail: string | null | undefined): boolean {
  const u = normalizarLoginUsuario(usernameState);
  return u === 'prueba' || normalizarEmail(loginEmail) === 'prueba@emd.com';
}

/** Operador técnico (solo login root): consola de monitoreo, sin cobranzas. */
function esUsuarioRootOperador(usernameState: string | null | undefined, loginEmail: string | null | undefined): boolean {
  const u = normalizarLoginUsuario(usernameState);
  return u === 'root' || normalizarEmail(loginEmail) === 'root@emd.com';
}

/** Solo Marcos puede aprobar/rechazar cheques (no Prueba ni otros admin). */
function esUsuarioMarcosOperador(usernameState: string | null | undefined, loginEmail: string | null | undefined): boolean {
  const u = normalizarLoginUsuario(usernameState);
  return u === 'marcos' || normalizarEmail(loginEmail) === 'emamoreno7@hotmail.com';
}

/** Validación en servidor (tabla usuarios): no depende de IP/MAC/caché del navegador. */
async function verificarAccesoDemoPruebaEnServidor(username: string) {
  const { data, error } = await supabase.rpc('verificar_acceso_demo_prueba', {
    p_username: String(username ?? '').trim(),
  });
  if (error) {
    devWarn('verificar_acceso_demo_prueba:', error);
    return parseResultadoAccesoDemo({ ok: true, es_demo: false });
  }
  return parseResultadoAccesoDemo(data);
}

/** Admin (Marcos, Prueba demo): aprobación de créditos, borrados y configuración avanzada. Root usa consola aparte. */
function esUsuarioMarcosP(params: {
  loginEmail: string | null | undefined;
  usernameState: string | null | undefined;
  authUser?: AuthMetaInput;
}): boolean {
  if (esUsuarioRootOperador(params.usernameState, params.loginEmail)) return false;
  const perfil = resolverPerfilDesdeSesion(params);
  return perfil?.esAdmin === true;
}

/** Cobradores / vendedores con reglas restringidas (no admin). */
function esUsuarioCobradorMatiasOVendedor(params: {
  loginEmail: string | null | undefined;
  usernameState: string | null | undefined;
  authUser?: AuthMetaInput;
}): boolean {
  const perfil = resolverPerfilDesdeSesion(params);
  if (!perfil || perfil.esAdmin) return false;
  return perfil.rolDefecto === 'cobrador' || perfil.rolDefecto === 'vendedor';
}

/** Cobrador en movimientos, PDF, cartones, tablas (email, local, UUID Auth o username). */
function etiquetaCobradorMovimiento(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s || s === '—' || s === 'Sin informar' || s === 'sin_usuario') return s || '—';
  const lower = s.toLowerCase();
  if (esUuidReferenciaUsuario(lower)) {
    return MAPA_USUARIO_POR_ID[lower]?.nombre || 'Usuario';
  }
  return etiquetaCobradorMovimientoDesdeClave(s);
}

function normalizarId(raw: unknown) {
  return String(raw ?? '').trim().toLowerCase();
}

/** `pagos.ficha_id` (uuid en BD): enviar y comparar en minúsculas al estilo UUID estándar. */
function fichaIdUuid(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.toLowerCase();
}
async function verificarClaveModuloMensual(login: string, clave: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('verificar_clave_modulo_mensual', {
      p_login: String(login ?? '').trim(),
      p_clave: String(clave ?? ''),
    });
    if (error) {
      devWarn('verificar_clave_modulo_mensual:', error);
      return false;
    }
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Tras validar clave local, intenta signUp (solo si Auth no existe) y signIn con mensual1@emd.com. */
async function provisionarAuthModuloMensual(authEmail: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const { error: signInFirstErr } = await supabase.auth.signInWithPassword({ email: authEmail, password });
  if (!signInFirstErr) return { ok: true };

  const { error: signUpErr } = await supabase.auth.signUp({
    email: authEmail,
    password,
  });
  if (signUpErr) {
    const msg = String(signUpErr.message || '').toLowerCase();
    const yaRegistrado = msg.includes('already registered') || msg.includes('already been registered')
      || signUpErr.code === 'user_already_exists';
    const emailInvalido = msg.includes('invalid') && msg.includes('email');
    if (emailInvalido) {
      return {
        ok: false,
        error: 'Supabase no acepta el correo automático. Creá manualmente en Authentication → Users: mensual1@emd.com con clave Emamoreno7 (Auto Confirm).',
      };
    }
    if (!yaRegistrado) {
      return { ok: false, error: signUpErr.message };
    }
  }
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email: authEmail, password });
  if (signInErr) {
    return {
      ok: false,
      error: 'Creá en Supabase Auth el usuario mensual1@emd.com con clave Emamoreno7 (Auto Confirm User activado).',
    };
  }
  return { ok: true };
}

async function resolverRolUsuarioSesion(authUserId: string | null | undefined, email: string): Promise<string> {
  const emailNorm = normalizarEmail(email);
  const localPart = emailNorm.split('@')[0] || '';
  const perfil = resolverPerfilDesdeAuthEmail(emailNorm);
  const usernamesBd = [...new Set([localPart, perfil?.login, perfil?.usernameBd].filter(Boolean))] as string[];
  try {
    let query = supabase.from('usuarios').select('rol').eq('activo', true);
    if (authUserId && usernamesBd.length) {
      const orParts = [`id.eq.${authUserId}`, ...usernamesBd.map(u => `username.eq.${u}`)];
      query = query.or(orParts.join(','));
    } else if (authUserId) {
      query = query.eq('id', authUserId);
    } else if (usernamesBd.length === 1) {
      query = query.eq('username', usernamesBd[0]);
    } else if (usernamesBd.length > 1) {
      query = query.or(usernamesBd.map(u => `username.eq.${u}`).join(','));
    } else {
      return rolNormalizadoDb(rolDesdeEmail(emailNorm));
    }
    const { data } = await query.limit(1).maybeSingle();
    if (data?.rol) {
      const rolDb = rolNormalizadoDb(String(data.rol));
      const rolEmail = rolNormalizadoDb(rolDesdeEmail(emailNorm));
      /** Correos vendedor demo prevalecen si en BD quedó rol cobrador por error. */
      if (rolEmail === 'vendedor') return 'vendedor';
      return rolDb;
    }
  } catch {
    /* tabla usuarios opcional en algunos entornos */
  }
  return rolNormalizadoDb(rolDesdeEmail(emailNorm));
}

function rolDesdeEmail(email: string | null | undefined) {
  const perfil = resolverPerfilDesdeAuthEmail(email);
  if (perfil) return perfil.rolDefecto;
  const e = normalizarEmail(email);
  if (e.endsWith('@proveedor.local')) return 'proveedor';
  if (e.startsWith('mensual1@') || e.startsWith('mensual@')) return 'mensual';
  if (e.includes('admin') || e.includes('root')) return 'root';
  if (e.startsWith('vendedor@')) return 'vendedor';
  return 'cobrador';
}

/** Interpreta la columna `plan` de creditos (Diario / Semanal / Mensual y variantes) como unidad de calendario. */
function normalizarPlazoUnidad(raw: string | null | undefined): 'Días' | 'Semanas' | 'Meses' {
  const s = String(raw ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (s === 'dias' || s === 'days' || s === 'dia' || s === 'día' || s === 'diario' || s === 'diaria') return 'Días';
  if (s === 'semanas' || s === 'weeks' || s === 'semana' || s === 'semanal') return 'Semanas';
  if (s === 'meses' || s === 'months' || s === 'mes' || s === 'mensual') return 'Meses';
  return 'Semanas';
}

/** Valor legado de columna `plan` en creditos (compatibilidad listados / PDF). */
function planEtiquetaDesdePlazoUnidad(u: 'Días' | 'Semanas' | 'Meses'): string {
  if (u === 'Días') return 'Diario';
  if (u === 'Meses') return 'Mensual';
  return 'Semanal';
}

/**
 * Calendario de cuotas solo desde columna `plan` (Diario → un día por cuota; Semanal/Mensual según corresponda).
 * Sin `plan`: se asume Diario para Ruta/créditos viejos.
 */
function plazoUnidadPlanillaCredito(credito: Credito): 'Días' | 'Semanas' | 'Meses' {
  const raw = credito.plan;
  if (raw == null || String(raw).trim() === '') return 'Días';
  return normalizarPlazoUnidad(String(raw));
}
function addUnidad(fecha: string, unidad: 'Días' | 'Semanas' | 'Meses', cantidad: number) {
  const d = new Date(fecha);
  if (unidad === 'Días') d.setDate(d.getDate() + cantidad);
  if (unidad === 'Semanas') d.setDate(d.getDate() + (cantidad * 7));
  if (unidad === 'Meses') d.setMonth(d.getMonth() + cantidad);
  return d.toISOString().split('T')[0];
}
function generarPlanillaCredito(credito: Credito, opts?: { fechaActivacion?: string }): CuotaPlanilla[] {
  const cuotas = Math.max(1, Number(credito.cuotas ?? credito.plazo_cantidad) || 1);
  const unidad = plazoUnidadPlanillaCredito(credito);
  const total = redondearPesos(Number(credito.monto_total ?? credito.total_con_interes) || 0);
  const montosPorCuota = distribuirMontoEnCuotas(total, cuotas);
  const basePrimeraCuota = addDias(fechaBasePlanCuotasCredito(credito, opts?.fechaActivacion), 1);
  return Array.from({ length: cuotas }, (_, i) => {
    const nro = i + 1;
    /** Primera cuota: día siguiente al alta/aprobación; siguientes según unidad del plan. */
    const vencimiento = nro === 1 ? basePrimeraCuota : addUnidad(basePrimeraCuota, unidad, nro - 1);
    const pagadoIncluyeEsta = montosPorCuota.slice(0, nro).reduce((s, m) => s + m, 0);
    const saldo = Math.max(0, total - pagadoIncluyeEsta);
    return { nro, vencimiento, monto: montosPorCuota[i], saldo };
  });
}

async function sincronizarCuotasCreditoSupabase(credito: Credito, opts?: { fechaActivacion?: string }) {
  const creditoUuidNorm = normalizarUuidPostgrest(credito.id);
  const clienteUuidNorm = normalizarUuidPostgrest(credito.cliente_id);
  if (!creditoUuidNorm || !clienteUuidNorm) return;
  const planilla = generarPlanillaCredito(credito, opts);
  if (planilla.length === 0) return;
  const rows = planilla.map(c => ({
    credito_id: creditoUuidNorm,
    cliente_id: clienteUuidNorm,
    nro_cuota: Number(c.nro),
    fecha_vencimiento: String(c.vencimiento).slice(0, 10),
    monto: redondearPesos(Number(c.monto) || 0),
    estado: 'pendiente',
  }));
  dbgSupabaseTbl('cuotas', 'upsert', { credito_id: creditoUuidNorm, filas: rows.length });
  const { error } = await supabase.from('cuotas').upsert(rows as any, { onConflict: 'credito_id,nro_cuota' });
  if (error) devWarn('sincronizarCuotasCreditoSupabase:', error);
}

/** Lee `cp_cobros_pendientes_v1`: arma parámetros para insert en `pagos` / update en `cuotas` (tablas públicas en minúsculas). */
function parametrosRegistroDirectoDesdeColaLocalPagoDb(pagoDb: Record<string, unknown>): ParamsRegistroCobranzaDirectaSupabase | null {
  const ficha_id = normalizarUuidPostgrest(pagoDb.ficha_id);
  const cliente_id = normalizarUuidPostgrest(pagoDb.cliente_id);
  if (!ficha_id || !cliente_id) return null;
  const cobrador_id = String(pagoDb.cobrador_id ?? '').trim();
  let fecha_pago = String(pagoDb.fecha_pago ?? '').trim();
  if (!fecha_pago) fecha_pago = new Date().toISOString();
  const cuota_numero = Math.round(Number(pagoDb.cuota_numero ?? NaN));
  if (!Number.isFinite(cuota_numero) || cuota_numero < 1) return null;
  return {
    ficha_id,
    cliente_id,
    cobrador_id: cobrador_id || 'sin_usuario',
    monto: redondearPesos(Number(pagoDb.monto ?? 0)),
    fecha_pago,
    cuota_numero,
    es_registro_no_pago: Boolean(pagoDb.es_registro_no_pago),
  };
}

/** Subida manual (admin): recorre `cp_cobros_pendientes_v1` uno a uno sin RPC. */
async function ejecutarSubidaManualCobrosLocalesDesdeLs(): Promise<{ subidos: number; pendientesFinal: number; erroresDetalle: string[] }> {
  const entrada = leerCobrosPendientesLocalRaw();
  const restantes: CobroPendienteLocalV1[] = [];
  const erroresDetalle: string[] = [];
  let subidos = 0;
  for (const item of entrada) {
    const params = parametrosRegistroDirectoDesdeColaLocalPagoDb(item.pagoDb as Record<string, unknown>);
    if (!params) {
      restantes.push(item);
      erroresDetalle.push(`ts=${item.ts}: datos incompletos (ficha/cliente/cuota)`);
      continue;
    }
    const res = await registrarCobranzaDirectaConReintentos(params, 3);
    if (res.ok) subidos += 1;
    else {
      restantes.push(item);
      erroresDetalle.push(`ts=${item.ts}: ${serializarErrorParaAuditoria(res.error).mensaje.slice(0, 200)}`);
    }
  }
  escribirCobrosPendientesLocal(restantes);
  return {
    subidos,
    pendientesFinal: restantes.length,
    erroresDetalle,
  };
}

/** Días calendario desde inicio hasta hoy (inclusive), excluyendo domingos (plan diario en ruta / mora). */
function diasTranscurridosDesdeInicioExclDomingos(fechaInicio: string, hRef: string): number {
  const fi = new Date(`${String(fechaInicio).slice(0, 10)}T12:00:00`);
  const fin = new Date(`${hRef}T12:00:00`);
  if (Number.isNaN(fi.getTime()) || Number.isNaN(fin.getTime())) return 0;
  if (fin < fi) return 0;
  let n = 0;
  const d = new Date(fi);
  // La primera cuota vence al día siguiente del alta/aprobación.
  d.setDate(d.getDate() + 1);
  while (d <= fin) {
    if (d.getDay() !== 0) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

/**
 * Cuotas de atraso: plan Diario → max(0, min(días sin domingo − pagos efectivos, cuotas pendientes)).
 * Semanal/Mensual → cuotas consecutivas impagas cuyo vencimiento (planilla) es anterior a hoy.
 */
function cuotasDeAtrasoCredito(credito: Credito, pagos: PagoRegistro[], hRef: string): number {
  const planilla = generarPlanillaCredito(credito);
  const ctx = contextoCobroCredito(credito, pagos);
  const cuotasCompletas = ctx.cuotasCompletas;
  const pendientes = planilla.length - cuotasCompletas;
  if (pendientes <= 0) return 0;
  const u = plazoUnidadPlanillaCredito(credito);
  if (u === 'Días') {
    const dias = diasTranscurridosDesdeInicioExclDomingos(fechaBasePlanCuotasCredito(credito), hRef);
    return Math.max(0, Math.min(dias - cuotasCompletas, pendientes));
  }
  let c = 0;
  for (let i = cuotasCompletas; i < planilla.length; i++) {
    const vto = String(planilla[i].vencimiento).slice(0, 10);
    if (vto < hRef) c++;
    else break;
  }
  return c;
}

function esCreditoActivo(credito: Credito | null | undefined) {
  return ['ACTIVO', 'VIGENTE', 'APROBADO'].includes(String(credito?.estado || '').trim().toUpperCase());
}

/** Suma de montos de cuotas con vencimiento en la fecha indicada (típicamente hoy). */
function sumaMontosACobrarEnFechaCredito(credito: Credito, fechaRef: string): number {
  if (!esCreditoActivo(credito)) return 0;
  return redondearPesos(
    generarPlanillaCredito(credito)
      .filter(cu => String(cu.vencimiento).slice(0, 10) === fechaRef)
      .reduce((s, cu) => s + redondearPesos(Number(cu.monto) || 0), 0),
  );
}

function totalACobrarHoyDesdeCreditos(creditos: Credito[], fechaRef: string): number {
  return redondearPesos(creditos.reduce((s, c) => s + sumaMontosACobrarEnFechaCredito(c, fechaRef), 0));
}

function totalACobrarHoyCobrador(creditos: Credito[], cobradorKey: string, fechaRef: string): number {
  const k = String(cobradorKey || 'sin_usuario').trim();
  return redondearPesos(
    creditos
      .filter(c => String(c.cobrador_id ?? c.creado_por ?? 'sin_usuario').trim() === k)
      .reduce((s, c) => s + sumaMontosACobrarEnFechaCredito(c, fechaRef), 0),
  );
}

function efectividadCobroPorMonto(cobrado: number, aCobrar: number): number {
  const meta = redondearPesos(aCobrar);
  const real = redondearPesos(cobrado);
  if (meta <= 0) return real > 0 ? 100 : 0;
  return (real / meta) * 100;
}

function mapFilaCajaSupabase(row: Record<string, unknown>): MovimientoCaja {
  return {
    id: String(row.id ?? genId()),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    tipo: String(row.tipo ?? 'entrada') === 'salida' ? 'salida' : 'entrada',
    monto: redondearPesos(Number(row.monto ?? 0)),
    descripcion: String(row.descripcion ?? 'Movimiento de caja'),
    cobradorId: String(row.cobrador_id ?? 'sin_usuario'),
    clienteId: row.cliente_id != null ? String(row.cliente_id) : null,
    fichaId: row.ficha_id != null ? String(row.ficha_id) : null,
    pagoId: row.pago_id != null ? String(row.pago_id) : null,
  };
}

function mapSolicitudFondoCredito(row: Record<string, unknown>): SolicitudFondoCredito {
  const est = String(row.estado ?? 'pendiente').trim().toLowerCase();
  return {
    id: String(row.id ?? genId()),
    created_at: String(row.created_at ?? new Date().toISOString()),
    credito_id: String(row.credito_id ?? ''),
    cliente_id: String(row.cliente_id ?? ''),
    cobrador_id: String(row.cobrador_id ?? 'sin_usuario'),
    solicitante_email: row.solicitante_email != null ? String(row.solicitante_email) : null,
    solicitante_nombre: row.solicitante_nombre != null ? String(row.solicitante_nombre) : null,
    monto: redondearPesos(Number(row.monto ?? 0)),
    estado: est === 'fondado' || est === 'cancelado' ? est : 'pendiente',
    fondado_at: row.fondado_at != null ? String(row.fondado_at) : null,
  };
}

function creditoEstadoPendienteAprobacion(estado: string | null | undefined): boolean {
  const u = String(estado || '').trim().toUpperCase();
  return u === 'PENDIENTE' || u === 'PENDIENTE_APROBACION';
}

/** Solicitud de fondo solo si el crédito sigue pendiente de aprobación (no ACTIVO/FINALIZADO/etc.). */
function solicitudFondoCreditoVigente(
  sol: SolicitudFondoCredito,
  creditos: Credito[],
): boolean {
  if (sol.estado !== 'pendiente') return false;
  const cred = creditos.find(c => fichaIdUuid(c.id) === fichaIdUuid(sol.credito_id));
  if (!cred) return false;
  return creditoEstadoPendienteAprobacion(cred.estado);
}

/** Solo fondos ligados a créditos aún sin aprobar/rechazar (evita solicitudes huérfanas en Caja). */
function solicitudFondoCreditoVigenteParaAdmin(
  sol: SolicitudFondoCredito,
  creditos: Credito[],
  idsConEgresoPropia: Set<string>,
): boolean {
  if (idsConEgresoPropia.has(sol.id)) return false;
  return solicitudFondoCreditoVigente(sol, creditos);
}

function solicitudFondoCreditoEsHuerfana(sol: SolicitudFondoCredito, creditos: Credito[]): boolean {
  if (sol.estado !== 'pendiente') return false;
  const cred = creditos.find(c => fichaIdUuid(c.id) === fichaIdUuid(sol.credito_id));
  return !cred || !creditoEstadoPendienteAprobacion(cred.estado);
}

/** Sin cobranzas ni ingresos previos en caja del cobrador que crea el crédito. */
function cobradorSinRecaudadoEnCaja(
  cobradorId: string,
  pagos: PagoRegistro[],
  movimientos: MovimientoCaja[],
  authUserId: string | null,
  username: string | null,
  loginEmail: string | null,
): boolean {
  const cobradoPagos = pagos
    .filter(p => esPagoEfectivo(p) && esRegistroDelCobrador(p, authUserId, username, loginEmail))
    .reduce((s, p) => s + redondearPesos(Number(p.monto) || 0), 0);
  if (cobradoPagos > 0) return false;
  const k = String(cobradorId || authUserId || username || loginEmail || '').trim();
  const entradas = movimientos
    .filter(m => {
      if (m.tipo !== 'entrada' || m.monto <= 0) return false;
      const mc = String(m.cobradorId || '').trim();
      return mc === k || esRegistroDelCobrador({ cobradorId: mc, userId: mc } as PagoRegistro, authUserId, username, loginEmail);
    })
    .reduce((s, m) => s + m.monto, 0);
  return entradas <= 0;
}

function descripcionIngresoMarcosCredito(nombreCliente: string): string {
  const nom = (nombreCliente || 'cliente').trim();
  return `Ingreso de Marcos para crédito entregado — ${nom}`;
}

function mapMovimientoCajaPropia(row: Record<string, unknown>): MovimientoCajaPropia {
  return {
    id: String(row.id ?? genId()),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    fecha: String(row.fecha ?? hoy()).slice(0, 10),
    tipo: String(row.tipo ?? 'entrada') === 'salida' ? 'salida' : 'entrada',
    monto: redondearPesos(Number(row.monto ?? 0)),
    descripcion: String(row.descripcion ?? 'Movimiento caja propia'),
    nota: row.nota != null ? String(row.nota) : null,
    registradoPor: row.registrado_por != null ? String(row.registrado_por) : null,
    solicitudFondoId: row.solicitud_fondo_id != null ? String(row.solicitud_fondo_id) : null,
    cajaReferenciaId: row.caja_referencia_id != null ? String(row.caja_referencia_id) : null,
    rendicionId: row.rendicion_id != null ? String(row.rendicion_id) : null,
  };
}

function timestampDesdeFechaMov(fecha: string, ts?: string | number | null): number {
  if (ts != null && ts !== '') {
    const n = typeof ts === 'number' ? ts : new Date(String(ts)).getTime();
    if (Number.isFinite(n)) return n;
  }
  const f = String(fecha || '').slice(0, 10);
  return f ? new Date(`${f}T23:59:59`).getTime() : 0;
}

/** Movimiento del día visible en contadores de Marcos tras un cierre de día (mismo calendario). */
function perteneceContadorMarcosActivo(fecha: string, ts?: string | number | null, corteAt?: string | null): boolean {
  const h = hoy();
  const fd = String(fecha || '').slice(0, 10);
  if (fd !== h) return false;
  if (!corteAt) return true;
  const corteMs = new Date(corteAt).getTime();
  if (!Number.isFinite(corteMs)) return true;
  if (String(corteAt).slice(0, 10) !== h) return true;
  return timestampDesdeFechaMov(fd, ts) > corteMs;
}

function saldoCajaPropiaDesdeMovimientos(movs: MovimientoCajaPropia[]): number {
  return redondearPesos(
    movs.reduce((s, m) => s + (m.tipo === 'entrada' ? m.monto : -m.monto), 0),
  );
}

/** Saldo en servidor (evita doble egreso con estado local desactualizado). */
async function obtenerSaldoCajaPropiaDesdeDb(): Promise<number> {
  const { data, error } = await supabase.from('caja_propia_movimientos').select('tipo, monto');
  if (error) throw error;
  let saldo = 0;
  for (const row of data ?? []) {
    const r = row as { tipo?: string; monto?: number };
    const m = redondearPesos(Number(r.monto ?? 0));
    saldo += String(r.tipo ?? 'entrada') === 'salida' ? -m : m;
  }
  return redondearPesos(saldo);
}

/**
 * Ruta: crédito con estado ACTIVO y cuotas pendientes (pagos efectivos < cuotas totales).
 * Monto: suma de todas las cuotas aún no cubiertas según `generarPlanillaCredito` (sin exigir vto ≤ hoy).
 * Atraso: alguna cuota pendiente con vencimiento < hoy.
 */
function resumenCuotasRutaCredito(credito: Credito, pagos: PagoRegistro[]): {
  enRuta: boolean;
  montoPendienteVtoHastaHoy: number;
  tieneAtraso: boolean;
  siguienteCuotaNro: number | null;
  vencimientoSiguiente: string | null;
  cuotasDeAtraso: number;
} {
  const h = hoy();
  if (String(credito?.estado || '').trim().toUpperCase() !== 'ACTIVO') {
    return { enRuta: false, montoPendienteVtoHastaHoy: 0, tieneAtraso: false, siguienteCuotaNro: null, vencimientoSiguiente: null, cuotasDeAtraso: 0 };
  }
  const planilla = generarPlanillaCredito(credito);
  const ctx = contextoCobroCredito(credito, pagos);
  const cuotasTotales = Math.max(1, planilla.length);
  if (ctx.creditoFinalizado || ctx.cuotasCompletas >= cuotasTotales) {
    return { enRuta: false, montoPendienteVtoHastaHoy: 0, tieneAtraso: false, siguienteCuotaNro: null, vencimientoSiguiente: null, cuotasDeAtraso: 0 };
  }
  let monto = 0;
  let tieneAtraso = false;
  let pendientesConVtoHastaHoy = 0;
  for (let idx = ctx.cuotasCompletas; idx < planilla.length; idx++) {
    const cuo = planilla[idx];
    const vto = String(cuo.vencimiento).slice(0, 10);
    if (vto <= h) {
      monto += Number(cuo.monto) || 0;
      pendientesConVtoHastaHoy += 1;
    }
    if (vto < h) tieneAtraso = true;
  }
  const next = planilla[ctx.cuotasCompletas];
  const siguienteCuotaNro = ctx.cuotaActualNro ?? (next != null ? Number(next.nro) : null);
  const vencimientoSiguiente = next != null ? String(next.vencimiento).slice(0, 10) : null;
  const cuotasDeAtraso = cuotasDeAtrasoCredito(credito, pagos, h);
  return {
    enRuta: pendientesConVtoHastaHoy > 0,
    montoPendienteVtoHastaHoy: redondearPesos(monto),
    tieneAtraso,
    siguienteCuotaNro: Number.isFinite(siguienteCuotaNro) ? siguienteCuotaNro : null,
    vencimientoSiguiente,
    cuotasDeAtraso,
  };
}

function saldoDeudaCredito(credito: Credito, pagos: PagoRegistro[]): number {
  const montoTotal = redondearPesos(Number(credito.monto_total ?? credito.total_con_interes) || 0);
  const pagado = redondearPesos(
    pagosEfectivosCredito(pagos, credito.id).reduce((s, p) => s + redondearPesos(Number(p.monto) || 0), 0),
  );
  return Math.max(0, montoTotal - pagado);
}

function etiquetaPlanRutaDesdeCredito(c: Credito): 'DIARIO' | 'SEMANAL' | 'MENSUAL' {
  const u = plazoUnidadPlanillaCredito(c);
  if (u === 'Días') return 'DIARIO';
  if (u === 'Meses') return 'MENSUAL';
  return 'SEMANAL';
}

function pagosEfectivosCreditosClienteHoy(pagos: PagoRegistro[], creditoIds: string[], fechaRef: string): number {
  const ids = new Set(creditoIds.map(id => fichaIdUuid(id)));
  let sum = 0;
  for (const p of pagos) {
    if (!p.fichaId || !ids.has(fichaIdUuid(p.fichaId))) continue;
    if (!esPagoEfectivo(p)) continue;
    const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
    if (fd !== fechaRef) continue;
    sum += redondearPesos(Number(p.monto) || 0);
  }
  return sum;
}

type FilaRutaResumen = { credito: Credito; resumen: ReturnType<typeof resumenCuotasRutaCredito>; ficha: Ficha };

function visitaFallidaClienteHoy(visitas: VisitaFallida[], clienteId: string, fechaRef: string): boolean {
  const cid = normalizarId(clienteId);
  const d = String(fechaRef).slice(0, 10);
  return visitas.some(v => normalizarId(v.clienteId) === cid && String(v?.fecha ?? '').slice(0, 10) === d);
}

/** Amarillo: pendiente de visita. Rojo: visita sin cobro hoy. Verde: pago efectivo imputado hoy (cualquier crédito de la ruta del cliente). */
function semaforoRutaCliente(
  pagos: PagoRegistro[],
  visitasFallidas: VisitaFallida[],
  fechaRef: string,
  clienteId: string,
  filas: FilaRutaResumen[],
): 'rojo' | 'amarillo' | 'verde' {
  const ids = filas.map(f => f.credito.id);
  if (pagosEfectivosCreditosClienteHoy(pagos, ids, fechaRef) > 0) return 'verde';
  if (visitaFallidaClienteHoy(visitasFallidas, clienteId, fechaRef)) return 'rojo';
  return 'amarillo';
}

type ItemRutaGrupoBase = {
  cliente: Cliente;
  filas: FilaRutaResumen[];
  montoPendienteVtoHoy: number;
  tieneAtraso: boolean;
  distancia: number | null;
  saldoTotalDeuda: number;
  etiquetasPlan: Array<'DIARIO' | 'SEMANAL' | 'MENSUAL'>;
  creditoCobrar: Credito;
  fichaCobrar: Ficha;
  siguienteCuotaNro: number | null;
  vencimientoSiguiente: string | null;
  cuotasTexto: string;
  /** Fila generada para visita de captación (sin crédito real en BD); no abrir cobro/no pago. */
  esRutaCaptacionSinCreditoReal?: boolean;
};

type ItemRutaGrupo = ItemRutaGrupoBase & { semaforo: 'rojo' | 'amarillo' | 'verde' };

function cmpDistanciaOrdenNombreRuta(a: ItemRutaGrupoBase, b: ItemRutaGrupoBase): number {
  const da = a.distancia;
  const db = b.distancia;
  if (da != null && db != null && Number.isFinite(da) && Number.isFinite(db)) return da - db;
  if (da != null && Number.isFinite(da)) return -1;
  if (db != null && Number.isFinite(db)) return 1;
  const na = Number(a.cliente.orden_ruta);
  const nb = Number(b.cliente.orden_ruta);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  if (Number.isFinite(na) && !Number.isFinite(nb)) return -1;
  if (!Number.isFinite(na) && Number.isFinite(nb)) return 1;
  return String(nombreCompletoCliente(a.cliente) || '').localeCompare(String(nombreCompletoCliente(b.cliente) || ''), 'es');
}

function visitasFallidasClienteEnFecha(visitas: VisitaFallida[], clienteId: string, fechaD: string): VisitaFallida[] {
  const cid = normalizarId(clienteId);
  const d = String(fechaD).slice(0, 10);
  return visitas.filter(v => normalizarId(v.clienteId) === cid && String(v?.fecha ?? '').slice(0, 10) === d);
}

function pagosEfectivosCreditosRutaEnFecha(pagos: PagoRegistro[], filas: FilaRutaResumen[], fechaD: string): PagoRegistro[] {
  const ids = new Set(filas.map(f => fichaIdUuid(f.credito.id)));
  const d = String(fechaD).slice(0, 10);
  return pagos
    .filter(p => {
      if (!p.fichaId || !ids.has(fichaIdUuid(p.fichaId))) return false;
      if (!esPagoEfectivo(p)) return false;
      const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
      return fd === d;
    })
    .sort((a, b) => String(a.fechaPago || a.fecha || '').localeCompare(String(b.fechaPago || b.fecha || '')));
}

function textoTipoCobroPago(tipo: string | undefined): string {
  const t = String(tipo || '').toLowerCase();
  if (t === 'completo') return 'Cuota completa';
  if (t === 'parcial') return 'Pago parcial';
  return tipo ? String(tipo) : 'Cobro en efectivo';
}

function motivoVisitaFallidaLabel(motivo: VisitaFallida['motivo']): string {
  const map: Record<string, string> = {
    no_domicilio: 'No estaba en domicilio',
    sin_dinero: 'Sin dinero',
    promesa_pago: 'Promesa de pago',
    local_cerrado: 'Local cerrado',
  };
  return map[String(motivo)] || String(motivo);
}

function fichaParaComprobanteDesdePago(p: PagoRegistro, fichas: Ficha[], filas: FilaRutaResumen[]): Ficha | null {
  const fid = fichaIdUuid(p.fichaId);
  const fic = fichas.find(f => fichaIdUuid(f.id) === fid);
  if (fic) return fic;
  const row = filas.find(f => fichaIdUuid(f.credito.id) === fid);
  return row?.ficha ?? null;
}

function saldoTrasPagoHistorial(ficha: Ficha, pagos: PagoRegistro[], p: PagoRegistro): number {
  const fid = fichaIdUuid(p.fichaId);
  const ordenados = [...pagos]
    .filter(x => fichaIdUuid(x.fichaId) === fid && esPagoEfectivo(x))
    .sort((a, b) => String(a.fechaPago || a.fecha || '').localeCompare(String(b.fechaPago || b.fecha || '')));
  const idx = ordenados.findIndex(x => x.id === p.id);
  const hasta = idx < 0 ? ordenados : ordenados.slice(0, idx + 1);
  const totalPagado = hasta.reduce((s, x) => s + redondearPesos(Number(x.monto) || 0), 0);
  const cap = redondearPesos(Number(ficha.montoTotal ?? ficha.precioVenta ?? 0));
  return redondearPesos(Math.max(0, cap - totalPagado));
}

function comprobanteImagenDesdePago(p: PagoRegistro, cliente: Cliente, ficha: Ficha, pagos: PagoRegistro[]): ComprobantePagoImagen {
  return {
    cliente,
    ficha,
    monto: redondearPesos(Number(p.monto) || 0),
    saldoRestante: saldoTrasPagoHistorial(ficha, pagos, p),
    fechaPago: p.fechaPago || `${String(p.fecha || '').slice(0, 10)}T12:00:00.000Z`,
    cobradorId: String(p.cobradorId || p.userId || '—'),
  };
}

function abrirWazeCoordenadas(lat: number, lng: number) {
  if (typeof window !== 'undefined') {
    window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, '_blank', 'noopener,noreferrer');
  }
}

function abrirMapsPuntoGps(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    alert('No hay coordenadas guardadas para este registro.');
    return;
  }
  if (typeof window !== 'undefined') window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
}

type FilaCartonCreditoRow = {
  nro: number;
  vencimiento: string;
  fechaPagoDisplay: string;
  montoDisplay: string;
  cobrador: string;
  pagadaEfectiva: boolean;
  esNoPago: boolean;
  filaStyleBg: string;
};

function generarFilasCartonCreditoDetalle(credito: Credito, pagos: PagoRegistro[]): FilaCartonCreditoRow[] {
  const h = hoy();
  const planilla = generarPlanillaCredito(credito);
  const pe = pagosEfectivosCredito(pagos, credito.id);
  const noPagoPorCuota = new Map<number, PagoRegistro>();
  for (const p of pagos) {
    if (fichaIdUuid(p.fichaId) !== fichaIdUuid(credito.id)) continue;
    if (p.esRegistroNoPago && p.cuotaNumero != null) noPagoPorCuota.set(Number(p.cuotaNumero), p);
  }
  const cobradorLegible = (raw: unknown) => etiquetaCobradorMovimiento(String(raw || '').trim());
  return planilla.map((cuota, idx) => {
    const vto = String(cuota.vencimiento || '').slice(0, 10);
    const pagoEf = idx < pe.length ? pe[idx] : null;
    if (pagoEf) {
      const fechaPago = String(pagoEf.fechaPago || pagoEf.fecha || '').slice(0, 10);
      return {
        nro: cuota.nro,
        vencimiento: vto,
        fechaPagoDisplay: fechaPago,
        montoDisplay: fmt(Number(pagoEf.monto) || 0),
        cobrador: cobradorLegible(pagoEf.cobradorId ?? pagoEf.userId),
        pagadaEfectiva: true,
        esNoPago: false,
        filaStyleBg: '#dcfce7',
      };
    }
    const regNo = noPagoPorCuota.get(cuota.nro);
    const vencidaSinPagoEfectivo = vto < h;
    if (regNo || vencidaSinPagoEfectivo) {
      return {
        nro: cuota.nro,
        vencimiento: vto,
        fechaPagoDisplay: 'NO PAGO',
        montoDisplay: '$0',
        cobrador: regNo ? (cobradorLegible(regNo.cobradorId ?? regNo.userId) || 'Sistema') : '—',
        pagadaEfectiva: false,
        esNoPago: true,
        filaStyleBg: '#ffffff',
      };
    }
    return {
      nro: cuota.nro,
      vencimiento: vto,
      fechaPagoDisplay: '—',
      montoDisplay: '—',
      cobrador: '—',
      pagadaEfectiva: false,
      esNoPago: false,
      filaStyleBg: '#ffffff',
    };
  });
}

function filasHistorialCartonResumen(
  credito: Credito,
  pagos: PagoRegistro[],
): { id: string; fecha: string; cuota: string; importe: string; enRojo: boolean }[] {
  const pe = pagosEfectivosCredito(pagos, credito.id);
  const ordenados = ordenHistorialCartonCronologico(credito, pagos);
  return ordenados.map(p => {
    const fecha = String(p.fechaPago || p.fecha || '').slice(0, 10);
    let cuota: string;
    if (p.esRegistroNoPago && p.cuotaNumero != null) cuota = String(p.cuotaNumero);
    else if (esPagoEfectivo(p)) {
      const ix = pe.findIndex(x => x.id === p.id);
      cuota = ix >= 0 ? String(ix + 1) : '—';
    } else cuota = '—';
    const enRojo = Boolean(p.esRegistroNoPago) || redondearPesos(Number(p.monto) || 0) <= 0;
    const importe = p.esRegistroNoPago || !esPagoEfectivo(p) ? '$0' : fmt(Number(p.monto) || 0);
    return { id: p.id, fecha, cuota, importe, enRojo };
  });
}

/** Ficha mínima si falta la derivada del fetch (mismo id que `creditos.id` y `pagos.ficha_id`). */
function construirFichaRutaDesdeCredito(credito: Credito, pagos: PagoRegistro[]): Ficha {
  const cuotas = Math.max(1, Number(credito.cuotas ?? credito.plazo_cantidad) || 1);
  const montoTotal = redondearPesos(Number(credito.monto_total ?? credito.total_con_interes) || 0);
  const ctx = contextoCobroCredito(credito, pagos);
  const u = plazoUnidadPlanillaCredito(credito);
  const plan_pago: PlanPago = u === 'Días' ? 'Diario' : u === 'Meses' ? 'Mensual' : 'Quincenal';
  return {
    id: credito.id,
    clienteId: credito.cliente_id,
    tipo: 'prestamo',
    montoTotal,
    precioVenta: montoTotal,
    costo: redondearPesos(Number(credito.monto_solicitado) || 0),
    ganancia: Math.max(0, montoTotal - redondearPesos(Number(credito.monto_solicitado) || 0)),
    saldo: ctx.saldoCredito,
    cuotas,
    cuotasPagas: ctx.cuotasCompletas,
    cuotaMonto: ctx.montoFaltanteCuotaActual > 0 ? ctx.montoFaltanteCuotaActual : ctx.montoCuotaActual,
    total_pagado: ctx.totalPagado,
    producto: credito.detalle_mercaderia ?? '',
    fecha_inicio: String(credito.fecha_inicio || hoy()),
    fecha: String(credito.fecha_inicio || hoy()),
    estado: 'activa',
    plan_pago,
    pagos: [],
    Mora: 0,
    moraPorciento: M.moraPorciento,
  };
}

/** Ruta / listados: crédito activo se muestra al cobrador cuyo `cobrador_id` coincide con la sesión (UUID auth, usuario o email). Admin/root ven todo. */
function creditoVisibleParaSesion(
  credito: Credito,
  rol: string | null | undefined,
  authUserId: string | null | undefined,
  user: string | null | undefined,
  loginEmail: string | null | undefined,
): boolean {
  if (isAdminOrRoot(rol)) return true;
  const cid = String(credito.cobrador_id || credito.creado_por || '').trim();
  if (!cid) return true;
  const emailTrim = String(loginEmail ?? '').trim();
  const emailLocal = emailTrim.includes('@') ? emailTrim.split('@')[0] : '';
  const cand = new Set(
    [authUserId, user, loginEmail, emailLocal || null]
      .map(x => String(x ?? '').trim())
      .filter(Boolean),
  );
  const igual = (a: string, b: string) =>
    a === b || a.toLowerCase() === b.toLowerCase();
  return [...cand].some(x => igual(x, cid));
}

/** Candidatos para `cobrador_id.in.(…)` con la sesión: UUID de auth, email y username de `cp_session` (p. ej. cobrador1). */
function cobradorIdsParaFiltroSesion(session: { user?: { id?: string; email?: string } } | null): string[] {
  const uid = String(session?.user?.id ?? '').trim();
  const email = normalizarEmail(session?.user?.email);
  let username = '';
  try {
    const cp = typeof localStorage !== 'undefined' ? localStorage.getItem('cp_session') : null;
    if (cp) username = String(JSON.parse(cp).username ?? '').trim();
  } catch {
    username = '';
  }
  const perfil = resolverPerfilDesdeAuthEmail(email) || resolverPerfilDesdeEntradaLogin(username);
  const extras = idsReferenciaPerfil(perfil);
  return Array.from(new Set([uid, email, username, ...extras].filter(Boolean)));
}

/**
 * Valor para `clientes.cobrador_id` al crear/editar: prioriza UUID de auth (RLS y filtros usan el mismo criterio que `cobradorIdsParaFiltroSesion`).
 */
function cobradorIdDesdeSesionParaCliente(
  authUserId: string | undefined,
  session: { user?: { id?: string; email?: string } } | null | undefined,
  userState: string | null | undefined,
  loginEmailState: string | null | undefined,
): string {
  const aid = String(authUserId ?? '').trim();
  const sid = String(session?.user?.id ?? '').trim();
  if (esUuidClienteId(aid)) return aid;
  if (esUuidClienteId(sid)) return sid;
  const filtro = cobradorIdsParaFiltroSesion(session ?? null);
  const uuidFiltro = filtro.map(String).find(x => esUuidClienteId(x));
  if (uuidFiltro) return uuidFiltro.trim();
  return (
    aid
    || sid
    || filtro.map(String).find(Boolean)?.trim()
    || String(userState ?? '').trim()
    || String(loginEmailState ?? '').trim()
    || 'sin_usuario'
  );
}

function planPagoDeFicha(ficha: Ficha): PlanPago {
  const p = ficha.plan_pago;
  if (p === 'Diario' || p === 'Quincenal' || p === 'Mensual') return p;
  return 'Mensual';
}

function estadoFichaNormalizado(raw: unknown): Ficha['estado'] {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'finalizada') return 'cancelada';
  if (v === 'activo' || v === 'vigente' || v === 'aprobado') return 'activa';
  if (v === 'pendiente' || v === 'activa' || v === 'cancelada' || v === 'vencida') return v;
  return 'activa';
}

/** Último día del mes, i meses después del mes de inicio (1ª cuota = cierre del mes siguiente al de fecha). */
function vencimientoCierreMesFicha(fechaInicio: string, indiceCuota0: number): string {
  const base = new Date(fechaInicio);
  const ultimo = new Date(base.getFullYear(), base.getMonth() + indiceCuota0 + 2, 0);
  return ultimo.toISOString().split('T')[0];
}

/** Filas de planilla alineadas a cuotas, cuotaMonto y precioVenta de la ficha. */
function generarPlanillaFicha(ficha: Ficha): CuotaPlanilla[] {
  const plan = planPagoDeFicha(ficha);
  const n = Math.max(1, ficha.cuotas || 1);
  const total = redondearPesos(Number(ficha.precioVenta) || 0);
  const montosPorCuota = distribuirMontoEnCuotas(total, n);
  const cuotaRef = montosPorCuota[0] ?? redondearPesos(total / n);
  const inicio = ficha.fecha_inicio || ficha.fecha;
  const diasTranscurridos = Math.max(0, diffDias(hoy(), inicio));
  const tp = redondearPesos(Number(ficha.total_pagado ?? 0));
  let acumEsperado = 0;
  let pagas = 0;
  for (let i = 0; i < n; i++) {
    acumEsperado += montosPorCuota[i] ?? 0;
    if (tp >= acumEsperado) pagas = i + 1;
    else break;
  }
  return Array.from({ length: n }, (_, i) => {
    const nro = i + 1;
    let vencimiento: string;
    if (plan === 'Diario') vencimiento = addDias(inicio, i + 1);
    else if (plan === 'Quincenal') vencimiento = addDias(inicio, 15 * (i + 1));
    else vencimiento = vencimientoCierreMesFicha(inicio, i);
    const d = new Date(vencimiento);
    const esDomingo = plan === 'Diario' && d.getDay() === 0;
    const diasHastaVto = Math.max(0, diffDias(vencimiento, inicio));
    const vencida = diasTranscurridos >= diasHastaVto;
    const pagada = nro <= pagas;
    const pagadoIncluyeEsta = montosPorCuota.slice(0, nro).reduce((s, m) => s + m, 0);
    const saldo = Math.max(0, total - pagadoIncluyeEsta);
    const cuota = montosPorCuota[i] ?? cuotaRef;
    return { nro, vencimiento, monto: cuota, saldo, esDomingo, vencida, pagada };
  });
}

function productoFichaLabel(ficha: Ficha): string {
  const v = String((ficha as any)?.producto || (ficha as any)?.nombreProducto || '').trim();
  return v || 'Sin Informar';
}

function semaforoFicha(ficha: Ficha): { cardClass: string; metaLabel: string } {
  const pctPagado = ficha.precioVenta > 0 ? ((Number(ficha.total_pagado ?? 0) / ficha.precioVenta) * 100) : 0;
  if (ficha.estado === 'cancelada') {
    return { cardClass: 'from-red-500/15 to-red-600/5 border-red-500/35', metaLabel: 'Cancelada' };
  }
  if (pctPagado <= 10) {
    return { cardClass: 'from-emerald-500/15 to-emerald-600/5 border-emerald-500/35', metaLabel: `${pctPagado.toFixed(0)}% pagado` };
  }
  return { cardClass: 'from-amber-500/15 to-amber-600/5 border-amber-500/35', metaLabel: `${pctPagado.toFixed(0)}% pagado` };
}

function normalizarFechaOrden(fecha: string): number {
  const t = new Date(fecha || '').getTime();
  return Number.isFinite(t) ? t : 0;
}

function saldoRestanteFicha(ficha: Ficha): number {
  return redondearPesos(Math.max(0, Number(ficha.montoTotal ?? 0) - Number(ficha.total_pagado ?? 0)));
}

function construirEstadoCuentaPagos(ficha: Ficha, pagosFicha: PagoRegistro[]): EstadoCuentaPagoRow[] {
  const totalInicial = redondearPesos(Math.max(0, Number(ficha.precioVenta || ficha.montoTotal || 0)));
  let acumulado = 0;
  const ordenados = [...pagosFicha].sort((a, b) => {
    const d = normalizarFechaOrden(a.fecha) - normalizarFechaOrden(b.fecha);
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });
  return ordenados.map(p => {
    const montoMostrar = redondearPesos(Math.max(0, Number(p.monto) || 0));
    const sumaSaldo = esPagoEfectivo(p) ? montoMostrar : 0;
    acumulado += sumaSaldo;
    const saldoPositivo = redondearPesos(Math.max(0, totalInicial - acumulado));
    return {
      fecha: p.fecha || '',
      cobrador: p.esRegistroNoPago ? 'Sistema' : etiquetaCobradorMovimiento(String(p.cobradorId || p.userId || 'Sin informar')),
      montoCobrado: montoMostrar,
      saldoRestante: -saldoPositivo,
    };
  });
}

/** Estado de cuenta dinámico, compacto para previsualización móvil. */
async function crearEstadoCuentaPdf(ficha: Ficha, cliente: Cliente | null, pagosFicha: PagoRegistro[]): Promise<JsPDFDocument> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const totalInicial = redondearPesos(Math.max(0, Number(ficha.precioVenta || ficha.montoTotal || 0)));
  const rows = construirEstadoCuentaPagos(ficha, pagosFicha);
  const saldoPendientePositivo = rows.length > 0
    ? redondearPesos(Math.max(0, -rows[rows.length - 1].saldoRestante))
    : redondearPesos(Math.max(0, Number(ficha.saldo || totalInicial || 0)));
  const saldoPendienteNegativo = -saldoPendientePositivo;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('ESTADO DE CUENTA', 14, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Cliente: ${nombreCompletoCliente(cliente)} | Producto: ${productoFichaLabel(ficha)}`, 14, 21);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(185, 28, 28);
  doc.text(`Saldo Pendiente: ${fmt(saldoPendienteNegativo)}`, 14, 29);
  doc.setTextColor(20, 20, 20);

  let y = 38;
  const lh = 6;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('Fecha', 14, y);
  doc.text('Cobrador', 42, y);
  doc.text('Monto Cobrado', 98, y);
  doc.text('Saldo Restante', 146, y);
  y += lh;
  doc.setFont('helvetica', 'normal');

  if (rows.length === 0) {
    doc.text('Sin pagos registrados para esta ficha.', 14, y);
    y += lh;
  } else {
    for (const row of rows) {
      if (y > 284) {
        doc.addPage();
        y = 14;
      }
      doc.text(row.fecha || '-', 14, y);
      doc.text(row.cobrador.slice(0, 24), 42, y);
      doc.text(fmt(row.montoCobrado), 98, y);
      doc.text(fmt(row.saldoRestante), 146, y);
      y += lh;
    }
  }

  if (saldoPendientePositivo <= 0.0001) {
    y += 6;
    doc.setDrawColor(34, 197, 94);
    doc.setTextColor(21, 128, 61);
    doc.setLineWidth(0.8);
    doc.roundedRect(60, Math.max(20, y - 4), 90, 14, 2, 2, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('CUENTA CANCELADA', 71, Math.max(28, y + 5));
    doc.setTextColor(20, 20, 20);
  }

  const paginas = doc.getNumberOfPages();
  for (let p = 1; p <= paginas; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(12, 74, 110);
    doc.text(`${MARCA_PRIMARIA} · ${MARCA_DESCRIPTOR}`, 105, 289, { align: 'center' });
  }

  return doc;
}

const HABILES = [1, 2, 3, 4, 5]; // Lunes a viernes
function proxDiaHabil(fecha: string): string {
  let d = new Date(fecha);
  while (!HABILES.includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

class SectionErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    // Evita que errores de una seccion rompan toda la app.
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-gray-900/60 border border-red-500/30 rounded-2xl p-4 text-center">
          <p className="text-red-300 font-semibold">Hubo un problema al cargar esta sección. Reintentar</p>
          <button
            onClick={this.handleRetry}
            className="mt-3 px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/40 text-red-200 text-sm font-semibold hover:bg-red-500/30 transition"
          >
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Haversine
function calcularDistancia(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCpDataV2(): Record<string, unknown> | null {
  try {
    const stored = localStorage.getItem('cp_data_v2');
    return stored ? (JSON.parse(stored) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getInitData(): AppMeta {
  const d = parseCpDataV2();
  const interesMStored = typeof window !== 'undefined' ? window.localStorage.getItem('cp_interes_credito_m') : null;
  const interesPStored = typeof window !== 'undefined' ? window.localStorage.getItem('cp_interes_credito_p') : null;
  const interesM = interesMStored != null && interesMStored !== '' && !Number.isNaN(parseFloat(interesMStored)) ? parseFloat(interesMStored) : undefined;
  const interesP = interesPStored != null && interesPStored !== '' && !Number.isNaN(parseFloat(interesPStored)) ? parseFloat(interesPStored) : undefined;
  if (d) {
    let cfg = configDesdeCacheLocal((d.config as Partial<Config>) || undefined);
    if (interesM != null) cfg = { ...cfg, interesCreditoM: interesM };
    if (interesP != null) cfg = { ...cfg, interesCreditoP: interesP };
    return {
      cierres: (d.cierres as AppMeta['cierres']) || [],
      logs: (d.logs as AppMeta['logs']) || [],
      config: cfg,
      cierresJornada: (d.cierresJornada as AppMeta['cierresJornada']) || [],
      visitasFallidas: (d.visitasFallidas as AppMeta['visitasFallidas']) || [],
    };
  }
  return {
    cierres: [],
    logs: [],
    config: {
      ...M,
      ...(interesM != null ? { interesCreditoM: interesM } : {}),
      ...(interesP != null ? { interesCreditoP: interesP } : {}),
    },
    cierresJornada: [],
    visitasFallidas: [],
  };
}

// ==========================================
// APP
// ==========================================
export default function App() {
  // --- LÓGICA DE PERSISTENCIA PARA DATOS ---
  const cargar = (key: string, def: any) => {
    const data = window.localStorage.getItem(key); // Agregamos 'window.' para más seguridad
    return data ? JSON.parse(data) : def;
  };

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [fichas, setFichas] = useState<Ficha[]>([]);
  const [pagos, setPagos] = useState<PagoRegistro[]>([]);
  const [creditos, setCreditos] = useState<Credito[]>([]);
  const [cartonesCredito, setCartonesCredito] = useState<Record<string, string>>(() => cargar('cp_cartones_credito', {} as Record<string, string>));
  const [notificaciones, setNotificaciones] = useState<Notificacion[]>([]);
  const [movimientosCaja, setMovimientosCaja] = useState<MovimientoCaja[]>([]);
  const [solicitudesFondoCredito, setSolicitudesFondoCredito] = useState<SolicitudFondoCredito[]>([]);
  const [guardandoFondoCreditoId, setGuardandoFondoCreditoId] = useState<string | null>(null);
  const [movimientosCajaPropia, setMovimientosCajaPropia] = useState<MovimientoCajaPropia[]>([]);
  const [formMovCajaPropia, setFormMovCajaPropia] = useState<{
    tipo: 'entrada' | 'salida';
    monto: string;
    nota: string;
    fecha: string;
  }>({ tipo: 'entrada', monto: '', nota: '', fecha: hoy() });
  const [guardandoMovCajaPropia, setGuardandoMovCajaPropia] = useState(false);
  const [guardandoBorrarCajaPropia, setGuardandoBorrarCajaPropia] = useState(false);
  const [gastos, setGastos] = useState<Gasto[]>(() => {
    const v = cargar('cp_gas', [] as Gasto[]);
    if (Array.isArray(v) && v.length) return v;
    const d = parseCpDataV2();
    const leg = d?.gastos as Gasto[] | undefined;
    return Array.isArray(leg) ? leg : [];
  });
  const [auditoria] = useState<any[]>(() => cargar('cp_aud', []));

  useEffect(() => {
    localStorage.setItem('cp_fic', JSON.stringify(fichas));
    localStorage.setItem('cp_gas', JSON.stringify(gastos));
    localStorage.setItem('cp_aud', JSON.stringify(auditoria));
    localStorage.setItem('cp_cartones_credito', JSON.stringify(cartonesCredito));
  }, [fichas, gastos, auditoria, cartonesCredito]);
  useEffect(() => {
    // Evita que caches legacy del navegador muestren contadores/listas que ya no existen en Supabase.
    localStorage.removeItem('cp_fic');
    localStorage.removeItem('cp_gas');
    setFichas([]);
    setGastos([]);
  }, []);
  // -----------------------------------------
  const [data, setData] = useState<AppMeta>(getInitData);
  const { cierresJornada } = data;
  const [user, setUser] = useState<string | null>(null);
  /** UUID de Supabase Auth; alinear cobros/gastos/rendiciones por cobrador. */
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState<string | null>(null);
  /** user_metadata de Supabase Auth (full_name, etc.) para el saludo. */
  const [authUserMeta, setAuthUserMeta] = useState<Record<string, unknown> | null>(null);
  const [rol, setRol] = useState<string | null>(null);
  const [page, setPage] = useState<string>('login');
  const [subTabRendicion, setSubTabRendicion] = useState<'pendientes' | 'historial'>('pendientes');
  const [sessionReady, setSessionReady] = useState(() => typeof window === 'undefined' || !window.localStorage.getItem('cp_session'));
  const [loading, setLoading] = useState(false);
  const fetchSeqRef = useRef(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showSplash, setShowSplash] = useState(true);
  const [splashMs, setSplashMs] = useState(0);

  // Filters & Search
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [menuPerfilAbierto, setMenuPerfilAbierto] = useState(false);
  const menuPerfilRef = useRef<HTMLDivElement | null>(null);
  const [mVistaRapidaSistema, setMVistaRapidaSistema] = useState(false);
  /** Trial solo usuario demo `prueba` (columna usuarios.trial_fin, validado en servidor). */
  const [trialFinPrueba, setTrialFinPrueba] = useState<string | null>(null);

  // Modals
  const [mCliente, setMCliente] = useState<Partial<Cliente> | null>(null);
  /** Evita remount del formulario al actualizar GPS u otros campos en el padre; solo cambia al abrir «Nuevo cliente». */
  const [clienteModalNonce, setClienteModalNonce] = useState(0);
  const [mPago, setMPago] = useState<{ ficha: Ficha; cliente: Cliente } | null>(null);
  const [registrandoPago, setRegistrandoPago] = useState(false);
  /** Admin: proceso de subir cola cp_cobros_pendientes_v1. */
  const [forzandoSubidaCobrosLocales, setForzandoSubidaCobrosLocales] = useState(false);
  const [bannerCobroRed, setBannerCobroRed] = useState<string | null>(null);
  const [bannerGpsInstrucciones, setBannerGpsInstrucciones] = useState<string | null>(null);
  const [mFicha, setMFicha] = useState<{ cliente: Cliente; ficha?: Ficha } | null>(null);
  const [mGasto, setMGasto] = useState<Partial<Gasto> | null>(null);
  const [mCierre, setMCierre] = useState<Partial<Cierre> | null>(null);
  const [mJornada, setMJornada] = useState(false);
  const [mNoPago, setMNoPago] = useState<{ ficha: Ficha; cliente: Cliente } | null>(null);
  const [mAuditoria, setMAuditoria] = useState(false);
  const [logsAuditoriaRemotos, setLogsAuditoriaRemotos] = useState<LogAuditoriaRemoto[]>([]);
  const [logsAuditoriaLoading, setLogsAuditoriaLoading] = useState(false);
  const [logsAuditoriaDesde, setLogsAuditoriaDesde] = useState('');
  const [logsAuditoriaHasta, setLogsAuditoriaHasta] = useState('');
  const [logsAuditoriaActor, setLogsAuditoriaActor] = useState('');
  const [logsAuditoriaCreditoId, setLogsAuditoriaCreditoId] = useState('');
  const [mCierreCajaResumen, setMCierreCajaResumen] = useState<string | null>(null);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [inversionesProveedor, setInversionesProveedor] = useState<InversionProveedor[]>([]);
  const [proveedorLocal, setProveedorLocal] = useState<Proveedor | null>(null);
  const [mNuevoProveedor, setMNuevoProveedor] = useState(false);
  const [mCredencialesProveedor, setMCredencialesProveedor] = useState<{
    nombre: string;
    login: string;
    password: string;
  } | null>(null);
  const [formNuevoProv, setFormNuevoProv] = useState({ nombre: '', login: '', telefono: '' });
  const [formIngresoExt, setFormIngresoExt] = useState({ proveedorId: '', monto: '', nota: '', fecha: hoy() });
  const [guardandoIngresoExt, setGuardandoIngresoExt] = useState(false);
  const [guardandoProveedor, setGuardandoProveedor] = useState(false);
  const [mDetalleCliente, setMDetalleCliente] = useState<Cliente | null>(null);
  /** Tras aprobación / notificación: resaltar envío de cartón por WhatsApp para este crédito. */
  const [cartonDestacarCreditoId, setCartonDestacarCreditoId] = useState<string | null>(null);
  const deepLinkCreditoAtendidoRef = useRef<string | null>(null);
  const urlCreditoInicialAplicadoRef = useRef(false);
  /** Evita doble clic antes de que React deshabilite el botón (caja propia / fondo crédito). */
  const fondoCreditoProcesandoRef = useRef<Set<string>>(new Set());
  const movCajaPropiaProcesandoRef = useRef(false);
  const aceptarRendicionProcesandoRef = useRef<Set<string>>(new Set());
  const [mComprobanteImagen, setMComprobanteImagen] = useState<ComprobantePagoImagen | null>(null);
  const comprobanteTicketRef = useRef<HTMLDivElement | null>(null);
  const [mRuta, setMRuta] = useState(false);
  const [mNotificaciones, setMNotificaciones] = useState(false);
  const [mQrScan, setMQrScan] = useState(false);
  const [mCreditoTipo, setMCreditoTipo] = useState<'M' | 'P' | null>(null);
  const [configTasasMensual, setConfigTasasMensual] = useState<ConfigTasasMensual>(() => leerConfigTasasMensual());
  const [mAjusteTasaMensual, setMAjusteTasaMensual] = useState(false);
  /** Tras crear crédito como MatiasM/Vendedor: splash bloqueante hasta abrir WhatsApp al admin. */
  const [exitoCreditoCobradorWa, setExitoCreditoCobradorWa] = useState<{
    linkWhatsapp: string;
    waAbierto: boolean;
  } | null>(null);
  const [mCreditoRevision, setMCreditoRevision] = useState<Credito | null>(null);
  /** Lista para el selector de cobrador en revisión (solo admin/root): `usuarios` con rol cobrador. */
  const [cobradoresRevision, setCobradoresRevision] = useState<Array<{ valor: string; label: string }>>([]);
  const [vendedoresComisionAdmin, setVendedoresComisionAdmin] = useState<VendedorComisionResumen[]>([]);
  const [liquidandoComisionId, setLiquidandoComisionId] = useState<string | null>(null);
  const [marcosConfigTab, setMarcosConfigTab] = useState<'ajustes' | 'comisiones'>('ajustes');
  const [guardandoPctComisionId, setGuardandoPctComisionId] = useState<string | null>(null);
  const [aprobandoComisionCreditoId, setAprobandoComisionCreditoId] = useState<string | null>(null);
  const [eliminandoComisionCreditoId, setEliminandoComisionCreditoId] = useState<string | null>(null);
  const [eliminandoCreditoId, setEliminandoCreditoId] = useState<string | null>(null);
  const [mPlanilla, setMPlanilla] = useState<{ tipo: 'ficha'; ficha: Ficha; cliente: Cliente } | { tipo: 'credito'; credito: Credito; cliente: Cliente | null } | null>(null);
  const [cartonSharePayload, setCartonSharePayload] = useState<CartonSharePayload | null>(null);
  const cartonShareRef = useRef<HTMLDivElement | null>(null);
  const [filtroPendientesCredito, setFiltroPendientesCredito] = useState<'pendientes' | 'procesados'>('pendientes');

  const limpiarDeepLinkCredito = useCallback(() => {
    setCreditoIdEnUrl(null);
    setCartonDestacarCreditoId(null);
    deepLinkCreditoAtendidoRef.current = null;
  }, []);

  // GPS
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsPos, setGpsPos] = useState<{ lat: number; lng: number } | null>(null);

  // Tab state for FichaForm
  const [tab, setTab] = useState(0);
  const [estadoQr, setEstadoQr] = useState('Preparando cámara...');
  const qrInstanceRef = useRef<any>(null);

  const logsAuditoriaFiltrados = useMemo(() => {
    const desde = logsAuditoriaDesde ? String(logsAuditoriaDesde).slice(0, 10) : '';
    const hasta = logsAuditoriaHasta ? String(logsAuditoriaHasta).slice(0, 10) : '';
    const actorQ = logsAuditoriaActor.trim().toLowerCase();
    const creditoQ = logsAuditoriaCreditoId.trim().toLowerCase();
    return logsAuditoriaRemotos.filter(log => {
      const f = String(log.created_at || '').slice(0, 10);
      if (desde && f < desde) return false;
      if (hasta && f > hasta) return false;
      if (actorQ) {
        const actor = String(log.actor ?? '').toLowerCase();
        if (!actor.includes(actorQ)) return false;
      }
      if (creditoQ) {
        const contexto = String(log.contexto ?? '').toLowerCase();
        const msg = String(log.mensaje_error ?? '').toLowerCase();
        const payload = JSON.stringify(log.datos_enviados ?? {}).toLowerCase();
        if (!contexto.includes(creditoQ) && !msg.includes(creditoQ) && !payload.includes(creditoQ)) return false;
      }
      return true;
    });
  }, [logsAuditoriaRemotos, logsAuditoriaDesde, logsAuditoriaHasta, logsAuditoriaActor, logsAuditoriaCreditoId]);

  /** Listas seguras para .map/.find (evita crash si el estado llegó null/undefined). */
  const clientesOrEmpty = Array.isArray(clientes) ? clientes : [];
  const creditosOrEmpty = Array.isArray(creditos) ? creditos : [];
  const pagosOrEmpty = Array.isArray(pagos) ? pagos : [];
  const visitasFallidasOrEmpty = Array.isArray(data.visitasFallidas) ? data.visitasFallidas : [];
  const fichasOrEmpty = Array.isArray(fichas) ? fichas : [];
  const notificacionesOrEmpty = Array.isArray(notificaciones) ? notificaciones : [];

  const esUsuarioRootOperadorSesion = useMemo(
    () => esUsuarioRootOperador(user, loginEmail),
    [user, loginEmail],
  );
  const esMarcosOperadorSesion = useMemo(
    () => esUsuarioMarcosOperador(user, loginEmail),
    [user, loginEmail],
  );
  const actorChequesSesion = useMemo(
    () => nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    }),
    [loginEmail, user, authUserMeta],
  );
  const esMarcosPUsuario = useMemo(
    () => esUsuarioMarcosP({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    }),
    [loginEmail, user, authUserMeta],
  );
  const esSesionUsuarioPrueba = useMemo(
    () => esUsuarioPruebaSesion(user, loginEmail),
    [user, loginEmail],
  );
  const sistemaBloqueadoTrial = useMemo(
    () => esSesionUsuarioPrueba && trialExpirado(trialFinPrueba),
    [esSesionUsuarioPrueba, trialFinPrueba],
  );
  const puedeOperarSistema = !sistemaBloqueadoTrial;
  const esMatiasOVendedorUsuario = useMemo(
    () => esUsuarioCobradorMatiasOVendedor({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    }),
    [loginEmail, user, authUserMeta],
  );
  const esUsuarioVendedorSesion = useMemo(
    () => esUsuarioVendedorPorIdentidad({
      loginEmail,
      usernameState: user,
      rol,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    }),
    [loginEmail, user, rol, authUserMeta],
  );
  const esProveedorUsuario = useMemo(() => esProveedorSesion(rol), [rol]);
  const esUsuarioMensualUsuario = useMemo(() => esUsuarioMensualSesion(rol), [rol]);
  const proveedorSesion = useMemo(() => {
    if (proveedorLocal) return proveedorLocal;
    if (!esProveedorUsuario) return null;
    const email = normalizarEmail(loginEmail);
    return proveedores.find(p => normalizarEmail(p.auth_email) === email) ?? null;
  }, [proveedorLocal, esProveedorUsuario, proveedores, loginEmail]);
  const misInversionesProveedor = useMemo(() => {
    if (!proveedorSesion) return [];
    return inversionesProveedor.filter(i => i.proveedor_id === proveedorSesion.id && i.estado === 'activa');
  }, [proveedorSesion, inversionesProveedor]);
  const inversionesExternasAdmin = useMemo(() => {
    return inversionesProveedor
      .filter(i => i.estado === 'activa')
      .map(inv => ({
        ...inv,
        proveedor: proveedores.find(p => p.id === inv.proveedor_id),
      }));
  }, [inversionesProveedor, proveedores]);

  useEffect(() => {
    if (esProveedorUsuario && page !== 'mi_inversion' && page !== 'login') {
      setPage('mi_inversion');
    }
  }, [esProveedorUsuario, page]);

  useEffect(() => {
    if (esUsuarioMensualUsuario && page !== 'login' && !PAGINAS_MODULO_MENSUAL.has(page)) {
      setPage('dashboard');
    }
  }, [esUsuarioMensualUsuario, page]);

  type SavePatch = Partial<AppMeta> & Partial<{ clientes: Cliente[]; fichas: Ficha[]; gastos: Gasto[] }>;

  const save = useCallback((upd: SavePatch) => {
    if (
      sistemaBloqueadoTrial
      && (upd.clientes !== undefined || upd.fichas !== undefined || upd.gastos !== undefined || upd.config !== undefined)
    ) {
      alert(MSG_TRIAL_EXPIRADO);
      return;
    }
    if (upd.clientes !== undefined) setClientes(Array.isArray(upd.clientes) ? upd.clientes : []);
    if (upd.fichas !== undefined) setFichas(Array.isArray(upd.fichas) ? upd.fichas : []);
    if (upd.gastos !== undefined) setGastos(Array.isArray(upd.gastos) ? upd.gastos : []);
    const { clientes: _c, fichas: _f, gastos: _g, ...meta } = upd;
    setData(prev => {
      const next = { ...prev, ...meta };
      if (next.config) {
        const c = next.config as Config;
        if (typeof c.interesCreditoM === 'number' && Number.isFinite(c.interesCreditoM)) {
          localStorage.setItem('cp_interes_credito_m', String(c.interesCreditoM));
        }
        if (typeof c.interesCreditoP === 'number' && Number.isFinite(c.interesCreditoP)) {
          localStorage.setItem('cp_interes_credito_p', String(c.interesCreditoP));
        }
      }
      localStorage.setItem('cp_data_v2', JSON.stringify(next));
      return next;
    });
  }, [sistemaBloqueadoTrial]);

  // Audit
  const audit = useCallback(( accion: AuditAction, detalle: string, gps?: { lat: number; lng: number } ) => {
    registrarAuditoria(accion, detalle, gps);
  }, []);
  const logAuditDb = useCallback(async (accion: string, detalle: string) => {
    const actor = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    await supabase.from('audit_logs').insert([{ actor: actor || 'sistema', accion, detalle }]);
  }, [user, loginEmail, authUserMeta]);

  const fetchData = useCallback(async (opts?: { silencioso?: boolean }): Promise<{ clientes: Cliente[] } | undefined> => {
    const seq = ++fetchSeqRef.current;
    const silencioso = Boolean(opts?.silencioso);
    if (!silencioso) setLoading(true);
    try {
      const provToken = typeof localStorage !== 'undefined' ? localStorage.getItem(CP_PROVEEDOR_TOKEN_KEY) : null;
      let sesionLocalProveedor = false;
      try {
        const cp = typeof localStorage !== 'undefined' ? localStorage.getItem('cp_session') : null;
        if (cp) {
          const parsed = JSON.parse(cp) as { rol?: string; local?: boolean };
          sesionLocalProveedor = parsed.rol === 'proveedor' && parsed.local === true;
        }
      } catch {
        sesionLocalProveedor = false;
      }
      if (provToken && sesionLocalProveedor) {
        const inv = await fetchInversionesProveedorToken(provToken);
        setInversionesProveedor(inv);
        return undefined;
      }

      const { data: authWrap } = await supabase.auth.getSession();
      const session = authWrap?.session ?? null;

      let rolFetch: string | null = null;
      try {
        const cp = typeof localStorage !== 'undefined' ? localStorage.getItem('cp_session') : null;
        if (cp) rolFetch = rolNormalizadoDb(JSON.parse(cp).rol);
      } catch {
        rolFetch = 'cobrador';
      }

      const emailSesionFetch = normalizarEmail(session?.user?.email);
      /** Admin en panel: sin filtrar por cobrador (usa rol en estado, localStorage y correo MarcosP). */
      const verTodosLosCreditos =
        isAdminOrRoot(rolFetch)
        || isAdminOrRoot(rol)
        || resolverPerfilDesdeAuthEmail(emailSesionFetch)?.esAdmin === true;

      if (verTodosLosCreditos) {
        void supabase.rpc('purge_videos_verificacion_clientes_expirados').then(({ error: errPurge }) => {
          if (errPurge) devWarn('purge_videos_verificacion_clientes_expirados:', errPurge);
        });
      }

      const cobradorIdsFilter = !verTodosLosCreditos ? cobradorIdsParaFiltroSesion(session) : [];
      const ambitoFetch = ambitoDatosSesion(rolFetch || rol);

      /** Clientes: misma cartera para admin, cobrador y vendedor (sin filtro por rol). */
      const clientesQuery = supabase.from('clientes').select('*').eq('ambito', ambitoFetch).order('created_at', { ascending: false });
      let pagosQuery = supabase.from('pagos').select('*').eq('ambito', ambitoFetch).order('fecha_pago', { ascending: false });
      let gastosQuery = supabase.from('gastos').select('*').order('fecha', { ascending: false });
      let creditosQuery = supabase.from('creditos').select('*').eq('ambito', ambitoFetch).order('created_at', { ascending: false });
      if (esUsuarioMensualSesion(rolFetch || rol)) {
        gastosQuery = supabase.from('gastos').select('*').limit(0);
      } else if (!verTodosLosCreditos) {
        if (cobradorIdsFilter.length === 0) {
          pagosQuery = supabase.from('pagos').select('*').limit(0);
          gastosQuery = supabase.from('gastos').select('*').limit(0);
          creditosQuery = supabase.from('creditos').select('*').limit(0);
        } else {
          pagosQuery = pagosQuery.in('cobrador_id', cobradorIdsFilter);
          gastosQuery = gastosQuery.in('cobrador_id', cobradorIdsFilter);
          creditosQuery = creditosQuery.in('cobrador_id', cobradorIdsFilter);
        }
      }

      const [
        { data: clientesDb, error: clientesErr },
        { data: pagosDb, error: pagosErr },
        { data: creditosDb, error: creditosErr },
        { data: notiDb, error: notiErr },
        { data: gastosDb, error: gastosErr },
        { data: configDb, error: configErr },
      ] = await Promise.all([
        clientesQuery,
        pagosQuery,
        creditosQuery,
        supabase.from('notificaciones').select('*').order('created_at', { ascending: false }),
        gastosQuery,
        supabase.from('configuracion').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      if (clientesErr) console.error('Supabase fetch clientes error:', clientesErr);
      if (pagosErr) console.error('Supabase fetch pagos error:', pagosErr);
      if (creditosErr) console.error('Supabase fetch creditos error:', creditosErr);
      if (notiErr) console.error('Supabase fetch notificaciones error:', notiErr);
      if (gastosErr) {
        const ge = gastosErr as { message?: string; code?: string; status?: number };
        devWarn('Supabase fetch gastos warning (p. ej. tabla 404 o sin permiso). Se usa $0 salvo gastos locales pendientes de sincronizar.', ge.message || gastosErr);
        setGastos(prev => (Array.isArray(prev) ? prev.filter(g => g && !g.sync) : []));
      }
      if (configErr) console.error('Supabase fetch configuracion error:', configErr);
      if (seq !== fetchSeqRef.current) return undefined;
      const mappedClientes = Array.isArray(clientesDb)
        ? (clientesDb as Record<string, unknown>[]).map(c => mapClienteFilaSupabase(c))
        : [];
      setClientes(mappedClientes);
      const creditosNormalizados = Array.isArray(creditosDb) ? (creditosDb as any[]).map((c): Credito => {
        const planRaw = String(c?.plan ?? '').trim();
        const plazo_unidad = normalizarPlazoUnidad(planRaw || 'Diario');
        const cuotas = Math.max(1, Number(c?.cuotas ?? c?.plazo_cantidad ?? 1));
        const montoTotal = redondearPesos(Number(c?.monto_total ?? c?.total_con_interes ?? c?.monto_solicitado ?? 0));
        return {
          id: String(c?.id ?? '').trim(),
          nro_carton: String(c?.nro_carton ?? c?.nroCarton ?? ''),
          cliente_id: String(c?.cliente_id ?? '').trim(),
          tipo: c?.tipo ?? 'P',
          monto_solicitado: redondearPesos(Number(c?.monto_solicitado ?? 0)),
          monto_total: montoTotal,
          detalle_mercaderia: c?.detalle_mercaderia ?? null,
          fecha_inicio: String(c?.fecha_inicio ?? hoy()),
          cuotas,
          plan: planRaw || planEtiquetaDesdePlazoUnidad(plazo_unidad),
          plazo_unidad,
          plazo_cantidad: cuotas,
          total_con_interes: montoTotal,
          estado: String(c?.estado ?? 'PENDIENTE').trim().toUpperCase() as Credito['estado'],
          interes_aplicado: Number(c?.interes_aplicado ?? 30),
          creado_por: c?.creado_por ?? c?.cobrador_id ?? null,
          cobrador_id: c?.cobrador_id ?? c?.creado_por ?? null,
          created_at: c?.created_at,
          inicio_cuotas_modo: (c?.inicio_cuotas_modo as Credito['inicio_cuotas_modo']) ?? 'A_FECHA',
          fecha_inicio_cuotas_post: c?.fecha_inicio_cuotas_post != null ? String(c.fecha_inicio_cuotas_post).slice(0, 10) : null,
          cobrador_notif_email: c?.cobrador_notif_email != null ? String(c.cobrador_notif_email).trim() : null,
          es_retroactivo: Boolean(c?.es_retroactivo),
          vendedor_id: c?.vendedor_id != null ? String(c.vendedor_id) : null,
          comision_vendedor: redondearPesos(Number(c?.comision_vendedor ?? 0)),
          comision_liquidada: Boolean(c?.comision_liquidada),
          comision_aprobada_admin: Boolean(c?.comision_aprobada_admin),
          porcentaje_comision_credito: Number(c?.porcentaje_comision_credito ?? 0) || undefined,
        };
      }) : [];
      const pagosRaw = Array.isArray(pagosDb) ? (pagosDb as any[]) : [];
      setFichas(creditosNormalizados
        .filter(c => ['ACTIVO', 'VIGENTE', 'APROBADO'].includes(String(c.estado || '').toUpperCase()))
        .map(c => {
          const pagosCredito = pagosRaw.filter(p => fichaIdUuid(p?.ficha_id ?? p?.fichaId) === fichaIdUuid(c.id));
          const pagosEfectivos = pagosCredito.filter(p => !p?.es_registro_no_pago && redondearPesos(Number(p?.monto) || 0) > 0);
          const pagosParaCtx: PagoRegistro[] = pagosEfectivos.map(p => ({
            id: String(p?.id ?? ''),
            clienteId: String(c.cliente_id ?? ''),
            fichaId: fichaIdUuid(c.id),
            fecha: String(p?.fecha_pago ?? p?.fecha ?? hoy()).slice(0, 10),
            monto: redondearPesos(Number(p?.monto) || 0),
            dia: 0,
            tipo: 'completo',
            fechaPago: p?.fecha_pago ?? p?.fecha,
            esRegistroNoPago: false,
          }));
          const ctxFicha = contextoCobroCredito(c, pagosParaCtx);
          const montoTotal = redondearPesos(Number(c.monto_total ?? c.total_con_interes ?? 0));
          const cuotas = Math.max(1, Number(c.cuotas ?? c.plazo_cantidad) || 1);
          const costoSol = redondearPesos(Number(c.monto_solicitado ?? 0));
          return {
            id: c.id,
            nro_ficha: c.id.slice(-5).toUpperCase(),
            clienteId: c.cliente_id,
            tipo: 'prestamo' as const,
            montoTotal,
            precioVenta: montoTotal,
            costo: costoSol,
            ganancia: Math.max(0, montoTotal - costoSol),
            saldo: ctxFicha.saldoCredito,
            cuotas,
            cuotasPagas: ctxFicha.cuotasCompletas,
            cuotaMonto: ctxFicha.montoFaltanteCuotaActual > 0
              ? ctxFicha.montoFaltanteCuotaActual
              : (cuotas > 0 ? montoCuotaCreditoDesdeTotal(montoTotal, cuotas) : montoTotal),
            total_pagado: ctxFicha.totalPagado,
            producto: c.detalle_mercaderia || `Crédito ${c.plan || ''}`.trim(),
            fecha_inicio: c.fecha_inicio || hoy(),
            fecha: c.fecha_inicio || hoy(),
            estado: estadoFichaNormalizado(c.estado),
            plan_pago: ((): PlanPago => {
              const u = normalizarPlazoUnidad(c.plan || 'Diario');
              if (u === 'Días') return 'Diario';
              if (u === 'Meses') return 'Mensual';
              return 'Quincenal';
            })(),
            pagos: pagosCredito.map(p => ({
              fecha: String(p?.fecha_pago ?? p?.fecha ?? hoy()).slice(0, 10),
              monto: redondearPesos(Number(p?.monto ?? 0)),
              dia: Number(p?.dia ?? 0),
              tipo: 'completo' as const,
              observaciones: p?.observaciones ?? '',
            })),
            Mora: 0,
            moraPorciento: M.moraPorciento,
          };
        }));
      setPagos(Array.isArray(pagosDb) ? (pagosDb as any[]).map(p => ({
        id: p?.id,
        clienteId: String(p?.cliente_id ?? p?.clienteId ?? ''),
        fichaId: p?.ficha_id != null && String(p.ficha_id).trim() !== ''
          ? fichaIdUuid(String(p.ficha_id))
          : (p?.fichaId != null ? fichaIdUuid(String(p.fichaId)) : null),
        fecha: String(p?.fecha_pago ?? p?.fecha ?? hoy()).slice(0, 10),
        monto: redondearPesos(Number(p?.monto ?? 0)),
        dia: Number(p?.dia ?? 0),
        tipo: p?.tipo ?? 'pago',
        observaciones: p?.observaciones ?? '',
        lat: p?.lat ?? null,
        lng: p?.lng ?? null,
        userId: p?.cobrador_id ?? p?.userId ?? null,
        cobradorId: p?.cobrador_id ?? p?.userId ?? null,
        fechaPago: p?.fecha_pago ?? p?.fecha,
        esRegistroNoPago: Boolean(p?.es_registro_no_pago),
        cuotaNumero: p?.cuota_numero != null ? Number(p.cuota_numero) : undefined,
      })) as PagoRegistro[] : []);
      setCreditos(creditosNormalizados);
      setNotificaciones(Array.isArray(notiDb) ? (notiDb as Notificacion[]) : []);
      if (Array.isArray(gastosDb) && !gastosErr) {
        setGastos((gastosDb as any[]).map(g => ({
          id: String(g?.id ?? genId()),
          fecha: String(g?.fecha ?? hoy()).slice(0, 10),
          categoria: String(g?.categoria ?? 'Otros'),
          monto: redondearPesos(Number(g?.monto ?? 0)),
          nota: String(g?.nota ?? ''),
          userId: String(g?.cobrador_id ?? g?.user_id ?? g?.userId ?? ''),
          sync: true,
          timestamp: Number(g?.timestamp ?? new Date(g?.created_at ?? Date.now()).getTime()),
        })) as Gasto[]);
      }
      {
        let cajaQuery = supabase.from('caja').select('*').order('created_at', { ascending: false }).limit(300);
        if (!verTodosLosCreditos) {
          if (cobradorIdsFilter.length === 0) {
            cajaQuery = cajaQuery.limit(0);
          } else {
            cajaQuery = cajaQuery.in('cobrador_id', cobradorIdsFilter);
          }
        }
        const { data: cajaDb, error: cajaErr } = await cajaQuery;
        if (cajaErr) {
          devWarn('Supabase fetch caja:', cajaErr);
          setMovimientosCaja([]);
        } else {
          setMovimientosCaja(
            (Array.isArray(cajaDb) ? cajaDb : []).map(r => mapFilaCajaSupabase(r as Record<string, unknown>)),
          );
        }
      }

      let solicitudesFondoQuery = supabase
        .from('solicitudes_fondo_credito')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (!verTodosLosCreditos && cobradorIdsFilter.length > 0) {
        solicitudesFondoQuery = solicitudesFondoQuery.in('cobrador_id', cobradorIdsFilter);
      } else if (!verTodosLosCreditos) {
        solicitudesFondoQuery = solicitudesFondoQuery.limit(0);
      }
      const { data: solFondoDb, error: solFondoErr } = await solicitudesFondoQuery;
      if (solFondoErr) {
        devWarn('Supabase fetch solicitudes_fondo_credito (¿migración 038?):', solFondoErr);
        setSolicitudesFondoCredito([]);
      } else {
        const mappedSolFondo = (Array.isArray(solFondoDb) ? solFondoDb : []).map(r =>
          mapSolicitudFondoCredito(r as Record<string, unknown>),
        );
        const staleSolIds = mappedSolFondo
          .filter(s => solicitudFondoCreditoEsHuerfana(s, creditosNormalizados))
          .map(s => s.id);
        if (staleSolIds.length > 0) {
          void supabase
            .from('solicitudes_fondo_credito')
            .update({ estado: 'cancelado' })
            .in('id', staleSolIds)
            .eq('estado', 'pendiente');
        }
        setSolicitudesFondoCredito(
          mappedSolFondo.map(s => (staleSolIds.includes(s.id) ? { ...s, estado: 'cancelado' as const } : s)),
        );
      }

      if (verTodosLosCreditos) {
        const { data: propDb, error: propErr } = await supabase
          .from('caja_propia_movimientos')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(400);
        if (propErr) {
          devWarn('Supabase fetch caja_propia_movimientos (¿migración 039?):', propErr);
          setMovimientosCajaPropia([]);
        } else {
          setMovimientosCajaPropia(
            (Array.isArray(propDb) ? propDb : []).map(r => mapMovimientoCajaPropia(r as Record<string, unknown>)),
          );
        }
      } else {
        setMovimientosCajaPropia([]);
      }

      const { data: rendicionesDb, error: rendErr } = await supabase.from('rendiciones').select('*').order('created_at', { ascending: false });
      if (rendErr) {
        devWarn('Supabase fetch rendiciones:', rendErr.message || rendErr);
      } else if (Array.isArray(rendicionesDb)) {
        const rendicionesMapped = rendicionesDb.map(r => mapRowRendicionDb(r as Record<string, unknown>));
        registrarEtiquetasDesdeRendicionRows(
          rendicionesDb as Array<{ cobrador_id?: string; cobrador_nombre?: string }>,
        );
        registrarEtiquetasDesdeCierres(rendicionesMapped);
        setData(prev => {
          const next = { ...prev, cierresJornada: rendicionesMapped };
          localStorage.setItem('cp_data_v2', JSON.stringify(next));
          return next;
        });
      }
      if (configDb) {
        const merged = configDesdeSupabase(configDb as Record<string, unknown>);
        setData(prev => {
          localStorage.setItem('cp_interes_credito_m', String(merged.interesCreditoM));
          localStorage.setItem('cp_interes_credito_p', String(merged.interesCreditoP));
          const next = { ...prev, config: merged };
          localStorage.setItem('cp_data_v2', JSON.stringify(next));
          return next;
        });
      }
      try {
        const { data: provDb, error: provErr } = await supabase
          .from('proveedores')
          .select('*')
          .eq('activo', true)
          .order('nombre');
        if (!provErr && Array.isArray(provDb)) {
          setProveedores(provDb.map(r => mapProveedorRow(r as Record<string, unknown>)));
        }
        const { data: invDb, error: invErr } = await supabase
          .from('inversiones_proveedor')
          .select('*')
          .order('fecha_ingreso', { ascending: false });
        if (!invErr && Array.isArray(invDb)) {
          setInversionesProveedor(invDb.map(r => mapInversionRow(r as Record<string, unknown>)));
        }
      } catch {
        /* tablas de proveedores opcionales hasta migración 017 */
      }
      return { clientes: mappedClientes };
    } catch (error) {
      console.error('fetchData error:', error);
      return undefined;
    } finally {
      if (seq === fetchSeqRef.current && !silencioso) setLoading(false);
    }
  }, [rol]);

  /** Refresco en segundo plano (sin pantalla de carga) tras acciones o cambio de pestaña. */
  const refrescarDatosApp = useCallback(() => fetchData({ silencioso: true }), [fetchData]);

  /** Solo tabla `clientes` (sin `setLoading`): refresco inmediato tras un insert; opcionalmente reinyerta la fila del `.single()` si falta en la respuesta. */
  const refetchClientesSupabase = useCallback(async (asegurarIncluido?: Cliente | null): Promise<Cliente[] | undefined> => {
    try {
      const { data: clientesDb, error: clientesErr } = await supabase
        .from('clientes')
        .select('*')
        .order('created_at', { ascending: false });
      if (clientesErr) {
        console.error('Supabase refetch clientes error:', clientesErr);
        if (asegurarIncluido && esUuidClienteId(asegurarIncluido.id)) {
          setClientes(prev => mergeClienteAlInicioSiFalta(Array.isArray(prev) ? prev : [], asegurarIncluido));
        }
        return undefined;
      }
      let mapped = Array.isArray(clientesDb)
        ? (clientesDb as Record<string, unknown>[]).map(c => mapClienteFilaSupabase(c))
        : [];
      if (asegurarIncluido && esUuidClienteId(asegurarIncluido.id)) {
        mapped = mergeClienteAlInicioSiFalta(mapped, asegurarIncluido);
      }
      setClientes(mapped);
      return mapped;
    } catch (e) {
      console.error('refetchClientesSupabase:', e);
      return undefined;
    }
  }, []);

  /** En Hoja de Ruta: si Realtime está habilitado en Supabase, refresca `clientes` ante altas/bajas sin recargar la página. */
  useEffect(() => {
    if (page !== 'ruta' || !user) return;
    const ch = supabase
      .channel(`clientes-ruta-${String(user).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'u'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, () => {
        void refetchClientesSupabase(null);
      })
      .subscribe(status => {
        if (status === 'CHANNEL_ERROR') devWarn('Realtime `clientes` (ruta): canal no disponible (revisá Realtime en Supabase).');
      });
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [page, user, refetchClientesSupabase]);

  const sincronizarNoPagosAutomaticos = useCallback(async (): Promise<boolean> => {
    if (!user) return true;
    const hRef = hoy();
    const inserts: Record<string, unknown>[] = [];
    /** FK crédito/ficha en tabla `pagos`: solo columna `ficha_id` (nunca `credito_id`). */
    for (const credito of creditosOrEmpty) {
      if (!esCreditoActivo(credito)) continue;
      const planilla = generarPlanillaCredito(credito);
      const tieneNo = new Set(
        pagosOrEmpty
          .filter(p => fichaIdUuid(p.fichaId) === fichaIdUuid(credito.id) && p.esRegistroNoPago && p.cuotaNumero != null)
          .map(p => String(p.cuotaNumero)),
      );
      const cuotasCompletas = contextoCobroCredito(credito, pagosOrEmpty).cuotasCompletas;
      for (const cuota of planilla) {
        const k = cuota.nro;
        if (cuotasCompletas >= k) continue;
        const vto = String(cuota.vencimiento).slice(0, 10);
        if (vto >= hRef) continue;
        if (tieneNo.has(String(k))) continue;
        inserts.push({
          ficha_id: fichaIdUuid(credito.id),
          cliente_id: String(credito.cliente_id ?? '').trim(),
          cobrador_id: 'sistema',
          monto: 0,
          fecha_pago: `${vto}T12:00:00.000Z`,
          es_registro_no_pago: true,
          cuota_numero: k,
        });
      }
    }
    if (inserts.length === 0) return true;
    const chunk = 50;
    for (let i = 0; i < inserts.length; i += chunk) {
      const slice = inserts.slice(i, i + chunk);
      const { error } = await supabase.from('pagos').insert(slice as any);
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505') {
          await fetchData({ silencioso: true });
          return true;
        }
        devWarn('Sincronizar no_pago automático:', error);
        return false;
      }
    }
    await fetchData({ silencioso: true });
    return true;
  }, [user, creditosOrEmpty, pagosOrEmpty, fetchData, supabase]);

  const handleSaveConfig = useCallback(async (c: Config) => {
    if (sistemaBloqueadoTrial) {
      alert(MSG_TRIAL_EXPIRADO);
      return;
    }
    const telefonoEmpresaNorm = normalizarTelefonoArg549(c.telefonoEmpresa);
    const numeroWhatsappAdminNorm = normalizarTelefonoArg549(c.numeroWhatsappAdmin);
    const cNorm: Config = { ...c, telefonoEmpresa: telefonoEmpresaNorm, numeroWhatsappAdmin: numeroWhatsappAdminNorm };
    save({ config: cNorm });
    audit('CONFIG_CAMBIO', 'Configuración modificada');
    const row = {
      id: 'global_config',
      porcentaje_interes: Number(cNorm.interesCreditoP ?? cNorm.interesCreditoM ?? 0),
      interes_credito_m: Number(cNorm.interesCreditoM ?? 0),
      interes_credito_p: Number(cNorm.interesCreditoP ?? 0),
      porcentaje_comision_vendedor: Number(cNorm.porcentajeComisionVendedor ?? 5),
      nombre_empresa: cNorm.nombreEmpresa,
      telefono_empresa: telefonoEmpresaNorm,
      direccion_empresa: cNorm.direccionEmpresa,
      ruc: cNorm.ruc,
      moneda: cNorm.moneda,
      simbolo_moneda: cNorm.simboloMoneda,
      mora_porciento: Number(cNorm.moraPorciento ?? 0),
      numero_whatsapp_admin: numeroWhatsappAdminNorm,
      modo_exterior: Boolean(cNorm.modoExterior),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('configuracion').upsert([row as any], { onConflict: 'id' });
    if (error && String(error.message || '').trim() !== '') {
      console.error('Supabase save configuracion error:', error);
      alert('Configuración guardada localmente, pero no se pudo guardar en Supabase. ' + (error.message || ''));
      return;
    }
    await fetchData({ silencioso: true });
  }, [save, audit, fetchData, sistemaBloqueadoTrial]);

  useEffect(() => {
    const run = async () => {
      const provToken = typeof window !== 'undefined' ? localStorage.getItem(CP_PROVEEDOR_TOKEN_KEY) : null;
      let cpLocal: { username?: string; rol?: string; local?: boolean } = {};
      try {
        const cpRaw = window.localStorage.getItem('cp_session');
        if (cpRaw) cpLocal = JSON.parse(cpRaw) as typeof cpLocal;
      } catch {
        cpLocal = {};
      }

      if (provToken && cpLocal.local && cpLocal.rol === 'proveedor') {
        const prov = await validarTokenProveedor(provToken);
        if (prov) {
          setProveedorLocal(prov);
          setUser(prov.login);
          setRol('proveedor');
          setLoginEmail(prov.auth_email || null);
          setAuthUserId(null);
          setAuthUserMeta(null);
          setPage('mi_inversion');
          setSessionReady(true);
          const inv = await fetchInversionesProveedorToken(provToken);
          setInversionesProveedor(inv);
          return;
        }
        localStorage.removeItem(CP_PROVEEDOR_TOKEN_KEY);
      }

      const { data: sess } = await supabase.auth.getSession();
      const email = sess.session?.user?.email?.trim().toLowerCase();
      setAuthUserId(sess.session?.user?.id ?? null);
      setAuthUserMeta((sess.session?.user?.user_metadata as Record<string, unknown> | undefined) ?? null);
      if (!email) {
        localStorage.removeItem('cp_session');
        setProveedorLocal(null);
        setUser(null);
        setAuthUserId(null);
        setAuthUserMeta(null);
        setLoginEmail(null);
        setRol(null);
        setPage('login');
        setSessionReady(true);
        return;
      }
      setProveedorLocal(null);
      localStorage.removeItem(CP_PROVEEDOR_TOKEN_KEY);
      const sesionLocal = window.localStorage.getItem('cp_session');
      let local: { username?: string; rol?: string } = {};
      if (sesionLocal) {
        try {
          local = JSON.parse(sesionLocal) as { username?: string; rol?: string };
        } catch {
          local = {};
        }
      }
      const rolUsuario = await resolverRolUsuarioSesion(sess.session?.user?.id ?? null, email);
      const perfil = resolverPerfilDesdeAuthEmail(email);
      const usernameSesion = (perfil?.login || local.username || email.split('@')[0] || '').trim();
      if (esUsuarioPruebaSesion(usernameSesion, email)) {
        const accDemo = await verificarAccesoDemoPruebaEnServidor(usernameSesion);
        if (!accDemo.ok) {
          await supabase.auth.signOut();
          setTrialFinPrueba(null);
          alert(mensajeBloqueoDemoPrueba(accDemo.motivo));
          setSessionReady(true);
          return;
        }
        setTrialFinPrueba(accDemo.trialFin);
      } else {
        setTrialFinPrueba(null);
      }
      localStorage.setItem('cp_session', JSON.stringify({ username: usernameSesion, rol: rolUsuario }));
      if (perfil?.login) localStorage.setItem('cp_last_login_user', perfil.login);
      setUser(usernameSesion);
      setRol(rolUsuario);
      setLoginEmail(email);
      registrarEtiquetaCobradorReferencia(
        sess.session?.user?.id ?? null,
        nombreParaMostrarSesion({
          loginEmail: email,
          usernameState: usernameSesion,
          authUser: sess.session?.user ? { user_metadata: sess.session.user.user_metadata as Record<string, unknown> } : null,
        }),
        rolUsuario,
      );
      setPage(esUsuarioRootOperador(usernameSesion, email) ? 'root_console' : 'dashboard');
      setSessionReady(true);
    };
    void run();
  }, []);

  useEffect(() => {
    if (!user) return;
    if (esUsuarioRootOperadorSesion) return;
    void fetchData();
  }, [user, fetchData, esUsuarioRootOperadorSesion]);

  useEffect(() => {
    if (!user || !esUsuarioRootOperadorSesion) return;
    if (page !== 'root_console') setPage('root_console');
  }, [user, esUsuarioRootOperadorSesion, page]);

  useEffect(() => {
    if (!mAuditoria || !esMarcosPUsuario) return;
    let cancel = false;
    setLogsAuditoriaLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from('logs_auditoria')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (cancel) return;
      if (error) {
        console.error('fetch logs_auditoria:', error);
        setLogsAuditoriaRemotos([]);
        setLogsAuditoriaLoading(false);
        return;
      }
      const rows = Array.isArray(data) ? (data as unknown as LogAuditoriaRemoto[]) : [];
      setLogsAuditoriaRemotos(rows);
      setLogsAuditoriaLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [mAuditoria, esMarcosPUsuario]);

  useEffect(() => {
    if (!mCreditoRevision || !esMarcosPUsuario) {
      setCobradoresRevision([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('usuarios')
        .select('id, username')
        .in('rol', ['cobrador', 'vendedor'])
        .eq('activo', true)
        .order('username');
      if (cancelled) return;
      if (error) {
        devWarn('fetch usuarios cobradores (revisión crédito):', error);
        setCobradoresRevision([]);
        return;
      }
      setCobradoresRevision(
        (data ?? []).map((u: { id: string; username: string }) => ({
          valor: String(u.id),
          label: etiquetaCobradorMovimiento(String(u.username ?? u.id)),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [mCreditoRevision, esMarcosPUsuario]);

  const fetchVendedoresComisionAdmin = useCallback(async () => {
    if (!esMarcosPUsuario) {
      setVendedoresComisionAdmin([]);
      return;
    }
    const pctGlobal = Number(data.config.porcentajeComisionVendedor ?? 5);
    const { data: vends, error } = await supabase
      .from('usuarios')
      .select('id, username, comision_acumulada, porcentaje_comision')
      .eq('rol', 'vendedor')
      .eq('activo', true)
      .order('username');
    if (error) devWarn('fetch vendedores comisiones (usuarios):', error);

    const porClave = new Map<string, {
      id: string;
      username: string;
      comision_acumulada: number;
      porcentaje_comision: number | null;
    }>();
    for (const v of (vends ?? []) as Array<{
      id: string;
      username: string;
      comision_acumulada: number;
      porcentaje_comision: number | null;
    }>) {
      const username = String(v.username || '').trim();
      if (!username) continue;
      porClave.set(username.toLowerCase(), {
        id: String(v.id),
        username,
        comision_acumulada: Number(v.comision_acumulada) || 0,
        porcentaje_comision: v.porcentaje_comision != null ? Number(v.porcentaje_comision) : null,
      });
    }
    for (const perfil of PERFILES_VENDEDOR_SISTEMA) {
      const username = perfil.username.trim();
      if (!porClave.has(username.toLowerCase())) {
        porClave.set(username.toLowerCase(), {
          id: username,
          username,
          comision_acumulada: 0,
          porcentaje_comision: null,
        });
      }
    }
    for (const c of creditosOrEmpty) {
      const vid = String(c.vendedor_id ?? '').trim();
      if (!vid) continue;
      const usernameGuess = vid.includes('@') ? vid.split('@')[0] : vid;
      const clave = usernameGuess.toLowerCase();
      if (!porClave.has(clave)) {
        porClave.set(clave, { id: vid, username: usernameGuess, comision_acumulada: 0, porcentaje_comision: null });
      }
    }

    const resumen: VendedorComisionResumen[] = [...porClave.values()].map(v => {
      const ids = idsReferenciaVendedor({ id: v.id, username: v.username, email: `${v.username}@emd.com` });
      const ventasPendientesAprob = creditosOrEmpty.filter(c =>
        creditoComisionPendienteAprobacionAdmin(c) && creditoPerteneceAVendedor(c, ids),
      );
      const ventasAprobadasPend = creditosOrEmpty.filter(c =>
        creditoComisionAprobadaPendienteCobro(c) && creditoPerteneceAVendedor(c, ids),
      );
      const sumAprobadas = ventasAprobadasPend.reduce((s, c) => s + Number(c.comision_vendedor || 0), 0);
      const acum = redondearPesos(Math.max(Number(v.comision_acumulada) || 0, sumAprobadas));
      const totalPendAprob = redondearPesos(ventasPendientesAprob.reduce((s, c) => s + Number(c.comision_vendedor || 0), 0));
      return {
        id: String(v.id),
        username: String(v.username),
        comision_acumulada: acum,
        creditos_pendientes: ventasAprobadasPend.length,
        porcentaje_comision: porcentajeComisionEfectivoVendedor(v.porcentaje_comision, pctGlobal),
        total_pendiente_aprobacion: totalPendAprob,
        ventas_pendientes_aprobacion: ventasPendientesAprob,
        ventas_aprobadas_pendientes: ventasAprobadasPend,
      };
    }).sort((a, b) => b.comision_acumulada - a.comision_acumulada);

    setVendedoresComisionAdmin(resumen);
  }, [esMarcosPUsuario, creditosOrEmpty, data.config.porcentajeComisionVendedor]);

  useEffect(() => {
    if (!user || !esMarcosPUsuario) return;
    void fetchVendedoresComisionAdmin();
  }, [user, esMarcosPUsuario, fetchVendedoresComisionAdmin, creditosOrEmpty.length]);

  useEffect(() => {
    if (!sessionReady || !user) return;
    registrarEtiquetasCobradorDesdePersistencia();
    registrarEtiquetasDesdeCierres(cierresJornada);
    void (async () => {
      const { data, error } = await supabase
        .from('usuarios')
        .select('id, username, rol')
        .eq('activo', true);
      if (!error && Array.isArray(data) && data.length > 0) {
        registrarMapaUsuariosEtiquetas(data as Array<{ id: string; username: string; rol: string }>);
      }
      const { data: rendRows, error: rendErr } = await supabase
        .from('rendiciones')
        .select('cobrador_id, cobrador_nombre');
      if (!rendErr && Array.isArray(rendRows) && rendRows.length > 0) {
        registrarEtiquetasDesdeRendicionRows(rendRows as Array<{ cobrador_id: string; cobrador_nombre: string }>);
      }
      const filasSesion: Array<{ id?: string; username?: string; rol?: string }> = [];
      if (authUserId) {
        filasSesion.push({
          id: authUserId,
          username: user || loginEmail?.split('@')[0] || '',
          rol: rol ?? undefined,
        });
        registrarEtiquetaCobradorReferencia(
          authUserId,
          nombreParaMostrarSesion({
            loginEmail,
            usernameState: user,
            authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
          }),
          rol ?? undefined,
        );
      }
      for (const p of USUARIOS_SISTEMA) {
        if (p.usernameBd) filasSesion.push({ username: p.usernameBd, rol: p.rolDefecto });
        if (p.login) filasSesion.push({ username: p.login, rol: p.rolDefecto });
      }
      if (filasSesion.length > 0) registrarMapaUsuariosEtiquetas(filasSesion);
    })();
  }, [sessionReady, user, authUserId, loginEmail, rol, authUserMeta, cierresJornada]);

  useEffect(() => {
    if (typeof window === 'undefined' || (!esMarcosPUsuario && !esUsuarioRootOperadorSesion)) return;
    const w = window as Window & { dotcomLimpiarStorageEntrega?: () => Promise<unknown> };
    w.dotcomLimpiarStorageEntrega = async () => {
      if (!window.confirm('¿Vaciar TODOS los documentos y videos de clientes en Storage?')) {
        return { cancelado: true };
      }
      const r = await limpiarStorageEntregaDotCom();
      console.log('[DotCom] Storage limpiado:', r);
      alert(`Storage: ${r.total} archivo(s) eliminados.`);
      return r;
    };
    return () => {
      delete w.dotcomLimpiarStorageEntrega;
    };
  }, [esMarcosPUsuario, esUsuarioRootOperadorSesion]);

  useEffect(() => {
    if (!sessionReady || !user || !esSesionUsuarioPrueba) return;
    void (async () => {
      const acc = await verificarAccesoDemoPruebaEnServidor(user);
      if (!acc.ok) {
        alert(mensajeBloqueoDemoPrueba(acc.motivo));
        setTrialFinPrueba(null);
        try {
          await supabase.auth.signOut();
        } catch {
          /* ignore */
        }
        localStorage.removeItem('cp_session');
        setUser(null);
        setAuthUserId(null);
        setLoginEmail(null);
        setRol(null);
        setPage('login');
        return;
      }
      setTrialFinPrueba(acc.trialFin);
    })();
  }, [sessionReady, user, loginEmail, esSesionUsuarioPrueba]);

  useEffect(() => {
    if (page !== 'dashboard' || !user || !esSesionUsuarioPrueba) return;
    if (localStorage.getItem('cp_vista_rapida_prueba_ok')) return;
    setMVistaRapidaSistema(true);
    localStorage.setItem('cp_vista_rapida_prueba_ok', '1');
  }, [page, user, esSesionUsuarioPrueba]);

  const miResumenComisionVendedor = useMemo(() => {
    if (!esUsuarioVendedorSesion) return null;
    const ids = cobradorIdsParaFiltroSesion(
      loginEmail ? { user: { id: authUserId ?? undefined, email: loginEmail } } : null,
    );
    const enRevisionAdmin = creditosOrEmpty.filter(c =>
      creditoComisionPendienteAprobacionAdmin(c) && creditoPerteneceAVendedor(c, ids),
    );
    const aprobadasPendientes = creditosOrEmpty.filter(c =>
      creditoComisionAprobadaPendienteCobro(c) && creditoPerteneceAVendedor(c, ids),
    );
    const totalRevision = redondearPesos(enRevisionAdmin.reduce((s, c) => s + Number(c.comision_vendedor || 0), 0));
    const total = redondearPesos(aprobadasPendientes.reduce((s, c) => s + Number(c.comision_vendedor || 0), 0));
    return {
      total,
      totalRevision,
      pendientes: aprobadasPendientes,
      enRevisionAdmin,
      corteSemana: sabadoCorteSemana(),
      proximoSabado: proximoSabadoDesde(),
    };
  }, [esUsuarioVendedorSesion, creditosOrEmpty, authUserId, loginEmail]);

  const handleLiquidarComisionVendedor = useCallback(async (v: VendedorComisionResumen) => {
    if (!esMarcosPUsuario) return;
    if (v.comision_acumulada <= 0) {
      alert('Este vendedor no tiene comisiones pendientes de liquidar.');
      return;
    }
    const ok = window.confirm(
      `¿Liquidar ${fmt(v.comision_acumulada)} de comisiones a ${etiquetaCobradorMovimiento(v.username)}?\n`
      + 'Se registrará el pago, se reiniciará el acumulado y quedará historial de la semana.',
    );
    if (!ok) return;
    setLiquidandoComisionId(v.id);
    try {
      const ids = idsReferenciaVendedor({ id: v.id, username: v.username, email: `${v.username}@emd.com` });
      const creditosPend = creditosOrEmpty.filter(c =>
        creditoComisionAprobadaPendienteCobro(c) && creditoPerteneceAVendedor(c, ids),
      );
      const montoTotal = redondearPesos(
        creditosPend.length > 0
          ? creditosPend.reduce((s, c) => s + Number(c.comision_vendedor || 0), 0)
          : v.comision_acumulada,
      );
      const actor = nombreParaMostrarSesion({
        loginEmail,
        usernameState: user,
        authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
      });
      const semanaCorte = sabadoCorteSemana();
      const { error: insErr } = await supabase.from('liquidaciones_comision_vendedor').insert([{
        vendedor_id: v.id,
        vendedor_username: v.username,
        semana_corte: semanaCorte,
        monto_total: montoTotal,
        cantidad_creditos: creditosPend.length,
        pagado_por: actor || 'Marcos',
        notas: `Liquidación semanal — corte ${semanaCorte}`,
      }]);
      if (insErr) throw insErr;
      if (creditosPend.length > 0) {
        const idsCred = creditosPend.map(c => fichaIdUuid(c.id)).filter(Boolean);
        for (const cid of idsCred) {
          await supabase.from('creditos').update({ comision_liquidada: true }).eq('id', cid);
        }
      }
      await supabase.from('usuarios').update({ comision_acumulada: 0 }).or(`id.eq.${v.id},username.eq.${v.username}`);
      const emailVendedor = resolverPerfilDesdeEntradaLogin(v.username)?.authEmail
        ?? `${String(v.username).trim().toLowerCase()}@emd.com`;
      try {
        await supabase.from('notificaciones').insert([{
          titulo: 'Comisión liquidada',
          mensaje: `Se registró el pago de ${fmt(montoTotal)} por tus ventas (corte semana ${semanaCorte}). El acumulado pendiente fue reiniciado.`,
          destinatario_rol: 'vendedor',
          destinatario_usuario: normalizarEmail(emailVendedor),
          leido: false,
        }]);
      } catch {
        /* aviso opcional */
      }
      await fetchData({ silencioso: true });
      await fetchVendedoresComisionAdmin();
      audit('CONFIG_CAMBIO', `Comisión liquidada a ${v.username}: ${fmt(montoTotal)} (corte ${semanaCorte})`);
      alert(`Comisión liquidada: ${fmt(montoTotal)}. El acumulado del vendedor fue reiniciado.`);
    } catch (e: unknown) {
      console.error('handleLiquidarComisionVendedor:', e);
      alert('No se pudo registrar la liquidación. Revisá la conexión o ejecutá la migración de comisiones en Supabase.');
    } finally {
      setLiquidandoComisionId(null);
    }
  }, [
    esMarcosPUsuario, creditosOrEmpty, loginEmail, user, authUserMeta,
    fetchData, fetchVendedoresComisionAdmin, audit,
  ]);

  const handleGuardarPorcentajeComisionVendedor = useCallback(async (
    v: VendedorComisionResumen,
    nuevoPct: number,
  ) => {
    if (!esMarcosPUsuario) return;
    const pct = Math.max(0, Number(nuevoPct) || 0);
    setGuardandoPctComisionId(v.id);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({ porcentaje_comision: pct })
        .or(`id.eq.${v.id},username.eq.${v.username}`);
      if (error) throw error;
      for (const c of v.ventas_pendientes_aprobacion) {
        const capital = redondearPesos(Number(c.monto_solicitado) || 0);
        const comision = calcularComisionVentaVendedor(capital, pct);
        const cid = fichaIdUuid(c.id);
        if (!cid) continue;
        await supabase.from('creditos').update({
          comision_vendedor: comision,
          porcentaje_comision_credito: pct,
        }).eq('id', cid);
        setCreditos(prev => prev.map(cr => fichaIdUuid(cr.id) === cid
          ? { ...cr, comision_vendedor: comision, porcentaje_comision_credito: pct }
          : cr));
      }
      audit('CONFIG_CAMBIO', `Comisión vendedor ${v.username}: ${pct}%`);
      await fetchVendedoresComisionAdmin();
      alert(`Porcentaje de ${etiquetaCobradorMovimiento(v.username)} actualizado a ${pct}%.`);
    } catch (e) {
      console.error('handleGuardarPorcentajeComisionVendedor:', e);
      alert('No se pudo guardar el porcentaje. Ejecutá la migración 024 en Supabase si falta la columna porcentaje_comision.');
    } finally {
      setGuardandoPctComisionId(null);
    }
  }, [esMarcosPUsuario, fetchVendedoresComisionAdmin, audit, setCreditos]);

  const handleAprobarComisionCredito = useCallback(async (credito: Credito, vendedor: VendedorComisionResumen) => {
    if (!esMarcosPUsuario) return;
    const cid = fichaIdUuid(credito.id);
    if (!cid) return;
    const monto = redondearPesos(Number(credito.comision_vendedor) || 0);
    if (monto <= 0) {
      alert('La comisión de esta venta es cero.');
      return;
    }
    setAprobandoComisionCreditoId(credito.id);
    try {
      const { error } = await supabase.from('creditos').update({ comision_aprobada_admin: true }).eq('id', cid);
      if (error) throw error;
      const hintUser = vendedor.username;
      await incrementarComisionAcumuladaVendedor(vendedor.id, hintUser, monto);
      setCreditos(prev => prev.map(c => fichaIdUuid(c.id) === cid
        ? { ...c, comision_aprobada_admin: true }
        : c));
      const emailVendedor = resolverPerfilDesdeEntradaLogin(vendedor.username)?.authEmail
        ?? `${String(vendedor.username).trim().toLowerCase()}@emd.com`;
      try {
        await supabase.from('notificaciones').insert([{
          titulo: 'Comisión aprobada',
          mensaje: `Marcos aprobó tu comisión de ${fmt(monto)} por la venta ${String(credito.nro_carton || '').trim() || cid.slice(0, 8)}. Ya figura en tu panel para cobrar tras la liquidación semanal.`,
          destinatario_rol: 'vendedor',
          destinatario_usuario: normalizarEmail(emailVendedor),
          leido: false,
        }]);
      } catch { /* opcional */ }
      audit('CONFIG_CAMBIO', `Comisión aprobada crédito ${cid} — ${fmt(monto)} — ${vendedor.username}`);
      await fetchData({ silencioso: true });
      await fetchVendedoresComisionAdmin();
    } catch (e) {
      console.error('handleAprobarComisionCredito:', e);
      alert('No se pudo aprobar la comisión. Revisá Supabase (migración 024).');
    } finally {
      setAprobandoComisionCreditoId(null);
    }
  }, [
    esMarcosPUsuario, fetchData, fetchVendedoresComisionAdmin, audit,
  ]);

  const handleEliminarComisionCredito = useCallback(async (credito: Credito, vendedor: VendedorComisionResumen) => {
    if (!esMarcosPUsuario) return;
    const cid = fichaIdUuid(credito.id);
    if (!cid) return;
    const monto = redondearPesos(Number(credito.comision_vendedor) || 0);
    if (monto <= 0) {
      alert('Esta venta no tiene comisión pendiente.');
      return;
    }
    const carton = String(credito.nro_carton || '').trim() || cid.slice(0, 8);
    const eraAprobada = Boolean(credito.comision_aprobada_admin) && !Boolean(credito.comision_liquidada);
    const ok = window.confirm(
      eraAprobada
        ? `¿Eliminar la comisión de ${fmt(monto)} (${carton}) de ${etiquetaCobradorMovimiento(vendedor.username)}?\n`
          + 'Se quitará del acumulado a cobrar del vendedor.'
        : `¿Eliminar la comisión de ${fmt(monto)} (${carton}) de ${etiquetaCobradorMovimiento(vendedor.username)}?\n`
          + 'El vendedor dejará de verla en «Pendientes de aprobación».',
    );
    if (!ok) return;
    setEliminandoComisionCreditoId(credito.id);
    try {
      const { error } = await supabase.from('creditos').update({
        comision_vendedor: 0,
        comision_aprobada_admin: false,
        porcentaje_comision_credito: 0,
      }).eq('id', cid);
      if (error) throw error;
      if (eraAprobada) {
        await decrementarComisionAcumuladaVendedor(vendedor.id, vendedor.username, monto);
      }
      setCreditos(prev => prev.map(c => fichaIdUuid(c.id) === cid
        ? { ...c, comision_vendedor: 0, comision_aprobada_admin: false, porcentaje_comision_credito: 0 }
        : c));
      const emailVendedor = resolverPerfilDesdeEntradaLogin(vendedor.username)?.authEmail
        ?? `${String(vendedor.username).trim().toLowerCase()}@emd.com`;
      try {
        await supabase.from('notificaciones').insert([{
          titulo: 'Comisión eliminada',
          mensaje: eraAprobada
            ? `Marcos eliminó la comisión de ${fmt(monto)} por la venta ${carton}. Ya no figura en tu monto a cobrar.`
            : `Marcos eliminó la comisión de ${fmt(monto)} por la venta ${carton}. Ya no está pendiente de aprobación.`,
          destinatario_rol: 'vendedor',
          destinatario_usuario: normalizarEmail(emailVendedor),
          leido: false,
        }]);
      } catch { /* opcional */ }
      audit('CONFIG_CAMBIO', `Comisión eliminada crédito ${cid} — ${fmt(monto)} — ${vendedor.username}`);
      await fetchData({ silencioso: true });
      await fetchVendedoresComisionAdmin();
    } catch (e) {
      console.error('handleEliminarComisionCredito:', e);
      alert('No se pudo eliminar la comisión. Revisá la conexión o permisos en Supabase.');
    } finally {
      setEliminandoComisionCreditoId(null);
    }
  }, [
    esMarcosPUsuario, fetchData, fetchVendedoresComisionAdmin, audit,
  ]);

  const handleEliminarCreditoCompleto = useCallback(async (credito: Credito) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede eliminar créditos.');
      return;
    }
    const creditoUuid = fichaIdUuid(credito.id);
    if (!creditoUuid) {
      alert('Crédito sin identificador válido.');
      return;
    }
    const clienteUuid = normalizarUuidPostgrest(String(credito.cliente_id ?? ''));
    const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(String(credito.cliente_id ?? '')));
    const nombreCli = nombreCompletoCliente(cli) || String(credito.cliente_id ?? '').slice(0, 8);
    const carton = String(credito.nro_carton || '').trim() || creditoUuid.slice(0, 8);
    const pagosCred = pagosEfectivosCredito(pagosOrEmpty, credito.id);
    const totalCobrado = redondearPesos(pagosCred.reduce((s, p) => s + (Number(p.monto) || 0), 0));
    const comision = redondearPesos(Number(credito.comision_vendedor) || 0);
    const ok = window.confirm(
      `¿Eliminar el crédito ${carton} de ${nombreCli}?\n\n`
      + `• Se borrarán cobros (${fmt(totalCobrado)}), cuotas y movimientos de caja vinculados.\n`
      + `• Se revertirá el saldo del cliente y las comisiones del vendedor si aplican.\n`
      + `• Si hubo habilitación desde caja propia, se registrará la reversión.\n\n`
      + 'Esta acción no se puede deshacer.',
    );
    if (!ok) return;
    setEliminandoCreditoId(credito.id);
    const actor = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    try {
      const { data: pagosDb, error: ePagosSel } = await supabase
        .from('pagos')
        .select('id, monto, es_registro_no_pago')
        .eq('ficha_id', creditoUuid);
      if (ePagosSel) throw ePagosSel;
      const totalRevertir = redondearPesos(
        (pagosDb ?? [])
          .filter(p => !Boolean((p as { es_registro_no_pago?: boolean }).es_registro_no_pago)
            && redondearPesos(Number((p as { monto?: number }).monto) || 0) > 0)
          .reduce((s, p) => s + redondearPesos(Number((p as { monto?: number }).monto) || 0), 0),
      );

      if (comision > 0 && Boolean(credito.comision_aprobada_admin) && !Boolean(credito.comision_liquidada)) {
        const vid = String(credito.vendedor_id ?? '').trim();
        if (vid) await decrementarComisionAcumuladaVendedor(vid, vid.split('@')[0] || vid, comision);
      }

      const { data: solFondo } = await supabase
        .from('solicitudes_fondo_credito')
        .select('id, estado, monto, cobrador_id')
        .eq('credito_id', creditoUuid)
        .maybeSingle();
      if (solFondo && String((solFondo as { estado?: string }).estado ?? '') === 'fondado') {
        const solId = String((solFondo as { id?: string }).id ?? '');
        const montoFondo = redondearPesos(Number((solFondo as { monto?: number }).monto) || 0);
        const { data: propMovs } = await supabase
          .from('caja_propia_movimientos')
          .select('id, tipo, monto')
          .eq('solicitud_fondo_id', solId);
        for (const m of propMovs ?? []) {
          const row = m as { id?: string; tipo?: string; monto?: number };
          if (String(row.tipo) === 'salida' && redondearPesos(Number(row.monto) || 0) > 0) {
            await supabase.from('caja_propia_movimientos').insert([{
              tipo: 'entrada',
              monto: redondearPesos(Number(row.monto) || 0),
              descripcion: `Reversión eliminación crédito — ${nombreCli}`,
              nota: `Crédito ${carton} eliminado por admin`,
              registrado_por: actor || 'Marcos',
              fecha: hoy(),
            }]);
          }
          if (row.id) {
            await supabase.from('caja_propia_movimientos').delete().eq('id', row.id);
          }
        }
        if (montoFondo > 0) {
          devWarn('Eliminar crédito: fondo habilitado revertido en caja propia', { solId, montoFondo });
        }
      }

      for (const p of pagosDb ?? []) {
        const pid = normalizarUuidPostgrest(String((p as { id?: string }).id ?? ''));
        if (pid) {
          const { error: eCajaP } = await supabase.from('caja').delete().eq('pago_id', pid);
          if (eCajaP) devWarn('Eliminar crédito: caja por pago', eCajaP);
        }
      }
      const { error: eCajaF } = await supabase.from('caja').delete().eq('ficha_id', creditoUuid);
      if (eCajaF) devWarn('Eliminar crédito: caja por ficha', eCajaF);

      const { error: eDelPagos } = await supabase.from('pagos').delete().eq('ficha_id', creditoUuid);
      if (eDelPagos) throw eDelPagos;

      const { error: eCuotas } = await supabase.from('cuotas').delete().eq('credito_id', creditoUuid);
      if (eCuotas) devWarn('Eliminar crédito: cuotas', eCuotas);

      if (clienteUuid && totalRevertir > 0) {
        const { data: cliDb } = await supabase
          .from('clientes')
          .select('saldo_pendiente, saldo_debitado, saldo')
          .eq('id', clienteUuid)
          .maybeSingle();
        if (cliDb && typeof cliDb === 'object') {
          const c = cliDb as Record<string, unknown>;
          const sp = intPgSaldo(redondearPesos(Number(c.saldo_pendiente ?? 0)) + totalRevertir);
          const sd = intPgSaldo(Math.max(0, redondearPesos(Number(c.saldo_debitado ?? 0)) - totalRevertir));
          const sal = intPgSaldo(redondearPesos(Number(c.saldo ?? 0)) + totalRevertir);
          await supabase.from('clientes').update({
            saldo_pendiente: sp,
            saldo_debitado: sd,
            saldo: sal,
          } as any).eq('id', clienteUuid);
        }
      }

      await supabase.from('solicitudes_fondo_credito').delete().eq('credito_id', creditoUuid);

      const { error: eCred } = await supabase.from('creditos').delete().eq('id', creditoUuid);
      if (eCred) throw eCred;

      setCreditos(prev => (Array.isArray(prev) ? prev.filter(c => fichaIdUuid(c.id) !== creditoUuid) : prev));
      setPagos(prev => (Array.isArray(prev)
        ? prev.filter(p => fichaIdUuid(p.fichaId ?? '') !== creditoUuid)
        : prev));
      save({ fichas: fichasOrEmpty.filter(f => fichaIdUuid(f.id) !== creditoUuid) });

      const cobradorEmail = normalizarEmail(String(credito.cobrador_notif_email ?? ''));
      if (cobradorEmail) {
        try {
          await supabase.from('notificaciones').insert([{
            titulo: 'Crédito eliminado',
            mensaje: `Marcos eliminó el crédito ${carton} de ${nombreCli}. Los cobros y movimientos de caja de ese crédito fueron revertidos.`,
            destinatario_rol: 'cobrador',
            destinatario_usuario: cobradorEmail,
            leido: false,
          }]);
        } catch { /* opcional */ }
      }
      const vid = String(credito.vendedor_id ?? '').trim();
      if (vid) {
        const perfilV = resolverPerfilDesdeEntradaLogin(vid) || resolverPerfilDesdeAuthEmail(vid);
        const emailV = perfilV?.authEmail ?? (vid.includes('@') ? vid : `${vid.toLowerCase()}@emd.com`);
        try {
          await supabase.from('notificaciones').insert([{
            titulo: 'Crédito eliminado',
            mensaje: `Marcos eliminó el crédito ${carton} de ${nombreCli}.${comision > 0 ? ` La comisión asociada (${fmt(comision)}) ya no aplica.` : ''}`,
            destinatario_rol: 'vendedor',
            destinatario_usuario: normalizarEmail(emailV),
            leido: false,
          }]);
        } catch { /* opcional */ }
      }

      audit('CONFIG_CAMBIO', `Crédito eliminado ${creditoUuid} (${carton}) — cobros revertidos ${fmt(totalRevertir)}`);
      if (mCreditoRevision && fichaIdUuid(mCreditoRevision.id) === creditoUuid) setMCreditoRevision(null);
      await fetchData({ silencioso: true });
      if (esMarcosPUsuario) await fetchVendedoresComisionAdmin();
      alert(`Crédito ${carton} eliminado. Movimientos revertidos.`);
    } catch (e) {
      console.error('handleEliminarCreditoCompleto:', e);
      alert('No se pudo eliminar el crédito. Ejecutá la migración 045 en Supabase si falta permiso de borrado.');
    } finally {
      setEliminandoCreditoId(null);
    }
  }, [
    esMarcosPUsuario, clientesOrEmpty, pagosOrEmpty, fichasOrEmpty, loginEmail, user, authUserMeta,
    mCreditoRevision, fetchData, fetchVendedoresComisionAdmin, audit, save,
  ]);

  /** Una vez al día: inserta en Supabase registros $0 de no pago para cuotas vencidas sin cobro efectivo (idempotente con índice único). */
  useEffect(() => {
    if (!user || loading || creditosOrEmpty.length === 0) return;
    const today = hoy();
    if (typeof localStorage !== 'undefined' && localStorage.getItem('cp_last_no_pago_sync_date') === today) return;
    const t = window.setTimeout(() => {
      void sincronizarNoPagosAutomaticos().then(ok => {
        if (ok && typeof localStorage !== 'undefined') localStorage.setItem('cp_last_no_pago_sync_date', today);
      });
    }, 2200);
    return () => clearTimeout(t);
  }, [user, loading, creditosOrEmpty.length, sincronizarNoPagosAutomaticos]);

  /** Al cambiar de pestaña, datos frescos sin recargar la página manualmente. */
  useEffect(() => {
    if (!user || page === 'login' || page === 'root_console') return;
    void fetchData({ silencioso: true });
  }, [page, user, fetchData]);

  /** Marcos: refresco periódico en Caja, inicio y panel (recaudación en vivo). */
  useEffect(() => {
    if (!esMarcosPUsuario || !user) return;
    if (page !== 'cierre_caja' && page !== 'dashboard' && page !== 'panel_control') return;
    void refrescarDatosApp();
    const t = window.setInterval(() => { void refrescarDatosApp(); }, 10000);
    return () => clearInterval(t);
  }, [esMarcosPUsuario, page, user, refrescarDatosApp]);

  /** En Ruta (una vez por visita): insertar no pagos $0 acumulados; índice único evita duplicados. */
  const rutaNoPagoSyncRef = useRef(false);
  useEffect(() => {
    if (page !== 'ruta') {
      rutaNoPagoSyncRef.current = false;
      return;
    }
    if (!user || loading) return;
    if (rutaNoPagoSyncRef.current) return;
    rutaNoPagoSyncRef.current = true;
    const t = window.setTimeout(() => { void sincronizarNoPagosAutomaticos(); }, 900);
    return () => clearTimeout(t);
  }, [page, user, loading, sincronizarNoPagosAutomaticos]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel('cp-live-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pagos' }, () => { void fetchData({ silencioso: true }); })
      /** Supabase Realtime: al aprobar/editar créditos el cobrador ve el cambio sin recargar (p. ej. PENDIENTE / PENDIENTE_APROBACION → ACTIVO). */
      .on('postgres_changes', { event: '*', schema: 'public', table: 'creditos' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notificaciones' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rendiciones' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'caja' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'solicitudes_fondo_credito' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'caja_propia_movimientos' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clientes' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cheques' }, () => { void fetchData({ silencioso: true }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'configuracion' }, () => { void fetchData({ silencioso: true }); })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, fetchData]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_COBROS_PENDIENTES_V1);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        setBannerCobroRed(prev => prev || `Hay ${parsed.length} cobro(s) guardado(s) en este dispositivo pendientes de sincronización con el servidor.`);
      }
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void flushColaLogsAuditoriaSupabase();
    const iv = window.setInterval(() => { void flushColaLogsAuditoriaSupabase(); }, 52000);
    const onOnline = () => void flushColaLogsAuditoriaSupabase();
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('online', onOnline);
    };
  }, [user]);

  /** Si el usuario abre la app con `?id=` en la URL (compartir / enlace), ir a Créditos y mostrar el detalle. */
  useEffect(() => {
    if (!user || urlCreditoInicialAplicadoRef.current) return;
    const id = getCreditoIdFromUrl();
    if (!id) return;
    urlCreditoInicialAplicadoRef.current = true;
    setFiltroPendientesCredito('procesados');
    setPage('creditos');
  }, [user]);

  /** Abre el modal del cliente del crédito enlazado por `?id=` (persistente hasta cerrar el modal). */
  useEffect(() => {
    if (page !== 'creditos' || !user) return;
    const id = getCreditoIdFromUrl();
    if (!id) return;

    const credito = creditosOrEmpty.find(c => String(c.id) === String(id));
    if (!credito) return;

    if (deepLinkCreditoAtendidoRef.current === id && mDetalleCliente) return;

    const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(credito.cliente_id));
    if (!cli) return;

    deepLinkCreditoAtendidoRef.current = id;
    setFiltroPendientesCredito('procesados');
    setCartonDestacarCreditoId(id);
    setMDetalleCliente(cli);
  }, [page, user, creditosOrEmpty, clientesOrEmpty, mDetalleCliente]);

  useEffect(() => {
    if (!user) {
      setLoginEmail(null);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setLoginEmail(data.session?.user?.email?.toLowerCase() ?? null);
    });
  }, [user]);

  useEffect(() => {
    if (!mQrScan) return;
    let active = true;
    const loadLib = async () => {
      if (window.Html5Qrcode) return;
      await new Promise<void>((resolve, reject) => {
        const existing = document.getElementById('html5-qrcode-script');
        if (existing) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.id = 'html5-qrcode-script';
        script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('No se pudo cargar html5-qrcode'));
        document.body.appendChild(script);
      });
    };
    const startScan = async () => {
      try {
        setEstadoQr('Iniciando cámara...');
        await loadLib();
        if (!window.Html5Qrcode || !active) return;
        const scanner = new window.Html5Qrcode('qr-reader-box');
        qrInstanceRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 230, height: 230 } },
          (decodedText: string) => {
            if (!active) return;
            setEstadoQr(`Leído: ${decodedText}`);
            const normalizado = String(decodedText || '').trim().replace(/^cliente:/i, '');
            const cliente = clientesOrEmpty.find(c => c.id === normalizado);
            if (!cliente) {
              setEstadoQr(`No se encontró cliente para ID: ${normalizado}`);
              return;
            }
            const fichaActiva = fichasOrEmpty.find(f => f.clienteId === cliente.id && f.estado === 'activa');
            limpiarDeepLinkCredito();
            setPage('fichas');
            setSearch('');
            setFilterStatus('all');
            setTab(0);
            setMQrScan(false);
            setMFicha({ cliente, ...(fichaActiva ? { ficha: fichaActiva } : {}) });
          },
          () => {},
        );
        setEstadoQr('Escaneando... apuntá al QR del cliente');
      } catch (e) {
        setEstadoQr('No se pudo iniciar el escáner');
      }
    };
    void startScan();
    return () => {
      active = false;
      const scanner = qrInstanceRef.current;
      if (scanner) {
        scanner.stop().catch(() => null).finally(() => {
          scanner.clear?.();
          qrInstanceRef.current = null;
        });
      }
    };
  }, [mQrScan, clientesOrEmpty, fichasOrEmpty, limpiarDeepLinkCredito]);

  // ==========================================
  // EFFECTS
  // ==========================================
  useEffect(() => {
    const onOnline = () => { setIsOnline(true); audit('SYNC_ONLINE', 'Conexión restaurada'); };
    const onOffline = () => { setIsOnline(false); audit('SYNC_OFFLINE', 'Conexión perdida'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [audit]);

  useEffect(() => {
    const t0 = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.min(3000, performance.now() - t0);
      setSplashMs(elapsed);
      if (elapsed >= 3000) {
        setShowSplash(false);
        window.clearInterval(timer);
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, []);

  // ==========================================
  // COMPUTED
  // ==========================================

  const filtrados = useMemo(() => {
    const status = ['all', 'mora', 'pendiente', 'alDia'].includes(filterStatus) ? filterStatus : 'all';
    const baseClientes = clientesOrEmpty.filter(c => c && typeof c === 'object');
    let list = [...baseClientes];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        nombreCompletoCliente(c).toLowerCase().includes(q)
        || (c?.nombre ?? '').toLowerCase().includes(q)
        || (c?.apellido ?? '').toLowerCase().includes(q)
        || (c?.direccion ?? '').toLowerCase().includes(q)
        || (c?.telefono ?? '').includes(q)
      );
    }
    switch (status) {
      case 'mora':
        list = list.filter(c => (c?.saldo ?? 0) > 0 && (getMoraClientes(c).total ?? 0) > 0);
        break;
      case 'pendiente':
        list = list.filter(c => (c?.saldo ?? 0) > 0 && (getMoraClientes(c).total ?? 0) === 0);
        break;
      case 'alDia':
        list = list.filter(c => (c?.saldo ?? 0) === 0);
        break;
      default:
        // "all": conserva lista completa
        break;
    }
    return list;
  }, [clientesOrEmpty, search, filterStatus]);

  const getFichasCliente = useCallback((id: string) => fichasOrEmpty.filter(f => normalizarId(f.clienteId) === normalizarId(id)), [fichasOrEmpty]);

  const getMoraClientes = (cliente?: Cliente | null) => {
    try {
      if (!cliente?.id) return { total: 0, diasMora: 0, proxFecha: '' };
      const fs = getFichasCliente(cliente.id);
      let total = 0, diasMora = 0, proxFecha = '';
      const h = hoy();
      fs.filter(f => f?.estado === 'activa').forEach(f => {
        if ((f?.saldo ?? 0) > 0) {
          const pagado = (f?.pagos ?? []).reduce((s, p) => s + (p?.monto ?? 0), 0);
          const esperado = (f?.cuotaMonto ?? 0) * (f?.cuotasPagas ?? 0);
          const diff = Math.max(0, esperado - pagado);
          total += diff + (f?.saldo ?? 0);
        }
      });
      if (total > 0) diasMora = 7;
      const fxs = fs.filter(f => f?.estado === 'activa' && (f?.saldo ?? 0) > 0);
      if (fxs.length > 0) proxFecha = proxDiaHabil(h);
      return { total, diasMora, proxFecha };
    } catch {
      return { total: 0, diasMora: 0, proxFecha: '' };
    }
  };

  const getSemafClient = (cliente?: Cliente | null) => {
    try {
      if (!cliente?.id) return '⚪';
      const { total } = getMoraClientes(cliente);
      const fs = getFichasCliente(cliente.id);
      const h = hoy();
      const tienePagoHoy = fs.some(f => (f?.pagos ?? []).some(p => p?.fecha === h && (p?.monto ?? 0) > 0));
      if (total > 0) return '🔴';
      if (tienePagoHoy) return '🟢';
      if ((cliente?.saldo ?? 0) > 0) return '🟡';
      return '⚪';
    } catch {
      return '⚪';
    }
  };

  // KPIs Dashboard
  const kpis = useMemo(() => {
    const h = hoy();
    const clientesConDeuda = clientesOrEmpty.filter(c => (c?.saldo ?? 0) > 0);
    const totalMoraRaw = clientesConDeuda.reduce((s, c) => s + (getMoraClientes(c).total || 0), 0);
    const totalMora = Number.isFinite(totalMoraRaw) ? totalMoraRaw : 0;
    const moraClientes = clientesConDeuda.filter(c => getMoraClientes(c).total > 0);

    const usuarioActual = String(user || loginEmail || '').trim();
    const pagosHoyGlobal = pagosOrEmpty
      .filter((p: any) => String(p?.fechaPago ?? p?.fecha ?? '').slice(0, 10) === h && esPagoEfectivo(p as PagoRegistro));
    const pagosHoyUsuario = pagosHoyGlobal
      .filter((p: any) => {
        const cobrador = String(p?.cobradorId ?? p?.userId ?? '').trim();
        return !usuarioActual || cobrador === usuarioActual;
      });
    const pagosBase = isAdminOrRoot(rol) ? pagosHoyGlobal : pagosHoyUsuario;
    const gastosList = Array.isArray(gastos) ? gastos : [];
    const recaudacionCampo = calcularRecaudacionCampoHoy(pagosOrEmpty, gastosList, h);
    const totalCobradoHoy = isAdminOrRoot(rol)
      ? recaudacionCampo.ingresosCampoHoy
      : pagosBase.reduce((s: number, p: any) => s + (Number(p?.monto) || 0), 0);
    const cuotasCobradasHoy = isAdminOrRoot(rol)
      ? recaudacionCampo.porUsuarioCampo.reduce((s, u) => s + u.cantCobros, 0)
      : pagosBase.length;

    const gastosHoy = gastosList.filter(g => g && String(g.fecha || '').slice(0, 10) === h);
    const totalGastosHoy = isAdminOrRoot(rol)
      ? recaudacionCampo.egresosCampoHoy
      : gastosHoy.reduce((s, g) => s + (Number(g?.monto) || 0), 0);

    const totalACobrarHoy = isAdminOrRoot(rol)
      ? totalACobrarHoyDesdeCreditos(creditosOrEmpty, h)
      : totalACobrarHoyDesdeCreditos(
        creditosOrEmpty.filter(c => {
          const cc = String(c.cobrador_id ?? c.creado_por ?? '').trim();
          const u = String(authUserId || user || loginEmail || '').trim();
          return !u || cc === u;
        }),
        h,
      );

    const efectividad = efectividadCobroPorMonto(totalCobradoHoy, totalACobrarHoy);
    const gananciaNeta = isAdminOrRoot(rol)
      ? recaudacionCampo.cobradoAcumuladoCampo
      : totalCobradoHoy - totalGastosHoy;

    const promesasCount = clientesOrEmpty.filter(c => c?.promesaFecha === h).length;

    return {
      moraClientes: moraClientes.length,
      totalMora,
      totalCobradoHoy,
      totalGastosHoy,
      totalACobrarHoy,
      efectividad,
      gananciaNeta,
      promesasCount,
      clientesConDeuda: clientesConDeuda.length,
      cuotasCobradasHoy,
      recaudacionCampo: isAdminOrRoot(rol) ? recaudacionCampo : null,
    };
  }, [clientesOrEmpty, gastos, pagosOrEmpty, user, loginEmail, rol, creditosOrEmpty, authUserId]);
  const resumenCobrador = useMemo(() => {
    const h = hoy();
    const pagosHoy = pagosOrEmpty.filter((p: any) => {
      const fd = String(p?.fechaPago ?? p?.fecha ?? '').slice(0, 10);
      if (fd !== h) return false;
      if (!esPagoEfectivo(p as PagoRegistro)) return false;
      return esRegistroDelCobrador(p, authUserId, user, loginEmail);
    });
    const visitasFallidasHoy = (data.visitasFallidas || []).filter(v => v?.fecha === h);
    const clientesVisitados = new Set<string>([
      ...pagosHoy.map((p: any) => String(p?.clienteId || '')),
      ...visitasFallidasHoy.map(v => String(v?.clienteId || '')),
    ].filter(Boolean));
    const totalCobros = pagosHoy.length;
    const totalRecaudado = pagosHoy.reduce((s: number, p: any) => s + (Number(p?.monto) || 0), 0);
    const efectividad = clientesVisitados.size > 0 ? (totalCobros / clientesVisitados.size) * 100 : 0;
    return { totalCobros, totalRecaudado, clientesVisitados: clientesVisitados.size, efectividad };
  }, [pagosOrEmpty, data.visitasFallidas, user, authUserId, loginEmail]);

  const esUsuarioCampoConCaja = useMemo(() => {
    if (esMarcosPUsuario) return false;
    const r = (rol || '').toLowerCase();
    return r === 'cobrador' || r === 'vendedor';
  }, [esMarcosPUsuario, rol]);

  const cierreCajaMarcosAt = useMemo(
    () => data.config.cierreCajaMarcosAt ?? null,
    [data.config.cierreCajaMarcosAt],
  );

  const miRendicionHoy = useMemo(() => {
    const h = hoy();
    return cierresJornada.find(c => c.fecha === h && rendicionEsDelUsuarioActual(c, authUserId, user));
  }, [cierresJornada, authUserId, user]);

  const cajaCobradorDia = useMemo(() => {
    const h = hoy();
    const gList = Array.isArray(gastos) ? gastos : [];
    const pagosH = pagosOrEmpty.filter(p => {
      const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
      return fd === h && esPagoEfectivo(p) && esRegistroDelCobrador(p, authUserId, user, loginEmail);
    });
    const totalCobrado = redondearPesos(pagosH.reduce((s, p) => s + (Number(p.monto) || 0), 0));
    const gastosH = gList.filter(g => String(g.fecha || '').slice(0, 10) === h && esGastoDelCobrador(g, authUserId, user, loginEmail));
    const totalGastos = redondearPesos(gastosH.reduce((s, g) => s + (Number(g.monto) || 0), 0));
    const movsHoy = movimientosCaja.filter(m => {
      if (String(m.createdAt).slice(0, 10) !== h) return false;
      return esRegistroDelCobrador({ cobradorId: m.cobradorId, userId: m.cobradorId } as PagoRegistro, authUserId, user, loginEmail);
    });
    const ingresosCaja = redondearPesos(
      movsHoy.filter(m => m.tipo === 'entrada').reduce((s, m) => s + m.monto, 0),
    );
    const salidasCaja = redondearPesos(
      movsHoy.filter(m => m.tipo === 'salida').reduce((s, m) => s + m.monto, 0),
    );
    const live = {
      totalCobrado,
      totalGastos,
      ingresosCaja,
      salidasCaja,
      efectivoEnMano: redondearPesos(totalCobrado + ingresosCaja - totalGastos - salidasCaja),
      cantGastos: gastosH.length,
    };
    /** Solo congelar mientras espera validación de Marcos; si ya fue aceptada, seguir sumando cobros en vivo. */
    if (miRendicionHoy && !miRendicionHoy.validado) {
      const totalCobradoCong = redondearPesos(Number(miRendicionHoy.totalSistema) || 0);
      const totalGastosCong = redondearPesos(Number(miRendicionHoy.totalGastos) || 0);
      const netoCong = redondearPesos(
        Number(miRendicionHoy.netoEntregar) || totalCobradoCong - totalGastosCong,
      );
      return {
        totalCobrado: totalCobradoCong,
        totalGastos: totalGastosCong,
        ingresosCaja: 0,
        salidasCaja: 0,
        efectivoEnMano: netoCong,
        cantGastos: 0,
        congeladoRendicion: true as const,
      };
    }
    return {
      ...live,
      congeladoRendicion: false as const,
    };
  }, [pagosOrEmpty, gastos, movimientosCaja, authUserId, user, loginEmail, miRendicionHoy]);

  const esperandoValidacionRendicion = useMemo(() => Boolean(miRendicionHoy && !miRendicionHoy.validado), [miRendicionHoy]);
  const jornadaCerradaValidadaHoy = useMemo(() => Boolean(miRendicionHoy && miRendicionHoy.validado), [miRendicionHoy]);
  const cobradorBloqueadoCobros = useMemo(
    () => (rol || '').toLowerCase() === 'cobrador' && (esperandoValidacionRendicion || jornadaCerradaValidadaHoy),
    [rol, esperandoValidacionRendicion, jornadaCerradaValidadaHoy],
  );
  const puedeCerrarJornadaCampo = useMemo(
    () => esUsuarioCampoConCaja && !miRendicionHoy,
    [esUsuarioCampoConCaja, miRendicionHoy],
  );
  const usuarioCampoBloqueadoOperaciones = useMemo(
    () => esUsuarioCampoConCaja && (esperandoValidacionRendicion || jornadaCerradaValidadaHoy),
    [esUsuarioCampoConCaja, esperandoValidacionRendicion, jornadaCerradaValidadaHoy],
  );
  const rendicionesPendientesAdmin = useMemo(
    () => cierresJornada.filter(c => !c.validado),
    [cierresJornada],
  );
  const historialRendicionesAdmin = useMemo(
    () => cierresJornada.filter(c => c.validado).sort((a, b) => {
      const ta = a.validadoAt || '';
      const tb = b.validadoAt || '';
      return tb.localeCompare(ta);
    }),
    [cierresJornada],
  );

  const creditosConClienteValido = useMemo(() => {
    const clienteIds = new Set(clientesOrEmpty.map(c => normalizarId(c.id)).filter(Boolean));
    return creditosOrEmpty.filter(c => {
      const clienteId = normalizarId(c?.cliente_id);
      return Boolean(clienteId && clienteIds.has(clienteId));
    });
  }, [creditosOrEmpty, clientesOrEmpty]);

  const creditosPendientesValidos = useMemo(() => {
    return creditosConClienteValido.filter(c => {
      const u = String(c?.estado || '').trim().toUpperCase();
      return u === 'PENDIENTE' || u === 'PENDIENTE_APROBACION';
    });
  }, [creditosConClienteValido]);

  const creditosProcesadosValidos = useMemo(() => {
    return creditosConClienteValido.filter(c => {
      const u = String(c?.estado || '').trim().toUpperCase();
      return u === 'ACTIVO' || u === 'RECHAZADO' || u === 'FINALIZADO';
    });
  }, [creditosConClienteValido]);

  const solicitudesPendientes = creditosPendientesValidos.length;

  const solicitudesFondoIdsConEgresoPropia = useMemo(
    () =>
      new Set(
        movimientosCajaPropia
          .map(m => m.solicitudFondoId)
          .filter((id): id is string => Boolean(id)),
      ),
    [movimientosCajaPropia],
  );

  const solicitudesFondoPendientesAdmin = useMemo(
    () =>
      esMarcosPUsuario
        ? solicitudesFondoCredito.filter(s =>
            solicitudFondoCreditoVigenteParaAdmin(s, creditosOrEmpty, solicitudesFondoIdsConEgresoPropia),
          )
        : [],
    [esMarcosPUsuario, solicitudesFondoCredito, solicitudesFondoIdsConEgresoPropia, creditosOrEmpty],
  );

  const misSolicitudesFondoCredito = useMemo(() => {
    const emailNorm = normalizarEmail(loginEmail);
    return solicitudesFondoCredito.filter(s => {
      const em = normalizarEmail(s.solicitante_email);
      if (emailNorm && em && em === emailNorm) return true;
      return esRegistroDelCobrador(
        { cobradorId: s.cobrador_id, userId: s.cobrador_id } as PagoRegistro,
        authUserId,
        user,
        loginEmail,
      );
    });
  }, [solicitudesFondoCredito, loginEmail, authUserId, user]);

  /** Solo solicitudes con crédito aún pendiente de aprobación (oculta huérfanas de $100k, etc.). */
  const misSolicitudesFondoCreditoVigentes = useMemo(
    () => misSolicitudesFondoCredito.filter(s => solicitudFondoCreditoVigente(s, creditosOrEmpty)),
    [misSolicitudesFondoCredito, creditosOrEmpty],
  );

  const cumpleañosHoy = useMemo(() => {
    const ahora = new Date();
    const mes = String(ahora.getMonth() + 1).padStart(2, '0');
    const dia = String(ahora.getDate()).padStart(2, '0');
    return clientesOrEmpty.filter(c => {
      if (!c) return false;
      const fecha = String(c?.fechaNacimiento || '').slice(0, 10);
      if (!fecha) return false;
      const partes = fecha.split('-');
      return partes.length === 3 && partes[1] === mes && partes[2] === dia;
    });
  }, [clientesOrEmpty]);

  const resumenCajaMarcosDia = useMemo(() => {
    const h = hoy();
    const corte = cierreCajaMarcosAt;
    const gastosList = Array.isArray(gastos) ? gastos : [];
    /** Recaudación en vivo de cobradores/vendedores (hoy, sin esperar cierre de caja). */
    const {
      ingresosCampoHoy,
      egresosCampoHoy,
      cobradoAcumuladoCampo,
      porUsuarioCampo,
    } = calcularRecaudacionCampoHoy(pagosOrEmpty, gastosList, h);

    const pagosH = pagosOrEmpty.filter(p => {
      const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
      return (
        fd === h
        && esPagoEfectivo(p)
        && redondearPesos(Number(p.monto) || 0) > 0
        && perteneceContadorMarcosActivo(fd, p.fechaPago ?? (p as { timestamp?: number }).timestamp, corte)
      );
    });
    const gastosH = (Array.isArray(gastos) ? gastos : []).filter(
      g =>
        g
        && String(g.fecha || '').slice(0, 10) === h
        && perteneceContadorMarcosActivo(String(g.fecha || '').slice(0, 10), g.timestamp, corte),
    );
    const totalCobradoHoy = redondearPesos(pagosH.reduce((s, p) => s + (Number(p.monto) || 0), 0));
    const totalGastosHoy = redondearPesos(gastosH.reduce((s, g) => s + (Number(g.monto) || 0), 0));

    let totalIngresosCajaHoy = 0;
    let totalSalidasCajaHoy = 0;
    movimientosCaja.forEach(m => {
      const fd = String(m.createdAt).slice(0, 10);
      if (fd !== h || !perteneceContadorMarcosActivo(fd, m.createdAt, corte)) return;
      if (m.tipo === 'entrada') totalIngresosCajaHoy += redondearPesos(m.monto);
      else totalSalidasCajaHoy += redondearPesos(m.monto);
    });
    totalIngresosCajaHoy = redondearPesos(totalIngresosCajaHoy);
    totalSalidasCajaHoy = redondearPesos(totalSalidasCajaHoy);
    const totalCajaHoy = redondearPesos(
      totalCobradoHoy + totalIngresosCajaHoy - totalGastosHoy - totalSalidasCajaHoy,
    );

    const porUsuario = new Map<
      string,
      {
        cobrador: string;
        cobrado: number;
        gastos: number;
        ingresosCaja: number;
        salidasCaja: number;
        enMano: number;
        cantCobros: number;
        cantGastos: number;
      }
    >();
    const touch = (rawId: string) => {
      const cobrador = String(rawId || 'sin_usuario').trim() || 'sin_usuario';
      const actual = porUsuario.get(cobrador) || {
        cobrador,
        cobrado: 0,
        gastos: 0,
        ingresosCaja: 0,
        salidasCaja: 0,
        enMano: 0,
        cantCobros: 0,
        cantGastos: 0,
      };
      porUsuario.set(cobrador, actual);
      return actual;
    };
    pagosH.forEach(p => {
      const item = touch(String(p.cobradorId ?? p.userId ?? 'sin_usuario'));
      item.cobrado += redondearPesos(Number(p.monto) || 0);
      item.cantCobros += 1;
    });
    gastosH.forEach(g => {
      const item = touch(String(g.userId || 'sin_usuario'));
      item.gastos += redondearPesos(Number(g.monto) || 0);
      item.cantGastos += 1;
    });
    movimientosCaja.forEach(m => {
      const fd = String(m.createdAt).slice(0, 10);
      if (fd !== h || !perteneceContadorMarcosActivo(fd, m.createdAt, corte)) return;
      const item = touch(String(m.cobradorId || 'sin_usuario'));
      if (m.tipo === 'entrada') item.ingresosCaja += redondearPesos(m.monto);
      else item.salidasCaja += redondearPesos(m.monto);
    });
    porUsuario.forEach(item => {
      item.enMano = redondearPesos(item.cobrado + item.ingresosCaja - item.gastos - item.salidasCaja);
    });

    return {
      ingresosCampoHoy,
      egresosCampoHoy,
      cobradoAcumuladoCampo,
      totalCobradoHoy,
      totalGastosHoy,
      totalIngresosCajaHoy,
      totalSalidasCajaHoy,
      totalCajaHoy,
      netoCampoHoy: redondearPesos(totalCobradoHoy - totalGastosHoy),
      porUsuarioCampo,
      porUsuario: Array.from(porUsuario.values()).sort((a, b) => b.enMano - a.enMano),
      corteActivo: corte,
    };
  }, [pagosOrEmpty, gastos, movimientosCaja, cierreCajaMarcosAt]);

  const resumenCajaPropia = useMemo(() => {
    const h = hoy();
    const saldo = saldoCajaPropiaDesdeMovimientos(movimientosCajaPropia);
    const ingresosTotal = redondearPesos(
      movimientosCajaPropia.filter(m => m.tipo === 'entrada').reduce((s, m) => s + m.monto, 0),
    );
    const egresosTotal = redondearPesos(
      movimientosCajaPropia.filter(m => m.tipo === 'salida').reduce((s, m) => s + m.monto, 0),
    );
    const movsHoy = movimientosCajaPropia.filter(m => m.fecha === h);
    return {
      saldo,
      ingresosTotal,
      egresosTotal,
      movimientos: movimientosCajaPropia.slice(0, 80),
      ingresosHoy: redondearPesos(movsHoy.filter(m => m.tipo === 'entrada').reduce((s, m) => s + m.monto, 0)),
      egresosHoy: redondearPesos(movsHoy.filter(m => m.tipo === 'salida').reduce((s, m) => s + m.monto, 0)),
    };
  }, [movimientosCajaPropia]);

  // ==========================================
  // GPS
  // ==========================================
  const getGPS = useCallback((): Promise<{ lat: number; lng: number }> => {
    return new Promise((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        reject(new Error('Geolocalización no disponible en este entorno'));
        return;
      }
      setGpsLoading(true);
      navigator.geolocation.getCurrentPosition(
        pos => {
          const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setGpsPos(coords);
          setGpsLoading(false);
          resolve(coords);
        },
        err => {
          setGpsLoading(false);
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      );
    });
  }, []);

  const obtenerUbicacionAproximadaPorIP = useCallback(async (): Promise<{ lat: number; lng: number; fuente: string } | null> => {
    try {
      const res = await fetch('https://ipapi.co/json/');
      if (!res.ok) return null;
      const data = await res.json() as { latitude?: unknown; longitude?: unknown };
      const lat = Number(data.latitude);
      const lng = Number(data.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, fuente: 'ipapi' };
    } catch {
      return null;
    }
  }, []);

  const intentarCapturarGpsParaCobranza = useCallback(async (
    contextoLog: string,
    opts?: { forzar?: boolean },
  ): Promise<{ ok: true; coords: { lat: number; lng: number } } | { ok: false }> => {
    const forzar = Boolean(opts?.forzar);
    if (!forzar && gpsPos != null && (gpsPos.lat !== 0 || gpsPos.lng !== 0)) {
      return { ok: true, coords: gpsPos };
    }
    const actor = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    try {
      const coords = await getGPS();
      setBannerGpsInstrucciones(null);
      return { ok: true, coords };
    } catch (err: unknown) {
      const perm = await consultarPermisoGeolocalizacion();
      const instructivo = perm === 'denied' ? textoInstruccionesGPSDenegadoNavegador() : null;
      setBannerGpsInstrucciones(instructivo);
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: contextoLog,
        mensaje_error: mensajeErrorGeolocalizacion(err),
        datos_enviados: {
          permiso_detectado: perm,
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        },
        actor,
        meta: err && typeof err === 'object' && 'code' in err ? { code: (err as GeolocationPositionError).code } : {},
      });
      if (perm === 'denied') {
        alert(`Ubicación denegada para este sitio.\n\n${instructivo ?? textoInstruccionesGPSDenegadoNavegador()}\n\nEl cobro seguirá sin bloquearse y se guardará una marca de GPS fallido.`);
      } else {
        alert('No se pudo obtener la ubicación (tiempo agotado o señal insuficiente). El cobro continuará y quedará marcado como GPS fallido.');
      }
      const aproxIP = await obtenerUbicacionAproximadaPorIP();
      if (aproxIP) {
        const coords = { lat: aproxIP.lat, lng: aproxIP.lng };
        setGpsPos(coords);
        void insertarLogAuditoriaSupabase({
          tipo: 'cobro',
          contexto: `${contextoLog}_gps_aproximado_ip`,
          mensaje_error: 'GPS exacto fallido; se usa ubicación aproximada por IP',
          datos_enviados: { permiso_detectado: perm, fuente: aproxIP.fuente, lat: coords.lat, lng: coords.lng },
          actor,
        });
        return { ok: true, coords };
      }
      const coords = { lat: 0, lng: 0 };
      setGpsPos(coords);
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: `${contextoLog}_gps_fallido`,
        mensaje_error: 'GPS Fallido: no se obtuvo ubicación exacta ni aproximada por IP',
        datos_enviados: { permiso_detectado: perm },
        actor,
      });
      return { ok: true, coords };
    }
  }, [gpsPos, getGPS, loginEmail, user, authUserMeta, obtenerUbicacionAproximadaPorIP]);

  // ==========================================
  // LOGIN
  // ==========================================
  const doLogin = async (username: string, password: string) => {
    setLoading(true);
    const usernameTrim = username.trim();
    const passwordTrim = password.trim();
    const perfilLogin = resolverPerfilDesdeEntradaLogin(usernameTrim);

    if (perfilLogin) {
      const authEmail = perfilLogin.authEmail;
      let authData: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['data'] | null = null;
      let authError: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>['error'] | null = null;

      const intentoAuth = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: passwordTrim,
      });
      authData = intentoAuth.data;
      authError = intentoAuth.error;

      if (authError && perfilLogin.rolDefecto === 'mensual') {
        let claveLocalOk = await verificarClaveModuloMensual(usernameTrim, passwordTrim);
        if (!claveLocalOk) {
          const loginNorm = normalizarLoginUsuario(usernameTrim);
          const canon = ALIAS_LOGIN_USUARIO[loginNorm] ?? loginNorm;
          if (canon === 'mensual' && passwordTrim === 'Emamoreno7') claveLocalOk = true;
        }
        if (claveLocalOk) {
          const prov = await provisionarAuthModuloMensual(authEmail, passwordTrim);
          if (prov.ok) {
            const reintento = await supabase.auth.signInWithPassword({
              email: authEmail,
              password: passwordTrim,
            });
            authData = reintento.data;
            authError = reintento.error;
          } else {
            alert(prov.error || 'No se pudo activar la cuenta mensual en Auth.');
            setLoading(false);
            return;
          }
        }
      }

      if (authError) {
        console.error('Supabase login error:', authError.message, authError.code);
        audit('LOGIN_FAILED', `Login fallido: ${usernameTrim}`);
        await logAuditDb('LOGIN_FAILED', `Login fallido: ${usernameTrim}`);
        void registrarEventoSesion({
          username: usernameTrim,
          email: authEmail,
          accion: 'LOGIN_FAILED',
          detalle: authError.message,
        });
        if (perfilLogin.rolDefecto === 'mensual') {
          alert(
            'Credenciales incorrectas para el módulo mensual.\n\n'
            + 'Usuario: mensual\nClave: Emamoreno7\n\n'
            + 'Si persiste, ejecutá las migraciones 021–023 y creá en Auth el usuario mensual1@emd.com con clave Emamoreno7.',
          );
        } else {
          alert('Credenciales incorrectas');
        }
        setLoading(false);
        return;
      }
      const { data: loginSessionData } = await supabase.auth.getSession();
      const loginToken = loginSessionData.session?.access_token ?? null;
      if (!loginSessionData.session || !loginToken) {
        alert('No se pudo establecer la sesión autenticada. Iniciá sesión nuevamente.');
        setLoading(false);
        return;
      }
      localStorage.removeItem(CP_PROVEEDOR_TOKEN_KEY);
      setProveedorLocal(null);
      const authUserEmail = (authData?.user?.email || authEmail).toLowerCase();
      const perfilSesion = perfilLogin || resolverPerfilDesdeAuthEmail(authUserEmail);
      let rolUsuario = await resolverRolUsuarioSesion(authData?.user?.id ?? null, authUserEmail);
      if (perfilLogin.rolDefecto === 'mensual') rolUsuario = 'mensual';
      const usernameSesion = (perfilSesion?.login || normalizarLoginUsuario(usernameTrim) || authUserEmail.split('@')[0]).trim();
      if (esUsuarioPruebaSesion(usernameSesion, authUserEmail)) {
        const accDemo = await verificarAccesoDemoPruebaEnServidor(usernameSesion);
        if (!accDemo.ok) {
          await supabase.auth.signOut();
          setTrialFinPrueba(null);
          alert(mensajeBloqueoDemoPrueba(accDemo.motivo));
          setLoading(false);
          return;
        }
        setTrialFinPrueba(accDemo.trialFin);
      } else {
        setTrialFinPrueba(null);
      }
      const u = { username: usernameSesion, rol: rolUsuario };
      localStorage.setItem('cp_last_login_user', usernameSesion);
      localStorage.setItem('cp_session', JSON.stringify(u));
      setUser(usernameSesion);
      setRol(rolUsuario);
      setLoginEmail(authUserEmail);
      setPage(esUsuarioRootOperador(usernameSesion, authUserEmail) ? 'root_console' : 'dashboard');
      setAuthUserMeta((authData?.user?.user_metadata as Record<string, unknown> | undefined) ?? null);
      const { data: s2 } = await supabase.auth.getSession();
      const authIdLogin = s2.session?.user?.id ?? null;
      setAuthUserId(authIdLogin);
      registrarEtiquetaCobradorReferencia(
        authIdLogin,
        nombreParaMostrarSesion({
          loginEmail: authUserEmail,
          usernameState: usernameSesion,
          authUser: authData?.user ? { user_metadata: authData.user.user_metadata as Record<string, unknown> } : null,
        }),
        rolUsuario,
      );
      if (!esUsuarioRootOperador(usernameSesion, authUserEmail)) {
        await fetchData({ silencioso: true });
      }
      audit('LOGIN_SUCCESS', `Login exitoso: ${usernameTrim}`);
      await logAuditDb('LOGIN_SUCCESS', `Login exitoso: ${usernameTrim}`);
      void registrarEventoSesion({
        username: usernameSesion,
        email: authUserEmail,
        accion: 'LOGIN_SUCCESS',
        detalle: `Login exitoso: ${usernameTrim}`,
      });
      setLoading(false);
      return;
    }

    const provOk = await loginProveedorLocal(usernameTrim, passwordTrim);
    if (!provOk) {
      audit('LOGIN_FAILED', `Login proveedor fallido: ${usernameTrim}`);
      alert('Credenciales incorrectas');
      setLoading(false);
      return;
    }
    try {
      await supabase.auth.signOut();
    } catch {
      /* sin sesión Auth previa */
    }
    localStorage.setItem(CP_PROVEEDOR_TOKEN_KEY, provOk.token);
    localStorage.setItem('cp_last_login_user', provOk.login);
    localStorage.setItem('cp_session', JSON.stringify({ username: provOk.login, rol: 'proveedor', local: true }));
    setProveedorLocal({
      id: provOk.proveedor_id,
      nombre: provOk.nombre,
      login: provOk.login,
      auth_email: `${provOk.login}@proveedor.local`,
      activo: true,
    });
    setUser(provOk.login);
    setRol('proveedor');
    setLoginEmail(null);
    setAuthUserId(null);
    setAuthUserMeta(null);
    setPage('mi_inversion');
    const inv = await fetchInversionesProveedorToken(provOk.token);
    setInversionesProveedor(inv);
    audit('LOGIN_SUCCESS', `Login proveedor: ${provOk.login}`);
    setLoading(false);
  };

  const doLogout = async () => {
    const actor = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    void registrarEventoSesion({
      username: user,
      email: loginEmail,
      accion: 'LOGOUT',
      detalle: `Logout: ${actor}`,
    });
    try {
      registrarAuditoria('LOGOUT', `Logout: ${actor}`);
      await logAuditDb('LOGOUT', `Logout: ${actor}`);
    } catch {
      /* seguimos con cierre de sesión aunque falle auditoría remota */
    }
    try {
      await supabase.auth.signOut();
    } catch {
      /* signOut local aunque falle red */
    }
    resetSession();
    setUser(null); setAuthUserId(null); setAuthUserMeta(null); setLoginEmail(null); setRol(null); setPage('login');
    setSessionReady(true);
    try {
      sessionStorage.clear();
      localStorage.clear();
    } catch {
      /* */
    }
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      } catch {
        /* */
      }
    }
  };

  // ==========================================
  // CLIENTES
  // ==========================================
  const subirDocumentoCliente = useCallback(async (file: File, lado: 'frente' | 'dorso', clienteId?: string) => {
    const cid = clienteId || genId();
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `public/dni/${cid}/${lado}_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('clientes-documentos').upload(path, file, {
      upsert: true,
      contentType: file.type || 'image/jpeg',
    });
    if (error) {
      throw error;
    }
    const { data } = supabase.storage.from('clientes-documentos').getPublicUrl(path);
    return data.publicUrl;
  }, []);
  const subirVideoVerificacionCliente = useCallback(async (
    file: File,
    clienteId: string,
    pathAnterior?: string | null,
  ) => {
    if (file.size > MAX_BYTES_VIDEO_CLIENTE) {
      throw new ErrorSubidaVideoCliente('El video no puede superar 25 MB.');
    }
    const duracion = await obtenerDuracionVideoSegundos(file);
    if (duracion <= 0 || duracion > MAX_DURACION_VIDEO_CLIENTE_SEG + 0.5) {
      const seg = duracion > 0 ? Math.ceil(duracion) : '?';
      throw new ErrorSubidaVideoCliente(
        `El video debe durar como máximo ${MAX_DURACION_VIDEO_CLIENTE_SEG} segundos (detectado: ${seg}s).`,
      );
    }
    const cid = String(clienteId).trim();
    if (!esUuidClienteId(cid)) {
      throw new ErrorSubidaVideoCliente('El cliente aún no tiene UUID válido para subir el video.');
    }
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const path = `public/negocio/${cid}/video_${Date.now()}.${ext}`;
    const pathPrev = String(pathAnterior || '').trim();
    if (pathPrev) {
      await supabase.storage.from(BUCKET_VIDEO_VERIFICACION_CLIENTE).remove([pathPrev]);
    }
    const { error } = await supabase.storage.from(BUCKET_VIDEO_VERIFICACION_CLIENTE).upload(path, file, {
      upsert: false,
      contentType: file.type || 'video/mp4',
    });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET_VIDEO_VERIFICACION_CLIENTE).getPublicUrl(path);
    const subidoAt = new Date().toISOString();
    const expiraAt = new Date(Date.now() + DIAS_RETENCION_VIDEO_CLIENTE * 86400000).toISOString();
    return { url: data.publicUrl, path, subidoAt, expiraAt };
  }, []);
  const persistirVideoVerificacionCliente = useCallback(async (
    clienteId: string,
    file: File,
    pathAnterior?: string | null,
  ) => {
    const meta = await subirVideoVerificacionCliente(file, clienteId, pathAnterior);
    const { error } = await supabase.from('clientes').update({
      video_verificacion_url: meta.url,
      video_verificacion_path: meta.path,
      video_verificacion_subido_at: meta.subidoAt,
      video_verificacion_expira_at: meta.expiraAt,
    } as any).eq('id', clienteId);
    if (error) throw error;
    return meta;
  }, [subirVideoVerificacionCliente]);
  const handleSaveCliente = async (cli: Partial<Cliente>, opts?: OpcionesGuardarCliente) => {
    const toNullableDate = (v: unknown) => {
      if (v === '' || v === undefined || v === null) return null;
      return String(v);
    };
    const toClienteRow = (c: Partial<Cliente> | null | undefined, cobradorId: string, incluirGps = true) => {
      const base: Record<string, unknown> = {
        nombre: c?.nombre ?? '',
        apellido: c?.apellido ?? '',
        dni: c?.dni ?? '',
        telefono: normalizarTelefonoArg549(String(c?.telefono ?? '')),
        fecha_nacimiento: toNullableDate(c?.fechaNacimiento),
        direccion: c?.direccion ?? '',
        dni_frente_url: c?.dniFrenteUrl ?? null,
        dni_dorso_url: c?.dniDorsoUrl ?? null,
        video_verificacion_url: c?.videoVerificacionUrl ?? null,
        video_verificacion_path: c?.videoVerificacionPath ?? null,
        video_verificacion_subido_at: c?.videoVerificacionSubidoAt ?? null,
        video_verificacion_expira_at: c?.videoVerificacionExpiraAt ?? null,
        cobrador_id: cobradorId,
        orden_ruta: c?.orden_ruta != null && Number.isFinite(Number(c.orden_ruta)) ? Math.round(Number(c.orden_ruta)) : null,
        ambito: c?.ambito ?? ambitoDatosSesion(rol),
      };
      if (incluirGps) {
        base.lat = c?.lat != null && Number.isFinite(Number(c.lat)) ? Number(c.lat) : null;
        base.lng = c?.lng != null && Number.isFinite(Number(c.lng)) ? Number(c.lng) : null;
        if (c?.coordenadaErr) base.coordenada_err = String(c.coordenadaErr);
      }
      return base;
    };
    const errorFaltaColumnaGpsCliente = (err: { message?: string } | null | undefined) => {
      const msg = String(err?.message ?? '').toLowerCase();
      return msg.includes("'lat'") || msg.includes("'lng'") || msg.includes('schema cache');
    };
    const actualizarClienteSupabase = async (row: Record<string, unknown>, cliId: string) => {
      let { error } = await supabase.from('clientes').update(row as any).eq('id', cliId);
      if (error && errorFaltaColumnaGpsCliente(error)) {
        const sinGps = toClienteRow(
          {
            nombre: String(row.nombre ?? ''),
            apellido: String(row.apellido ?? ''),
            dni: String(row.dni ?? ''),
            telefono: String(row.telefono ?? ''),
            fechaNacimiento: row.fecha_nacimiento as string | undefined,
            direccion: String(row.direccion ?? ''),
            dniFrenteUrl: row.dni_frente_url as string | undefined,
            dniDorsoUrl: row.dni_dorso_url as string | undefined,
            videoVerificacionUrl: row.video_verificacion_url as string | undefined,
            videoVerificacionPath: row.video_verificacion_path as string | undefined,
            videoVerificacionSubidoAt: row.video_verificacion_subido_at as string | undefined,
            videoVerificacionExpiraAt: row.video_verificacion_expira_at as string | undefined,
            orden_ruta: row.orden_ruta as number | null | undefined,
            ambito: row.ambito as string | undefined,
          },
          String(row.cobrador_id ?? cobradorId),
          false,
        );
        ({ error } = await supabase.from('clientes').update(sinGps as any).eq('id', cliId));
      }
      return { error };
    };
    const insertarClienteSupabase = async (row: Record<string, unknown>, cliOriginal?: Partial<Cliente>) => {
      let { data, error } = await supabase.from('clientes').insert([row as any]).select('*').single();
      if (error && errorFaltaColumnaGpsCliente(error) && cliOriginal) {
        const sinGps = toClienteRow(cliOriginal, String(row.cobrador_id ?? cobradorId), false);
        ({ data, error } = await supabase.from('clientes').insert([sinGps as any]).select('*').single());
      }
      return { data, error };
    };

    const { data: sessInicial } = await supabase.auth.getSession();
    if (!sessInicial.session?.access_token) {
      const { data: ref1 } = await supabase.auth.refreshSession();
      if (!ref1.session?.access_token) {
        await doLogout();
        throw new SesionExpiradaSupabaseError();
      }
    }

    const sesionOk = await asegurarSesionEscritura();
    if (!sesionOk) {
      await doLogout();
      throw new SesionExpiradaSupabaseError();
    }

    const { data: authUserState } = await supabase.auth.getUser();
    if (!authUserState.user) {
      await doLogout();
      throw new SesionExpiradaSupabaseError();
    }
    const { data: sessGuardadoCliente } = await supabase.auth.getSession();
    const cobradorId = cobradorIdDesdeSesionParaCliente(
      authUserState.user?.id,
      sessGuardadoCliente?.session ?? null,
      user,
      loginEmail,
    );
    let altaClienteExitoReciente = false;
    let cerrarModalPostGuardado = false;
    const cliIdContacto = String(cli.id || '').trim();
    const esEdicionClienteUuid = esUuidClienteId(cliIdContacto) && clientesOrEmpty.some(c => c.id === cliIdContacto);
    if (esMatiasOVendedorUsuario && esEdicionClienteUuid) {
      const prev = clientesOrEmpty.find(c => c.id === cliIdContacto);
      if (!prev) {
        alert('Cliente no encontrado.');
        return;
      }
      const telefonoNorm = normalizarTelefonoArg549(String(cli.telefono ?? prev.telefono));
      if (soloDigitosTelefono(telefonoNorm).length < 11) {
        alert('Ingresá un celular válido: solo números, con prefijo 549 (ej: 5492634123456).');
        return;
      }
      const dir = String(cli.direccion ?? prev.direccion ?? '').trim();
      if (!dir) {
        alert('La dirección es obligatoria.');
        return;
      }
      const merged: Cliente = {
        ...prev,
        telefono: telefonoNorm,
        direccion: dir,
        lat: cli.lat !== undefined ? cli.lat : prev.lat,
        lng: cli.lng !== undefined ? cli.lng : prev.lng,
        coordenadaErr: cli.coordenadaErr,
      };
      const rowContacto = toClienteRow(merged, cobradorId);
      const { error: errContacto } = await actualizarClienteSupabase(rowContacto, cliIdContacto);
      if (errContacto) {
        console.error('Supabase update cliente (contacto) error:', errContacto);
        if (esErrorSesionSupabase(errContacto)) {
          await doLogout();
          throw new SesionExpiradaSupabaseError();
        }
        alert('No se pudo guardar: ' + (errContacto.message || 'Error de Supabase'));
        return;
      }
      save({ clientes: clientesOrEmpty.map(c => (c.id === cliIdContacto ? merged : c)) });
      audit('CLIENTE_EDITADO', `Cliente contacto actualizado: ${merged.nombre}`, gpsPos || undefined);
      void logAuditDb('CLIENTE_EDITADO', `Cliente contacto actualizado: ${merged.nombre}`);
      await fetchData({ silencioso: true });
      setMCliente(null);
      return;
    }
    if (!cli.nombre || !cli.apellido || !cli.dni || !cli.telefono || !cli.fechaNacimiento || !cli.direccion) {
      alert('Nombre, Apellido, DNI, Teléfono, Fecha de nacimiento y Dirección son obligatorios');
      return;
    }
    const telefonoNorm = normalizarTelefonoArg549(String(cli.telefono ?? ''));
    if (soloDigitosTelefono(telefonoNorm).length < 11) {
      alert('Ingresá un celular válido: solo números, con prefijo 549 (ej: 5492634123456).');
      return;
    }
    const cliId = String(cli.id || '').trim();
    const esEdicion = esUuidClienteId(cliId) && clientesOrEmpty.some(c => c.id === cliId);
    /** Solo para rutas en Storage (no es el id del cliente en BD). En altas nuevas nunca usamos el id del cliente hasta el INSERT. */
    const storagePathId = esEdicion
      ? cliId
      : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `pending_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`);

    let dniFrenteUrl = String(cli.dniFrenteUrl || '').trim();
    let dniDorsoUrl = String(cli.dniDorsoUrl || '').trim();
    const fileF = opts?.dniFiles?.frente;
    const fileD = opts?.dniFiles?.dorso;

    const cliSinIdCliente: Partial<Cliente> = { ...cli };
    delete (cliSinIdCliente as { id?: string }).id;

    if (esEdicion) {
      if (fileF) {
        try {
          dniFrenteUrl = await subirDocumentoCliente(fileF, 'frente', storagePathId);
        } catch (e) {
          console.error('[Cliente save] Upload failed (frente):', e);
          throw new ErrorSubidaDniCliente(
            'No se pudo subir el frente del DNI al almacenamiento. Revisá tu conexión o permisos del bucket e intentá de nuevo.',
          );
        }
      }
      if (fileD) {
        try {
          dniDorsoUrl = await subirDocumentoCliente(fileD, 'dorso', storagePathId);
        } catch (e) {
          console.error('[Cliente save] Upload failed (dorso):', e);
          throw new ErrorSubidaDniCliente(
            'No se pudo subir el dorso del DNI al almacenamiento. Revisá tu conexión o permisos del bucket e intentá de nuevo.',
          );
        }
      }
      if (!dniFrenteUrl || !dniDorsoUrl) {
        throw new ErrorSubidaDniCliente(
          'Seleccioná el frente y el dorso del DNI. Se suben al almacenamiento al tocar Guardar; si falla la subida, no se guarda el cliente.',
        );
      }
      const cliG: Partial<Cliente> = {
        ...cliSinIdCliente,
        id: cliId,
        telefono: telefonoNorm,
        dniFrenteUrl,
        dniDorsoUrl,
      };
      const clienteEditado = clientesOrEmpty.map(c => c.id === cliId ? { ...c, ...cliG } : c).find(c => c.id === cliId);
      const rowCompleto = toClienteRow(clienteEditado ?? cliG, cobradorId);
      const { error } = await actualizarClienteSupabase(rowCompleto, cliId);
      if (error) {
        console.error('Error detallado de Supabase:', error);
        if (esErrorSesionSupabase(error)) {
          await doLogout();
          throw new SesionExpiradaSupabaseError();
        }
        alert('No se pudo guardar el cliente: ' + (error.message || 'Error de Supabase'));
        return;
      }
      save({ clientes: clientesOrEmpty.map(c => c.id === cliId ? { ...c, ...cliG } : c) });
      audit('CLIENTE_EDITADO', `Cliente editado: ${cliG.nombre}`, gpsPos || undefined);
      void logAuditDb('CLIENTE_EDITADO', `Cliente editado: ${cliG.nombre}`);
      if (opts?.videoNegocio) {
        try {
          const prevVid = clientesOrEmpty.find(c => c.id === cliId);
          const metaVid = await persistirVideoVerificacionCliente(cliId, opts.videoNegocio, prevVid?.videoVerificacionPath);
          save({
            clientes: clientesOrEmpty.map(c => c.id === cliId ? {
              ...c,
              ...cliG,
              videoVerificacionUrl: metaVid.url,
              videoVerificacionPath: metaVid.path,
              videoVerificacionSubidoAt: metaVid.subidoAt,
              videoVerificacionExpiraAt: metaVid.expiraAt,
            } : c),
          });
        } catch (eVid) {
          console.error('[Cliente save] Upload video failed:', eVid);
          alert(
            eVid instanceof ErrorSubidaVideoCliente
              ? eVid.message
              : 'Cliente guardado, pero no se pudo subir el video del negocio. Podés reintentarlo editando la ficha.',
          );
        }
      }
      await fetchData({ silencioso: true });
      cerrarModalPostGuardado = true;
    } else {
      try {
        // A: Storage (el id del cliente lo genera solo Supabase en el paso B)
        if (fileF) {
          try {
            dniFrenteUrl = await subirDocumentoCliente(fileF, 'frente', storagePathId);
          } catch (e) {
            console.error('[Cliente save] Upload failed (frente):', e);
            throw new ErrorSubidaDniCliente(
              'No se pudo subir el frente del DNI al almacenamiento. Revisá tu conexión o permisos del bucket e intentá de nuevo.',
            );
          }
        }
        if (fileD) {
          try {
            dniDorsoUrl = await subirDocumentoCliente(fileD, 'dorso', storagePathId);
          } catch (e) {
            console.error('[Cliente save] Upload failed (dorso):', e);
            throw new ErrorSubidaDniCliente(
              'No se pudo subir el dorso del DNI al almacenamiento. Revisá tu conexión o permisos del bucket e intentá de nuevo.',
            );
          }
        }
        if (!dniFrenteUrl || !dniDorsoUrl) {
          throw new ErrorSubidaDniCliente(
            'Seleccioná el frente y el dorso del DNI. Se suben al almacenamiento al tocar Guardar; si falla la subida, no se crea el cliente.',
          );
        }

        const cliG: Partial<Cliente> = {
          ...cliSinIdCliente,
          telefono: telefonoNorm,
          dniFrenteUrl,
          dniDorsoUrl,
        };

        const ordenRutaNuevo = esMarcosPUsuario && cliG.orden_ruta != null && Number.isFinite(Number(cliG.orden_ruta))
          ? Math.round(Number(cliG.orden_ruta))
          : siguienteOrdenRutaCobrador(clientesOrEmpty, cobradorId);
        const nuevo: Cliente = {
          id: '',
          nombre: cliG.nombre!,
          apellido: cliG.apellido || '',
          dni: cliG.dni || '',
          fechaNacimiento: cliG.fechaNacimiento || '',
          telefono: telefonoNorm,
          direccion: cliG.direccion || '',
          dniFrenteUrl: cliG.dniFrenteUrl || '',
          dniDorsoUrl: cliG.dniDorsoUrl || '',
          lat: cliG.lat,
          lng: cliG.lng,
          saldo: 0,
          quota: 0,
          frecuencia: 'semanal',
          fechaAlta: hoy(),
          activo: true,
          notas: '',
          promesaPago: '',
          promesaFecha: '',
          orden_ruta: ordenRutaNuevo,
        };

        // B + C: INSERT y respuesta con UUID (.select().single() en insertarClienteSupabase)
        const rowCompleto = toClienteRow(nuevo, cobradorId);
        const { data: insertData, error } = await insertarClienteSupabase(rowCompleto, nuevo);
        if (error) {
          console.error('Error detallado de Supabase:', error);
          if (esErrorSesionSupabase(error)) {
            await doLogout();
            throw new SesionExpiradaSupabaseError();
          }
          throw new Error(String((error as { message?: string }).message || 'Error al insertar cliente'));
        }

        let nuevoDesdeSupabase = mapClienteFilaSupabase(insertData as Record<string, unknown> | null | undefined);
        nuevoDesdeSupabase = {
          ...nuevoDesdeSupabase,
          lat: nuevoDesdeSupabase.lat ?? cliG.lat,
          lng: nuevoDesdeSupabase.lng ?? cliG.lng,
          orden_ruta: nuevoDesdeSupabase.orden_ruta ?? ordenRutaNuevo,
          cobrador_id: nuevoDesdeSupabase.cobrador_id ?? cobradorId,
        };
        let idReal = String(nuevoDesdeSupabase.id || '').trim();
        const buscarUuidPorDniTel = (list: Cliente[]) => list.find(
          c => esUuidClienteId(c.id)
            && String(c.dni || '').trim() === String(cliG.dni || '').trim()
            && soloDigitosTelefono(c.telefono) === soloDigitosTelefono(telefonoNorm),
        );
        if (esUuidClienteId(idReal)) {
          setClientes(prev => mergeClienteAlInicioSiFalta(Array.isArray(prev) ? prev : [], nuevoDesdeSupabase));
        } else {
          let lista = (await fetchData())?.clientes ?? [];
          const hit = buscarUuidPorDniTel(lista);
          if (hit) idReal = hit.id;
          if (!esUuidClienteId(idReal)) {
            await new Promise(r => setTimeout(r, 400));
            lista = (await fetchData())?.clientes ?? [];
            const hit2 = buscarUuidPorDniTel(lista);
            if (hit2) idReal = hit2.id;
          }
        }
        if (!esUuidClienteId(idReal)) {
          console.error('Error detallado de Supabase: no se obtuvo UUID tras insert', { insertData, listaLen: 'ver fetchData' });
          throw new Error(
            'El cliente se guardó en el servidor pero no se pudo obtener su UUID en la lista local. Reintentá o recargá la página.',
          );
        }

        await refetchClientesSupabase(nuevoDesdeSupabase);
        if (opts?.videoNegocio) {
          try {
            const metaVid = await persistirVideoVerificacionCliente(idReal, opts.videoNegocio);
            nuevoDesdeSupabase = {
              ...nuevoDesdeSupabase,
              videoVerificacionUrl: metaVid.url,
              videoVerificacionPath: metaVid.path,
              videoVerificacionSubidoAt: metaVid.subidoAt,
              videoVerificacionExpiraAt: metaVid.expiraAt,
            };
          } catch (eVid) {
            console.error('[Cliente save] Upload video failed (alta):', eVid);
            alert(
              eVid instanceof ErrorSubidaVideoCliente
                ? `${eVid.message} El cliente sí quedó guardado; podés subir el video editando la ficha.`
                : 'Cliente guardado, pero no se pudo subir el video del negocio. Podés reintentarlo editando la ficha.',
            );
          }
        }
        await fetchData({ silencioso: true });
        setClientes(prev => mergeClienteAlInicioSiFalta(Array.isArray(prev) ? prev : [], nuevoDesdeSupabase));

        audit('CLIENTE_CREADO', `Cliente creado: ${nuevo.nombre} (id ${idReal})`, gpsPos || undefined);
        void logAuditDb('CLIENTE_CREADO', `Cliente creado: ${nuevo.nombre} (id ${idReal})`);
        altaClienteExitoReciente = true;
        cerrarModalPostGuardado = true;
      } catch (e) {
        console.error('Error detallado de Supabase:', e);
        if (e instanceof SesionExpiradaSupabaseError || e instanceof ErrorSubidaDniCliente) throw e;
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    if (altaClienteExitoReciente) setClienteModalNonce(n => n + 1);
    if (cerrarModalPostGuardado) setMCliente(null);
  };

  const handleDeleteCliente = (id: string) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede eliminar clientes.');
      return;
    }
    if (confirm('¿Eliminar cliente?')) {
      save({ clientes: clientesOrEmpty.filter(c => c.id !== id), fichas: fichasOrEmpty.filter(f => f.clienteId !== id) });
      audit('CLIENTE_ELIMINADO', `Cliente eliminado ID: ${id}`);
      void logAuditDb('CLIENTE_ELIMINADO', `Cliente eliminado ID: ${id}`);
      void refrescarDatosApp();
    }
  };

  // Geolocalizar cliente (coordenadas numéricas preferidas para navegación)
  const geoCliente = (cli: Cliente) => {
    const lat = cli.lat != null ? Number(cli.lat) : NaN;
    const lng = cli.lng != null ? Number(cli.lng) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank', 'noopener,noreferrer');
    } else if (cli.direccion) {
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cli.direccion)}`, '_blank', 'noopener,noreferrer');
    }
  };

  const waCliente = (cli: Cliente) => {
    const empresaMsg = data.config.nombreEmpresa || MARCA_COMPLETA;
    window.open(
      generarLinkWhatsApp(
        cli.telefono,
        `Hola ${nombreCompletoCliente(cli)}, te contactamos desde ${empresaMsg}. Tu saldo pendiente es ${fmt(cli.saldo)}.`,
      ),
      '_blank',
    );
  };

  const crearImagenCumpleanos = async (cli: Cliente) => {
    const empresa = data.config.nombreEmpresa || M.nombreEmpresa;
    const nombreCompleto = nombreCompletoCliente(cli);
    const mensaje = `¡Feliz Cumpleaños ${nombreCompleto}! Te desea lo mejor todo el equipo de ${empresa}. Gracias por confiar en nosotros, ¡te esperamos para seguir creciendo juntos!`;
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar la imagen de cumpleaños.');
    const grad = ctx.createLinearGradient(0, 0, 900, 900);
    grad.addColorStop(0, '#fff7ed');
    grad.addColorStop(0.5, '#fef3c7');
    grad.addColorStop(1, '#fce7f3');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 900, 900);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 10;
    ctx.roundRect(40, 40, 820, 820, 36);
    ctx.stroke();
    ctx.fillStyle = '#92400e';
    ctx.font = '700 46px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(empresa, 450, 125);
    ctx.font = '900 74px Arial, sans-serif';
    ctx.fillStyle = '#be123c';
    ctx.fillText('¡Feliz Cumpleaños!', 450, 250);
    ctx.font = '800 62px Arial, sans-serif';
    ctx.fillStyle = '#111827';
    ctx.fillText(nombreCompleto, 450, 330);
    ctx.font = '32px Arial, sans-serif';
    ctx.fillStyle = '#374151';
    const palabras = mensaje.replace(`¡Feliz Cumpleaños ${nombreCompleto}! `, '').split(' ');
    const lineas: string[] = [];
    let linea = '';
    palabras.forEach(palabra => {
      const intento = `${linea} ${palabra}`.trim();
      if (ctx.measureText(intento).width > 700 && linea) {
        lineas.push(linea);
        linea = palabra;
      } else {
        linea = intento;
      }
    });
    if (linea) lineas.push(linea);
    lineas.slice(0, 8).forEach((l, i) => ctx.fillText(l, 450, 440 + i * 45));
    ctx.font = '64px Arial, sans-serif';
    ctx.fillText('🎂✨', 450, 790);
    ctx.globalAlpha = 0.62;
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#0c4a6e';
    ctx.textAlign = 'center';
    ctx.fillText(MARCA_PRIMARIA, 450, 848);
    ctx.font = '500 18px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#075985';
    ctx.fillText(MARCA_DESCRIPTOR, 450, 878);
    ctx.globalAlpha = 1;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('No se pudo generar la imagen de cumpleaños.')), 'image/png', 1);
    });
    const nombre = (nombreCompletoCliente(cli) || 'Cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'Cliente';
    return new File([blob], `Cumpleanos_${nombre}_${hoy()}.png`, { type: 'image/png' });
  };

  const enviarSaludoCumpleanos = async (cli: Cliente) => {
    try {
      const file = await crearImagenCumpleanos(cli);
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ files: [file] });
        return;
      }
      descargarArchivo(file);
      const tel = normalizarTelefonoArg549(cli.telefono);
      if (soloDigitosTelefono(tel).length < 11) {
        alert('Imagen descargada. El cliente no tiene un WhatsApp válido.');
        return;
      }
      // Cero texto: abre WhatsApp sin mensaje para adjuntar solo la tarjeta.
      window.open(`https://wa.me/${tel}`, '_blank');
    } catch (error: any) {
      console.error('Error enviando saludo de cumpleaños:', error);
      alert(error?.message || 'No se pudo generar el saludo de cumpleaños.');
    }
  };

  const handleCerrarDiaMarcos = useCallback(async () => {
    if (!esMarcosPUsuario) return;
    const pendientes = rendicionesPendientesAdmin.filter(c => c.fecha === hoy());
    if (pendientes.length > 0) {
      if (
        !confirm(
          `Hay ${pendientes.length} rendición(es) sin aceptar.\n\n¿Cerrar el día igual? Los contadores en pantalla pasan a $0; el acumulado queda en caja propia hasta que registres un egreso.`,
        )
      ) {
        return;
      }
    } else if (
      !confirm(
        '¿Cerrar el día?\n\nLos contadores en tiempo real (Total cobrado, gastos, Total Caja) vuelven a $0.\nEl saldo de caja propia se mantiene hasta que registres un egreso.',
      )
    ) {
      return;
    }
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('configuracion')
      .update({ cierre_caja_marcos_at: now, updated_at: now })
      .eq('id', 'global_config');
    if (error) {
      const { error: insErr } = await supabase.from('configuracion').upsert([{
        id: 'global_config',
        cierre_caja_marcos_at: now,
        updated_at: now,
        nombre_empresa: data.config.nombreEmpresa,
        interes_credito_m: data.config.interesCreditoM,
        interes_credito_p: data.config.interesCreditoP,
      } as Record<string, unknown>]);
      if (insErr) {
        alert('No se pudo cerrar el día (¿migración 042?): ' + (insErr.message || ''));
        return;
      }
    }
    const saldoAntes = saldoCajaPropiaDesdeMovimientos(movimientosCajaPropia);
    audit('CONFIG_CAMBIO', `Cierre de día Marcos — contadores reiniciados · caja propia ${fmt(saldoAntes)}`);
    await fetchData({ silencioso: true });
    const saldo = await obtenerSaldoCajaPropiaDesdeDb();
    alert(`Día cerrado. Contadores en $0. Saldo caja propia (acumulado): ${fmt(saldo)}.`);
  }, [esMarcosPUsuario, rendicionesPendientesAdmin, data.config, movimientosCajaPropia, audit, fetchData]);

  // ==========================================
  // FICHAS
  // ==========================================
  const handleSaveFicha = async (fic: Partial<Ficha>) => {
    if (!fic.clienteId || !fic.montoTotal) { alert('Datos incompletos: falta clienteId o montoTotal'); return; }
    const cli = clientesOrEmpty.find(c => c.id === fic.clienteId);
    if (!cli) { alert('Cliente no encontrado'); return; }
    
    const montoTotal = redondearPesos(Number(fic.montoTotal));
    const cuotasTotales = Number(fic.cuotas || 1);
    const montoCuota = cuotasTotales > 0 ? montoCuotaCreditoDesdeTotal(montoTotal, cuotasTotales) : montoTotal;
    
    const prevFicha = fic.id ? fichasOrEmpty.find(x => x.id === fic.id) : undefined;
    const planPago: PlanPago = fic.plan_pago === 'Diario' || fic.plan_pago === 'Quincenal' || fic.plan_pago === 'Mensual'
      ? fic.plan_pago
      : (prevFicha ? planPagoDeFicha(prevFicha) : 'Mensual');

    if (fic.id) {
      // ========== UPDATE ==========
      const editada: Ficha[] = fichasOrEmpty.map((f): Ficha => f.id === fic.id ? { ...f, ...fic, plan_pago: planPago, estado: 'pendiente' } : f);
      save({ fichas: editada });
      const row = editada.find(x => x.id === fic.id);
      if (row) {
        const cobradorFicha = String(user || loginEmail || 'sin_usuario').trim();
        const dbRow = {
          cliente_id: fichaIdUuid(String(row.clienteId)),
          monto_solicitado: montoTotal,
          monto_total: montoTotal,
          cuotas: cuotasTotales,
          plan: planPago === 'Diario' ? 'Diario' : 'Semanal',
          estado: 'PENDIENTE',
          fecha_inicio: row.fecha_inicio || row.fecha || hoy(),
          cobrador_id: cobradorFicha ? (fichaIdUuid(cobradorFicha) || cobradorFicha) : cobradorFicha,
        };
        const { error } = await supabase.from('creditos').update(dbRow as any).eq('id', fichaIdUuid(row.id));
        if (error) {
          console.error('❌ Supabase save ficha error:', error.message, error.code, error.details);
          alert('No se pudo guardar la ficha: ' + (error.message || 'Error de Supabase') + '\nCódigo: ' + error.code);
          return;
        }
        alert('Ficha actualizada con éxito');
        await fetchData({ silencioso: true });
      }
    } else {
      // ========== INSERT ==========
      const tempId = genId();
      const nueva: Ficha = {
        id: tempId,
        clienteId: fic.clienteId,
        tipo: fic.tipo || 'venta',
        montoTotal: montoTotal,
        precioVenta: montoTotal,
        costo: montoTotal,
        ganancia: 0,
        saldo: montoTotal,
        cuotas: cuotasTotales,
        cuotasPagas: 0,
        cuotaMonto: montoCuota,
        total_pagado: 0,
        producto: String(fic.producto || '').trim(),
        fecha_inicio: hoy(),
        fecha: hoy(),
        estado: 'pendiente',
        plan_pago: planPago,
        pagos: [],
        Mora: 0,
        moraPorciento: M.moraPorciento,
      };
      save({ fichas: [...fichas, nueva] });
      
      // NO incluir id en el objeto para Supabase, dejar que genere el UUID
      const cobradorNuevaFicha = String(user || loginEmail || 'sin_usuario').trim();
      const dbRow = {
        cliente_id: fichaIdUuid(String(nueva.clienteId)),
        monto_solicitado: montoTotal,
        monto_total: montoTotal,
        cuotas: cuotasTotales,
        plan: planPago === 'Diario' ? 'Diario' : 'Semanal',
        estado: 'PENDIENTE',
        fecha_inicio: nueva.fecha_inicio,
        cobrador_id: cobradorNuevaFicha ? (fichaIdUuid(cobradorNuevaFicha) || cobradorNuevaFicha) : cobradorNuevaFicha,
      };
      const { error } = await supabase.from('creditos').insert([dbRow as any]).select('*');
      if (error) {
        console.error('❌ Supabase insert ficha error:', error.message, error.code, error.details);
        alert('No se pudo crear la ficha: ' + (error.message || 'Error de Supabase') + '\nCódigo: ' + error.code);
        return;
      }
      alert('Ficha creada con éxito');
      audit('FICHA_CREADA', `Ficha creada para ${cli.nombre}: ${fmt(montoTotal)}`, gpsPos || undefined);
      await fetchData({ silencioso: true });
    }
    // ========== CIERRE DE MODAL (aplica para ambos: INSERT y UPDATE) ==========
    setMFicha(null);
  };

  const handleDeleteFicha = (id: string) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede eliminar fichas.');
      return;
    }
    if (confirm('Eliminar esta ficha?')) {
      save({ fichas: fichasOrEmpty.filter(f => f.id !== id) });
      void refrescarDatosApp();
    }
  };

  // ==========================================
  // PAGOS
  // ==========================================
  const nombreArchivoComprobanteImagen = (comprobante: ComprobantePagoImagen) => {
    const cliente = (nombreCompletoCliente(comprobante.cliente) || 'Cliente')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'Cliente';
    const fecha = new Date(comprobante.fechaPago).toISOString().slice(0, 10);
    return `Comprobante_${cliente}_${fecha}.png`;
  };

  const crearArchivoComprobanteImagen = async (comprobante: ComprobantePagoImagen) => {
    const ticket = comprobanteTicketRef.current;
    if (!ticket) throw new Error('No se encontró el comprobante para generar la imagen.');
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const html2canvasModule = await import('html2canvas');
    const html2canvas = html2canvasModule.default;
    const canvas = await html2canvas(ticket, html2canvasOpcionesSeguras('#ffffff'));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('No se pudo generar la imagen del comprobante.')), 'image/png', 1);
    });
    return new File([blob], nombreArchivoComprobanteImagen(comprobante), { type: 'image/png' });
  };

  const descargarArchivo = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const descargarComprobantePagoImagen = async (comprobante: ComprobantePagoImagen) => {
    try {
      const file = await crearArchivoComprobanteImagen(comprobante);
      descargarArchivo(file);
    } catch (error: any) {
      console.error('Error generando imagen de comprobante:', error);
      alert(error?.message || 'No se pudo generar el comprobante.');
    }
  };

  const enviarComprobantePagoWhatsapp = async (comprobante: ComprobantePagoImagen) => {
    let file: File;
    try {
      file = await crearArchivoComprobanteImagen(comprobante);
    } catch (error: any) {
      console.error('Error generando imagen para WhatsApp:', error);
      alert(error?.message || 'No se pudo generar el comprobante.');
      return;
    }
    const shareData = {
      files: [file],
      title: `PAGO CONFIRMADO - ${MARCA_PRIMARIA}`,
      text: `PAGO CONFIRMADO - ${MARCA_PRIMARIA}\nHola ${nombreCompletoCliente(comprobante.cliente)}, te adjunto tu comprobante de pago.`,
    };
    if (
      typeof navigator !== 'undefined'
      && typeof navigator.share === 'function'
      && (!navigator.canShare || navigator.canShare({ files: [file] }))
    ) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // Si se cancela o falla el menú nativo, cae a descarga + WhatsApp.
      }
    }
    descargarArchivo(file);
    const mensaje = `PAGO CONFIRMADO - ${MARCA_PRIMARIA}\nHola ${nombreCompletoCliente(comprobante.cliente)}, te adjunto tu comprobante de pago.`;
    const telefono = normalizarTelefonoArg549(String(comprobante.cliente?.telefono ?? ''));
    if (soloDigitosTelefono(telefono).length < 11) {
      alert('Imagen descargada. El cliente no tiene un número de WhatsApp válido.');
      return;
    }
    window.open(generarLinkWhatsApp(telefono, mensaje), '_blank');
  };

  /** Tras cerrar auditoría de ruta: abre el modal de comprobante y ejecuta envío/descarga cuando el ticket ya está en el DOM. */
  const abrirComprobanteAuditoriaPostCerrar = (c: ComprobantePagoImagen, modo: 'wa' | 'descarga') => {
    setMRutaCobradoAuditoria(null);
    setMComprobanteImagen(c);
    window.setTimeout(async () => {
      try {
        if (modo === 'wa') await enviarComprobantePagoWhatsapp(c);
        else await descargarComprobantePagoImagen(c);
      } catch {
        /* El usuario puede reintentar desde el modal de comprobante. */
      }
    }, 500);
  };

  const handlePago = async ( ficha: Ficha, cliente: Cliente, monto: number, observaciones: string ) => {
    if (cobradorBloqueadoCobros) {
      alert('Tu jornada está cerrada o esperando validación del administrador. No podés registrar cobros hasta que la rendición sea aceptada o hasta mañana si ya fue confirmada.');
      return;
    }
    const montoPago = redondearPesos(monto);
    if (montoPago <= 0) { alert('Ingresá un monto'); return; }
    const gRes = await intentarCapturarGpsParaCobranza('handlePago_obtener_gps', { forzar: true });
    if (!gRes.ok) return;
    const gps = gRes.coords;
    setRegistrandoPago(true);
    const actorPago = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    let datosOfflineCobro:
      | { fichaActualizada: Ficha; cuotaNumeroPago: number; pagoDb: Record<string, unknown> }
      | undefined;
    try {
    const creditoCobroCtx = creditosOrEmpty.find(c => fichaIdUuid(c.id) === fichaIdUuid(ficha.id));
    const ctxCobro = creditoCobroCtx
      ? contextoCobroCredito(creditoCobroCtx, pagosOrEmpty)
      : null;
    const montoCuotaRef = ctxCobro
      ? (ctxCobro.montoFaltanteCuotaActual > 0 ? ctxCobro.montoFaltanteCuotaActual : redondearPesos(ficha.cuotaMonto))
      : redondearPesos(ficha.cuotaMonto);
    const tipo: 'completo' | 'parcial' = montoPago >= montoCuotaRef ? 'completo' : 'parcial';
    const moraCalc = ficha.Mora;

    const fechaPago = new Date().toISOString();
    const cobradorId = cobradorIdCanonicoDesdeSesionActiva(authUserId, user, loginEmail);
    const nuevoPago = { fecha: fechaPago.slice(0, 10), monto: montoPago, dia: diffDias(hoy(), ficha.fecha), tipo, observaciones, gps };
    const pagosActualizados = [...ficha.pagos, nuevoPago];
    const totalPagado = redondearPesos(Number(ficha.total_pagado ?? 0) + montoPago);
    const nuevoSaldo = redondearPesos(Math.max(0, Number(ficha.montoTotal ?? 0) - totalPagado));

    let MoraActualizada = moraCalc;
    if (tipo === 'parcial') {
      const faltante = redondearPesos(ficha.cuotaMonto) - montoPago;
      MoraActualizada += faltante;
    }

    const cuotasPagasBase = ctxCobro?.cuotasCompletas ?? (ficha.cuotasPagas ?? 0);
    const cuotasPagas = creditoCobroCtx
      ? contextoCobroCredito(creditoCobroCtx, [
        ...pagosEfectivosCredito(pagosOrEmpty, ficha.id),
        {
          id: 'sim',
          clienteId: String(cliente.id ?? ''),
          fichaId: fichaIdUuid(ficha.id),
          fecha: fechaPago.slice(0, 10),
          monto: montoPago,
          dia: 0,
          tipo,
          esRegistroNoPago: false,
        },
      ]).cuotasCompletas
      : (tipo === 'completo' ? cuotasPagasBase + 1 : cuotasPagasBase);

    const fichaActualizada: Ficha = {
      ...ficha,
      saldo: nuevoSaldo,
      Mora: MoraActualizada,
      pagos: pagosActualizados,
      cuotasPagas,
      total_pagado: totalPagado,
      cuotaMonto: ctxCobro && tipo === 'parcial'
        ? redondearPesos(montoCuotaRef - montoPago)
        : (ctxCobro?.montoCuotaActual ?? ficha.cuotaMonto),
      estado: nuevoSaldo === 0 ? 'cancelada' : 'activa',
    };

    const cobradorTxt = String(cobradorId).trim();
    const cuotasMax = Math.max(1, Number(ficha.cuotas) || 1);
    const cuotaNumeroPago = Math.min(
      Math.max(1, ctxCobro?.cuotaActualNro ?? (cuotasPagasBase + 1)),
      cuotasMax,
    );
    const pagoDb: Record<string, unknown> = {
      ficha_id: fichaIdUuid(ficha.id),
      cliente_id: String(cliente.id ?? '').trim(),
      cobrador_id: cobradorTxt,
      monto: montoPago,
      fecha_pago: fechaPago,
      es_registro_no_pago: false,
      cuota_numero: cuotaNumeroPago,
    };
    datosOfflineCobro = {
      fichaActualizada,
      cuotaNumeroPago,
      pagoDb: { ...pagoDb, observaciones_local: String(observaciones ?? '').slice(0, 2000) },
    };
    const creditoCobro = creditoCobroCtx ?? creditosOrEmpty.find(c => fichaIdUuid(c.id) === fichaIdUuid(ficha.id));
    if (creditoCobro) await sincronizarCuotasCreditoSupabase(creditoCobro);
    const insPago = await registrarCobranzaDirectaConReintentos({
      ficha_id: fichaIdUuid(ficha.id),
      cliente_id: String(cliente.id ?? '').trim(),
      cobrador_id: cobradorTxt,
      monto: montoPago,
      fecha_pago: fechaPago,
      cuota_numero: cuotaNumeroPago,
      es_registro_no_pago: false,
      ambito: ambitoDatosSesion(rol),
    }, 3);
    if (!insPago.ok) {
      if (esErrorSesionSupabase(insPago.error)) {
        console.error('Supabase insert pago (sesión):', insPago.error);
        const { mensaje, meta } = serializarErrorParaAuditoria(insPago.error);
        void insertarLogAuditoriaSupabase({
          tipo: 'cobro',
          contexto: 'handlePago_sesion_o_permiso',
          mensaje_error: mensaje,
          datos_enviados: { pagoDb, clienteId: cliente.id, fichaId: ficha.id, monto: montoPago },
          actor: actorPago,
          meta,
        });
        alert('Tu sesión expiró o no tenés permiso. Iniciá sesión de nuevo e intentá el cobro otra vez.');
        return;
      }
      appendCobroPendienteLocal({ v: 1, ts: Date.now(), pagoDb: datosOfflineCobro!.pagoDb });
      save({ fichas: fichasOrEmpty.map(f => f.id === ficha.id ? datosOfflineCobro!.fichaActualizada : f) });
      setClientes(prev => (Array.isArray(prev)
        ? prev.map(c => (c.id === cliente.id
          ? { ...c, saldo: redondearPesos(Math.max(0, c.saldo - montoPago)), ultimaVisita: hoy(), ultimoMontoRecibido: montoPago }
          : c))
        : prev));
      audit('PAGO_REGISTRADO', `Pago pendiente de subir (sin señal/servidor): ${fmt(montoPago)} - ${nombreCompletoCliente(cliente)} (${cliente?.id ?? '—'})`, gps ?? undefined);
      setBannerCobroRed(MSJ_COBRO_LOCAL_SIN_RED);
      setBannerGpsInstrucciones(null);
      const { mensaje, meta } = serializarErrorParaAuditoria(insPago.error);
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'handlePago_insert_fallido',
        mensaje_error: mensaje,
        datos_enviados: {
          pagoDb,
          clienteId: cliente.id,
          fichaId: ficha.id,
          monto: montoPago,
          observaciones,
          fichaResumen: {
            id: ficha.id,
            cuotaMonto: ficha.cuotaMonto,
            saldo: ficha.saldo,
            cuotasPagas: ficha.cuotasPagas,
          },
        },
        actor: actorPago,
        meta,
      });
      setMPago(null);
      setGpsPos(null);
      alert(MSJ_COBRO_LOCAL_SIN_RED);
      void flushColaLogsAuditoriaSupabase();
      return;
    }
    const pagoInsertado = insPago.data;
    const pagoRow = {
      id: String((pagoInsertado as any)?.pago_id ?? ''),
      clienteId: cliente.id,
      fichaId: fichaIdUuid(ficha.id) || ficha.id,
      fecha: nuevoPago.fecha,
      monto: montoPago,
      dia: nuevoPago.dia,
      tipo: nuevoPago.tipo,
      observaciones: nuevoPago.observaciones || '',
      lat: nuevoPago.gps?.lat ?? null,
      lng: nuevoPago.gps?.lng ?? null,
      userId: cobradorId,
      cobradorId,
      fechaPago,
      esRegistroNoPago: false,
    };
    if (!String(pagoRow.id || '').trim()) {
      appendCobroPendienteLocal({ v: 1, ts: Date.now(), pagoDb: datosOfflineCobro!.pagoDb });
      save({ fichas: fichasOrEmpty.map(f => f.id === ficha.id ? datosOfflineCobro!.fichaActualizada : f) });
      setClientes(prev => (Array.isArray(prev)
        ? prev.map(c => (c.id === cliente.id
          ? { ...c, saldo: redondearPesos(Math.max(0, c.saldo - montoPago)), ultimaVisita: hoy(), ultimoMontoRecibido: montoPago }
          : c))
        : prev));
      audit('PAGO_REGISTRADO', `Pago pendiente de subir (respuesta incompleta): ${fmt(montoPago)} - ${nombreCompletoCliente(cliente)}`, gps ?? undefined);
      setBannerCobroRed(MSJ_COBRO_LOCAL_SIN_RED);
      setBannerGpsInstrucciones(null);
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'handlePago_id_vacio',
        mensaje_error: 'Respuesta del servidor sin id de pago tras insert',
        datos_enviados: {
          pagoDb,
          pagoInsertado: sanitizarJsonAuditoria(pagoInsertado as Record<string, unknown>),
          clienteId: cliente.id,
          fichaId: ficha.id,
        },
        actor: actorPago,
        meta: {},
      });
      setMPago(null);
      setGpsPos(null);
      alert(MSJ_COBRO_LOCAL_SIN_RED);
      void flushColaLogsAuditoriaSupabase();
      return;
    }
    quitarCobrosPendientesLocalesResueltos({
      ficha_id: String(pagoDb.ficha_id ?? ''),
      cliente_id: String(pagoDb.cliente_id ?? ''),
      cuota_numero: cuotaNumeroPago,
    });
    setBannerCobroRed(siguienteMensajeBannerColaCobrosPendientes());
    const cuotaActualizada = Boolean((pagoInsertado as any)?.cuota_actualizada);
    const saldoPendienteAtomico = Number((pagoInsertado as any)?.saldo_pendiente ?? NaN);
    const modoFallbackSimple = Boolean((pagoInsertado as any)?.modo_fallback_simple);
    if (!cuotaActualizada && tipo === 'completo') {
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'handlePago_cuota_no_actualizada',
        mensaje_error: 'La cobranza se registró pero la cuota no quedó marcada en estado pagado',
        datos_enviados: { pagoDb, pagoInsertado, clienteId: cliente.id, fichaId: ficha.id },
        actor: actorPago,
      });
    }

    save({ fichas: fichasOrEmpty.map(f => f.id === ficha.id ? fichaActualizada : f) });
    if (nuevoSaldo === 0) {
      const { error: creditoUpdateError } = await supabase.from('creditos').update({ estado: 'FINALIZADO' } as any).eq('id', fichaIdUuid(ficha.id));
      if (creditoUpdateError) devWarn('No se pudo marcar crédito como FINALIZADO:', creditoUpdateError);
    }
    await fetchData({ silencioso: true });
    setPagos(prev => {
      const list = Array.isArray(prev) ? prev : [];
      const pid = String(pagoRow.id || '').trim();
      if (!pid || list.some(p => String(p?.id) === pid)) return list;
      return [...list, pagoRow];
    });
    const { data: cliPostSrv } = await supabase.from('clientes').select('*').eq('id', cliente.id).maybeSingle();
    if (cliPostSrv) {
      const mapCli = mapClienteFilaSupabase(cliPostSrv as Record<string, unknown>);
      setClientes(prev => (Array.isArray(prev) ? prev.map(c => (c.id === cliente.id ? { ...c, ...mapCli } : c)) : prev));
    } else if (!modoFallbackSimple) {
      devWarn('Post-pago: no se pudo releer el cliente en servidor; se mantiene saldo local estimado.');
      setClientes(prev => (Array.isArray(prev)
        ? prev.map(c => (c.id === cliente.id
          ? { ...c, saldo: redondearPesos(saldoPendienteAtomico), ultimaVisita: hoy(), ultimoMontoRecibido: montoPago }
          : c))
        : prev));
    } else {
      setClientes(prev => (Array.isArray(prev)
        ? prev.map(c => (c.id === cliente.id
          ? { ...c, saldo: redondearPesos(Math.max(0, c.saldo - montoPago)), ultimaVisita: hoy(), ultimoMontoRecibido: montoPago }
          : c))
        : prev));
    }

    audit('PAGO_REGISTRADO', `Pago de ${fmt(montoPago)} - Cliente: ${nombreCompletoCliente(cliente)} (${cliente?.id ?? '—'}) - Tipo: ${tipo}`, gps ?? undefined);

    setMPago(null);
    setGpsPos(null);
    setMComprobanteImagen({
      cliente,
      ficha: fichaActualizada,
      monto: montoPago,
      saldoRestante: fichaActualizada.saldo,
      fechaPago,
      cobradorId,
    });
    } catch (errCat: unknown) {
      const { mensaje, meta } = serializarErrorParaAuditoria(errCat);
      void insertarLogAuditoriaSupabase({
        tipo: 'cobro',
        contexto: 'handlePago_excepcion',
        mensaje_error: mensaje,
        datos_enviados: {
          cliente: { id: cliente.id, nombre: nombreCompletoCliente(cliente) },
          ficha: {
            id: ficha.id,
            cuotaMonto: ficha.cuotaMonto,
            saldo: ficha.saldo,
            montoTotal: ficha.montoTotal,
          },
          monto: montoPago,
          observaciones,
        },
        actor: actorPago,
        meta,
      });
      devWarn('handlePago excepción (sin alerta técnica al usuario):', errCat);
      const dOff = datosOfflineCobro;
      if (dOff) {
        appendCobroPendienteLocal({ v: 1, ts: Date.now(), pagoDb: dOff.pagoDb });
        save({ fichas: fichasOrEmpty.map(f => f.id === ficha.id ? dOff.fichaActualizada : f) });
        setClientes(prev => (Array.isArray(prev)
          ? prev.map(c => (c.id === cliente.id
            ? { ...c, saldo: redondearPesos(Math.max(0, c.saldo - montoPago)), ultimaVisita: hoy(), ultimoMontoRecibido: montoPago }
            : c))
          : prev));
        audit('PAGO_REGISTRADO', `Pago guardado en dispositivo (error al confirmar): ${fmt(montoPago)} - ${nombreCompletoCliente(cliente)}`, gps ?? undefined);
        setBannerCobroRed(MSJ_COBRO_LOCAL_SIN_RED);
        setBannerGpsInstrucciones(null);
        setMPago(null);
        setGpsPos(null);
        alert(MSJ_COBRO_LOCAL_SIN_RED);
      } else {
        setMPago(null);
        setGpsPos(null);
        alert(MSJ_COBRO_LOCAL_SIN_RED);
      }
      void flushColaLogsAuditoriaSupabase();
    } finally {
      setRegistrandoPago(false);
    }
  };
  const handleEliminarPago = async (ficha: Ficha, idx: number) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede eliminar pagos registrados.');
      return;
    }
    const pagosCred = pagosEfectivosCredito(pagosOrEmpty, ficha.id);
    const pagoTarget = pagosCred[idx];
    if (!pagoTarget?.id) {
      alert('No se encontró el pago en el servidor. Actualizá la pantalla e intentá de nuevo.');
      return;
    }
    const montoElim = redondearPesos(Number(pagoTarget.monto) || 0);
    if (!confirm(`¿Eliminar este cobro de ${fmt(montoElim)}? Solo el administrador puede revertir cargas sobre créditos.`)) return;
    const creditoUuid = fichaIdUuid(ficha.id);
    const clienteUuid = normalizarUuidPostgrest(ficha.clienteId);
    const pagoId = normalizarUuidPostgrest(pagoTarget.id);
    if (!creditoUuid || !pagoId) {
      alert('Datos del pago incompletos para eliminar en servidor.');
      return;
    }
    try {
      const { error: eCaja } = await supabase.from('caja').delete().eq('pago_id', pagoId);
      if (eCaja) devWarn('Eliminar pago: caja', eCaja);
      const { error: ePago } = await supabase.from('pagos').delete().eq('id', pagoId);
      if (ePago) {
        alert('No se pudo eliminar el pago en el servidor.');
        return;
      }
      await aplicarEstadoCuotasSegunPagosCredito(creditoUuid);
      if (clienteUuid) {
        const { data: cli } = await supabase
          .from('clientes')
          .select('saldo_pendiente, saldo_debitado, saldo')
          .eq('id', clienteUuid)
          .maybeSingle();
        if (cli && typeof cli === 'object') {
          const c = cli as Record<string, unknown>;
          const sp = intPgSaldo(redondearPesos(Number(c.saldo_pendiente ?? 0)) + montoElim);
          const sd = intPgSaldo(Math.max(0, redondearPesos(Number(c.saldo_debitado ?? 0)) - montoElim));
          const sal = intPgSaldo(redondearPesos(Number(c.saldo ?? 0)) + montoElim);
          await supabase.from('clientes').update({
            saldo_pendiente: sp,
            saldo_debitado: sd,
            saldo: sal,
          } as any).eq('id', clienteUuid);
        }
      }
      const creditoRef = creditosOrEmpty.find(c => fichaIdUuid(c.id) === creditoUuid);
      const pagosRestantes = pagosCred.filter((_, i) => i !== idx);
      const ctxPost = creditoRef
        ? contextoCobroCredito(creditoRef, pagosRestantes)
        : null;
      const pagosActualizados = ficha.pagos.filter((_, i) => i !== idx);
      const totalPagado = ctxPost?.totalPagado
        ?? redondearPesos(pagosActualizados.reduce((s, p) => s + redondearPesos(p.monto), 0));
      const nuevoSaldo = ctxPost?.saldoCredito
        ?? redondearPesos(Math.max(0, Number(ficha.precioVenta) - totalPagado));
      save({
        fichas: fichasOrEmpty.map(f => (f.id === ficha.id
          ? {
            ...f,
            pagos: pagosActualizados,
            saldo: nuevoSaldo,
            total_pagado: totalPagado,
            cuotasPagas: ctxPost?.cuotasCompletas ?? pagosActualizados.filter(p => p.tipo === 'completo').length,
            cuotaMonto: ctxPost?.montoFaltanteCuotaActual ?? f.cuotaMonto,
          }
          : f)),
      });
      setPagos(prev => (Array.isArray(prev) ? prev.filter(p => String(p.id) !== String(pagoTarget.id)) : prev));
      await fetchData({ silencioso: true });
      audit('PAGO_ELIMINADO', `Pago eliminado (${fmt(montoElim)}) - Crédito: ${ficha.id}`);
    } catch (err) {
      devWarn('handleEliminarPago:', err);
      alert('Error al eliminar el pago. Intentá de nuevo.');
    }
  };

  // ==========================================
  // NO PAGO / VISITA FALLIDA
  // ==========================================
  const handleNoPago = async ( _ficha: Ficha, cliente: Cliente, motivo: string, obs: string, promesaFecha: string ) => {
    const gRes = await intentarCapturarGpsParaCobranza('handleNoPago_obtener_gps', { forzar: true });
    if (!gRes.ok) return;
    const { lat, lng } = gRes.coords;
    const vf: VisitaFallida = { clienteId: cliente.id, fecha: hoy(), hora: new Date().toLocaleTimeString('es-AR'), motivo: motivo as any, lat, lng, observaciones: obs, promesaFecha };
    save({ visitasFallidas: [...(data.visitasFallidas || []), vf] });
    if (cliente.promesaFecha !== promesaFecha) {
      save({ clientes: clientesOrEmpty.map(c => c.id === cliente.id ? { ...c, promesaFecha, promesaPago: obs } : c) });
    }
    audit('VISITA_FALLIDA', `Visita fallida: ${nombreCompletoCliente(cliente)} (${cliente?.id ?? '—'}) - Motivo: ${motivo}`, { lat, lng });
    setMNoPago(null); setGpsPos(null);
  };

  // ==========================================
  // GASTOS
  // ==========================================
  const handleSaveGasto = async (g: Partial<Gasto>) => {
    const montoG = redondearPesos(Number(g.monto));
    if (!montoG || montoG <= 0) { alert('Monto inválido'); return; }
    const cobradorFuerte = String(authUserId || user || '').trim();
    const nuevo: Gasto = { id: genId(), fecha: hoy(), categoria: g.categoria || 'Otros', monto: montoG, nota: g.nota || '', userId: cobradorFuerte || user || '', sync: isOnline, timestamp: Date.now() };
    try {
      const { error } = await supabase.from('gastos').insert({
        id: nuevo.id,
        fecha: nuevo.fecha,
        categoria: nuevo.categoria,
        monto: montoG,
        nota: nuevo.nota,
        cobrador_id: cobradorFuerte || user || '',
      });
      if (error) throw error;
      nuevo.sync = true;
      const { error: cajaGastoErr } = await supabase.from('caja').insert([{
        tipo: 'salida',
        monto: montoG,
        descripcion: `Gasto — ${nuevo.categoria}`,
        cobrador_id: cobradorFuerte || user || '',
      } as Record<string, unknown>]);
      if (cajaGastoErr) devWarn('Caja gasto no insertada:', cajaGastoErr);
    } catch (error) {
      devWarn('No se pudo guardar gasto en Supabase. Verificar tabla/políticas de gastos; queda guardado localmente:', error);
      nuevo.sync = false;
    }
    save({ gastos: [...(Array.isArray(gastos) ? gastos : []), nuevo] });
    audit('GASTO_CREADO', `Gasto registrado: ${fmt(montoG)} - ${g.categoria}`);
    setMGasto(null);
    void refrescarDatosApp();
  };

  const handleDeleteGasto = (id: string) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede eliminar gastos.');
      return;
    }
    if (confirm('Eliminar gasto?')) {
      save({ gastos: gastos.filter(g => g.id !== id) });
      audit('GASTO_ELIMINADO', `Gasto eliminado ID: ${id}`);
      void refrescarDatosApp();
    }
  };

  const handleCrearProveedor = async () => {
    if (!esMarcosPUsuario) return;
    const nombre = formNuevoProv.nombre.trim();
    if (!nombre) { alert('Ingresá el nombre del proveedor.'); return; }
    const loginBase = formNuevoProv.login.trim() || slugLoginProveedor(nombre);
    const login = normalizarLoginUsuario(loginBase).replace(/[^a-z0-9_]/g, '_').slice(0, 28);
    if (!login) { alert('Usuario inválido.'); return; }
    if (proveedores.some(p => p.login === login)) {
      alert('Ya existe un proveedor con ese usuario.');
      return;
    }
    setGuardandoProveedor(true);
    try {
      const ses = await asegurarSesionEscritura();
      if (!ses) throw new SesionExpiradaSupabaseError();
      const password = generarPasswordProveedor();
      const actor = nombreParaMostrarSesion({ loginEmail, usernameState: user, authUser: authUserMeta ? { user_metadata: authUserMeta } : null });
      const resultado = await crearProveedorAdminRpc({
        nombre,
        login,
        clave: password,
        telefono: formNuevoProv.telefono.trim() || undefined,
        createdBy: actor || 'Marcos',
      });
      if (!resultado.ok) {
        const errProv = resultado.error;
        const hint = errProv.includes('Solo el administrador')
          ? 'La sesión de Supabase Auth no coincide con un admin en la BD.\n\n'
            + '• Entrá con marcos / emamoreno7@hotmail.com (o prueba@emd.com).\n'
            + '• Ejecutá la migración 043 en Supabase (es_admin_sesion ampliado).\n'
            + '• Cerrá sesión y volvé a iniciar.'
          : errProv.toLowerCase().includes('crypt') || errProv.toLowerCase().includes('gen_salt')
            ? 'Ejecutá la migración 019 en Supabase (fix pgcrypto).'
            : 'Verificá las migraciones 017, 018 y 043 en Supabase.';
        alert(`${errProv}\n\n${hint}`);
        return;
      }
      const provRow = resultado.proveedor;
      setProveedores(prev => [...prev, provRow].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      setFormIngresoExt(f => ({ ...f, proveedorId: provRow.id }));
      setMNuevoProveedor(false);
      setFormNuevoProv({ nombre: '', login: '', telefono: '' });
      setMCredencialesProveedor({ nombre, login: provRow.login, password });
      audit('CONFIG_CAMBIO', `Proveedor creado: ${nombre} (${login})`);
      await logAuditDb('CONFIG_CAMBIO', `Proveedor creado: ${nombre} (${login})`);
    } catch (e: unknown) {
      console.error('handleCrearProveedor:', e);
      alert('No se pudo dar de alta el proveedor. Verificá las migraciones 017 y 018 en Supabase.');
    } finally {
      setGuardandoProveedor(false);
    }
  };

  const handleRegistrarIngresoExterno = async () => {
    if (!esMarcosPUsuario) return;
    const provId = formIngresoExt.proveedorId.trim();
    const monto = redondearPesos(Number(formIngresoExt.monto));
    if (!provId) { alert('Seleccioná un proveedor.'); return; }
    if (!monto || monto <= 0) { alert('Monto inválido.'); return; }
    const prov = proveedores.find(p => p.id === provId);
    if (!prov) { alert('Proveedor no encontrado.'); return; }
    setGuardandoIngresoExt(true);
    try {
      const ses = await asegurarSesionEscritura();
      if (!ses) throw new SesionExpiradaSupabaseError();
      const fechaIngreso = formIngresoExt.fecha || hoy();
      const calc = calcularMontosInversion(monto, fechaIngreso);
      const actor = nombreParaMostrarSesion({ loginEmail, usernameState: user, authUser: authUserMeta ? { user_metadata: authUserMeta } : null });
      const { data: invRow, error: invErr } = await supabase
        .from('inversiones_proveedor')
        .insert([{
          proveedor_id: provId,
          monto: calc.capital,
          fecha_ingreso: fechaIngreso,
          tasa_interes: calc.tasaPct,
          plazo_dias: calc.plazoDias,
          monto_interes: calc.interes,
          monto_total_devolver: calc.total,
          fecha_vencimiento: calc.fechaVencimiento,
          estado: 'activa',
          registrado_por: actor || 'Marcos',
          nota: formIngresoExt.nota.trim() || null,
        }])
        .select('*')
        .single();
      if (invErr) throw invErr;
      const cobradorCaja = String(authUserId || loginEmail || user || 'marcos').trim();
      const { error: cajaErr } = await supabase.from('caja').insert([{
        tipo: 'entrada',
        monto: calc.capital,
        descripcion: `Ingreso externo — ${prov.nombre}`,
        cobrador_id: cobradorCaja,
        proveedor_id: provId,
        inversion_id: invRow.id,
      } as Record<string, unknown>]);
      if (cajaErr) devWarn('Caja ingreso externo no insertada:', cajaErr);
      setInversionesProveedor(prev => [mapInversionRow(invRow as Record<string, unknown>), ...prev]);
      setFormIngresoExt({ proveedorId: provId, monto: '', nota: '', fecha: hoy() });
      audit('CONFIG_CAMBIO', `Ingreso externo ${fmt(calc.capital)} de ${prov.nombre} (${TASA_INVERSION_PROVEEDOR}% / ${PLAZO_INVERSION_PROVEEDOR_DIAS} días)`);
      await logAuditDb('CONFIG_CAMBIO', `Ingreso externo ${fmt(calc.capital)} proveedor ${prov.login}`);
      alert(`Ingreso registrado.\nCapital: ${fmt(calc.capital)}\nInterés (${calc.tasaPct}%): ${fmt(calc.interes)}\nTotal a devolver: ${fmt(calc.total)}\nVencimiento: ${calc.fechaVencimiento}`);
    } catch (e: unknown) {
      console.error('handleRegistrarIngresoExterno:', e);
      alert('No se pudo registrar el ingreso. Verificá la migración 017 y permisos en Supabase.');
    } finally {
      setGuardandoIngresoExt(false);
    }
  };

  const crearNotificacion = useCallback(async (payload: {
    titulo: string;
    mensaje: string;
    destinatario_rol?: string | null;
    destinatario_usuario?: string | null;
    accion?: string | null;
  }) => {
    const emailDest = normalizarEmail(payload.destinatario_usuario);
    const row = {
      titulo: String(payload.titulo),
      mensaje: String(payload.mensaje),
      destinatario_rol: payload.destinatario_rol != null && String(payload.destinatario_rol).trim() !== '' ? String(payload.destinatario_rol).trim() : null,
      destinatario_usuario: emailDest || null,
      accion: payload.accion != null && String(payload.accion).trim() !== '' ? String(payload.accion).trim() : null,
      leido: false,
    };
    try {
      const { data, error } = await supabase.from('notificaciones').insert([row]).select('*').single();
      if (error) {
        devWarn('Supabase create notificacion warning:', error.message || error, error);
        return;
      }
      if (data) setNotificaciones(prev => [data as Notificacion, ...prev]);
    } catch (error) {
      devWarn('Supabase create notificacion warning:', error);
    }
  }, []);
  const crearNotificacionesPorEmail = useCallback(async (payload: {
    titulo: string;
    mensaje: string;
    accion?: string | null;
  }, emails: Array<string | null | undefined>) => {
    const unicos = Array.from(new Set(emails.map(e => normalizarEmail(e)).filter(Boolean)));
    if (unicos.length === 0) return;
    await Promise.all(unicos.map(email => crearNotificacion({
      ...payload,
      destinatario_usuario: email,
    })));
  }, [crearNotificacion]);

  const handleRegistrarMovimientoCajaPropia = useCallback(async () => {
    if (!esMarcosPUsuario) return;
    if (movCajaPropiaProcesandoRef.current) return;
    movCajaPropiaProcesandoRef.current = true;
    const tipo = formMovCajaPropia.tipo;
    const monto = redondearPesos(Number(formMovCajaPropia.monto));
    if (!monto || monto <= 0) {
      alert('Ingresá un monto válido.');
      movCajaPropiaProcesandoRef.current = false;
      return;
    }
    setGuardandoMovCajaPropia(true);
    try {
      if (tipo === 'salida') {
        const saldoDb = await obtenerSaldoCajaPropiaDesdeDb();
        if (saldoDb < monto) {
          alert(`Saldo insuficiente en caja propia.\nDisponible: ${fmt(saldoDb)}\nRetiro solicitado: ${fmt(monto)}`);
          return;
        }
      }
      const actor = nombreParaMostrarSesion({
        loginEmail,
        usernameState: user,
        authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
      });
      const fechaMov = formMovCajaPropia.fecha || hoy();
      const nota = formMovCajaPropia.nota.trim() || null;
      const descripcion =
        tipo === 'entrada'
          ? 'Ingreso propio de capital'
          : 'Egreso propio de caja (retiro)';
      const { error } = await supabase.from('caja_propia_movimientos').insert([{
        tipo,
        monto,
        descripcion,
        nota,
        registrado_por: actor || 'Marcos',
        fecha: fechaMov,
      }]);
      if (error) throw error;
      setFormMovCajaPropia({ tipo, monto: '', nota: '', fecha: hoy() });
      audit('CONFIG_CAMBIO', `${tipo === 'entrada' ? 'Ingreso' : 'Egreso'} propio caja ${fmt(monto)}`);
      const nuevoSaldo = await obtenerSaldoCajaPropiaDesdeDb();
      await fetchData({ silencioso: true });
      alert(
        tipo === 'entrada'
          ? `Ingreso propio registrado: ${fmt(monto)}. Saldo caja propia: ${fmt(nuevoSaldo)}.`
          : `Egreso propio registrado: ${fmt(monto)}. Saldo caja propia: ${fmt(nuevoSaldo)}.`,
      );
    } catch (e: unknown) {
      console.error('handleRegistrarMovimientoCajaPropia:', e);
      alert(e instanceof Error ? e.message : 'No se pudo registrar (¿migración 039?)');
    } finally {
      movCajaPropiaProcesandoRef.current = false;
      setGuardandoMovCajaPropia(false);
    }
  }, [esMarcosPUsuario, formMovCajaPropia, loginEmail, user, authUserMeta, audit, fetchData]);

  const handleDejarCajaPropiaEnCero = useCallback(async () => {
    if (!esMarcosPUsuario) return;
    if (movCajaPropiaProcesandoRef.current) return;
    const saldoDb = await obtenerSaldoCajaPropiaDesdeDb();
    if (saldoDb <= 0) {
      alert(saldoDb < 0
        ? 'El saldo está negativo. Corregí movimientos en Supabase antes de usar esta opción.'
        : 'La caja propia ya está en $0.');
      return;
    }
    if (
      !confirm(
        `¿Dejar caja propia en $0?\n\nSe registrará un egreso de ${fmt(saldoDb)} por el saldo completo.\n(Es un atajo; para retiros parciales usá «Egreso propio».)`,
      )
    ) {
      return;
    }
    movCajaPropiaProcesandoRef.current = true;
    setGuardandoBorrarCajaPropia(true);
    try {
      const saldoConfirmado = await obtenerSaldoCajaPropiaDesdeDb();
      if (saldoConfirmado <= 0) {
        alert('El saldo cambió. Recargá e intentá de nuevo.');
        return;
      }
      const actor = nombreParaMostrarSesion({
        loginEmail,
        usernameState: user,
        authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
      });
      const { error } = await supabase.from('caja_propia_movimientos').insert([{
        tipo: 'salida',
        monto: saldoConfirmado,
        descripcion: 'Ajuste — dejar caja propia en cero',
        nota: 'Cierre rápido de saldo (no reemplaza egresos parciales)',
        registrado_por: actor || 'Marcos',
        fecha: hoy(),
      }]);
      if (error) throw error;
      audit('CONFIG_CAMBIO', `Caja propia en cero — egreso ${fmt(saldoConfirmado)}`);
      await fetchData({ silencioso: true });
      const saldoFinal = await obtenerSaldoCajaPropiaDesdeDb();
      alert(`Caja propia en $0. Último ajuste: ${fmt(saldoConfirmado)}. Saldo actual: ${fmt(saldoFinal)}.`);
    } catch (e: unknown) {
      console.error('handleDejarCajaPropiaEnCero:', e);
      alert(e instanceof Error ? e.message : 'No se pudo dejar la caja en cero.');
    } finally {
      movCajaPropiaProcesandoRef.current = false;
      setGuardandoBorrarCajaPropia(false);
    }
  }, [esMarcosPUsuario, loginEmail, user, authUserMeta, audit, fetchData]);

  const handleRegistrarIngresoFondoCredito = useCallback(async (sol: SolicitudFondoCredito) => {
    if (!esMarcosPUsuario) {
      alert('Solo Marcos puede registrar este ingreso en caja.');
      return;
    }
    if (fondoCreditoProcesandoRef.current.has(sol.id)) return;
    fondoCreditoProcesandoRef.current.add(sol.id);
    setGuardandoFondoCreditoId(sol.id);

    const revertirSolicitudPendiente = async () => {
      await supabase
        .from('solicitudes_fondo_credito')
        .update({ estado: 'pendiente', fondado_at: null })
        .eq('id', sol.id);
    };

    try {
      if (sol.estado !== 'pendiente') {
        alert('Esta solicitud ya fue habilitada.');
        return;
      }
      const creditoId = fichaIdUuid(sol.credito_id);
      const clienteId = normalizarUuidPostgrest(sol.cliente_id);
      if (!creditoId || !clienteId) {
        alert('Solicitud con crédito o cliente inválido.');
        return;
      }

      const { data: egresoPrevio } = await supabase
        .from('caja_propia_movimientos')
        .select('id')
        .eq('solicitud_fondo_id', sol.id)
        .maybeSingle();
      if (egresoPrevio) {
        alert('Esta solicitud ya tiene un egreso en caja propia. No se duplicó el movimiento.');
        await fetchData({ silencioso: true });
        return;
      }

      let saldoPropio = await obtenerSaldoCajaPropiaDesdeDb();
      if (saldoPropio < sol.monto) {
        alert(
          `Saldo de caja propia insuficiente.\nDisponible: ${fmt(saldoPropio)}\nRequerido: ${fmt(sol.monto)}\n\nRegistrá un ingreso propio en caja propia antes de habilitar al cobrador.`,
        );
        return;
      }

      const { data: claimed, error: claimErr } = await supabase
        .from('solicitudes_fondo_credito')
        .update({ estado: 'fondado', fondado_at: new Date().toISOString() })
        .eq('id', sol.id)
        .eq('estado', 'pendiente')
        .select('id')
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claimed) {
        alert('Esta solicitud ya fue procesada por otro intento. No se duplicó el egreso.');
        await fetchData({ silencioso: true });
        return;
      }

      saldoPropio = await obtenerSaldoCajaPropiaDesdeDb();
      if (saldoPropio < sol.monto) {
        await revertirSolicitudPendiente();
        alert(
          `Saldo de caja propia insuficiente.\nDisponible: ${fmt(saldoPropio)}\nRequerido: ${fmt(sol.monto)}`,
        );
        return;
      }

      const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(sol.cliente_id));
      const nombreCli = nombreCompletoCliente(cli) || 'cliente';
      const desc = descripcionIngresoMarcosCredito(nombreCli);
      const actor = nombreParaMostrarSesion({
        loginEmail,
        usernameState: user,
        authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
      });
      const cobradorCaja = String(sol.cobrador_id || 'sin_usuario').trim();

      const { data: cajaRow, error: cajaErr } = await supabase
        .from('caja')
        .insert([{
          tipo: 'entrada',
          monto: sol.monto,
          descripcion: desc,
          cobrador_id: cobradorCaja,
          cliente_id: clienteId,
          ficha_id: creditoId,
        } as Record<string, unknown>])
        .select('id')
        .single();
      if (cajaErr) {
        await revertirSolicitudPendiente();
        throw cajaErr;
      }
      const cajaId = cajaRow != null ? String((cajaRow as Record<string, unknown>).id ?? '') : '';

      const { error: propErr } = await supabase.from('caja_propia_movimientos').insert([{
        tipo: 'salida',
        monto: sol.monto,
        descripcion: `Egreso caja propia — habilitación crédito ${nombreCli}`,
        nota: `Solicitud fondo · cobrador ${etiquetaCobradorMovimiento(cobradorCaja)}`,
        registrado_por: actor || 'Marcos',
        solicitud_fondo_id: sol.id,
        caja_referencia_id: cajaId || null,
        fecha: hoy(),
      }]);
      if (propErr) {
        await revertirSolicitudPendiente();
        const code = (propErr as { code?: string }).code;
        if (code === '23505') {
          alert('El egreso ya estaba registrado. No se duplicó.');
          await fetchData({ silencioso: true });
          return;
        }
        throw propErr;
      }

      const emailCob = normalizarEmail(sol.solicitante_email);
      if (emailCob) {
        await crearNotificacion({
          titulo: 'Ingreso en caja',
          mensaje: `Marcos ingresó ${fmt(sol.monto)} desde caja propia para el crédito de ${nombreCli}. Ya figura en tu caja.`,
          destinatario_usuario: emailCob,
          accion: 'go_creditos',
        });
      }
      audit('CONFIG_CAMBIO', `Egreso caja propia + ingreso cobrador ${fmt(sol.monto)} — ${nombreCli}`);
      await fetchData({ silencioso: true });
      const saldoFinal = await obtenerSaldoCajaPropiaDesdeDb();
      alert(`Habilitado: ${fmt(sol.monto)} al cobrador para ${nombreCli}. Saldo caja propia: ${fmt(saldoFinal)}.`);
    } catch (e: unknown) {
      console.error('handleRegistrarIngresoFondoCredito:', e);
      alert(e instanceof Error ? e.message : 'No se pudo registrar el ingreso (¿migraciones 038/039/040?)');
    } finally {
      fondoCreditoProcesandoRef.current.delete(sol.id);
      setGuardandoFondoCreditoId(null);
    }
  }, [esMarcosPUsuario, clientesOrEmpty, crearNotificacion, audit, fetchData, loginEmail, user, authUserMeta]);

  const handleCrearCredito = async (payload: {
    cliente_id: any; tipo: 'M' | 'P'; monto_solicitado: number; detalle_mercaderia: string | null; fecha_inicio: string;
    plazo_unidad: 'Días' | 'Semanas' | 'Meses'; plazo_cantidad: number; total_con_interes: number; interes_aplicado: number;
    es_retroactivo?: boolean;
  }) => {
    const clienteIdPlano = typeof payload.cliente_id === 'object' && payload.cliente_id !== null
      ? (payload.cliente_id.id ?? payload.cliente_id)
      : payload.cliente_id;
    const idClientePlanoStr = String(clienteIdPlano ?? '').trim();
    if (!esUuidClienteId(idClientePlanoStr)) {
      alert('El cliente seleccionado aún no tiene el identificador de servidor (UUID). Esperá unos segundos, recargá la lista de clientes o volvé a elegir al cliente antes de crear el crédito.');
      return;
    }
    const puedeRetro = puedeCargaRetroactivaCredito(rol);
    const fechaInicioNorm = String(payload.fecha_inicio || hoy()).slice(0, 10);
    const errFecha = validarFechaInicioCredito(fechaInicioNorm, puedeRetro, payload.plazo_unidad);
    if (errFecha) {
      alert(errFecha);
      return;
    }
    const esMatiasOVendedorCredito = esMatiasOVendedorUsuario;
    const etiquetaCreadorCredito = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    let rowCredito: Record<string, unknown> | null = null;
    try {
    const { data: sess } = await supabase.auth.getSession();
    const cobradorId = String(sess.session?.user?.id || user || loginEmail || 'sin_usuario');
    const emailSesion = String(sess.session?.user?.email ?? loginEmail ?? '').trim();
    const plazoUnidadSol = normalizarPlazoUnidad(payload.plazo_unidad);
    const esMensualCred = esUsuarioMensualSesion(rol);
    if (!esMensualCred && plazoUnidadSol === 'Meses') {
      alert('El plan mensual no está disponible. Elegí Diario o Semanal.');
      return;
    }
    if (esMensualCred && plazoUnidadSol !== 'Meses') {
      alert('En el módulo mensual solo podés crear préstamos con plan Mensual.');
      return;
    }
    const planEtiquetaSol = planEtiquetaDesdePlazoUnidad(plazoUnidadSol);
    const clienteIdNorm = fichaIdUuid(idClientePlanoStr);
    const cobradorCreditoNorm = String(cobradorId).trim();
    const ambitoCred = ambitoDatosSesion(rol);
    const cuotasCred = Math.max(1, Number(payload.plazo_cantidad));
    const montoSol = redondearPesos(Number(payload.monto_solicitado));
    const interesOficial = puedeEditarInteresCredito(rol)
      ? (Number(payload.interes_aplicado) || 30)
      : interesAplicadoOficialCredito(
        payload.tipo,
        rol,
        data.config,
        cuotasCred,
        configTasasMensual,
      );
    const totalCred = redondearPesos(montoSol + (montoSol * interesOficial / 100));
    rowCredito = {
      cliente_id: clienteIdNorm,
      tipo: payload.tipo,
      monto_solicitado: montoSol,
      monto_total: totalCred,
      total_con_interes: totalCred,
      cuotas: cuotasCred,
      plazo_cantidad: cuotasCred,
      plazo_unidad: plazoUnidadSol,
      plan: planEtiquetaSol,
      interes_aplicado: interesOficial,
      detalle_mercaderia: payload.detalle_mercaderia,
      fecha_inicio: fechaInicioNorm,
      cobrador_id: cobradorCreditoNorm ? (fichaIdUuid(cobradorCreditoNorm) || cobradorCreditoNorm) : cobradorCreditoNorm,
      estado: esMensualCred ? 'ACTIVO' : 'PENDIENTE',
      inicio_cuotas_modo: 'A_FECHA',
      fecha_inicio_cuotas_post: null,
      cobrador_notif_email: emailSesion || null,
      es_retroactivo: Boolean(payload.es_retroactivo),
      ambito: ambitoCred,
    };
    if (esUsuarioVendedorSesion) {
      rowCredito.vendedor_id = cobradorCreditoNorm ? (fichaIdUuid(cobradorCreditoNorm) || cobradorCreditoNorm) : cobradorCreditoNorm;
    }
    const insCred = await insertarCreditoConReintentos(rowCredito, 3);
    if (!insCred.ok) {
      console.error('Supabase create credito error:', insCred.error);
      const { mensaje, meta } = serializarErrorParaAuditoria(insCred.error);
      void insertarLogAuditoriaSupabase({
        tipo: 'credito',
        contexto: 'handleCrearCredito_insert_fallido',
        mensaje_error: mensaje,
        datos_enviados: {
          row: rowCredito,
          payload: sanitizarJsonAuditoria({ ...payload, cliente_id: idClientePlanoStr } as Record<string, unknown>),
        },
        actor: etiquetaCreadorCredito,
        meta,
      });
      const colFalta = errorColumnaCreditoFaltante(insCred.error);
      const hintMigracion = colFalta
        ? `\n\nFalta la columna «${colFalta}» en la tabla creditos. Ejecutá en Supabase la migración 035_creditos_columnas_app.sql (y recargá el esquema si hace falta).`
        : '\n\nRevisá en Supabase que la tabla creditos tenga las columnas de la migración 035.';
      alert('No se pudo crear la solicitud de crédito tras varios intentos.' + hintMigracion);
      return;
    }
    const created = insCred.data;
    let creditoCreado: Credito | null = null;
    if (created) {
      creditoCreado = created as unknown as Credito;
      const nroCarton = String(creditoCreado.nro_carton ?? '').trim();
      if (nroCarton) setCartonesCredito(prev => ({ ...prev, [creditoCreado!.id]: nroCarton }));
      setCreditos(prev => [{ ...creditoCreado!, nro_carton: nroCarton || creditoCreado!.nro_carton }, ...prev]);
      if (esMensualCred) {
        await sincronizarCuotasCreditoSupabase(creditoCreado, { fechaActivacion: hoy() });
      }
    }
    const refreshedCred = await fetchData({ silencioso: true });
    const listaPostCredito = refreshedCred?.clientes ?? clientesOrEmpty;
    setMCreditoTipo(null);
    const idPlanoCred = String(clienteIdPlano ?? '').trim();
    const cli = listaPostCredito.find(c => c.id === idPlanoCred || normalizarId(c.id) === normalizarId(idPlanoCred));
    const nombreCliCred = (nombreCompletoCliente(cli) || '').trim() || String(idPlanoCred);
    const creditoIdNuevo = creditoCreado ? fichaIdUuid(creditoCreado.id) : '';
    const capitalOtorgar = redondearPesos(Number(payload.monto_solicitado) || 0);
    const esCreadorSinMarcos = !esUsuarioMarcosOperador(user, loginEmail) && !esMarcosPUsuario;

    if (esCreadorSinMarcos && !esMensualCred && creditoIdNuevo && capitalOtorgar > 0) {
      const sinRecaudado = cobradorSinRecaudadoEnCaja(
        cobradorCreditoNorm,
        pagosOrEmpty,
        movimientosCaja,
        authUserId,
        user,
        loginEmail,
      );
      if (sinRecaudado) {
        try {
          const { error: solInsErr } = await supabase.from('solicitudes_fondo_credito').insert([{
            credito_id: creditoIdNuevo,
            cliente_id: clienteIdNorm,
            cobrador_id: cobradorCreditoNorm || String(authUserId || user || 'sin_usuario'),
            solicitante_email: emailSesion || null,
            solicitante_nombre: etiquetaCreadorCredito,
            monto: capitalOtorgar,
            estado: 'pendiente',
          }]);
          if (solInsErr) {
            devWarn('solicitudes_fondo_credito insert:', solInsErr);
          } else {
            await crearNotificacion({
              titulo: 'Solicitud ingreso en caja',
              mensaje: `${etiquetaCreadorCredito} solicita ${fmt(capitalOtorgar)} en caja para crédito de ${nombreCliCred} (sin recaudado previo).`,
              destinatario_usuario: EMAIL_ADMIN_MARCOS_CAJA,
              destinatario_rol: 'admin',
              accion: `go_fondo_credito:${creditoIdNuevo}`,
            });
            await crearNotificacion({
              titulo: 'Fondo solicitado a Marcos',
              mensaje: `Se envió a Marcos la solicitud de ingreso de ${fmt(capitalOtorgar)} para el crédito de ${nombreCliCred}. Verás el ingreso en caja cuando lo registre.`,
              destinatario_usuario: emailSesion || null,
              accion: 'go_creditos',
            });
          }
        } catch (solEx) {
          devWarn('No se pudo crear solicitud de fondo:', solEx);
        }
      }
    }

    if (!esMensualCred) {
    try {
      await crearNotificacionesPorEmail({
        titulo: 'Nueva Solicitud',
        mensaje: `Nueva solicitud pendiente de ${nombreCliCred}`,
        accion: 'go_creditos',
      }, [EMAIL_ADMIN_MARCOS_CAJA, loginEmail]);
    } catch (error) {
      devWarn('No se pudo crear la notificación de nueva solicitud:', error);
    }
    if (esMatiasOVendedorCredito) {
      const adminTel = String(import.meta.env.VITE_ADMIN_PHONE ?? '').trim();
      const cliGuardado = listaPostCredito.find(c => normalizarId(c.id) === normalizarId(idPlanoCred)) || cli;
      const nombreCliMsg = (nombreCompletoCliente(cliGuardado) || '').trim() || String(clienteIdPlano);
      const textoWa =
        resolverPerfilDesdeSesion({ loginEmail, usernameState: user })?.rolDefecto === 'cobrador'
          ? `El cobrador ${etiquetaCreadorCredito} está solicitando la revisión de un crédito para el cliente ${nombreCliMsg}. Favor de revisar en tu Dashboard.`
          : `El vendedor ${etiquetaCreadorCredito} está solicitando la revisión de un crédito para el cliente ${nombreCliMsg}. Favor de revisar en tu Dashboard.`;
      const telOk = soloDigitosTelefono(normalizarTelefonoArg549(adminTel)).length >= 11;
      const linkWhatsapp = telOk
        ? generarLinkWhatsApp(adminTel, textoWa)
        : `https://wa.me/?text=${encodeURIComponent(textoWa)}`;
      setExitoCreditoCobradorWa({ linkWhatsapp, waAbierto: false });
    }
    }
    audit('CONFIG_CAMBIO', esMensualCred
      ? `Préstamo mensual activo para cliente ${payload.cliente_id}`
      : payload.es_retroactivo
        ? `Solicitud ${payload.tipo} (retroactiva) creada para cliente ${payload.cliente_id}`
        : `Solicitud ${payload.tipo} creada para cliente ${payload.cliente_id}`);
    if (esMensualCred) {
      alert('Préstamo mensual creado y activado correctamente.');
    }
    } catch (errCred: unknown) {
      const { mensaje, meta } = serializarErrorParaAuditoria(errCred);
      void insertarLogAuditoriaSupabase({
        tipo: 'credito',
        contexto: 'handleCrearCredito_excepcion',
        mensaje_error: mensaje,
        datos_enviados: {
          row: rowCredito,
          payload: sanitizarJsonAuditoria({ ...payload, cliente_id: idClientePlanoStr } as Record<string, unknown>),
        },
        actor: etiquetaCreadorCredito,
        meta,
      });
      console.error('handleCrearCredito:', errCred);
      alert('Ocurrió un error inesperado al guardar el crédito. El equipo fue notificado para revisión.');
    }
  };
  const handleActualizarEstadoCredito = async (
    credito: Credito,
    estado: 'APROBADO' | 'RECHAZADO',
    review?: {
      plazo_unidad: 'Días' | 'Semanas' | 'Meses';
      plazo_cantidad: number;
      interes_aplicado: number;
      total_con_interes: number;
      notas_admin: string;
      /** Solo admin: cobrador asignado al aprobar (texto en BD). */
      cobrador_id_admin?: string;
    },
  ) => {
    if (!esMarcosPUsuario) {
      alert('Solo el administrador puede aprobar, activar o rechazar solicitudes de crédito.');
      return;
    }
    const idCredito = fichaIdUuid(credito.id);
    if (estado === 'APROBADO') {
      const solPend = solicitudesFondoCredito.find(
        s =>
          fichaIdUuid(s.credito_id) === idCredito
          && solicitudFondoCreditoVigenteParaAdmin(s, creditosOrEmpty, solicitudesFondoIdsConEgresoPropia),
      );
      if (solPend) {
        alert(
          `Hay una solicitud de ingreso en caja pendiente (${fmt(solPend.monto)}). Registrala en Cierre de Caja antes de activar el crédito.`,
        );
        setPage('cierre_caja');
        return;
      }
    }
    if (review && normalizarPlazoUnidad(review.plazo_unidad) === 'Meses') {
      alert('El plan mensual no está disponible. Elegí Diario o Semanal.');
      return;
    }
    const estadoDb: Credito['estado'] = estado === 'APROBADO' ? 'ACTIVO' : 'RECHAZADO';
    const cobradorIdActivo = (() => {
      const desdeAdmin = review?.cobrador_id_admin != null ? String(review.cobrador_id_admin).trim() : '';
      if (estadoDb === 'ACTIVO' && desdeAdmin !== '') return desdeAdmin;
      return String(credito.cobrador_id ?? '').trim();
    })();

    let cambios: Record<string, unknown>;
    if (estadoDb === 'ACTIVO') {
      cambios = {
        estado: 'ACTIVO',
        plan: credito.plan,
        monto_total: credito.monto_total,
        cuotas: credito.cuotas,
        fecha_inicio: credito.fecha_inicio,
        cliente_id: String(credito.cliente_id ?? '').trim(),
        cobrador_id: cobradorIdActivo,
      };
    } else {
      cambios = { estado: estadoDb };
    }

    const updCred = await actualizarCreditoEstadoConReintentos(idCredito, cambios, 3);
    if (!updCred.ok) {
      console.error('Supabase update credito estado error:', updCred.error);
      void insertarDebugErrorSupabase('handleActualizarEstadoCredito', { idCredito, cambios, credito, error: updCred.error });
      alert('No se pudo actualizar el estado tras varios intentos. El equipo fue notificado para revisión.');
      return;
    }
    if (estadoDb === 'RECHAZADO' && idCredito) {
      const { error: cancelSolErr } = await supabase
        .from('solicitudes_fondo_credito')
        .update({ estado: 'cancelado' })
        .eq('credito_id', idCredito)
        .eq('estado', 'pendiente');
      if (cancelSolErr) devWarn('No se pudo cancelar solicitud de fondo al rechazar crédito:', cancelSolErr);
    }
    const updated = updCred.data;
    const notas = String(review?.notas_admin || '').trim();
    if (updated) {
      const u = updated as any;
      const nroCartonSrv = String(u.nro_carton ?? '').trim();
      const merged: Credito = {
        ...credito,
        estado: String(u.estado ?? estadoDb).trim().toUpperCase() as Credito['estado'],
        monto_total: Number(u.monto_total ?? credito.monto_total),
        cuotas: Math.max(1, Number(u.cuotas ?? credito.cuotas)),
        plan: String(u.plan ?? credito.plan),
        plazo_unidad: normalizarPlazoUnidad(String(u.plan ?? credito.plan)),
        plazo_cantidad: Math.max(1, Number(u.cuotas ?? credito.cuotas)),
        total_con_interes: Number(u.monto_total ?? credito.monto_total),
        fecha_inicio: String(u.fecha_inicio ?? credito.fecha_inicio),
        nro_carton: nroCartonSrv || credito.nro_carton,
        inicio_cuotas_modo: u.inicio_cuotas_modo ?? credito.inicio_cuotas_modo,
        fecha_inicio_cuotas_post: u.fecha_inicio_cuotas_post ?? credito.fecha_inicio_cuotas_post,
        cobrador_notif_email: u.cobrador_notif_email ?? credito.cobrador_notif_email,
        es_retroactivo: u.es_retroactivo ?? credito.es_retroactivo,
        interes_aplicado: Number(credito.interes_aplicado ?? 30),
        cobrador_id: String(u.cobrador_id ?? cobradorIdActivo).trim() || null,
      };
      setCreditos(prev => prev.map(c => fichaIdUuid(c.id) === idCredito ? merged : c));
      if (nroCartonSrv) setCartonesCredito(prev => ({ ...prev, [credito.id]: nroCartonSrv }));
    } else {
      setCreditos(prev => prev.map(c => {
        if (fichaIdUuid(c.id) !== idCredito) return c;
        if (estadoDb === 'ACTIVO') {
          return { ...c, ...cambios } as Credito;
        }
        return { ...c, ...cambios } as Credito;
      }));
    }
    if (estadoDb === 'ACTIVO') {
      const baseSync = (updated as Credito | null) ?? ({ ...credito, ...cambios } as Credito);
      await sincronizarCuotasCreditoSupabase(baseSync, { fechaActivacion: hoy() });
      const capitalEntrega = redondearPesos(Number(baseSync.monto_solicitado ?? credito.monto_solicitado) || 0);
      if (capitalEntrega > 0) {
        const { error: cajaCredErr } = await supabase.from('caja').insert([{
          tipo: 'salida',
          monto: capitalEntrega,
          descripcion: `Entrega crédito — ${String(baseSync.tipo || credito.tipo || 'P')}`,
          cobrador_id: cobradorIdActivo || String(authUserId || loginEmail || user || 'marcos').trim(),
          cliente_id: String(baseSync.cliente_id ?? credito.cliente_id ?? '').trim() || null,
          ficha_id: idCredito,
        } as Record<string, unknown>]);
        if (cajaCredErr) devWarn('Caja entrega crédito no insertada:', cajaCredErr);
      }
      const vid = String(baseSync.vendedor_id ?? credito.vendedor_id ?? '').trim();
      const comisionPrev = Number(baseSync.comision_vendedor ?? credito.comision_vendedor ?? 0);
      if (vid && comisionPrev <= 0) {
        const hintUser = String(credito.cobrador_notif_email ?? loginEmail ?? user ?? '').split('@')[0];
        const usrV = await buscarUsuarioVendedorEnBd(vid, hintUser);
        const pct = porcentajeComisionEfectivoVendedor(
          usrV?.porcentaje_comision,
          Number(data.config.porcentajeComisionVendedor ?? 5),
        );
        const capital = redondearPesos(Number(baseSync.monto_solicitado ?? credito.monto_solicitado) || 0);
        const comision = calcularComisionVentaVendedor(capital, pct);
        if (comision > 0) {
          await supabase.from('creditos').update({
            comision_vendedor: comision,
            vendedor_id: vid,
            comision_liquidada: false,
            comision_aprobada_admin: false,
            porcentaje_comision_credito: pct,
          }).eq('id', idCredito);
          setCreditos(prev => prev.map(c => fichaIdUuid(c.id) === idCredito
            ? {
              ...c,
              comision_vendedor: comision,
              vendedor_id: vid,
              comision_liquidada: false,
              comision_aprobada_admin: false,
              porcentaje_comision_credito: pct,
            }
            : c));
        }
      }
    }
    await fetchData({ silencioso: true });
    if (esMarcosPUsuario) void fetchVendedoresComisionAdmin();
    const emailCobrador = String(credito.cobrador_notif_email ?? '').trim().toLowerCase();
    try {
      if (estadoDb === 'ACTIVO' && emailCobrador) {
        await crearNotificacion({
          titulo: 'Crédito activado',
          mensaje: `Tu solicitud fue aprobada. Cartón ${String((updated as any)?.nro_carton ?? '').trim() || 'asignado'}. Ya podés cobrar y enviar el cartón por WhatsApp.`,
          accion: `go_creditos:${credito.id}`,
          destinatario_usuario: emailCobrador,
        });
      } else if (estadoDb === 'RECHAZADO' && emailCobrador) {
        await crearNotificacion({
          titulo: 'Solicitud rechazada',
          mensaje: `Crédito ${credito.id}. ${notas ? `Notas: ${notas}` : ''}`,
          accion: 'go_creditos',
          destinatario_usuario: emailCobrador,
        });
      }
      await crearNotificacionesPorEmail({
        titulo: `Crédito ${estadoDb}`,
        mensaje: `Crédito ${credito.id} ${estadoDb === 'ACTIVO' ? 'activado' : 'rechazado'}. ${notas || 'Sin notas'}`,
          accion: estadoDb === 'ACTIVO' ? `go_creditos:${credito.id}` : 'go_creditos',
      }, [loginEmail]);
    } catch (err) {
      devWarn('No se pudo crear la notificación de estado de crédito:', err);
    }
    audit('CONFIG_CAMBIO', `Crédito ${credito.id} marcado como ${estadoDb}`);
  };

  const notificacionesUsuario = useMemo(() => {
    const emailNorm = (loginEmail || '').trim().toLowerCase();
    const r = (rol || '').toLowerCase();
    return notificacionesOrEmpty.filter(n => {
      const du = (n.destinatario_usuario || '').trim().toLowerCase();
      const dr = (n.destinatario_rol || '').toLowerCase();
      const rolCoincide = dr === r || (dr === 'admin' && ['admin', 'root', 'super'].includes(r));
      if (du && emailNorm && du === emailNorm) return true;
      if (rolCoincide) return true;
      return false;
    });
  }, [notificacionesOrEmpty, rol, loginEmail]);
  const notificacionesNoLeidas = useMemo(() => notificacionesUsuario.filter(n => !n.leido).length, [notificacionesUsuario]);
  const getDiasAtrasoCredito = useCallback((credito: Credito | null | undefined) => {
    if (!credito || !['ACTIVO', 'VIGENTE', 'APROBADO'].includes(String(credito.estado || '').toUpperCase())) return 0;
    const planilla = generarPlanillaCredito(credito);
    if (planilla.length === 0) return 0;
    const primerVencimiento = planilla[0]?.vencimiento;
    if (!primerVencimiento) return 0;
    return Math.max(0, diffDias(hoy(), primerVencimiento));
  }, []);
  const panelControlStats = useMemo(() => {
    const hoyIso = hoy();
    const gastosList = Array.isArray(gastos) ? gastos : [];
    const recaudacionCampo = calcularRecaudacionCampoHoy(pagosOrEmpty, gastosList, hoyIso);
    const cobradoHoy = recaudacionCampo.ingresosCampoHoy;
    const gastosCampoHoy = recaudacionCampo.egresosCampoHoy;
    const netoCampoHoy = recaudacionCampo.cobradoAcumuladoCampo;
    const capitalCalle = clientesOrEmpty.reduce((acc, c) => acc + Math.max(0, Number(c.saldo) || 0), 0);
    const totalClientes = clientesOrEmpty.filter(c => c.activo !== false).length || 1;
    const clientesRojo = creditosOrEmpty.filter(c => getDiasAtrasoCredito(c) > 5).length;
    const indiceMora = (clientesRojo / totalClientes) * 100;
    const totalACobrarHoy = totalACobrarHoyDesdeCreditos(creditosOrEmpty, hoyIso);
    const efectividad = efectividadCobroPorMonto(cobradoHoy, totalACobrarHoy);

    const cobradores = new Map<string, {
      cobrador: string;
      totalCobrado: number;
      gastos: number;
      totalACobrar: number;
      efectividad: number;
    }>();
    const ensure = (id: string) => {
      const cobrador = id || 'sin_usuario';
      const actual = cobradores.get(cobrador) || {
        cobrador,
        totalCobrado: 0,
        gastos: 0,
        totalACobrar: 0,
        efectividad: 0,
      };
      cobradores.set(cobrador, actual);
      return actual;
    };
    recaudacionCampo.porUsuarioCampo.forEach(u => {
      const item = ensure(u.cobrador);
      item.totalCobrado = u.cobrado;
      item.gastos = u.gastos;
    });
    creditosOrEmpty
      .filter(c => esCreditoActivo(c))
      .forEach(c => {
        ensure(String(c.cobrador_id ?? c.creado_por ?? 'sin_usuario').trim());
      });
    cobradores.forEach(item => {
      item.totalACobrar = totalACobrarHoyCobrador(creditosOrEmpty, item.cobrador, hoyIso);
    });
    const porCobrador = Array.from(cobradores.values())
      .map(item => ({
        ...item,
        efectividad: efectividadCobroPorMonto(item.totalCobrado, item.totalACobrar),
      }))
      .sort((a, b) => b.totalCobrado - a.totalCobrado);

    return {
      cobradoHoy,
      gastosCampoHoy,
      netoCampoHoy,
      capitalCalle,
      indiceMora,
      totalACobrarHoy,
      efectividad,
      porCobrador,
      porUsuarioCampo: recaudacionCampo.porUsuarioCampo,
    };
  }, [pagosOrEmpty, clientesOrEmpty, creditosOrEmpty, gastos, getDiasAtrasoCredito]);

  const feedMovimientosControl = useMemo((): FilaMovimientoControl[] => {
    const filas: FilaMovimientoControl[] = [];
    const pagoIdsEnCaja = new Set<string>();

    movimientosCaja.forEach(m => {
      if (m.pagoId) pagoIdsEnCaja.add(m.pagoId);
      filas.push({
        id: `caja-${m.id}`,
        ts: new Date(m.createdAt).getTime() || Date.now(),
        tipo: m.tipo,
        monto: m.monto,
        descripcion: m.descripcion,
        cobradorId: m.cobradorId,
        origen: 'caja',
      });
    });

    pagosOrEmpty.filter(p => esPagoEfectivo(p) && redondearPesos(Number(p.monto) || 0) > 0).forEach(p => {
      const pid = String(p.id ?? '');
      if (pid && pagoIdsEnCaja.has(pid)) return;
      const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
      filas.push({
        id: `pago-${pid || genId()}`,
        ts: new Date(`${fd}T12:00:00`).getTime(),
        tipo: 'entrada',
        monto: redondearPesos(Number(p.monto) || 0),
        descripcion: 'Cobranza en ruta',
        cobradorId: String(p.cobradorId ?? p.userId ?? 'sin_usuario'),
        origen: 'pago',
      });
    });

    const claveGastoEnCaja = new Set(
      movimientosCaja
        .filter(m => m.tipo === 'salida' && /gasto/i.test(m.descripcion))
        .map(m => `${m.cobradorId}|${m.monto}|${m.createdAt.slice(0, 10)}`),
    );
    (Array.isArray(gastos) ? gastos : []).forEach(g => {
      if (!g || redondearPesos(Number(g.monto) || 0) <= 0) return;
      const fd = String(g.fecha || '').slice(0, 10);
      const montoG = redondearPesos(Number(g.monto) || 0);
      const cob = String(g.userId || 'sin_usuario');
      if (claveGastoEnCaja.has(`${cob}|${montoG}|${fd}`)) return;
      filas.push({
        id: `gasto-${g.id}`,
        ts: Number(g.timestamp) || new Date(`${fd}T12:00:00`).getTime(),
        tipo: 'salida',
        monto: montoG,
        descripcion: `Gasto — ${g.categoria}${g.nota ? `: ${g.nota}` : ''}`,
        cobradorId: cob,
        origen: 'gasto',
      });
    });

    creditosOrEmpty
      .filter(c => esCreditoActivo(c))
      .forEach(c => {
        const capital = redondearPesos(Number(c.monto_solicitado) || 0);
        if (capital <= 0) return;
        const fAct = String(c.fecha_inicio ?? c.created_at ?? '').slice(0, 10);
        if (!fAct) return;
        const yaEnCaja = movimientosCaja.some(
          m => m.tipo === 'salida' && m.fichaId === fichaIdUuid(c.id) && m.monto === capital,
        );
        if (yaEnCaja) return;
        filas.push({
          id: `credito-${c.id}`,
          ts: new Date(`${fAct}T08:00:00`).getTime(),
          tipo: 'salida',
          monto: capital,
          descripcion: `Entrega crédito ${String(c.tipo || 'P')}`,
          cobradorId: String(c.cobrador_id ?? c.creado_por ?? 'sin_usuario'),
          origen: 'credito',
        });
      });

    return filas.sort((a, b) => b.ts - a.ts).slice(0, 200);
  }, [movimientosCaja, pagosOrEmpty, gastos, creditosOrEmpty]);
  const getNroCartonCredito = useCallback((credito: Credito, indiceFallback = 0) => {
    const directo = String(credito?.nro_carton || '').trim();
    if (directo) return directo;
    const guardado = String(cartonesCredito[credito.id] || '').trim();
    if (guardado) return guardado;
    const anio = String(credito?.fecha_inicio || credito?.created_at || hoy()).slice(0, 4);
    return `${String(indiceFallback + 1).padStart(3, '0')}-${anio}`;
  }, [cartonesCredito]);
  const generarFilasCartonCredito = useCallback(
    (credito: Credito) => generarFilasCartonCreditoDetalle(credito, pagosOrEmpty),
    [pagosOrEmpty],
  );
  const getSaldoRestanteCredito = useCallback((credito: Credito) => {
    const total = redondearPesos(Number(credito.monto_total ?? credito.total_con_interes) || 0);
    const pagado = redondearPesos(pagosEfectivosCredito(pagosOrEmpty, credito.id).reduce((s, p) => s + (Number(p.monto) || 0), 0));
    return redondearPesos(Math.max(0, total - pagado));
  }, [pagosOrEmpty]);
  const crearArchivoCartonCredito = useCallback(async (payload: CartonSharePayload) => {
    setCartonSharePayload(payload);
    await new Promise(resolve => window.setTimeout(resolve, 60));
    const nodo = cartonShareRef.current;
    if (!nodo) throw new Error('No se pudo preparar el cartón para compartir.');
    const html2canvasModule = await import('html2canvas');
    const html2canvas = html2canvasModule.default;
    const canvas = await html2canvas(nodo, html2canvasOpcionesSeguras('#ffffff'));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('No se pudo generar la imagen del cartón.')), 'image/png', 1);
    });
    const safeCarton = String(payload.nroCarton || 'carton').replace(/[^\w-]/g, '_');
    return new File([blob], `Carton_${safeCarton}_${hoy()}.png`, { type: 'image/png' });
  }, []);
  const compartirCartonActualizado = useCallback(async (payload: CartonSharePayload) => {
    const diasSin = diasSinPagoDesdePrimeraCuotaImpaga(payload.credito, pagosOrEmpty);
    const saldoW = getSaldoRestanteCredito(payload.credito);
    const msgCarton = `Hola ${nombreCompletoCliente(payload.cliente)}, te enviamos tu cartón actualizado. Días sin pago: ${diasSin}. Saldo restante: ${fmt(saldoW)}.`;
    try {
      const file = await crearArchivoCartonCredito(payload);
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        try {
          await navigator.share({ files: [file], text: msgCarton });
        } catch {
          await navigator.share({ files: [file] });
        }
      } else {
        descargarArchivo(file);
        const tel = normalizarTelefonoArg549(String(payload.cliente.telefono ?? ''));
        if (soloDigitosTelefono(tel).length < 11) {
          alert('Cartón descargado. El cliente no tiene un WhatsApp válido.');
        } else {
          window.open(generarLinkWhatsApp(tel, msgCarton), '_blank');
        }
      }
    } catch (error: any) {
      console.error('Error compartiendo cartón actualizado:', error);
      alert(error?.message || 'No se pudo compartir el cartón.');
    }
  }, [crearArchivoCartonCredito, pagosOrEmpty, getSaldoRestanteCredito]);
  const marcarNotificacionLeida = async (id: string) => {
    const { error } = await supabase.from('notificaciones').update({ leido: true }).eq('id', id);
    if (error) {
      console.error('Supabase update notificacion leida error:', error);
      alert('No se pudo actualizar la notificación como leída: ' + (error.message || 'Error de Supabase'));
      return;
    }
    setNotificaciones(prev => prev.map(n => n.id === id ? { ...n, leido: true } : n));
  };
  const extraerCreditoIdNotificacion = useCallback((n: Notificacion): string | null => {
    const accion = String(n.accion || '').trim();
    const matchFicha = accion.match(/^go_creditos_ficha:(.+)$/i);
    if (matchFicha?.[1]) return String(matchFicha[1]).trim();
    const matchId = accion.match(/^go_creditos:([^:]+)$/i);
    if (matchId?.[1]) return String(matchId[1]).trim();
    const texto = `${n.titulo || ''} ${n.mensaje || ''}`;
    const matchTexto = texto.match(/cr[eé]dito\s+([a-z0-9_-]+)/i);
    return matchTexto?.[1] || null;
  }, []);
  const handleNotificacionClick = useCallback((n: Notificacion) => {
    void marcarNotificacionLeida(n.id);
    const mensaje = String(n.mensaje || '').toLowerCase();
    const titulo = String(n.titulo || '').toLowerCase();
    const creditoIdNotif = extraerCreditoIdNotificacion(n);
    const esCreditoAprobado = (
      Boolean(n.accion?.startsWith('go_creditos_ficha:') || n.accion?.startsWith('go_creditos:'))
      || ((titulo.includes('crédito') || titulo.includes('credito') || mensaje.includes('crédito') || mensaje.includes('credito'))
        && (mensaje.includes('aprobado') || mensaje.includes('otorgado') || mensaje.includes('activado') || titulo.includes('aprobado') || titulo.includes('otorgado') || titulo.includes('activado')))
    );

    if (
      creditoIdNotif
      && (esCreditoAprobado || n.accion?.startsWith('go_creditos_ficha:') || n.accion?.startsWith('go_creditos:'))
    ) {
      setFiltroPendientesCredito('procesados');
      setCreditoIdEnUrl(creditoIdNotif);
      setPage('creditos');
      setSearch('');
      setFilterStatus('all');
      setMNotificaciones(false);
      return;
    }
    if (n.accion === 'go_rendiciones' || titulo.includes('rendición pendiente')) {
      setPage('rendiciones');
      setMNotificaciones(false);
      return;
    }
    if (
      n.accion?.startsWith('go_fondo_credito:')
      || titulo.includes('ingreso en caja')
      || (mensaje.includes('solicita') && mensaje.includes('caja'))
      || (titulo.includes('fondo') && mensaje.includes('Marcos'))
    ) {
      setPage('cierre_caja');
      setMNotificaciones(false);
      return;
    }
    if (n.accion === 'go_creditos' || mensaje.includes('nueva solicitud')) {
      setPage('creditos');
      setSearch('');
      setFilterStatus('all');
      setMNotificaciones(false);
    }
  }, [extraerCreditoIdNotificacion, marcarNotificacionLeida]);

  // ==========================================
  // CIERRE DE JORNADA
  // ==========================================
  const handleCierreJornada = async (montoFisico: number, kmFin?: number, novedades: string = '') => {
    const nombrePantallaJornada = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    const gRes = await intentarCapturarGpsParaCobranza('handleCierreJornada_obtener_gps', { forzar: true });
    if (!gRes.ok) return;
    const gps = gRes.coords;
    const totalCobrado = cajaCobradorDia.totalCobrado;
    const totalGastos = cajaCobradorDia.totalGastos;
    const netoEntregar = cajaCobradorDia.efectivoEnMano;
    const montoFisicoR = redondearPesos(montoFisico);
    const diferencia = redondearPesos(montoFisicoR - netoEntregar);
    const cobradorId = String(authUserId || user || '').trim();
    if (!cobradorId) {
      alert('No se pudo identificar al cobrador. Volvé a iniciar sesión.');
      return;
    }

    const rowDb = {
      fecha_jornada: hoy(),
      cobrador_id: cobradorId,
      cobrador_nombre: nombrePantallaJornada.slice(0, 120),
      total_cobrado: totalCobrado,
      total_gastos: totalGastos,
      neto_entregar: netoEntregar,
      monto_fisico_declarado: montoFisicoR,
      diferencia,
      km_fin: kmFin != null && Number.isFinite(kmFin) ? kmFin : null,
      novedades: novedades?.trim() || null,
      validado: false,
      ingreso_caja_central: 0,
      gps_lat: gps.lat,
      gps_lng: gps.lng,
    };

    const { data: inserted, error } = await supabase.from('rendiciones').insert([rowDb as any]).select('*').single();

    let cierre: Cierre;
    if (error) {
      const code = String((error as { code?: string }).code || '');
      const msg = String(error.message || '');
      if (code === '23505' || msg.toLowerCase().includes('duplicate')) {
        alert('Ya registraste el cierre de jornada de hoy.');
        return;
      }
      console.error('rendiciones insert:', error);
      cierre = {
        id: genId(),
        fecha: hoy(),
        userId: cobradorId,
        username: nombrePantallaJornada,
        totalSistema: totalCobrado,
        totalGastos,
        netoEntregar,
        montoFisico: montoFisicoR,
        diferencia,
        kmFin,
        novedades: novedades || '',
        validado: false,
        sync: false,
        timestamp: Date.now(),
        lat: gps.lat,
        lng: gps.lng,
      };
      save({ cierresJornada: [...cierresJornada, cierre] });
      alert('No se pudo guardar en el servidor. Cierre guardado solo en este dispositivo; sincronizá cuando la tabla rendiciones esté disponible.');
    } else {
      cierre = mapRowRendicionDb(inserted as Record<string, unknown>);
      await fetchData({ silencioso: true });
    }

    audit(
      'CIERRE_JORNADA',
      `Rendición — Cobrado: ${fmt(totalCobrado)} | Gastos: ${fmt(totalGastos)} | Neto: ${fmt(netoEntregar)} | Físico: ${fmt(montoFisicoR)} | Diff: ${fmt(diferencia)}`,
      gps,
    );

    const diffSigno = diferencia >= 0 ? `+${fmt(diferencia)}` : fmt(diferencia);
    const tipoDiff = diferencia > 0 ? '💚 Sobrante' : diferencia < 0 ? '🚩 Faltante' : '✅ Cuadrado';
    const msg = `CIERRE DE DÍA - ${MARCA_PRIMARIA}

🚩 Rendición de jornada — ${nombrePantallaJornada}

📅 Fecha jornada: ${hoy()}
👤 Cobrador: ${nombrePantallaJornada}

💵 Total cobrado: ${fmt(totalCobrado)}
📤 Gastos operativos: ${fmt(totalGastos)}
📗 Neto a entregar: ${fmt(netoEntregar)}
💵 Efectivo declarado: ${fmt(montoFisicoR)}
📊 Diferencia (vs neto): ${diffSigno} ${tipoDiff}

📝 Novedades: ${novedades || 'Sin novedades'}
📍 GPS: ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}

_${data.config.nombreEmpresa || MARCA_COMPLETA}_`;

    const adminNum = normalizarTelefonoArg549(
      String(data.config.numeroWhatsappAdmin || M.numeroWhatsappAdmin || M.telefonoEmpresa || ''),
    );
    const linkWA = soloDigitosTelefono(adminNum).length >= 11 ? generarLinkWhatsApp(adminNum, msg) : '';

    setMCierre(cierre);
    setMJornada(false);

    try {
      await crearNotificacion({
        titulo: 'Rendición pendiente de recepción',
        mensaje: `${nombrePantallaJornada} cerró jornada — ${fmt(netoEntregar)} a recibir. Aceptá en Rendiciones.`,
        destinatario_usuario: EMAIL_ADMIN_MARCOS_CAJA,
        accion: 'go_rendiciones',
      });
    } catch (err) {
      devWarn('Notificación rendición a Marcos:', err);
    }

    if (confirm('✅ Rendición enviada (pendiente de aceptación por Marcos). ¿Enviar copia al administrador por WhatsApp?')) {
      if (linkWA) window.open(linkWA, '_blank');
      else alert('Configurá el WhatsApp del administrador (solo números, prefijo 549) en Ajustes para enviar la copia.');
    }
  };

  const handleAceptarRendicion = async (c: Cierre) => {
    if (!esMarcosPUsuario) return;
    if (aceptarRendicionProcesandoRef.current.has(c.id)) return;
    if (c.validado) {
      alert('Esta rendición ya fue aceptada.');
      return;
    }
    aceptarRendicionProcesandoRef.current.add(c.id);
    const neto = redondearPesos(c.netoEntregar ?? (c.totalSistema - (c.totalGastos ?? 0)));
    const actor = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    const etiquetaCob = etiquetaCobradorMovimiento(c.username || c.userId);
    const cobradorCaja = String(c.userId || 'sin_usuario').trim();

    try {
      const { data: propiaPrev } = await supabase
        .from('caja_propia_movimientos')
        .select('id')
        .eq('rendicion_id', c.id)
        .maybeSingle();
      if (propiaPrev) {
        alert('Esta rendición ya fue recepcionada en caja propia.');
        await fetchData({ silencioso: true });
        return;
      }

      const { data: claimed, error: claimErr } = await supabase
        .from('rendiciones')
        .update({
          validado: true,
          validado_at: new Date().toISOString(),
          validado_por: actor || 'Marcos',
          ingreso_caja_central: neto,
        } as Record<string, unknown>)
        .eq('id', c.id)
        .eq('validado', false)
        .select('id')
        .maybeSingle();
      if (claimErr) throw claimErr;
      if (!claimed) {
        alert('La rendición ya fue procesada por otro intento.');
        await fetchData({ silencioso: true });
        return;
      }

      if (neto > 0) {
        const { error: salidaErr } = await supabase.from('caja').insert([{
          tipo: 'salida',
          monto: neto,
          descripcion: 'Rendición entregada — recepción administrador',
          cobrador_id: cobradorCaja,
        } as Record<string, unknown>]);
        if (salidaErr) throw salidaErr;

        const { error: propErr } = await supabase.from('caja_propia_movimientos').insert([{
          tipo: 'entrada',
          monto: neto,
          descripcion: `Recepción rendición — ${etiquetaCob}`,
          nota: `Jornada ${c.fecha}`,
          registrado_por: actor || 'Marcos',
          rendicion_id: c.id,
          fecha: hoy(),
        }]);
        if (propErr) {
          const code = (propErr as { code?: string }).code;
          if (code !== '23505') throw propErr;
        }
      }

      audit(
        'RENDICION_ACEPTADA',
        `Rendición ${c.id} — ${etiquetaCob} — ${fmt(neto)} ingresa a caja propia`,
      );
      await fetchData({ silencioso: true });
      alert(`Rendición aceptada. ${fmt(neto)} ingresó a caja propia. ${etiquetaCob} queda liberado tras las 00:00.`);
    } catch (e: unknown) {
      console.error('handleAceptarRendicion:', e);
      alert(e instanceof Error ? e.message : 'No se pudo aceptar la rendición (¿migración 042?)');
    } finally {
      aceptarRendicionProcesandoRef.current.delete(c.id);
    }
  };

  // ==========================================
  // RUTA INTELIGENTE
  // ==========================================
  const [clientesOrdenados, setClientesOrdenados] = useState<(Cliente & { distancia: number })[]>([]);
  const [ordenandoRuta, setOrdenandoRuta] = useState(false);

  const optimizarRuta = async () => {
    if (!navigator.geolocation) { alert('Geolocalización no disponible'); return; }
    setOrdenandoRuta(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
      });
      const { latitude: latU, longitude: lngU } = pos.coords;
      const pendientes = clientesOrEmpty.filter(c => c.saldo > 0 && c.lat && c.lng);
      const conDist = pendientes.map(c => ({
        ...c, distancia: calcularDistancia(latU, lngU, c.lat!, c.lng!),
      })).sort((a, b) => a.distancia - b.distancia);
      setClientesOrdenados(conDist);
      setMRuta(true);
    } catch (e) {
      alert('No se pudo obtener ubicación. Asegurate de permitir GPS.');
    }
    setOrdenandoRuta(false);
  };

  const [posicionRutaCobrador, setPosicionRutaCobrador] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (page !== 'ruta' || !user) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (!cancelled) setPosicionRutaCobrador({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        if (!cancelled) setPosicionRutaCobrador(null);
      },
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 12000 },
    );
    return () => { cancelled = true; };
  }, [page, user]);

  const [rutaClienteExpandidoId, setRutaClienteExpandidoId] = useState<string | null>(null);
  const [rutaCreditoElegidoPorCliente, setRutaCreditoElegidoPorCliente] = useState<Record<string, string>>({});
  /** Pestañas superiores de la Hoja de Ruta. */
  const [subTabRuta, setSubTabRuta] = useState<'por_cobrar' | 'cobrado'>('por_cobrar');
  /** Fecha del historial en pestaña Cobrado (YYYY-MM-DD). */
  const [rutaHistorialFecha, setRutaHistorialFecha] = useState<string>(() => hoy());
  /** Confirmación numérica antes de cerrar el día en ruta (cierre de caja). */
  const [montoConfirmacionCierreRuta, setMontoConfirmacionCierreRuta] = useState('');
  /** Detalle solo lectura (pestaña Cobrado). */
  const [mRutaCobradoAuditoria, setMRutaCobradoAuditoria] = useState<{
    cliente: Cliente;
    filas: FilaRutaResumen[];
    fecha: string;
    semaforo: 'verde' | 'rojo';
  } | null>(null);

  const rutaGruposBaseItems = useMemo((): ItemRutaGrupoBase[] => {
    if (page !== 'ruta') return [];
    const porCliente = new Map<string, { cliente: Cliente; filas: FilaRutaResumen[] }>();
    for (const c of creditosOrEmpty) {
      if (!creditoVisibleParaSesion(c, rol, authUserId, user, loginEmail)) continue;
      const resumen = resumenCuotasRutaCredito(c, pagosOrEmpty);
      if (!resumen.enRuta) continue;
      const cli = clientesOrEmpty.find(cl => normalizarId(cl.id) === normalizarId(c.cliente_id));
      if (!cli) continue;
      const fic = fichasOrEmpty.find(f => f.id === c.id) ?? construirFichaRutaDesdeCredito(c, pagosOrEmpty);
      const idCl = normalizarId(cli.id);
      const bucket = porCliente.get(idCl) || { cliente: cli, filas: [] };
      bucket.filas.push({ credito: c, resumen, ficha: fic });
      porCliente.set(idCl, bucket);
    }
    const items: ItemRutaGrupoBase[] = [];
    const hRuta = hoy();
    porCliente.forEach(({ cliente: cli, filas }) => {
      const montoPendienteVtoHoy = redondearPesos(filas.reduce((s, x) => s + x.resumen.montoPendienteVtoHastaHoy, 0));
      const tieneAtraso = filas.some(x => x.resumen.tieneAtraso);
      const conPrioridad = filas.filter(x => x.resumen.enRuta);
      const conDeuda = conPrioridad.filter(x => x.resumen.montoPendienteVtoHastaHoy > 0);
      const elegir = (conDeuda.length > 0
        ? [...conDeuda].sort((a, b) => {
          if (a.resumen.tieneAtraso !== b.resumen.tieneAtraso) return a.resumen.tieneAtraso ? -1 : 1;
          return String(a.credito.fecha_inicio || '').localeCompare(String(b.credito.fecha_inicio || ''));
        })[0]
        : (conPrioridad[0] ?? filas[0])) as FilaRutaResumen;
      let distancia: number | null = null;
      if (posicionRutaCobrador && cli.lat != null && cli.lng != null) {
        distancia = calcularDistancia(posicionRutaCobrador.lat, posicionRutaCobrador.lng, cli.lat, cli.lng);
      }
      const saldoTotalDeuda = redondearPesos(filas.reduce((s, x) => s + saldoDeudaCredito(x.credito, pagosOrEmpty), 0));
      const etiquetasPlan = [...new Set(filas.map(x => etiquetaPlanRutaDesdeCredito(x.credito)))];
      const planLenE = generarPlanillaCredito(elegir.credito).length;
      const sigNE = elegir.resumen.siguienteCuotaNro
        ?? Math.min(pagosEfectivosCredito(pagosOrEmpty, elegir.credito.id).length + 1, planLenE);
      const cuotasTexto = `Cuota ${sigNE} de ${planLenE}`;
      items.push({
        cliente: cli,
        filas,
        montoPendienteVtoHoy,
        tieneAtraso,
        distancia,
        saldoTotalDeuda,
        etiquetasPlan,
        creditoCobrar: elegir.credito,
        fichaCobrar: elegir.ficha,
        siguienteCuotaNro: elegir.resumen.siguienteCuotaNro,
        vencimientoSiguiente: elegir.resumen.vencimientoSiguiente,
        cuotasTexto,
      });
    });
    const idsEnRutaReal = new Set(porCliente.keys());
    for (const cli of clientesOrEmpty) {
      if (!cli?.id || !esUuidClienteId(cli.id)) continue;
      const idCl = normalizarId(cli.id);
      if (idsEnRutaReal.has(idCl)) continue;
      if (!Number.isFinite(Number(cli.lat)) || !Number.isFinite(Number(cli.lng))) continue;
      if (String(cli.fechaAlta || '').slice(0, 10) !== hRuta) continue;
      if (clienteTieneCreditoActivoEnRuta(cli.id, creditosOrEmpty, pagosOrEmpty)) continue;
      const credVirt = creditoPlaceholderCaptacion(cli);
      const resumenCap = resumenCuotasRutaCredito(credVirt, pagosOrEmpty);
      if (!resumenCap.enRuta) continue;
      const ficCap = construirFichaRutaDesdeCredito(credVirt, pagosOrEmpty);
      let distanciaCap: number | null = null;
      if (posicionRutaCobrador && cli.lat != null && cli.lng != null) {
        distanciaCap = calcularDistancia(posicionRutaCobrador.lat, posicionRutaCobrador.lng, cli.lat, cli.lng);
      }
      const filasCap: FilaRutaResumen[] = [{ credito: credVirt, resumen: resumenCap, ficha: ficCap }];
      const elegirCap = filasCap[0];
      items.push({
        cliente: cli,
        filas: filasCap,
        montoPendienteVtoHoy: 0,
        tieneAtraso: false,
        distancia: distanciaCap,
        saldoTotalDeuda: 0,
        etiquetasPlan: ['DIARIO'],
        creditoCobrar: elegirCap.credito,
        fichaCobrar: elegirCap.ficha,
        siguienteCuotaNro: elegirCap.resumen.siguienteCuotaNro,
        vencimientoSiguiente: elegirCap.resumen.vencimientoSiguiente,
        cuotasTexto: 'Pendiente de visita — alta del día (sin crédito en ruta)',
        esRutaCaptacionSinCreditoReal: true,
      });
    }
    return items.sort(cmpDistanciaOrdenNombreRuta);
  }, [page, creditosOrEmpty, clientesOrEmpty, fichasOrEmpty, pagosOrEmpty, rol, authUserId, user, loginEmail, posicionRutaCobrador]);

  const fechaRefHoyRuta = hoy();
  const rutaPorCobrarItems = useMemo((): ItemRutaGrupo[] => {
    if (page !== 'ruta') return [];
    return rutaGruposBaseItems
      .map(it => ({
        ...it,
        semaforo: semaforoRutaCliente(pagosOrEmpty, visitasFallidasOrEmpty, fechaRefHoyRuta, it.cliente.id, it.filas),
      }))
      .filter(x => x.semaforo === 'amarillo')
      .sort(cmpDistanciaOrdenNombreRuta);
  }, [page, rutaGruposBaseItems, pagosOrEmpty, visitasFallidasOrEmpty, fechaRefHoyRuta]);

  const rutaCierreStorageKey = useMemo(
    () => `cp_cierre_ruta_dia_${String(authUserId || '').trim() || String(user || '').trim() || 'anon'}`,
    [authUserId, user],
  );
  const [rutaDiaCerradoFecha, setRutaDiaCerradoFecha] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(rutaCierreStorageKey);
      setRutaDiaCerradoFecha(raw && raw.length >= 10 ? raw.slice(0, 10) : null);
    } catch {
      setRutaDiaCerradoFecha(null);
    }
  }, [rutaCierreStorageKey]);

  const rutaPorCobrarItemsLista = useMemo(() => {
    if (rutaDiaCerradoFecha === hoy()) return [];
    return rutaPorCobrarItems;
  }, [rutaPorCobrarItems, rutaDiaCerradoFecha]);

  const metricasCierreCajaRutaHoy = useMemo(() => {
    const f = hoy();
    const visitados = rutaGruposBaseItems.map(it => ({
      ...it,
      semaforo: semaforoRutaCliente(pagosOrEmpty, visitasFallidasOrEmpty, f, it.cliente.id, it.filas),
    })).filter(x => x.semaforo === 'verde' || x.semaforo === 'rojo');
    const pagosD = pagosOrEmpty.filter(p => {
      const fd = String(p.fechaPago ?? p.fecha ?? '').slice(0, 10);
      if (fd !== f || !esPagoEfectivo(p)) return false;
      return esRegistroDelCobrador(p, authUserId, user, loginEmail);
    });
    let efectivo = 0;
    let transfer = 0;
    for (const p of pagosD) {
      const m = redondearPesos(Number(p.monto) || 0);
      if (esPagoTransferenciaPorObservaciones(p)) transfer += m;
      else efectivo += m;
    }
    return {
      totalEfectivo: redondearPesos(efectivo),
      totalTransfer: redondearPesos(transfer),
      totalRecaudado: redondearPesos(efectivo + transfer),
      clientesVisitados: visitados.length,
      clientesNoPago: visitados.filter(x => x.semaforo === 'rojo').length,
      clientesConPago: visitados.filter(x => x.semaforo === 'verde').length,
    };
  }, [rutaGruposBaseItems, pagosOrEmpty, visitasFallidasOrEmpty, authUserId, user, loginEmail]);

  const rutaBloqueadaPorCierreHoy = rutaDiaCerradoFecha === hoy();

  useEffect(() => {
    if (!menuPerfilAbierto) return;
    const onDown = (e: MouseEvent) => {
      if (menuPerfilRef.current && !menuPerfilRef.current.contains(e.target as Node)) {
        setMenuPerfilAbierto(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuPerfilAbierto]);

  const handleCerrarDiaRutaCobrador = () => {
    const nombrePantallaRuta = nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
    const esperado = metricasCierreCajaRutaHoy.totalRecaudado;
    const ingresado = redondearPesos(parseFloat(String(montoConfirmacionCierreRuta).replace(',', '.')) || 0);
    if (ingresado !== esperado) {
      alert(`El monto confirmado (${fmt(ingresado)}) no coincide con el total del día (${fmt(esperado)}: efectivo + transferencias).`);
      return;
    }
    try {
      localStorage.setItem(rutaCierreStorageKey, hoy());
    } catch {
      /* */
    }
    setRutaDiaCerradoFecha(hoy());
    setMontoConfirmacionCierreRuta('');
    audit('CIERRE_DIA_RUTA', `Cierre día ruta ${hoy()} — Total ${fmt(esperado)} — Visitados ${metricasCierreCajaRutaHoy.clientesVisitados} — No pago ${metricasCierreCajaRutaHoy.clientesNoPago}`);
    void logAuditDb('CIERRE_DIA_RUTA', `Cierre día ruta ${hoy()}; total ${esperado}`);
    const adminNum = normalizarTelefonoArg549(
      String(data.config.numeroWhatsappAdmin || M.numeroWhatsappAdmin || M.telefonoEmpresa || ''),
    );
    if (soloDigitosTelefono(adminNum).length < 11) {
      alert('Día cerrado en este dispositivo. Configurá el WhatsApp del administrador (549 + número, solo dígitos) en Ajustes para abrir el resumen por WhatsApp.');
      return;
    }
    const msg = [
      `*CIERRE DE DÍA - ${MARCA_PRIMARIA}*`,
      `Fecha: ${hoy()}`,
      `Cobrador: ${nombrePantallaRuta}`,
      '',
      `*Total cobrado:* ${fmt(metricasCierreCajaRutaHoy.totalRecaudado)}`,
      `*Clientes visitados:* ${metricasCierreCajaRutaHoy.clientesVisitados}`,
      `*Clientes con No Pago:* ${metricasCierreCajaRutaHoy.clientesNoPago}`,
      '',
      `Detalle: efectivo ${fmt(metricasCierreCajaRutaHoy.totalEfectivo)} · transferencias ${fmt(metricasCierreCajaRutaHoy.totalTransfer)}`,
    ].join('\n');
    window.open(generarLinkWhatsApp(adminNum, msg), '_blank', 'noopener,noreferrer');
  };

  const rutaCobradoItems = useMemo((): ItemRutaGrupo[] => {
    if (page !== 'ruta') return [];
    const f = String(rutaHistorialFecha).slice(0, 10);
    return rutaGruposBaseItems
      .map(it => ({
        ...it,
        semaforo: semaforoRutaCliente(pagosOrEmpty, visitasFallidasOrEmpty, f, it.cliente.id, it.filas),
      }))
      .filter(x => x.semaforo === 'verde' || x.semaforo === 'rojo')
      .sort((a, b) => {
        const ta = a.semaforo === 'verde' ? 0 : 1;
        const tb = b.semaforo === 'verde' ? 0 : 1;
        if (ta !== tb) return ta - tb;
        return cmpDistanciaOrdenNombreRuta(a, b);
      });
  }, [page, rutaGruposBaseItems, pagosOrEmpty, visitasFallidasOrEmpty, rutaHistorialFecha, posicionRutaCobrador]);

  // ==========================================
  // MODAL: GPS PARA ACCIONES
  // ==========================================
  const capturarGPSAccion = async (accion: 'pago' | 'nopago' | 'jornada') => {
    const r = await intentarCapturarGpsParaCobranza(`captura_modal_${accion}`, { forzar: true });
    if (!r.ok) return;
    if (accion === 'pago') setMPago(mPago ? { ...mPago } : null);
    else if (accion === 'nopago') setMNoPago(mNoPago ? { ...mNoPago } : null);
  };

  // ==========================================
  // SWIPE
  // ==========================================
  const [swiped, setSwiped] = useState<string | null>(null);

  const nombrePantallaSesion = useMemo(() => {
    if (proveedorSesion?.nombre) return proveedorSesion.nombre;
    return nombreParaMostrarSesion({
      loginEmail,
      usernameState: user,
      authUser: authUserMeta ? { user_metadata: authUserMeta } : null,
    });
  }, [loginEmail, user, authUserMeta, proveedorSesion]);

  const avatarUrlSesion = useMemo(() => {
    const um = authUserMeta;
    if (!um || typeof um !== 'object') return '';
    for (const k of ['avatar_url', 'picture', 'photo', 'image', 'avatar'] as const) {
      const v = um[k];
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
    }
    return '';
  }, [authUserMeta]);

  const inicialAvatarSesion = useMemo(() => {
    const c = String(nombrePantallaSesion || '').trim().charAt(0);
    return c ? c.toUpperCase() : '?';
  }, [nombrePantallaSesion]);

  const SwipeRow = ({ id, children, onEdit, onDelete, onDetail }: { id: string; children: React.ReactNode; onEdit?: () => void; onDelete?: () => void; onDetail?: () => void }) => {
    const startX = useRef(0);
    const onTouchStart = (e: React.TouchEvent) => { startX.current = e.touches[0].clientX; setSwiped(null); };
    const onTouchMove = (e: React.TouchEvent) => {
      const diff = e.touches[0].clientX - startX.current;
      if (Math.abs(diff) > 80) { setSwiped(diff < 0 ? id : null); }
    };
    const onTouchEnd = () => { if (swiped === id) setSwiped(null); };
    return (
      <div className={`relative overflow-hidden rounded-2xl ${swiped === id ? 'shadow-lg' : ''}`}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {swiped === id && (
          <div className="absolute inset-y-0 right-0 flex">
            {onDetail && <button onClick={onDetail} className="w-16 bg-blue-500 text-white flex items-center justify-center active:scale-95 transition">📋</button>}
            {onEdit && <button onClick={onEdit} className="w-16 bg-amber-500 text-white flex items-center justify-center active:scale-95 transition">✏️</button>}
            {onDelete && <button onClick={onDelete} className="w-16 bg-red-500 text-white flex items-center justify-center active:scale-95 transition">🗑️</button>}
          </div>
        )}
        <div className={`transition-transform ${swiped === id ? '-translate-x-20' : ''}`}>{children}</div>
      </div>
    );
  };

  // ==========================================
  // RENDER
  // ==========================================
  if (showSplash) {
    return <SplashScreen elapsedMs={splashMs} />;
  }

  if (!sessionReady) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center p-6 text-slate-400"
        style={{ backgroundColor: 'var(--dotcom-fondo-splash, #020617)' }}
      >
        <p className="text-sm">Verificando sesión y permisos…</p>
      </div>
    );
  }

  // ==========================================
  // LOGIN
  // ==========================================
  if (page === 'login') {
    return (
      <div
        className="min-h-screen flex flex-col"
        style={{
          backgroundColor: 'var(--dotcom-fondo-splash, #020617)',
          backgroundImage: 'linear-gradient(180deg, #0c4a6e 0%, #020617 42%, #020617 100%)',
        }}
      >
        <style>{`
          @keyframes loginFadeIn {
            0% { opacity: 0; transform: translateY(8px); }
            100% { opacity: 1; transform: translateY(0); }
          }
        `}</style>
        <header className="shrink-0 px-6 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4 text-center font-sans" style={{ animation: 'loginFadeIn 0.45s ease-out forwards' }}>
          <h1 className="font-black text-4xl sm:text-5xl tracking-tight text-white leading-none" style={{ letterSpacing: '-0.04em' }}>
            {MARCA_PRIMARIA}
          </h1>
          <p className="mt-2 font-light text-sm sm:text-base text-cyan-100/80 tracking-wide">
            {MARCA_DESCRIPTOR}
          </p>
        </header>
        <div className="flex-1 flex flex-col justify-center items-center px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] min-h-0 overflow-y-auto">
          <div className="w-full max-w-sm py-4">
            <LoginForm
              onLogin={doLogin}
              loading={loading}
              onAbrirGuia={() => setMVistaRapidaSistema(true)}
            />
          </div>
        </div>
        <VistaRapidaSistemaModal
          open={mVistaRapidaSistema}
          onClose={() => setMVistaRapidaSistema(false)}
        />
      </div>
    );
  }

  // ==========================================
  // CONSOLA ROOT (operador técnico, sin cobranzas)
  // ==========================================
  if (esUsuarioRootOperadorSesion) {
    return (
      <div
        className="min-h-screen flex flex-col font-sans text-white pt-8 pt-[env(safe-area-inset-top)] overflow-x-hidden"
        style={{ backgroundColor: 'var(--dotcom-fondo-app, #020617)' }}
      >
        <header
          className="sticky top-0 z-50 border-b border-emerald-900/40 px-4 py-3 flex items-center justify-between gap-3 shrink-0"
          style={{ backgroundColor: 'color-mix(in srgb, var(--dotcom-fondo-app, #020617) 92%, transparent)' }}
        >
          <div className="min-w-0 flex items-center gap-2">
            <Shield className="w-5 h-5 shrink-0 text-emerald-400" aria-hidden />
            <div className="min-w-0">
              <p className="font-black text-base tracking-tight truncate">{MARCA_PRIMARIA}</p>
              <p className="text-[10px] text-emerald-400/90 uppercase tracking-[0.18em]">Consola técnica Root</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void doLogout()}
              className="flex items-center gap-1.5 rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200 active:scale-95 transition hover:bg-red-500/20"
              title="Cerrar sesión e ingresar con otro usuario"
            >
              <LogOut className="w-4 h-4 shrink-0" aria-hidden />
              <span className="hidden min-[360px]:inline">Salir</span>
            </button>
          </div>
        </header>
        <main className="flex-1 px-4 pt-3 min-w-0">
          <PanelRootTecnico onLogout={() => void doLogout()} />
        </main>
        <div
          className="shrink-0 w-full max-w-full box-border px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
          style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))' }}
        >
          <BrandingFooter
            align="center"
            variant="dark"
            className="branding-footer--screen w-full"
            marcaPrimaria={MARCA_PRIMARIA}
            descriptor={MARCA_DESCRIPTOR}
          />
        </div>
      </div>
    );
  }

  // ==========================================
  // MAIN APP
  // ==========================================
  const go = (p: string) => {
    if (sistemaBloqueadoTrial && p !== 'dashboard') return;
    if (esProveedorUsuario && p !== 'mi_inversion') return;
    if (esUsuarioMensualUsuario && !PAGINAS_MODULO_MENSUAL.has(p)) return;
    if (p !== 'creditos') limpiarDeepLinkCredito();
    setPage(p); setSwiped(null); setSearch(''); setFilterStatus('all');
    if (user && p !== 'login' && p !== 'root_console') void refrescarDatosApp();
  };
  const irAClientesParaCobro = () => {
    limpiarDeepLinkCredito();
    setPage('clientes');
    setSwiped(null);
    setSearch('');
    setFilterStatus('all');
    window.setTimeout(() => searchInputRef.current?.focus(), 80);
  };

  return (
    <div className={`min-h-screen font-sans pt-8 pt-[env(safe-area-inset-top)] ${data.config.modoExterior ? 'modo-exterior bg-white text-black text-[18px]' : 'text-white'}`} style={data.config.modoExterior ? undefined : { backgroundColor: 'var(--dotcom-fondo-app, #020617)' }}>
      {data.config.modoExterior && (
        <style>{`
          .modo-exterior button { border: 2px solid #000 !important; box-shadow: none !important; }
          .modo-exterior input, .modo-exterior textarea, .modo-exterior select { background: #fff !important; color: #000 !important; border: 2px solid #000 !important; }
          .modo-exterior .text-gray-400, .modo-exterior .text-gray-500 { color: #111 !important; }
        `}</style>
      )}
      {/* Status Bar */}
      <div
        className={`sticky top-0 z-50 backdrop-blur-xl border-b ${data.config.modoExterior ? 'bg-white border-black' : 'border-gray-800'}`}
        style={data.config.modoExterior ? undefined : { backgroundColor: 'color-mix(in srgb, var(--dotcom-fondo-app, #020617) 92%, transparent)' }}
      >
        <div className="flex items-center justify-between px-4 py-2 gap-3">
          <div className="flex min-w-0 items-center gap-3 shrink-0">
            <div className="leading-tight hidden min-[380px]:block font-sans">
              <span className="block font-black text-base sm:text-lg tracking-tight text-white" style={{ letterSpacing: '-0.03em' }}>{MARCA_PRIMARIA}</span>
              <span className="block font-light text-[9px] sm:text-[10px] text-gray-400 tracking-[0.14em] uppercase">{MARCA_DESCRIPTOR}</span>
            </div>
            <div className="relative flex min-w-0 items-center gap-2" ref={menuPerfilRef}>
            <span className="text-lg shrink-0" aria-hidden>💰</span>
            {user ? (
              <>
                <button
                  type="button"
                  onClick={() => setMenuPerfilAbierto(v => !v)}
                  className={`flex min-w-0 items-center gap-2.5 rounded-xl py-1.5 pl-1.5 pr-2 -mx-1 border border-transparent text-left transition ${
                    data.config.modoExterior
                      ? 'hover:border-gray-300 hover:bg-gray-100'
                      : 'hover:border-gray-600/80 hover:bg-gray-900/50'
                  }`}
                  aria-expanded={menuPerfilAbierto}
                  aria-haspopup="menu"
                  aria-label={`Menú de sesión: ${nombrePantallaSesion}`}
                >
                  {avatarUrlSesion ? (
                    <img
                      src={avatarUrlSesion}
                      alt=""
                      width={32}
                      height={32}
                      className={`h-8 w-8 shrink-0 rounded-full object-cover ${data.config.modoExterior ? 'ring-2 ring-cyan-700/30' : 'ring-2 ring-cyan-400/35'}`}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
                      style={{ background: 'linear-gradient(135deg, #0c4a6e 0%, #075985 42%, #22d3ee 100%)' }}
                      aria-hidden
                    >
                      {inicialAvatarSesion}
                    </div>
                  )}
                  <div className="min-w-0 leading-tight">
                    <p className={`text-sm truncate ${data.config.modoExterior ? 'text-gray-600' : 'text-gray-400'}`}>
                      Hola,{' '}
                      <span className={`font-bold ${data.config.modoExterior ? 'text-cyan-800' : 'text-cyan-300'}`}>{nombrePantallaSesion}</span>
                    </p>
                    <p className={`text-[10px] truncate ${data.config.modoExterior ? 'text-gray-500' : 'text-gray-500'}`}>Menú de sesión</p>
                  </div>
                </button>
                {menuPerfilAbierto && (
                  <div
                    role="menu"
                    className="absolute left-0 top-full mt-1 z-[60] min-w-[200px] rounded-xl border border-gray-700 bg-gray-900 shadow-xl shadow-black/40 py-1"
                  >
                    {!esProveedorUsuario && (
                      <button
                        type="button"
                        role="menuitem"
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-cyan-100 hover:bg-cyan-500/10 active:bg-cyan-500/15 transition"
                        onClick={() => {
                          setMenuPerfilAbierto(false);
                          setMVistaRapidaSistema(true);
                        }}
                      >
                        <span className="text-base shrink-0" aria-hidden>📖</span>
                        Guía del sistema
                      </button>
                    )}
                    {esMarcosPUsuario && (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-cyan-200 hover:bg-cyan-500/10 active:bg-cyan-500/15 transition"
                          onClick={() => {
                            setMenuPerfilAbierto(false);
                            setMarcosConfigTab('ajustes');
                            go('config');
                          }}
                        >
                          <span className="text-base shrink-0" aria-hidden>⚙️</span>
                          Perfil / Ajustes
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-amber-200 hover:bg-amber-500/10 active:bg-amber-500/15 transition"
                          onClick={() => {
                            setMenuPerfilAbierto(false);
                            setMarcosConfigTab('comisiones');
                            go('config');
                          }}
                        >
                          <span className="text-base shrink-0" aria-hidden>💰</span>
                          Comisiones
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-red-300 hover:bg-red-500/10 active:bg-red-500/15 transition"
                      onClick={() => {
                        setMenuPerfilAbierto(false);
                        void doLogout();
                      }}
                    >
                      <LogOut className="w-4 h-4 shrink-0" aria-hidden />
                      Cerrar sesión
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="leading-tight font-sans min-w-0">
                <span className="font-black text-sm sm:text-base block tracking-tight text-white">{MARCA_PRIMARIA}</span>
                <span className="font-light text-[10px] text-gray-400 block tracking-wide">{MARCA_DESCRIPTOR}</span>
              </div>
            )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isOnline && <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">📴 Offline</span>}
            {((Array.isArray(gastos) ? gastos : []).filter(g => g && !g.sync).length) > 0 && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">⏳ {(Array.isArray(gastos) ? gastos : []).filter(g => g && !g.sync).length}</span>}
            {user && (
              <button onClick={() => setMNotificaciones(true)} className="relative w-9 h-9 rounded-lg bg-gray-800/70 border border-gray-700 flex items-center justify-center">
                🔔
                {notificacionesNoLeidas > 0 && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-red-500" />}
              </button>
            )}
            <span className="text-xs text-gray-500">{new Date().toLocaleDateString('es-AR')}</span>
          </div>
        </div>
        {/* Global Search */}
        {(page === 'dashboard' || page === 'clientes' || page === 'fichas') && !esProveedorUsuario && !esUsuarioMensualUsuario && (
          <div className="px-4 pb-2">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input ref={searchInputRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente por nombre o dirección..."
                className="w-full bg-gray-800/60 border border-gray-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition" />
            </div>
          </div>
        )}
        {esUsuarioMensualUsuario && (page === 'dashboard' || page === 'clientes') && (
          <div className="px-4 pb-2">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input ref={searchInputRef} value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar cliente..."
                className="w-full bg-gray-800/60 border border-gray-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition" />
            </div>
          </div>
        )}
      </div>

      {/* Page Content */}
      <main className="pb-24 px-4 pt-3">
        {bannerCobroRed && (
          <div
            role="alert"
            className="mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-100 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="flex-1">{bannerCobroRed}</p>
            <button
              type="button"
              onClick={() => setBannerCobroRed(null)}
              className="shrink-0 rounded-xl bg-amber-600/80 px-3 py-2 font-medium text-white hover:bg-amber-600"
            >
              Entendido
            </button>
          </div>
        )}
        {misSolicitudesFondoCreditoVigentes.length > 0 && (
          <div className="mb-4 rounded-2xl border border-amber-500/35 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
            <p className="font-semibold text-amber-200">Solicitud de fondo en caja</p>
            <p className="mt-1 text-xs leading-relaxed">
              {misSolicitudesFondoCreditoVigentes.map(s => {
                const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(s.cliente_id));
                return `Esperando que Marcos ingrese ${fmt(s.monto)} para el crédito de ${nombreCompletoCliente(cli) || 'cliente'}.`;
              }).join(' ')}
            </p>
          </div>
        )}
        {misSolicitudesFondoCredito.some(s => s.estado === 'fondado') && (
          <div className="mb-4 rounded-2xl border border-green-500/35 bg-green-950/30 px-4 py-3 text-sm text-green-100">
            <p className="font-semibold text-green-300">Ingresos de Marcos en tu caja</p>
            <ul className="mt-2 space-y-1 text-xs">
              {misSolicitudesFondoCredito.filter(s => s.estado === 'fondado').slice(0, 5).map(s => {
                const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(s.cliente_id));
                return (
                  <li key={s.id}>
                    +{fmt(s.monto)} — crédito de {nombreCompletoCliente(cli) || 'cliente'}
                    {s.fondado_at ? ` (${new Date(s.fondado_at).toLocaleDateString('es-AR')})` : ''}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {/* DASHBOARD */}
        {page === 'dashboard' && esUsuarioMensualUsuario && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-teal-500/30 bg-teal-950/25 p-4">
              <h2 className="text-lg font-bold text-teal-100">Créditos mensuales</h2>
              <p className="text-xs text-teal-200/70 mt-1">Cartera independiente: clientes, préstamos y cobros solo de este módulo.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Clientes', icon: '👥', color: 'bg-indigo-600', route: 'clientes' },
                { label: 'Préstamos', icon: '🏦', color: 'bg-teal-600', route: 'creditos' },
                { label: 'Simulador', icon: '🧮', color: 'bg-violet-600', route: 'simulador_mensual' },
                { label: 'Cobros', icon: '💵', color: 'bg-green-600', route: 'clientes', action: 'cobro' as const },
                { label: 'Listado a cobrar', icon: '📋', color: 'bg-blue-600', route: 'ruta' },
                { label: 'Recibos mensuales', icon: '🧾', color: 'bg-amber-600', route: 'recibos_mensuales' },
              ].map((btn, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    if (btn.action === 'cobro') { irAClientesParaCobro(); return; }
                    go(btn.route);
                  }}
                  className={`${btn.color} rounded-2xl p-4 flex flex-col items-center gap-2 active:scale-95 transition-all shadow-lg`}
                >
                  <span className="text-3xl">{btn.icon}</span>
                  <span className="text-white font-semibold text-sm text-center">{btn.label}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700">
                <p className="text-xs text-gray-400">Clientes activos</p>
                <p className="text-2xl font-bold text-white">{clientesOrEmpty.filter(c => c.activo !== false).length}</p>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-3 border border-gray-700">
                <p className="text-xs text-gray-400">Préstamos activos</p>
                <p className="text-2xl font-bold text-white">{creditosOrEmpty.filter(c => esCreditoActivo(c)).length}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMAjusteTasaMensual(true)}
              className="w-full rounded-2xl border border-violet-500/40 bg-violet-950/30 px-4 py-3 flex items-center justify-between gap-3 active:scale-[0.98] transition"
            >
              <span className="text-left">
                <span className="block text-sm font-bold text-violet-100">📊 Tasas de interés mensual</span>
                <span className="block text-xs text-violet-200/70 mt-0.5">
                  {configTasasMensual.ajusteGlobalPct !== 0 && (
                    <>Ajuste general {configTasasMensual.ajusteGlobalPct > 0 ? '+' : ''}{configTasasMensual.ajusteGlobalPct} p.p. · </>
                  )}
                  {cantidadTasasMensualPersonalizadas(configTasasMensual) > 0
                    ? `${cantidadTasasMensualPersonalizadas(configTasasMensual)} plan(es) personalizado(s)`
                    : 'Tasas por defecto'}
                </span>
              </span>
              <span className="text-violet-300 text-lg shrink-0">⚙️</span>
            </button>
          </div>
        )}
        {page === 'dashboard' && !esUsuarioMensualUsuario && (
          <div className="space-y-4">
            {/* KPI Cards */}
            {isAdminOrRoot(rol) && (
              <SectionErrorBoundary>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'En Mora', valor: kpis.moraClientes, icon: '🚩', color: 'from-red-500/20 to-red-600/10 border-red-500/30', textColor: 'text-red-400', onClick: () => { setFilterStatus('mora'); go('clientes'); } },
                    { label: 'Ingresos campo', valor: fmt(kpis.totalCobradoHoy), icon: '💵', color: 'from-green-500/20 to-green-600/10 border-green-500/30', textColor: 'text-green-400', onClick: () => go('panel_control') },
                    { label: 'Egresos campo', valor: fmt(kpis.totalGastosHoy), icon: '📤', color: 'from-orange-500/20 to-orange-600/10 border-orange-500/30', textColor: 'text-orange-400', onClick: () => go('panel_control') },
                    { label: 'Cobrado acumulado', valor: fmt(kpis.gananciaNeta), icon: '📊', color: 'from-amber-500/20 to-amber-600/10 border-amber-500/30', textColor: 'text-amber-300', onClick: () => go('cierre_caja') },
                    { label: 'Total a cobrar hoy', valor: fmt(kpis.totalACobrarHoy), icon: '📋', color: 'from-indigo-500/20 to-indigo-600/10 border-indigo-500/30', textColor: 'text-indigo-300', onClick: () => go('panel_control') },
                    { label: 'Efectividad', valor: `${kpis.efectividad.toFixed(0)}%`, icon: '🎯', color: 'from-blue-500/20 to-blue-600/10 border-blue-500/30', textColor: 'text-blue-400', onClick: () => {} },
                  ].map((k, i) => (
                    <button key={i} onClick={k.onClick} className={`bg-gradient-to-br ${k.color} border rounded-2xl p-4 text-left active:scale-95 transition-all`}>
                      <div className="flex items-start justify-between">
                        <span className="text-2xl">{k.icon}</span>
                        <span className={`text-xs ${k.textColor} font-medium`}>{k.label}</span>
                      </div>
                      <p className={`text-2xl font-bold mt-2 ${k.textColor}`}>{k.valor}</p>
                    </button>
                  ))}
                </div>
                {kpis.recaudacionCampo && kpis.recaudacionCampo.porUsuarioCampo.length > 0 && (
                  <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-gray-300">Recaudación en vivo por usuario (campo)</p>
                    {kpis.recaudacionCampo.porUsuarioCampo.map(u => (
                      <div key={u.cobrador} className="flex items-center justify-between gap-2 rounded-xl bg-gray-800/50 px-3 py-2 text-xs">
                        <span className="text-gray-300 truncate">{etiquetaCobradorMovimiento(u.cobrador)}</span>
                        <span className="shrink-0 text-emerald-400 font-semibold">+{fmt(u.cobrado)}</span>
                        <span className="shrink-0 text-orange-400">−{fmt(u.gastos)}</span>
                        <span className={`shrink-0 font-bold ${u.neto < 0 ? 'text-red-400' : 'text-amber-300'}`}>{fmt(u.neto)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </SectionErrorBoundary>
            )}

            {/* Promesas de Pago */}
            {kpis.promesasCount > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⏰</span>
                  <div>
                    <p className="text-amber-400 font-semibold">Promesas de Pago para Hoy</p>
                    <p className="text-amber-300/70 text-sm">{kpis.promesasCount} cliente(s) tienen compromiso pendiente</p>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-pink-500/10 border border-pink-500/30 rounded-2xl p-4">
              <h3 className="font-bold text-sm text-pink-200 mb-3">🎂 Cumpleaños de Hoy</h3>
              {cumpleañosHoy.length === 0 && <p className="text-xs text-pink-100/60">No hay cumpleaños cargados para hoy.</p>}
              <div className="space-y-2">
                {cumpleañosHoy.map((cli, i) => (
                  <div key={cli?.id ? String(cli.id) : `cumple-${i}`} className="flex items-center justify-between gap-3 bg-gray-900/50 rounded-xl p-3">
                    <p className="text-sm font-semibold text-white truncate">{nombreCompletoCliente(cli) ?? '—'}</p>
                    <button
                      type="button"
                      onClick={() => void enviarSaludoCumpleanos(cli)}
                      className="shrink-0 bg-green-500 text-white rounded-lg px-3 py-2 text-xs font-bold active:scale-95 transition"
                    >
                      Enviar Saludo Especial
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <CalculadoraPlanesCredito puedeEditarTasa={puedeEditarInteresCredito(rol)} tasaFija={data.config.interesCreditoP ?? 30} />

            {/* Quick Actions */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Registrar Cobro', icon: '💵', color: 'bg-green-500', route: 'clientes' },
                { label: 'Ruta del Día', icon: '🗺️', color: 'bg-blue-500', route: 'clientes' },
                { label: 'Lista Morosos', icon: '🚩', color: 'bg-red-500', route: 'clientes' },
                ...(esMarcosPUsuario ? [{ label: 'Gastos y Caja', icon: '📤', color: 'bg-orange-500', route: 'gastos' }] : []),
                ...(esMarcosPUsuario ? [{ label: '⚙️ Configuración', icon: '⚙️', color: 'bg-indigo-600', route: 'config' }] : []),
                ...(esMarcosPUsuario ? [{ label: 'Cierre de Caja', icon: '🧾', color: 'bg-emerald-700', route: 'cierre_caja' }] : []),
                ...(esMarcosPUsuario ? [{ label: '🏦 Créditos', icon: '🏦', color: 'bg-teal-600', route: 'creditos' }] : []),
                ...(esMarcosPUsuario ? [{ label: '🧭 Panel de Control', icon: '🧭', color: 'bg-cyan-700', route: 'panel_control' }] : []),
                ...(esMarcosPUsuario && isRootLike(rol) ? [{ label: '👥 Gestión de usuarios', icon: '👥', color: 'bg-violet-600', route: 'config' }] : []),
              ].map((btn, i) => (
                <button key={i} onClick={() => {
                  if (btn.label === 'Registrar Cobro') { irAClientesParaCobro(); return; }
                  if (btn.route === 'clientes') setFilterStatus('mora');
                  if (btn.route === 'config') setFilterStatus('all');
                  go(btn.route);
                }}
                  className={`${btn.color} rounded-2xl p-4 flex flex-col items-center gap-2 active:scale-95 transition-all shadow-lg`}>
                  <span className="text-3xl">{btn.icon}</span>
                  <span className="text-white font-semibold text-sm text-center">{btn.label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setEstadoQr('Preparando cámara...'); setMQrScan(true); }}
              className="w-full bg-cyan-500/20 border border-cyan-400/40 text-cyan-300 rounded-2xl py-3 text-sm font-semibold active:scale-95 transition"
            >
              📷 Escaneo Rápido (QR Cliente)
            </button>
            {esMarcosPUsuario && (
              <div className="bg-violet-500/10 border border-violet-500/30 rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-violet-300 font-semibold">Solicitudes Pendientes</p>
                    <p className="text-xs text-violet-200/70">Revisión administrativa de créditos</p>
                  </div>
                  <span className="text-2xl font-bold text-violet-300">{solicitudesPendientes}</span>
                </div>
                <button
                  type="button"
                  onClick={() => { setFiltroPendientesCredito('pendientes'); go('creditos'); }}
                  className="mt-3 w-full bg-violet-600/40 border border-violet-400/30 text-violet-100 rounded-xl py-2 text-sm font-semibold active:scale-95 transition"
                >
                  Ver solicitudes
                </button>
              </div>
            )}

            {esMarcosPUsuario && (
              <button
                type="button"
                onClick={() => { setMarcosConfigTab('comisiones'); go('config'); }}
                className="w-full rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4 text-left active:scale-[0.98] transition"
              >
                <p className="text-sm font-bold text-amber-200">💰 Comisiones de vendedores</p>
                <p className="text-xs text-amber-100/70 mt-1">
                  {vendedoresComisionAdmin.filter(v => v.total_pendiente_aprobacion > 0).length > 0
                    ? `${vendedoresComisionAdmin.filter(v => v.total_pendiente_aprobacion > 0).length} vendedor(es) con comisiones por aprobar`
                    : 'Gestionar % por vendedor, aprobar ventas y liquidar'}
                </p>
              </button>
            )}

            {miResumenComisionVendedor && (
              <div className="bg-teal-500/10 border border-teal-500/35 rounded-2xl p-4 space-y-3">
                <div>
                  <p className="text-sm font-bold text-teal-200">💼 Mis comisiones</p>
                  <p className="text-xs text-teal-100/70 mt-1">
                    Marcos debe aprobar cada comisión; después figura acá como monto a cobrar en la liquidación semanal.
                  </p>
                  <p className="text-[11px] text-teal-200/60 mt-1">
                    Corte semana: {miResumenComisionVendedor.corteSemana} · Próxima liquidación: {miResumenComisionVendedor.proximoSabado}
                  </p>
                </div>
                {miResumenComisionVendedor.totalRevision > 0 && (
                  <div className="rounded-xl bg-violet-500/10 border border-violet-500/25 px-3 py-2">
                    <p className="text-[11px] text-violet-200">En revisión (admin)</p>
                    <p className="text-lg font-bold text-violet-300">{fmt(miResumenComisionVendedor.totalRevision)}</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] text-teal-200/80">A cobrar (aprobadas)</p>
                  <p className="text-3xl font-black text-teal-300">{fmt(miResumenComisionVendedor.total)}</p>
                </div>
                {miResumenComisionVendedor.enRevisionAdmin.length > 0 && (
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    <p className="text-[10px] text-violet-300/90 uppercase tracking-wide">Pendientes de aprobación</p>
                    {miResumenComisionVendedor.enRevisionAdmin.map(c => (
                      <div key={c.id} className="flex justify-between text-xs bg-violet-950/40 rounded-lg px-3 py-2">
                        <span className="text-gray-300 truncate pr-2">
                          {String(c.nro_carton || c.id).slice(0, 12)} · {fmt(Number(c.monto_solicitado) || 0)}
                        </span>
                        <span className="font-bold text-violet-300 shrink-0">{fmt(Number(c.comision_vendedor) || 0)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {miResumenComisionVendedor.pendientes.length > 0 && (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    <p className="text-[10px] text-teal-300/90 uppercase tracking-wide">Aprobadas — pendiente de pago</p>
                    {miResumenComisionVendedor.pendientes.map(c => (
                      <div key={c.id} className="flex justify-between text-xs bg-gray-900/50 rounded-lg px-3 py-2">
                        <span className="text-gray-300 truncate pr-2">
                          {String(c.nro_carton || c.id).slice(0, 12)} · {fmt(Number(c.monto_solicitado) || 0)}
                        </span>
                        <span className="font-bold text-teal-300 shrink-0">{fmt(Number(c.comision_vendedor) || 0)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Cobrador / vendedor: caja del día y cierre de jornada (pendiente hasta recepción Marcos) */}
            {esUsuarioCampoConCaja && (
              <div className="space-y-3">
                {(usuarioCampoBloqueadoOperaciones || cobradorBloqueadoCobros) && (
                  <div className={`rounded-2xl border p-3 text-center text-sm ${esperandoValidacionRendicion ? 'border-amber-500/50 bg-amber-500/10 text-amber-200' : 'border-sky-500/40 bg-sky-500/10 text-sky-200'}`}>
                    {esperandoValidacionRendicion && (
                      <p className="font-semibold">⏳ Esperando validación del administrador. No podés registrar cobros hasta que acepte la rendición.</p>
                    )}
                    {jornadaCerradaValidadaHoy && cobradorBloqueadoCobros && (
                      <p className="font-semibold">✅ Rendición aceptada. Nueva jornada a partir de las 00:00. No podés registrar cobros hasta entonces.</p>
                    )}
                    {jornadaCerradaValidadaHoy && esUsuarioVendedorSesion && (
                      <p className="font-semibold">✅ Rendición aceptada. Como vendedor podés seguir cobrando hoy; los montos se suman en «Efectivo en mano».</p>
                    )}
                  </div>
                )}
                <div className="bg-emerald-500/10 border border-emerald-500/35 rounded-2xl p-4">
                  <h3 className="font-bold text-sm text-emerald-200 mb-3">💵 Efectivo en mano (hoy)</h3>
                  <p className="text-[11px] text-emerald-100/70 mb-3">
                    {cajaCobradorDia.congeladoRendicion
                      ? 'Montos congelados al cerrar jornada. Pendiente de recepción por Marcos.'
                      : 'Cada gasto operativo resta del efectivo que llevás. Jornada = día calendario (00:00–00:00).'}
                  </p>
                  <div className="grid grid-cols-1 gap-2 text-sm">
                    <div className="flex justify-between"><span className="text-gray-400">Cobrado</span><span className="font-semibold text-white">{fmt(cajaCobradorDia.totalCobrado)}</span></div>
                    {cajaCobradorDia.ingresosCaja > 0 && (
                      <div className="flex justify-between"><span className="text-gray-400">Ingreso Marcos (crédito)</span><span className="font-semibold text-amber-300">+ {fmt(cajaCobradorDia.ingresosCaja)}</span></div>
                    )}
                    <div className="flex justify-between"><span className="text-gray-400">Gastos</span><span className="font-semibold text-orange-300">− {fmt(cajaCobradorDia.totalGastos)}</span></div>
                    <div className="flex justify-between border-t border-emerald-500/25 pt-2 mt-1"><span className="text-emerald-200 font-semibold">En mano</span><span className="font-black text-emerald-300 text-lg">{fmt(cajaCobradorDia.efectivoEnMano)}</span></div>
                  </div>
                  {(rol || '').toLowerCase() === 'cobrador' && !usuarioCampoBloqueadoOperaciones && (
                    <button
                      type="button"
                      onClick={() => setMGasto({ categoria: 'Combustible' })}
                      className="mt-4 w-full bg-orange-500/25 border border-orange-500/40 text-orange-100 rounded-xl py-3 text-sm font-bold active:scale-[0.99] transition"
                    >
                      + Registrar gasto operativo
                    </button>
                  )}
                </div>
                {puedeCerrarJornadaCampo && (
                  <button
                    type="button"
                    onClick={() => setMJornada(true)}
                    className="w-full bg-gray-800 border border-gray-700 hover:border-indigo-500 rounded-2xl p-4 flex items-center gap-4 active:scale-[0.98] transition-all"
                  >
                    <div className="w-12 h-12 bg-indigo-500/20 rounded-xl flex items-center justify-center">
                      <span className="text-2xl">🏁</span>
                    </div>
                    <div className="text-left flex-1">
                      <p className="text-white font-semibold">Cerrar caja / jornada</p>
                      <p className="text-gray-400 text-xs">Queda pendiente hasta que Marcos acepte la recepción</p>
                    </div>
                    <span className="text-gray-500">→</span>
                  </button>
                )}
                {esperandoValidacionRendicion && (
                  <div className="bg-amber-500/10 border border-amber-500/35 rounded-2xl p-4 text-center">
                    <p className="text-amber-200 font-semibold text-sm">Rendición enviada — pendiente de aprobación</p>
                    <p className="text-amber-100/60 text-xs mt-1">El administrador debe aceptarla para liberar tu próxima jornada.</p>
                  </div>
                )}
                {jornadaCerradaValidadaHoy && cobradorBloqueadoCobros && (
                  <div className="bg-sky-500/10 border border-sky-500/35 rounded-2xl p-4 text-center">
                    <p className="text-sky-200 font-semibold text-sm">Jornada cerrada y rendición aceptada</p>
                    <p className="text-sky-100/60 text-xs mt-1">Mañana a las 00:00 podés volver a cobrar.</p>
                  </div>
                )}
                {jornadaCerradaValidadaHoy && esUsuarioVendedorSesion && (
                  <div className="bg-sky-500/10 border border-sky-500/35 rounded-2xl p-4 text-center">
                    <p className="text-sky-200 font-semibold text-sm">Rendición de cobrador cerrada hoy</p>
                    <p className="text-sky-100/60 text-xs mt-1">Tus cobros de vendedor siguen acumulándose en efectivo en mano.</p>
                  </div>
                )}
              </div>
            )}

            {esMarcosPUsuario && (
              <div className="rounded-2xl border border-amber-500/40 bg-amber-950/40 p-4 space-y-2">
                <p className="text-sm font-bold text-amber-100">Limpiar cola offline de cobros</p>
                <p className="text-xs text-amber-200/80 leading-relaxed">
                  Forzar subida usando solo REST: tablas públicas{' '}
                  <code className="text-[11px] text-amber-50/95">pagos</code>,{' '}
                  <code className="text-[11px] text-amber-50/95">cuotas</code>, más{' '}
                  <code className="text-[11px] text-amber-50/95">clientes</code> /{' '}
                  <code className="text-[11px] text-amber-50/95">caja</code> cuando aplica (sin RPC).
                  localStorage{' '}
                  <code className="text-[11px]">{LS_COBROS_PENDIENTES_V1}</code>.
                </p>
                <p className="text-xs text-amber-300 font-medium">
                  Pendientes ahora: {leerCobrosPendientesLocalRaw().length}
                </p>
                <button
                  type="button"
                  disabled={forzandoSubidaCobrosLocales || leerCobrosPendientesLocalRaw().length === 0}
                  className="w-full rounded-xl bg-amber-600 py-3 text-sm font-bold text-white shadow active:scale-[0.99] transition disabled:opacity-50 disabled:pointer-events-none"
                  onClick={async () => {
                    setForzandoSubidaCobrosLocales(true);
                    try {
                      const r = await ejecutarSubidaManualCobrosLocalesDesdeLs();
                      await fetchData({ silencioso: true });
                      setBannerCobroRed(siguienteMensajeBannerColaCobrosPendientes());
                      const muestraErrores = r.erroresDetalle.slice(0, 5).join('\n');
                      alert(
                        `Listo.\n✅ Subidos: ${r.subidos}\n⏳ Pendientes en dispositivo: ${r.pendientesFinal}`
                        + (muestraErrores ? `\n\nÚltimos avisos:\n${muestraErrores}` : ''),
                      );
                    } catch (e: unknown) {
                      alert(`No se completó la subida. ${serializarErrorParaAuditoria(e).mensaje.slice(0, 300)}`);
                    } finally {
                      setForzandoSubidaCobrosLocales(false);
                    }
                  }}
                >
                  {forzandoSubidaCobrosLocales ? 'Subiendo cobros locales…' : 'Forzar Subida de Cobros Locales'}
                </button>
              </div>
            )}
            <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
              <h3 className="font-bold text-sm text-gray-300 mb-3">🔔 Avisos Recientes</h3>
              <div className="space-y-2">
                {notificacionesUsuario.slice(0, 3).map(n => (
                  <button
                    key={n.id}
                    onClick={() => handleNotificacionClick(n)}
                    className="w-full text-left bg-gray-800/60 rounded-lg p-3"
                  >
                    <p className="text-xs font-semibold text-white">{n.titulo}</p>
                    <p className="text-xs text-gray-400">{n.mensaje}</p>
                  </button>
                ))}
                {notificacionesUsuario.length === 0 && <p className="text-gray-500 text-xs">Sin avisos recientes</p>}
              </div>
            </div>
          </div>
        )}

        {page === 'simulador_mensual' && esUsuarioMensualUsuario && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold">🧮 Simulador de préstamos mensuales</h2>
            <CalculadoraPlanesCreditoMensual configTasasMensual={configTasasMensual} />
          </div>
        )}

        {page === 'recibos_mensuales' && esUsuarioMensualUsuario && (
          <RecibosMensualesLista
            pagos={pagosOrEmpty}
            clientes={clientesOrEmpty}
            onVerRecibo={(pago) => {
              const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(pago.clienteId));
              const ficha = fichaParaComprobanteDesdePago(pago, fichasOrEmpty, []);
              if (!cli || !ficha) {
                alert('No se pudo armar el recibo para este cobro.');
                return;
              }
              setMComprobanteImagen(comprobanteImagenDesdePago(pago, cli, ficha, pagosOrEmpty));
            }}
          />
        )}

        {/* CLIENTES */}
        {page === 'clientes' && (
          <div className="space-y-3">
            {/* Filtros */}
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
              {[{ k: 'all', l: 'Todos' }, { k: 'mora', l: '🔴 Mora' }, { k: 'pendiente', l: '🟡 Pendiente' }, { k: 'alDia', l: '🟢 Al Día' }].map(f => (
                <button key={f.k} onClick={() => setFilterStatus(f.k)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${filterStatus === f.k ? 'bg-indigo-500 text-white' : 'bg-gray-800 text-gray-400'}`}>
                  {f.l}
                </button>
              ))}
            </div>

            {/* GPS Ordenar */}
            <button onClick={optimizarRuta} disabled={ordenandoRuta}
              className="w-full bg-blue-500/10 border border-blue-500/30 text-blue-400 rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2 active:scale-95 transition">
              {ordenandoRuta ? '⏳ Obteniendo ubicación...' : '📍 Optimizar Ruta (ordenar por distancia)'}
            </button>

            {/* Lista */}
            <SectionErrorBoundary>
              <>
                {filtrados.length === 0 && (
                  <div className="text-center py-12 text-gray-500">
                    <p className="text-4xl mb-3">🔍</p>
                    <p>No se encontraron clientes</p>
                  </div>
                )}
                {filtrados.map(cli => {
                  if (!cli) return null;
                  const { total: moraTotal } = getMoraClientes(cli);
                  const sem = getSemafClient(cli);
                  return (
                    <SwipeRow key={cli.id} id={cli.id}
                      onEdit={() => { setMCliente(cli); setTab(0); }}
                      onDelete={esMarcosPUsuario ? (() => handleDeleteCliente(cli.id)) : undefined}
                      onDetail={() => setMDetalleCliente(cli)}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setMDetalleCliente(cli)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setMDetalleCliente(cli);
                          }
                        }}
                        className="w-full bg-gray-900/70 border border-gray-800 rounded-2xl p-4 text-left active:scale-[0.98] transition-all cursor-pointer"
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-12 h-12 bg-gray-800 rounded-xl flex items-center justify-center text-xl flex-shrink-0">
                            {sem === '🔴' ? '🚩' : sem === '🟢' ? '✅' : sem === '🟡' ? '⏳' : '💚'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-white truncate">{nombreCompletoCliente(cli) ?? '—'}</p>
                              {cli.promesaFecha && cli.promesaFecha === hoy() && <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">⏰ Hoy</span>}
                            </div>
                            <p className="text-gray-400 text-xs truncate">{cli.direccion}</p>
                            <div className="flex items-center gap-3 mt-2">
                              <span className={`text-xs font-semibold ${moraTotal > 0 ? 'text-red-400' : cli.saldo > 0 ? 'text-amber-400' : 'text-green-400'}`}>
                                {fmt(cli.saldo)}
                              </span>
                              <span className="text-xs text-gray-500">Cuota: {fmt(cli.quota)}</span>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2 flex-shrink-0">
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); setMCliente(cli); setTab(0); }}
                              className="w-9 h-9 bg-indigo-500/20 rounded-lg flex items-center justify-center text-indigo-300 active:scale-90 transition"
                              title="Editar cliente"
                              aria-label="Editar cliente"
                            >
                              ✏️
                            </button>
                            <button type="button" onClick={e => { e.stopPropagation(); waCliente(cli); }} className="w-9 h-9 bg-green-500/20 rounded-lg flex items-center justify-center text-green-400 active:scale-90 transition" aria-label="WhatsApp">💬</button>
                            <button type="button" onClick={e => { e.stopPropagation(); geoCliente(cli); }} className="w-9 h-9 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-400 active:scale-90 transition" aria-label="Ubicación">📍</button>
                          </div>
                        </div>
                      </div>
                    </SwipeRow>
                  );
                })}
              </>
            </SectionErrorBoundary>

            {(isAdminOrRoot(rol) || esRolCampoRestringido(rol) || esUsuarioMensualUsuario) && (
              <button
                type="button"
                onClick={() => {
                  setClienteModalNonce(n => n + 1);
                  setMCliente({});
                  setTab(0);
                }}
                className="w-full bg-indigo-500 text-white rounded-2xl py-4 font-bold text-base flex items-center justify-center gap-2 active:scale-95 transition-all shadow-lg shadow-indigo-500/30"
              >
                + Nuevo Cliente
              </button>
            )}
            {rol === 'cobrador' && !esUsuarioMensualUsuario && (
              <div className="bg-gray-900/70 border border-cyan-500/30 rounded-2xl p-4">
                <h3 className="text-sm font-bold text-cyan-300 mb-3">📌 Resumen del Día</h3>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Cobros realizados hoy</span>
                    <span className="font-semibold text-green-400">{resumenCobrador.totalCobros}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Monto recaudado hoy</span>
                    <span className="font-semibold text-emerald-400">{fmt(resumenCobrador.totalRecaudado)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Efectividad (visitados vs cobros)</span>
                    <span className="font-semibold text-blue-400">{resumenCobrador.efectividad.toFixed(1)}%</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* FICHAS */}
        {page === 'fichas' && (
          <div className="space-y-3">
            {fichasOrEmpty.length === 0 && <div className="text-center py-12 text-gray-500"><p className="text-4xl mb-3">📋</p><p>Sin fichas registradas</p></div>}
            {fichasOrEmpty.map(fic => {
              const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(fic.clienteId)) || {
                id: fic.clienteId || `sin_cliente_${fic.id}`,
                nombre: fic.clienteId ? `Cliente ${fic.clienteId}` : 'Cliente sin vincular',
                telefono: '',
                direccion: 'Sin datos de cliente',
                saldo: 0,
                quota: 0,
                frecuencia: 'semanal' as const,
                fechaAlta: hoy(),
                activo: true,
              };
              const semaforo = semaforoFicha(fic);
              const saldoRestante = saldoRestanteFicha(fic);
              return (
                <SwipeRow key={fic.id} id={fic.id}
                  onEdit={() => { setMFicha({ cliente: cli, ficha: fic }); setTab(0); }}
                  onDelete={esMarcosPUsuario ? (() => handleDeleteFicha(fic.id)) : undefined}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMFicha({ cliente: cli, ficha: fic })}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setMFicha({ cliente: cli, ficha: fic });
                      }
                    }}
                    className={`w-full bg-gradient-to-br ${semaforo.cardClass} rounded-2xl p-4 text-left active:scale-[0.98] transition-all cursor-pointer`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold">{nombreCompletoCliente(cli) ?? '—'}</p>
                        <p className="text-xs text-gray-400">{fic.tipo === 'prestamo' ? '💳 Préstamo' : '🛒 Venta'} · {fic.cuotasPagas}/{fic.cuotas} cuotas</p>
                        <p className="text-[11px] text-cyan-300">Producto: {productoFichaLabel(fic)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-indigo-400">{fmt(saldoRestante)}</p>
                        <p className="text-xs text-gray-500">{semaforo.metaLabel}</p>
                      </div>
                    </div>
                    {/* Barra de progreso */}
                    <div className="mt-3 bg-gray-800 rounded-full h-2">
                      <div className="bg-gradient-to-r from-green-400 to-emerald-500 h-2 rounded-full transition-all" style={{ width: `${(fic.cuotasPagas / fic.cuotas) * 100}%` }} />
                    </div>
                  </div>
                </SwipeRow>
              );
            })}
            {isAdminOrRoot(rol) && (
              <button onClick={() => {
                const firstUuid = clientesOrEmpty.find(c => esUuidClienteId(String(c?.id ?? '')));
                const first = firstUuid || clientesOrEmpty[0];
                setMFicha({ cliente: first || null as unknown as Cliente });
                setTab(0);
                setTimeout(() => (document.getElementById('selCliente') as HTMLSelectElement)?.focus(), 100);
              }}
                className="w-full bg-indigo-500 text-white rounded-2xl py-4 font-bold flex items-center justify-center gap-2 active:scale-95 transition-all">
                + Nueva Ficha
              </button>
            )}
          </div>
        )}

        {/* CIERRE DE CAJA */}
        {page === 'cierre_caja' && esMarcosPUsuario && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">🧾 Caja</h2>
                <p className="text-xs text-gray-400">Recaudación en vivo de cobradores/vendedores (sin esperar cierre de caja).</p>
              </div>
              <button
                type="button"
                onClick={() => void handleCerrarDiaMarcos()}
                className="bg-emerald-600 text-white rounded-xl px-4 py-2 text-sm font-bold active:scale-95 transition"
              >
                Cerrar Día
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-900/60 border border-emerald-500/35 rounded-2xl p-3">
                <p className="text-[10px] text-gray-400 leading-tight">Ingresos (cobros campo)</p>
                <p className="text-lg font-black text-emerald-400 mt-1">{fmt(resumenCajaMarcosDia.ingresosCampoHoy)}</p>
              </div>
              <div className="bg-gray-900/60 border border-orange-500/35 rounded-2xl p-3">
                <p className="text-[10px] text-gray-400 leading-tight">Egresos (gastos campo)</p>
                <p className="text-lg font-black text-orange-400 mt-1">{fmt(resumenCajaMarcosDia.egresosCampoHoy)}</p>
              </div>
              <div className="bg-gray-900/60 border border-amber-500/35 rounded-2xl p-3">
                <p className="text-[10px] text-gray-400 leading-tight">Cobrado acumulado</p>
                <p className={`text-lg font-black mt-1 ${resumenCajaMarcosDia.cobradoAcumuladoCampo < 0 ? 'text-red-400' : 'text-amber-300'}`}>
                  {fmt(resumenCajaMarcosDia.cobradoAcumuladoCampo)}
                </p>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 text-center">
              Actualización automática cada 10 s y al registrar cobros/gastos en ruta.
            </p>

            <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-3">
              <h3 className="font-bold text-sm text-gray-300">Recaudación por usuario (hoy, en vivo)</h3>
              {resumenCajaMarcosDia.porUsuarioCampo.length === 0 && (
                <p className="text-sm text-gray-500">Sin cobros ni gastos de cobradores/vendedores hoy.</p>
              )}
              {resumenCajaMarcosDia.porUsuarioCampo.map(u => (
                <div key={u.cobrador} className="bg-gray-800/60 rounded-xl p-3">
                  <p className="font-semibold text-sm text-white mb-2">{etiquetaCobradorMovimiento(u.cobrador)}</p>
                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="rounded-lg bg-green-950/40 border border-green-500/25 px-2 py-1.5">
                      <p className="text-[10px] text-green-300/80 uppercase">Ingresos</p>
                      <p className="font-bold text-green-400">{fmt(u.cobrado)}</p>
                    </div>
                    <div className="rounded-lg bg-orange-950/40 border border-orange-500/25 px-2 py-1.5">
                      <p className="text-[10px] text-orange-300/80 uppercase">Egresos</p>
                      <p className="font-bold text-orange-400">{fmt(u.gastos)}</p>
                    </div>
                    <div className="rounded-lg bg-amber-950/40 border border-amber-500/25 px-2 py-1.5">
                      <p className="text-[10px] text-amber-300/80 uppercase">Neto</p>
                      <p className={`font-bold ${u.neto < 0 ? 'text-red-400' : 'text-amber-300'}`}>{fmt(u.neto)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {resumenCajaMarcosDia.corteActivo && (
              <p className="text-[11px] text-violet-300/80 text-center">
                Último cierre de día Marcos: {new Date(resumenCajaMarcosDia.corteActivo).toLocaleString('es-AR')}
              </p>
            )}

            <div className="bg-gradient-to-br from-sky-950/70 via-gray-900/80 to-violet-950/50 border-2 border-sky-400/45 rounded-2xl p-6 text-center shadow-lg shadow-sky-900/20">
              <p className="text-sm text-sky-200/90 font-semibold tracking-wide uppercase">Total Caja</p>
              <p className={`text-4xl font-black mt-2 ${resumenCajaPropia.saldo < 0 ? 'text-red-400' : 'text-sky-100'}`}>
                {fmt(resumenCajaPropia.saldo)}
              </p>
              <p className="text-[11px] text-gray-400 mt-2">Saldo disponible en caja propia</p>
            </div>

            <div className="bg-gray-900/60 border border-violet-500/40 rounded-2xl p-4 space-y-4">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setFormMovCajaPropia(f => ({ ...f, tipo: 'entrada', monto: '' }))}
                  className={`rounded-xl py-3 text-xs sm:text-sm font-bold border transition ${
                    formMovCajaPropia.tipo === 'entrada'
                      ? 'bg-green-600/90 border-green-400 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400'
                  }`}
                >
                  Ingreso de Caja
                </button>
                <button
                  type="button"
                  onClick={() => setFormMovCajaPropia(f => ({ ...f, tipo: 'salida', monto: '' }))}
                  className={`rounded-xl py-3 text-xs sm:text-sm font-bold border transition ${
                    formMovCajaPropia.tipo === 'salida'
                      ? 'bg-orange-600/90 border-orange-400 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400'
                  }`}
                >
                  Egreso de Caja
                </button>
                <button
                  type="button"
                  disabled={
                    guardandoBorrarCajaPropia ||
                    guardandoMovCajaPropia ||
                    resumenCajaPropia.saldo <= 0
                  }
                  onClick={() => void handleDejarCajaPropiaEnCero()}
                  className="rounded-xl py-3 text-xs sm:text-sm font-bold border border-red-500/50 bg-red-950/50 hover:bg-red-950/70 text-red-200 disabled:opacity-50 active:scale-95 transition"
                >
                  {guardandoBorrarCajaPropia ? 'Caja a $0…' : 'Caja a $0'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">
                    Monto {formMovCajaPropia.tipo === 'entrada' ? 'ingreso' : 'egreso'} ($)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={formMovCajaPropia.monto}
                    onChange={e => setFormMovCajaPropia(f => ({ ...f, monto: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Fecha</label>
                  <input
                    type="date"
                    value={formMovCajaPropia.fecha}
                    onChange={e => setFormMovCajaPropia(f => ({ ...f, fecha: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                  />
                </div>
              </div>
              <input
                value={formMovCajaPropia.nota}
                onChange={e => setFormMovCajaPropia(f => ({ ...f, nota: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                placeholder="Nota opcional"
              />
              <button
                type="button"
                disabled={
                  guardandoMovCajaPropia ||
                  guardandoBorrarCajaPropia ||
                  (formMovCajaPropia.tipo === 'salida' &&
                    resumenCajaPropia.saldo < redondearPesos(Number(formMovCajaPropia.monto) || 0))
                }
                onClick={() => void handleRegistrarMovimientoCajaPropia()}
                className={`w-full disabled:opacity-50 text-white rounded-xl py-3 text-sm font-bold active:scale-95 transition ${
                  formMovCajaPropia.tipo === 'entrada' ? 'bg-violet-600' : 'bg-orange-600'
                }`}
              >
                {guardandoMovCajaPropia
                  ? 'Registrando…'
                  : formMovCajaPropia.tipo === 'entrada'
                    ? 'Registrar ingreso de caja'
                    : 'Registrar egreso de caja'}
              </button>
            </div>

            {solicitudesFondoPendientesAdmin.length > 0 && (
            <div className="bg-gray-900/60 border border-amber-500/40 rounded-2xl p-4 space-y-3">
              <div>
                <h3 className="font-bold text-sm text-amber-200">💰 Habilitar créditos (desde caja propia)</h3>
                <p className="text-xs text-gray-400 mt-1">
                  Créditos pendientes de aprobación sin recaudado previo. Al confirmar, egresa de caja propia e ingresa al cobrador.
                </p>
                <p className="text-xs text-violet-300/90 mt-2">Saldo caja propia: <strong>{fmt(resumenCajaPropia.saldo)}</strong></p>
              </div>
              {solicitudesFondoPendientesAdmin.map(sol => {
                const cliSol = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(sol.cliente_id));
                const nombreCliSol = nombreCompletoCliente(cliSol) || 'Cliente';
                const sinSaldo = resumenCajaPropia.saldo < sol.monto;
                return (
                  <div key={sol.id} className="bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 space-y-2">
                    <div className="flex flex-wrap justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-white truncate">{nombreCliSol}</p>
                        <p className="text-xs text-gray-400">
                          {sol.solicitante_nombre || etiquetaCobradorMovimiento(sol.cobrador_id)} · {new Date(sol.created_at).toLocaleString('es-AR')}
                        </p>
                      </div>
                      <p className="text-lg font-black text-amber-300 shrink-0">{fmt(sol.monto)}</p>
                    </div>
                    <p className="text-[11px] text-amber-100/80">
                      El cobrador verá: «{descripcionIngresoMarcosCredito(nombreCliSol)}».
                    </p>
                    {sinSaldo && (
                      <p className="text-[11px] text-red-300">Saldo caja propia insuficiente. Registrá un ingreso propio en la sección de arriba.</p>
                    )}
                    <button
                      type="button"
                      disabled={guardandoFondoCreditoId != null || sinSaldo}
                      onClick={() => void handleRegistrarIngresoFondoCredito(sol)}
                      className="w-full bg-amber-600 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-bold active:scale-95 transition"
                    >
                      {guardandoFondoCreditoId === sol.id ? 'Registrando…' : `Habilitar desde caja propia (${fmt(sol.monto)})`}
                    </button>
                  </div>
                );
              })}
            </div>
            )}

            <div className="bg-gray-900/60 border border-sky-500/35 rounded-2xl p-4 space-y-4">
              <div>
                <h3 className="font-bold text-sm text-sky-200">💵 Ingresos externos de dinero</h3>
                <p className="text-xs text-gray-400 mt-1">
                  Capital de proveedores/inversores. Tasa {TASA_INVERSION_PROVEEDOR}% a {PLAZO_INVERSION_PROVEEDOR_DIAS} días. Al agregar uno se genera usuario y contraseña automáticamente.
                </p>
              </div>
              <div className="space-y-2">
                <label className="text-xs text-gray-400 block">Proveedor</label>
                <div className="flex gap-2">
                  <select
                    value={formIngresoExt.proveedorId}
                    onChange={e => setFormIngresoExt(f => ({ ...f, proveedorId: e.target.value }))}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                  >
                    <option value="">— Seleccionar —</option>
                    {proveedores.map(p => (
                      <option key={p.id} value={p.id}>{p.nombre} ({p.login})</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setMNuevoProveedor(true)}
                    className="shrink-0 bg-sky-600 text-white rounded-xl px-3 py-2 text-xs font-bold active:scale-95 transition"
                  >
                    + Agregar
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Monto ($)</label>
                  <input
                    type="number"
                    min={1}
                    value={formIngresoExt.monto}
                    onChange={e => setFormIngresoExt(f => ({ ...f, monto: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Fecha ingreso</label>
                  <input
                    type="date"
                    value={formIngresoExt.fecha}
                    onChange={e => setFormIngresoExt(f => ({ ...f, fecha: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                  />
                </div>
              </div>
              <input
                value={formIngresoExt.nota}
                onChange={e => setFormIngresoExt(f => ({ ...f, nota: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                placeholder="Nota opcional"
              />
              {formIngresoExt.monto && Number(formIngresoExt.monto) > 0 && (
                <div className="text-xs text-sky-200/90 bg-sky-500/10 border border-sky-500/20 rounded-xl p-3">
                  {(() => {
                    const c = calcularMontosInversion(Number(formIngresoExt.monto), formIngresoExt.fecha || hoy());
                    return (
                      <>
                        Interés estimado: <strong>{fmt(c.interes)}</strong> · Total a devolver: <strong>{fmt(c.total)}</strong> · Vence: {c.fechaVencimiento}
                      </>
                    );
                  })()}
                </div>
              )}
              <button
                type="button"
                disabled={guardandoIngresoExt}
                onClick={() => void handleRegistrarIngresoExterno()}
                className="w-full bg-sky-600 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-bold active:scale-95 transition"
              >
                {guardandoIngresoExt ? 'Registrando…' : 'Registrar ingreso en caja'}
              </button>
              {inversionesExternasAdmin.length > 0 && (
                <div className="pt-2 border-t border-gray-800 space-y-2 max-h-48 overflow-y-auto">
                  <p className="text-xs text-gray-500 font-semibold">Inversiones activas</p>
                  {inversionesExternasAdmin.map(inv => (
                    <div key={inv.id} className="flex justify-between gap-2 text-xs bg-gray-800/50 rounded-lg p-2">
                      <span className="text-gray-300 truncate">{inv.proveedor?.nombre ?? 'Proveedor'}</span>
                      <span className="text-sky-300 shrink-0">{fmt(inv.monto)} → {fmt(inv.monto_total_devolver)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* PANEL PROVEEDOR / INVERSOR */}
        {page === 'mi_inversion' && esProveedorUsuario && (
          <div className="space-y-4 max-w-lg mx-auto">
            <div className="text-center pt-2">
              <h2 className="text-xl font-bold text-white">Mi inversión</h2>
              <p className="text-xs text-gray-400 mt-1">Capital ingresado por el administrador · {TASA_INVERSION_PROVEEDOR}% en {PLAZO_INVERSION_PROVEEDOR_DIAS} días</p>
            </div>
            {misInversionesProveedor.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-12">Todavía no hay inversiones registradas a tu nombre.</p>
            )}
            {misInversionesProveedor.map(inv => {
              const diasRest = diasRestantesInversion(inv.fecha_vencimiento);
              const vencido = diasRest < 0;
              return (
                <div key={inv.id} className="bg-gradient-to-br from-teal-900/40 to-gray-900/80 border border-teal-500/30 rounded-2xl p-5 space-y-4">
                  <div>
                    <p className="text-xs text-teal-200/70">Capital invertido</p>
                    <p className="text-3xl font-black text-white">{fmt(inv.monto)}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-gray-500 text-xs">Fecha de entrada</p>
                      <p className="font-semibold text-gray-200">{inv.fecha_ingreso}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-xs">Vencimiento</p>
                      <p className="font-semibold text-gray-200">{inv.fecha_vencimiento}</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-xs">Tasa / plazo</p>
                      <p className="font-semibold text-gray-200">{inv.tasa_interes}% · {inv.plazo_dias} días</p>
                    </div>
                    <div>
                      <p className="text-gray-500 text-xs">{vencido ? 'Plazo cumplido' : 'Días restantes'}</p>
                      <p className={`font-semibold ${vencido ? 'text-amber-300' : 'text-teal-300'}`}>
                        {vencido ? 'Vencido' : `${diasRest} días`}
                      </p>
                    </div>
                  </div>
                  <div className="bg-teal-500/10 border border-teal-500/25 rounded-xl p-4">
                    <p className="text-xs text-teal-200/80">Total a recibir (capital + interés)</p>
                    <p className="text-2xl font-black text-teal-300">{fmt(inv.monto_total_devolver)}</p>
                    <p className="text-xs text-gray-400 mt-1">Incluye interés de {fmt(inv.monto_interes)}</p>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => void doLogout()}
              className="w-full bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl py-3 text-sm font-semibold active:scale-95 transition"
            >
              Cerrar sesión
            </button>
          </div>
        )}

        {/* RENDICIONES (ADMIN) */}
        {page === 'rendiciones' && esMarcosPUsuario && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold">📑 Rendiciones pendientes</h2>
              <p className="text-xs text-gray-400">Aceptá cada cierre de caja. El neto ingresa a caja propia; el usuario queda en pendiente hasta la recepción y liberado tras las 00:00.</p>
            </div>
            <div className="flex rounded-xl overflow-hidden border border-gray-700">
              <button
                type="button"
                onClick={() => setSubTabRendicion('pendientes')}
                className={`flex-1 py-2.5 text-sm font-semibold transition ${subTabRendicion === 'pendientes' ? 'bg-amber-500/25 text-amber-200' : 'bg-gray-800 text-gray-400'}`}
              >
                Pendientes ({rendicionesPendientesAdmin.length})
              </button>
              <button
                type="button"
                onClick={() => setSubTabRendicion('historial')}
                className={`flex-1 py-2.5 text-sm font-semibold transition ${subTabRendicion === 'historial' ? 'bg-emerald-500/25 text-emerald-200' : 'bg-gray-800 text-gray-400'}`}
              >
                Historial de cajas
              </button>
            </div>
            {subTabRendicion === 'pendientes' && (
              <div className="space-y-3">
                {rendicionesPendientesAdmin.length === 0 && (
                  <p className="text-sm text-gray-500 text-center py-10">No hay rendiciones esperando validación.</p>
                )}
                {rendicionesPendientesAdmin.map(c => (
                  <div key={c.id} className="bg-gray-900/70 border border-amber-500/30 rounded-2xl p-4 space-y-3">
                    <div>
                      <p className="font-bold text-white">{etiquetaCobradorMovimiento(c.username || c.userId) || 'Cobrador'}</p>
                      <p className="text-xs text-gray-500">Jornada {c.fecha}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><p className="text-gray-500 text-xs">Cobró</p><p className="font-semibold text-emerald-400">{fmt(c.totalSistema)}</p></div>
                      <div><p className="text-gray-500 text-xs">Gastó</p><p className="font-semibold text-orange-300">{fmt(c.totalGastos ?? 0)}</p></div>
                      <div className="col-span-2"><p className="text-gray-500 text-xs">Neto a entregar (físico esperado)</p><p className="font-black text-lg text-sky-300">{fmt(c.netoEntregar ?? c.totalSistema)}</p></div>
                      <div><p className="text-gray-500 text-xs">Declaró en mano</p><p className="font-semibold text-white">{fmt(c.montoFisico)}</p></div>
                      <div><p className="text-gray-500 text-xs">Diferencia</p><p className={`font-semibold ${c.diferencia === 0 ? 'text-green-400' : 'text-amber-300'}`}>{fmt(c.diferencia)}</p></div>
                    </div>
                    {!!c.novedades?.trim() && <p className="text-xs text-gray-400 bg-gray-800/60 rounded-lg p-2">{c.novedades}</p>}
                    <button
                      type="button"
                      onClick={() => {
                        const neto = c.netoEntregar ?? redondearPesos(c.totalSistema - (c.totalGastos ?? 0));
                        if (!confirm(`¿Recibir rendición de ${etiquetaCobradorMovimiento(c.username || c.userId) || 'este usuario'}? Ingresan ${fmt(neto)} a caja propia.`)) return;
                        void handleAceptarRendicion(c);
                      }}
                      className="w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded-xl active:scale-[0.99] transition"
                    >
                      Recibir en caja propia
                    </button>
                  </div>
                ))}
              </div>
            )}
            {subTabRendicion === 'historial' && (
              <div className="overflow-x-auto rounded-xl border border-gray-800">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-800 text-gray-300">
                      <th className="p-2 text-left">Fecha jornada</th>
                      <th className="p-2 text-left">Cobrador</th>
                      <th className="p-2 text-right">Ingreso caja central</th>
                      <th className="p-2 text-left">Fecha / hora aceptación</th>
                      <th className="p-2 text-left">Validó</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historialRendicionesAdmin.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-4 text-center text-gray-500">Sin registros aún.</td>
                      </tr>
                    )}
                    {historialRendicionesAdmin.map(c => (
                      <tr key={c.id} className="border-t border-gray-800">
                        <td className="p-2 whitespace-nowrap">{c.fecha}</td>
                        <td className="p-2">{etiquetaCobradorMovimiento(c.username || c.userId)}</td>
                        <td className="p-2 text-right font-semibold text-emerald-400">{fmt(c.ingresoCajaCentral ?? c.netoEntregar ?? 0)}</td>
                        <td className="p-2 whitespace-nowrap">{c.validadoAt ? new Date(c.validadoAt).toLocaleString('es-AR') : '—'}</td>
                        <td className="p-2 text-gray-400">{etiquetaCobradorMovimiento(c.validadoPor || '') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* GASTOS */}
        {page === 'cheques' && !esProveedorUsuario && !esUsuarioRootOperadorSesion && (
          <VistaCheques
            esMarcosOperador={esMarcosOperadorSesion}
            esAdminCheques={esMarcosPUsuario}
            actorLabel={actorChequesSesion}
          />
        )}

        {page === 'gastos' && esMarcosPUsuario && (
          <div className="space-y-3">
            {/* Resumen */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 text-center">
                <p className="text-xs text-gray-400">Gastos Mes</p>
                <p className="text-xl font-bold text-red-400">{fmt((Array.isArray(gastos) ? gastos : []).reduce((s, g) => s + (Number(g?.monto) || 0), 0))}</p>
              </div>
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 text-center">
                <p className="text-xs text-gray-400">Ganancia Neta</p>
                <p className="text-xl font-bold text-green-400">{fmt(kpis.totalCobradoHoy - kpis.totalGastosHoy)}</p>
              </div>
            </div>

            <button onClick={() => setMGasto({})}
              className="w-full bg-orange-500 text-white rounded-2xl py-4 font-bold flex items-center justify-center gap-2 active:scale-95 transition-all">
              + Registrar Gasto
            </button>

            {(Array.isArray(gastos) ? gastos : []).filter(g => g && g.fecha === hoy()).map(g => (
              <div key={g.id} className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{g.categoria === 'Combustible' ? '⛽' : g.categoria === 'Comida' ? '🍔' : g.categoria === 'Reparaciones' ? '🔧' : '📦'}</span>
                  <div>
                    <p className="font-semibold text-sm">{g.categoria}</p>
                    <p className="text-xs text-gray-400">{g.nota || g.fecha}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-red-400">{fmt(Number(g?.monto) || 0)}</span>
                  {esMarcosPUsuario && (
                    <button onClick={() => handleDeleteGasto(g.id)} className="text-red-400/60 text-xs">🗑️</button>
                  )}
                </div>
              </div>
            ))}
            {(Array.isArray(gastos) ? gastos : []).filter(g => g && g.fecha === hoy()).length === 0 && <div className="text-center py-8 text-gray-500 text-sm">Sin gastos hoy</div>}
          </div>
        )}

        {page === 'panel_control' && esMarcosPUsuario && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold">🧭 Panel de Control</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
                <p className="text-xs text-gray-400">Ingresos campo (hoy)</p>
                <p className="text-2xl font-bold text-green-400">{fmt(panelControlStats.cobradoHoy)}</p>
              </div>
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
                <p className="text-xs text-gray-400">Egresos campo (hoy)</p>
                <p className="text-2xl font-bold text-orange-400">{fmt(panelControlStats.gastosCampoHoy)}</p>
              </div>
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 col-span-2 sm:col-span-1">
                <p className="text-xs text-gray-400">Cobrado acumulado</p>
                <p className={`text-2xl font-bold ${panelControlStats.netoCampoHoy < 0 ? 'text-red-400' : 'text-amber-300'}`}>
                  {fmt(panelControlStats.netoCampoHoy)}
                </p>
              </div>
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
                <p className="text-xs text-gray-400">Total a cobrar hoy</p>
                <p className="text-2xl font-bold text-indigo-300">{fmt(panelControlStats.totalACobrarHoy)}</p>
              </div>
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
                <p className="text-xs text-gray-400">Efectividad diaria</p>
                <p className="text-2xl font-bold text-blue-400">{panelControlStats.efectividad.toFixed(1)}%</p>
                <p className="text-[10px] text-gray-500 mt-1">Ingresos campo ÷ total a cobrar</p>
              </div>
            </div>
            <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-2 max-h-[420px] overflow-y-auto">
              <h3 className="font-semibold sticky top-0 bg-gray-900/95 py-1 z-10">Movimientos de caja (todos los usuarios)</h3>
              <p className="text-[11px] text-gray-500">Cobros, gastos y entregas de crédito en tiempo real.</p>
              {feedMovimientosControl.length === 0 && (
                <p className="text-sm text-gray-500 py-4">Sin movimientos registrados.</p>
              )}
              {feedMovimientosControl.map(m => (
                <div
                  key={m.id}
                  className={`flex items-start justify-between gap-2 rounded-xl px-3 py-2 border ${
                    m.tipo === 'entrada'
                      ? 'bg-green-950/30 border-green-500/25'
                      : 'bg-orange-950/25 border-orange-500/25'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-white truncate">{m.descripcion}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {etiquetaCobradorMovimiento(m.cobradorId)} · {new Date(m.ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <p className={`shrink-0 text-sm font-bold ${m.tipo === 'entrada' ? 'text-green-400' : 'text-orange-400'}`}>
                    {m.tipo === 'entrada' ? '+' : '−'}{fmt(m.monto)}
                  </p>
                </div>
              ))}
            </div>
            <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-3">
              <h3 className="font-semibold">Control por cobrador</h3>
              {panelControlStats.porCobrador.length === 0 && <p className="text-sm text-gray-500">Sin actividad ni cuotas a cobrar hoy.</p>}
              {panelControlStats.porCobrador.map(item => (
                <div key={item.cobrador} className="bg-gray-800/60 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-sm font-semibold truncate">{etiquetaCobradorMovimiento(item.cobrador)}</p>
                    <p className="text-[11px] text-gray-500">{etiquetaRolUsuario(item.cobrador)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Ingresos</p>
                    <p className="font-semibold text-green-400">{fmt(item.totalCobrado)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Egresos</p>
                    <p className="font-semibold text-orange-400">{fmt(item.gastos)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Neto campo</p>
                    <p className={`font-semibold ${item.totalCobrado - item.gastos < 0 ? 'text-red-400' : 'text-amber-300'}`}>
                      {fmt(redondearPesos(item.totalCobrado - item.gastos))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">A cobrar hoy</p>
                    <p className="font-semibold text-indigo-300">{fmt(item.totalACobrar)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Efectividad</p>
                    <p className="font-semibold text-blue-400">{item.efectividad.toFixed(1)}%</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* CREDITOS */}
        {page === 'creditos' && (() => {
          const creditosLista = esUsuarioMensualUsuario
            ? creditosOrEmpty.filter(c => esUuidClienteId(String(c.cliente_id ?? '')))
            : filtroPendientesCredito === 'pendientes'
              ? creditosPendientesValidos
              : creditosProcesadosValidos;
          return (
            <>
              <div className="space-y-4">
                <h2 className="text-lg font-bold">{esUsuarioMensualUsuario ? '🏦 Préstamos mensuales' : '🏦 Créditos'}</h2>
                <p className="text-sm text-gray-400">
                  {esUsuarioMensualUsuario
                    ? 'Alta directa de préstamos con plan mensual (activos al guardar).'
                    : 'Solicitudes nuevas sincronizadas con la tabla real de créditos.'}
                </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {esUsuarioMensualUsuario ? (
                <button onClick={() => setMCreditoTipo('P')} className="w-full sm:col-span-2 bg-gradient-to-r from-teal-600 to-cyan-600 text-white rounded-2xl py-4 font-bold active:scale-95 transition-all">
                  + Nuevo préstamo mensual
                </button>
              ) : (
                <>
              <button onClick={() => setMCreditoTipo('M')} className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white rounded-2xl py-4 font-bold active:scale-95 transition-all">
                Nuevo Crédito M
              </button>
              <button onClick={() => setMCreditoTipo('P')} className="w-full bg-gradient-to-r from-orange-500 to-yellow-500 text-white rounded-2xl py-4 font-bold active:scale-95 transition-all">
                Nuevo Crédito P
              </button>
                </>
              )}
            </div>
            <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{esUsuarioMensualUsuario ? 'Préstamos' : 'Solicitudes'}</h3>
                {!esUsuarioMensualUsuario && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setFiltroPendientesCredito('pendientes')} className={`px-2 py-1 rounded-lg text-xs ${filtroPendientesCredito === 'pendientes' ? 'bg-indigo-500 text-white' : 'bg-gray-800 text-gray-300'}`}>Pendientes</button>
                  <button type="button" onClick={() => setFiltroPendientesCredito('procesados')} className={`px-2 py-1 rounded-lg text-xs ${filtroPendientesCredito === 'procesados' ? 'bg-indigo-500 text-white' : 'bg-gray-800 text-gray-300'}`}>Procesados</button>
                </div>
                )}
              </div>
              {creditosLista.length === 0 && (
                <p className="text-sm text-gray-500">{esUsuarioMensualUsuario ? 'No hay préstamos mensuales cargados.' : filtroPendientesCredito === 'pendientes' ? 'No hay solicitudes pendientes con cliente válido.' : 'No hay créditos procesados con cliente válido.'}</p>
              )}
              {creditosLista.map(credito => {
                const cli = clientesOrEmpty.find(c => normalizarId(c.id) === normalizarId(credito.cliente_id));
                const estado = String(credito.estado || '').trim().toUpperCase();
                const estadoLista = estado === 'PENDIENTE_APROBACION' ? 'Pendiente aprobación' : estado;
                const esProcesado = estado === 'ACTIVO' || estado === 'RECHAZADO' || estado === 'FINALIZADO';
                return (
                  <div key={credito.id} className="bg-gray-800/60 rounded-xl p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{nombreCompletoCliente(cli) || credito.cliente_id}</p>
                      <p className="text-xs text-gray-400">Estado: {estadoLista} · Total: {fmt(Number(credito.monto_total ?? credito.total_con_interes) || 0)}</p>
                      <p className="text-[11px] text-gray-500">Cliente ID: {credito.cliente_id}</p>
                    </div>
                    {esMarcosPUsuario && (
                      <div className="shrink-0 flex flex-col gap-1.5">
                        <button
                          type="button"
                          onClick={() => setMCreditoRevision(credito)}
                          className={`rounded-lg px-3 py-2 text-xs font-semibold active:scale-95 transition ${
                            esProcesado ? 'bg-gray-700 text-gray-200' : 'bg-green-500 text-white'
                          }`}
                        >
                          {esProcesado ? 'Ver Detalles' : 'Aprobar'}
                        </button>
                        <button
                          type="button"
                          disabled={eliminandoCreditoId === credito.id}
                          onClick={() => void handleEliminarCreditoCompleto(credito)}
                          className="rounded-lg px-3 py-2 text-[10px] font-bold bg-red-600/90 text-white disabled:opacity-50 active:scale-95 transition"
                        >
                          {eliminandoCreditoId === credito.id ? '…' : 'Eliminar'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          </>
        );
      })()}

        {/* RUTA — pestañas Por cobrar / Cobrado + historial por fecha */}
        {page === 'ruta' && (() => {
          const listaRutaMostrada = subTabRuta === 'por_cobrar' ? rutaPorCobrarItemsLista : rutaCobradoItems;
          const hoyStr = hoy();
          const puedeRegistrarPagoEnLista = subTabRuta === 'por_cobrar';
          const esTabCobrado = subTabRuta === 'cobrado';
          return (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold">🗺️ Hoja de Ruta</h2>
                <p className="text-xs text-gray-400 mt-0.5">Activos en ruta · {hoyStr}</p>
              </div>
              <button type="button" onClick={optimizarRuta} disabled={ordenandoRuta} className="shrink-0 text-sm text-blue-400 font-semibold active:scale-95 transition disabled:opacity-50">
                {ordenandoRuta ? '⏳…' : '📍 Mapa'}
              </button>
            </div>
            <div className="flex rounded-xl border border-gray-700/90 bg-gray-900/80 p-0.5">
              <button
                type="button"
                onClick={() => setSubTabRuta('por_cobrar')}
                className={`relative flex-1 rounded-lg py-2.5 text-center text-xs font-bold transition ${
                  subTabRuta === 'por_cobrar'
                    ? 'bg-amber-500/25 text-amber-100 shadow-inner ring-1 ring-amber-500/40'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Por cobrar
                <span className="ml-1 inline-block min-w-[1.25rem] rounded-full bg-gray-800 px-1 text-[10px] text-gray-300">{rutaPorCobrarItemsLista.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTabRuta('cobrado')}
                className={`relative flex-1 rounded-lg py-2.5 text-center text-xs font-bold transition ${
                  subTabRuta === 'cobrado'
                    ? 'bg-emerald-600/25 text-emerald-100 shadow-inner ring-1 ring-emerald-500/40'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                Cobrado
                <span className="ml-1 inline-block min-w-[1.25rem] rounded-full bg-gray-800 px-1 text-[10px] text-gray-300">{rutaCobradoItems.length}</span>
              </button>
            </div>
            <div className="rounded-2xl border border-emerald-500/35 bg-emerald-950/30 px-4 py-3">
              <p className="text-sm font-bold text-emerald-100">
                {subTabRuta === 'por_cobrar' ? (
                  <>
                    Pendientes de visita (amarillo): <span className="text-white">{rutaPorCobrarItemsLista.length}</span>
                    {' · '}
                    Con atraso en esta lista: <span className="text-white">{rutaPorCobrarItemsLista.filter(x => x.tieneAtraso).length}</span>
                  </>
                ) : (
                  <>
                    Gestión del <span className="text-white">{rutaHistorialFecha === hoyStr ? 'día de hoy' : rutaHistorialFecha}</span>
                    : <span className="text-white">{rutaCobradoItems.filter(x => x.semaforo === 'verde').length}</span> pago(s)
                    {' · '}
                    <span className="text-white">{rutaCobradoItems.filter(x => x.semaforo === 'rojo').length}</span> no pago(s)
                  </>
                )}
              </p>
              <p className="text-[11px] text-emerald-200/70 mt-1">
                {subTabRuta === 'por_cobrar'
                  ? (rutaBloqueadaPorCierreHoy
                    ? 'Día cerrado con cierre de caja: la lista Por cobrar queda vacía hasta mañana para evitar duplicaciones.'
                    : (posicionRutaCobrador
                      ? 'Solo clientes sin visita ni cobro hoy · orden por cercanía GPS'
                      : 'Solo pendientes de visita hoy · sin GPS: orden admin / nombre'))
                  : 'Solo lectura y auditoría: tocá un cliente para ver detalle, comprobante y GPS del registro. Cambiá la fecha para revisar días anteriores sin poder modificarlos.'}
              </p>
            </div>
            {subTabRuta === 'cobrado' && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-700/80 bg-gray-900/50 px-3 py-2.5">
                <label className="flex flex-wrap items-center gap-2 text-xs font-semibold text-gray-300">
                  <span className="text-gray-400">Fecha</span>
                  <input
                    type="date"
                    value={rutaHistorialFecha}
                    onChange={e => setRutaHistorialFecha(String(e.target.value || hoyStr).slice(0, 10))}
                    className="rounded-lg border border-gray-600 bg-gray-950 px-2 py-1.5 text-sm text-white"
                  />
                </label>
                <p className="text-[11px] text-gray-400">No se pueden imputar cobros ni «No pago» desde esta pestaña.</p>
              </div>
            )}
            {listaRutaMostrada.length === 0 ? (
              <div className="text-center py-12 text-gray-500 rounded-2xl border border-gray-800 bg-gray-900/40">
                <p className="text-4xl mb-3">{subTabRuta === 'por_cobrar' ? (rutaBloqueadaPorCierreHoy ? '🔒' : '✅') : '📋'}</p>
                <p className="font-semibold text-gray-300">
                  {subTabRuta === 'por_cobrar'
                    ? (rutaBloqueadaPorCierreHoy ? 'Por cobrar bloqueado (día cerrado)' : 'Nadie pendiente por visitar hoy')
                    : 'Sin movimientos en esta fecha'}
                </p>
                <p className="text-xs mt-2 px-4 leading-relaxed">
                  {subTabRuta === 'por_cobrar'
                    ? (rutaBloqueadaPorCierreHoy
                      ? 'Ya registraste el cierre de caja del día. La hoja de ruta no muestra pendientes hasta el próximo día calendario.'
                      : 'Todos los clientes de tu ruta ya fueron visitados o cobrados hoy, o no hay créditos ACTIVO en ruta.')
                    : 'No hubo pagos efectivos ni visitas sin cobro registradas para el día seleccionado.'}
                </p>
              </div>
            ) : (
              listaRutaMostrada.map((item, i) => {
                const {
                  cliente: cli,
                  filas,
                  distancia,
                  tieneAtraso,
                  etiquetasPlan,
                  semaforo,
                  saldoTotalDeuda,
                } = item;
                const captacionSolo = Boolean(item.esRutaCaptacionSinCreditoReal);
                const idCredSel = rutaCreditoElegidoPorCliente[cli.id] ?? item.creditoCobrar.id;
                const filaAct = filas.find(f => f.credito.id === idCredSel) ?? filas[0];
                const planLenAct = generarPlanillaCredito(filaAct.credito).length;
                const peAct = pagosEfectivosCredito(pagosOrEmpty, filaAct.credito.id);
                const sigNAct = filaAct.resumen.siguienteCuotaNro ?? Math.min(peAct.length + 1, planLenAct);
                const cuotasTxtAct = captacionSolo ? item.cuotasTexto : `Cuota ${sigNAct} de ${planLenAct}`;
                const montoPendAct = filaAct.resumen.montoPendienteVtoHastaHoy;
                const marcarAtraso = tieneAtraso;
                const expandido = rutaClienteExpandidoId === cli.id;
                const esFechaHistorialLista = subTabRuta === 'cobrado' && rutaHistorialFecha !== hoyStr;
                const semTitulo = semaforo === 'amarillo'
                  ? 'Pendiente de visita (prioridad ruta)'
                  : semaforo === 'rojo'
                    ? (esFechaHistorialLista ? `No pago el ${rutaHistorialFecha}` : 'No pago hoy — reintento después')
                    : (esFechaHistorialLista ? `Pago imputado el ${rutaHistorialFecha}` : 'Pago imputado hoy');
                const tagClase = (tag: string) =>
                  (tag === 'DIARIO'
                    ? 'bg-blue-600 text-white border-blue-400/50'
                    : tag === 'SEMANAL'
                      ? 'bg-violet-600 text-white border-violet-400/50'
                      : 'bg-teal-600 text-white border-teal-400/50');
                const mostrarColDer = saldoTotalDeuda > 0
                  || (distancia != null && Number.isFinite(distancia))
                  || (cli.orden_ruta != null && Number.isFinite(Number(cli.orden_ruta)) && !posicionRutaCobrador)
                  || captacionSolo;
                return (
                  <div
                    key={cli.id}
                    role={esTabCobrado ? 'button' : undefined}
                    tabIndex={esTabCobrado ? 0 : undefined}
                    onClick={() => {
                      if (!esTabCobrado) return;
                      setMRutaCobradoAuditoria({
                        cliente: cli,
                        filas,
                        fecha: rutaHistorialFecha,
                        semaforo: semaforo === 'verde' ? 'verde' : 'rojo',
                      });
                    }}
                    onKeyDown={e => {
                      if (!esTabCobrado) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setMRutaCobradoAuditoria({
                          cliente: cli,
                          filas,
                          fecha: rutaHistorialFecha,
                          semaforo: semaforo === 'verde' ? 'verde' : 'rojo',
                        });
                      }
                    }}
                    className={`relative rounded-2xl p-4 pt-9 border transition-all ${marcarAtraso
                      ? 'bg-gradient-to-br from-red-950/40 via-gray-900/80 to-gray-900/75 border-red-500/45 shadow-lg shadow-red-950/20'
                      : 'bg-gradient-to-br from-amber-500/18 via-emerald-900/25 to-gray-900/75 border-amber-400/40 shadow-lg shadow-black/25'
                    } ${esTabCobrado ? 'cursor-pointer hover:border-cyan-500/45 hover:ring-1 hover:ring-cyan-500/25' : ''}`}
                  >
                    <div className="absolute top-2 left-3 z-10 flex max-w-[88%] flex-wrap gap-1">
                      {etiquetasPlan.map(tag => (
                        <span
                          key={tag}
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tagClase(tag)}`}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    {captacionSolo && (
                      <p className="mx-3 mt-8 rounded-lg border border-cyan-500/35 bg-cyan-950/40 px-2 py-1.5 text-[11px] font-semibold text-cyan-100/95">
                        Pendiente de visita (jornada actual): alta del día con GPS. Activá un crédito ACTIVO para cobrar desde esta lista.
                      </p>
                    )}
                    <div className="flex items-start gap-3">
                      <div className="flex shrink-0 flex-col items-center gap-1 pt-1" title={semTitulo}>
                        <div
                          className={`h-4 w-4 shrink-0 rounded-full ring-2 ring-white/25 ${
                            semaforo === 'rojo'
                              ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.55)]'
                              : semaforo === 'amarillo'
                                ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.45)]'
                                : 'bg-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.45)]'
                          }`}
                        />
                        <span className="text-[10px] font-bold leading-none text-gray-500">{i + 1}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        {esTabCobrado ? (
                          <div className="w-full text-left">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-bold text-white">{nombreCompletoCliente(cli) ?? '—'}</p>
                              {marcarAtraso && (
                                <span className="rounded-full border border-red-400/60 bg-red-600/85 px-2 py-0.5 text-[10px] font-bold uppercase text-white shadow-sm">ATRASADO</span>
                              )}
                              {filas.length > 1 && (
                                <span className="text-[10px] font-semibold text-gray-500">{filas.length} créditos en ruta</span>
                              )}
                              <span className="text-[10px] font-semibold text-cyan-400/90">Tocá para auditoría</span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-gray-300">{cli?.direccion}</p>
                            <p
                              className={`mt-1 text-xs font-bold ${
                                filaAct.resumen.cuotasDeAtraso > 0 ? 'text-red-600' : 'text-gray-500'
                              }`}
                            >
                              Cuotas de atraso: {filaAct.resumen.cuotasDeAtraso}
                            </p>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={`w-full text-left ${filas.length > 1 ? 'cursor-pointer' : 'cursor-default'}`}
                            onClick={() => {
                              if (filas.length <= 1) return;
                              setRutaClienteExpandidoId(prev => {
                                const next = prev === cli.id ? null : cli.id;
                                if (next === cli.id) {
                                  setRutaCreditoElegidoPorCliente(r => ({
                                    ...r,
                                    [cli.id]: r[cli.id] ?? item.creditoCobrar.id,
                                  }));
                                }
                                return next;
                              });
                            }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-bold text-white">{nombreCompletoCliente(cli) ?? '—'}</p>
                              {marcarAtraso && (
                                <span className="rounded-full border border-red-400/60 bg-red-600/85 px-2 py-0.5 text-[10px] font-bold uppercase text-white shadow-sm">ATRASADO</span>
                              )}
                              {filas.length > 1 && (
                                <span className="text-[10px] font-semibold text-cyan-300">
                                  {expandido ? '▲' : '▼'} {filas.length} créditos
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-xs text-gray-300">{cli?.direccion}</p>
                            <p
                              className={`mt-1 text-xs font-bold ${
                                filaAct.resumen.cuotasDeAtraso > 0 ? 'text-red-600' : 'text-gray-500'
                              }`}
                            >
                              Cuotas de atraso: {filaAct.resumen.cuotasDeAtraso}
                            </p>
                          </button>
                        )}
                        <p className={`mt-1 text-[12px] font-semibold ${marcarAtraso ? 'text-red-100' : 'text-amber-100'}`}>{cuotasTxtAct}</p>
                        {!captacionSolo ? (
                          <p className={`mt-0.5 text-[11px] ${marcarAtraso ? 'text-red-200/90' : 'text-amber-200/90'}`}>
                            Pendiente planilla: <span className="font-bold">{fmt(montoPendAct)}</span>
                            {filaAct.resumen.vencimientoSiguiente ? (
                              <span className="font-normal text-gray-400"> · próx. vto {filaAct.resumen.vencimientoSiguiente}</span>
                            ) : null}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11px] text-cyan-200/90">
                            Ubicación:{' '}
                            <span className="font-mono text-cyan-100">
                              {Number(cli.lat).toFixed(5)}, {Number(cli.lng).toFixed(5)}
                            </span>
                          </p>
                        )}
                      </div>
                      {mostrarColDer && (
                        <div className="min-w-[6.5rem] shrink-0 text-right">
                          {saldoTotalDeuda > 0 && (
                            <>
                              <p className="text-[10px] uppercase tracking-wide text-gray-400">
                                {filas.length > 1 ? 'Saldos Totales' : 'Saldo Total'}
                              </p>
                              <p className="text-sm font-bold text-amber-100">{fmt(saldoTotalDeuda)}</p>
                            </>
                          )}
                          {distancia != null && Number.isFinite(distancia) && (
                            <p className={`text-[11px] text-cyan-300 ${saldoTotalDeuda > 0 ? 'mt-0.5' : ''}`}>{distancia.toFixed(2)} km</p>
                          )}
                          {cli.orden_ruta != null && Number.isFinite(Number(cli.orden_ruta)) && !posicionRutaCobrador && (
                            <p className="mt-0.5 text-[10px] text-violet-300">Prioridad {cli.orden_ruta}</p>
                          )}
                        </div>
                      )}
                    </div>
                    {!esTabCobrado && filas.length > 1 && expandido && (
                      <div className="mt-3 space-y-1 rounded-xl border border-gray-700/80 bg-gray-900/50 p-2">
                        <p className="px-1 text-[10px] text-gray-500">Elegí crédito para cobrar</p>
                        {filas.map(f => {
                          const sel = f.credito.id === idCredSel;
                          const plN = generarPlanillaCredito(f.credito).length;
                          const peN = pagosEfectivosCredito(pagosOrEmpty, f.credito.id);
                          const sig = f.resumen.siguienteCuotaNro ?? Math.min(peN.length + 1, plN);
                          const saldoF = saldoDeudaCredito(f.credito, pagosOrEmpty);
                          return (
                            <button
                              key={f.credito.id}
                              type="button"
                              onClick={() => setRutaCreditoElegidoPorCliente(r => ({ ...r, [cli.id]: f.credito.id }))}
                              className={`w-full rounded-lg border px-2 py-2 text-left text-xs transition ${
                                sel
                                  ? 'border-cyan-500/70 bg-cyan-950/40 text-cyan-50'
                                  : 'border-transparent bg-gray-800/60 text-gray-200 hover:bg-gray-800'
                              }`}
                            >
                              <span className="font-mono text-[10px] text-gray-500">{String(f.credito.id).slice(0, 8)}…</span>
                              <span className="block font-semibold">
                                {etiquetaPlanRutaDesdeCredito(f.credito)} · Cuota {sig} de {plN}
                              </span>
                              <span className="text-gray-400">Deuda: {fmt(saldoF)}</span>
                              <span
                                className={`mt-0.5 block text-[10px] font-bold ${
                                  f.resumen.cuotasDeAtraso > 0 ? 'text-red-600' : 'text-gray-500'
                                }`}
                              >
                                Cuotas de atraso: {f.resumen.cuotasDeAtraso}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); waCliente(cli); }}
                        className="min-w-[30%] flex-1 rounded-xl bg-green-500/20 py-2 text-xs font-semibold text-green-400 transition active:scale-95"
                      >
                        💬 WhatsApp
                      </button>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); geoCliente(cli); }}
                        className="min-w-[30%] flex-1 rounded-xl bg-blue-500/20 py-2 text-xs font-semibold text-blue-400 transition active:scale-95"
                      >
                        📍 Maps
                      </button>
                      {Number.isFinite(Number(cli.lat)) && Number.isFinite(Number(cli.lng)) && (
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            abrirWazeCoordenadas(Number(cli.lat), Number(cli.lng));
                          }}
                          className="min-w-[30%] flex-1 rounded-xl bg-sky-500/20 py-2 text-xs font-semibold text-sky-300 transition active:scale-95"
                        >
                          🧭 Waze
                        </button>
                      )}
                      {puedeRegistrarPagoEnLista && !captacionSolo && (
                        <>
                          <button
                            type="button"
                            onClick={() => setMPago({ ficha: filaAct.ficha, cliente: cli })}
                            className="min-w-[30%] flex-1 rounded-xl bg-green-500 py-2 text-xs font-bold text-white shadow-md shadow-green-900/35 transition active:scale-95"
                          >
                            💵 Cobrar
                          </button>
                          <button
                            type="button"
                            onClick={() => setMNoPago({ ficha: filaAct.ficha, cliente: cli })}
                            className="min-w-[45%] flex-1 rounded-xl border border-red-500/50 bg-red-500/15 py-2 text-xs font-bold text-red-200 transition active:scale-95 hover:bg-red-500/25"
                          >
                            🚫 No pago
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {subTabRuta === 'cobrado' && rutaHistorialFecha === hoyStr && (rol || '').toLowerCase() === 'cobrador' && (
              <div className="rounded-2xl border border-indigo-500/40 bg-gradient-to-br from-indigo-950/50 to-gray-900/80 p-4 space-y-3">
                <h3 className="font-bold text-sm text-indigo-200 flex items-center gap-2">
                  <span>🧾</span> Cierre de caja (hoy)
                </h3>
                <p className="text-[11px] text-indigo-100/75">
                  Resumen automático: efectivo y transferencias de tus cobros de hoy. Las transferencias se detectan por palabras en observaciones (transferencia, CBU, alias, Mercado Pago, depósito, etc.).
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl bg-gray-900/70 border border-gray-700 px-3 py-2">
                    <span className="text-gray-400">Efectivo</span>
                    <p className="font-bold text-emerald-300">{fmt(metricasCierreCajaRutaHoy.totalEfectivo)}</p>
                  </div>
                  <div className="rounded-xl bg-gray-900/70 border border-gray-700 px-3 py-2">
                    <span className="text-gray-400">Transferencias</span>
                    <p className="font-bold text-sky-300">{fmt(metricasCierreCajaRutaHoy.totalTransfer)}</p>
                  </div>
                  <div className="rounded-xl bg-gray-900/70 border border-gray-700 px-3 py-2 col-span-2">
                    <span className="text-gray-400">Total a confirmar</span>
                    <p className="font-black text-white text-lg">{fmt(metricasCierreCajaRutaHoy.totalRecaudado)}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-gray-600/80 bg-gray-950/50 px-3 py-2 text-[11px] text-gray-300 space-y-1">
                  <p>
                    Clientes visitados: <strong className="text-white">{metricasCierreCajaRutaHoy.clientesVisitados}</strong>
                    {' · '}
                    Con No Pago: <strong className="text-red-300">{metricasCierreCajaRutaHoy.clientesNoPago}</strong>
                  </p>
                </div>
                {rutaBloqueadaPorCierreHoy ? (
                  <p className="text-xs text-amber-300 font-semibold text-center py-2">Día ya cerrado: Por cobrar queda vacío hasta mañana.</p>
                ) : (
                  <>
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">Confirmá el monto total recaudado (debe coincidir con el total)</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={montoConfirmacionCierreRuta}
                        onChange={e => setMontoConfirmacionCierreRuta(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white font-bold text-lg focus:outline-none focus:border-indigo-500"
                        placeholder={String(metricasCierreCajaRutaHoy.totalRecaudado)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleCerrarDiaRutaCobrador}
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 rounded-xl active:scale-95 transition shadow-lg shadow-indigo-900/30"
                    >
                      Cerrar día (WhatsApp al administrador)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          );
        })()}

        {/* CONFIG */}
        {page === 'config' && esMarcosPUsuario && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold">⚙️ Perfil administrador</h2>
            <div className="flex rounded-xl p-1 gap-1 bg-gray-900/80 border border-gray-700">
              <button
                type="button"
                onClick={() => setMarcosConfigTab('ajustes')}
                className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition ${marcosConfigTab === 'ajustes' ? 'bg-indigo-600 text-white' : 'text-gray-400'}`}
              >
                Ajustes
              </button>
              <button
                type="button"
                onClick={() => { setMarcosConfigTab('comisiones'); void fetchVendedoresComisionAdmin(); }}
                className={`flex-1 rounded-lg py-2.5 text-sm font-semibold transition ${marcosConfigTab === 'comisiones' ? 'bg-amber-600 text-white' : 'text-gray-400'}`}
              >
                Comisiones
                {vendedoresComisionAdmin.some(v => v.total_pendiente_aprobacion > 0) && (
                  <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1">
                    {vendedoresComisionAdmin.reduce((s, v) => s + v.ventas_pendientes_aprobacion.length, 0)}
                  </span>
                )}
              </button>
            </div>
            {marcosConfigTab === 'comisiones' ? (
              <ComisionesAdminPanel
                vendedores={vendedoresComisionAdmin}
                pctGlobal={Number(data.config.porcentajeComisionVendedor ?? 5)}
                clientes={clientesOrEmpty}
                guardandoPctId={guardandoPctComisionId}
                liquidandoId={liquidandoComisionId}
                aprobandoCreditoId={aprobandoComisionCreditoId}
                eliminandoCreditoId={eliminandoComisionCreditoId}
                onGuardarPct={(v, pct) => void handleGuardarPorcentajeComisionVendedor(v, pct)}
                onAprobarComision={(c, v) => void handleAprobarComisionCredito(c, v)}
                onEliminarComision={(c, v) => void handleEliminarComisionCredito(c, v)}
                onLiquidar={v => void handleLiquidarComisionVendedor(v)}
              />
            ) : (
              <>
                <ConfigForm
                  config={data.config}
                  soloLectura={!puedeOperarSistema}
                  onSave={(c: any) => { void handleSaveConfig(c as Config); }}
                />
                <div className="rounded-3xl border border-indigo-500/20 bg-gradient-to-br from-gray-900/80 to-gray-800/70 p-5 shadow-xl shadow-indigo-900/20">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-indigo-300 text-lg">ℹ️</span>
                    <p className="font-bold text-indigo-200">Información del Sistema</p>
                  </div>
                  <div className="space-y-2 text-sm text-gray-300">
                    <p><span className="text-gray-400">Software:</span> {MARCA_COMPLETA} v1.0</p>
                    <p><span className="text-gray-400">Programación y Arquitectura:</span> Emanuel Moreno Di Cesare.</p>
                    <p><span className="text-gray-400">Contacto de Soporte:</span> emamoreno@icloud.com Wsp: 549-263-4340284</p>
                  </div>
                </div>
                {isRootLike(rol) && (
                  <div className="space-y-2">
                    <div className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-4">
                      <p className="font-semibold text-violet-200 text-sm mb-1">👥 Gestión de usuarios</p>
                      <p className="text-xs text-gray-400 leading-relaxed">Los accesos se definen en Supabase Auth y en la tabla <span className="text-gray-300">usuarios</span> (columna <span className="text-gray-300">rol</span>: cobrador, vendedor, admin, root, super). Desde el panel SQL o Table Editor podés crear filas y asignar roles.</p>
                    </div>
                    <button onClick={() => setMAuditoria(true)} className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded-xl py-3 text-sm font-semibold active:scale-95 transition">📜 Ver Auditoría</button>
                    <button onClick={() => { if (confirm('¿Exportar logs?')) { const csv = exportarAuditoria(); const blob = new Blob([csv], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `auditoria_${hoy()}.csv`; a.click(); } }} className="w-full bg-gray-800 border border-gray-700 text-gray-300 rounded-xl py-3 text-sm font-semibold active:scale-95 transition">📥 Exportar Auditoría CSV</button>
                  </div>
                )}
                <button onClick={() => doLogout()} className="w-full bg-red-500/20 border border-red-500/30 text-red-400 rounded-xl py-3 text-sm font-semibold active:scale-95 transition">🚪 Cerrar Sesión</button>
              </>
            )}
          </div>
        )}
        {user && (
          <footer className="pt-6 pb-2 text-center">
            <p className="text-[11px] leading-relaxed text-gray-500 tracking-wide">
              Desarrollado por Emanuel Moreno | Soluciones Tecnológicas © 2026
            </p>
          </footer>
        )}
      </main>

      {/* Tab Bar */}
      {user && (
        <nav className="fixed bottom-0 left-0 right-0 bg-gray-950/90 backdrop-blur-2xl border-t border-gray-800 z-50">
          <div className="flex">
            {[
              ...(esUsuarioMensualUsuario ? [
                { k: 'dashboard', icon: '🏠', l: 'Inicio' },
                { k: 'clientes', icon: '👥', l: 'Clientes' },
                { k: 'creditos', icon: '🏦', l: 'Préstamos' },
                { k: 'cheques', icon: '📝', l: 'Cheques' },
                { k: 'ruta', icon: '📋', l: 'A cobrar' },
                { k: 'recibos_mensuales', icon: '🧾', l: 'Recibos' },
              ] : []),
              ...(esProveedorUsuario ? [{ k: 'mi_inversion', icon: '💰', l: 'Mi inversión' }] : []),
              ...(!esProveedorUsuario && !esUsuarioMensualUsuario ? [
                { k: 'dashboard', icon: '🏠', l: 'Inicio' },
                { k: 'clientes', icon: '👥', l: 'Clientes' },
                { k: 'fichas', icon: '📋', l: 'Fichas' },
                { k: 'creditos', icon: '🏦', l: 'Créditos' },
                { k: 'cheques', icon: '📝', l: 'Cheques' },
                { k: 'ruta', icon: '🗺️', l: 'Ruta' },
                ...(esMarcosPUsuario ? [{ k: 'cierre_caja', icon: '🧾', l: 'Caja' }] : []),
                ...(esMarcosPUsuario ? [{ k: 'rendiciones', icon: '📑', l: 'Rendición', pend: rendicionesPendientesAdmin.length }] : []),
                ...(esMarcosPUsuario ? [{ k: 'panel_control', icon: '🧭', l: 'Control' }] : []),
                ...(esMarcosPUsuario ? [{ k: 'gastos', icon: '💸', l: 'Gastos' }] : []),
                ...(esMarcosPUsuario ? [{ k: 'config', icon: '⚙️', l: 'Ajustes' }] : []),
              ] : []),
            ].map(t => (
              <button key={t.k} onClick={() => go(t.k)}
                className={`relative flex-1 flex flex-col items-center py-3 gap-0.5 transition-all ${page === t.k ? 'text-indigo-400' : 'text-gray-500'}`}>
                <span className="text-xl">{t.icon}</span>
                <span className="text-[10px] font-semibold">{t.l}</span>
                {'pend' in t && (t as { pend?: number }).pend != null && (t as { pend?: number }).pend! > 0 && (
                  <span className="absolute top-2 right-1/4 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                    {(t as { pend?: number }).pend}
                  </span>
                )}
              </button>
            ))}
          </div>
        </nav>
      )}

      <div
        aria-hidden
        style={{
          position: 'fixed',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          overflow: 'visible',
          pointerEvents: 'none',
          zIndex: -1,
        }}
      >
      <div
        ref={cartonShareRef}
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 0,
          width: '720px',
          minHeight: '1280px',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
          border: '1px solid #e2e8f0',
          borderRadius: '22px',
          padding: '22px',
          fontFamily: 'Inter, Roboto, Arial, sans-serif',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {cartonSharePayload && (
          <div style={{ border: '1px solid #cbd5e1', borderRadius: '18px', overflow: 'hidden', backgroundColor: '#ffffff', display: 'flex', flexDirection: 'column' }}>
            <div style={{ backgroundColor: '#1e293b', color: '#f8fafc', padding: '16px 18px' }}>
              <p style={{ margin: 0, fontSize: '22px', fontWeight: 900, letterSpacing: '0.4px' }}>
                Cartón {cartonSharePayload.nroCarton} {String(cartonSharePayload.credito.tipo || 'P').toUpperCase()}
              </p>
              <p style={{ margin: '8px 0 0', fontSize: '23px', fontWeight: 800 }}>{nombreCompletoCliente(cartonSharePayload.cliente)}</p>
              <div style={{ marginTop: '10px', display: 'grid', gap: '4px', fontSize: '13px', color: '#dbeafe' }}>
                <p style={{ margin: 0 }}><strong>Monto del Crédito:</strong> {fmt(Number(cartonSharePayload.credito.monto_total ?? cartonSharePayload.credito.total_con_interes ?? cartonSharePayload.credito.monto_solicitado) || 0)}</p>
                <p style={{ margin: 0 }}><strong>Plan:</strong> {`${Math.max(1, Number(cartonSharePayload.credito.cuotas ?? cartonSharePayload.credito.plazo_cantidad) || 1)} ${normalizarPlazoUnidad(cartonSharePayload.credito.plan ?? '')}`}</p>
                <p style={{ margin: 0 }}><strong>Monto Cuota:</strong> {fmt(montoCuotaCreditoDesdeTotal(Number(cartonSharePayload.credito.monto_total ?? cartonSharePayload.credito.total_con_interes) || 0, Math.max(1, Number(cartonSharePayload.credito.cuotas ?? cartonSharePayload.credito.plazo_cantidad) || 1)))}</p>
                <p style={{ margin: 0, color: '#fecaca', fontWeight: 800 }}>
                  <strong>Días sin pago:</strong> {diasSinPagoDesdePrimeraCuotaImpaga(cartonSharePayload.credito, pagosOrEmpty)}
                </p>
              </div>
            </div>
            <div style={{ padding: '16px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#e2e8f0' }}>
                    <th style={{ border: '1px solid #cbd5e1', padding: '10px', textAlign: 'left' }}>N° Cuota</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '10px', textAlign: 'left' }}>Vencimiento</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '10px', textAlign: 'left' }}>Fecha de Pago</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '10px', textAlign: 'left' }}>Monto Cobrado</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '10px', textAlign: 'left' }}>Cobrador</th>
                  </tr>
                </thead>
                <tbody>
                  {generarFilasCartonCredito(cartonSharePayload.credito).map(row => (
                    <tr key={row.nro} style={{ backgroundColor: row.filaStyleBg }}>
                      <td style={{ border: '1px solid #cbd5e1', padding: '10px' }}>{row.nro}</td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '10px' }}>{row.vencimiento || '—'}</td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '10px', color: row.esNoPago ? '#dc2626' : row.pagadaEfectiva ? '#0f172a' : '#94a3b8', fontWeight: row.esNoPago ? 800 : 400 }}>
                        {row.esNoPago ? 'NO PAGO' : (row.fechaPagoDisplay || '—')}
                      </td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '10px', color: row.esNoPago ? '#dc2626' : row.pagadaEfectiva ? '#0f172a' : '#94a3b8' }}>{row.montoDisplay}</td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '10px', color: row.pagadaEfectiva ? '#0f172a' : '#94a3b8' }}>{row.cobrador || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ margin: '14px 0 8px', fontSize: '13px', fontWeight: 800, color: '#0f172a' }}>Historial cronológico</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f1f5f9' }}>
                    <th style={{ border: '1px solid #cbd5e1', padding: '8px', textAlign: 'left' }}>Fecha</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '8px', textAlign: 'left' }}>Cuota</th>
                    <th style={{ border: '1px solid #cbd5e1', padding: '8px', textAlign: 'right' }}>Importe pagado</th>
                  </tr>
                </thead>
                <tbody>
                  {filasHistorialCartonResumen(cartonSharePayload.credito, pagosOrEmpty).map(h => (
                    <tr key={h.id}>
                      <td style={{ border: '1px solid #cbd5e1', padding: '8px' }}>{h.fecha || '—'}</td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '8px' }}>{h.cuota}</td>
                      <td style={{ border: '1px solid #cbd5e1', padding: '8px', textAlign: 'right', color: h.enRojo ? '#dc2626' : '#0f172a', fontWeight: h.enRojo ? 700 : 400 }}>{h.importe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ borderTop: '1px solid #e2e8f0', padding: '16px 18px', textAlign: 'right' }}>
              <p style={{ margin: 0, fontSize: '12px', color: '#475569', fontWeight: 700 }}>Saldo Restante</p>
              <p style={{ margin: '8px 0 0', fontSize: '40px', lineHeight: 1, color: '#2563eb', fontWeight: 900 }}>
                {fmt(getSaldoRestanteCredito(cartonSharePayload.credito))}
              </p>
            </div>
            <BrandingFooter align="end" variant="light" marcaPrimaria={MARCA_PRIMARIA} descriptor={MARCA_DESCRIPTOR} />
          </div>
        )}
      </div>
      </div>

      {mComprobanteImagen && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            overflow: 'visible',
            pointerEvents: 'none',
            zIndex: -1,
          }}
        >
          <div
            ref={comprobanteTicketRef}
            style={{
              position: 'absolute',
              left: '-9999px',
              top: 0,
              width: '400px',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            <ComprobantePagoTicketVista
              comprobante={mComprobanteImagen}
              nombreEmpresaDisplay={data.config.nombreEmpresa || M.nombreEmpresa}
            />
          </div>
        </div>
      )}

      {/* ====== MODALS ====== */}

      {mCierreCajaResumen && (
        <Modal onClose={() => setMCierreCajaResumen(null)} title="🧾 Resumen de Cierre">
          <div className="space-y-4">
            <pre className="whitespace-pre-wrap bg-gray-800/70 border border-gray-700 rounded-xl p-4 text-xs text-gray-200 leading-relaxed">{mCierreCajaResumen}</pre>
            <button
              type="button"
              onClick={() => {
                if (!navigator.clipboard) {
                  alert('Copiado automático no disponible en este navegador.');
                  return;
                }
                navigator.clipboard.writeText(mCierreCajaResumen).then(
                  () => alert('Resumen copiado.'),
                  () => alert('No se pudo copiar automáticamente.')
                );
              }}
              className="w-full bg-emerald-600 text-white rounded-xl py-3 font-bold active:scale-95 transition"
            >
              Copiar Resumen
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: Detalle Cliente */}
      {mDetalleCliente && (
        <Modal onClose={() => { limpiarDeepLinkCredito(); setMDetalleCliente(null); }} title={`📋 ${nombreCompletoCliente(mDetalleCliente)}`}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3">
              <div className="bg-gray-800/50 rounded-xl p-3">
                <p className="text-xs text-gray-400">Nombre</p>
                <p className="font-semibold">{nombreCompletoCliente(mDetalleCliente)}</p>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-3">
                <p className="text-xs text-gray-400">Localidad</p>
                <p className="font-semibold">{((mDetalleCliente as any).localidad || mDetalleCliente.direccion || 'Sin informar')}</p>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-3">
                <p className="text-xs text-gray-400">Fecha de Nacimiento</p>
                <p className="font-semibold">{((mDetalleCliente as any).fechaNacimiento || (mDetalleCliente as any).fecha_nacimiento || 'Sin informar')}</p>
              </div>
            </div>
            <AvisoApellidoIncompleto cliente={mDetalleCliente} />
            <div className="bg-gray-800/50 rounded-xl p-3 space-y-2">
              <p className="font-bold text-sm text-gray-200">Documentación DNI</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const url = String((mDetalleCliente as any)?.dniFrenteUrl || (mDetalleCliente as any)?.dni_frente_url || '').trim();
                    if (!url) { alert('No hay imagen de frente cargada.'); return; }
                    window.open(url, '_blank', 'noopener,noreferrer');
                  }}
                  className="bg-indigo-500/20 border border-indigo-500/30 text-indigo-200 rounded-xl py-2 text-sm font-semibold active:scale-95 transition"
                >
                  Ver Frente DNI
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const url = String((mDetalleCliente as any)?.dniDorsoUrl || (mDetalleCliente as any)?.dni_dorso_url || '').trim();
                    if (!url) { alert('No hay imagen de dorso cargada.'); return; }
                    window.open(url, '_blank', 'noopener,noreferrer');
                  }}
                  className="bg-indigo-500/20 border border-indigo-500/30 text-indigo-200 rounded-xl py-2 text-sm font-semibold active:scale-95 transition"
                >
                  Ver Dorso DNI
                </button>
              </div>
            </div>
            {esMarcosPUsuario && (
              <BloqueVideoVerificacionNegocioAdmin cliente={mDetalleCliente} />
            )}
            <div className="bg-gray-800/50 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-bold text-sm text-gray-200">Créditos Activos</p>
                <span className="text-xs text-gray-500">{fichasOrEmpty.filter(f => normalizarId(f.clienteId) === normalizarId(mDetalleCliente.id)).length}</span>
              </div>
              {fichasOrEmpty.filter(f => normalizarId(f.clienteId) === normalizarId(mDetalleCliente.id)).length === 0 && (
                <p className="text-sm text-gray-500">Este cliente no tiene fichas cargadas.</p>
              )}
              {fichasOrEmpty
                .filter(f => normalizarId(f.clienteId) === normalizarId(mDetalleCliente.id))
                .map(f => {
                  const saldoReal = saldoRestanteFicha(f);
                  return (
                    <div key={f.id} className="rounded-xl border border-gray-700 bg-gray-900/70 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{productoFichaLabel(f)}</p>
                          <p className="text-xs text-gray-500">Ficha: {f.id}</p>
                          <p className="text-xs text-gray-400">{f.cuotasPagas}/{f.cuotas} cuotas · Estado: {String(f.estado).replace(/_/g, ' ')}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-gray-500">Saldo real</p>
                          <p className="font-bold text-red-300">{fmt(-Math.abs(saldoReal))}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setMPago({ ficha: f, cliente: mDetalleCliente });
                          limpiarDeepLinkCredito();
                          setMDetalleCliente(null);
                        }}
                        className="mt-3 w-full bg-green-500 text-white rounded-xl py-3 font-bold active:scale-95 transition"
                      >
                        Ingresar Pago
                      </button>
                    </div>
                  );
                })}
            </div>
            <div className="bg-gray-800/50 rounded-xl p-3 space-y-3">
              <div className="flex items-center justify-between">
                <p className="font-bold text-sm text-gray-200">Historial de Créditos</p>
                <span className="text-xs text-gray-500">
                  {creditosOrEmpty.filter(c => normalizarId(c.cliente_id) === normalizarId(mDetalleCliente.id)).length}
                </span>
              </div>
              {creditosOrEmpty.filter(c => normalizarId(c.cliente_id) === normalizarId(mDetalleCliente.id)).length === 0 && (
                <p className="text-sm text-gray-500">Sin créditos registrados para este cliente.</p>
              )}
              {creditosOrEmpty
                .filter(c => normalizarId(c.cliente_id) === normalizarId(mDetalleCliente.id))
                .sort((a, b) => {
                  const focus = cartonDestacarCreditoId;
                  if (focus) {
                    const af = String(a.id) === String(focus) ? 1 : 0;
                    const bf = String(b.id) === String(focus) ? 1 : 0;
                    if (af !== bf) return bf - af;
                  }
                  return String(b.fecha_inicio || b.created_at || '').localeCompare(String(a.fecha_inicio || a.created_at || ''));
                })
                .map((credito, idx) => {
                  const estado = String(credito.estado || '').toUpperCase();
                  const estadoTexto = estado === 'FINALIZADO'
                    ? 'Pagado'
                    : esCreditoActivo(credito)
                      ? 'Activo'
                      : estado === 'RECHAZADO'
                        ? 'Rechazado'
                        : estado === 'PENDIENTE_APROBACION'
                          ? 'Pendiente aprobación'
                          : 'Pendiente';
                  const cuotasTotales = Math.max(1, Number(credito.cuotas ?? credito.plazo_cantidad) || 1);
                  const cuotasPagadas = Math.min(cuotasTotales, pagosEfectivosCredito(pagosOrEmpty, credito.id).length);
                  const cuotasRestantes = Math.max(0, cuotasTotales - cuotasPagadas);
                  const nroCarton = getNroCartonCredito(credito, idx);
                  const destacar = String(cartonDestacarCreditoId || '') === String(credito.id);
                  const activoRow = esCreditoActivo(credito);
                  const waDestacadoClass = destacar && activoRow
                    ? 'bg-green-500 border-2 border-amber-400 text-white rounded-lg px-3 py-2.5 text-xs font-bold shadow-lg shadow-green-500/30 ring-2 ring-amber-400/70 active:scale-95 transition'
                    : destacar
                      ? 'bg-green-500/30 border border-green-500/55 text-green-100 rounded-lg px-3 py-2 text-xs font-semibold active:scale-95 transition'
                      : 'bg-green-500/20 border border-green-500/40 text-green-200 rounded-lg px-3 py-2 text-xs font-semibold active:scale-95 transition';
                  const btnVerCarton = (
                    <button
                      key="ver"
                      type="button"
                      onClick={() => setMPlanilla({ tipo: 'credito', credito: { ...credito, nro_carton: nroCarton }, cliente: mDetalleCliente })}
                      className="bg-indigo-500/20 border border-indigo-500/35 text-indigo-200 rounded-lg px-3 py-2 text-xs font-semibold active:scale-95 transition"
                    >
                      Ver Cartón
                    </button>
                  );
                  const btnWaCarton = (
                    <button
                      key="wa"
                      type="button"
                      onClick={() => void compartirCartonActualizado({ credito: { ...credito, nro_carton: nroCarton }, cliente: mDetalleCliente, nroCarton })}
                      className={waDestacadoClass}
                    >
                      {destacar ? '💬 Enviar Cartón por WhatsApp' : '💬 Enviar Cartón Actualizado'}
                    </button>
                  );
                  return (
                    <div
                      key={credito.id}
                      className={`rounded-xl border bg-gray-900/70 p-3 ${destacar ? 'border-amber-500/50 ring-1 ring-amber-500/40' : 'border-gray-700'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{String(credito.fecha_inicio || credito.created_at || '').slice(0, 10)} · {fmt(Number(credito.monto_total ?? credito.total_con_interes) || 0)}</p>
                          <p className="text-xs text-gray-400">Cartón {nroCarton} · Estado: {estadoTexto}</p>
                          {esCreditoActivo(credito) && (
                            <p className="text-xs text-cyan-300">Pagadas: {cuotasPagadas}/{cuotasTotales} · Faltan: {cuotasRestantes}</p>
                          )}
                        </div>
                        <div className="shrink-0 flex flex-col gap-2">
                          {destacar ? <>{btnWaCarton}{btnVerCarton}</> : <>{btnVerCarton}{btnWaCarton}</>}
                          {esMarcosPUsuario && (
                            <button
                              type="button"
                              disabled={eliminandoCreditoId === credito.id}
                              onClick={() => void handleEliminarCreditoCompleto(credito)}
                              className="rounded-lg px-3 py-2 text-[10px] font-bold bg-red-600/80 text-white disabled:opacity-50 active:scale-95 transition"
                            >
                              {eliminandoCreditoId === credito.id ? 'Eliminando…' : '🗑 Eliminar crédito'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                onClick={() => { setMCliente(mDetalleCliente); setTab(0); limpiarDeepLinkCredito(); setMDetalleCliente(null); }}
                className="bg-indigo-500/20 border border-indigo-500/30 text-indigo-200 rounded-xl py-3 font-semibold text-sm active:scale-95 transition"
              >
                ✏️ Editar Información
              </button>
              <button onClick={() => waCliente(mDetalleCliente)} className="flex-1 bg-green-500 text-white rounded-xl py-3 font-semibold text-sm active:scale-95 transition">💬 WhatsApp</button>
              <button onClick={() => geoCliente(mDetalleCliente)} className="flex-1 bg-blue-500 text-white rounded-xl py-3 font-semibold text-sm active:scale-95 transition">📍 GPS</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal: Pago */}
      {mPago && (
        <Modal
          onClose={() => {
            if (registrandoPago) return;
            setBannerGpsInstrucciones(null);
            setMPago(null);
            setGpsPos(null);
          }}
          title={`💵 Registrar Pago — ${nombreCompletoCliente(mPago.cliente)}`}
        >
          <div className="space-y-4">
            <div className="bg-gray-800/50 rounded-xl p-3 grid grid-cols-2 gap-3">
              <div><p className="text-xs text-gray-400">Cuota / faltante</p><p className="font-bold text-green-400">{fmt(mPago.ficha.cuotaMonto)}</p></div>
              <div><p className="text-xs text-gray-400">Saldo crédito</p><p className="font-bold text-indigo-400">{fmt(mPago.ficha.saldo)}</p></div>
              {mPago.ficha.Mora > 0 && <div className="col-span-2"><p className="text-xs text-red-400">⚠️ Mora: {fmt(mPago.ficha.Mora)}</p></div>}
            </div>
            <PagoForm
              ficha={mPago.ficha}
              saldoCredito={mPago.ficha.saldo}
              onPago={(monto, obs) => handlePago(mPago.ficha, mPago.cliente, monto, obs)}
              gpsLoading={gpsLoading}
              gpsPos={gpsPos}
              onCapturarGPS={() => void capturarGPSAccion('pago')}
              guardandoExterno={registrandoPago}
              instruccionesGps={bannerGpsInstrucciones}
              esMarcosP={esMarcosPUsuario}
            />
          </div>
        </Modal>
      )}

      {/* Modal: Comprobante de pago */}
      {mComprobanteImagen && (
        <Modal onClose={() => setMComprobanteImagen(null)} title={`PAGO CONFIRMADO - ${MARCA_PRIMARIA}`}>
          <div className="space-y-4">
            <AvisoApellidoIncompleto cliente={mComprobanteImagen.cliente} />
            <div style={{ margin: '0 auto', maxWidth: 360 }}>
              <ComprobantePagoTicketVista
                comprobante={mComprobanteImagen}
                nombreEmpresaDisplay={data.config.nombreEmpresa || M.nombreEmpresa}
              />
            </div>
            <button
              type="button"
              onClick={() => void descargarComprobantePagoImagen(mComprobanteImagen)}
              className="w-full bg-indigo-500 text-white rounded-xl py-3 font-bold active:scale-95 transition"
            >
              Descargar Comprobante
            </button>
            <button
              type="button"
              onClick={() => void enviarComprobantePagoWhatsapp(mComprobanteImagen)}
              className="w-full bg-green-500 text-white rounded-xl py-3 font-bold active:scale-95 transition"
            >
              Enviar por WhatsApp
            </button>
            <button
              type="button"
              onClick={() => setMComprobanteImagen(null)}
              className="w-full bg-gray-800 text-gray-300 rounded-xl py-3 font-semibold active:scale-95 transition"
            >
              Cerrar
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: No Pago */}
      {mNoPago && (
        <Modal onClose={() => { setBannerGpsInstrucciones(null); setMNoPago(null); setGpsPos(null); }} title={`🚫 No se pudo cobrar — ${nombreCompletoCliente(mNoPago.cliente)}`}>
          <NoPagoForm
            cliente={mNoPago.cliente}
            ficha={mNoPago.ficha}
            gpsLoading={gpsLoading}
            gpsPos={gpsPos}
            onCapturarGPS={() => void capturarGPSAccion('nopago')}
            instruccionesGps={bannerGpsInstrucciones}
            esMarcosP={esMarcosPUsuario}
            onSubmit={(motivo, obs, fechaPromesa) => void handleNoPago(mNoPago.ficha, mNoPago.cliente, motivo, obs, fechaPromesa)}
          />
        </Modal>
      )}

      {mRutaCobradoAuditoria && (() => {
        const aud = mRutaCobradoAuditoria;
        const pagosDia = pagosEfectivosCreditosRutaEnFecha(pagosOrEmpty, aud.filas, aud.fecha);
        const visitasDia = visitasFallidasClienteEnFecha(visitasFallidasOrEmpty, aud.cliente.id, aud.fecha);
        return (
          <Modal onClose={() => setMRutaCobradoAuditoria(null)} title={`📋 Auditoría — ${nombreCompletoCliente(aud.cliente) ?? '—'} (${aud.fecha})`}>
            <div className="max-h-[min(78vh,560px)] space-y-4 overflow-y-auto pr-1 text-sm text-gray-200">
              <p className="text-xs leading-relaxed text-gray-500">
                Vista solo lectura. No se pueden alterar registros pasados ni imputar desde aquí. El punto de color indica pago efectivo (verde) o visita sin cobro (rojo).
              </p>
              {aud.semaforo === 'verde' ? (
                pagosDia.length === 0 ? (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                    No se encontraron pagos efectivos vinculados a los créditos de ruta para esta fecha.
                  </p>
                ) : (
                  pagosDia.map(p => {
                    const fic = fichaParaComprobanteDesdePago(p, fichasOrEmpty, aud.filas);
                    const fechaPagoIso = p.fechaPago || `${String(p.fecha || '').slice(0, 10)}T12:00:00`;
                    let horaStr = fechaPagoIso;
                    try {
                      horaStr = new Date(fechaPagoIso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' });
                    } catch { /* mantener iso */ }
                    const comp = fic ? comprobanteImagenDesdePago(p, aud.cliente, fic, pagosOrEmpty) : null;
                    return (
                      <div key={p.id} className="space-y-2 rounded-xl border border-emerald-500/35 bg-emerald-950/25 p-3">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.5)] ring-2 ring-white/20" title="Pago efectivo" />
                          <span className="text-xs font-bold uppercase tracking-wide text-emerald-300">Pago registrado</span>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Hora del registro</p>
                          <p className="font-mono text-sm font-semibold text-white">{horaStr}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Monto cobrado</p>
                          <p className="text-lg font-bold text-emerald-200">{fmt(redondearPesos(Number(p.monto) || 0))}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Modalidad / tipo</p>
                          <p className="text-gray-100">{textoTipoCobroPago(p.tipo)}</p>
                        </div>
                        {!!p.observaciones?.trim() && (
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Observaciones</p>
                            <p className="text-xs text-gray-300">{p.observaciones}</p>
                          </div>
                        )}
                        <div className="flex flex-col gap-2 border-t border-emerald-500/20 pt-3">
                          <button
                            type="button"
                            onClick={() => abrirMapsPuntoGps(p.lat, p.lng)}
                            className="w-full rounded-xl bg-blue-600/85 py-2.5 text-xs font-bold text-white transition active:scale-[0.98] hover:bg-blue-600"
                          >
                            Ver ubicación de cobro (GPS del registro)
                          </button>
                          {comp ? (
                            <>
                              <button
                                type="button"
                                onClick={() => abrirComprobanteAuditoriaPostCerrar(comp, 'wa')}
                                className="w-full rounded-xl bg-green-600 py-2.5 text-xs font-bold text-white transition active:scale-[0.98] hover:bg-green-500"
                              >
                                Re-enviar comprobante (WhatsApp)
                              </button>
                              <button
                                type="button"
                                onClick={() => abrirComprobanteAuditoriaPostCerrar(comp, 'descarga')}
                                className="w-full rounded-xl bg-indigo-600 py-2.5 text-xs font-bold text-white transition active:scale-[0.98] hover:bg-indigo-500"
                              >
                                Descargar captura del recibo
                              </button>
                            </>
                          ) : (
                            <p className="text-center text-[11px] text-amber-400">No se pudo armar el comprobante (ficha no encontrada para este pago).</p>
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : visitasDia.length === 0 ? (
                <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  No se encontraron visitas sin cobro para esta fecha.
                </p>
              ) : (
                visitasDia.map((v, vi) => (
                  <div key={`${aud.cliente.id}-${aud.fecha}-vf-${vi}`} className="space-y-2 rounded-xl border border-red-500/40 bg-red-950/20 p-3">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 shrink-0 rounded-full bg-red-500 shadow-[0_0_8px_rgba(248,113,113,0.45)] ring-2 ring-white/20" title="Visita sin cobro" />
                      <span className="text-xs font-bold uppercase tracking-wide text-red-300">No pago (visita)</span>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Hora registrada</p>
                      <p className="font-mono text-sm font-semibold text-white">{v.hora}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Motivo</p>
                      <p className="text-gray-100">{motivoVisitaFallidaLabel(v.motivo)}</p>
                    </div>
                    {!!v.observaciones?.trim() && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Observaciones</p>
                        <p className="text-xs text-gray-300">{v.observaciones}</p>
                      </div>
                    )}
                    {!!v.promesaFecha?.trim() && (
                      <p className="text-xs text-amber-200">Promesa: {v.promesaFecha}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => abrirMapsPuntoGps(v.lat, v.lng)}
                      className="mt-1 w-full rounded-xl bg-blue-600/85 py-2.5 text-xs font-bold text-white transition active:scale-[0.98] hover:bg-blue-600"
                    >
                      Ver ubicación registrada (GPS de la visita)
                    </button>
                    <p className="text-center text-[11px] text-gray-500">No aplica comprobante de pago (no hubo cobro).</p>
                  </div>
                ))
              )}
              <button
                type="button"
                onClick={() => setMRutaCobradoAuditoria(null)}
                className="w-full rounded-xl border border-gray-600 bg-gray-800 py-3 text-sm font-semibold text-gray-200 transition active:scale-[0.98] hover:bg-gray-700/90"
              >
                Cerrar
              </button>
            </div>
          </Modal>
        );
      })()}

      {/* Modal: Cliente */}
      {mCliente && (
        <Modal
          onClose={() => setMCliente(null)}
          title={
            mCliente.id && esUuidClienteId(mCliente.id) ? '✏️ Editar Cliente' : '+ Nuevo Cliente'
          }
        >
          <ClienteForm
            key={
              mCliente.id && esUuidClienteId(mCliente.id)
                ? mCliente.id
                : `draft-${clienteModalNonce}`
            }
            cliente={mCliente}
            edicionClienteUuidEnServidor={Boolean(
              mCliente?.id && esUuidClienteId(String(mCliente.id)),
            )}
            mostrarOrdenRuta={esMarcosPUsuario}
            modoEdicionSoloContacto={Boolean(
              esMatiasOVendedorUsuario
                && mCliente?.id
                && clientesOrEmpty.some(c => c.id === mCliente.id),
            )}
            onSave={handleSaveCliente}
            onCancel={() => setMCliente(null)}
            onGeoCoords={getGPS}
          />
        </Modal>
      )}

      {/* Modal: Ficha */}
      {mFicha && (
        <Modal onClose={() => setMFicha(null)} title={mFicha.ficha ? '📋 Editar Ficha' : '+ Nueva Ficha'}>
          <FichaForm
            key={mFicha.ficha?.id || `nueva-${mFicha.cliente?.id ?? 'sin'}`}
            ficha={mFicha.ficha}
            cliente={mFicha.cliente}
            clientes={clientesOrEmpty.filter(c => esUuidClienteId(String(c?.id ?? '')))}
            onSave={handleSaveFicha}
            onTab={tab}
            onSetTab={setTab}
            onEliminarPago={handleEliminarPago}
            puedeEliminarPagos={esMarcosPUsuario}
          />
        </Modal>
      )}
      {mCreditoTipo && (
        <Modal onClose={() => setMCreditoTipo(null)} title={esUsuarioMensualUsuario ? '🏦 Nuevo préstamo mensual' : mCreditoTipo === 'M' ? '🟢 Nuevo Crédito M' : '🟠 Nuevo Crédito P'}>
          <CreditoForm
            tipo={mCreditoTipo}
            clientes={clientesOrEmpty.filter(c => esUuidClienteId(String(c?.id ?? '')))}
            interesM={data.config.interesCreditoM ?? 30}
            interesP={data.config.interesCreditoP ?? 30}
            rol={rol}
            soloPlanMensual={esUsuarioMensualUsuario}
            configTasasMensual={configTasasMensual}
            onCancel={() => setMCreditoTipo(null)}
            onSubmit={handleCrearCredito}
          />
        </Modal>
      )}
      {mAjusteTasaMensual && esUsuarioMensualUsuario && (
        <Modal onClose={() => setMAjusteTasaMensual(false)} title="📊 Tasas de interés mensual">
          <AjusteTasasMensualPanel
            config={configTasasMensual}
            onGuardar={(nuevo) => {
              setConfigTasasMensual(nuevo);
              guardarConfigTasasMensual(nuevo);
              setMAjusteTasaMensual(false);
            }}
            onCerrar={() => setMAjusteTasaMensual(false)}
          />
        </Modal>
      )}
      {exitoCreditoCobradorWa && (
        <CreditoExitoNotificarMarcosOverlay
          linkWhatsapp={exitoCreditoCobradorWa.linkWhatsapp}
          waAbierto={exitoCreditoCobradorWa.waAbierto}
          onMarcarWhatsappAbierto={() => setExitoCreditoCobradorWa(prev => (prev ? { ...prev, waAbierto: true } : prev))}
          onIrDashboard={() => {
            setExitoCreditoCobradorWa(null);
            go('dashboard');
          }}
        />
      )}
      {mCreditoRevision && (
        <Modal onClose={() => setMCreditoRevision(null)} title={`🔎 Revisar crédito ${mCreditoRevision.id}`}>
          <CreditoReviewForm
            credito={mCreditoRevision}
            cliente={clientesOrEmpty.find(c => c.id === mCreditoRevision.cliente_id) || null}
            historial={creditosOrEmpty.filter(c => c.cliente_id === mCreditoRevision.cliente_id && c.id !== mCreditoRevision.id)}
            puedeGestionarRevision={esMarcosPUsuario}
            cobradoresOpciones={cobradoresRevision}
            eliminando={eliminandoCreditoId === mCreditoRevision.id}
            onCerrar={() => setMCreditoRevision(null)}
            onVerPlanilla={(credito) => setMPlanilla({ tipo: 'credito', credito, cliente: clientesOrEmpty.find(c => c.id === credito.cliente_id) || null })}
            onResolver={async (review, estado) => {
              await handleActualizarEstadoCredito(mCreditoRevision, estado, review);
              setMCreditoRevision(null);
            }}
            onEliminarCredito={credito => void handleEliminarCreditoCompleto(credito)}
          />
        </Modal>
      )}
      {mPlanilla && (
        <Modal onClose={() => setMPlanilla(null)} title="🧾 Planilla de Pagos">
          {mPlanilla.tipo === 'ficha' ? (
            <PlanillaPagosFicha ficha={mPlanilla.ficha} cliente={mPlanilla.cliente} pagos={pagosOrEmpty} />
          ) : (
            <PlanillaPagosCredito credito={mPlanilla.credito} cliente={mPlanilla.cliente} creditos={creditosOrEmpty} pagos={pagosOrEmpty} nroCarton={getNroCartonCredito(mPlanilla.credito)} />
          )}
        </Modal>
      )}

      {/* Modal: Gasto */}
      {mGasto && (
        <Modal onClose={() => setMGasto(null)} title="+ Registrar Gasto">
          <GastoForm onSave={handleSaveGasto} />
        </Modal>
      )}

      {mNuevoProveedor && (
        <Modal onClose={() => setMNuevoProveedor(false)} title="+ Nuevo proveedor / inversor">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Nombre</label>
              <input
                value={formNuevoProv.nombre}
                onChange={e => setFormNuevoProv(f => ({ ...f, nombre: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                placeholder="Ej: Juan Pérez"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Usuario de acceso (opcional)</label>
              <input
                value={formNuevoProv.login}
                onChange={e => setFormNuevoProv(f => ({ ...f, login: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
                placeholder="Se genera del nombre si está vacío"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Teléfono (opcional)</label>
              <input
                value={formNuevoProv.telefono}
                onChange={e => setFormNuevoProv(f => ({ ...f, telefono: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white"
              />
            </div>
            <p className="text-xs text-gray-500">Se crea el acceso automáticamente. Compartí usuario y contraseña con el inversor (sin Supabase).</p>
            <button
              type="button"
              disabled={guardandoProveedor}
              onClick={() => void handleCrearProveedor()}
              className="w-full bg-sky-600 disabled:opacity-50 text-white rounded-xl py-3 font-bold active:scale-95 transition"
            >
              {guardandoProveedor ? 'Creando…' : 'Crear proveedor y usuario'}
            </button>
          </div>
        </Modal>
      )}

      {mCredencialesProveedor && (
        <Modal onClose={() => setMCredencialesProveedor(null)} title="✅ Proveedor listo">
          <div className="space-y-3 text-sm">
            <p className="text-gray-300">
              <strong>{mCredencialesProveedor.nombre}</strong> ya puede ingresar a la app con estos datos:
            </p>
            <div className="bg-gray-800 rounded-xl p-4 space-y-2 font-mono text-xs">
              <p><span className="text-gray-500">Usuario:</span> <span className="text-sky-300">{mCredencialesProveedor.login}</span></p>
              <p><span className="text-gray-500">Contraseña:</span> <span className="text-amber-300">{mCredencialesProveedor.password}</span></p>
            </div>
            <p className="text-xs text-gray-500">Solo verá su capital invertido, fecha de entrada y total a recibir. No hace falta configurar nada en Supabase.</p>
            <button
              type="button"
              onClick={() => {
                const txt = `Usuario: ${mCredencialesProveedor.login}\nContraseña: ${mCredencialesProveedor.password}`;
                void navigator.clipboard?.writeText(txt);
                alert('Copiado al portapapeles');
              }}
              className="w-full bg-gray-700 text-white rounded-xl py-2.5 font-semibold"
            >
              Copiar credenciales
            </button>
          </div>
        </Modal>
      )}

      {/* Modal: Cierre Jornada */}
      {mJornada && (
        <Modal onClose={() => { setBannerGpsInstrucciones(null); setMJornada(false); }} title="🏁 Cerrar jornada">
          <JornadaForm
            key={`${cajaCobradorDia.efectivoEnMano}-${cajaCobradorDia.totalCobrado}`}
            totalCobrado={cajaCobradorDia.totalCobrado}
            totalGastos={cajaCobradorDia.totalGastos}
            netoEntregar={cajaCobradorDia.efectivoEnMano}
            gpsLoading={gpsLoading}
            gpsPos={gpsPos}
            instruccionesGps={bannerGpsInstrucciones}
            esMarcosP={esMarcosPUsuario}
            onCapturarGPS={() => void capturarGPSAccion('jornada')}
            onSubmit={(montoFisico, kmFin, novedades) => handleCierreJornada(montoFisico, kmFin, novedades)}
          />
        </Modal>
      )}

      {/* Modal: Ver Cierre */}
      {mCierre && (
        <Modal onClose={() => setMCierre(null)} title="✅ Rendición registrada">
          <div className="space-y-3 text-center">
            <p className="text-xs text-gray-400">Pendiente de validación del administrador.</p>
            {(mCierre.totalGastos != null || mCierre.netoEntregar != null) && (
              <div className="bg-gray-800/60 rounded-xl p-3 text-sm text-left space-y-1">
                <p><span className="text-gray-500">Cobrado:</span> <span className="text-white font-semibold">{fmt(Number(mCierre.totalSistema))}</span></p>
                <p><span className="text-gray-500">Gastos:</span> <span className="text-orange-300 font-semibold">{fmt(Number(mCierre.totalGastos ?? 0))}</span></p>
                <p><span className="text-gray-500">Neto a entregar:</span> <span className="text-emerald-400 font-bold">{fmt(Number(mCierre.netoEntregar ?? mCierre.totalSistema))}</span></p>
              </div>
            )}
            <div className="text-5xl">{Number(mCierre.diferencia) === 0 ? '✅' : Number(mCierre.diferencia) > 0 ? '💚' : '🚩'}</div>
            <p className="font-bold text-lg">Diferencia (físico vs neto): {fmt(Math.abs(Number(mCierre.diferencia)))}</p>
            <p className="text-gray-400 text-sm">{Number(mCierre.diferencia) > 0 ? 'Sobrante' : Number(mCierre.diferencia) < 0 ? 'Faltante' : 'Cuadrado'}</p>
          </div>
        </Modal>
      )}

      {/* Modal: Ruta Optimizada */}
      {mRuta && (
        <Modal onClose={() => setMRuta(false)} title="🗺️ Ruta Optimizada">
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {clientesOrdenados.length === 0 && <p className="text-center text-gray-400">Clientes sin coordenadas</p>}
            {clientesOrdenados.map((cli, i) => (
              <div key={cli.id} className="bg-gray-800/50 rounded-xl p-3 flex items-center gap-3">
                <div className="w-8 h-8 bg-indigo-500/20 rounded-lg flex items-center justify-center font-bold text-indigo-400">{i + 1}</div>
                <div className="flex-1">
                  <p className="font-semibold text-sm">{nombreCompletoCliente(cli) ?? '—'}</p>
                  <p className="text-xs text-gray-400">{cli?.direccion}</p>
                </div>
                <span className="text-xs text-blue-400 font-mono">{cli.distancia?.toFixed(1)} km</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {mNotificaciones && (
        <Modal onClose={() => setMNotificaciones(false)} title="🔔 Notificaciones">
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {notificacionesUsuario.map(n => (
              <button
                key={n.id}
                onClick={() => handleNotificacionClick(n)}
                className={`w-full text-left rounded-xl p-3 border ${n.leido ? 'bg-gray-800/40 border-gray-800' : 'bg-indigo-500/10 border-indigo-500/30'}`}
              >
                <p className="text-sm font-semibold">{n.titulo}</p>
                <p className="text-xs text-gray-400">{n.mensaje}</p>
              </button>
            ))}
            {notificacionesUsuario.length === 0 && <p className="text-center text-gray-500 text-sm">Sin notificaciones</p>}
          </div>
        </Modal>
      )}
      {mQrScan && (
        <Modal onClose={() => setMQrScan(false)} title="📷 Escaneo Rápido">
          <div className="space-y-3">
            <p className="text-xs text-gray-400">Escaneá el QR del cliente para abrir su ficha automáticamente.</p>
            <div id="qr-reader-box" className="w-full min-h-[280px] rounded-xl overflow-hidden border border-gray-700 bg-black" />
            <p className="text-xs text-cyan-300">{estadoQr}</p>
          </div>
        </Modal>
      )}

      {/* Modal: Auditoría */}
      {mAuditoria && (
        <Modal onClose={() => setMAuditoria(false)} title="📜 Logs de Auditoría">
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <input
                type="date"
                value={logsAuditoriaDesde}
                onChange={e => setLogsAuditoriaDesde(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white"
                placeholder="Desde"
              />
              <input
                type="date"
                value={logsAuditoriaHasta}
                onChange={e => setLogsAuditoriaHasta(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white"
                placeholder="Hasta"
              />
              <input
                type="text"
                value={logsAuditoriaActor}
                onChange={e => setLogsAuditoriaActor(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white md:col-span-1"
                placeholder="Buscar por nombre/actor"
              />
              <input
                type="text"
                value={logsAuditoriaCreditoId}
                onChange={e => setLogsAuditoriaCreditoId(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white md:col-span-1"
                placeholder="Buscar por Crédito ID"
              />
            </div>
            <div className="text-xs text-gray-400">
              Mostrando {logsAuditoriaFiltrados.length} de {logsAuditoriaRemotos.length} registros.
            </div>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {logsAuditoriaLoading && <p className="text-center text-gray-500">Cargando logs...</p>}
              {!logsAuditoriaLoading && logsAuditoriaFiltrados.map(e => (
                <div key={`${e.id}`} className="bg-gray-800/50 rounded-lg p-3 text-xs">
                  <div className="flex justify-between text-gray-500 mb-1 gap-3">
                    <span>{String(e.created_at || '').replace('T', ' ').slice(0, 19)}</span>
                    <span className="text-indigo-400">{etiquetaCobradorMovimiento(String(e.actor ?? ''))}</span>
                  </div>
                  <p className="text-gray-200 font-semibold">{String(e.contexto || 'sin_contexto')}</p>
                  {e.mensaje_error && <p className="text-red-200 mt-1">{e.mensaje_error}</p>}
                  <p className="text-[11px] text-gray-400 mt-1">{String(e.tipo || '').toUpperCase()}</p>
                </div>
              ))}
              {!logsAuditoriaLoading && logsAuditoriaFiltrados.length === 0 && <p className="text-center text-gray-500">Sin registros</p>}
            </div>
          </div>
        </Modal>
      )}

      <VistaRapidaSistemaModal
        open={mVistaRapidaSistema}
        onClose={() => setMVistaRapidaSistema(false)}
      />

      {esSesionUsuarioPrueba && trialFinPrueba && (
        <TrialCountdownBadge trialFin={trialFinPrueba} />
      )}
      <TrialBloqueoOverlay activo={sistemaBloqueadoTrial} onCerrarSesion={() => void doLogout()} />
    </div>
  );
}

// ==========================================
// SUB-COMPONENTS
// ==========================================

function LoginForm({
  onLogin,
  loading,
  onAbrirGuia,
}: {
  onLogin: (u: string, p: string) => void;
  loading: boolean;
  onAbrirGuia?: () => void;
}) {
  const [u, setU] = useState(() => loginDesdeAlmacenado(localStorage.getItem('cp_last_login_user')));
  const [p, setP] = useState('');
  const userRef = useRef<HTMLInputElement | null>(null);
  const passRef = useRef<HTMLInputElement | null>(null);
  const accesosRapidos = useMemo(() => accesosRapidosLoginVisibles(), []);
  useEffect(() => {
    if (u) passRef.current?.focus();
    else userRef.current?.focus();
  }, []);
  return (
    <div className="space-y-3 bg-gray-900/75 rounded-3xl p-5 border border-gray-800 backdrop-blur-sm shadow-2xl">
      {accesosRapidos.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {accesosRapidos.map(r => (
            <button
              key={r.login}
              type="button"
              onClick={() => {
                setU(r.login);
                setP('');
                setTimeout(() => passRef.current?.focus(), 0);
              }}
              className="bg-gray-800/80 border border-gray-700 text-gray-200 rounded-xl py-2.5 text-xs font-semibold active:scale-95 transition"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Usuario</label>
        <input
          ref={userRef}
          value={u}
          onChange={e => setU(e.target.value)}
          type="text"
          autoComplete="username"
          className="w-full bg-gray-900/80 border border-amber-400/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-amber-300/70 focus:ring-1 focus:ring-amber-300/40 transition"
          placeholder="marcos, matias, prueba…"
        />
      </div>
      <div>
        <label className="text-xs text-gray-400 mb-1 block">Contraseña</label>
        <input
          ref={passRef}
          type="password"
          value={p}
          onChange={e => setP(e.target.value)}
          autoComplete="current-password"
          className="w-full bg-gray-900/80 border border-amber-400/20 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-amber-300/70 focus:ring-1 focus:ring-amber-300/40 transition"
          placeholder="••••••••"
        />
      </div>
      <button onClick={() => u.trim() && p && onLogin(u.trim(), p)} disabled={loading}
        className="w-full bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 disabled:from-amber-500/50 disabled:to-yellow-500/50 text-gray-950 font-bold py-3 rounded-xl transition-all active:scale-[0.98] shadow-lg shadow-amber-500/20">
        {loading ? '⏳...' : 'Ingresar'}
      </button>
      {onAbrirGuia && (
        <button
          type="button"
          onClick={onAbrirGuia}
          className="w-full bg-cyan-500/15 border border-cyan-400/35 text-cyan-200 font-semibold py-2.5 rounded-xl text-sm active:scale-[0.98] transition hover:bg-cyan-500/25"
        >
          📖 Ver guía del sistema
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setU('prueba');
          setP('prueba');
          setTimeout(() => passRef.current?.focus(), 0);
        }}
        className="w-full text-[11px] text-gray-500 hover:text-amber-300/90 py-1 transition"
      >
        Demo: usuario <span className="text-gray-400">prueba</span> / clave <span className="text-gray-400">prueba</span>
      </button>
    </div>
  );
}

function IconoWhatsappMarca({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.718 2.006-1.413.248-.695.248-1.29.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"
      />
    </svg>
  );
}

function CreditoExitoNotificarMarcosOverlay({
  linkWhatsapp,
  waAbierto,
  onMarcarWhatsappAbierto,
  onIrDashboard,
}: {
  linkWhatsapp: string;
  waAbierto: boolean;
  onMarcarWhatsappAbierto: () => void;
  onIrDashboard: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[300] flex flex-col items-center justify-center px-5 py-12 text-white"
      style={{
        backgroundColor: 'var(--dotcom-fondo-app, #020617)',
        backgroundImage: 'linear-gradient(165deg, rgba(12, 74, 110, 0.55) 0%, #020617 42%, #000 100%)',
      }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="credito-exito-notificar-titulo"
    >
      <div className="w-full max-w-md rounded-[28px] border border-cyan-500/20 bg-gray-950/75 px-8 py-10 text-center shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <p className="font-light text-[10px] uppercase tracking-[0.2em] text-cyan-200/70">{MARCA_DESCRIPTOR}</p>
        <p id="credito-exito-notificar-titulo" className="mt-3 font-black tracking-tight text-2xl text-white sm:text-3xl" style={{ letterSpacing: '-0.03em' }}>
          ¡Crédito registrado!
        </p>
        <p className="mt-5 text-sm leading-relaxed text-gray-300 sm:text-base">
          Para activar este crédito y computar tu comisión, debes notificar a la administración para su aprobación.
        </p>
        <a
          href={linkWhatsapp}
          target="_blank"
          rel="noopener noreferrer"
          role="button"
          onClick={onMarcarWhatsappAbierto}
          className="mt-8 inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-green-600 px-5 py-4 text-base font-bold text-white shadow-[0_8px_32px_rgba(22,163,74,0.35)] transition hover:bg-green-500 active:scale-[0.98] sm:text-lg"
        >
          <IconoWhatsappMarca className="h-7 w-7 shrink-0 sm:h-8 sm:w-8" />
          Enviar revisión al administrador
        </a>
        {!waAbierto && (
          <p className="mt-5 text-xs leading-relaxed text-cyan-200/55">
            Es obligatorio abrir WhatsApp con este botón para continuar en {MARCA_PRIMARIA}.
          </p>
        )}
        {waAbierto && (
          <button
            type="button"
            onClick={onIrDashboard}
            className="mt-8 w-full rounded-2xl border border-cyan-500/35 bg-cyan-950/40 px-6 py-3.5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-950/60 active:scale-[0.98]"
          >
            Volver al Dashboard
          </button>
        )}
      </div>
    </div>
  );
}

function Modal({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 border border-gray-700 rounded-t-3xl sm:rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between z-10 rounded-t-3xl sm:rounded-t-2xl">
          <h2 className="font-bold text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 bg-gray-800 rounded-full flex items-center justify-center text-gray-400 active:scale-90 transition">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function PagoForm({ ficha, saldoCredito, onPago, gpsLoading, gpsPos, onCapturarGPS, guardandoExterno = false, instruccionesGps = null, esMarcosP = false }: {
  ficha: Ficha;
  saldoCredito?: number;
  onPago: (monto: number, obs: string) => void | Promise<void>;
  gpsLoading: boolean;
  gpsPos: any;
  onCapturarGPS: () => void | Promise<void>;
  guardandoExterno?: boolean;
  instruccionesGps?: string | null;
  esMarcosP?: boolean;
}) {
  const cuotaRef = redondearPesos(Number(ficha.cuotaMonto) || 0);
  const saldoRef = redondearPesos(Number(saldoCredito ?? ficha.saldo) || 0);
  const [monto, setMonto] = useState(String(cuotaRef || ''));
  const [obs, setObs] = useState('');
  const [medio, setMedio] = useState<'efectivo' | 'transferencia'>('efectivo');
  const [enviandoPago, setEnviandoPago] = useState(false);
  const m = parseFloat(monto) || 0;
  const esParcial = m > 0 && m < cuotaRef;
  const esAdelanto = m > cuotaRef && m <= saldoRef;
  const bloqueado = guardandoExterno || enviandoPago;
  const gpsOkReal = Boolean(gpsPos && (Number(gpsPos.lat) !== 0 || Number(gpsPos.lng) !== 0));
  const confirmar = async () => {
    if (bloqueado) return;
    const t = obs.trim();
    const obsFin = medio === 'transferencia' ? (t ? `Transferencia: ${t}` : 'Transferencia') : t;
    setEnviandoPago(true);
    try {
      await Promise.resolve(onPago(m, obsFin));
    } finally {
      setEnviandoPago(false);
    }
  };
  return (
    <div className="space-y-4">
      {instruccionesGps && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100 leading-relaxed">
          <p className="font-semibold text-amber-200 mb-1">Ubicación bloqueada</p>
          <p>{instruccionesGps}</p>
        </div>
      )}
      {esMarcosP && gpsPos && !gpsOkReal && (
        <p className="text-xs text-violet-300 rounded-lg border border-violet-500/30 bg-violet-950/30 px-3 py-2">Modo administrador: cobro sin coordenadas GPS (0,0). Solo para pruebas o escritorio.</p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void Promise.resolve(onCapturarGPS())} disabled={gpsLoading} className={`text-xs px-3 py-2 rounded-xl font-semibold active:scale-95 transition ${gpsOkReal ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
          {gpsLoading ? '⏳ GPS...' : gpsOkReal ? '✅ GPS OK' : '📍 Capturar GPS'}
        </button>
        {gpsPos && <span className="text-xs text-gray-500">{gpsPos.lat.toFixed(4)}, {gpsPos.lng.toFixed(4)}</span>}
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Medio</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMedio('efectivo')}
            className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${medio === 'efectivo' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 border border-gray-700'}`}
          >
            Efectivo
          </button>
          <button
            type="button"
            onClick={() => setMedio('transferencia')}
            className={`flex-1 rounded-xl py-2 text-xs font-bold transition ${medio === 'transferencia' ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-400 border border-gray-700'}`}
          >
            Transferencia
          </button>
        </div>
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Monto a registrar</label>
        <div className="flex flex-wrap gap-2 mb-2">
          <button
            type="button"
            onClick={() => setMonto(String(cuotaRef))}
            className="rounded-lg bg-emerald-600/30 border border-emerald-500/40 px-3 py-1.5 text-[11px] font-bold text-emerald-200"
          >
            Cuota actual ({fmt(cuotaRef)})
          </button>
          {saldoRef > cuotaRef && (
            <button
              type="button"
              onClick={() => setMonto(String(saldoRef))}
              className="rounded-lg bg-sky-600/30 border border-sky-500/40 px-3 py-1.5 text-[11px] font-bold text-sky-200"
            >
              Saldo total ({fmt(saldoRef)})
            </button>
          )}
        </div>
        <input type="number" value={monto} onChange={e => setMonto(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-xl font-bold focus:outline-none focus:border-indigo-500" />
        {esParcial && <p className="text-xs text-orange-400 mt-1">⚠️ Pago parcial. Faltante de {fmt(cuotaRef - m)} queda pendiente en esta cuota</p>}
        {esAdelanto && <p className="text-xs text-sky-300 mt-1">✓ Adelanto: el excedente se aplicará a cuotas siguientes según el saldo</p>}
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Observaciones (opcional)</label>
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none" placeholder={medio === 'transferencia' ? 'Ej: alias, banco, comprobante' : 'Ej: Dejó en sobre bajo la puerta'} />
      </div>
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button
          type="button"
          onClick={() => void confirmar()}
          disabled={bloqueado}
          className="flex-1 bg-green-500 text-white font-bold py-3 rounded-xl active:scale-95 transition-all shadow-lg disabled:opacity-50 disabled:pointer-events-none"
        >
          {bloqueado ? '⏳ Guardando…' : '💵 Confirmar Pago'}
        </button>
      </div>
    </div>
  );
}

function NoPagoForm({ gpsLoading, gpsPos, onCapturarGPS, onSubmit, instruccionesGps = null, esMarcosP = false }: {
  cliente: Cliente; ficha: Ficha; gpsLoading: boolean; gpsPos: any; onCapturarGPS: () => void | Promise<void>;
  instruccionesGps?: string | null;
  esMarcosP?: boolean;
  onSubmit: (motivo: string, obs: string, fechaPromesa: string) => void | Promise<void>;
}) {
  const [motivo, setMotivo] = useState(''); const [obs, setObs] = useState(''); const [fechaPromesa, setFechaPromesa] = useState('');
  const motivos = [{ k: 'no_domicilio', l: '🚪 No estaba en domicilio' }, { k: 'sin_dinero', l: '💸 No tenía el dinero' }, { k: 'local_cerrado', l: '🔒 Local cerrado' }, { k: 'promesa_pago', l: '📅 Promesa de pago' }];
  const gpsOkReal = Boolean(gpsPos && (Number(gpsPos.lat) !== 0 || Number(gpsPos.lng) !== 0));
  return (
    <div className="space-y-4">
      {instruccionesGps && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100 leading-relaxed">
          <p className="font-semibold text-amber-200 mb-1">Ubicación bloqueada</p>
          <p>{instruccionesGps}</p>
        </div>
      )}
      {esMarcosP && gpsPos && !gpsOkReal && (
        <p className="text-xs text-violet-300 rounded-lg border border-violet-500/30 bg-violet-950/30 px-3 py-2">Modo administrador: podés confirmar sin GPS real (coordenadas 0,0).</p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void Promise.resolve(onCapturarGPS())} disabled={gpsLoading} className={`text-xs px-3 py-2 rounded-xl font-semibold active:scale-95 transition ${gpsOkReal ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
          {gpsLoading ? '⏳ GPS...' : gpsOkReal ? '✅ GPS OK' : '📍 Capturar GPS (obligatorio)'}
        </button>
        {!gpsOkReal && <span className="text-xs text-red-400">GPS requerido</span>}
      </div>
      <div className="space-y-2">
        {motivos.map(m => (
          <button key={m.k} onClick={() => setMotivo(m.k)} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold transition-all ${motivo === m.k ? 'bg-indigo-500 text-white' : 'bg-gray-800 text-gray-300'}`}>
            {m.l}
          </button>
        ))}
      </div>
      {motivo === 'promesa_pago' && (
        <div>
          <label className="text-xs text-gray-400 block mb-1">Nueva fecha de visita</label>
          <input type="date" value={fechaPromesa} onChange={e => setFechaPromesa(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" />
        </div>
      )}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Observaciones</label>
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none" />
      </div>
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button
          type="button"
          onClick={() => {
            void (async () => {
              if (!motivo) { alert('Seleccioná un motivo'); return; }
              if (motivo === 'promesa_pago' && !String(fechaPromesa || '').trim()) { alert('Elegí la fecha de la promesa'); return; }
              await Promise.resolve(onSubmit(motivo, obs, fechaPromesa));
            })();
          }}
          className="flex-1 bg-red-500 text-white font-bold py-3 rounded-xl active:scale-95 transition-all"
        >
          🚫 Confirmar No Pago
        </button>
      </div>
    </div>
  );
}

function AjusteTasasMensualPanel({
  config,
  onGuardar,
  onCerrar,
}: {
  config: ConfigTasasMensual;
  onGuardar: (nuevo: ConfigTasasMensual) => void;
  onCerrar: () => void;
}) {
  const [draft, setDraft] = useState<ConfigTasasMensual>(config);
  useEffect(() => { setDraft(config); }, [config]);
  const planPreview = useMemo(() => listadoPlanMensualPlazoTasa(draft), [draft]);
  const pasoAjusteGlobal = (delta: number) => setDraft(prev => ({ ...prev, ajusteGlobalPct: prev.ajusteGlobalPct + delta }));
  const setTasaEfectivaPlazo = (meses: number, tasaEfectiva: number) => {
    const base = Math.max(0, Math.round(tasaEfectiva - draft.ajusteGlobalPct));
    setDraft(prev => {
      const tasasPersonalizadas = { ...prev.tasasPersonalizadas };
      const defecto = tasaDefectoMensualPorMeses(meses);
      if (base === defecto) delete tasasPersonalizadas[meses];
      else tasasPersonalizadas[meses] = base;
      return { ...prev, tasasPersonalizadas };
    });
  };
  const restablecerPlazo = (meses: number) => {
    setDraft(prev => {
      const tasasPersonalizadas = { ...prev.tasasPersonalizadas };
      delete tasasPersonalizadas[meses];
      return { ...prev, tasasPersonalizadas };
    });
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400 leading-relaxed">
        Podés subir o bajar <strong className="text-gray-200">todas</strong> las tasas con el ajuste general, o editar <strong className="text-gray-200">cada plazo</strong> por separado. El simulador y los nuevos préstamos usan estos valores.
      </p>
      <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 space-y-3">
        <label className="text-xs text-violet-200 block">Ajuste general (suma a todos los planes, p.p.)</label>
        <div className="flex flex-wrap gap-2">
          {[-10, -5, -1, 1, 5, 10].map(delta => (
            <button
              key={delta}
              type="button"
              onClick={() => pasoAjusteGlobal(delta)}
              className="rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm font-semibold text-white active:scale-95"
            >
              {delta > 0 ? `+${delta}` : delta}
            </button>
          ))}
        </div>
        <input
          type="number"
          value={draft.ajusteGlobalPct}
          onChange={e => setDraft(prev => ({ ...prev, ajusteGlobalPct: Number(e.target.value) || 0 }))}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-lg font-bold"
        />
      </div>
      <div className="rounded-xl border border-gray-700 overflow-hidden">
        <p className="text-xs font-semibold text-gray-300 px-3 py-2 bg-gray-800/80">Tasa por plazo (% efectivo en simulador)</p>
        <div className="max-h-64 overflow-y-auto divide-y divide-gray-800">
          {planPreview.map(p => {
            const personalizada = draft.tasasPersonalizadas[p.meses] != null;
            const defecto = tasaDefectoMensualPorMeses(p.meses);
            return (
              <div key={p.meses} className="px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-300 shrink-0">{p.meses} {p.meses === 1 ? 'mes' : 'meses'}</span>
                  <input
                    type="number"
                    min={0}
                    value={p.tasaPct}
                    onChange={e => setTasaEfectivaPlazo(p.meses, Number(e.target.value) || 0)}
                    className="w-24 bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-sm text-white text-right font-bold"
                  />
                </div>
                <p className="text-[10px] text-gray-500">
                  Defecto: {defecto}%
                  {personalizada && <span className="text-violet-300"> · base personalizada: {draft.tasasPersonalizadas[p.meses]}%</span>}
                  {draft.ajusteGlobalPct !== 0 && <span> · ajuste global {draft.ajusteGlobalPct > 0 ? '+' : ''}{draft.ajusteGlobalPct} p.p.</span>}
                </p>
                {personalizada && (
                  <button
                    type="button"
                    onClick={() => restablecerPlazo(p.meses)}
                    className="text-[10px] text-violet-300 underline underline-offset-2"
                  >
                    Volver al valor por defecto ({defecto}%)
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={() => setDraft(CONFIG_TASAS_MENSUAL_VACIO)}
          className="flex-1 bg-gray-700 text-white rounded-xl py-3 font-semibold active:scale-95"
        >
          Restablecer todo
        </button>
        <button type="button" onClick={onCerrar} className="flex-1 bg-gray-800 border border-gray-600 text-white rounded-xl py-3 font-semibold">
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => onGuardar(draft)}
          className="flex-1 bg-violet-600 text-white rounded-xl py-3 font-bold active:scale-95"
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function CalculadoraPlanesCreditoMensual({ configTasasMensual = CONFIG_TASAS_MENSUAL_VACIO }: { configTasasMensual?: ConfigTasasMensual }) {
  const [monto, setMonto] = useState('');
  const [cuotas, setCuotas] = useState<number>(PLAN_MENSUAL_OPCIONES[0]);
  const planOpciones = useMemo(() => listadoPlanMensualPlazoTasa(configTasasMensual), [configTasasMensual]);
  const tasaInteres = String(tasaInteresMensualPorMeses(cuotas, configTasasMensual));
  const montoSolicitado = redondearPesos(Number(monto) || 0);
  const interesPorcentaje = Number(tasaInteres) || 0;
  const total = redondearPesos(montoSolicitado + redondearPesos(montoSolicitado * (interesPorcentaje / 100)));
  const montosCuota = distribuirMontoEnCuotas(total, cuotas);
  const valorCuota = montosCuota[0] ?? 0;
  return (
    <div className="rounded-2xl border border-teal-500/30 bg-teal-950/20 p-4 space-y-3">
      <p className="text-xs text-teal-100/80">
        Simulación de cuotas mensuales (solo referencia).
        {(configTasasMensual.ajusteGlobalPct !== 0 || cantidadTasasMensualPersonalizadas(configTasasMensual) > 0) && (
          <span className="block mt-1 text-violet-200/90">
            {configTasasMensual.ajusteGlobalPct !== 0 && (
              <>Ajuste general: {configTasasMensual.ajusteGlobalPct > 0 ? '+' : ''}{configTasasMensual.ajusteGlobalPct} p.p. </>
            )}
            {cantidadTasasMensualPersonalizadas(configTasasMensual) > 0 && (
              <>{cantidadTasasMensualPersonalizadas(configTasasMensual)} plan(es) con tasa personalizada</>
            )}
          </span>
        )}
      </p>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Capital solicitado</label>
        <input type="number" value={monto} onChange={e => setMonto(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white" placeholder="0" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Interés (%)</label>
          <input type="number" value={tasaInteres} readOnly className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white opacity-80" />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Cuotas mensuales</label>
          <select value={cuotas} onChange={e => setCuotas(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white">
            {planOpciones.map(p => (
              <option key={p.meses} value={p.meses}>{p.meses} {p.meses === 1 ? 'mes' : 'meses'} · {p.tasaPct}%</option>
            ))}
          </select>
        </div>
      </div>
      {montoSolicitado > 0 && (
        <div className="bg-gray-900/60 rounded-xl p-3 text-center space-y-1">
          <p className="text-xs text-gray-400">Total con interés</p>
          <p className="text-2xl font-bold text-teal-300">{fmt(total)}</p>
          <p className="text-sm text-gray-300">Cuota mensual aprox.: <strong>{fmt(valorCuota)}</strong></p>
        </div>
      )}
    </div>
  );
}

function RecibosMensualesLista({
  pagos,
  clientes,
  onVerRecibo,
}: {
  pagos: PagoRegistro[];
  clientes: Cliente[];
  onVerRecibo: (p: PagoRegistro) => void;
}) {
  const mesRef = hoy().slice(0, 7);
  const pagosMes = useMemo(
    () => pagos
      .filter(p => !p.esRegistroNoPago && redondearPesos(Number(p.monto) || 0) > 0)
      .filter(p => String(p.fecha || p.fechaPago || '').slice(0, 7) === mesRef)
      .sort((a, b) => String(b.fechaPago || b.fecha).localeCompare(String(a.fechaPago || a.fecha))),
    [pagos, mesRef],
  );
  const totalMes = useMemo(
    () => redondearPesos(pagosMes.reduce((s, p) => s + redondearPesos(Number(p.monto) || 0), 0)),
    [pagosMes],
  );
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-4">
        <h2 className="text-lg font-bold text-amber-100">🧾 Recibos del mes</h2>
        <p className="text-xs text-amber-200/70 mt-1">Cobros registrados en {mesRef} · Total: {fmt(totalMes)}</p>
      </div>
      {pagosMes.length === 0 && (
        <p className="text-sm text-gray-500 text-center py-8">No hay cobros con recibo en el mes actual.</p>
      )}
      <div className="space-y-2">
        {pagosMes.map(p => {
          const cli = clientes.find(c => normalizarId(c.id) === normalizarId(p.clienteId));
          return (
            <div key={String(p.id ?? `${p.clienteId}-${p.fecha}-${p.monto}`)} className="bg-gray-800/60 rounded-xl p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{nombreCompletoCliente(cli) || p.clienteId}</p>
                <p className="text-xs text-gray-400">{String(p.fecha || '').slice(0, 10)} · {fmt(Number(p.monto) || 0)}</p>
              </div>
              <button
                type="button"
                onClick={() => onVerRecibo(p)}
                className="shrink-0 rounded-lg bg-amber-600/80 px-3 py-2 text-xs font-bold text-white active:scale-95"
              >
                Ver recibo
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalculadoraPlanesCredito({ puedeEditarTasa = true, tasaFija = 30 }: { puedeEditarTasa?: boolean; tasaFija?: number }) {
  const [monto, setMonto] = useState('');
  const [plan, setPlan] = useState<'Semanal' | 'Diario'>('Semanal');
  const [tasaInteres, setTasaInteres] = useState(String(tasaFija));
  useEffect(() => {
    if (!puedeEditarTasa) setTasaInteres(String(tasaFija));
  }, [puedeEditarTasa, tasaFija]);
  const [compartirSoloSeleccionado, setCompartirSoloSeleccionado] = useState(false);
  const tarjetaCapturaRef = useRef<HTMLDivElement | null>(null);
  const cuotasOpciones = plan === 'Semanal' ? PLAN_SEMANAL_OPCIONES : PLAN_DIARIO_OPCIONES;
  const [cuotas, setCuotas] = useState(cuotasOpciones[0]);
  useEffect(() => {
    setCuotas(cuotasOpciones[0]);
  }, [plan]);
  const montoSolicitado = redondearPesos(Number(monto) || 0);
  const interesPorcentaje = Number(tasaInteres) || 0;
  const interes = redondearPesos(montoSolicitado * (interesPorcentaje / 100));
  const total = redondearPesos(montoSolicitado + interes);
  const montosCuotaSel = distribuirMontoEnCuotas(total, cuotas);
  const valorCuota = cuotas > 0 ? (montosCuotaSel[0] ?? 0) : 0;
  const esPlazoEspecial = (n: number) => (plan === 'Semanal' ? n === 44 : n === 286);
  const textoPlazoBase = (n: number) => (plan === 'Semanal' ? `${n} semanas` : `${n} días`);
  const etiquetaPlazo = (n: number) => {
    const base = textoPlazoBase(n);
    return esPlazoEspecial(n) ? `${base} (Especial)` : base;
  };
  const planEspecialCuotaInsuficiente = esPlazoEspecial(cuotas) && montoSolicitado > 0 && montosCuotaSel.length > 0
    && Math.min(...montosCuotaSel) > 0 && Math.min(...montosCuotaSel) < MONTO_CUOTA_MIN_PLAN_ESPECIAL;
  const etiquetaMontoCuota = plan === 'Semanal' ? 'Monto semanal' : 'Monto diario';
  const crearImagenPlanCredito = async () => {
    const nodo = tarjetaCapturaRef.current;
    if (!nodo) throw new Error('No se encontró la tarjeta de simulación para generar la imagen.');
    const html2canvasModule = await import('html2canvas');
    const html2canvas = html2canvasModule.default;
    const canvas = await html2canvas(nodo, html2canvasOpcionesSeguras('#f8fafc'));
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('No se pudo generar la tarjeta del plan.')), 'image/png', 1);
    });
    return new File([blob], `Plan_Credito_${hoy()}.png`, { type: 'image/png' });
  };
  const descargarArchivoLocal = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const compartirPlan = async () => {
    if (montoSolicitado <= 0) {
      alert('Ingresá un monto para compartir la simulación.');
      return;
    }
    if (planEspecialCuotaInsuficiente) {
      alert(`Para el plan especial el monto por cuota no puede ser menor a ${fmt(MONTO_CUOTA_MIN_PLAN_ESPECIAL)}. Aumentá el capital o elegí otro plazo.`);
      return;
    }
    try {
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const file = await crearImagenPlanCredito();
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        await navigator.share({ files: [file] });
        return;
      }
      descargarArchivoLocal(file);
      // Cero texto: se abre WhatsApp sin mensaje para adjuntar solo la tarjeta.
      window.open('https://wa.me/', '_blank');
    } catch (error: any) {
      console.error('Error compartiendo plan de crédito:', error);
      alert(error?.message || 'No se pudo generar la tarjeta del plan.');
    }
  };
  return (
    <>
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: -1,
      }}
    >
    <div
      ref={tarjetaCapturaRef}
      style={{
        position: 'absolute',
        left: '-9999px',
        top: '0',
        width: '720px',
        minHeight: compartirSoloSeleccionado ? '1280px' : 'auto',
        backgroundColor: '#f8fafc',
        color: '#0f172a',
        border: '1px solid #e2e8f0',
        borderRadius: '28px',
        padding: '28px',
        fontFamily: 'Inter, Roboto, Arial, sans-serif',
        pointerEvents: 'none',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ backgroundColor: '#1e293b', color: '#f8fafc', borderRadius: '18px', padding: '16px 18px', textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: '13px', letterSpacing: '0.9px', fontWeight: 800 }}>{MARCA_PRIMARIA}</p>
        <p style={{ margin: '4px 0 0', fontSize: '11px', letterSpacing: '0.12em', fontWeight: 300, color: '#bae6fd' }}>{MARCA_DESCRIPTOR}</p>
      </div>
      <div
        style={{
          marginTop: '18px',
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '22px',
          boxShadow: '0 14px 30px rgba(15, 23, 42, 0.10)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid #e2e8f0' }}>
          <h3 style={{ margin: 0, fontSize: '28px', fontWeight: 900, color: '#0f172a', letterSpacing: '0.5px' }}>SIMULACIÓN DE PLAN</h3>
          <p style={{ margin: '8px 0 0', fontSize: '15px', color: '#0f172a', fontWeight: 800 }}>
            {plan === 'Diario' ? 'Plan Diario' : 'Plan Semanal'}
          </p>
        </div>

        {compartirSoloSeleccionado ? (
          <>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e2e8f0' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Capital solicitado</p>
              <p style={{ margin: '8px 0 0', fontSize: '38px', lineHeight: 1.08, fontWeight: 900, color: '#0f172a' }}>{fmt(montoSolicitado)}</p>
            </div>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e2e8f0' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Plazo</p>
              <p style={{ margin: '8px 0 0', fontSize: '38px', lineHeight: 1.08, fontWeight: 900, color: '#0f172a' }}>
                {esPlazoEspecial(cuotas) ? (
                  <>
                    <span style={{ color: '#0f172a' }}>{textoPlazoBase(cuotas)}</span>
                    <span style={{ color: PALETA_TEXTO_PLAN_ESPECIAL }}>{' '} (Especial)</span>
                  </>
                ) : (
                  textoPlazoBase(cuotas)
                )}
              </p>
            </div>
            <div style={{ padding: '18px 22px' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#334155', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{etiquetaMontoCuota}</p>
              <p style={{ margin: '8px 0 0', fontSize: '38px', lineHeight: 1.08, fontWeight: 900, color: '#059669' }}>{fmt(valorCuota)}</p>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid #e2e8f0' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#334155', fontWeight: 700, textTransform: 'uppercase' }}>Capital solicitado</p>
              <p style={{ margin: '6px 0 0', fontSize: '36px', fontWeight: 900, color: '#0f172a' }}>{fmt(montoSolicitado)}</p>
            </div>
            <div style={{ padding: '16px 22px 8px' }}>
              <p style={{ margin: '0 0 10px', fontSize: '13px', color: '#334155', fontWeight: 800, textTransform: 'uppercase' }}>Opciones de cuota (mismo capital)</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '15px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                    <th style={{ textAlign: 'left', padding: '10px 8px', color: '#64748b', fontWeight: 800 }}>Plazo</th>
                    <th style={{ textAlign: 'right', padding: '10px 8px', color: '#64748b', fontWeight: 800 }}>{etiquetaMontoCuota}</th>
                  </tr>
                </thead>
                <tbody>
                  {cuotasOpciones.map((n) => {
                    const sel = n === cuotas;
                    const vc = n > 0 ? (distribuirMontoEnCuotas(total, n)[0] ?? 0) : 0;
                    return (
                      <tr
                        key={n}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          backgroundColor: sel ? 'rgba(5, 150, 105, 0.08)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '12px 8px', fontWeight: sel ? 900 : 600, color: '#0f172a' }}>
                          {esPlazoEspecial(n) ? (
                            <>
                              <span style={{ color: '#0f172a' }}>{textoPlazoBase(n)}</span>
                              <span style={{ color: PALETA_TEXTO_PLAN_ESPECIAL, fontWeight: 900 }}>{' '} (Especial)</span>
                            </>
                          ) : (
                            textoPlazoBase(n)
                          )}
                        </td>
                        <td style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 900, color: '#059669' }}>{fmt(vc)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <BrandingFooter align="end" variant="light" marcaPrimaria={MARCA_PRIMARIA} descriptor={MARCA_DESCRIPTOR} />
    </div>
    </div>
    <div
      className="rounded-2xl p-4 space-y-3"
      style={{ backgroundColor: '#111827', border: '1px solid #065f46', color: '#e5e7eb' }}
    >
      <div>
        <h3 className="font-bold text-sm" style={{ color: '#a7f3d0' }}>🧮 Simulador de Créditos</h3>
        <p className="text-xs" style={{ color: '#94a3b8' }}>Montos en pesos enteros; la última cuota ajusta diferencias de redondeo. Interés por defecto 30%.</p>
      </div>
      <div>
        <p className="text-xs mb-1.5" style={{ color: '#94a3b8' }}>Tipo de plan</p>
        <div className="flex rounded-xl p-1 gap-1" style={{ backgroundColor: '#1f2937', border: '1px solid #374151' }}>
          <button
            type="button"
            onClick={() => setPlan('Diario')}
            className="flex-1 rounded-lg py-2 text-xs font-bold transition-all"
            style={{
              backgroundColor: plan === 'Diario' ? '#059669' : 'transparent',
              color: plan === 'Diario' ? '#ffffff' : '#94a3b8',
            }}
          >
            Plan Diario
          </button>
          <button
            type="button"
            onClick={() => setPlan('Semanal')}
            className="flex-1 rounded-lg py-2 text-xs font-bold transition-all"
            style={{
              backgroundColor: plan === 'Semanal' ? '#059669' : 'transparent',
              color: plan === 'Semanal' ? '#ffffff' : '#94a3b8',
            }}
          >
            Plan Semanal
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="text-xs block mb-1" style={{ color: '#94a3b8' }}>Monto solicitado</label>
          <input
            type="number"
            value={monto}
            onChange={e => setMonto(e.target.value)}
            className="w-full rounded-xl px-3 py-2 focus:outline-none"
            style={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#ffffff' }}
            placeholder="0"
          />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: '#94a3b8' }}>Cuotas</label>
          <select value={cuotas} onChange={e => setCuotas(Number(e.target.value))} className="w-full rounded-xl px-3 py-2 focus:outline-none" style={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#ffffff' }}>
            {cuotasOpciones.map(v => (
              <option key={v} value={v}>{etiquetaPlazo(v)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: '#94a3b8' }}>Tasa (%)</label>
          <input
            type="number"
            value={tasaInteres}
            onChange={e => setTasaInteres(e.target.value)}
            readOnly={!puedeEditarTasa}
            disabled={!puedeEditarTasa}
            className="w-full rounded-xl px-3 py-2 focus:outline-none disabled:opacity-70"
            style={{ backgroundColor: '#1f2937', border: '1px solid #374151', color: '#ffffff' }}
            placeholder="30"
          />
          {!puedeEditarTasa && (
            <p className="text-[10px] mt-1" style={{ color: '#94a3b8' }}>Tasa fijada por el administrador.</p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="rounded-xl p-3" style={{ backgroundColor: '#1f2937' }}>
          <p className="text-[11px]" style={{ color: '#94a3b8' }}>Capital</p>
          <p className="font-bold" style={{ color: '#ffffff' }}>{fmt(montoSolicitado)}</p>
        </div>
        <div className="rounded-xl p-3" style={{ backgroundColor: '#1f2937' }}>
          <p className="text-[11px]" style={{ color: '#94a3b8' }}>Interés ({interesPorcentaje.toFixed(2)}%)</p>
          <p className="font-bold" style={{ color: '#fcd34d' }}>{fmt(interes)}</p>
        </div>
        <div className="rounded-xl p-3" style={{ backgroundColor: '#1f2937' }}>
          <p className="text-[11px]" style={{ color: '#94a3b8' }}>Total a devolver</p>
          <p className="font-bold" style={{ color: '#93c5fd' }}>{fmt(total)}</p>
        </div>
        <div className="rounded-xl p-3" style={{ backgroundColor: '#1f2937' }}>
          <p className="text-[11px]" style={{ color: '#94a3b8' }}>Cuotas</p>
          <p className="font-bold" style={{ color: '#67e8f9' }}>{cuotas}</p>
        </div>
        <div className="rounded-xl p-3" style={{ backgroundColor: '#052e2b', border: '1px solid #047857' }}>
          <p className="text-[11px]" style={{ color: '#a7f3d0' }}>{etiquetaMontoCuota}</p>
          <p className="font-black" style={{ color: '#6ee7b7' }}>{fmt(valorCuota)}</p>
        </div>
      </div>
      {planEspecialCuotaInsuficiente && (
        <p className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          Plan especial: cada cuota debe ser al menos {fmt(MONTO_CUOTA_MIN_PLAN_ESPECIAL)}. Subí el monto o cambiá el plazo.
        </p>
      )}
      <label className="flex items-center gap-2 cursor-pointer select-none text-xs" style={{ color: '#94a3b8' }}>
        <input
          type="checkbox"
          checked={compartirSoloSeleccionado}
          onChange={e => setCompartirSoloSeleccionado(e.target.checked)}
          className="rounded border-gray-600"
          style={{ accentColor: '#22c55e' }}
        />
        En la tarjeta, compartir solo el plazo seleccionado arriba (si no, se envían todas las opciones del plan)
      </label>
      <button
        type="button"
        onClick={compartirPlan}
        disabled={planEspecialCuotaInsuficiente}
        className="w-full rounded-xl py-3 font-bold active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ backgroundColor: '#22c55e', color: '#ffffff' }}
      >
        Compartir Plan
      </button>
    </div>
    </>
  );
}

const PREFIJO_CELULAR_AR_DEFAULT = '549';

/** Valor inicial en formularios: solo dígitos o `549` si está vacío. */
function valorInicialCampoCelular(guardado: string | undefined | null): string {
  const d = soloDigitosTelefono(String(guardado ?? ''));
  return d.length > 0 ? d : PREFIJO_CELULAR_AR_DEFAULT;
}

function BloqueVideoVerificacionNegocioAdmin({ cliente }: { cliente: Partial<Cliente> | null | undefined }) {
  if (!videoVerificacionClienteVigente(cliente ?? undefined)) {
    const url = String(cliente?.videoVerificacionUrl || '').trim();
    if (url) {
      return (
        <p className="text-xs text-gray-500 rounded-xl border border-gray-700 bg-gray-800/40 p-3">
          El video de verificación del negocio ya expiró (retención máxima {DIAS_RETENCION_VIDEO_CLIENTE} días).
        </p>
      );
    }
    return null;
  }
  const url = String(cliente?.videoVerificacionUrl || '').trim();
  const expira = String(cliente?.videoVerificacionExpiraAt || '').slice(0, 10);
  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-950/20 p-3 space-y-2">
      <p className="text-sm font-semibold text-violet-100">Video del negocio (verificación de crédito)</p>
      <video src={url} controls playsInline className="w-full rounded-xl max-h-72 bg-black" />
      {expira && (
        <p className="text-[10px] text-gray-500">
          Disponible hasta {expira} · se elimina automáticamente a los {DIAS_RETENCION_VIDEO_CLIENTE} días
        </p>
      )}
    </div>
  );
}

function ClienteForm({
  cliente,
  edicionClienteUuidEnServidor = false,
  mostrarOrdenRuta,
  modoEdicionSoloContacto,
  onSave,
  onCancel,
  onGeoCoords,
}: {
  cliente: Partial<Cliente>;
  /** True si el modal es edición de un cliente ya persistido (UUID en servidor). */
  edicionClienteUuidEnServidor?: boolean;
  /** Solo admin/root: prioridad numérica en la hoja de ruta cuando no hay GPS. */
  mostrarOrdenRuta?: boolean;
  /** MatiasM/Vendedor en cliente ya guardado: solo teléfono, dirección y GPS. */
  modoEdicionSoloContacto?: boolean;
  onSave: (c: Partial<Cliente>, opts?: OpcionesGuardarCliente) => void | Promise<void>;
  onCancel: () => void;
  /** GPS solo actualiza el estado local del formulario (no resetea campos por props del padre). */
  onGeoCoords: () => Promise<{ lat: number; lng: number }>;
}) {
  const [f, setF] = useState<Partial<Cliente>>(() => ({
    ...cliente,
    telefono: valorInicialCampoCelular(cliente.telefono),
  }));
  const [formError, setFormError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [archivoFrente, setArchivoFrente] = useState<File | null>(null);
  const [archivoDorso, setArchivoDorso] = useState<File | null>(null);
  const [archivoVideoNegocio, setArchivoVideoNegocio] = useState<File | null>(null);
  const [videoNegocioPreviewUrl, setVideoNegocioPreviewUrl] = useState<string | null>(null);
  const [validandoVideo, setValidandoVideo] = useState(false);
  const [geoCapturando, setGeoCapturando] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'error' | 'ok' } | null>(null);
  const toastTRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frenteRef = useRef<HTMLInputElement | null>(null);
  const dorsoRef = useRef<HTMLInputElement | null>(null);
  const videoNegocioRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      if (toastTRef.current) clearTimeout(toastTRef.current);
      if (videoNegocioPreviewUrl) URL.revokeObjectURL(videoNegocioPreviewUrl);
    },
    [videoNegocioPreviewUrl],
  );

  const mostrarToast = (msg: string, tone: 'error' | 'ok') => {
    if (toastTRef.current) clearTimeout(toastTRef.current);
    setToast({ msg, tone });
    toastTRef.current = setTimeout(() => {
      setToast(null);
      toastTRef.current = null;
    }, 7000);
  };

  const s = (k: keyof Cliente, v: any) => {
    if (formError) setFormError('');
    setF(prev => ({ ...prev, [k]: v }));
  };

  const capturarGeoEnFormulario = async () => {
    setGeoCapturando(true);
    setFormError('');
    try {
      const p = await onGeoCoords();
      setF(prev => ({ ...prev, lat: p.lat, lng: p.lng, coordenadaErr: undefined }));
    } catch {
      setF(prev => ({ ...prev, coordenadaErr: 'No se pudo obtener GPS' }));
    } finally {
      setGeoCapturando(false);
    }
  };

  const handlePickDni = (e: React.ChangeEvent<HTMLInputElement>, lado: 'frente' | 'dorso') => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (formError) setFormError('');
    /** No asignamos id en el cliente nuevo: el UUID lo devuelve Supabase tras el INSERT. */
    if (lado === 'frente') {
      setArchivoFrente(file);
      setF(prev => ({ ...prev, dniFrenteUrl: undefined }));
    } else {
      setArchivoDorso(file);
      setF(prev => ({ ...prev, dniDorsoUrl: undefined }));
    }
  };

  const handlePickVideoNegocio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (formError) setFormError('');
    if (!file.type.startsWith('video/')) {
      setFormError('Seleccioná un archivo de video (MP4, WebM, etc.).');
      return;
    }
    if (file.size > MAX_BYTES_VIDEO_CLIENTE) {
      setFormError('El video no puede superar 25 MB.');
      return;
    }
    setValidandoVideo(true);
    try {
      const dur = await obtenerDuracionVideoSegundos(file);
      if (dur <= 0 || dur > MAX_DURACION_VIDEO_CLIENTE_SEG + 0.5) {
        setFormError(`El video debe durar como máximo ${MAX_DURACION_VIDEO_CLIENTE_SEG} segundos (detectado: ${dur > 0 ? Math.ceil(dur) : '?'}s).`);
        return;
      }
      if (videoNegocioPreviewUrl) URL.revokeObjectURL(videoNegocioPreviewUrl);
      setArchivoVideoNegocio(file);
      setVideoNegocioPreviewUrl(URL.createObjectURL(file));
    } catch {
      setFormError('No se pudo leer el video. Probá con otro archivo.');
    } finally {
      setValidandoVideo(false);
    }
  };

  const quitarVideoNegocio = () => {
    if (videoNegocioPreviewUrl) URL.revokeObjectURL(videoNegocioPreviewUrl);
    setArchivoVideoNegocio(null);
    setVideoNegocioPreviewUrl(null);
  };

  const tieneDniFrenteListo = Boolean(archivoFrente || String(f.dniFrenteUrl || '').trim());
  const tieneDniDorsoListo = Boolean(archivoDorso || String(f.dniDorsoUrl || '').trim());

  const esperandoUuidServidor = Boolean(
    edicionClienteUuidEnServidor
    && String(f.id || '').trim().length > 0
    && !esUuidClienteId(String(f.id || '')),
  );

  const guardar = async () => {
    setFormError('');
    if (modoEdicionSoloContacto) {
      if (!String(f.telefono || '').trim()) {
        setFormError('Teléfono obligatorio.');
        return;
      }
      if (!String(f.direccion || '').trim()) {
        setFormError('Dirección obligatoria.');
        return;
      }
      setGuardando(true);
      try {
        await Promise.resolve(
          onSave({
            id: f.id,
            telefono: normalizarTelefonoArg549(String(f.telefono)),
            direccion: String(f.direccion || '').trim(),
            lat: f.lat,
            lng: f.lng,
            coordenadaErr: f.coordenadaErr,
          }),
        );
      } catch (err) {
        if (err instanceof SesionExpiradaSupabaseError) {
          setFormError(MSJ_SESION_EXPIRADA_CLIENTE);
        } else {
          console.error(err);
          const msg = err instanceof Error && err.message ? err.message : 'No se pudo guardar. Intentá de nuevo.';
          setFormError(msg);
        }
      } finally {
        setGuardando(false);
      }
      return;
    }
    if (esperandoUuidServidor) {
      setFormError('Sincronizando datos del cliente...');
      return;
    }
    if (!String(f.nombre || '').trim() || !String(f.apellido || '').trim() || !String(f.dni || '').trim()) {
      setFormError('Nombre, apellido y DNI son obligatorios.');
      return;
    }
    if (!String(f.telefono || '').trim() || !String(f.fechaNacimiento || '').trim()) {
      setFormError('Teléfono y Fecha de nacimiento son obligatorios.');
      return;
    }
    if (!String(f.direccion || '').trim()) {
      setFormError('La dirección es obligatoria.');
      return;
    }
    if (!tieneDniFrenteListo || !tieneDniDorsoListo) {
      setFormError('Seleccioná el frente y el dorso del DNI. Se suben al guardar (no se pierde lo que escribiste si falla).');
      return;
    }
    setGuardando(true);
    try {
      const opts: OpcionesGuardarCliente = {};
      if (archivoFrente || archivoDorso) {
        opts.dniFiles = {};
        if (archivoFrente) opts.dniFiles.frente = archivoFrente;
        if (archivoDorso) opts.dniFiles.dorso = archivoDorso;
      }
      if (archivoVideoNegocio) opts.videoNegocio = archivoVideoNegocio;
      await Promise.resolve(onSave(f, opts));
    } catch (err) {
      if (err instanceof SesionExpiradaSupabaseError) {
        setFormError(MSJ_SESION_EXPIRADA_CLIENTE);
      } else if (err instanceof ErrorSubidaDniCliente) {
        mostrarToast(err.message, 'error');
      } else {
        console.error(err);
        const msg = err instanceof Error && err.message ? err.message : 'No se pudo guardar. Intentá de nuevo.';
        setFormError(msg);
      }
    } finally {
      setGuardando(false);
    }
  };

  const soloLecturaIdentidad = Boolean(modoEdicionSoloContacto);
  return (
    <div className="relative space-y-4">
      {toast && (
        <div
          role="status"
          className={`fixed bottom-24 left-4 right-4 z-[80] rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg sm:left-auto sm:right-6 sm:max-w-md ${
            toast.tone === 'error'
              ? 'border-red-500/50 bg-red-950/95 text-red-100'
              : 'border-emerald-500/50 bg-emerald-950/95 text-emerald-100'
          }`}
        >
          {toast.msg}
        </div>
      )}
      {formError && <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">{formError}</p>}
      {esperandoUuidServidor && (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
          Sincronizando datos del cliente...
        </p>
      )}
      {modoEdicionSoloContacto && (
        <p className="rounded-xl border border-cyan-500/30 bg-cyan-950/30 p-3 text-xs text-cyan-100/90">
          Podés actualizar solo datos de contacto (teléfono y dirección). Los demás datos los gestiona el administrador.
        </p>
      )}
      <div><label className="text-xs text-gray-400 block mb-1">Nombre *</label><input readOnly={soloLecturaIdentidad} value={f.nombre || ''} onChange={e => s('nombre', e.target.value)} className={`w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 ${soloLecturaIdentidad ? 'opacity-60 cursor-not-allowed' : ''}`} placeholder="Nombre completo" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">Apellido *</label><input readOnly={soloLecturaIdentidad} value={f.apellido || ''} onChange={e => s('apellido', e.target.value)} className={`w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 ${soloLecturaIdentidad ? 'opacity-60 cursor-not-allowed' : ''}`} placeholder="Apellido" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">DNI *</label><input readOnly={soloLecturaIdentidad} value={f.dni || ''} onChange={e => s('dni', e.target.value)} className={`w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 ${soloLecturaIdentidad ? 'opacity-60 cursor-not-allowed' : ''}`} placeholder="Número de DNI" /></div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Teléfono (celular) <span className="text-red-400">*</span></label>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          required
          value={f.telefono ?? ''}
          onChange={e => s('telefono', soloDigitosTelefono(e.target.value))}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500"
          placeholder="5491123456789"
        />
      </div>
      <div><label className="text-xs text-gray-400 block mb-1">Fecha de nacimiento <span className="text-red-400">*</span></label><input readOnly={soloLecturaIdentidad} required={!modoEdicionSoloContacto} type="date" value={f.fechaNacimiento || ''} onChange={e => s('fechaNacimiento', e.target.value)} className={`w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 ${soloLecturaIdentidad ? 'opacity-60 cursor-not-allowed' : ''}`} /></div>
      <div><label className="text-xs text-gray-400 block mb-1">Dirección *</label><input value={f.direccion || ''} onChange={e => s('direccion', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" placeholder="Dirección" /></div>
      {mostrarOrdenRuta && (
        <div>
          <label className="text-xs text-gray-400 block mb-1">Prioridad en ruta (1 = primero)</label>
          <input
            type="number"
            min={1}
            step={1}
            value={f.orden_ruta ?? ''}
            onChange={e => {
              const v = e.target.value;
              if (v === '') { s('orden_ruta', null); return; }
              const n = parseInt(v, 10);
              s('orden_ruta', Number.isFinite(n) ? n : null);
            }}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500"
            placeholder="Vacío = sin prioridad manual"
          />
          <p className="text-[10px] text-gray-500 mt-1">Si el cobrador no tiene GPS, se usa este número (menor antes). Con GPS activo en la pestaña Ruta manda la cercanía.</p>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void capturarGeoEnFormulario()}
          disabled={geoCapturando}
          className="flex-1 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-xl py-3 text-sm font-semibold active:scale-95 transition"
        >
          {geoCapturando ? '⏳...' : '📍 Capturar GPS'}
        </button>
        {f.lat != null && f.lng != null && (
          <span className="text-xs text-gray-500 self-center">
            {f.lat?.toFixed(4)}, {f.lng?.toFixed(4)}
          </span>
        )}
      </div>
      {f.coordenadaErr && <p className="text-xs text-red-400">{f.coordenadaErr}</p>}
      {!modoEdicionSoloContacto && (
      <>
      <div className="space-y-2 rounded-xl border border-gray-700 bg-gray-800/40 p-3">
        <p className="text-sm font-semibold text-gray-200">Documentación</p>
        <p className="text-[11px] text-gray-400">
          Las fotos del DNI se suben al almacenamiento solo al tocar Guardar, después de validar la sesión. Si la subida falla, no se crea el registro y tus datos siguen en el formulario.
        </p>
        <input ref={frenteRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePickDni(e, 'frente')} />
        <input ref={dorsoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePickDni(e, 'dorso')} />
        <button type="button" onClick={() => frenteRef.current?.click()} disabled={guardando} className="w-full bg-indigo-500 disabled:bg-indigo-500/50 text-white rounded-xl py-4 text-base font-bold active:scale-95 transition">
          {archivoFrente ? `Frente: ${archivoFrente.name}` : 'Capturar Frente DNI'}
        </button>
        <button type="button" onClick={() => dorsoRef.current?.click()} disabled={guardando} className="w-full bg-indigo-500/85 disabled:bg-indigo-500/40 text-white rounded-xl py-4 text-base font-bold active:scale-95 transition">
          {archivoDorso ? `Dorso: ${archivoDorso.name}` : 'Capturar Dorso DNI'}
        </button>
        {!!f.dniFrenteUrl && (
          <a href={f.dniFrenteUrl} target="_blank" rel="noreferrer" className="block text-xs text-green-400">
            Frente en servidor (link)
          </a>
        )}
        {!!f.dniDorsoUrl && (
          <a href={f.dniDorsoUrl} target="_blank" rel="noreferrer" className="block text-xs text-green-400">
            Dorso en servidor (link)
          </a>
        )}
      </div>
      <div className="space-y-2 rounded-xl border border-violet-500/25 bg-violet-950/15 p-3">
        <p className="text-sm font-semibold text-violet-100">Video del negocio (opcional)</p>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Grabá un recorrido breve del local o negocio (máx. {MAX_DURACION_VIDEO_CLIENTE_SEG} segundos). El administrador lo usa para evaluar si es apto para un crédito. Se guarda {DIAS_RETENCION_VIDEO_CLIENTE} días y luego se elimina solo.
        </p>
        <input
          ref={videoNegocioRef}
          type="file"
          accept="video/*"
          capture="environment"
          className="hidden"
          onChange={e => void handlePickVideoNegocio(e)}
        />
        <button
          type="button"
          onClick={() => videoNegocioRef.current?.click()}
          disabled={guardando || validandoVideo}
          className="w-full bg-violet-600/80 disabled:bg-violet-600/40 text-white rounded-xl py-3 text-sm font-bold active:scale-95 transition"
        >
          {validandoVideo ? 'Validando video…' : archivoVideoNegocio ? `Video: ${archivoVideoNegocio.name}` : '🎥 Subir video del negocio'}
        </button>
        {videoNegocioPreviewUrl && (
          <div className="space-y-2">
            <video src={videoNegocioPreviewUrl} controls playsInline className="w-full rounded-xl max-h-48 bg-black" />
            <button type="button" onClick={quitarVideoNegocio} className="text-xs text-red-300 underline">Quitar video</button>
          </div>
        )}
        {!archivoVideoNegocio && videoVerificacionClienteVigente(f) && (
          <div className="space-y-1">
            <video src={f.videoVerificacionUrl} controls playsInline className="w-full rounded-xl max-h-48 bg-black" />
            <p className="text-[10px] text-gray-500">Video actual en servidor (vigente hasta {String(f.videoVerificacionExpiraAt || '').slice(0, 10) || '—'})</p>
          </div>
        )}
      </div>
      </>
      )}
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button
          type="button"
          onClick={() => void guardar()}
          disabled={guardando || esperandoUuidServidor}
          className="flex-1 inline-flex items-center justify-center gap-2 bg-indigo-500 disabled:bg-indigo-500/50 text-white font-bold py-3 rounded-xl active:scale-95 transition-all disabled:cursor-not-allowed"
        >
          {guardando ? (
            <>
              <span
                className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white"
                aria-hidden
              />
              Cargando...
            </>
          ) : (
            <>💾 Guardar</>
          )}
        </button>
        <button type="button" onClick={() => { onCancel(); }} className="flex-1 bg-gray-700 text-white font-bold py-3 rounded-xl active:scale-95 transition-all">Cancelar</button>
      </div>
    </div>
  );
}

function FichaForm({ ficha, cliente, clientes, onSave, onTab, onSetTab, onEliminarPago, puedeEliminarPagos = true }: { ficha?: Ficha; cliente: Cliente | null; clientes: Cliente[]; onSave: (f: Partial<Ficha>) => void; onTab: number; onSetTab: (t: number) => void; onEliminarPago: (ficha: Ficha, idx: number) => void; puedeEliminarPagos?: boolean }) {
  const [f, setF] = useState<Partial<Ficha>>(() => ficha || { clienteId: cliente?.id || '', tipo: 'prestamo', montoTotal: 0, cuotas: 4, costo: 0, plan_pago: 'Mensual' });
  const s = (k: keyof Ficha, v: any) => setF(prev => ({ ...prev, [k]: v }));
  return (
    <div className="space-y-4">
      <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
        {['Datos', 'Cara B'].map((t, i) => (
          <button key={i} onClick={() => onSetTab(i)} className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${onTab === i ? 'bg-indigo-500 text-white' : 'text-gray-400'}`}>{t}</button>
        ))}
      </div>
      {onTab === 0 && (
        <div className="space-y-4">
          {!ficha && (<div><label className="text-xs text-gray-400 block mb-1">Cliente</label><select id="selCliente" value={f.clienteId || ''} onChange={e => s('clienteId', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500"><option value="">Seleccionar...</option>{clientes.map(c => <option key={c?.id ?? ''} value={c?.id ?? ''}>{nombreCompletoCliente(c) ?? '—'}</option>)}</select></div>)}
          <div><label className="text-xs text-gray-400 block mb-1">Tipo</label><select value={f.tipo || 'prestamo'} onChange={e => s('tipo', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500"><option value="prestamo">💳 Préstamo</option><option value="venta">🛒 Venta</option></select></div>
          <div><label className="text-xs text-gray-400 block mb-1">Monto Total</label><input type="number" value={f.montoTotal || ''} onChange={e => s('montoTotal', parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" /></div>
          <div><label className="text-xs text-gray-400 block mb-1">Producto</label><input value={String(f.producto || '')} onChange={e => s('producto', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" placeholder="Ej: Heladera, Electrodoméstico, Préstamo en efectivo..." /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-gray-400 block mb-1">Costo</label><input type="number" value={f.costo || ''} onChange={e => s('costo', parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" /></div>
            <div><label className="text-xs text-gray-400 block mb-1">Cuotas</label><input type="number" value={f.cuotas || 4} onChange={e => s('cuotas', parseInt(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" /></div>
          </div>
          <div><label className="text-xs text-gray-400 block mb-1">Plan de pago (vencimientos / dorso)</label><select value={f.plan_pago || 'Mensual'} onChange={e => s('plan_pago', e.target.value as PlanPago)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500"><option value="Diario">Diario (domingos tachados en grilla)</option><option value="Quincenal">Quincenal (cada 15 días)</option><option value="Mensual">Mensual (cierre de mes)</option></select></div>
          {f.montoTotal && f.cuotas && <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-3 text-center"><p className="text-xs text-indigo-400">Precio Venta</p><p className="text-2xl font-bold text-indigo-300">{fmt(redondearPesos((f.montoTotal || 0) * 1.3))}</p><p className="text-xs text-indigo-400/60">Ganancia: {fmt(redondearPesos((f.montoTotal || 0) * 0.3))}</p></div>}
        </div>
      )}
      {onTab === 1 && ficha && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400 text-center">Grilla de Cobros - {nombreCompletoCliente(cliente)}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-800">
                  <th className="p-2 text-left">Día</th><th className="p-2 text-left">Fecha</th><th className="p-2 text-center">Estado</th><th className="p-2 text-right">Monto</th><th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {generarPlanillaFicha(ficha).map((row, i) => {
                  const p = ficha.pagos[i];
                  const fecha = row.vencimiento;
                  const dom = row.esDomingo;
                  return (
                    <tr key={i} className={`border-t border-gray-800 ${dom ? 'line-through decoration-red-400/80 opacity-75' : ''} ${row.pagada ? 'bg-green-500/5' : row.vencida ? 'bg-red-500/5' : ''}`}>
                      <td className="p-2">{i + 1}</td>
                      <td className="p-2">{fecha}{dom ? ' · Dom' : ''}</td>
                      <td className="p-2 text-center">{dom ? '—' : row.pagada ? '✅' : row.vencida ? '🚩' : '⏳'}</td>
                      <td className="p-2 text-right font-semibold">{p ? `${fmt(p.monto)}` : fmt(row.monto)}</td>
                      <td className="p-2">{puedeEliminarPagos && p && <button type="button" onClick={() => onEliminarPago(ficha, i)} className="text-red-400 text-xs">✕</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {onTab === 0 && (
        <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
          <button onClick={() => onSave(f)} className="flex-1 bg-indigo-500 text-white font-bold py-3 rounded-xl active:scale-95 transition-all">💾 Guardar</button>
        </div>
      )}
    </div>
  );
}

function GastoForm({ onSave }: { onSave: (g: Partial<Gasto>) => void }) {
  const [cat, setCat] = useState('Combustible'); const [monto, setMonto] = useState(''); const [nota, setNota] = useState('');
  return (
    <div className="space-y-4">
      <div><label className="text-xs text-gray-400 block mb-1">Categoría</label>
        <select value={cat} onChange={e => setCat(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500">
          {['Combustible', 'Comida', 'Reparaciones', 'Otros'].map(c => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div><label className="text-xs text-gray-400 block mb-1">Monto</label><input type="number" value={monto} onChange={e => setMonto(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" placeholder="$0.00" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">Nota</label><input value={nota} onChange={e => setNota(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" placeholder="Descripción..." /></div>
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button onClick={() => { if (!monto) return; onSave({ categoria: cat, monto: parseFloat(monto), nota }); }} className="flex-1 bg-orange-500 text-white font-bold py-3 rounded-xl active:scale-95 transition-all">💾 Registrar Gasto</button>
      </div>
    </div>
  );
}

function JornadaForm({
  totalCobrado,
  totalGastos,
  netoEntregar,
  gpsLoading,
  gpsPos,
  instruccionesGps = null,
  esMarcosP = false,
  onCapturarGPS,
  onSubmit,
}: {
  totalCobrado: number;
  totalGastos: number;
  netoEntregar: number;
  gpsLoading: boolean;
  gpsPos: any;
  instruccionesGps?: string | null;
  esMarcosP?: boolean;
  onCapturarGPS: () => void | Promise<void>;
  onSubmit: (montoFisico: number, kmFin?: number, novedades?: string) => void | Promise<void>;
}) {
  const [montoFisico, setMontoFisico] = useState(String(Math.max(0, netoEntregar)));
  const [kmFin, setKmFin] = useState('');
  const [novedades, setNovedades] = useState('');
  const efectivo = redondearPesos(parseFloat(montoFisico) || 0);
  const diferencia = redondearPesos(efectivo - netoEntregar);
  const cierreBueno = diferencia >= -50 && diferencia <= 50;
  const requiereNovedades = !cierreBueno;
  const gpsOkReal = Boolean(gpsPos && (Number(gpsPos.lat) !== 0 || Number(gpsPos.lng) !== 0));
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-gray-500 text-center">Jornada calendario 00:00–00:00 (día local). Neto = cobrado − gastos operativos.</p>
      {instruccionesGps && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100 leading-relaxed">
          <p className="font-semibold text-amber-200 mb-1">Ubicación bloqueada</p>
          <p>{instruccionesGps}</p>
        </div>
      )}
      {esMarcosP && gpsPos && !gpsOkReal && (
        <p className="text-xs text-violet-300 rounded-lg border border-violet-500/30 bg-violet-950/30 px-3 py-2">Modo administrador: cierre sin coordenadas GPS reales (0,0). Solo para pruebas o escritorio.</p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void Promise.resolve(onCapturarGPS())} disabled={gpsLoading} className={`text-xs px-3 py-2 rounded-xl font-semibold active:scale-95 transition ${gpsOkReal ? 'bg-green-500/20 text-green-400' : 'bg-gray-800 text-gray-400'}`}>
          {gpsLoading ? '⏳ GPS...' : gpsOkReal ? '✅ GPS OK' : '📍 Capturar GPS'}
        </button>
        {gpsPos && <span className="text-xs text-gray-500">{gpsPos.lat.toFixed(4)}, {gpsPos.lng.toFixed(4)}</span>}
      </div>
      <div className="grid grid-cols-1 gap-2">
        <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-3 text-center">
          <p className="text-xs text-indigo-400">Total cobrado (hoy)</p>
          <p className="text-2xl font-bold text-indigo-300">{fmt(totalCobrado)}</p>
        </div>
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 text-center">
          <p className="text-xs text-orange-300">Gastos operativos (hoy)</p>
          <p className="text-2xl font-bold text-orange-200">− {fmt(totalGastos)}</p>
        </div>
        <div className="bg-emerald-500/15 border border-emerald-500/35 rounded-xl p-4 text-center">
          <p className="text-xs text-emerald-300 font-semibold uppercase tracking-wide">Neto a entregar</p>
          <p className="text-3xl font-black text-emerald-300">{fmt(netoEntregar)}</p>
        </div>
      </div>
      <div><label className="text-xs text-gray-400 block mb-1">Efectivo físico contado *</label><input type="number" value={montoFisico} onChange={e => setMontoFisico(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-xl font-bold focus:outline-none focus:border-indigo-500" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">Kilometraje Final (opcional)</label><input type="number" value={kmFin} onChange={e => setKmFin(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">Novedades {requiereNovedades && <span className="text-red-400">*</span>}</label><textarea value={novedades} onChange={e => setNovedades(e.target.value)} rows={2} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-indigo-500 resize-none" placeholder={requiereNovedades ? 'Explicá por qué falta o sobra dinero...' : 'Opcional'} /></div>
      <div className={`rounded-xl p-3 text-center ${cierreBueno ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
        <p className={`font-bold ${cierreBueno ? 'text-green-400' : 'text-red-400'}`}>
          Diferencia: {fmt(diferencia)}
        </p>
        {cierreBueno && <p className="text-xs text-green-300 mt-1">Buen cierre de jornada</p>}
        {!cierreBueno && <p className="text-xs text-red-300 mt-1">{diferencia > 0 ? 'Sobrante fuera de tolerancia' : 'Faltante fuera de tolerancia'}</p>}
      </div>
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button onClick={() => { if (!montoFisico) return; if (requiereNovedades && !novedades.trim()) { alert('Explicá en Novedades por qué falta o sobra dinero.'); return; } void onSubmit(efectivo, kmFin ? parseFloat(kmFin) : undefined, novedades); }} disabled={gpsLoading} className="flex-1 bg-indigo-500 disabled:bg-indigo-500/50 text-white font-bold py-3 rounded-xl active:scale-95 transition-all shadow-lg shadow-indigo-500/30">🏁 Cerrar jornada y enviar rendición</button>
      </div>
    </div>
  );
}

function SplashScreen({ elapsedMs }: { elapsedMs: number }) {
  const phase2 = elapsedMs >= 900;
  const phase3 = elapsedMs >= 1400;
  const phase4 = elapsedMs >= 2800;
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col transition-opacity duration-200 ${phase4 ? 'opacity-0' : 'opacity-100'}`}
      style={{
        backgroundColor: 'var(--dotcom-fondo-splash, #020617)',
        backgroundImage: 'linear-gradient(165deg, #0c4a6e 0%, #020617 45%, #000 100%)',
      }}
    >
      <header className="shrink-0 pt-[max(1.5rem,env(safe-area-inset-top))] px-6 pb-2 text-center font-sans">
        <p className="font-black tracking-tight text-2xl sm:text-3xl text-white" style={{ letterSpacing: '-0.03em' }}>{MARCA_PRIMARIA}</p>
        <p className="mt-1 font-light text-xs sm:text-sm text-cyan-100/85 tracking-wide">{MARCA_DESCRIPTOR}</p>
      </header>
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 px-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className={`w-28 h-28 rounded-3xl border border-cyan-400/25 bg-cyan-950/30 backdrop-blur-sm flex items-center justify-center shadow-[0_0_40px_rgba(34,211,238,0.2)] ${phase2 ? 'animate-pulse' : ''}`}>
          <Shield className="w-14 h-14 text-cyan-200" strokeWidth={2.2} />
        </div>
        <div className={`mt-8 h-10 transition-all duration-300 ${phase3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`} aria-hidden />
      </div>
    </div>
  );
}

function ComisionesAdminPanel({
  vendedores,
  pctGlobal,
  clientes,
  guardandoPctId,
  liquidandoId,
  aprobandoCreditoId,
  eliminandoCreditoId,
  onGuardarPct,
  onAprobarComision,
  onEliminarComision,
  onLiquidar,
}: {
  vendedores: VendedorComisionResumen[];
  pctGlobal: number;
  clientes: Cliente[];
  guardandoPctId: string | null;
  liquidandoId: string | null;
  aprobandoCreditoId: string | null;
  eliminandoCreditoId: string | null;
  onGuardarPct: (v: VendedorComisionResumen, pct: number) => void;
  onAprobarComision: (credito: Credito, v: VendedorComisionResumen) => void;
  onEliminarComision: (credito: Credito, v: VendedorComisionResumen) => void;
  onLiquidar: (v: VendedorComisionResumen) => void;
}) {
  const [pctDraft, setPctDraft] = useState<Record<string, string>>({});
  const nombreClienteCredito = (c: Credito) => {
    const cli = clientes.find(cl => normalizarId(cl.id) === normalizarId(String(c.cliente_id ?? '')));
    return nombreCompletoCliente(cli) || String(c.cliente_id ?? '').slice(0, 8);
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400 leading-relaxed">
        Definí el <strong className="text-gray-200">% de comisión</strong> por vendedor, revisá cada venta y <strong className="text-gray-200">aprobá</strong> o <strong className="text-gray-200">eliminá</strong> la comisión.
        El vendedor solo ve el monto a cobrar después de tu aprobación; si la eliminás, desaparece de su panel. Por defecto global: {pctGlobal}%.
      </p>
      <p className="text-[11px] text-amber-200/80">
        Corte semanal: {sabadoCorteSemana()} · Próximo sábado: {proximoSabadoDesde()}
      </p>
      {vendedores.length === 0 && (
        <p className="text-sm text-gray-500 text-center py-6">No hay vendedores registrados en el sistema.</p>
      )}
      {vendedores.map(v => {
        const draftKey = v.id;
        const pctVal = pctDraft[draftKey] ?? String(v.porcentaje_comision);
        return (
          <div key={v.id} className="rounded-2xl border border-amber-500/30 bg-amber-950/15 overflow-hidden">
            <div className="p-4 border-b border-amber-500/20 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-bold text-white text-lg">{etiquetaCobradorMovimiento(v.username)}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    A cobrar (aprobadas): <span className="text-amber-300 font-semibold">{fmt(v.comision_acumulada)}</span>
                    {v.total_pendiente_aprobacion > 0 && (
                      <span className="text-violet-300"> · En revisión: {fmt(v.total_pendiente_aprobacion)}</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={v.comision_acumulada <= 0 || liquidandoId === v.id}
                  onClick={() => onLiquidar(v)}
                  className="shrink-0 rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-40 active:scale-95"
                >
                  {liquidandoId === v.id ? 'Liquidando…' : 'Liquidar y reiniciar'}
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[120px]">
                  <label className="text-[10px] text-gray-500 block mb-1">% Comisión (sobre capital)</label>
                  <input
                    type="number"
                    min={0}
                    value={pctVal}
                    onChange={e => setPctDraft(prev => ({ ...prev, [draftKey]: e.target.value }))}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-semibold"
                  />
                </div>
                <button
                  type="button"
                  disabled={guardandoPctId === v.id}
                  onClick={() => onGuardarPct(v, Number(pctVal) || 0)}
                  className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  {guardandoPctId === v.id ? 'Guardando…' : 'Guardar %'}
                </button>
              </div>
            </div>
            {v.ventas_pendientes_aprobacion.length > 0 && (
              <div className="p-3 border-b border-gray-800/80">
                <p className="text-xs font-semibold text-violet-200 mb-2">Ventas pendientes de aprobación ({v.ventas_pendientes_aprobacion.length})</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {v.ventas_pendientes_aprobacion.map(c => (
                    <div key={c.id} className="flex flex-col sm:flex-row sm:items-center gap-2 bg-gray-900/60 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0 text-xs">
                        <p className="text-white font-medium truncate">{nombreClienteCredito(c)}</p>
                        <p className="text-gray-500">
                          Cartón {String(c.nro_carton || '—')} · Capital {fmt(Number(c.monto_solicitado) || 0)}
                          {c.porcentaje_comision_credito != null && ` · ${c.porcentaje_comision_credito}%`}
                        </p>
                      </div>
                      <p className="font-bold text-violet-300 shrink-0">{fmt(Number(c.comision_vendedor) || 0)}</p>
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          disabled={aprobandoCreditoId === c.id || eliminandoCreditoId === c.id}
                          onClick={() => onAprobarComision(c, v)}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                        >
                          {aprobandoCreditoId === c.id ? '…' : 'Aprobar'}
                        </button>
                        <button
                          type="button"
                          disabled={aprobandoCreditoId === c.id || eliminandoCreditoId === c.id}
                          onClick={() => onEliminarComision(c, v)}
                          className="rounded-lg bg-red-600/90 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                        >
                          {eliminandoCreditoId === c.id ? '…' : 'Eliminar'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {v.ventas_aprobadas_pendientes.length > 0 && (
              <div className="p-3">
                <p className="text-xs font-semibold text-teal-200/90 mb-2">Ventas con comisión aprobada ({v.ventas_aprobadas_pendientes.length})</p>
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {v.ventas_aprobadas_pendientes.map(c => (
                    <div key={c.id} className="flex flex-col sm:flex-row sm:items-center gap-2 text-xs bg-gray-900/40 rounded-lg px-3 py-2">
                      <span className="text-gray-300 truncate pr-2 flex-1 min-w-0">
                        {nombreClienteCredito(c)} · {String(c.nro_carton || '').slice(0, 10)}
                      </span>
                      <span className="font-bold text-teal-300 shrink-0">{fmt(Number(c.comision_vendedor) || 0)}</span>
                      <button
                        type="button"
                        disabled={eliminandoCreditoId === c.id || aprobandoCreditoId === c.id}
                        onClick={() => onEliminarComision(c, v)}
                        className="shrink-0 rounded-lg bg-red-600/80 px-2.5 py-1 text-[10px] font-bold text-white disabled:opacity-50"
                      >
                        {eliminandoCreditoId === c.id ? '…' : 'Eliminar'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {v.ventas_pendientes_aprobacion.length === 0 && v.ventas_aprobadas_pendientes.length === 0 && (
              <p className="p-4 text-xs text-gray-500 text-center">Sin ventas con comisión en este período.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConfigForm({
  config,
  onSave,
  soloLectura = false,
}: {
  config: Config;
  onSave: (c: Config) => void;
  soloLectura?: boolean;
}) {
  const [f, setF] = useState<Config>(() => ({
    ...config,
    telefonoEmpresa: valorInicialCampoCelular(config.telefonoEmpresa),
    numeroWhatsappAdmin: valorInicialCampoCelular(config.numeroWhatsappAdmin),
  }));
  useEffect(() => {
    setF({
      ...config,
      telefonoEmpresa: valorInicialCampoCelular(config.telefonoEmpresa),
      numeroWhatsappAdmin: valorInicialCampoCelular(config.numeroWhatsappAdmin),
    });
  }, [config]);
  const s = (k: keyof Config, v: any) => setF(prev => ({ ...prev, [k]: v }));
  return (
    <div className="space-y-4">
      {soloLectura && (
        <p className="text-xs text-red-300/90 bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2">
          Período de prueba finalizado: los ajustes no se pueden modificar.
        </p>
      )}
      <div><label className="text-xs text-gray-400 block mb-1">Nombre comercial (textos al cliente)</label><input value={f.nombreEmpresa} onChange={e => s('nombreEmpresa', e.target.value)} placeholder={MARCA_COMPLETA} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Teléfono (celular / empresa)</label>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={f.telefonoEmpresa}
          onChange={e => s('telefonoEmpresa', soloDigitosTelefono(e.target.value))}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          placeholder="5491123456789"
          disabled={soloLectura}
        />
      </div>
      <div><label className="text-xs text-gray-400 block mb-1">Dirección</label><input value={f.direccionEmpresa} onChange={e => s('direccionEmpresa', e.target.value)} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">RUC / CUIT</label><input value={f.ruc} onChange={e => s('ruc', e.target.value)} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">% Mora (diario)</label><input type="number" value={f.moraPorciento} onChange={e => s('moraPorciento', parseFloat(e.target.value))} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">% Interés Mercadería (M)</label><input type="number" value={f.interesCreditoM} onChange={e => s('interesCreditoM', parseFloat(e.target.value))} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">% Interés Préstamo (P)</label><input type="number" value={f.interesCreditoP} onChange={e => s('interesCreditoP', parseFloat(e.target.value))} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div><label className="text-xs text-gray-400 block mb-1">% Comisión vendedor (sobre capital)</label><input type="number" value={f.porcentajeComisionVendedor ?? 5} onChange={e => s('porcentajeComisionVendedor', parseFloat(e.target.value))} disabled={soloLectura} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50" /></div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">WhatsApp administrador</label>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={f.numeroWhatsappAdmin}
          onChange={e => s('numeroWhatsappAdmin', soloDigitosTelefono(e.target.value))}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 disabled:opacity-50"
          placeholder="5491123456789"
          disabled={soloLectura}
        />
      </div>
      <label className="flex items-center justify-between rounded-xl border border-gray-700 bg-gray-800/60 px-4 py-3">
        <span className="text-sm font-semibold text-gray-200">Modo Exterior (alto contraste)</span>
        <input type="checkbox" checked={Boolean(f.modoExterior)} onChange={e => s('modoExterior', e.target.checked)} disabled={soloLectura} className="w-5 h-5 accent-indigo-500 disabled:opacity-50" />
      </label>
      <div className="flex gap-3 sticky bottom-0 bg-gray-900 pt-2">
        <button onClick={() => onSave(f)} disabled={soloLectura} className="flex-1 bg-indigo-500 text-white font-bold py-3 rounded-xl active:scale-95 transition-all disabled:opacity-40 disabled:pointer-events-none">💾 Guardar</button>
      </div>
    </div>
  );
}

function CreditoForm({
  tipo,
  clientes,
  interesM,
  interesP,
  rol,
  soloPlanMensual = false,
  configTasasMensual = CONFIG_TASAS_MENSUAL_VACIO,
  onCancel,
  onSubmit,
}: {
  tipo: 'M' | 'P';
  clientes: Cliente[];
  interesM: number;
  interesP: number;
  rol: string | null;
  soloPlanMensual?: boolean;
  configTasasMensual?: ConfigTasasMensual;
  onCancel: () => void;
  onSubmit: (payload: {
    cliente_id: string; tipo: 'M' | 'P'; monto_solicitado: number; detalle_mercaderia: string | null; fecha_inicio: string;
    plazo_unidad: 'Días' | 'Semanas' | 'Meses'; plazo_cantidad: number; total_con_interes: number; interes_aplicado: number;
    es_retroactivo?: boolean;
  }) => void | Promise<void>;
}) {
  const [busqueda, setBusqueda] = useState('');
  const [clienteId, setClienteId] = useState('');
  const [fechaInicio, setFechaInicio] = useState(() => hoy());
  const [detalleMercaderia, setDetalleMercaderia] = useState('');
  const [montoCapital, setMontoCapital] = useState('');
  const [interesAplicado, setInteresAplicado] = useState<number>(30);
  const [plazoUnidad, setPlazoUnidad] = useState<'Días' | 'Semanas' | 'Meses'>(() => (soloPlanMensual ? 'Meses' : 'Semanas'));
  const [plazoCantidad, setPlazoCantidad] = useState<number>(() => (soloPlanMensual ? PLAN_MENSUAL_OPCIONES[0] : 1));
  const plazoUnidadFecha = soloPlanMensual ? 'Meses' : plazoUnidad;
  const maxDiasFuturoFecha = maxDiasFuturoFechaInicioCredito(plazoUnidadFecha);
  const fechaMaxFutura = useMemo(() => addDias(hoy(), maxDiasFuturoFecha), [maxDiasFuturoFecha]);

  const puedeEditarInteres = puedeEditarInteresCredito(rol);
  const esCobrador = String(rol || '').toLowerCase() === 'cobrador';
  const puedeRetro = puedeCargaRetroactivaCredito(rol);
  useEffect(() => {
    const err = validarFechaInicioCredito(fechaInicio, puedeRetro, plazoUnidadFecha);
    if (err) {
      if (!puedeRetro && fechaInicio < hoy()) setFechaInicio(hoy());
      else if (fechaInicio > fechaMaxFutura) setFechaInicio(fechaMaxFutura);
    }
  }, [puedeRetro, fechaInicio, fechaMaxFutura, plazoUnidadFecha]);
  useEffect(() => {
    if (!puedeEditarInteres || soloPlanMensual) {
      setInteresAplicado(
        interesAplicadoOficialCredito(tipo, rol, { interesCreditoM: interesM, interesCreditoP: interesP }, plazoCantidad, configTasasMensual),
      );
      return;
    }
    const baseInteres = tipo === 'M' ? Number(interesM) : Number(interesP);
    setInteresAplicado(Number.isFinite(baseInteres) && baseInteres > 0 ? baseInteres : 30);
  }, [soloPlanMensual, plazoCantidad, configTasasMensual, puedeEditarInteres, esCobrador, tipo, interesM, interesP, rol]);
  const planMensualOpciones = useMemo(
    () => listadoPlanMensualPlazoTasa(configTasasMensual),
    [configTasasMensual],
  );
  const q = busqueda.trim().toLowerCase();
  const clientesFiltrados = useMemo(() => {
    if (!q) return clientes;
    return clientes.filter(c => {
      const n = nombreCompletoCliente(c).toLowerCase();
      return n.includes(q) || n.startsWith(q);
    });
  }, [clientes, q]);

  const opcionesCantidad = opcionesCantidadPlazoCredito(soloPlanMensual ? 'Meses' : (plazoUnidad === 'Meses' ? 'Semanas' : plazoUnidad));
  useEffect(() => {
    if (!opcionesCantidad.includes(plazoCantidad)) setPlazoCantidad(opcionesCantidad[0]);
  }, [opcionesCantidad, plazoCantidad]);

  useEffect(() => {
    if (!clienteId) return;
    if (!esUuidClienteId(clienteId)) {
      setClienteId('');
      return;
    }
    if (!clientes.some(c => c.id === clienteId)) setClienteId('');
  }, [clientes, clienteId]);

  const base = redondearPesos(Number(montoCapital) || 0);
  const totalAutomatico = redondearPesos(base + (base * interesAplicado / 100));
  const totalFinal = totalAutomatico;

  const seleccionarCliente = (c: Cliente) => {
    setClienteId(c.id);
    setBusqueda('');
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-gray-400 block mb-1">Buscador de Clientes</label>
        <input
          value={busqueda}
          onChange={e => { setBusqueda(e.target.value); if (!e.target.value.trim()) setClienteId(''); }}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white"
          placeholder="Escribí para filtrar por nombre..."
          autoComplete="off"
        />
        {clienteId && (
          <p className="text-xs text-emerald-400 mt-1 flex flex-wrap items-center gap-2">
            <span>Cliente vinculado: {nombreCompletoCliente(clientes.find(c => c.id === clienteId)) || clienteId}</span>
            <button type="button" className="text-indigo-300 underline-offset-2 hover:underline" onClick={() => { setClienteId(''); setBusqueda(''); }}>
              Cambiar
            </button>
          </p>
        )}
        {busqueda.trim().length > 0 && (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-xl border border-gray-700 bg-gray-900/80 divide-y divide-gray-800">
            {clientesFiltrados.length === 0 && (
              <p className="p-3 text-xs text-gray-500">Sin coincidencias</p>
            )}
            {clientesFiltrados.slice(0, 50).map(c => (
              <button
                key={c?.id ?? ''}
                type="button"
                onClick={() => seleccionarCliente(c)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-800 ${clienteId === c.id ? 'bg-indigo-500/20 text-indigo-200' : 'text-white'}`}
              >
                {nombreCompletoCliente(c) ?? '—'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Fecha de inicio del crédito</label>
        <input
          type="date"
          min={puedeRetro ? undefined : hoy()}
          max={fechaMaxFutura}
          value={fechaInicio}
          onChange={e => setFechaInicio(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white"
        />
        <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
          {puedeRetro
            ? `Referencia administrativa del crédito. Podés usar fechas pasadas (retroactivo). Hacia adelante, máximo ${maxDiasFuturoFecha} días desde hoy (${plazoUnidadFecha === 'Semanas' ? 'plan semanal' : 'plan diario/mensual'}).`
            : `Referencia del crédito (por defecto hoy). Hacia adelante, máximo ${maxDiasFuturoFecha} días (${plazoUnidadFecha === 'Semanas' ? 'semanal' : 'diario/mensual'}). El cobrador verá las cuotas para cobrar desde el día siguiente a la aprobación.`}
        </p>
      </div>
      {tipo === 'M' && (
        <div>
          <label className="text-xs text-gray-400 block mb-1">Detalle de Mercadería</label>
          <textarea value={detalleMercaderia} onChange={e => setDetalleMercaderia(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white" rows={2} />
        </div>
      )}
      <div>
        <label className="text-xs text-gray-400 block mb-1">{tipo === 'M' ? 'Monto capital (base)' : 'Monto solicitado (capital)'}</label>
        <input type="number" value={montoCapital} onChange={e => setMontoCapital(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white" placeholder="0" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Unidad de Plazo</label>
          {soloPlanMensual ? (
            <input readOnly value="Mensual" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white opacity-80" />
          ) : (
          <select
            value={plazoUnidad}
            onChange={e => setPlazoUnidad(normalizarPlazoUnidad(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white"
          >
            <option value="Días">Diario (por día)</option>
            <option value="Semanas">Semanal</option>
          </select>
          )}
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">{soloPlanMensual ? 'Cuotas (meses)' : 'Cantidad'}</label>
          <select value={plazoCantidad} onChange={e => setPlazoCantidad(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white">
            {soloPlanMensual
              ? planMensualOpciones.map(p => (
                <option key={p.meses} value={p.meses}>{p.meses} {p.meses === 1 ? 'mes' : 'meses'} · {p.tasaPct}%</option>
              ))
              : opcionesCantidad.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Interés aplicado (%)</label>
        <input
          type="number"
          value={interesAplicado}
          onChange={e => setInteresAplicado(Number(e.target.value) || 0)}
          readOnly={!puedeEditarInteres || soloPlanMensual}
          disabled={!puedeEditarInteres || soloPlanMensual}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white disabled:opacity-70"
        />
        <p className="text-[11px] text-gray-500 mt-1">
          {soloPlanMensual
            ? 'La tasa se asigna automáticamente según la cantidad de cuotas mensuales.'
            : puedeEditarInteres
              ? 'Como administrador podés ajustar el interés antes de guardar.'
              : esCobrador
                ? 'El interés queda fijo en 30% (solo el administrador puede modificarlo).'
                : 'El interés lo define el administrador; no podés modificarlo en la solicitud.'}
        </p>
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Monto Total</label>
        <input
          type="number"
          value={Number.isFinite(totalFinal) ? String(totalFinal) : ''}
          readOnly
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white"
        />
        <p className="text-[11px] text-gray-500 mt-1">Cálculo automático: Capital + (Capital * (Interés / 100)).</p>
      </div>
      <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-xl p-3">
        <p className="text-xs text-gray-300">Interés aplicado: {interesAplicado}%</p>
        <p className="text-xs text-gray-400">Total automático: {fmt(totalAutomatico)}</p>
        <p className="text-lg font-bold text-indigo-300">Total a enviar: {fmt(totalFinal)}</p>
        <p className="text-xs text-amber-300">{soloPlanMensual ? 'Al guardar, el préstamo mensual queda activo de inmediato.' : 'Al guardar, el estado lo asigna el sistema (p. ej. pendiente de aprobación según tu cuenta).'}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 bg-gray-700 text-white rounded-xl py-3 font-semibold">Cancelar</button>
        <button
          type="button"
          onClick={() => void onSubmit({
            cliente_id: clienteId,
            tipo,
            monto_solicitado: base,
            detalle_mercaderia: tipo === 'M' ? detalleMercaderia : null,
            fecha_inicio: fechaInicio,
            plazo_unidad: soloPlanMensual ? 'Meses' : plazoUnidad,
            plazo_cantidad: plazoCantidad,
            total_con_interes: totalFinal,
            interes_aplicado: interesAplicado,
            es_retroactivo: Boolean(puedeRetro && fechaInicio < hoy()),
          })}
          disabled={
            !clienteId
            || !esUuidClienteId(clienteId)
            || base <= 0
            || (tipo === 'M' && !detalleMercaderia.trim())
            || Boolean(validarFechaInicioCredito(fechaInicio, puedeRetro, plazoUnidadFecha))
          }
          className="flex-1 bg-indigo-500 text-white rounded-xl py-3 font-bold disabled:opacity-50"
        >
          Guardar Solicitud
        </button>
      </div>
    </div>
  );
}

function PlanillaPagosFicha({ ficha, cliente, pagos }: { ficha: Ficha; cliente: Cliente | null; pagos: PagoRegistro[] }) {
  const pagosFicha = useMemo(
    () => pagos.filter(p => fichaIdUuid(p.fichaId) === fichaIdUuid(ficha.id)),
    [pagos, ficha.id]
  );
  const estadoCuentaRows = useMemo(
    () => construirEstadoCuentaPagos(ficha, pagosFicha),
    [ficha, pagosFicha]
  );
  const saldoPendienteNegativo = useMemo(() => {
    if (estadoCuentaRows.length > 0) return estadoCuentaRows[estadoCuentaRows.length - 1].saldoRestante;
    const deudaBase = Math.max(0, Number(ficha.saldo || ficha.precioVenta || ficha.montoTotal || 0));
    return -deudaBase;
  }, [estadoCuentaRows, ficha]);

  const handleDescargarPdf = async () => {
    const doc = await crearEstadoCuentaPdf(ficha, cliente, pagosFicha);
    const slug = String(ficha.id).replace(/[^\w-]/g, '').slice(-12) || 'ficha';
    doc.save(`estado-cuenta-${slug}.pdf`);
  };

  const handleEnviarPdf = async () => {
    const doc = await crearEstadoCuentaPdf(ficha, cliente, pagosFicha);
    const filename = 'Estado_Cuenta.pdf';
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });
    const saldoTexto = fmt(saldoPendienteNegativo);
    const textoShare = `Hola, te adjunto tu estado de cuenta de ${MARCA_COMPLETA}.\nSaldo Pendiente actual: ${saldoTexto}`;
    const textoWAFallback = `Archivo descargado. Por favor, adjúntalo manualmente.\nSaldo Pendiente actual: ${saldoTexto}`;
    const tel = normalizarTelefonoArg549(String(cliente?.telefono ?? ''));
    const soportaShareArchivos = typeof navigator !== 'undefined'
      && typeof navigator.share === 'function'
      && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [file] });
    if (soportaShareArchivos) {
      try {
        await navigator.share({
          files: [file],
          title: 'Estado de Cuenta',
          text: textoShare,
        });
        return;
      } catch {
        // Si se cancela o falla share, cae al flujo de descarga + WA.
      }
    }
    doc.save(filename);
    window.open(generarLinkWhatsApp(tel, textoWAFallback), '_blank');
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-300">{nombreCompletoCliente(cliente) ?? '—'} · Ficha {ficha.id}</p>
      <p className="text-xs text-gray-500">Cliente: {nombreCompletoCliente(cliente) ?? '—'} | Producto: {productoFichaLabel(ficha)}</p>
      <p className="text-base font-bold text-red-400">Saldo Pendiente: {fmt(saldoPendienteNegativo)}</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleDescargarPdf}
          className="w-full py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold active:scale-[0.99] transition"
        >
          Descargar PDF
        </button>
        <button
          type="button"
          onClick={() => void handleEnviarPdf()}
          className="w-full py-2 rounded-xl bg-green-600 text-white text-sm font-semibold active:scale-[0.99] transition"
        >
          Enviar PDF
        </button>
      </div>
      {Math.abs(saldoPendienteNegativo) <= 0.0001 && (
        <div className="rounded-xl border border-green-500/50 bg-green-500/10 p-2 text-center text-green-300 text-sm font-semibold">
          CUENTA CANCELADA
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-800">
              <th className="p-2 text-left">Fecha</th>
              <th className="p-2 text-left">Cobrador</th>
              <th className="p-2 text-right">Monto Cobrado</th>
              <th className="p-2 text-right">Saldo Restante</th>
            </tr>
          </thead>
          <tbody>
            {estadoCuentaRows.length === 0 && (
              <tr className="border-t border-gray-800">
                <td className="p-2 text-gray-500" colSpan={4}>Sin pagos registrados en la tabla de pagos para esta ficha.</td>
              </tr>
            )}
            {estadoCuentaRows.map((row, idx) => {
              return (
                <tr key={`${row.fecha}-${idx}`} className="border-t border-gray-800">
                  <td className="p-2">{row.fecha || '-'}</td>
                  <td className="p-2">{row.cobrador}</td>
                  <td className="p-2 text-right">{fmt(row.montoCobrado)}</td>
                  <td className="p-2 text-right">{fmt(row.saldoRestante)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanillaPagosCredito({ credito, cliente, creditos, pagos, nroCarton }: { credito: Credito; cliente: Cliente | null; creditos: Credito[]; pagos: PagoRegistro[]; nroCarton?: string }) {
  const creditoActual = useMemo(() => creditos.find(c => c.id === credito.id) || credito, [creditos, credito]);
  const planilla = useMemo(() => generarPlanillaCredito(creditoActual), [creditoActual]);
  const pagosEfectivos = useMemo(() => pagosEfectivosCredito(pagos, creditoActual.id), [pagos, creditoActual.id]);
  const pagadas = Math.min(planilla.length, pagosEfectivos.length);
  const faltantes = Math.max(0, planilla.length - pagadas);
  const hRef = hoy();
  return (
    <div className="space-y-3">
      <AvisoApellidoIncompleto cliente={cliente} />
      <div>
        <p className="text-sm text-gray-200">{nombreCompletoCliente(cliente) || creditoActual.cliente_id}</p>
        <p className="text-xs text-gray-400">Crédito {creditoActual.id} · Cartón {nroCarton || creditoActual.nro_carton || '---'} · {creditoActual.tipo}</p>
        <p className="text-xs text-cyan-300">Cuotas pagadas: {pagadas} · Cuotas faltantes: {faltantes}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-800">
              <th className="p-2 text-left">Cuota</th>
              <th className="p-2 text-left">Vencimiento</th>
              <th className="p-2 text-left">Estado</th>
              <th className="p-2 text-right">Monto</th>
              <th className="p-2 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {planilla.map((c, idx) => {
              const vto = String(c.vencimiento || '').slice(0, 10);
              const pagadaFila = idx < pagosEfectivos.length;
              const estadoCuota = pagadaFila ? 'Pagada' : (vto < hRef ? 'No pago' : 'Pendiente');
              const colorEstado = pagadaFila ? 'text-emerald-300' : (vto < hRef ? 'text-red-400' : 'text-amber-200');
              return (
                <tr key={c.nro} className="border-t border-gray-800">
                  <td className="p-2">{c.nro}</td>
                  <td className="p-2">{c.vencimiento}</td>
                  <td className={`p-2 font-medium ${colorEstado}`}>{estadoCuota}</td>
                  <td className="p-2 text-right">{fmt(c.monto)}</td>
                  <td className="p-2 text-right">{fmt(c.saldo)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreditoReviewForm({
  credito,
  cliente,
  historial,
  puedeGestionarRevision,
  cobradoresOpciones,
  eliminando,
  onCerrar,
  onVerPlanilla,
  onResolver,
  onEliminarCredito,
}: {
  credito: Credito;
  cliente: Cliente | null;
  historial: Credito[];
  /** Solo MarcosP: aprobar/rechazar y parámetros administrativos. */
  puedeGestionarRevision: boolean;
  /** Solo admin/root: filas de `usuarios` rol cobrador para asignar crédito. */
  cobradoresOpciones: Array<{ valor: string; label: string }>;
  eliminando?: boolean;
  onCerrar: () => void;
  onVerPlanilla: (credito: Credito) => void;
  onResolver: (review: {
    plazo_unidad: 'Días' | 'Semanas' | 'Meses';
    plazo_cantidad: number;
    interes_aplicado: number;
    total_con_interes: number;
    notas_admin: string;
    cobrador_id_admin?: string;
  }, estado: 'APROBADO' | 'RECHAZADO') => void | Promise<void>;
  onEliminarCredito?: (credito: Credito) => void | Promise<void>;
}) {
  const estadoCredito = String(credito.estado || '').trim().toUpperCase();
  const esProcesado = estadoCredito === 'ACTIVO' || estadoCredito === 'RECHAZADO' || estadoCredito === 'FINALIZADO';
  const puedeResolver = puedeGestionarRevision && !esProcesado;
  const capitalBase = Math.max(0, Number(credito.monto_solicitado) || 0);
  const [plazoUnidad, setPlazoUnidad] = useState<'Días' | 'Semanas' | 'Meses'>(() => {
    const u = normalizarPlazoUnidad(credito.plan ?? '');
    return u === 'Meses' ? 'Semanas' : u;
  });
  const [plazoCantidad, setPlazoCantidad] = useState<number>(Math.max(1, Number(credito.plazo_cantidad ?? credito.cuotas) || 1));
  const [interes, setInteres] = useState<number>(Number(credito.interes_aplicado) || 30);
  const [total, setTotal] = useState<number>(() => redondearPesos(
    capitalBase + (capitalBase * ((Number(credito.interes_aplicado) || 30) / 100)),
  ));
  const [notas, setNotas] = useState('');
  const [cobradorAsignado, setCobradorAsignado] = useState('');
  const opcionesCobrador = useMemo(() => {
    const base = cobradoresOpciones.map(o => ({ ...o }));
    const cid = String(credito.cobrador_id || '').trim();
    if (cid) {
      const cubre = base.some(o => o.valor === cid || o.label === cid || o.label.toLowerCase() === cid.toLowerCase());
      if (!cubre) {
        base.unshift({ valor: cid, label: `${cid.length > 28 ? `${cid.slice(0, 26)}…` : cid} (solicitud)` });
      }
    }
    return base;
  }, [cobradoresOpciones, credito.cobrador_id]);
  useEffect(() => {
    const cid = String(credito.cobrador_id || '').trim();
    if (opcionesCobrador.length === 0) {
      setCobradorAsignado(cid);
      return;
    }
    const exact = opcionesCobrador.find(o => o.valor === cid);
    if (exact) {
      setCobradorAsignado(exact.valor);
      return;
    }
    const byLabel = opcionesCobrador.find(o => o.label === cid || o.label.toLowerCase() === cid.toLowerCase());
    if (byLabel) {
      setCobradorAsignado(byLabel.valor);
      return;
    }
    setCobradorAsignado(opcionesCobrador[0]?.valor ?? cid);
  }, [credito.id, credito.cobrador_id, opcionesCobrador]);
  const opcionesCantidad = opcionesCantidadPlazoCredito(plazoUnidad === 'Meses' ? 'Semanas' : plazoUnidad);
  useEffect(() => {
    if (!opcionesCantidad.includes(plazoCantidad)) setPlazoCantidad(opcionesCantidad[0]);
  }, [opcionesCantidad, plazoCantidad]);
  useEffect(() => {
    setTotal(redondearPesos(capitalBase + (capitalBase * ((Number(interes) || 0) / 100))));
  }, [capitalBase, interes]);
  return (
    <div className="space-y-4">
      <AvisoApellidoIncompleto cliente={cliente} />
      {puedeGestionarRevision && (
        <BloqueVideoVerificacionNegocioAdmin cliente={cliente} />
      )}
      <div className="bg-gray-800/60 rounded-xl p-3">
        <p className="text-sm font-semibold">{nombreCompletoCliente(cliente) || credito.cliente_id}</p>
        <p className="text-xs text-gray-400">Solicitud {credito.id} · Tipo {credito.tipo}</p>
        <p className="text-xs text-cyan-400/90 mt-1">
          Fecha de inicio del crédito: {String(credito.fecha_inicio || '').slice(0, 10) || '—'} (referencia). Cuotas para cobrar desde el día siguiente a la aprobación.
        </p>
        {credito.es_retroactivo && (
          <p className="text-xs text-amber-300/95 mt-1 font-semibold">Carga retroactiva — quedó registrado en base (es_retroactivo)</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Plazo</label>
          <select
            value={plazoUnidad}
            onChange={e => setPlazoUnidad(normalizarPlazoUnidad(e.target.value))}
            disabled={!puedeResolver}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white disabled:opacity-60"
          >
            <option value="Días">Diario (por día)</option>
            <option value="Semanas">Semanal</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Cuotas</label>
          <select value={plazoCantidad} onChange={e => setPlazoCantidad(Number(e.target.value))} disabled={!puedeResolver} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white disabled:opacity-60">
            {opcionesCantidad.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Interés (%)</label>
          <input type="number" value={interes} onChange={e => setInteres(Number(e.target.value) || 0)} readOnly={!puedeResolver} disabled={!puedeResolver} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white disabled:opacity-70" />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Monto Total</label>
          <input type="number" value={total} readOnly className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white" />
        </div>
      </div>
      {puedeResolver && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-950/25 p-3 space-y-2">
          <label className="text-xs text-violet-100 font-semibold block">Cobrador asignado (Ruta)</label>
          <select
            value={cobradorAsignado}
            onChange={e => setCobradorAsignado(String(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white"
          >
            {opcionesCobrador.length === 0 ? (
              <option value="">— Sin cobradores en tabla usuarios —</option>
            ) : (
              opcionesCobrador.map(o => (
                <option key={`${o.valor}-${o.label}`} value={String(o.valor)}>{o.label}</option>
              ))
            )}
          </select>
          <p className="text-[10px] text-gray-500">Al aprobar, el crédito queda vinculado a este cobrador para filtros y Ruta.</p>
        </div>
      )}
      <button type="button" onClick={() => onVerPlanilla({ ...credito, plazo_unidad: plazoUnidad, plazo_cantidad: plazoCantidad, interes_aplicado: interes, total_con_interes: total })} className="w-full bg-indigo-500/15 border border-indigo-500/35 text-indigo-200 rounded-xl py-2 text-sm font-semibold active:scale-95 transition">
        Ver Planilla de Pagos
      </button>
      <div className="bg-gray-900/70 border border-gray-800 rounded-xl p-3 space-y-2">
        <p className="text-sm font-semibold text-gray-200">Historial del Cliente</p>
        {historial.length === 0 && <p className="text-xs text-gray-500">Sin créditos anteriores para este cliente.</p>}
        {historial.map(h => {
          const estadoPago = h.estado === 'APROBADO' ? 'Pagado/En curso' : h.estado === 'RECHAZADO' ? 'Rechazado' : 'Mora/Pendiente';
          const comportamiento = h.estado === 'APROBADO' ? 'Cumplimiento aceptable' : h.estado === 'RECHAZADO' ? 'Riesgo alto' : 'A revisar';
          return (
            <div key={h.id} className="rounded-lg bg-gray-800/70 border border-gray-700 p-2">
              <p className="text-xs font-semibold">{h.id} · {h.tipo}</p>
              <p className="text-xs text-gray-400">Estado: {estadoPago}</p>
              <p className="text-xs text-gray-500">Comportamiento: {comportamiento}</p>
            </div>
          );
        })}
      </div>
      <div>
        <label className="text-xs text-gray-400 block mb-1">Notas del Administrador</label>
        <textarea
          value={notas}
          onChange={e => setNotas(e.target.value)}
          readOnly={!puedeResolver}
          disabled={!puedeResolver}
          rows={3}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white resize-none disabled:opacity-50"
          placeholder="Se incluirán en la notificación al cobrador."
        />
      </div>
      {puedeGestionarRevision && onEliminarCredito && (
        <button
          type="button"
          disabled={eliminando}
          onClick={() => void onEliminarCredito(credito)}
          className="w-full rounded-xl border border-red-500/45 bg-red-950/40 py-3 text-sm font-bold text-red-200 disabled:opacity-50 active:scale-[0.99] transition"
        >
          {eliminando ? 'Eliminando crédito y revirtiendo movimientos…' : '🗑 Eliminar crédito y revertir movimientos'}
        </button>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={onCerrar} className="w-full sm:flex-1 bg-gray-700 text-white rounded-xl py-3 font-semibold">Cerrar</button>
        {puedeResolver && (
          <>
            <button type="button" onClick={() => void onResolver({ plazo_unidad: plazoUnidad, plazo_cantidad: plazoCantidad, interes_aplicado: interes, total_con_interes: total, notas_admin: notas }, 'RECHAZADO')} className="w-full sm:flex-1 bg-red-500 text-white rounded-xl py-3 font-semibold">Rechazar</button>
            <button
              type="button"
              onClick={() => {
                if (!String(cobradorAsignado).trim()) {
                  alert('Seleccioná un cobrador.');
                  return;
                }
                void onResolver({
                  plazo_unidad: plazoUnidad,
                  plazo_cantidad: plazoCantidad,
                  interes_aplicado: interes,
                  total_con_interes: total,
                  notas_admin: notas,
                  cobrador_id_admin: String(cobradorAsignado).trim(),
                }, 'APROBADO');
              }}
              className="w-full sm:flex-1 bg-green-500 text-white rounded-xl py-3 font-semibold"
            >
              Aceptar solicitud
            </button>
          </>
        )}
      </div>
    </div>
  );
}
