-- Varias jornadas por día calendario: la siguiente inicia cuando Marcos recepciona la rendición (no a las 00:00).

alter table public.rendiciones drop constraint if exists rendiciones_cobrador_fecha_unique;

create index if not exists idx_rendiciones_cobrador_created
  on public.rendiciones (cobrador_id, created_at desc);

notify pgrst, 'reload schema';
