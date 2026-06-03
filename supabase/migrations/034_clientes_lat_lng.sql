-- Coordenadas GPS en clientes (alta/edición y navegación en ruta).

alter table public.clientes add column if not exists lat double precision;
alter table public.clientes add column if not exists lng double precision;
alter table public.clientes add column if not exists coordenada_err text;

comment on column public.clientes.lat is 'Latitud GPS al guardar cliente (grados decimales).';
comment on column public.clientes.lng is 'Longitud GPS al guardar cliente (grados decimales).';
comment on column public.clientes.coordenada_err is 'Mensaje si falló la captura de GPS.';
