-- Todos los usuarios autenticados ven la misma cartera de clientes (sin filtrar por cobrador).

alter table public.clientes enable row level security;

drop policy if exists "clientes_select_authenticated" on public.clientes;
create policy "clientes_select_authenticated"
  on public.clientes for select
  to authenticated
  using (true);

drop policy if exists "clientes_insert_authenticated" on public.clientes;
create policy "clientes_insert_authenticated"
  on public.clientes for insert
  to authenticated
  with check (true);

drop policy if exists "clientes_update_authenticated" on public.clientes;
create policy "clientes_update_authenticated"
  on public.clientes for update
  to authenticated
  using (true)
  with check (true);
