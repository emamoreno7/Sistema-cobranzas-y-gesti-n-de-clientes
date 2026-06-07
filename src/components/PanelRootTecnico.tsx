import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut } from 'lucide-react';
import { supabase } from '../supabaseClient';

type TabRoot = 'resumen' | 'sesiones' | 'errores' | 'tickets' | 'sistema';

type EventoSesion = {
  id: number;
  created_at: string;
  username: string | null;
  email: string | null;
  accion: string;
  ip: string | null;
  user_agent: string | null;
  detalle: string | null;
};

type LogAuditoria = {
  id: number;
  created_at: string;
  tipo: string;
  contexto: string;
  mensaje_error: string | null;
  actor: string | null;
  meta: Record<string, unknown> | null;
};

type DebugError = {
  id: number;
  created_at: string;
  context: string;
  payload: Record<string, unknown> | null;
};

type AuditLog = {
  id: number;
  created_at: string;
  actor: string | null;
  accion: string;
  detalle: string;
};

type Ticket = {
  id: string;
  created_at: string;
  updated_at: string;
  titulo: string;
  descripcion: string | null;
  estado: string;
  prioridad: string;
  reportado_por: string | null;
};

const TABS: { id: TabRoot; label: string; icon: string }[] = [
  { id: 'resumen', label: 'Monitor', icon: '📡' },
  { id: 'sesiones', label: 'Sesiones', icon: '🔐' },
  { id: 'errores', label: 'Errores', icon: '⚠️' },
  { id: 'tickets', label: 'Tickets', icon: '🎫' },
  { id: 'sistema', label: 'Sistema', icon: '⚙️' },
];

function fmtFecha(iso: string) {
  return String(iso || '').replace('T', ' ').slice(0, 19);
}

function badgeEstado(estado: string) {
  const map: Record<string, string> = {
    abierto: 'bg-red-500/20 text-red-200',
    en_progreso: 'bg-amber-500/20 text-amber-200',
    resuelto: 'bg-green-500/20 text-green-200',
    cerrado: 'bg-gray-500/20 text-gray-300',
  };
  return map[estado] || 'bg-gray-700 text-gray-300';
}

