-- Un solo egreso en caja propia por solicitud de fondo (evita duplicados por doble clic).
-- Si ya hubo doble clic, conserva el movimiento más antiguo por solicitud.

delete from public.caja_propia_movimientos
where id in (
  select id from (
    select id,
      row_number() over (
        partition by solicitud_fondo_id
        order by created_at asc, id asc
      ) as rn
    from public.caja_propia_movimientos
    where solicitud_fondo_id is not null
  ) duplicados
  where rn > 1
);

create unique index if not exists idx_caja_propia_solicitud_fondo_unica
  on public.caja_propia_movimientos (solicitud_fondo_id)
  where solicitud_fondo_id is not null;
