-- Gastos: inserts desde la app (sin enviar id manual o con uuid).

create table if not exists public.gastos (
  id text primary key default (gen_random_uuid()::text),
  fecha date not null default current_date,
  categoria text not null default 'Otros',
  monto numeric not null default 0,
  nota text,
  cobrador_id text,
  created_at timestamptz not null default now()
);

alter table public.gastos
  alter column id set default (gen_random_uuid()::text);

alter table public.gastos enable row level security;

drop policy if exists gastos_select_auth on public.gastos;
create policy gastos_select_auth
  on public.gastos for select to authenticated using (true);

drop policy if exists gastos_insert_auth on public.gastos;
create policy gastos_insert_auth
  on public.gastos for insert to authenticated with check (true);

drop policy if exists gastos_update_auth on public.gastos;
create policy gastos_update_auth
  on public.gastos for update to authenticated using (true) with check (true);

drop policy if exists gastos_delete_auth on public.gastos;
create policy gastos_delete_auth
  on public.gastos for delete to authenticated using (true);
