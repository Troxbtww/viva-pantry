-- Viva Pantry / Supabase. Run once in the Supabase SQL editor as project owner.
-- Browser clients use only the public anon/publishable key and a signed-in JWT.
-- Re-running this file is safe. No service-role key belongs in the website.
begin;

create table if not exists public.pantry_items (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null check (length(btrim(name)) between 1 and 150),
  brand text not null default '' check (length(brand) <= 100),
  category text not null default 'Other' check (length(category) <= 80),
  package_size numeric check (package_size > 0 and package_size <= 100000),
  package_unit text not null default 'each' check (package_unit in ('g','kg','ml','L','each')),
  pack_count integer not null default 1 check (pack_count between 1 and 1000),
  notes text not null default '' check (length(notes) <= 5000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, owner_id)
);
create table if not exists public.pantry_sources (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  filename text not null check (length(filename) between 1 and 180),
  storage_name text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('photo','flyer')),
  page_count integer not null default 1 check (page_count between 1 and 10000),
  byte_size bigint not null check (byte_size between 1 and 41943040),
  created_at timestamptz not null default now(), extraction jsonb,
  unique (owner_id, checksum), unique (id, owner_id),
  check (split_part(storage_name, '/', 1) = owner_id::text)
);
create table if not exists public.pantry_item_sources (
  item_id bigint not null, source_id bigint not null, owner_id uuid not null,
  primary key (item_id, source_id),
  foreign key (item_id,owner_id) references public.pantry_items(id,owner_id) on delete cascade,
  foreign key (source_id,owner_id) references public.pantry_sources(id,owner_id)
);
create table if not exists public.pantry_nutrition_labels (
  id bigint generated always as identity primary key,
  item_id bigint not null, owner_id uuid not null,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  recorded_at timestamptz not null default now(),
  foreign key (item_id,owner_id) references public.pantry_items(id,owner_id) on delete cascade
);
create table if not exists public.pantry_prices (
  id bigint generated always as identity primary key,
  item_id bigint not null, owner_id uuid not null,
  amount_fils integer not null check (amount_fils between 1 and 10000000),
  currency text not null default 'AED' check (currency = 'AED'),
  observed_on date not null, valid_to date,
  kind text not null check (kind in ('regular','offer','paid')),
  source_id bigint, page integer check (page between 1 and 10000),
  notes text not null default '' check (length(notes) <= 2000),
  import_key text, created_at timestamptz not null default now(),
  foreign key (item_id,owner_id) references public.pantry_items(id,owner_id) on delete cascade,
  foreign key (source_id,owner_id) references public.pantry_sources(id,owner_id),
  unique (owner_id,import_key),
  check (valid_to is null or valid_to >= observed_on),
  check (page is null or source_id is not null)
);
create index if not exists pantry_items_owner_idx on public.pantry_items(owner_id);
create index if not exists pantry_sources_owner_idx on public.pantry_sources(owner_id);
create index if not exists pantry_item_sources_owner_idx on public.pantry_item_sources(owner_id);
create index if not exists pantry_labels_item_idx on public.pantry_nutrition_labels(owner_id,item_id,id desc);
create index if not exists pantry_prices_item_idx on public.pantry_prices(owner_id,item_id,observed_on);

alter table public.pantry_items enable row level security;
alter table public.pantry_sources enable row level security;
alter table public.pantry_item_sources enable row level security;
alter table public.pantry_nutrition_labels enable row level security;
alter table public.pantry_prices enable row level security;
drop policy if exists pantry_items_owner on public.pantry_items;
create policy pantry_items_owner on public.pantry_items for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists pantry_sources_owner on public.pantry_sources;
create policy pantry_sources_owner on public.pantry_sources for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists pantry_item_sources_owner on public.pantry_item_sources;
create policy pantry_item_sources_owner on public.pantry_item_sources for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists pantry_labels_owner on public.pantry_nutrition_labels;
create policy pantry_labels_owner on public.pantry_nutrition_labels for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists pantry_prices_owner on public.pantry_prices;
create policy pantry_prices_owner on public.pantry_prices for select to authenticated using (owner_id = (select auth.uid()));
-- Writes are possible only through the checked transactional functions below.
revoke all on public.pantry_items, public.pantry_sources, public.pantry_item_sources,
 public.pantry_nutrition_labels, public.pantry_prices from anon, authenticated;
grant select on public.pantry_items, public.pantry_sources, public.pantry_item_sources,
 public.pantry_nutrition_labels, public.pantry_prices to authenticated;

