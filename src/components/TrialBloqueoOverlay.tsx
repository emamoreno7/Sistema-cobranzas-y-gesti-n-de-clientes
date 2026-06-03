import { MSG_TRIAL_EXPIRADO } from '../utils/trialLicencia';

type TrialBloqueoOverlayProps = {
  activo: boolean;
  onCerrarSesion: () => void;
};

export function TrialBloqueoOverlay({ activo, onCerrarSesion }: TrialBloqueoOverlayProps) {
  if (!activo) return null;
  return (
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center p-6 bg-black/70 backdrop-blur-[2px]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="trial-bloqueo-titulo"
    >
      <div className="w-full max-w-sm rounded-3xl border border-red-500/30 bg-gray-950 px-6 py-8 text-center shadow-2xl">
        <p className="text-4xl mb-3" aria-hidden>⏱️</p>
        <h2 id="trial-bloqueo-titulo" className="text-lg font-bold text-white">
          Período de prueba finalizado
        </h2>
        <p className="text-sm text-gray-400 mt-3 leading-relaxed">{MSG_TRIAL_EXPIRADO}</p>
        <p className="text-xs text-gray-500 mt-4">
          Podés revisar la guía del sistema, pero no registrar cobros, clientes ni cambios hasta activar la licencia.
        </p>
        <button
          type="button"
          onClick={onCerrarSesion}
          className="mt-6 w-full bg-gray-800 hover:bg-gray-700 border border-gray-600 text-gray-200 font-semibold py-3 rounded-xl transition active:scale-[0.98]"
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
