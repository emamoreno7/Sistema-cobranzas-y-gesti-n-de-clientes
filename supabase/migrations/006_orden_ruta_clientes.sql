-- Prioridad manual en la hoja de ruta del día (menor número = antes). Opcional; el cobrador puede ordenar por cercanía si hay GPS.
alter table public.clientes add column if not exists orden_ruta integer;

comment on column public.clientes.orden_ruta is 'Orden sugerido en ruta diaria (admin). Si es null, se usa cercanía cuando hay ubicación.';