create or replace function public.pantry_text(v jsonb, maximum integer, required boolean default false)
returns text language plpgsql immutable set search_path = '' as $$
declare result text;
begin
  if v is null or v = 'null'::jsonb then result := '';
  elsif jsonb_typeof(v) <> 'string' then raise exception 'Expected text.';
  else result := btrim(v #>> '{}'); end if;
  if length(result) > maximum or (required and result = '') then
    raise exception 'Enter text between % and % characters.', case when required then 1 else 0 end, maximum;
  end if;
  return result;
end $$;

create or replace function public.pantry_number(v jsonb, field_name text, maximum numeric, whole boolean default false)
returns numeric language plpgsql immutable set search_path = '' as $$
declare result numeric; raw text := v #>> '{}';
begin
  if v is null or jsonb_typeof(v) not in ('number','string') or raw !~ '^[+]?[0-9]+([.][0-9]+)?$' then
    raise exception '% must be a positive number.', field_name;
  end if;
  result := raw::numeric;
  if result <= 0 or result > maximum or (whole and result <> trunc(result)) then
    raise exception '% is outside the allowed range.', field_name;
  end if;
  return result;
end $$;

create or replace function public.pantry_date(v jsonb, field_name text)
returns date language plpgsql immutable set search_path = '' as $$
declare result date; raw text := v #>> '{}';
begin
  if jsonb_typeof(v) is distinct from 'string' or raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception '% must be a date in YYYY-MM-DD format.', field_name;
  end if;
  begin result := raw::date;
  exception when others then raise exception '% must be a real date.', field_name; end;
  if to_char(result, 'YYYY-MM-DD') <> raw or result < date '0001-01-01' then
    raise exception '% must be a real date.', field_name;
  end if;
  return result;
end $$;

create or replace function public.pantry_nutrition(v jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare rows jsonb := '[]'; r jsonb; amount text;
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(coalesce(v->'values','[]')) <> 'array' then
    raise exception 'Nutrition must include a list of values.';
  end if;
  if jsonb_array_length(coalesce(v->'values','[]')) > 50 then raise exception 'A label can have at most 50 nutrient rows.'; end if;
  for r in select value from jsonb_array_elements(coalesce(v->'values','[]')) loop
    if jsonb_typeof(r) <> 'object' then raise exception 'Each nutrient needs a label, value and unit.'; end if;
    amount := null;
    if r->'value' is not null and r->'value' <> 'null'::jsonb and r->>'value' <> '' then
      if jsonb_typeof(r->'value') not in ('number','string') then raise exception 'A nutrient amount must be text or a number.'; end if;
      amount := public.pantry_text(to_jsonb(r->>'value'),60);
    end if;
    rows := rows || jsonb_build_array(jsonb_build_object('label',public.pantry_text(r->'label',80,true),'value',amount,'unit',public.pantry_text(r->'unit',30)));
  end loop;
  return jsonb_build_object('basis',public.pantry_text(v->'basis',100),'serving_size',public.pantry_text(v->'serving_size',100),'values',rows);
end $$;

create or replace function public.pantry_snapshot()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare owner uuid := auth.uid();
begin
  if owner is null then raise exception 'Sign in to continue.'; end if;
  return jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(i) order by lower(i.name),i.id) from public.pantry_items i where owner_id=owner),'[]'),
    'sources',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from public.pantry_sources s where owner_id=owner),'[]'),
    'nutrition_labels',coalesce((select jsonb_agg(to_jsonb(n) order by n.id) from public.pantry_nutrition_labels n where owner_id=owner),'[]'),
    'prices',coalesce((select jsonb_agg(to_jsonb(p) order by p.observed_on,p.id) from public.pantry_prices p where owner_id=owner),'[]'),
    'item_sources',coalesce((select jsonb_agg(to_jsonb(x) order by x.item_id,x.source_id) from public.pantry_item_sources x where owner_id=owner),'[]')
  );
end $$;

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
    insert into public.pantry_items(owner_id,name,brand,category,package_size,package_unit,pack_count,notes)
    values(owner,updated.name,updated.brand,updated.category,updated.package_size,updated.package_unit,updated.pack_count,updated.notes) returning id into p_item_id;
  else
    update public.pantry_items set name=updated.name,brand=updated.brand,category=updated.category,package_size=updated.package_size,
      package_unit=updated.package_unit,pack_count=updated.pack_count,notes=updated.notes,updated_at=now() where id=p_item_id and owner_id=owner;
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

