-- Corte de contadores del día (Marcos) y vínculo rendición → caja propia.

alter table public.configuracion
  add column if not exists cierre_caja_marcos_at timestamptz;

alter table public.caja_propia_movimientos
  add column if not exists rendicion_id uuid references public.rendiciones(id) on delete set null;

create unique index if not exists idx_caja_propia_rendicion_unica
  on public.caja_propia_movimientos (rendicion_id)
  where rendicion_id is not null;
