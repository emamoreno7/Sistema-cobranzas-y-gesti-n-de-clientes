-- Columnas que la app usa al crear/actualizar créditos (alta compatible con BD existentes).

alter table public.creditos add column if not exists tipo text;
alter table public.creditos add column if not exists monto_solicitado numeric default 0;
alter table public.creditos add column if not exists monto_total numeric;
alter table public.creditos add column if not exists total_con_interes numeric;
alter table public.creditos add column if not exists cuotas integer;
alter table public.creditos add column if not exists plazo_cantidad integer;
alter table public.creditos add column if not exists plan text;
alter table public.creditos add column if not exists plazo_unidad text;
alter table public.creditos add column if not exists detalle_mercaderia text;
alter table public.creditos add column if not exists fecha_inicio date default current_date;
alter table public.creditos add column if not exists interes_aplicado numeric default 30;
alter table public.creditos add column if not exists cobrador_id text;
alter table public.creditos add column if not exists creado_por text;
alter table public.creditos add column if not exists inicio_cuotas_modo text default 'A_FECHA';
alter table public.creditos add column if not exists fecha_inicio_cuotas_post date;
alter table public.creditos add column if not exists cobrador_notif_email text;
alter table public.creditos add column if not exists es_retroactivo boolean not null default false;
alter table public.creditos add column if not exists ambito text not null default 'principal';
alter table public.creditos add column if not exists nro_carton text;
alter table public.creditos add column if not exists vendedor_id text;
alter table public.creditos add column if not exists comision_vendedor numeric default 0;
alter table public.creditos add column if not exists comision_liquidada boolean not null default false;

-- Valores por defecto y sincronía entre columnas duplicadas
update public.creditos set tipo = coalesce(nullif(trim(tipo), ''), 'P') where tipo is null or trim(tipo) = '';
update public.creditos set monto_total = coalesce(monto_total, total_con_interes, monto_solicitado, 0) where monto_total is null;
update public.creditos set total_con_interes = coalesce(total_con_interes, monto_total, monto_solicitado, 0) where total_con_interes is null;
update public.creditos set cuotas = coalesce(cuotas, plazo_cantidad, 1) where cuotas is null;
update public.creditos set plazo_cantidad = coalesce(plazo_cantidad, cuotas, 1) where plazo_cantidad is null;
update public.creditos set plan = coalesce(nullif(trim(plan), ''), 'Diario') where plan is null or trim(plan) = '';
update public.creditos set plazo_unidad = coalesce(nullif(trim(plazo_unidad), ''), 'Días') where plazo_unidad is null or trim(plazo_unidad) = '';

alter table public.creditos alter column tipo set default 'P';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'creditos_tipo_check'
  ) then
    alter table public.creditos add constraint creditos_tipo_check check (tipo in ('M', 'P'));
  end if;
exception when others then
  null;
end $$;

comment on column public.creditos.tipo is 'M = mercadería, P = préstamo/plan.';
