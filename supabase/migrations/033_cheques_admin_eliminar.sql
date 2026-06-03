-- Admin (Marcos + cuenta demo Prueba): aprobar, rechazar y eliminar cheques.

create or replace function public.es_usuario_admin_cheques_jwt()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(auth.jwt() ->> 'email', ''))) in (
    'emamoreno7@hotmail.com',
    'prueba@emd.com'
  );
$$;

drop policy if exists cheques_update_marcos on public.cheques;
create policy cheques_update_admin on public.cheques
  for update to authenticated
  using (public.es_usuario_admin_cheques_jwt())
  with check (public.es_usuario_admin_cheques_jwt());

drop policy if exists cheques_delete_marcos on public.cheques;
create policy cheques_delete_admin on public.cheques
  for delete to authenticated
  using (public.es_usuario_admin_cheques_jwt());

-- Storage: admin puede borrar fotos al eliminar un cheque
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'cheques_fotos_delete_admin'
  ) then
    create policy cheques_fotos_delete_admin
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'cheques-fotos'
        and public.es_usuario_admin_cheques_jwt()
      );
  end if;
end $$;
