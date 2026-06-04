/** Tasa diaria: 0,4 % → 0.004 por día sobre el importe del cheque. */
export const TASA_INTERES_CHEQUE_DIARIA = 0.004;
export const TASA_INTERES_CHEQUE_DIARIA_PCT = 0.4;

/** Mínimo de comisión: 7,5 % del importe del cheque. */
export const INTERES_MINIMO_CHEQUE_FRACCION = 0.075;
export const INTERES_MINIMO_CHEQUE_PCT = 7.5;

/** Día administrativo extra después del vencimiento para el cobro de comisión. */
export const DIAS_ADMIN_POST_VENCIMIENTO = 1;

export const DIAS_RETENCION_CHEQUE_ACEPTADO = 210;
export const DIAS_RETENCION_CHEQUE_RECHAZADO = 7;

export function parseFechaSoloDia(fecha: string): Date {
  const s = String(fecha || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(n => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Días calendario desde hoy hasta la fecha de vencimiento (sin día admin). */
export function diasHastaVencimientoCheque(fechaVencimiento: string, ref = new Date()): number {
  const venc = parseFechaSoloDia(fechaVencimiento);
  const hoy = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const v = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate());
  const diff = Math.round((v.getTime() - hoy.getTime()) / 86400000);
  return Math.max(0, diff);
}

/** Días para comisión: hasta vencimiento + 1 día administrativo. */
export function diasParaComisionCheque(fechaVencimiento: string, ref = new Date()): number {
  const venc = parseFechaSoloDia(fechaVencimiento);
  venc.setDate(venc.getDate() + DIAS_ADMIN_POST_VENCIMIENTO);
  const hoy = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const v = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate());
  const diff = Math.round((v.getTime() - hoy.getTime()) / 86400000);
  return Math.max(0, diff);
}

export function redondearAMil(n: number): number {
  const v = Number(n) || 0;
  return Math.round(v / 1000) * 1000;
}

export type LiquidacionCheque = {
  /** Días hasta vencimiento + 1 (administrativo). */
  dias: number;
  interes: number;
  montoRecibir: number;
  importe: number;
  tasaDiariaPct: number;
  interesMinimoAplicado: boolean;
};

export function calcularLiquidacionCheque(importe: number, fechaVencimiento: string): LiquidacionCheque {
  const importeNum = Math.max(0, Number(importe) || 0);
  const dias = diasParaComisionCheque(fechaVencimiento);
  const interesPorDias = importeNum * TASA_INTERES_CHEQUE_DIARIA * dias;
  const interesMinimo = importeNum * INTERES_MINIMO_CHEQUE_FRACCION;
  const interesMinimoAplicado = interesPorDias < interesMinimo;
  const interes = Math.round(Math.max(interesPorDias, interesMinimo));
  const montoRecibir = redondearAMil(Math.max(0, importeNum - interes));
  return {
    dias,
    interes,
    montoRecibir,
    importe: importeNum,
    tasaDiariaPct: TASA_INTERES_CHEQUE_DIARIA_PCT,
    interesMinimoAplicado,
  };
}

export function fmtPesos(n: number): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(
    Math.round(Number(n) || 0),
  );
}