-- Internal helper is not callable by browser roles. Caller owns its transaction.
create or replace function public.pantry_insert_price(p_item_id bigint, p_data jsonb, p_import_key text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); amount numeric; observed date; ending date; source_id bigint; page integer;
  kind text; price_id bigint; source_pages integer;
begin
  if owner is null then raise exception 'Sign in to continue.'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Expected a price record.'; end if;
  -- Serialize against pack edits so prices cannot race a package change.
  perform 1 from public.pantry_items where id=p_item_id and owner_id=owner for update;
  if not found then raise exception 'Food item was not found.'; end if;
  amount := public.pantry_number(p_data->'price','AED price',100000);
  if amount * 100 <> trunc(amount * 100) then raise exception 'Enter an AED price with no more than two decimal places.'; end if;
  observed := public.pantry_date(p_data->'observed_on','Price date');
  if p_data->>'valid_to' is not null and p_data->>'valid_to' <> '' then ending := public.pantry_date(p_data->'valid_to','Offer end'); end if;
  if ending < observed then raise exception 'The offer end cannot be before its start.'; end if;
  kind := coalesce(p_data->>'kind','regular');
  if kind not in ('regular','offer','paid') then raise exception 'Choose a regular, offer, or paid price.'; end if;
  if p_data->>'source_id' is not null and p_data->>'source_id' <> '' then source_id := public.pantry_number(p_data->'source_id','Source',9007199254740991,true)::bigint; end if;
  if p_data->>'page' is not null and p_data->>'page' <> '' then page := public.pantry_number(p_data->'page','Page',10000,true)::integer; end if;
  if source_id is not null then
    select s.page_count into source_pages from public.pantry_sources s where s.id=source_id and s.owner_id=owner;
    if not found then raise exception 'Source file was not found.'; end if;
    if page > source_pages then raise exception 'The page number is outside this file.'; end if;
  elsif page is not null then raise exception 'A page number needs a source file.'; end if;
  insert into public.pantry_prices(item_id,owner_id,amount_fils,observed_on,valid_to,kind,source_id,page,notes,import_key)
    values(p_item_id,owner,(amount*100)::integer,observed,ending,kind,source_id,page,public.pantry_text(p_data->'notes',2000),p_import_key)
    on conflict(owner_id,import_key) do nothing returning id into price_id;
  return price_id;
end $$;

