-- Additive schema only. Conversion happens only after a reviewed PDF confirmation.
alter table public.garden_income add column onda_key text unique,add column onda_reference text,
 add column payment_method text,add column payment_account text check(payment_account in ('cash','bank','booking')),
 add column onda_hidden boolean not null default false,add column onda_split boolean not null default false;
alter table public.garden_income drop constraint garden_income_business_date_category_id_key;
create unique index garden_manual_daily_income on public.garden_income(business_date,category_id) where onda_key is null;
alter table public.garden_onda_imports add column encoding_version integer not null default 1 check(encoding_version in (1,2));
drop index public.garden_onda_confirmed_file;
create unique index garden_onda_confirmed_encoding on public.garden_onda_imports(sha256,encoding_version) where state='confirmed';
create table public.garden_onda_entry_links(
 id uuid not null unique default gen_random_uuid(),key text primary key,income_id uuid not null unique references public.garden_income,
 allocation_id uuid unique references public.garden_cash_allocations on delete set null,
 account text not null check(account in ('cash','bank','booking')),method text not null,last_amount bigint not null,last_notes text not null);
alter table public.garden_onda_entry_links enable row level security;
revoke all on public.garden_onda_entry_links from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant select on public.garden_onda_entry_links to service_role;end if;end;$$;
create trigger onda_entries_audit after insert or update or delete on public.garden_onda_entry_links for each row execute function public.garden_log_change();
alter table public.garden_cash_allocations add column onda_key text references public.garden_onda_entry_links(key);
alter table public.garden_cash_allocations drop constraint garden_cash_allocations_amount_cents_check;
alter table public.garden_cash_allocations add constraint garden_cash_allocation_signed_onda check (
 amount_cents between 1 and 999999999999 or (income_id is not null and onda_key is not null and amount_cents between -999999999999 and -1));

