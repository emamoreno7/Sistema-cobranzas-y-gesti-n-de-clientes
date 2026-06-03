/** Tasa diaria: 0,5 % → 0.005 por día sobre el importe del cheque. */
export const TASA_INTERES_CHEQUE_DIARIA = 0.005;

export function parseFechaSoloDia(fecha: string): Date {
  const s = String(fecha || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(n => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Días calendario desde hoy (inclusive hoy=0) hasta la fecha de vencimiento. */
export function diasHastaVencimientoCheque(fechaVencimiento: string, ref = new Date()): number {
  const venc = parseFechaSoloDia(fechaVencimiento);
  const hoy = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const v = new Date(venc.getFullYear(), venc.getMonth(), venc.getDate());
  const diff = Math.round((v.getTime() - hoy.getTime()) / 86400000);
  return Math.max(0, diff);
}

export type LiquidacionCheque = {
  dias: number;
  interes: number;
  montoRecibir: number;
  importe: number;
  tasaDiariaPct: number;
};

export function calcularLiquidacionCheque(importe: number, fechaVencimiento: string): LiquidacionCheque {
  const importeNum = Math.max(0, Number(importe) || 0);
  const dias = diasHastaVencimientoCheque(fechaVencimiento);
  const interes = Math.round(importeNum * TASA_INTERES_CHEQUE_DIARIA * dias);
  const montoRecibir = Math.max(0, importeNum - interes);
  return {
    dias,
    interes,
    montoRecibir,
    importe: importeNum,
    tasaDiariaPct: 0.5,
  };
}

export function fmtPesos(n: number): string {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(
    Math.round(Number(n) || 0),
  );
}
