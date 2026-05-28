-- Ejecutar en Supabase SQL Editor si la BD ya existía con restricciones anteriores.

-- Rol root en usuarios
alter table public.usuarios drop constraint if exists usuarios_rol_check;
alter table public.usuarios add constraint usuarios_rol_check check (rol in ('super', 'admin', 'cobrador', 'root'));

-- Plazo unidad con mayúsculas y tildes (créditos): migrar valores viejos si existían
update public.creditos set plazo_unidad = case lower(trim(plazo_unidad))
  when 'dias' then 'Días'
  when 'semanas' then 'Semanas'
  when 'meses' then 'Meses'
  else trim(plazo_unidad)
end where plazo_unidad is not null;

alter table public.creditos drop constraint if exists creditos_plazo_unidad_check;
alter table public.creditos add constraint creditos_plazo_unidad_check check (plazo_unidad in ('Días', 'Semanas', 'Meses'));
