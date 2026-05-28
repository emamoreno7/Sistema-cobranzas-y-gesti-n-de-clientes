-- Registros de cierre: cuota vencida sin cobro ($0), no reducen saldo ni sustituyen un pago real.
alter table public.pagos add column if not exists es_registro_no_pago boolean not null default false;
alter table public.pagos add column if not exists cuota_numero integer;

comment on column public.pagos.es_registro_no_pago is 'true = registro automático de NO PAGO en cierre de día (monto 0).';
comment on column public.pagos.cuota_numero is 'N° de cuota del plan (1..n) asociado al registro; obligatorio para no_pago automático.';

create unique index if not exists idx_pagos_ficha_cuota_no_pago
  on public.pagos (ficha_id, cuota_numero)
  where es_registro_no_pago = true and cuota_numero is not null;
