-- Onda import evidence is private; the finance table remains one total per day/category.
create table public.garden_onda_imports(
 id uuid primary key,sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),filename text not null check(length(filename) between 1 and 200),file_bytes integer not null check(file_bytes between 1 and 4000000),
 actor_id uuid not null references public.garden_profiles,parsed jsonb not null,plan jsonb not null,snapshot_hash text not null,
 state text not null default 'preview' check(state in ('preview','confirmed')),created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '30 minutes',confirmed_at timestamptz,result jsonb
);
create unique index garden_onda_confirmed_file on public.garden_onda_imports(sha256) where state='confirmed';
create index garden_onda_history on public.garden_onda_imports(created_at desc,id);
create table public.garden_onda_transactions(reference text primary key,data jsonb not null,generated_at timestamptz not null,import_id uuid not null references public.garden_onda_imports);
create table public.garden_onda_refunds(identity text primary key,data jsonb not null,generated_at timestamptz not null,import_id uuid not null references public.garden_onda_imports);
create table public.garden_onda_days(day date not null,kind text not null check(kind in ('BK','ER')),generated_at timestamptz not null,import_id uuid not null references public.garden_onda_imports,primary key(day,kind));
create table public.garden_onda_links(
 business_date date not null,category_id uuid not null references public.garden_categories,income_id uuid unique references public.garden_income on delete set null,
 source_amount bigint not null,manual_amount bigint not null,last_amount bigint not null,last_notes text not null,generated_notes text not null,
 primary key(business_date,category_id)
);
do $$declare t text;begin
 foreach t in array array['garden_onda_imports','garden_onda_transactions','garden_onda_refunds','garden_onda_days','garden_onda_links'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant select on public.%I to service_role',t);end if;
 end loop;
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('garden-income-imports','garden-income-imports',false,4000000,array['application/pdf']) on conflict(id) do update set public=false,file_size_limit=4000000,allowed_mime_types=array['application/pdf'];
  execute $policy$create policy gardens_income_imports_server_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'garden-income-imports') with check(bucket_id<>'garden-income-imports')$policy$;
 end if;
end;$$;
create function public.garden_onda_actor(p_actor uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from public.garden_profiles where id=p_actor and active and role='admin' and (is_owner or finance_access)) then raise exception 'Finance management permission required.' using errcode='42501';end if;
end;$$;
create function public.garden_onda_context(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare payload jsonb;begin
 perform public.garden_onda_actor(p_actor);
 select jsonb_build_object(
  'income',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_income t),'[]'),
  'categories',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_categories t),'[]'),
  'expenses',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_expenses t),'[]'),
  'allocations',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_cash_allocations t where income_id is not null),'[]'),
  'transactions',coalesce((select jsonb_agg(to_jsonb(t) order by reference) from public.garden_onda_transactions t),'[]'),
  'refunds',coalesce((select jsonb_agg(to_jsonb(t) order by identity) from public.garden_onda_refunds t),'[]'),
  'days',coalesce((select jsonb_agg(to_jsonb(t) order by day,kind) from public.garden_onda_days t),'[]'),
  'links',coalesce((select jsonb_agg(to_jsonb(t) order by business_date,category_id) from public.garden_onda_links t),'[]')
 ) into payload;
 return payload||jsonb_build_object('fingerprint',md5(payload::text));
end;$$;
create function public.garden_onda_prepare(p_actor uuid,p_id uuid,p_hash text,p_name text,p_bytes integer,p_parsed jsonb,p_plan jsonb,p_snapshot text) returns jsonb
language plpgsql security definer set search_path='' as $$declare r public.garden_onda_imports;begin
 perform public.garden_onda_actor(p_actor);
 select * into r from public.garden_onda_imports where id=p_id;
 if found then
  if r.actor_id<>p_actor or r.sha256<>p_hash then raise exception 'Upload reference already belongs to another file.';end if;
  return to_jsonb(r);
 end if;
 if p_snapshot is distinct from (public.garden_onda_context(p_actor)->>'fingerprint') then raise exception 'Records changed. Refresh the preview.' using errcode='40001';end if;
 if jsonb_typeof(p_parsed)<>'object' or p_parsed->>'version'<>'1' or jsonb_typeof(p_plan)<>'object' then raise exception 'Invalid parsed report.';end if;
 insert into public.garden_onda_imports(id,sha256,filename,file_bytes,actor_id,parsed,plan,snapshot_hash) values(p_id,p_hash,p_name,p_bytes,p_actor,p_parsed,p_plan,p_snapshot) returning * into r;return to_jsonb(r);
end;$$;
create function public.garden_onda_refresh(p_actor uuid,p_id uuid,p_plan jsonb,p_snapshot text) returns jsonb
language plpgsql security definer set search_path='' as $$declare r public.garden_onda_imports;begin
 perform public.garden_onda_actor(p_actor);
 select * into r from public.garden_onda_imports where id=p_id for update;
 if not found or r.actor_id<>p_actor then raise exception 'Preview not found.';end if;
 if r.state='confirmed' then return to_jsonb(r);end if;
 if p_snapshot is distinct from (public.garden_onda_context(p_actor)->>'fingerprint') then raise exception 'Records changed. Refresh the preview.' using errcode='40001';end if;
 update public.garden_onda_imports set plan=p_plan,snapshot_hash=p_snapshot,expires_at=now()+interval '30 minutes' where id=p_id returning * into r;return to_jsonb(r);
