export type BrandingFooterProps = {
  /** Alineación del bloque inferior (impresión / PDF captura). */
  align?: 'center' | 'end';
  /** Superficie clara (tarjetas blancas) u oscura. */
  variant?: 'light' | 'dark';
  className?: string;
  marcaPrimaria?: string;
  descriptor?: string;
};

/**
 * Pie reutilizable para tarjetas, cartones y vistas imprimibles.
 * Estilos de impresión en `src/index.css` (`.branding-footer`).
 */
export function BrandingFooter({
  align = 'end',
  variant = 'light',
  className = '',
  marcaPrimaria = 'DotCom',
  descriptor = 'Sistema de Gestión',
}: BrandingFooterProps) {
  const alignClass = align === 'center' ? 'branding-footer--align-center' : 'branding-footer--align-end';
  const variantClass = variant === 'dark' ? 'branding-footer--dark' : 'branding-footer--light';
  return (
    <footer
      role="contentinfo"
      aria-label="Marca"
      className={`branding-footer ${variantClass} ${alignClass} ${className}`.trim()}
    >
      <div className="branding-footer__inner">
        <img
          src="/apple-touch-icon.png?v=2"
          alt=""
          width={28}
          height={28}
          className="branding-footer__logo"
          decoding="async"
        />
        <span className="branding-footer__text">
          <span className="branding-footer__marca">{marcaPrimaria}</span>
          <span className="branding-footer__sep" aria-hidden>
            {' '}
          </span>
          <span className="branding-footer__descriptor">{descriptor}</span>
        </span>
      </div>
    </footer>
  );
}
