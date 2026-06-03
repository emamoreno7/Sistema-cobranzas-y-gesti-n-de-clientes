export const MSG_TRIAL_EXPIRADO =
  'El período de prueba de 30 días de la cuenta demo finalizó. Contacte al administrador para activar una licencia completa.';

export type ResultadoAccesoDemo = {
  ok: boolean;
  esDemo: boolean;
  motivo?: string;
  trialFin: string | null;
};

export function parseResultadoAccesoDemo(raw: unknown): ResultadoAccesoDemo {
  const j = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const trialRaw = j.trial_fin;
  let trialFin: string | null = null;
  if (trialRaw != null && trialRaw !== '') {
    const d = new Date(String(trialRaw));
    if (!Number.isNaN(d.getTime())) trialFin = d.toISOString().slice(0, 10);
  }
  return {
    ok: j.ok !== false,
    esDemo: Boolean(j.es_demo),
    motivo: j.motivo != null ? String(j.motivo) : undefined,
    trialFin,
  };
}

export function mensajeBloqueoDemoPrueba(motivo?: string): string {
  if (motivo === 'demo_bloqueada' || motivo === 'trial_vencido') {
    return `${MSG_TRIAL_EXPIRADO}\n\nLa cuenta demo quedó desactivada en el servidor. Borrar datos del navegador o cambiar de dispositivo no la reactiva.`;
  }
  if (motivo === 'usuario_no_existe' || motivo === 'usuario_inactivo') {
    return 'La cuenta demo no está disponible. Solicite activación al administrador.';
  }
  return MSG_TRIAL_EXPIRADO;
}

export function hoyIsoLocal(): string {
  return new Date().toISOString().slice(0, 10);
}

export function diffDiasIso(a: string, b: string): number {
  return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

export function diasRestantesTrial(trialFin: string | null | undefined): number | null {
  if (!trialFin) return null;
  return Math.max(0, diffDiasIso(trialFin, hoyIsoLocal()));
}

export function trialExpirado(trialFin: string | null | undefined): boolean {
  if (!trialFin) return false;
  return hoyIsoLocal() > trialFin.slice(0, 10);
}

export function trialLicenciaActiva(trialFin: string | null | undefined): boolean {
  if (!trialFin) return true;
  return !trialExpirado(trialFin);
}

export function etiquetaTrialBadge(trialFin: string | null | undefined): string {
  if (!trialFin) return '';
  if (trialExpirado(trialFin)) return 'Prueba finalizada';
  const d = diasRestantesTrial(trialFin);
  if (d === null) return '';
  if (d === 0) return 'Último día de prueba';
  if (d === 1) return 'Prueba · 1 día restante';
  return `Prueba · ${d} días restantes`;
}
