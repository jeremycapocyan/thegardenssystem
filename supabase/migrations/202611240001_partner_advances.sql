-- Partner reimbursements and owner capital recovery are separate directions of debt.
create table public.garden_partner_purchases(
 id uuid primary key references public.garden_installments on delete restrict,
 owner text not null check(owner in ('Genesis','Ken','Jeremy')),purchased_on date not null check(purchased_on between date '2000-01-01' and date '2100-12-31'),
 created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_partner_payments(
 id uuid primary key,installment_id uuid not null references public.garden_partner_purchases,
 expense_id uuid unique references public.garden_expenses on delete set null,allocation_id uuid unique references public.garden_cash_allocations on delete set null,
 detail jsonb not null,voided_at timestamptz,void_reason text,created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_partner_fundings(
 id uuid primary key,supplier text not null check(length(btrim(supplier)) between 1 and 200),purpose text not null check(length(btrim(purpose)) between 1 and 1000),
 total_cents bigint not null check(total_cents between 1 and 999999999999),start_month date not null check(start_month=date_trunc('month',start_month)::date and start_month between date '2000-01-01' and date '2100-12-01'),
 state text not null default 'draft' check(state in ('draft','funded','void')),funded_on date,movement_id uuid unique references public.garden_cash_movements on delete set null,
 funding_detail jsonb,void_reason text,created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_partner_debts(
 id uuid primary key default gen_random_uuid(),funding_id uuid not null references public.garden_partner_fundings,
 owner text not null check(owner in ('Genesis','Ken','Jeremy')),amount_cents bigint not null check(amount_cents between 1 and 999999999999),unique(funding_id,owner)
);
create table public.garden_partner_rules(
 id uuid primary key default gen_random_uuid(),owner text not null check(owner in ('Genesis','Ken','Jeremy')),
 effective_month date not null check(effective_month=date_trunc('month',effective_month)::date and effective_month between date '2000-01-01' and date '2100-12-01'),
 rate_bps integer not null check(rate_bps between 0 and 10000),reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null default now(),created_by uuid references auth.users,unique(owner,effective_month)
);
create table public.garden_owner_settlements(
 id uuid primary key,month date not null check(month=date_trunc('month',month)::date),net_cents bigint not null,
 profit_hash text not null,snapshot jsonb not null,confirmed_at timestamptz not null default now(),confirmed_by uuid references auth.users,
 reversed_at timestamptz,reversed_by uuid references auth.users,reversal_reason text
);
create unique index garden_owner_active_month on public.garden_owner_settlements(month) where reversed_at is null;
create table public.garden_owner_recoveries(
 id uuid primary key default gen_random_uuid(),settlement_id uuid not null references public.garden_owner_settlements,
 debt_id uuid not null references public.garden_partner_debts,owner text not null check(owner in ('Genesis','Ken','Jeremy')),
 amount_cents bigint not null check(amount_cents>0),effective_on date not null,unique(settlement_id,debt_id)
);
create index garden_owner_recovery_debt on public.garden_owner_recoveries(debt_id);
create table public.garden_partner_actions(id uuid primary key,action text not null,actor_id uuid not null references auth.users,payload_hash text not null,result jsonb not null,created_at timestamptz not null default now());

do $$declare t text;begin
 foreach t in array array['garden_partner_purchases','garden_partner_payments','garden_partner_fundings','garden_partner_debts','garden_partner_rules','garden_owner_settlements','garden_owner_recoveries','garden_partner_actions'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'garden_partner_actions' then
   execute format('grant select on public.%I to authenticated',t);execute format('create policy finance_read on public.%I for select to authenticated using(public.garden_is_member())',t);
  end if;
  execute format('create trigger log_change after insert or update or delete on public.%I for each row execute function public.garden_log_change()',t);
 end loop;
end;$$;
create policy partner_audit_boundary on public.garden_audit as restrictive for select to authenticated using(
 table_name not in ('garden_partner_purchases','garden_partner_payments','garden_partner_fundings','garden_partner_debts','garden_partner_rules','garden_owner_settlements','garden_owner_recoveries','garden_partner_actions') or public.garden_is_admin()
);

-- All share-input writers serialize with settlement commands before touching rows.
create function public.garden_partner_serialize() returns trigger language plpgsql security definer set search_path='' as $$begin
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));return null;
end;$$;
do $$declare t text;begin foreach t in array array['garden_income','garden_expenses','garden_payouts','garden_installments','garden_categories','garden_cash_allocations','garden_cash_movements','garden_cash_settings'] loop
 execute format('create trigger partner_serialize before insert or update or delete on public.%I for each statement execute function public.garden_partner_serialize()',t);
end loop;end;$$;

create function public.garden_partner_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if not public.garden_is_member() then raise exception 'Finance viewing permission required.' using errcode='42501';end if;
 return jsonb_build_object(
 'purchases',coalesce((select jsonb_agg(to_jsonb(t) order by purchased_on,id) from public.garden_partner_purchases t),'[]'),
 'payments',coalesce((select jsonb_agg(to_jsonb(t) order by created_at,id) from public.garden_partner_payments t),'[]'),
 'fundings',coalesce((select jsonb_agg(to_jsonb(t) order by created_at,id) from public.garden_partner_fundings t),'[]'),
 'debts',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_partner_debts t),'[]'),
 'rules',coalesce((select jsonb_agg(to_jsonb(t) order by effective_month,id) from public.garden_partner_rules t),'[]'),
 'settlements',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('needs_review',t.reversed_at is null and t.profit_hash<>md5(public.garden_partner_profit(t.month)::text)) order by month,id) from public.garden_owner_settlements t),'[]'),
 'recoveries',coalesce((select jsonb_agg(to_jsonb(t) order by effective_on,id) from public.garden_owner_recoveries t),'[]'));
