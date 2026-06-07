-- Fix: id uuid en gastos (error 42804 si se usó ::text en el default).
-- Ejecutar si 047 falló con "column id is of type uuid but default expression is of type text".

alter table public.gastos
  alter column id set default gen_random_uuid();

alter table public.gastos enable row level security;

drop policy if exists gastos_select_auth on public.gastos;
create policy gastos_select_auth
  on public.gastos for select to authenticated using (true);

drop policy if exists gastos_insert_auth on public.gastos;
create policy gastos_insert_auth
  on public.gastos for insert to authenticated with check (true);
