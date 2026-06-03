import { etiquetaTrialBadge, trialExpirado } from '../utils/trialLicencia';

type TrialCountdownBadgeProps = {
  trialFin: string | null | undefined;
};

export function TrialCountdownBadge({ trialFin }: TrialCountdownBadgeProps) {
  if (!trialFin) return null;
  const texto = etiquetaTrialBadge(trialFin);
  if (!texto) return null;
  const expirado = trialExpirado(trialFin);
  return (
    <div
      className={`fixed z-[45] pointer-events-none select-none max-w-[11rem] ${
        expirado
          ? 'bottom-[5.25rem] right-2 sm:right-3'
          : 'bottom-[5.25rem] right-2 sm:right-3'
      }`}
      role="status"
      aria-live="polite"
    >
      <div
        className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold leading-tight shadow-lg backdrop-blur-md ${
          expirado
            ? 'border-red-500/40 bg-red-950/90 text-red-200'
            : 'border-amber-400/35 bg-gray-950/90 text-amber-100/95'
        }`}
      >
        {texto}
      </div>
    </div>
  );
}
