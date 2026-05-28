/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Teléfono del administrador (549…); enlace wa.me al notificar nuevo crédito (MatiasM / Vendedor). */
  readonly VITE_ADMIN_PHONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