end;$$;
create function public.garden_onda_confirm(p_actor uuid,p_id uuid,p_resolutions jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.garden_onda_imports; prior public.garden_onda_imports;p jsonb;v jsonb;resolution jsonb;key text;target bigint;manual bigint;allocated bigint;new_notes text;income uuid;current_row public.garden_income;inserted integer=0;updated integer=0;unchanged integer=0;delta bigint=0;changes jsonb='[]';answer jsonb;
begin
 perform public.garden_onda_actor(p_actor);
 perform pg_advisory_xact_lock(hashtext('gardens-onda-imports'));
 perform 1 from public.garden_profiles where id=p_actor for share;
 select * into r from public.garden_onda_imports where id=p_id for update;
 if not found or r.actor_id<>p_actor then raise exception 'Preview not found.';end if;
 if r.state='confirmed' then return r.result;end if;
 select * into prior from public.garden_onda_imports where sha256=r.sha256 and state='confirmed';
 if found then return prior.result||jsonb_build_object('already_imported',true,'import_id',prior.id);end if;
 if r.expires_at<now() then raise exception 'Preview expired. Refresh it before confirming.' using errcode='40001';end if;
 -- Parent locks precede allocation locks, matching the allocation RPC's order.
 lock table public.garden_income in exclusive mode;
 lock table public.garden_cash_allocations,public.garden_expenses,public.garden_categories in share mode;
 if r.snapshot_hash is distinct from (public.garden_onda_context(p_actor)->>'fingerprint') then raise exception 'Records changed after preview. Refresh and review again.' using errcode='40001';end if;
 if jsonb_array_length(r.plan->'blockers')>0 then raise exception 'Resolve the blocking report warnings before confirming.';end if;
 if p_resolutions is null then p_resolutions='{}';end if;
 if jsonb_typeof(p_resolutions)<>'object' then raise exception 'Invalid reconciliation choices.';end if;
 for key in select jsonb_object_keys(p_resolutions) loop
  if not exists(select 1 from jsonb_array_elements(r.plan->'proposals') t where t->>'key'=key) then raise exception 'A reconciliation choice does not belong to this preview.';end if;
 end loop;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 for p in select * from jsonb_array_elements(r.plan->'proposals') loop
  resolution=p_resolutions->(p->>'key');manual=(p->>'manual_amount')::bigint;
  if (p->>'conflict')::boolean and resolution is null then raise exception 'Resolve every manual-income conflict.';end if;
  if resolution is not null then
   if resolution->>'mode'='replace' then manual=0;
   elsif resolution->>'mode'='manual' and jsonb_typeof(resolution->'amount_cents')='number' then manual=(resolution->>'amount_cents')::bigint;
   else raise exception 'Choose Onda only or enter income outside Onda.';end if;
   if resolution ? 'replace_notes' and jsonb_typeof(resolution->'replace_notes')<>'boolean' then raise exception 'Invalid notes choice.';end if;
  end if;
  target=(p->>'source_amount')::bigint+manual;
  if abs(manual)>999999999999 or abs(target)>999999999999 then raise exception 'Income amount is too large.';end if;
  income=nullif(p->>'income_id','')::uuid;
  select coalesce(sum(amount_cents),0) into allocated from public.garden_cash_allocations where income_id=income;
  if allocated>greatest(0,target) then raise exception 'Reconcile existing account assignments before reducing this income.';end if;
  new_notes=case when coalesce((resolution->>'replace_notes')::boolean,false) then p->>'generated_notes' else p->>'notes' end;
  select * into current_row from public.garden_income where id=income;
  if income is null then
   income=gen_random_uuid();insert into public.garden_income(id,business_date,category_id,amount_cents,notes) values(income,(p->>'date')::date,(p->>'category_id')::uuid,target,new_notes);inserted=inserted+1;
  elsif not found then raise exception 'An income entry was removed. Refresh the preview.' using errcode='40001';
  elsif current_row.amount_cents<>target or current_row.notes<>new_notes then update public.garden_income set amount_cents=target,notes=new_notes where id=income;updated=updated+1;
  else unchanged=unchanged+1;end if;
  delta=delta+target-coalesce((p->>'old_amount')::bigint,0);
  if target is distinct from (p->>'old_amount')::bigint or new_notes is distinct from p->>'old_notes' then changes=changes||jsonb_build_array(jsonb_build_object('income_id',income,'date',p->>'date','kind',p->>'kind','before_cents',p->'old_amount','after_cents',target,'before_notes',p->>'old_notes','after_notes',new_notes));end if;
  insert into public.garden_onda_links(business_date,category_id,income_id,source_amount,manual_amount,last_amount,last_notes,generated_notes)
  values((p->>'date')::date,(p->>'category_id')::uuid,income,(p->>'source_amount')::bigint,manual,target,new_notes,p->>'generated_notes')
  on conflict(business_date,category_id) do update set income_id=excluded.income_id,source_amount=excluded.source_amount,manual_amount=excluded.manual_amount,last_amount=excluded.last_amount,last_notes=excluded.last_notes,generated_notes=excluded.generated_notes;
 end loop;
 for v in select * from jsonb_array_elements(r.plan->'transactions') loop
  insert into public.garden_onda_transactions(reference,data,generated_at,import_id) values(v->'data'->>'reference',v->'data',(v->>'generated_at')::timestamptz,p_id)
  on conflict(reference) do update set data=excluded.data,generated_at=excluded.generated_at,import_id=excluded.import_id where garden_onda_transactions.generated_at<=excluded.generated_at;
 end loop;
 for v in select * from jsonb_array_elements(r.plan->'refunds') loop
  insert into public.garden_onda_refunds(identity,data,generated_at,import_id) values(v->'data'->>'identity',v->'data',(v->>'generated_at')::timestamptz,p_id)
  on conflict(identity) do update set data=excluded.data,generated_at=excluded.generated_at,import_id=excluded.import_id where garden_onda_refunds.generated_at<=excluded.generated_at;
 end loop;
 for v in select * from jsonb_array_elements(r.plan->'days') loop
  insert into public.garden_onda_days(day,kind,generated_at,import_id) values((v->>'day')::date,v->>'kind',(v->>'generated_at')::timestamptz,p_id)
  on conflict(day,kind) do update set generated_at=excluded.generated_at,import_id=excluded.import_id where garden_onda_days.generated_at<=excluded.generated_at;
 end loop;
 answer=jsonb_build_object('import_id',p_id,'inserted',inserted,'updated',updated,'unchanged',unchanged,'change_cents',delta,'source_net_cents',r.parsed->'net','changes',changes);
 update public.garden_onda_imports set state='confirmed',confirmed_at=now(),result=answer where id=p_id;
 insert into public.garden_audit(record_id,table_name,action,after_record,actor_id) values(p_id,'garden_onda_imports','CONFIRM',answer,p_actor);
 return answer;
end;$$;
-- Imported refund-only days can be negative; all expense/payment constraints remain positive.
alter table public.garden_income drop constraint garden_income_amount_cents_check;
alter table public.garden_income add constraint garden_income_amount_cents_check check(amount_cents between -999999999999 and 999999999999);
create or replace function public.garden_cash_guard_parent() returns trigger
language plpgsql security definer set search_path='' as $$declare assigned bigint;opening date;d date;first_posted date;col text;begin
 col=case tg_table_name when 'garden_income' then 'income_id' when 'garden_expenses' then 'expense_id' else 'payout_id' end;
 execute format('select coalesce(sum(amount_cents),0) from public.garden_cash_allocations where %I=$1',col) into assigned using new.id;
 if assigned>greatest(0,new.amount_cents) then raise exception 'Remove or reduce account assignments in Balances before reducing this amount.';end if;
 d=case when tg_table_name='garden_income' then (to_jsonb(new)->>'business_date')::date else (to_jsonb(new)->>'paid_on')::date end;
 execute format('select min(posted_on) from public.garden_cash_allocations where %I=$1',col) into first_posted using new.id;
 select start_date into opening from public.garden_cash_settings;
 if assigned>0 and (d<opening or d>first_posted) then raise exception 'Remove account assignments before changing this entry outside the tracked dates.';end if;return new;
end;$$;
create function public.garden_onda_guard_link() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if (new.business_date<>old.business_date or new.category_id<>old.category_id) and exists(select 1 from public.garden_onda_links where income_id=old.id) then raise exception 'Imported totals keep their original date and category. Correct the Onda report or reconcile the income amount.';end if;return new;
end;$$;
create trigger onda_link_guard before update on public.garden_income for each row execute function public.garden_onda_guard_link();
revoke all on function public.garden_onda_actor(uuid),public.garden_onda_context(uuid),public.garden_onda_prepare(uuid,uuid,text,text,integer,jsonb,jsonb,text),public.garden_onda_refresh(uuid,uuid,jsonb,text),public.garden_onda_confirm(uuid,uuid,jsonb),public.garden_onda_guard_link() from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.garden_onda_context(uuid),public.garden_onda_prepare(uuid,uuid,text,text,integer,jsonb,jsonb,text),public.garden_onda_refresh(uuid,uuid,jsonb,text),public.garden_onda_confirm(uuid,uuid,jsonb) to service_role;end if;end;$$;
alter policy admin_audit on public.garden_audit using(
 (table_name='garden_profiles' and public.garden_can_manage_accounts()) or
 (table_name in ('garden_onda_imports','garden_onda_transactions','garden_onda_refunds','garden_onda_days','garden_onda_links','garden_cash_settings','garden_cash_allocations','garden_cash_movements','garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_admin()) or
 (table_name not in ('garden_profiles','garden_onda_imports','garden_onda_transactions','garden_onda_refunds','garden_onda_days','garden_onda_links','garden_cash_settings','garden_cash_allocations','garden_cash_movements','garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_team_admin())
);
notify pgrst,'reload schema';
