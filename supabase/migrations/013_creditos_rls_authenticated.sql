-- Lectura/escritura de créditos para usuarios autenticados (la app aplica filtros por rol en cliente).
-- Si la tabla ya tenía RLS restrictivo, estas políticas sustituyen los nombres usados aquí.

alter table public.creditos enable row level security;

drop policy if exists "creditos_select_authenticated" on public.creditos;
create policy "creditos_select_authenticated"
  on public.creditos
  for select
  to authenticated
  using (true);

drop policy if exists "creditos_insert_authenticated" on public.creditos;
create policy "creditos_insert_authenticated"
  on public.creditos
  for insert
  to authenticated
  with check (true);

drop policy if exists "creditos_update_authenticated" on public.creditos;
create policy "creditos_update_authenticated"
  on public.creditos
  for update
  to authenticated
  using (true)
  with check (true);
