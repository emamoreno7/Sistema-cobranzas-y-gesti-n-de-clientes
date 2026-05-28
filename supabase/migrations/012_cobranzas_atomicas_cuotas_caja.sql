-- Cobranzas atómicas: cuotas + saldo cliente + movimiento de caja.
create table if not exists public.cuotas (
  id uuid primary key default gen_random_uuid(),
  credito_id uuid not null references public.creditos(id) on delete cascade,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  nro_cuota integer not null check (nro_cuota > 0),
  fecha_vencimiento date not null,
  monto integer not null check (monto >= 0),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado')),
  pago_id uuid references public.pagos(id) on delete set null,
  pagado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cuotas_credito_nro_unique unique (credito_id, nro_cuota)
);

create index if not exists idx_cuotas_credito_estado_vto on public.cuotas (credito_id, estado, fecha_vencimiento);
create index if not exists idx_cuotas_cliente_estado_vto on public.cuotas (cliente_id, estado, fecha_vencimiento);

create table if not exists public.caja (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo text not null check (tipo in ('entrada', 'salida')),
  monto integer not null check (monto >= 0),
  descripcion text,
  cobrador_id text not null,
  cliente_id uuid references public.clientes(id) on delete set null,
  ficha_id uuid references public.creditos(id) on delete set null,
  pago_id uuid references public.pagos(id) on delete set null
);

create index if not exists idx_caja_created_at on public.caja (created_at desc);
create index if not exists idx_caja_cobrador_created_at on public.caja (cobrador_id, created_at desc);

alter table public.clientes add column if not exists saldo_pendiente integer;
alter table public.clientes add column if not exists saldo_debitado integer not null default 0;

update public.clientes
set saldo_pendiente = coalesce(saldo_pendiente, greatest(0, coalesce(saldo, 0)))
where saldo_pendiente is null;

alter table public.clientes alter column saldo_pendiente set default 0;
alter table public.clientes alter column saldo_pendiente set not null;

create or replace function public.set_updated_at_cuotas()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_cuotas_updated_at on public.cuotas;
create trigger trg_cuotas_updated_at
before update on public.cuotas
for each row
execute function public.set_updated_at_cuotas();

create or replace function public.registrar_cobranza_atomica(
  p_ficha_id uuid,
  p_cliente_id uuid,
  p_cobrador_id text,
  p_monto integer,
  p_fecha_pago timestamptz,
  p_cuota_numero integer,
  p_es_registro_no_pago boolean default false
)
returns table (
  pago_id uuid,
  cuota_actualizada boolean,
  saldo_pendiente integer,
  saldo_debitado integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pago_id uuid;
  v_cuota_actualizada boolean := false;
  v_saldo_pendiente integer;
  v_saldo_debitado integer;
begin
  insert into public.pagos (
    ficha_id,
    cliente_id,
    cobrador_id,
    monto,
    fecha_pago,
    es_registro_no_pago,
    cuota_numero
  )
  values (
    p_ficha_id,
    p_cliente_id,
    p_cobrador_id,
    p_monto,
    p_fecha_pago,
    coalesce(p_es_registro_no_pago, false),
    p_cuota_numero
  )
  returning id into v_pago_id;

  if coalesce(p_es_registro_no_pago, false) = false and p_monto > 0 then
    update public.cuotas
    set
      estado = 'pagado',
      pago_id = v_pago_id,
      pagado_at = coalesce(p_fecha_pago, now()),
      updated_at = now()
    where credito_id = p_ficha_id
      and nro_cuota = p_cuota_numero
      and estado <> 'pagado';
    v_cuota_actualizada := found;

    update public.clientes
    set
      saldo_pendiente = greatest(0, coalesce(saldo_pendiente, 0) - p_monto),
      saldo_debitado = coalesce(saldo_debitado, 0) + p_monto,
      saldo = greatest(0, coalesce(saldo, 0) - p_monto),
      ultimo_monto_recibido = p_monto,
      ultima_visita = current_date::text
    where id = p_cliente_id
    returning clientes.saldo_pendiente, clientes.saldo_debitado into v_saldo_pendiente, v_saldo_debitado;

    insert into public.caja (tipo, monto, descripcion, cobrador_id, cliente_id, ficha_id, pago_id)
    values ('entrada', p_monto, 'Cobranza de cuota', p_cobrador_id, p_cliente_id, p_ficha_id, v_pago_id);
  else
    select coalesce(c.saldo_pendiente, 0), coalesce(c.saldo_debitado, 0)
    into v_saldo_pendiente, v_saldo_debitado
    from public.clientes c
    where c.id = p_cliente_id;
  end if;

  return query
  select v_pago_id, v_cuota_actualizada, coalesce(v_saldo_pendiente, 0), coalesce(v_saldo_debitado, 0);
end;
$$;

alter table public.cuotas enable row level security;
alter table public.caja enable row level security;

drop policy if exists "cuotas_select_authenticated" on public.cuotas;
create policy "cuotas_select_authenticated"
  on public.cuotas
  for select
  to authenticated
  using (true);

drop policy if exists "cuotas_insert_authenticated" on public.cuotas;
create policy "cuotas_insert_authenticated"
  on public.cuotas
  for insert
  to authenticated
  with check (true);

drop policy if exists "cuotas_update_authenticated" on public.cuotas;
create policy "cuotas_update_authenticated"
  on public.cuotas
  for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "caja_select_authenticated" on public.caja;
create policy "caja_select_authenticated"
  on public.caja
  for select
  to authenticated
  using (true);

drop policy if exists "caja_insert_authenticated" on public.caja;
create policy "caja_insert_authenticated"
  on public.caja
  for insert
  to authenticated
  with check (true);