end;$$;
create function public.garden_partner_profit(p_month date) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('income',coalesce((select jsonb_agg(jsonb_build_array(id,business_date,amount_cents) order by id) from public.garden_income where business_date>=p_month and business_date<(p_month+interval '1 month')::date),'[]'),
 'expenses',coalesce((select jsonb_agg(jsonb_build_array(id,paid_on,amount_cents) order by id) from public.garden_expenses where paid_on>=p_month and paid_on<(p_month+interval '1 month')::date),'[]'));
$$;
create function public.garden_partner_preview(p_month date) returns jsonb language plpgsql security definer set search_path='' as $$
declare net bigint;gross bigint;forty bigint;paid bigint;rate integer;budget bigint;available bigint;remaining bigint;take bigint;person text;debt record;allocations jsonb;owners jsonb='[]';blockers jsonb='[]';profit jsonb;inputs jsonb;stamp text;active public.garden_owner_settlements;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 if p_month is null or p_month<>date_trunc('month',p_month)::date or p_month<date '2000-01-01' or p_month>date_trunc('month',now() at time zone 'Asia/Manila')::date then raise exception 'Choose a current or past calendar month.';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 perform 1 from public.garden_profiles where id=auth.uid() for share;
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 profit=public.garden_partner_profit(p_month);
 select coalesce((select sum(amount_cents) from public.garden_income where business_date>=p_month and business_date<(p_month+interval '1 month')::date),0)-coalesce((select sum(amount_cents) from public.garden_expenses where paid_on>=p_month and paid_on<(p_month+interval '1 month')::date),0) into net;
 forty=floor((greatest(0,net)::numeric*40+50)/100);
 foreach person in array array['Genesis','Ken','Jeremy'] loop
  gross=case when person='Jeremy' then greatest(0,net)-forty*2 else forty end;
  select coalesce(sum(amount_cents),0) into paid from public.garden_payouts where owner=person and settlement_month=p_month;
  select rate_bps into rate from public.garden_partner_rules where owner=person and effective_month<=p_month order by effective_month desc limit 1;
  available=greatest(0,gross-paid);budget=least(available,floor((gross::numeric*coalesce(rate,0)+5000)/10000));allocations='[]';remaining=0;
  for debt in select d.id,d.amount_cents-coalesce((select sum(r.amount_cents) from public.garden_owner_recoveries r join public.garden_owner_settlements s on s.id=r.settlement_id where r.debt_id=d.id and s.reversed_at is null),0) balance
   from public.garden_partner_debts d join public.garden_partner_fundings f on f.id=d.funding_id
   where d.owner=person and f.state='funded' and f.start_month<=p_month and f.funded_on<(p_month+interval '1 month')::date order by f.funded_on,f.created_at,f.id,d.id loop
   remaining=remaining+greatest(0,debt.balance);take=least(budget,greatest(0,debt.balance));
   if take>0 then allocations=allocations||jsonb_build_array(jsonb_build_object('debt_id',debt.id,'amount_cents',take));budget=budget-take;end if;
  end loop;
  if remaining>0 and rate is null then blockers=blockers||jsonb_build_array('Set a recovery rate for '||person||'.');end if;
  select coalesce(sum((v->>'amount_cents')::bigint),0) into take from jsonb_array_elements(allocations)v;
  owners=owners||jsonb_build_array(jsonb_build_object('owner',person,'entitlement',gross,'paid',paid,'rate_bps',rate,'withheld',take,'payable',gross-paid-take,'debt_before',remaining,'debt_after',remaining-take,'allocations',allocations));
 end loop;
 inputs=jsonb_build_object('month',p_month,'profit',profit,'partners',public.garden_partner_snapshot(),'payouts',coalesce((select jsonb_agg(to_jsonb(t) order by id) from public.garden_payouts t where settlement_month=p_month),'[]'));
 stamp=md5(inputs::text);
 select * into active from public.garden_owner_settlements where month=p_month and reversed_at is null;
 return jsonb_build_object('month',p_month,'net_cents',net,'owners',owners,'fingerprint',stamp,'profit_hash',md5(profit::text),'blockers',blockers,
 'can_post',p_month<date_trunc('month',now() at time zone 'Asia/Manila')::date and active.id is null and jsonb_array_length(blockers)=0,
 'active_settlement',case when active.id is not null then to_jsonb(active) else null end,'needs_review',active.id is not null and active.profit_hash<>md5(profit::text));