create or replace function public.pantry_add_price(p_item_id bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
begin return public.pantry_insert_price(p_item_id,p_data); end $$;

create or replace function public.pantry_delete_price(p_price_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to continue.'; end if;
  delete from public.pantry_prices where id=p_price_id and owner_id=auth.uid();
  if not found then raise exception 'Price was not found.'; end if;
  return true;
end $$;

create or replace function public.pantry_commit_import(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); source_id bigint; source_pages integer; r jsonb; reviewed jsonb;
  item_id bigint; observed date; page integer; import_key text; saved integer := 0; skipped integer := 0;
begin
  if owner is null then raise exception 'Sign in to continue.'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Expected a JSON object.'; end if;
  source_id := public.pantry_number(p_data->'source_id','Source',9007199254740991,true)::bigint;
  select s.page_count into source_pages from public.pantry_sources s where s.id=source_id and s.owner_id=owner;
  if not found then raise exception 'Source file was not found.'; end if;
  if jsonb_typeof(p_data->'rows') is distinct from 'array' then raise exception 'Select between 1 and 500 reviewed prices.'; end if;
  if jsonb_array_length(p_data->'rows') not between 1 and 500 then raise exception 'Select between 1 and 500 reviewed prices.'; end if;
  observed := public.pantry_date(p_data->'observed_on','Price date');
  -- This RPC is one transaction: any bad row rolls back all previous rows.
  for r in select value from jsonb_array_elements(p_data->'rows') loop
    if jsonb_typeof(r) <> 'object' then raise exception 'Each price must be a record.'; end if;
    item_id := public.pantry_number(r->'item_id','Item',9007199254740991,true)::bigint;
    page := null;
    if r->>'page' is not null and r->>'page' <> '' then page := public.pantry_number(r->'page','Page',10000,true)::integer; end if;
    reviewed := r || jsonb_build_object('source_id',source_id,'kind','offer','observed_on',observed,'valid_to',p_data->'valid_to');
    import_key := source_id::text || ':' || item_id::text || ':' || observed::text || ':' || coalesce(page::text,'');
    if public.pantry_insert_price(item_id,reviewed,import_key) is null then skipped := skipped+1; else saved := saved+1; end if;
  end loop;
  return jsonb_build_object('saved',saved,'skipped',skipped);
end $$;

create or replace function public.pantry_register_source(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); v_checksum text; object_name text; byte_size bigint; result public.pantry_sources;
begin
  if owner is null then raise exception 'Sign in to continue.'; end if;
  v_checksum := public.pantry_text(p_data->'checksum',64,true);
  if v_checksum !~ '^[a-f0-9]{64}$' then raise exception 'Invalid file checksum.'; end if;
  select * into result from public.pantry_sources where owner_id=owner and checksum=v_checksum;
  if found then return to_jsonb(result) || jsonb_build_object('duplicate',true); end if;
  object_name := public.pantry_text(p_data->'storage_name',200,true);
  if split_part(object_name,'/',1) <> owner::text or object_name !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}[.](jpg|png|webp|pdf)$' then raise exception 'Invalid private file path.'; end if;
  byte_size := public.pantry_number(p_data->'byte_size','File size',41943040,true)::bigint;
  if not exists(select 1 from storage.objects where bucket_id='pantry-originals' and name=object_name and (metadata->>'size')::bigint=byte_size) then
    raise exception 'The original file has not finished uploading.';
  end if;
  insert into public.pantry_sources(owner_id,filename,storage_name,mime_type,checksum,purpose,page_count,byte_size)
    values(owner,public.pantry_text(p_data->'filename',180,true),object_name,public.pantry_text(p_data->'mime_type',100,true),v_checksum,
      coalesce(nullif(public.pantry_text(p_data->'purpose',10),''),'photo'),public.pantry_number(coalesce(p_data->'page_count','1'),'Page count',10000,true)::integer,byte_size)
    on conflict(owner_id,checksum) do nothing returning * into result;
  if result.id is null then
    select * into result from public.pantry_sources where owner_id=owner and checksum=v_checksum;
    return to_jsonb(result) || jsonb_build_object('duplicate',true);
  end if;
  return to_jsonb(result);
end $$;

create or replace function public.pantry_save_extraction(p_source_id bigint, p_extraction jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to continue.'; end if;
  if jsonb_typeof(p_extraction) is distinct from 'object' or pg_column_size(p_extraction) > 2097152 then raise exception 'Extraction result is too large.'; end if;
  update public.pantry_sources set extraction=p_extraction where id=p_source_id and owner_id=auth.uid();
  if not found then raise exception 'Source file was not found.'; end if;
  return true;
end $$;

-- Private originals. Names begin with the signed-in user's UUID. Never public.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('pantry-originals','pantry-originals',false,41943040,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists pantry_originals_read on storage.objects;
create policy pantry_originals_read on storage.objects for select to authenticated
using (bucket_id='pantry-originals' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists pantry_originals_upload on storage.objects;
create policy pantry_originals_upload on storage.objects for insert to authenticated
with check (bucket_id='pantry-originals' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists pantry_originals_cleanup on storage.objects;
create policy pantry_originals_cleanup on storage.objects for delete to authenticated
using (bucket_id='pantry-originals' and (storage.foldername(name))[1]=(select auth.uid())::text
  and not exists(select 1 from public.pantry_sources s where s.storage_name=name and s.owner_id=(select auth.uid())));

-- PostgreSQL grants new functions to PUBLIC by default: explicitly close that door.
revoke all on function public.pantry_text(jsonb,integer,boolean), public.pantry_number(jsonb,text,numeric,boolean),
 public.pantry_date(jsonb,text), public.pantry_nutrition(jsonb), public.pantry_snapshot(),
 public.pantry_save_item(jsonb,bigint), public.pantry_insert_price(bigint,jsonb,text),
 public.pantry_add_price(bigint,jsonb), public.pantry_delete_price(bigint), public.pantry_commit_import(jsonb),
 public.pantry_register_source(jsonb), public.pantry_save_extraction(bigint,jsonb) from public, anon, authenticated;
grant execute on function public.pantry_snapshot(), public.pantry_save_item(jsonb,bigint),
 public.pantry_add_price(bigint,jsonb), public.pantry_delete_price(bigint), public.pantry_commit_import(jsonb),
 public.pantry_register_source(jsonb), public.pantry_save_extraction(bigint,jsonb) to authenticated;

commit;
