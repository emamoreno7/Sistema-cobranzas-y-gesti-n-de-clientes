-- Modo de inicio de cuotas (solicitud) y cartón solo al pasar a ACTIVO.

drop function if exists public.creditos_assign_nro_carton_before_insert();

alter table public.creditos add column if not exists inicio_cuotas_modo text default 'A_FECHA';
alter table public.creditos add column if not exists fecha_inicio_cuotas_post date;
alter table public.creditos add column if not exists cobrador_notif_email text;

-- Cartón único al activar (no en solicitudes PENDIENTE).
create or replace function public.creditos_assign_nro_carton_on_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  anio text;
  max_n int;
  next_n int;
  base_fecha date;
  estado_new text;
begin
  if new.nro_carton is not null and btrim(new.nro_carton) <> '' then
    return new;
  end if;

  estado_new := upper(trim(coalesce(new.estado::text, '')));
  if estado_new <> 'ACTIVO' then
    return new;
  end if;

  base_fecha := coalesce(new.fecha_inicio::date, (new.created_at)::date, current_date);
  anio := to_char(base_fecha, 'YYYY');

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
before insert or update on public.creditos
for each row
execute function public.creditos_assign_nro_carton_on_active();
