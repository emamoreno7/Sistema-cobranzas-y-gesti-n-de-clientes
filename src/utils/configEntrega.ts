/** Valores de contacto que no deben mostrarse en entregas/demo (datos de otro cliente). */
const TELEFONOS_LEGACY_BLOQUEADOS = new Set([
  '5492634340284',
  '5491100000000',
]);

export type ConfigApp = {
  moneda: string;
  simboloMoneda: string;
  moraPorciento: number;
  nombreEmpresa: string;
  telefonoEmpresa: string;
  direccionEmpresa: string;
  ruc: string;
  numeroWhatsappAdmin: string;
  interesCreditoM: number;
  interesCreditoP: number;
  porcentajeComisionVendedor: number;
  modoExterior: boolean;
  trialFin: string | null;
  /** Último cierre de día de Marcos: contadores en pantalla solo cuentan movimientos posteriores (mismo día). */
  cierreCajaMarcosAt: string | null;
  /** Root: desactiva bloqueos de jornada/rendición para pruebas en campo. */
  jornadaSinBloqueosPruebas: boolean;
};

export const CONFIG_DEFECTO: ConfigApp = {
  moneda: 'ARS',
  simboloMoneda: '$',
  moraPorciento: 2,
  nombreEmpresa: 'DotCom Sistema de Gestión',
  telefonoEmpresa: '',
  direccionEmpresa: 'Calle Principal 123',
  ruc: '00-00000000-0',
  numeroWhatsappAdmin: '',
  interesCreditoM: 30,
  interesCreditoP: 20,
  porcentajeComisionVendedor: 5,
  modoExterior: false,
  trialFin: null,
  cierreCajaMarcosAt: null,
  jornadaSinBloqueosPruebas: false,
};

function soloDigitosTel(v: string): string {
  return String(v || '').replace(/\D/g, '');
}

function telefonoPermitido(raw: unknown): string {
  const d = soloDigitosTel(String(raw ?? ''));
  if (!d || TELEFONOS_LEGACY_BLOQUEADOS.has(d)) return CONFIG_DEFECTO.telefonoEmpresa;
  return d;
}

function textoEmpresaPermitido(raw: unknown, fallback: string): string {
  const t = String(raw ?? '').trim();
  if (!t) return fallback;
  const lower = t.toLowerCase();
  if (lower.includes('emamoreno') || lower.includes('marcosp')) return fallback;
  return t;
}

export function parseTrialFinDesdeDb(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Mapea fila `configuracion` → config de app (sin datos de contacto de otros clientes). */
export function configDesdeSupabase(raw: Record<string, unknown> | null | undefined): ConfigApp {
  const cfg = raw || {};
  const interesM = Number(cfg.interes_credito_m ?? cfg.interesCreditoM ?? cfg.porcentaje_interes);
  const interesP = Number(cfg.interes_credito_p ?? cfg.interesCreditoP);
  const pctComision = Number(cfg.porcentaje_comision_vendedor ?? cfg.porcentajeComisionVendedor);
  const mora = Number(cfg.mora_porciento ?? cfg.moraPorciento);
  return {
    ...CONFIG_DEFECTO,
    ...(Number.isFinite(interesM) ? { interesCreditoM: interesM } : {}),
    ...(Number.isFinite(interesP) ? { interesCreditoP: interesP } : {}),
    ...(Number.isFinite(pctComision) ? { porcentajeComisionVendedor: pctComision } : {}),
    ...(Number.isFinite(mora) ? { moraPorciento: mora } : {}),
    modoExterior: Boolean(cfg.modo_exterior ?? cfg.modoExterior),
    trialFin: parseTrialFinDesdeDb(cfg.trial_fin ?? cfg.trialFin),
    cierreCajaMarcosAt:
      cfg.cierre_caja_marcos_at != null && String(cfg.cierre_caja_marcos_at).trim()
        ? String(cfg.cierre_caja_marcos_at)
        : null,
    jornadaSinBloqueosPruebas: Boolean(cfg.jornada_sin_bloqueos_pruebas ?? cfg.jornadaSinBloqueosPruebas),
    nombreEmpresa: textoEmpresaPermitido(cfg.nombre_empresa ?? cfg.nombreEmpresa, CONFIG_DEFECTO.nombreEmpresa),
    direccionEmpresa: textoEmpresaPermitido(cfg.direccion_empresa ?? cfg.direccionEmpresa, CONFIG_DEFECTO.direccionEmpresa),
    ruc: String(cfg.ruc ?? CONFIG_DEFECTO.ruc).trim() || CONFIG_DEFECTO.ruc,
    telefonoEmpresa: telefonoPermitido(cfg.telefono_empresa ?? cfg.telefonoEmpresa),
    numeroWhatsappAdmin: telefonoPermitido(cfg.numero_whatsapp_admin ?? cfg.numeroWhatsappAdmin),
    moneda: String(cfg.moneda ?? CONFIG_DEFECTO.moneda),
    simboloMoneda: String(cfg.simbolo_moneda ?? cfg.simboloMoneda ?? CONFIG_DEFECTO.simboloMoneda),
  };
}

/** Ignora caché local de empresa/contacto; conserva solo parámetros numéricos y trial. */
export function configDesdeCacheLocal(partial: Partial<ConfigApp> | null | undefined): ConfigApp {
  const base = { ...CONFIG_DEFECTO };
  if (!partial) return base;
  return {
    ...base,
    ...(typeof partial.interesCreditoM === 'number' && Number.isFinite(partial.interesCreditoM)
      ? { interesCreditoM: partial.interesCreditoM } : {}),
    ...(typeof partial.interesCreditoP === 'number' && Number.isFinite(partial.interesCreditoP)
      ? { interesCreditoP: partial.interesCreditoP } : {}),
    ...(typeof partial.moraPorciento === 'number' && Number.isFinite(partial.moraPorciento)
      ? { moraPorciento: partial.moraPorciento } : {}),
    ...(typeof partial.porcentajeComisionVendedor === 'number' && Number.isFinite(partial.porcentajeComisionVendedor)
      ? { porcentajeComisionVendedor: partial.porcentajeComisionVendedor } : {}),
    modoExterior: Boolean(partial.modoExterior),
    trialFin: partial.trialFin ?? base.trialFin,
    jornadaSinBloqueosPruebas: Boolean(partial.jornadaSinBloqueosPruebas),
  };
}