end;$$;

create function public.garden_partner_command(p_action text,p_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare prior public.garden_partner_actions;answer jsonb;payload_hash text;today date=(now() at time zone 'Asia/Manila')::date;item uuid;opening date;person text;amount bigint;paid bigint;target_month date;agreement public.garden_installments;purchase public.garden_partner_purchases;fund public.garden_partner_fundings;payment public.garden_partner_payments;statement public.garden_owner_settlements;preview jsonb;v jsonb;a jsonb;total bigint;expense uuid;allocation uuid;movement uuid;rate integer;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 if p_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid command.';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 perform 1 from public.garden_profiles where id=auth.uid() for share;
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 payload_hash=md5(p_payload::text);
 select * into prior from public.garden_partner_actions where id=p_id;
 if found then
  if prior.action<>p_action or prior.actor_id<>auth.uid() or prior.payload_hash<>payload_hash then raise exception 'Retry key belongs to another action.';end if;
  return prior.result;
 end if;
 perform set_config('gardens.partner_write','on',true);
 if p_action='purchase' then
  person=p_payload->>'owner';
  if (p_payload->>'purchased_on')::date>today then raise exception 'Use the actual purchase date.';end if;
  if nullif(p_payload->>'existing_id','') is not null then
   item=(p_payload->>'existing_id')::uuid;select * into agreement from public.garden_installments where id=item for update;
   if not found then raise exception 'Installment agreement not found.';end if;
   if exists(select 1 from public.garden_expenses where installment_id=item and (staff_payment_id is not null or paid_on<(p_payload->>'purchased_on')::date)) then raise exception 'Purchase date or linked payments do not match this agreement.';end if;
  else
   item=p_id;
   insert into public.garden_installments(id,code,name,category_id,total_cents,monthly_cents,first_due,notes) values(item,'PARTNER-'||upper(left(p_id::text,8)),btrim(p_payload->>'name'),(p_payload->>'category_id')::uuid,(p_payload->>'total_cents')::bigint,(p_payload->>'monthly_cents')::bigint,(p_payload->>'first_due')::date,coalesce(p_payload->>'notes',''));
  end if;
  insert into public.garden_partner_purchases(id,owner,purchased_on,created_by) values(item,person,(p_payload->>'purchased_on')::date,auth.uid());
  answer=jsonb_build_object('installment_id',item);
 elsif p_action='reimburse' then
  item=(p_payload->>'installment_id')::uuid;
  select * into purchase from public.garden_partner_purchases where id=item;
  if not found then raise exception 'Choose a partner-funded purchase.';end if;
  select * into agreement from public.garden_installments where id=item for update;
  amount=(p_payload->>'amount_cents')::bigint;
  select coalesce(sum(amount_cents),0) into paid from public.garden_expenses where installment_id=item;
  if amount is null or amount<=0 or paid+amount>agreement.total_cents then raise exception 'Reimbursement exceeds the outstanding obligation.';end if;
  select start_date into opening from public.garden_cash_settings;
  if opening is null or (p_payload->>'paid_on')::date<greatest(opening,purchase.purchased_on) or (p_payload->>'paid_on')::date>today then raise exception 'Set opening balances and use an actual payment date on or after purchase and opening.';end if;
  expense=gen_random_uuid();allocation=gen_random_uuid();
  insert into public.garden_expenses(id,paid_on,category_id,payment_kind,installment_id,due_month,amount_cents,reference,notes)
  values(expense,(p_payload->>'paid_on')::date,agreement.category_id,'installment',item,(p_payload->>'due_month')::date,amount,coalesce(p_payload->>'reference',''),'Reimbursement to '||purchase.owner||': '||agreement.name);
  perform public.garden_cash_allocate(allocation,'expenses',expense,p_payload->>'account',amount);
  insert into public.garden_partner_payments(id,installment_id,expense_id,allocation_id,detail,created_by) values(p_id,item,expense,allocation,jsonb_build_object('paid_on',p_payload->>'paid_on','amount_cents',amount,'account',p_payload->>'account','reference',coalesce(p_payload->>'reference','')),auth.uid());
  answer=jsonb_build_object('payment_id',p_id,'expense_id',expense);
 elsif p_action='void_reimbursement' then
  select * into payment from public.garden_partner_payments where id=(p_payload->>'payment_id')::uuid for update;
  if not found or payment.voided_at is not null then raise exception 'Active reimbursement not found.';end if;
  if length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'Enter a correction reason.';end if;
  delete from public.garden_cash_allocations where id=payment.allocation_id;
  delete from public.garden_expenses where id=payment.expense_id;
  update public.garden_partner_payments set voided_at=now(),void_reason=btrim(p_payload->>'reason') where id=payment.id;
  answer=jsonb_build_object('voided_payment',payment.id);
 elsif p_action='funding_draft' then
  if jsonb_typeof(p_payload->'partners')<>'array' or jsonb_array_length(p_payload->'partners') not between 1 and 3 then raise exception 'Choose partners and their capital allocations.';end if;
  amount=(p_payload->>'total_cents')::bigint;target_month=(p_payload->>'start_month')::date;
  select sum((x.value->>'amount_cents')::bigint) into total from jsonb_array_elements(p_payload->'partners')x;
  if total is distinct from amount then raise exception 'Partner allocations must equal the supplier payment.';end if;
  insert into public.garden_partner_fundings(id,supplier,purpose,total_cents,start_month,created_by) values(p_id,btrim(p_payload->>'supplier'),btrim(p_payload->>'purpose'),amount,target_month,auth.uid());
  for v in select * from jsonb_array_elements(p_payload->'partners') loop
   person=v->>'owner';rate=(v->>'rate_bps')::integer;
   if rate is null then raise exception 'Enter a recovery percentage for every selected partner.';end if;
   insert into public.garden_partner_debts(funding_id,owner,amount_cents) values(p_id,person,(v->>'amount_cents')::bigint);
   if exists(select 1 from public.garden_owner_settlements s where s.month>=target_month and s.reversed_at is null) then raise exception 'Recovery rules must start after confirmed settlements. Reverse the affected settlement to correct it.';end if;
   insert into public.garden_partner_rules(owner,effective_month,rate_bps,reason,created_by) values(person,target_month,rate,'Capital recovery setup',auth.uid()) on conflict(owner,effective_month) do update set rate_bps=excluded.rate_bps,reason=excluded.reason;
  end loop;
  answer=jsonb_build_object('funding_id',p_id);
 elsif p_action='fund' then
  select * into fund from public.garden_partner_fundings where id=(p_payload->>'funding_id')::uuid for update;
  if not found or fund.state<>'draft' then raise exception 'Choose an unpaid draft capital advance.';end if;
  select start_date into opening from public.garden_cash_settings;
  if opening is null or (p_payload->>'paid_on')::date<opening or (p_payload->>'paid_on')::date>today then raise exception 'Set opening balances and use an actual payment date on or after opening.';end if;
  movement=gen_random_uuid();
  insert into public.garden_cash_movements(id,moved_on,kind,from_account,to_account,amount_cents,reference,reason,created_by) values(movement,(p_payload->>'paid_on')::date,'partner_capital',p_payload->>'account',null,fund.total_cents,coalesce(p_payload->>'reference',''),'Capital advance: '||fund.purpose,auth.uid());
  update public.garden_partner_fundings set state='funded',funded_on=(p_payload->>'paid_on')::date,movement_id=movement,funding_detail=jsonb_build_object('account',p_payload->>'account','reference',coalesce(p_payload->>'reference','')) where id=fund.id;
  answer=jsonb_build_object('funding_id',fund.id,'movement_id',movement);
 elsif p_action='void_funding' then
  select * into fund from public.garden_partner_fundings where id=(p_payload->>'funding_id')::uuid for update;
  if not found or fund.state='void' then raise exception 'Active capital advance not found.';end if;
  if length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'Enter a correction reason.';end if;
  if exists(select 1 from public.garden_owner_recoveries r join public.garden_partner_debts d on d.id=r.debt_id join public.garden_owner_settlements s on s.id=r.settlement_id where d.funding_id=fund.id and s.reversed_at is null) then raise exception 'Reverse its owner settlements before correcting funded capital.';end if;
  delete from public.garden_cash_movements where id=fund.movement_id;
  update public.garden_partner_fundings set state='void',void_reason=btrim(p_payload->>'reason') where id=fund.id;
  answer=jsonb_build_object('voided_funding',fund.id);
 elsif p_action='rule' then
  target_month=(p_payload->>'effective_month')::date;
  if exists(select 1 from public.garden_owner_settlements s where s.month>=target_month and s.reversed_at is null) then raise exception 'Rules cannot rewrite confirmed settlements. Reverse the affected settlement first.';end if;
  insert into public.garden_partner_rules(owner,effective_month,rate_bps,reason,created_by) values(p_payload->>'owner',target_month,(p_payload->>'rate_bps')::int,btrim(p_payload->>'reason'),auth.uid()) on conflict(owner,effective_month) do update set rate_bps=excluded.rate_bps,reason=excluded.reason;
  answer=jsonb_build_object('rule_saved',true);
 elsif p_action='settle' then
  target_month=(p_payload->>'month')::date;preview=public.garden_partner_preview(target_month);
  if not (preview->>'can_post')::boolean then raise exception 'Use a completed, unconfirmed month with recovery rates configured.';end if;
  if preview->>'fingerprint' is distinct from p_payload->>'fingerprint' then raise exception 'Records changed after preview. Refresh and review again.' using errcode='40001';end if;
  insert into public.garden_owner_settlements(id,month,net_cents,profit_hash,snapshot,confirmed_by) values(p_id,target_month,(preview->>'net_cents')::bigint,preview->>'profit_hash',preview,auth.uid());
  for v in select * from jsonb_array_elements(preview->'owners') loop
   for a in select * from jsonb_array_elements(v->'allocations') loop
    insert into public.garden_owner_recoveries(settlement_id,debt_id,owner,amount_cents,effective_on) values(p_id,(a->>'debt_id')::uuid,v->>'owner',(a->>'amount_cents')::bigint,(target_month+interval '1 month - 1 day')::date);
   end loop;
  end loop;
  answer=jsonb_build_object('settlement_id',p_id,'snapshot',preview);
 elsif p_action='reverse_settlement' then
  select * into statement from public.garden_owner_settlements where id=(p_payload->>'settlement_id')::uuid for update;
  if not found or statement.reversed_at is not null then raise exception 'Confirmed settlement not found.';end if;
  if length(btrim(coalesce(p_payload->>'reason','')))<3 then raise exception 'Enter a correction reason.';end if;
  update public.garden_owner_settlements set reversed_at=now(),reversed_by=auth.uid(),reversal_reason=btrim(p_payload->>'reason') where id=statement.id;
  answer=jsonb_build_object('reversed_settlement',statement.id);
 else raise exception 'Unknown partner finance action.';end if;
 perform set_config('gardens.partner_write','off',true);
 insert into public.garden_partner_actions(id,action,actor_id,payload_hash,result) values(p_id,p_action,auth.uid(),payload_hash,answer);
 return answer;
end;$$;

alter table public.garden_cash_movements drop constraint garden_cash_movements_kind_check;
alter table public.garden_cash_movements add constraint garden_cash_movements_kind_check check(kind in ('transfer','funding','adjustment','partner_capital'));
alter table public.garden_cash_movements add constraint partner_capital_direction check(kind<>'partner_capital' or (from_account is not null and to_account is null));

create function public.garden_partner_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare linked boolean=false;ok boolean;person text;target_month date;gross bigint;withheld bigint;paid bigint;statement public.garden_owner_settlements;
begin
 ok=current_user=(select pg_get_userbyid(proowner) from pg_proc where oid='public.garden_partner_command(text,uuid,jsonb)'::regprocedure) and coalesce(current_setting('gardens.partner_write',true),'')='on';
 if tg_table_name='garden_expenses' then
  if tg_op<>'DELETE' then linked=exists(select 1 from public.garden_partner_purchases where id=new.installment_id);end if;
  if tg_op<>'INSERT' then linked=linked or exists(select 1 from public.garden_partner_purchases where id=old.installment_id);end if;
 elsif tg_table_name='garden_installments' then
  linked=exists(select 1 from public.garden_partner_purchases where id=old.id);
 elsif tg_table_name='garden_cash_movements' then
  if tg_op<>'DELETE' then linked=new.kind='partner_capital';end if;
  if tg_op<>'INSERT' then linked=linked or old.kind='partner_capital';end if;
 elsif tg_table_name='garden_cash_allocations' then
  if tg_op<>'INSERT' then linked=exists(select 1 from public.garden_partner_payments where allocation_id=old.id and voided_at is null);end if;
 elsif tg_table_name='garden_payouts' and tg_op<>'DELETE' then
  person=new.owner;target_month=new.settlement_month;
  select * into statement from public.garden_owner_settlements s where s.month=target_month and s.reversed_at is null;
  if statement.id is not null then
   select (v->>'entitlement')::bigint,(v->>'withheld')::bigint into gross,withheld from jsonb_array_elements(statement.snapshot->'owners')v where v->>'owner'=person;
   select coalesce(sum(amount_cents),0) into paid from public.garden_payouts where owner=person and settlement_month=target_month and id<>new.id;
   if paid+new.amount_cents>gross-withheld then raise exception 'Payout exceeds the confirmed entitlement after capital deductions. Correct the settlement first.';end if;
  end if;
 end if;
 if linked and not ok then raise exception 'Use Partner advances to change this linked agreement, payment or account entry.' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
create trigger partner_guard before insert or update or delete on public.garden_expenses for each row execute function public.garden_partner_guard();
create trigger partner_guard before update or delete on public.garden_installments for each row execute function public.garden_partner_guard();
create trigger partner_guard before insert or update or delete on public.garden_cash_movements for each row execute function public.garden_partner_guard();
create trigger partner_guard before update or delete on public.garden_cash_allocations for each row execute function public.garden_partner_guard();
create trigger partner_guard before insert or update on public.garden_payouts for each row execute function public.garden_partner_guard();

-- Keep the normal finance snapshot shape, adding only Finance-visible partner records.
create or replace function public.garden_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'categories',coalesce((select jsonb_agg(to_jsonb(t) order by name) from public.garden_categories t),'[]'),
 'income',coalesce((select jsonb_agg(to_jsonb(t) order by business_date desc,id) from public.garden_income t),'[]'),
 'expenses',coalesce((select jsonb_agg(to_jsonb(t) order by paid_on desc,id) from public.garden_expenses t),'[]'),
 'bills',coalesce((select jsonb_agg(to_jsonb(t) order by name) from public.garden_fixed_bills t),'[]'),
 'terms',coalesce((select jsonb_agg(to_jsonb(t) order by start_month) from public.garden_bill_terms t),'[]'),
 'installments',coalesce((select jsonb_agg(to_jsonb(t) order by name) from public.garden_installments t),'[]'),
 'payouts',coalesce((select jsonb_agg(to_jsonb(t) order by paid_on desc,id) from public.garden_payouts t),'[]'),
 'audit',coalesce((select jsonb_agg(to_jsonb(t)) from (select id,table_name,action,occurred_at from public.garden_audit order by occurred_at desc,id desc limit 100)t),'[]'),
 'partners',case when public.garden_is_member() then public.garden_partner_snapshot() else null end);