do $m$declare definition text;begin
 definition=replace(pg_get_functiondef('public.garden_onda_context(uuid)'::regprocedure),chr(13),'');
 definition=replace(definition,'''income'',coalesce(','''entries'',coalesce((select jsonb_agg(to_jsonb(t) order by key) from public.garden_onda_entry_links t),''[]''),''settings'',(select to_jsonb(t) from public.garden_cash_settings t),''income'',coalesce(');execute definition;
 definition=replace(pg_get_functiondef('public.garden_onda_prepare(uuid,uuid,text,text,integer,jsonb,jsonb,text)'::regprocedure),chr(13),'');
 definition=replace(definition,'parsed,plan,snapshot_hash) values','parsed,plan,snapshot_hash,encoding_version) values');
 definition=replace(definition,'p_actor,p_parsed,p_plan,p_snapshot) returning','p_actor,p_parsed,p_plan,p_snapshot,coalesce((p_plan->>''encoding_version'')::integer,1)) returning');execute definition;
 definition=replace(pg_get_functiondef('public.garden_onda_refresh(uuid,uuid,jsonb,text)'::regprocedure),chr(13),'');
 definition=replace(definition,'set plan=p_plan,snapshot_hash=', 'set plan=p_plan,encoding_version=coalesce((p_plan->>''encoding_version'')::integer,1),snapshot_hash=');execute definition;
end;$m$;

create function public.garden_onda_entry_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare managed boolean;ok boolean;begin
 ok=current_user=(select pg_get_userbyid(proowner) from pg_proc where oid='public.garden_onda_confirm_transactions(uuid,uuid,jsonb,jsonb,boolean)'::regprocedure) and coalesce(current_setting('gardens.onda_write',true),'')='on';
 if tg_table_name='garden_income' then
  if tg_op='UPDATE' and old.onda_split and old.onda_key is null and not ok then
   if old.business_date<>new.business_date or old.category_id<>new.category_id then raise exception 'Keep the original date/category for this manual reconciliation row.';end if;
   new.onda_hidden=new.amount_cents=0;
  end if;
  managed=case when tg_op='INSERT' then new.onda_key is not null or new.onda_hidden or new.onda_split when tg_op='DELETE' then old.onda_key is not null or old.onda_split else old.onda_key is not null or new.onda_key is not null or old.onda_split<>new.onda_split or (old.onda_hidden<>new.onda_hidden and not old.onda_split) end;
 else managed=case when tg_op='INSERT' then new.onda_key is not null when tg_op='DELETE' then old.onda_key is not null else old.onda_key is not null or new.onda_key is not null end;end if;
 if managed and not ok then raise exception 'This entry is managed by Onda. Upload or refresh its report to update it.' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke all on function public.garden_onda_entry_guard() from public,anon,authenticated;
create trigger a_onda_income_guard before insert or update or delete on public.garden_income for each row execute function public.garden_onda_entry_guard();
create trigger onda_allocation_guard before insert or update or delete on public.garden_cash_allocations for each row execute function public.garden_onda_entry_guard();

create function public.garden_onda_confirm_transactions(p_actor uuid,p_id uuid,p_resolutions jsonb,p_accounts jsonb,p_replace_allocations boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
<<encode>>
declare r public.garden_onda_imports;prior public.garden_onda_imports;p jsonb;v jsonb;entry jsonb;resolution jsonb;key text;
 target bigint;manual bigint;opening date;account text;parent uuid;child uuid;allocation uuid;notes text;link public.garden_onda_entry_links;
 inserted integer=0;updated integer=0;unchanged integer=0;delta bigint=0;answer jsonb;changes jsonb='[]';begin
 perform public.garden_onda_actor(p_actor);
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));perform pg_advisory_xact_lock(hashtext('gardens-onda-imports'));
 perform 1 from public.garden_profiles where id=p_actor for share;
 perform public.garden_onda_actor(p_actor);
 select * into r from public.garden_onda_imports where id=p_id for update;
 if not found or r.actor_id<>p_actor then raise exception 'Preview not found.';end if;
 if r.state='confirmed' then return r.result;end if;
 select * into prior from public.garden_onda_imports where sha256=r.sha256 and encoding_version=2 and state='confirmed';
 if found then return prior.result||jsonb_build_object('already_imported',true,'import_id',prior.id);end if;
 if r.encoding_version<>2 or r.plan->>'encoding_version'<>'2' then raise exception 'Refresh this preview for transaction-level account posting.';end if;
 if r.expires_at<now() then raise exception 'Preview expired. Refresh it.' using errcode='40001';end if;
 lock table public.garden_income in exclusive mode;lock table public.garden_cash_allocations in exclusive mode;
 lock table public.garden_expenses,public.garden_categories,public.garden_cash_settings in share mode;
 if r.snapshot_hash is distinct from (public.garden_onda_context(p_actor)->>'fingerprint') then raise exception 'Records changed after preview. Refresh and review again.' using errcode='40001';end if;
 if jsonb_array_length(r.plan->'blockers')>0 then raise exception 'Resolve the blocking report warnings before confirming.';end if;
 select start_date into opening from public.garden_cash_settings;if opening is null then raise exception 'Configure opening balances first.';end if;
 if p_resolutions is null or p_accounts is null or jsonb_typeof(p_resolutions)<>'object' or jsonb_typeof(p_accounts)<>'object' then raise exception 'Invalid reconciliation choices.';end if;
 for key in select jsonb_object_keys(p_resolutions) loop
  if not exists(select 1 from jsonb_array_elements(r.plan->'proposals') t where t->>'key'=key) then raise exception 'Unknown reconciliation choice.';end if;
 end loop;
 for key in select jsonb_object_keys(p_accounts) loop
  if not exists(select 1 from jsonb_array_elements(r.plan->'entries') t where t->>'key'=key) and not exists(select 1 from jsonb_array_elements(r.plan->'proposals') t where 'manual:'||(t->>'key')=key) then raise exception 'Unknown account choice.';end if;
  if p_accounts->>key not in ('cash','bank','booking') then raise exception 'Choose Cash, Bank or Booking System.';end if;
 end loop;
 if coalesce((r.plan->>'replaced_allocations')::integer,0)>0 and not p_replace_allocations then raise exception 'Review replacement of the existing daily account assignments.';end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);perform set_config('gardens.onda_write','on',true);
 for p in select * from jsonb_array_elements(r.plan->'proposals') loop
  resolution=p_resolutions->(p->>'key');manual=(p->>'manual_amount')::bigint;
  if (p->>'conflict')::boolean and resolution is null then raise exception 'Resolve every manual-income conflict.';end if;
  if resolution is not null then
   if resolution->>'mode'='replace' then manual=0;
   elsif resolution->>'mode'='manual' and jsonb_typeof(resolution->'amount_cents')='number' then manual=(resolution->>'amount_cents')::bigint;
   else raise exception 'Choose Onda only or enter income outside Onda.';end if;
  end if;
  target=(p->>'source_amount')::bigint+manual;if abs(manual)>999999999999 or abs(target)>999999999999 then raise exception 'Income amount is too large.';end if;
  parent=nullif(p->>'income_id','')::uuid;notes=case when coalesce((resolution->>'replace_notes')::boolean,false) then p->>'generated_notes' else p->>'notes' end;
  if parent is not null then delete from public.garden_cash_allocations where income_id=parent;end if;
  if parent is null then
   parent=gen_random_uuid();insert into public.garden_income(id,business_date,category_id,amount_cents,notes,onda_split,onda_hidden) values(parent,(p->>'date')::date,(p->>'category_id')::uuid,manual,notes,true,manual=0);
  else update public.garden_income set amount_cents=manual,notes=encode.notes,onda_split=true,onda_hidden=manual=0 where id=parent;
   if not found then raise exception 'The original income row was removed. Refresh.';end if;
  end if;
  if manual<>0 and (p->>'date')::date>=opening then
   account=p_accounts->>('manual:'||(p->>'key'));
   if account is null or account not in ('cash','bank','booking') then raise exception 'Choose the account for income outside Onda.';end if;
   if manual<0 then raise exception 'Keep negative non-Onda corrections separate and reconcile their account manually.';end if;
   perform public.garden_cash_allocate(gen_random_uuid(),'income',parent,account,manual,(p->>'date')::date);
  end if;
  insert into public.garden_onda_links(business_date,category_id,income_id,source_amount,manual_amount,last_amount,last_notes,generated_notes)
  values((p->>'date')::date,(p->>'category_id')::uuid,parent,(p->>'source_amount')::bigint,manual,target,notes,p->>'generated_notes')
  on conflict(business_date,category_id) do update set income_id=excluded.income_id,source_amount=excluded.source_amount,manual_amount=excluded.manual_amount,last_amount=excluded.last_amount,last_notes=excluded.last_notes,generated_notes=excluded.generated_notes;
  delta=delta+target-coalesce((p->>'old_amount')::bigint,0);
 end loop;
 for entry in select * from jsonb_array_elements(r.plan->'entries') loop
  select * into link from public.garden_onda_entry_links where garden_onda_entry_links.key=entry->>'key';
  child=coalesce(link.income_id,gen_random_uuid());allocation=coalesce(link.allocation_id,gen_random_uuid());account=coalesce(p_accounts->>(entry->>'key'),entry->>'account');
  if account is null or account not in ('cash','bank','booking') then raise exception 'Choose an account for every transaction.';end if;
  if link.income_id is not null then delete from public.garden_cash_allocations where income_id=child;end if;
  insert into public.garden_income(id,business_date,category_id,amount_cents,notes,onda_key,onda_reference,payment_method,payment_account,onda_hidden)
  values(child,(entry->>'date')::date,(entry->>'category_id')::uuid,(entry->>'amount_cents')::bigint,entry->>'notes',entry->>'key',entry->>'reference',entry->>'method',account,(entry->>'amount_cents')::bigint=0)
  on conflict(id) do update set business_date=excluded.business_date,category_id=excluded.category_id,amount_cents=excluded.amount_cents,notes=excluded.notes,payment_method=excluded.payment_method,payment_account=excluded.payment_account,onda_hidden=excluded.onda_hidden;
  if link.income_id is null then inserted=inserted+1;elsif link.last_amount is distinct from (entry->>'amount_cents')::bigint or link.account is distinct from account or link.last_notes is distinct from entry->>'notes' then updated=updated+1;else unchanged=unchanged+1;end if;
  insert into public.garden_onda_entry_links(key,income_id,account,method,last_amount,last_notes)
  values(entry->>'key',child,account,entry->>'method',(entry->>'amount_cents')::bigint,entry->>'notes')
  on conflict on constraint garden_onda_entry_links_pkey do update set account=excluded.account,method=excluded.method,last_amount=excluded.last_amount,last_notes=excluded.last_notes;
  if (entry->>'amount_cents')::bigint<>0 and (entry->>'date')::date>=opening then
   insert into public.garden_cash_allocations(id,account,posted_on,income_id,amount_cents,onda_key,created_by,updated_by) values(allocation,account,(entry->>'date')::date,child,(entry->>'amount_cents')::bigint,entry->>'key',p_actor,p_actor);
   update public.garden_onda_entry_links set allocation_id=allocation where garden_onda_entry_links.key=entry->>'key';
  end if;
  changes=changes||jsonb_build_array(jsonb_build_object('income_id',child,'date',entry->>'date','kind',entry->>'kind','reference',entry->>'reference','after_cents',(entry->>'amount_cents')::bigint,'account',account));
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
 answer=jsonb_build_object('import_id',p_id,'inserted',inserted,'updated',updated,'unchanged',unchanged,'change_cents',delta,'source_net_cents',r.parsed->'net','encoding_version',2,'changes',changes);
 update public.garden_onda_imports set state='confirmed',confirmed_at=now(),result=answer where id=p_id;
 insert into public.garden_audit(record_id,table_name,action,after_record,actor_id) values(p_id,'garden_onda_imports','CONFIRM_TRANSACTIONS',answer,p_actor);
 return answer;
end;$$;
revoke all on function public.garden_onda_confirm_transactions(uuid,uuid,jsonb,jsonb,boolean) from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.garden_onda_confirm_transactions(uuid,uuid,jsonb,jsonb,boolean) to service_role;end if;end;$$;
do $m$declare definition text;begin
 definition=replace(pg_get_functiondef('public.garden_onda_confirm(uuid,uuid,jsonb)'::regprocedure),chr(13),'');
 definition=replace(definition,' perform set_config(''request.jwt.claim.sub'',p_actor::text,true);',$guard$ if exists(select 1 from public.garden_income i join jsonb_array_elements(r.plan->'proposals') je on i.business_date=(je->>'date')::date and i.category_id=(je->>'category_id')::uuid where i.onda_split) then raise exception 'This date uses transaction-level income. Refresh the application and upload again.';end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);$guard$);execute definition;
end;$m$;
notify pgrst,'reload schema';

create policy onda_entry_audit_read on public.garden_audit for select to authenticated using(table_name='garden_onda_entry_links' and public.garden_is_admin());
create policy onda_entry_audit_boundary on public.garden_audit as restrictive for select to authenticated using(table_name<>'garden_onda_entry_links' or public.garden_is_admin());
