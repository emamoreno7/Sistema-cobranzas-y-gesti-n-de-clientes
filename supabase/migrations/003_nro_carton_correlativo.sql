-- Número de cartón único por año (ej. 045-2026). Asignación atómica en servidor (sin carrera entre clientes).
-- Ejecutar en Supabase SQL Editor si la migración no corre sola.

alter table public.creditos add column if not exists nro_carton text;

create or replace function public.creditos_assign_nro_carton_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  anio text;
  max_n int;
  next_n int;
begin
  if new.nro_carton is not null and btrim(new.nro_carton) <> '' then
    return new;
  end if;

  anio := to_char(coalesce(new.fecha_inicio::date, (new.created_at)::date, current_date), 'YYYY');

  perform pg_advisory_xact_lock(hashtext('creditos_carton_' || anio));

  select coalesce(max(substring(c.nro_carton from 1 for 3)::int), 0)
  into max_n
  from public.creditos c
  where c.nro_carton ~ '^[0-9]{3}-[0-9]{4}$'
    and substring(c.nro_carton from 5 for 4) = anio;

  next_n := max_n + 1;
  new.nro_carton := lpad(next_n::text, 3, '0') || '-' || anio;
  return new;
end;
$$;

drop trigger if exists trg_creditos_assign_nro_carton on public.creditos;

create trigger trg_creditos_assign_nro_carton
before insert on public.creditos
for each row
execute function public.creditos_assign_nro_carton_before_insert();
