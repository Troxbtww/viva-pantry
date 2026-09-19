-- Add private favorites to an existing Viva Pantry project. Safe to run again.
-- Existing records, function permissions, and account access rules are preserved.
begin;

alter table public.pantry_items add column if not exists is_favorite boolean not null default false;

create or replace function public.pantry_save_item(p_data jsonb, p_item_id bigint default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); old public.pantry_items; data jsonb; updated public.pantry_items;
  source_id bigint; v jsonb; nutrition jsonb; latest jsonb; ids jsonb;
begin
  if owner is null then raise exception 'Sign in to continue.'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Expected a JSON object.'; end if;
  if p_item_id is not null then
    select * into old from public.pantry_items where id=p_item_id and owner_id=owner for update;
    if not found then raise exception 'Food item was not found.'; end if;
  end if;
  data := case when p_item_id is null then p_data else to_jsonb(old) || p_data end;
  updated.name := public.pantry_text(data->'name',150,true);
  updated.brand := public.pantry_text(data->'brand',100);
  updated.category := coalesce(nullif(public.pantry_text(data->'category',80),''),'Other');
  updated.package_unit := coalesce(nullif(public.pantry_text(data->'package_unit',10),''),'each');
  if updated.package_unit not in ('g','kg','ml','L','each') then raise exception 'Choose g, kg, ml, L or each for the pack unit.'; end if;
  if data->>'package_size' is not null and data->>'package_size' <> '' then updated.package_size := public.pantry_number(data->'package_size','Pack size',100000); end if;
  updated.pack_count := public.pantry_number(coalesce(data->'pack_count','1'),'Pack count',1000,true)::integer;
  updated.notes := public.pantry_text(data->'notes',5000);
  if data ? 'is_favorite' and jsonb_typeof(data->'is_favorite') is distinct from 'boolean' then
    raise exception 'Favorite must be true or false.';
  end if;
  updated.is_favorite := coalesce((data->>'is_favorite')::boolean,false);
  if p_item_id is not null and (updated.package_size is distinct from old.package_size or updated.package_unit <> old.package_unit or updated.pack_count <> old.pack_count)
    and exists(select 1 from public.pantry_prices where item_id=p_item_id and owner_id=owner) then
    raise exception 'This pack already has price history. Add a separate item for a different pack size so prices stay comparable.';
  end if;
  if p_data->'nutrition' is not null and p_data->'nutrition' <> 'null'::jsonb then nutrition := public.pantry_nutrition(p_data->'nutrition'); end if;
  ids := coalesce(p_data->'source_ids','[]');
  if jsonb_typeof(ids) <> 'array' or jsonb_array_length(ids) > 50 then raise exception 'Choose up to 50 source files.'; end if;
  for v in select value from jsonb_array_elements(ids) loop
    source_id := public.pantry_number(v,'Source',9007199254740991,true)::bigint;
    if not exists(select 1 from public.pantry_sources where id=source_id and owner_id=owner) then raise exception 'Source file was not found.'; end if;
  end loop;
  if p_item_id is null then
    insert into public.pantry_items(owner_id,name,brand,category,package_size,package_unit,pack_count,notes,is_favorite)
    values(owner,updated.name,updated.brand,updated.category,updated.package_size,updated.package_unit,updated.pack_count,updated.notes,updated.is_favorite) returning id into p_item_id;
  else
    update public.pantry_items set name=updated.name,brand=updated.brand,category=updated.category,package_size=updated.package_size,
      package_unit=updated.package_unit,pack_count=updated.pack_count,notes=updated.notes,is_favorite=updated.is_favorite,updated_at=now() where id=p_item_id and owner_id=owner;
  end if;
  if nutrition is not null then
    select content into latest from public.pantry_nutrition_labels where item_id=p_item_id and owner_id=owner order by id desc limit 1;
    if latest is distinct from nutrition then
      insert into public.pantry_nutrition_labels(item_id,owner_id,content) values(p_item_id,owner,nutrition);
    end if;
  end if;
  if p_data ? 'source_ids' then
    delete from public.pantry_item_sources where item_id=p_item_id and owner_id=owner;
    for v in select value from jsonb_array_elements(ids) loop
      insert into public.pantry_item_sources(item_id,source_id,owner_id) values(p_item_id,(v #>> '{}')::bigint,owner) on conflict do nothing;
    end loop;
  end if;
  return p_item_id;
end $$;

commit;
