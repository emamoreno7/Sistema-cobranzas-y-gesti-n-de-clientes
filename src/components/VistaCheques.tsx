import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Options as Html2CanvasOptions } from 'html2canvas';
import { supabase } from '../supabaseClient';
import { ComprobanteLiquidacionCheque } from './ComprobanteLiquidacionCheque';
import {
  calcularLiquidacionCheque,
  DIAS_RETENCION_CHEQUE_ACEPTADO,
  DIAS_RETENCION_CHEQUE_RECHAZADO,
  diasHastaVencimientoCheque,
  fmtPesos,
  INTERES_MINIMO_CHEQUE_PCT,
  TASA_INTERES_CHEQUE_DIARIA_PCT,
  type LiquidacionCheque,
} from '../utils/chequesCalculo';

const BUCKET_CHEQUES = 'cheques-fotos';

export type ChequeRow = {
  id: string;
  created_at: string;
  solicitante: string;
  fecha_vencimiento: string;
  importe: number;
  numero_cheque: string;
  foto_url: string | null;
  foto_path: string | null;
  estado: 'pendiente' | 'aceptado' | 'rechazado';
  creado_por: string | null;
  revisado_por: string | null;
  revisado_at: string | null;
  eliminar_en: string | null;
};

type FormCheque = {
  solicitante: string;
  fecha_vencimiento: string;
  importe: string;
  numero_cheque: string;
  foto: File | null;
  previewUrl: string;
};

const formVacio = (): FormCheque => ({
  solicitante: '',
  fecha_vencimiento: '',
  importe: '',
  numero_cheque: '',
  foto: null,
  previewUrl: '',
});

function badgeEstado(estado: string) {
  if (estado === 'aceptado') return 'bg-green-500/20 text-green-200 border-green-500/40';
  if (estado === 'rechazado') return 'bg-red-500/20 text-red-200 border-red-500/40';
  return 'bg-amber-500/20 text-amber-200 border-amber-500/40';
}