$$;
revoke all on function public.garden_partner_serialize(),public.garden_partner_profit(date),public.garden_partner_guard(),public.garden_partner_snapshot(),public.garden_partner_preview(date),public.garden_partner_command(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.garden_partner_snapshot(),public.garden_partner_preview(date),public.garden_partner_command(text,uuid,jsonb) to authenticated;

-- Share one lock order with Onda imports and standalone allocations. A source-row
-- lock or Onda's former table locks must not precede waiting for partner finance.
-- Replacing only these lock statements preserves the existing RPC bodies and ACLs.
do $$declare definition text;begin
 definition=pg_get_functiondef('public.garden_onda_confirm(uuid,uuid,jsonb)'::regprocedure);
 if position('lock table public.garden_income in exclusive mode;' in definition)=0 or position('lock table public.garden_cash_allocations,public.garden_expenses,public.garden_categories in share mode;' in definition)=0 then raise exception 'Unexpected Onda locking definition; do not apply a partial concurrency update.';end if;
 definition=replace(definition,'lock table public.garden_income in exclusive mode;','perform pg_advisory_xact_lock(hashtext(''gardens-partner-finance''));');
 definition=replace(definition,'lock table public.garden_cash_allocations,public.garden_expenses,public.garden_categories in share mode;','');
 definition=replace(definition,'Parent locks precede allocation locks, matching the allocation RPC''s order.','Finance writers share an advisory lock before touching source rows.');
 execute definition;
 definition=pg_get_functiondef('public.garden_cash_allocate(uuid,text,uuid,text,bigint,date)'::regprocedure);
 if position('t=''garden_''||p_kind;' in definition)=0 then raise exception 'Unexpected allocation locking definition.';end if;
 definition=replace(definition,'t=''garden_''||p_kind;','perform pg_advisory_xact_lock(hashtext(''gardens-partner-finance'')); perform 1 from public.garden_profiles where id=auth.uid() for share; if not public.garden_is_admin() then raise exception ''Finance management permission required.'' using errcode=''42501'';end if; t=''garden_''||p_kind;');
 execute definition;
end;$$;
notify pgrst,'reload schema';
