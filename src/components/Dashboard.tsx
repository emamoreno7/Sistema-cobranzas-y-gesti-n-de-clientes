import { getAuditoria } from '../utils/exports';

/**
 * Logs de auditoría local en el inicio (solo sesión MarcosP: no existe en el DOM para cobradores ni otros usuarios).
 */
export function DashboardLogsSistema({ esMarcosP }: { esMarcosP: boolean }) {
  if (!esMarcosP) return null;

  const auditoria = getAuditoria();
  const recientes = auditoria.slice(0, 5);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4">
      <h3 className="font-bold text-sm text-gray-300 mb-3">Logs de Sistema</h3>
      <div className="space-y-2">
        {recientes.map(e => (
          <div key={e.id} className="flex items-center gap-3 py-2 border-b border-gray-800/50 last:border-0">
            <span className="text-xs text-gray-500 w-16">{e.hora}</span>
            <span className="text-xs text-gray-300 flex-1">{e.detalle}</span>
          </div>
        ))}
        {auditoria.length === 0 && (
          <p className="text-gray-500 text-xs text-center">Sin actividad reciente</p>
        )}
      </div>
    </div>
  );
}