function fmtFecha(iso: string) {
  const s = String(iso || '').slice(0, 10);
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function html2canvasOpciones(backgroundColor: string): Partial<Html2CanvasOptions> {
  return {
    backgroundColor,
    scale: 2,
    useCORS: true,
    logging: false,
    foreignObjectRendering: false,
  };
}

async function esperarImagenesEnNodo(nodo: HTMLElement, msMax = 8000) {
  const imgs = Array.from(nodo.querySelectorAll('img'));
  await Promise.all(
    imgs.map(
      img =>
        new Promise<void>(resolve => {
          if (img.complete && img.naturalWidth > 0) {
            resolve();
            return;
          }
          const fin = () => resolve();
          img.addEventListener('load', fin, { once: true });
          img.addEventListener('error', fin, { once: true });
          window.setTimeout(fin, msMax);
        }),
    ),
  );
  await new Promise(r => window.setTimeout(r, 120));
}

export function VistaCheques({
  esMarcosOperador,
  esAdminCheques,
  actorLabel,
}: {
  esMarcosOperador: boolean;
  /** Marcos / admin: eliminar cheques cuando haga falta. */
  esAdminCheques: boolean;
  actorLabel: string;
}) {
  const [cheques, setCheques] = useState<ChequeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [modalAlta, setModalAlta] = useState(false);
  const [form, setForm] = useState<FormCheque>(formVacio);
  const [guardando, setGuardando] = useState(false);
  const [compartiendoId, setCompartiendoId] = useState<string | null>(null);
  const pdfRef = useRef<HTMLDivElement | null>(null);
  const [pdfPayload, setPdfPayload] = useState<{
    cheque: ChequeRow;
    liq: LiquidacionCheque;
  } | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      await supabase.rpc('limpiar_cheques_expirados');
      const { data, error } = await supabase
        .from('cheques')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setCheques((data ?? []) as ChequeRow[]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error al cargar cheques';
      alert(msg + ' (¿ejecutaste migración 032?)');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return cheques;
    return cheques.filter(c =>
      [c.numero_cheque, c.solicitante, c.creado_por].some(v => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [cheques, busqueda]);

  const subirFoto = async (file: File, chequeId: string) => {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `public/${chequeId}/foto_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET_CHEQUES).upload(path, file, {
      upsert: true,
      contentType: file.type || 'image/jpeg',
    });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET_CHEQUES).getPublicUrl(path);
    return { url: data.publicUrl, path };
  };

  const guardarCheque = async () => {
    const solicitante = form.solicitante.trim();
    const numero = form.numero_cheque.trim();
    const fv = form.fecha_vencimiento.trim();
    const importe = Number(String(form.importe).replace(',', '.'));
    if (!solicitante || !numero || !fv || !importe || importe <= 0) {
      alert('Completá solicitante, número, vencimiento e importe.');
      return;
    }
    if (!form.foto) {
      alert('La foto del cheque es obligatoria.');
      return;
    }
    setGuardando(true);
    try {
      const id = crypto.randomUUID();
      const foto = await subirFoto(form.foto, id);
      const { error } = await supabase.from('cheques').insert([{
        id,
        solicitante,
        fecha_vencimiento: fv,
        importe,
        numero_cheque: numero,
        foto_url: foto.url,
        foto_path: foto.path,
        estado: 'pendiente',
        creado_por: actorLabel,
      } as never]);
      if (error) throw error;
      setModalAlta(false);
      setForm(formVacio());
      await cargar();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'No se pudo guardar el cheque');
    } finally {
      setGuardando(false);
    }
  };

  const revisarCheque = async (id: string, accion: 'aceptado' | 'rechazado') => {
    if (!esMarcosOperador) return;
    const diasRet = accion === 'aceptado' ? DIAS_RETENCION_CHEQUE_ACEPTADO : DIAS_RETENCION_CHEQUE_RECHAZADO;
    const eliminarEn = new Date(Date.now() + diasRet * 86400000).toISOString();
    const { error } = await supabase.from('cheques').update({
      estado: accion,
      revisado_por: actorLabel,
      revisado_at: new Date().toISOString(),
      eliminar_en: eliminarEn,
      updated_at: new Date().toISOString(),
    } as never).eq('id', id);
    if (error) {
      alert(error.message);
      return;
    }
    await cargar();
  };

  const eliminarCheque = async (c: ChequeRow) => {
    if (!esAdminCheques) return;
    if (!window.confirm(`¿Eliminar el cheque Nº ${c.numero_cheque} de ${c.solicitante}? Esta acción no se puede deshacer.`)) {
      return;
    }
    try {
      if (c.foto_path) {
        await supabase.storage.from(BUCKET_CHEQUES).remove([c.foto_path]);
      }
      const { error } = await supabase.from('cheques').delete().eq('id', c.id);
      if (error) throw error;
      await cargar();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'No se pudo eliminar (¿sos admin y corriste migración 033?)');
    }
  };

  const generarPdfCheque = useCallback(async (cheque: ChequeRow, liq: LiquidacionCheque) => {
    setPdfPayload({ cheque, liq });
    await new Promise(r => window.setTimeout(r, 100));
    const nodo = pdfRef.current;
    if (!nodo) throw new Error('No se pudo armar el documento.');
    await esperarImagenesEnNodo(nodo);
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(nodo, html2canvasOpciones('#f0f9ff'));
    const { jsPDF } = await import('jspdf');
    const img = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 12;
    const w = pw - margin * 2;
    const h = (canvas.height * w) / canvas.width;
    const drawH = Math.min(h, ph - margin * 2);
    const y = drawH < ph - margin * 2 ? (ph - drawH) / 2 : margin;
    pdf.addImage(img, 'PNG', margin, y, w, drawH);
    pdf.save(`Liquidacion_Cheque_${cheque.numero_cheque}_${String(cheque.fecha_vencimiento).slice(0, 10)}.pdf`);
    setPdfPayload(null);
  }, []);

  const compartirLiquidacion = async (cheque: ChequeRow) => {
    const liq = calcularLiquidacionCheque(Number(cheque.importe), cheque.fecha_vencimiento);
    setCompartiendoId(cheque.id);
    try {
      await generarPdfCheque(cheque, liq);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'No se pudo generar el PDF');
    } finally {
      setCompartiendoId(null);
    }
  };

  return (
    <div className="space-y-4 pb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Cheques</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Comisión 0,4 %/día (mín. {INTERES_MINIMO_CHEQUE_PCT} %), hasta vencimiento +1 día admin. Aceptados se archivan {DIAS_RETENCION_CHEQUE_ACEPTADO} días.
            {esMarcosOperador ? ' Podés aprobar, rechazar y eliminar registros.' : esAdminCheques ? ' Podés eliminar registros.' : ' Marcos aprueba las solicitudes.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalAlta(true)}
          className="shrink-0 bg-indigo-600 text-white font-semibold px-4 py-2.5 rounded-xl text-sm active:scale-95 transition"
        >
          + Nuevo cheque
        </button>
      </div>

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">🔍</span>
        <input
          type="search"
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          placeholder="Buscar por número o titular…"
          className="w-full bg-gray-900/80 border border-gray-700 rounded-xl pl-10 pr-3 py-2.5 text-sm text-white"
        />
      </div>

      {loading && <p className="text-center text-gray-500 text-sm">Cargando…</p>}

      <div className="space-y-3">
        {filtrados.map(c => {
          const liq = calcularLiquidacionCheque(Number(c.importe), c.fecha_vencimiento);
          const dias = diasHastaVencimientoCheque(c.fecha_vencimiento);
          return (
            <article
              key={c.id}
              className="rounded-2xl border border-gray-800 bg-gray-900/50 overflow-hidden"
            >
              {c.foto_url && (
                <img src={c.foto_url} alt="" className="w-full max-h-48 object-contain bg-black/40" />
              )}
              <div className="p-4 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-white">{c.solicitante}</p>
                    <p className="text-xs text-gray-500">Nº {c.numero_cheque}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${badgeEstado(c.estado)}`}>
                    {c.estado}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <p className="text-gray-500">Vencimiento</p>
                    <p className="text-gray-200 font-medium">{fmtFecha(c.fecha_vencimiento)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Importe cheque</p>
                    <p className="text-cyan-300 font-bold">{fmtPesos(Number(c.importe))}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Venc. (días)</p>
                    <p className="text-gray-200 font-medium">{dias}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Días comisión (venc.+1)</p>
                    <p className="text-gray-200 font-medium">{liq.dias}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">
                      Comisión ({TASA_INTERES_CHEQUE_DIARIA_PCT}%/día, mín. {INTERES_MINIMO_CHEQUE_PCT}%)
                    </p>
                    <p className="text-amber-300 font-medium">
                      {fmtPesos(liq.interes)}
                      {liq.interesMinimoAplicado ? ' · mín.' : ''}
                    </p>
                  </div>
                </div>
                <div className="rounded-xl bg-indigo-950/40 border border-indigo-500/30 px-3 py-2">
                  <p className="text-[10px] text-indigo-300/80 uppercase tracking-wide">Monto a entregar al cliente</p>
                  <p className="text-lg font-bold text-indigo-100">{fmtPesos(liq.montoRecibir)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {fmtPesos(Number(c.importe))} − {fmtPesos(liq.interes)} · redondeo a $1.000
                  </p>
                </div>
                {c.eliminar_en && (
                  <p className="text-[10px] text-gray-500">
                    Archivo hasta: {fmtFecha(c.eliminar_en)}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    disabled={compartiendoId === c.id}
                    onClick={() => void compartirLiquidacion(c)}
                    className="text-xs font-semibold px-3 py-2 rounded-lg bg-cyan-600/25 border border-cyan-500/40 text-cyan-100"
                  >
                    {compartiendoId === c.id ? '…' : '📄 PDF liquidación'}
                  </button>
                  {esMarcosOperador && c.estado === 'pendiente' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void revisarCheque(c.id, 'aceptado')}
                        className="text-xs font-semibold px-3 py-2 rounded-lg bg-green-600/25 border border-green-500/40 text-green-100"
                      >
                        Aceptar
                      </button>
                      <button
                        type="button"
                        onClick={() => void revisarCheque(c.id, 'rechazado')}
                        className="text-xs font-semibold px-3 py-2 rounded-lg bg-red-600/25 border border-red-500/40 text-red-100"
                      >
                        Rechazar
                      </button>
                    </>
                  )}
                  {esAdminCheques && (
                    <button
                      type="button"
                      onClick={() => void eliminarCheque(c)}
                      className="text-xs font-semibold px-3 py-2 rounded-lg bg-gray-700/80 border border-gray-500/50 text-gray-200"
                      title="Eliminar cheque (solo admin)"
                    >
                      🗑️ Eliminar
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        {!loading && filtrados.length === 0 && (
          <p className="text-center text-gray-500 py-10 text-sm">Sin cheques registrados</p>
        )}
      </div>

      {modalAlta && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 p-4 space-y-3">
            <h3 className="text-lg font-bold text-white">Nuevo cheque</h3>
            <label className="block text-xs text-gray-400">
              Foto del cheque *
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="mt-1 w-full text-sm text-gray-300"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setForm(prev => ({
                    ...prev,
                    foto: f,
                    previewUrl: URL.createObjectURL(f),
                  }));
                }}
              />
            </label>
            {form.previewUrl && (
              <img src={form.previewUrl} alt="" className="w-full max-h-40 object-contain rounded-lg bg-black/30" />
            )}
            <label className="block text-xs text-gray-400">
              Nombre del solicitante *
              <input
                value={form.solicitante}
                onChange={e => setForm(p => ({ ...p, solicitante: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-gray-400">
              Número de cheque *
              <input
                value={form.numero_cheque}
                onChange={e => setForm(p => ({ ...p, numero_cheque: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-gray-400">
              Fecha vencimiento *
              <input
                type="date"
                value={form.fecha_vencimiento}
                onChange={e => setForm(p => ({ ...p, fecha_vencimiento: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-gray-400">
              Importe del cheque *
              <input
                type="number"
                min={1}
                step={1}
                value={form.importe}
                onChange={e => setForm(p => ({ ...p, importe: e.target.value }))}
                className="mt-1 w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </label>
            {form.fecha_vencimiento && form.importe && (
              <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/30 p-3 text-xs text-indigo-100">
                {(() => {
                  const liq = calcularLiquidacionCheque(Number(form.importe), form.fecha_vencimiento);
                  return (
                    <>
                      <p>
                        Vista previa: {liq.dias} días (venc.+1) · Comisión {fmtPesos(liq.interes)}
                        {liq.interesMinimoAplicado ? ` (mín. ${INTERES_MINIMO_CHEQUE_PCT}%)` : ''}
                      </p>
                      <p className="font-bold mt-1">A recibir: {fmtPesos(liq.montoRecibir)}</p>
                    </>
                  );
                })()}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setModalAlta(false); setForm(formVacio()); }}
                className="flex-1 py-2.5 rounded-xl border border-gray-600 text-gray-300 text-sm font-semibold"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={guardando}
                onClick={() => void guardarCheque()}
                className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
              >
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pdfPayload && (
        <div ref={pdfRef} style={{ position: 'fixed', left: '-9999px', top: 0, zIndex: -1 }}>
          <ComprobanteLiquidacionCheque cheque={pdfPayload.cheque} liq={pdfPayload.liq} />
        </div>
      )}
    </div>
  );
}
