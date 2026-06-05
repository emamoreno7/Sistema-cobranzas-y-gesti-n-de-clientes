import type { LiquidacionCheque } from '../utils/chequesCalculo';
import { fmtPesos } from '../utils/chequesCalculo';

type ChequeComprobante = {
  solicitante: string;
  numero_cheque: string;
  fecha_vencimiento: string;
  foto_url: string | null;
};

const MARCA = 'DotCom';
const DESCRIPTOR = 'Sistema de Gestión';

function fmtFechaLarga(iso: string) {
  const s = String(iso || '').slice(0, 10);
  if (!s) return '—';
  try {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return s;
  }
}

function logoUrl() {
  const base = String(import.meta.env.BASE_URL || '/');
  return `${base}${base.endsWith('/') ? '' : '/'}apple-touch-icon.png?v=2`;
}

export function ComprobanteLiquidacionCheque({
  cheque,
  liq,
}: {
  cheque: ChequeComprobante;
  liq: LiquidacionCheque;
}) {
  const emitido = new Date().toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      style={{
        width: '420px',
        fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif',
        color: '#0f172a',
        background: 'linear-gradient(180deg, #f0f9ff 0%, #ffffff 28%)',
        borderRadius: '20px',
        overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(12, 74, 110, 0.12)',
        border: '1px solid #bae6fd',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, #0c4a6e 0%, #075985 55%, #0369a1 100%)',
          padding: '20px 22px 18px',
          color: '#fff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <img
            src={logoUrl()}
            alt=""
            width={52}
            height={52}
            style={{
              borderRadius: '14px',
              boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
              border: '2px solid rgba(255,255,255,0.35)',
              flexShrink: 0,
            }}
            crossOrigin="anonymous"
          />
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: 0,
                fontSize: '22px',
                fontWeight: 800,
                letterSpacing: '-0.03em',
                lineHeight: 1.1,
              }}
            >
              {MARCA}
            </p>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'rgba(103, 232, 249, 0.95)',
              }}
            >
              {DESCRIPTOR}
            </p>
          </div>
        </div>
        <p
          style={{
            margin: '14px 0 0',
            fontSize: '13px',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.92)',
            letterSpacing: '0.02em',
          }}
        >
          Comprobante de liquidación de cheque
        </p>
        <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'rgba(255,255,255,0.7)' }}>
          Emitido el {emitido}
        </p>
      </div>

      <div style={{ padding: '18px 20px 20px' }}>
        <p
          style={{
            margin: '0 0 14px',
            fontSize: '12px',
            lineHeight: 1.5,
            color: '#475569',
            fontStyle: 'italic',
          }}
        >
          Estimado/a <strong style={{ color: '#0c4a6e', fontStyle: 'normal' }}>{cheque.solicitante}</strong>,
          {' '}detallamos la liquidación acordada para su cheque.
        </p>

        {cheque.foto_url && (
          <div
            style={{
              marginBottom: '16px',
              borderRadius: '14px',
              overflow: 'hidden',
              border: '2px solid #e0f2fe',
              background: '#f8fafc',
            }}
          >
            <p
              style={{
                margin: 0,
                padding: '8px 12px',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#0369a1',
                background: '#e0f2fe',
              }}
            >
              Imagen del cheque
            </p>
            <img
              src={cheque.foto_url}
              alt=""
              style={{
                display: 'block',
                width: '100%',
                maxHeight: '200px',
                objectFit: 'contain',
              }}
              crossOrigin="anonymous"
            />
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px',
            marginBottom: '14px',
          }}
        >
          {[
            { label: 'Nº de cheque', value: cheque.numero_cheque },
            { label: 'Titular', value: cheque.solicitante, span: 2 },
            { label: 'Vencimiento', value: fmtFechaLarga(cheque.fecha_vencimiento), span: 2 },
            { label: 'Importe del cheque', value: fmtPesos(liq.importe), accent: true },
          ].map((item, i) => (
            <div
              key={i}
              style={{
                gridColumn: item.span === 2 ? '1 / -1' : undefined,
                background: '#f8fafc',
                borderRadius: '12px',
                padding: '10px 12px',
                border: '1px solid #e2e8f0',
              }}
            >
              <p style={{ margin: 0, fontSize: '9px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {item.label}
              </p>
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: item.span === 2 ? '13px' : '14px',
                  fontWeight: 700,
                  color: item.accent ? '#0c4a6e' : '#1e293b',
                }}
              >
                {item.value}
              </p>
            </div>
          ))}
        </div>

        <div
          style={{
            background: 'linear-gradient(135deg, #ecfeff 0%, #cffafe 100%)',
            borderRadius: '16px',
            padding: '16px 18px',
            border: '2px solid #22d3ee',
            textAlign: 'center',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: '#0e7490',
            }}
          >
            Monto a Cobrar
          </p>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: '28px',
              fontWeight: 800,
              color: '#0c4a6e',
              letterSpacing: '-0.02em',
            }}
          >
            {fmtPesos(liq.montoRecibir)}
          </p>
          <p style={{ margin: '10px 0 0', fontSize: '11px', color: '#475569', lineHeight: 1.45 }}>
            Monto neto acordado para entrega, sobre valor de cheque de {fmtPesos(liq.importe)}.
          </p>
        </div>

        <div
          style={{
            marginTop: '18px',
            paddingTop: '14px',
            borderTop: '1px dashed #cbd5e1',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontSize: '11px', color: '#64748b', lineHeight: 1.5 }}>
            Documento informativo para el cliente. Ante cualquier consulta, comunicarse con su asesor {MARCA}.
          </p>
          <p style={{ margin: '10px 0 0', fontSize: '10px', color: '#94a3b8' }}>
            {MARCA} · {DESCRIPTOR} · Emanuel Moreno · Soluciones Tecnológicas © {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
