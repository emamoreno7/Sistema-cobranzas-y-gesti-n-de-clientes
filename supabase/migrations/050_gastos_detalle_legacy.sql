-- Gastos legacy en producción: columna detalle NOT NULL (esquema anterior a categoria/nota).
-- La app ahora envía detalle; este script asegura default y backfill desde categoria si existe.

alter table public.gastos add column if not exists detalle text;

update public.gastos
set detalle = coalesce(nullif(trim(detalle), ''), nullif(trim(categoria), ''), 'Otros')
where detalle is null or trim(detalle) = '';

alter table public.gastos alter column detalle set default 'Otros';

notify pgrst, 'reload schema';
