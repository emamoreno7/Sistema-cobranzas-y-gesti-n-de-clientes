-- Marca auditoría: solicitud creada con fecha pasada (solo admin/root en UI).
alter table public.creditos add column if not exists es_retroactivo boolean not null default false;

comment on column public.creditos.es_retroactivo is 'True si la solicitud usó carga retroactiva (fechas pasadas habilitadas para admin/root).';
