-- Estado para solicitudes creadas por MatiasM / Vendedor (notificación WhatsApp + aprobación admin).

alter table public.creditos drop constraint if exists creditos_estado_check;

alter table public.creditos
  add constraint creditos_estado_check check (
    btrim(estado) in (
      'PENDIENTE',
      'APROBADO',
      'RECHAZADO',
      'ACTIVO',
      'VIGENTE',
      'FINALIZADO',
      'pendiente_aprobacion'
    )
  );
