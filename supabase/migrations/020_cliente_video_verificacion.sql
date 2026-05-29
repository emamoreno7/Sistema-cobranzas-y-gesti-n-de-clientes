-- Video corto del negocio al alta de cliente (verificación admin). Retención 30 días en storage.

alter table public.clientes add column if not exists video_verificacion_url text;
alter table public.clientes add column if not exists video_verificacion_path text;
alter table public.clientes add column if not exists video_verificacion_subido_at timestamptz;
alter table public.clientes add column if not exists video_verificacion_expira_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'clientes-videos-verificacion',
  'clientes-videos-verificacion',
  true,
  52428800,
  array['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp', 'video/3gp', 'video/x-msvideo']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_videos_select_public'
  ) then
    create policy clientes_videos_select_public
    on storage.objects for select
    using (bucket_id = 'clientes-videos-verificacion');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_videos_insert_authenticated'
  ) then
    create policy clientes_videos_insert_authenticated
    on storage.objects for insert
    with check (bucket_id = 'clientes-videos-verificacion' and auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_videos_update_authenticated'
  ) then
    create policy clientes_videos_update_authenticated
    on storage.objects for update
    using (bucket_id = 'clientes-videos-verificacion' and auth.role() = 'authenticated')
    with check (bucket_id = 'clientes-videos-verificacion' and auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'clientes_videos_delete_authenticated'
  ) then
    create policy clientes_videos_delete_authenticated
    on storage.objects for delete
    using (bucket_id = 'clientes-videos-verificacion' and auth.role() = 'authenticated');
  end if;
end $$;

-- Elimina archivos vencidos del bucket y limpia columnas en clientes.
create or replace function public.purge_videos_verificacion_clientes_expirados()
returns integer
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, video_verificacion_path
    from public.clientes
    where video_verificacion_expira_at is not null
      and video_verificacion_expira_at < now()
      and coalesce(btrim(video_verificacion_path), '') <> ''
  loop
    delete from storage.objects
    where bucket_id = 'clientes-videos-verificacion'
      and name = r.video_verificacion_path;

    update public.clientes
    set video_verificacion_url = null,
        video_verificacion_path = null,
        video_verificacion_subido_at = null,
        video_verificacion_expira_at = null
    where id = r.id;

    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.purge_videos_verificacion_clientes_expirados() from public;
grant execute on function public.purge_videos_verificacion_clientes_expirados() to authenticated;

comment on function public.purge_videos_verificacion_clientes_expirados() is
  'Borra videos de verificación de clientes con más de 30 días. Ejecutar periódicamente (p. ej. al abrir panel admin).';