export function PanelRootTecnico({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<TabRoot>('resumen');
  const [loading, setLoading] = useState(false);
  const [sesiones, setSesiones] = useState<EventoSesion[]>([]);
  const [logsAud, setLogsAud] = useState<LogAuditoria[]>([]);
  const [debugErr, setDebugErr] = useState<DebugError[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [filtroSesion, setFiltroSesion] = useState('');
  const [nuevoTicket, setNuevoTicket] = useState({ titulo: '', descripcion: '', prioridad: 'media' });
  const [jornadaSinBloqueosPruebas, setJornadaSinBloqueosPruebas] = useState(false);
  const [guardandoJornadaPruebas, setGuardandoJornadaPruebas] = useState(false);
  const [configJornadaError, setConfigJornadaError] = useState<string | null>(null);

  const cargarConfigSistema = useCallback(async () => {
    setConfigJornadaError(null);
    const { data, error } = await supabase
      .from('configuracion')
      .select('jornada_sin_bloqueos_pruebas')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('configuracion (root):', error);
      const msg = String(error.message || '');
      if (msg.includes('jornada_sin_bloqueos_pruebas') || msg.includes('column')) {
        setConfigJornadaError('Falta la migración 046 en Supabase (columna jornada_sin_bloqueos_pruebas).');
      } else {
        setConfigJornadaError(msg || 'No se pudo leer configuración.');
      }
      return;
    }
    setJornadaSinBloqueosPruebas(Boolean(data?.jornada_sin_bloqueos_pruebas));
  }, []);

  const toggleJornadaSinBloqueosPruebas = useCallback(async () => {
    const nuevo = !jornadaSinBloqueosPruebas;
    setGuardandoJornadaPruebas(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from('configuracion').upsert([{
        id: 'global_config',
        jornada_sin_bloqueos_pruebas: nuevo,
        updated_at: now,
      }], { onConflict: 'id' });
      if (error) {
        const msg = String(error.message || 'error desconocido');
        if (msg.includes('jornada_sin_bloqueos_pruebas') || msg.includes('column')) {
          alert('Ejecutá la migración 046 en Supabase SQL Editor antes de usar este toggle.');
        } else {
          alert('No se pudo guardar: ' + msg);
        }
        return;
      }
      setJornadaSinBloqueosPruebas(nuevo);
      await supabase.from('audit_logs').insert([{
        actor: 'root',
        accion: nuevo ? 'JORNADA_PRUEBAS_ON' : 'JORNADA_PRUEBAS_OFF',
        detalle: nuevo
          ? 'Modo pruebas: sin bloqueo de cobros/cierres/ruta'
          : 'Modo pruebas desactivado: bloqueos normales',
      }]);
    } finally {
      setGuardandoJornadaPruebas(false);
    }
  }, [jornadaSinBloqueosPruebas]);

  const cargarDatos = useCallback(async () => {
    setLoading(true);
    try {
      const [rSes, rLog, rDbg, rAud, rTkt] = await Promise.all([
        supabase.from('eventos_sesion').select('*').order('created_at', { ascending: false }).limit(300),
        supabase.from('logs_auditoria').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('debug_errors').select('*').order('created_at', { ascending: false }).limit(150),
        supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('tickets_soporte').select('*').order('created_at', { ascending: false }).limit(100),
      ]);
      setSesiones((rSes.data ?? []) as EventoSesion[]);
      setLogsAud((rLog.data ?? []) as LogAuditoria[]);
      setDebugErr((rDbg.data ?? []) as DebugError[]);
      setAuditLogs((rAud.data ?? []) as AuditLog[]);
      setTickets((rTkt.data ?? []) as Ticket[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargarDatos();
    void cargarConfigSistema();
  }, [cargarDatos, cargarConfigSistema]);

  const sesionesFiltradas = useMemo(() => {
    const q = filtroSesion.trim().toLowerCase();
    if (!q) return sesiones;
    return sesiones.filter(s =>
      [s.username, s.email, s.accion, s.ip, s.detalle].some(v => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [sesiones, filtroSesion]);

  const kpis = useMemo(() => {
    const hoy = new Date().toISOString().slice(0, 10);
    const loginsHoy = sesiones.filter(s => s.accion === 'LOGIN_SUCCESS' && String(s.created_at).startsWith(hoy)).length;
    const fallosHoy = sesiones.filter(s => s.accion === 'LOGIN_FAILED' && String(s.created_at).startsWith(hoy)).length;
    return {
      loginsHoy,
      fallosHoy,
      erroresAud: logsAud.length,
      debugTotal: debugErr.length,
      ticketsAbiertos: tickets.filter(t => t.estado === 'abierto' || t.estado === 'en_progreso').length,
    };
  }, [sesiones, logsAud, debugErr, tickets]);

  const crearTicket = async () => {
    if (!nuevoTicket.titulo.trim()) return;
    const { error } = await supabase.from('tickets_soporte').insert([{
      titulo: nuevoTicket.titulo.trim(),
      descripcion: nuevoTicket.descripcion.trim() || null,
      prioridad: nuevoTicket.prioridad,
      reportado_por: 'root',
      origen: 'root_console',
    } as never]);
    if (error) {
      alert('No se pudo crear el ticket: ' + error.message);
      return;
    }
    setNuevoTicket({ titulo: '', descripcion: '', prioridad: 'media' });
    void cargarDatos();
  };

  const cardModoPruebasJornada = (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-3">
      <div>
        <p className="font-semibold text-white">Modo pruebas — cobros sin bloqueo de jornada</p>
        <p className="text-xs text-gray-400 leading-relaxed mt-1">
          Permite a cobradores y vendedores cobrar, cerrar jornada y usar la ruta «Por cobrar» sin quedar bloqueados
          por rendición pendiente. Solo para pruebas; desactivá al terminar.
        </p>
      </div>
      {configJornadaError && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          ⚠️ {configJornadaError}
        </p>
      )}
      <button
        type="button"
        disabled={guardandoJornadaPruebas || Boolean(configJornadaError)}
        onClick={() => void toggleJornadaSinBloqueosPruebas()}
        className={`w-full py-3 rounded-xl border font-semibold text-sm transition ${
          jornadaSinBloqueosPruebas
            ? 'bg-violet-600/30 border-violet-400/50 text-violet-100'
            : 'bg-gray-800 border-gray-600 text-gray-300'
        } disabled:opacity-50`}
      >
        {guardandoJornadaPruebas
          ? 'Guardando…'
          : jornadaSinBloqueosPruebas
            ? '🧪 ACTIVO — Tocar para desactivar'
            : 'Activar modo pruebas (sin bloqueos)'}
      </button>
      {jornadaSinBloqueosPruebas && (
        <p className="text-[11px] text-violet-300/80 text-center">
          Los usuarios en campo verán un aviso violeta. Los cambios se aplican al instante vía realtime.
        </p>
      )}
    </div>
  );

  const actualizarTicketEstado = async (id: string, estado: string) => {
    const { error } = await supabase.from('tickets_soporte').update({
      estado,
      updated_at: new Date().toISOString(),
    } as never).eq('id', id);
    if (error) alert(error.message);
    else void cargarDatos();
  };

  return (
    <div className="space-y-4 pb-24">
      <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/40 to-gray-950 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/80">Operador técnico</p>
            <h2 className="text-xl font-bold text-white mt-1">Consola Root</h2>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Monitoreo de sesiones, errores y tickets. Sin gestión de cobranzas.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => { void cargarDatos(); void cargarConfigSistema(); }}
              disabled={loading}
              className="text-xs bg-emerald-600/30 border border-emerald-500/40 text-emerald-100 px-3 py-2 rounded-lg font-semibold"
              title="Actualizar datos"
            >
              {loading ? '…' : '↻'}
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center gap-1 text-xs bg-red-500/15 border border-red-500/35 text-red-200 px-3 py-2 rounded-lg font-semibold active:scale-95 transition"
              title="Cerrar sesión / cambiar usuario"
            >
              <LogOut className="w-3.5 h-3.5" aria-hidden />
              Salir
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`shrink-0 px-3 py-2 rounded-xl text-xs font-semibold transition ${
              tab === t.id
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-800/80 text-gray-400 border border-gray-700'
            }`}
          >
            {t.icon} {t.label}
            {t.id === 'sistema' && jornadaSinBloqueosPruebas && (
              <span className="ml-1 text-[9px] bg-violet-500 text-white px-1 rounded">ON</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'resumen' && (
        <div className="space-y-3">
          {cardModoPruebasJornada}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-[10px] text-gray-500">Logins hoy</p>
              <p className="text-2xl font-bold text-emerald-300">{kpis.loginsHoy}</p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-[10px] text-gray-500">Fallos login hoy</p>
              <p className="text-2xl font-bold text-red-300">{kpis.fallosHoy}</p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-[10px] text-gray-500">Errores auditoría</p>
              <p className="text-2xl font-bold text-amber-300">{kpis.erroresAud}</p>
            </div>
            <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-[10px] text-gray-500">Tickets abiertos</p>
              <p className="text-2xl font-bold text-violet-300">{kpis.ticketsAbiertos}</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 text-center">
            Últimos eventos: {sesiones[0] ? fmtFecha(sesiones[0].created_at) : '—'}
          </p>
        </div>
      )}

      {tab === 'sesiones' && (
        <div className="space-y-3">
          <input
            type="search"
            value={filtroSesion}
            onChange={e => setFiltroSesion(e.target.value)}
            placeholder="Filtrar usuario, IP, acción…"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white"
          />
          <p className="text-xs text-gray-500">{sesionesFiltradas.length} registros</p>
          <div className="space-y-2 max-h-[55vh] overflow-y-auto">
            {sesionesFiltradas.map(s => (
              <div key={s.id} className="rounded-xl border border-gray-800 bg-gray-900/50 p-3 text-xs">
                <div className="flex justify-between gap-2 mb-1">
                  <span className={`font-bold ${
                    s.accion === 'LOGIN_SUCCESS' ? 'text-emerald-400'
                      : s.accion === 'LOGIN_FAILED' ? 'text-red-400'
                        : 'text-gray-300'
                  }`}>{s.accion}</span>
                  <span className="text-gray-500 shrink-0">{fmtFecha(s.created_at)}</span>
                </div>
                <p className="text-gray-300">
                  <span className="text-gray-500">Usuario:</span> {s.username || '—'}
                  {' · '}
                  <span className="text-gray-500">IP:</span>{' '}
                  <span className="font-mono text-cyan-300/90">{s.ip || 'sin dato'}</span>
                </p>
                {s.email && <p className="text-gray-500 mt-0.5">{s.email}</p>}
                {s.detalle && <p className="text-gray-400 mt-1">{s.detalle}</p>}
              </div>
            ))}
            {sesionesFiltradas.length === 0 && !loading && (
              <p className="text-center text-gray-500 py-8">Sin sesiones (¿ejecutaste migración 030?)</p>
            )}
          </div>
        </div>
      )}

      {tab === 'errores' && (
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          <section>
            <h3 className="text-sm font-semibold text-amber-200 mb-2">Logs auditoría (cobros/créditos)</h3>
            <div className="space-y-2">
              {logsAud.map(e => (
                <div key={`la-${e.id}`} className="rounded-lg border border-amber-900/40 bg-gray-900/40 p-2 text-[11px]">
                  <div className="flex justify-between text-gray-500">
                    <span>{fmtFecha(e.created_at)}</span>
                    <span>{e.tipo}</span>
                  </div>
                  <p className="text-gray-200 font-medium">{e.contexto}</p>
                  {e.mensaje_error && <p className="text-red-300 mt-1">{e.mensaje_error}</p>}
                  {e.actor && <p className="text-indigo-400/80 mt-0.5">{e.actor}</p>}
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-red-200 mb-2">Debug errors (críticos)</h3>
            <div className="space-y-2">
              {debugErr.map(e => (
                <div key={`de-${e.id}`} className="rounded-lg border border-red-900/40 bg-gray-900/40 p-2 text-[11px]">
                  <p className="text-gray-500">{fmtFecha(e.created_at)} · {e.context}</p>
                  <pre className="text-gray-400 mt-1 whitespace-pre-wrap break-all max-h-24 overflow-auto">
                    {JSON.stringify(e.payload ?? {}, null, 0).slice(0, 800)}
                  </pre>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Audit log (acciones app)</h3>
            <div className="space-y-1">
              {auditLogs.slice(0, 40).map(e => (
                <div key={`al-${e.id}`} className="text-[11px] py-1.5 border-b border-gray-800/80">
                  <span className="text-gray-500">{fmtFecha(e.created_at)}</span>
                  {' · '}
                  <span className="text-emerald-400/90">{e.accion}</span>
                  {' · '}
                  <span className="text-gray-400">{e.actor || 'sistema'}</span>
                  <p className="text-gray-500 truncate">{e.detalle}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'tickets' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-violet-500/25 bg-violet-950/20 p-3 space-y-2">
            <p className="text-sm font-semibold text-violet-200">Nuevo ticket</p>
            <input
              value={nuevoTicket.titulo}
              onChange={e => setNuevoTicket(p => ({ ...p, titulo: e.target.value }))}
              placeholder="Título"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <textarea
              value={nuevoTicket.descripcion}
              onChange={e => setNuevoTicket(p => ({ ...p, descripcion: e.target.value }))}
              placeholder="Descripción"
              rows={2}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <select
              value={nuevoTicket.prioridad}
              onChange={e => setNuevoTicket(p => ({ ...p, prioridad: e.target.value }))}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="baja">Baja</option>
              <option value="media">Media</option>
              <option value="alta">Alta</option>
              <option value="critica">Crítica</option>
            </select>
            <button
              type="button"
              onClick={() => void crearTicket()}
              className="w-full bg-violet-600 text-white font-semibold py-2 rounded-lg text-sm"
            >
              Crear ticket
            </button>
          </div>
          <div className="space-y-2 max-h-[45vh] overflow-y-auto">
            {tickets.map(t => (
              <div key={t.id} className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">
                <div className="flex justify-between items-start gap-2">
                  <p className="font-semibold text-sm text-white">{t.titulo}</p>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${badgeEstado(t.estado)}`}>{t.estado}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{fmtFecha(t.created_at)} · {t.prioridad}</p>
                {t.descripcion && <p className="text-xs text-gray-400 mt-2">{t.descripcion}</p>}
                <div className="flex gap-2 mt-2 flex-wrap">
                  {t.estado !== 'en_progreso' && (
                    <button type="button" onClick={() => void actualizarTicketEstado(t.id, 'en_progreso')}
                      className="text-[10px] px-2 py-1 rounded bg-amber-600/30 text-amber-100">En progreso</button>
                  )}
                  {t.estado !== 'resuelto' && (
                    <button type="button" onClick={() => void actualizarTicketEstado(t.id, 'resuelto')}
                      className="text-[10px] px-2 py-1 rounded bg-green-600/30 text-green-100">Resuelto</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'sistema' && (
        <div className="space-y-3 text-sm text-gray-300">
          <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 space-y-2">
            <p className="font-semibold text-white">Acceso operativo</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              Usuario <strong className="text-emerald-300">root</strong> / <strong className="text-emerald-300">root@emd.com</strong>.
              Marcos y cobradores usan la app de gestión; vos solo esta consola.
            </p>
            <p className="text-xs text-gray-500">
              Migraciones: 030 (sesiones, tickets), 046 (modo pruebas jornada).
            </p>
          </div>
          {cardModoPruebasJornada}
          <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 space-y-2">
            <p className="font-semibold text-white">Herramientas</p>
            <button
              type="button"
              onClick={() => {
                const w = window as Window & { dotcomLimpiarStorageEntrega?: () => Promise<unknown> };
                if (typeof w.dotcomLimpiarStorageEntrega === 'function') {
                  void w.dotcomLimpiarStorageEntrega();
                } else {
                  alert('Iniciá sesión como Marcos para vaciar Storage, o usá la consola del navegador.');
                }
              }}
              className="w-full py-2 rounded-lg bg-gray-800 border border-gray-600 text-gray-200 text-xs font-semibold"
            >
              Vaciar Storage (si está disponible)
            </button>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="w-full py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 font-semibold"
          >
            Cerrar sesión Root
          </button>
        </div>
      )}
    </div>
  );
}
