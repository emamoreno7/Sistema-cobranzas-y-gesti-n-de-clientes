-- Gastos: columnas que la app inserta/lee (producción puede tener tabla legacy sin categoria, nota, etc.).
-- Ejecutar si PostgREST devuelve PGRST204 "Could not find the 'categoria' column of 'gastos'".

alter table public.gastos add column if not exists fecha date not null default current_date;
alter table public.gastos add column if not exists categoria text not null default 'Otros';
alter table public.gastos add column if not exists monto numeric not null default 0;
alter table public.gastos add column if not exists nota text;
alter table public.gastos add column if not exists cobrador_id text;
alter table public.gastos add column if not exists created_at timestamptz not null default now();

create index if not exists idx_gastos_fecha on public.gastos (fecha);
create index if not exists idx_gastos_cobrador on public.gastos (cobrador_id);

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

notify pgrst, 'reload schema';
