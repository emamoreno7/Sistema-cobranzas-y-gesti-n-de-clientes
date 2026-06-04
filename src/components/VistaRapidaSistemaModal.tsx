import { useState } from 'react';

export type ModuloSistemaDestacado = {
  icon: string;
  titulo: string;
  descripcion: string;
  pestana?: string;
};

export const MODULOS_SISTEMA_DESTACADOS: ModuloSistemaDestacado[] = [
  {
    icon: '🏠',
    titulo: 'Inicio',
    descripcion: 'Resumen del día: cobrado, mora, promesas, cumpleaños, calculadora de planes y accesos rápidos.',
    pestana: 'Inicio',
  },
  {
    icon: '👥',
    titulo: 'Clientes',
    descripcion: 'Alta con DNI, video de verificación, GPS, cobros, comprobantes, WhatsApp y escaneo QR.',
    pestana: 'Clientes',
  },
  {
    icon: '📋',
    titulo: 'Fichas',
    descripcion: 'Planes diarios, semanales o mensuales; seguimiento de cuotas y saldos por cliente.',
    pestana: 'Fichas',
  },
  {
    icon: '🏦',
    titulo: 'Créditos',
    descripcion: 'Mercadería (M) y préstamo (P), tasas configurables, cartón digital, aprobación admin y comisiones.',
    pestana: 'Créditos',
  },
  {
    icon: '🗺️',
    titulo: 'Ruta del día',
    descripcion: 'Recorrido ordenado, registro de no pago, cierre de jornada y aviso al administrador.',
    pestana: 'Ruta',
  },
  {
    icon: '🧾',
    titulo: 'Caja y rendición',
    descripcion: 'Cierre de caja (efectivo/transferencias), rendición de cobradores y validación central.',
    pestana: 'Caja / Rendición',
  },
  {
    icon: '🧭',
    titulo: 'Panel de control',
    descripcion: 'Efectividad por cobrador: cobrado, gastos, total a cobrar hoy y movimientos de caja en vivo.',
    pestana: 'Control',
  },
  {
    icon: '💸',
    titulo: 'Gastos',
    descripcion: 'Gastos de campo por cobrador vinculados a la jornada y rendiciones.',
    pestana: 'Gastos',
  },
  {
    icon: '💰',
    titulo: 'Comisiones',
    descripcion: 'Porcentaje por vendedor, aprobación de ventas y liquidación semanal.',
    pestana: 'Ajustes → Comisiones',
  },
  {
    icon: '⚙️',
    titulo: 'Ajustes',
    descripcion: 'Datos de empresa, intereses M/P, mora, WhatsApp admin y modo alto contraste.',
    pestana: 'Ajustes',
  },
  {
    icon: '📅',
    titulo: 'Sistema mensual',
    descripcion: 'Cartera aislada con planes a 1–12 meses y tasas personalizables.',
    pestana: 'Sistema Mensual',
  },
  {
    icon: '🤝',
    titulo: 'Proveedores',
    descripcion: 'Inversiones externas, ingreso a caja y seguimiento de devoluciones.',
    pestana: 'Proveedores',
  },
];

type VistaRapidaSistemaModalProps = {
  open: boolean;
  onClose: () => void;
  /** Muestra bloque usuario demo prueba/prueba */
  mostrarCredencialesDemo?: boolean;
};

export function VistaRapidaSistemaModal({
  open,
  onClose,
  mostrarCredencialesDemo = true,
}: VistaRapidaSistemaModalProps) {
  const [tab, setTab] = useState<'modulos' | 'roles'>('modulos');

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[250] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vista-rapida-titulo"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg max-h-[92vh] sm:max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl border border-cyan-500/25 bg-gray-950 shadow-2xl shadow-cyan-900/20"
        onClick={e => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-5 pb-3 border-b border-gray-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80 font-light">DotCom Gestión</p>
              <h2 id="vista-rapida-titulo" className="text-xl font-bold text-white mt-1">
                Guía rápida del sistema
              </h2>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                Funciones principales para demos y nuevos usuarios.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 w-9 h-9 rounded-full bg-gray-800 text-gray-300 text-lg leading-none hover:bg-gray-700"
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={() => setTab('modulos')}
              className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                tab === 'modulos' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400'
              }`}
            >
              Módulos
            </button>
            <button
              type="button"
              onClick={() => setTab('roles')}
              className={`flex-1 rounded-lg py-2 text-xs font-semibold transition ${
                tab === 'roles' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400'
              }`}
            >
              Perfiles
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 min-h-0">
          {tab === 'modulos' && MODULOS_SISTEMA_DESTACADOS.map(m => (
            <div
              key={m.titulo}
              className="rounded-2xl border border-gray-800 bg-gray-900/60 p-3.5 flex gap-3"
            >
              <span className="text-2xl shrink-0" aria-hidden>{m.icon}</span>
              <div className="min-w-0">
                <p className="font-semibold text-white text-sm">{m.titulo}</p>
                {m.pestana && (
                  <p className="text-[10px] text-cyan-400/90 mt-0.5">Pestaña: {m.pestana}</p>
                )}
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">{m.descripcion}</p>
              </div>
            </div>
          ))}

          {tab === 'roles' && (
            <>
              {[
                { rol: 'Administración', items: ['Todo el sistema', 'Aprobar créditos', 'Comisiones', 'Control', 'Ajustes', 'Rendiciones'] },
                { rol: 'Cobradores', items: ['Clientes y ruta', 'Cobros y no pago', 'Cierre de jornada', 'Sin panel administrativo'] },
                { rol: 'Vendedores', items: ['Alta de créditos', 'Comisiones pendientes de aprobación', 'Cartón y notificación al administrador'] },
                { rol: 'Sistema Mensual', items: ['Cartera mensual aislada', 'Planes y recibos propios'] },
                { rol: 'Proveedores', items: ['Inversiones y seguimiento de rendimiento'] },
              ].map(r => (
                <div key={r.rol} className="rounded-2xl border border-gray-800 bg-gray-900/60 p-3.5">
                  <p className="font-semibold text-violet-200 text-sm">{r.rol}</p>
                  <ul className="mt-2 space-y-1">
                    {r.items.map(it => (
                      <li key={it} className="text-xs text-gray-400 flex gap-2">
                        <span className="text-cyan-500 shrink-0">•</span>
                        {it}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}

          {mostrarCredencialesDemo && tab === 'modulos' && (
            <div className="rounded-2xl border border-amber-500/35 bg-amber-500/10 p-4">
              <p className="text-sm font-semibold text-amber-200">Usuario demo (acceso completo)</p>
              <p className="text-xs text-amber-100/80 mt-1">
                Usuario: <strong className="text-white">prueba</strong>
                {' · '}
                Contraseña: <strong className="text-white">prueba</strong>
              </p>
              <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                Cuenta de demostración con acceso administrativo completo para explorar el sistema.
              </p>
            </div>
          )}
        </div>

        <div className="shrink-0 p-4 border-t border-gray-800 safe-area-pb">
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold py-3 rounded-xl active:scale-[0.98] transition"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}
