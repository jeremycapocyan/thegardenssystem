-- Cash borrowed from a partner is financing, not revenue or an expense.
create table public.garden_partner_cash_advances (
 id uuid primary key,owner text not null check(owner in ('Genesis','Ken','Jeremy')),
 purpose text not null check(length(btrim(purpose)) between 1 and 1000),received_on date not null,
 amount_cents bigint not null check(amount_cents between 1 and 999999999999),
 monthly_cents bigint not null check(monthly_cents between 1 and 999999999999),first_due date not null check(first_due>=received_on),
 receipt_id uuid unique references public.garden_cash_movements on delete set null,owned_receipt boolean not null,detail jsonb not null,
 voided_at timestamptz,void_reason text,created_at timestamptz not null default now(),created_by uuid references auth.users,
 check(received_on between date '2000-01-01' and date '2100-12-31'),check(first_due<=date '2100-12-31'),check(monthly_cents<=amount_cents)
);
create table public.garden_partner_cash_spends (
 id uuid primary key,advance_id uuid not null references public.garden_partner_cash_advances,
 expense_id uuid references public.garden_expenses on delete set null,allocation_id uuid references public.garden_cash_allocations on delete set null,
 amount_cents bigint not null check(amount_cents between 1 and 999999999999),owned_expense boolean not null,owned_allocation boolean not null,detail jsonb not null,
 voided_at timestamptz,void_reason text,created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_partner_cash_repayments (
 id uuid primary key,advance_id uuid not null references public.garden_partner_cash_advances,
 paid_on date not null,amount_cents bigint not null check(amount_cents between 1 and 999999999999),
 movement_id uuid unique references public.garden_cash_movements on delete set null,owned_movement boolean not null,detail jsonb not null,
 voided_at timestamptz,void_reason text,created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_partner_cash_actions (
 id uuid primary key,action text not null,actor_id uuid not null references auth.users,payload_hash text not null,result jsonb not null,created_at timestamptz not null default now()
);
create index partner_cash_spend_advance on public.garden_partner_cash_spends(advance_id);
create index partner_cash_spend_expense on public.garden_partner_cash_spends(expense_id);
create index partner_cash_repay_advance on public.garden_partner_cash_repayments(advance_id);
do $$declare t text;begin
 foreach t in array array['garden_partner_cash_advances','garden_partner_cash_spends','garden_partner_cash_repayments','garden_partner_cash_actions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  if t<>'garden_partner_cash_actions' then
   execute format('grant select on public.%I to authenticated',t);
   execute format('create policy finance_read on public.%I for select to authenticated using(public.garden_is_member())',t);
  end if;
  execute format('create trigger log_change after insert or update or delete on public.%I for each row execute function public.garden_log_change()',t);
 end loop;
end;$$;
create policy partner_cash_audit_read on public.garden_audit for select to authenticated using(table_name in ('garden_partner_cash_advances','garden_partner_cash_spends','garden_partner_cash_repayments','garden_partner_cash_actions') and public.garden_is_admin());
create policy partner_cash_audit_boundary on public.garden_audit as restrictive for select to authenticated using(table_name not in ('garden_partner_cash_advances','garden_partner_cash_spends','garden_partner_cash_repayments','garden_partner_cash_actions') or public.garden_is_admin());

create function public.garden_partner_cash_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if not public.garden_is_member() then raise exception 'Finance viewing permission required.' using errcode='42501';end if;
 return jsonb_build_object(
 'advances',coalesce((select jsonb_agg(to_jsonb(t) order by received_on,id) from public.garden_partner_cash_advances t),'[]'),
 'spends',coalesce((select jsonb_agg(to_jsonb(t) order by created_at,id) from public.garden_partner_cash_spends t),'[]'),
 'repayments',coalesce((select jsonb_agg(to_jsonb(t) order by paid_on,id) from public.garden_partner_cash_repayments t),'[]'));
end;$$;

create function public.garden_partner_cash_command(p_action text,p_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior public.garden_partner_cash_actions;a public.garden_partner_cash_advances;s public.garden_partner_cash_spends;r public.garden_partner_cash_repayments;
 m public.garden_cash_movements;e public.garden_expenses;c public.garden_cash_allocations;
 today date=(now() at time zone 'Asia/Manila')::date;opening date;d date;amount bigint;whole bigint;used bigint;other bigint;
 aid uuid;mid uuid;eid uuid;cid uuid;answer jsonb;hash text;account text;reason text;owned boolean;allocated boolean;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 perform 1 from public.garden_profiles where id=auth.uid() for share;
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 hash=md5(p_payload::text);
 select * into prior from public.garden_partner_cash_actions where id=p_id;
 if found then
  if prior.action<>p_action or prior.actor_id<>auth.uid() or prior.payload_hash<>hash then raise exception 'Retry key belongs to another action.';end if;
  return prior.result;
 end if;
 perform set_config('gardens.partner_cash_write','on',true);
 select start_date into opening from public.garden_cash_settings;
 if opening is null then raise exception 'Configure opening balances in Cash & balances first.';end if;
 if p_action='receive' then
  aid=p_id;amount=(p_payload->>'amount_cents')::bigint;d=(p_payload->>'received_on')::date;account=p_payload->>'account';
  if d is null or d<opening or d>today or account is null or account not in ('cash','bank') then raise exception 'Use an actual receipt date on or after opening balances and choose Cash or Bank.';end if;
  if nullif(p_payload->>'movement_id','') is not null then
   mid=(p_payload->>'movement_id')::uuid;select * into m from public.garden_cash_movements where id=mid for update;
   if not found or m.kind<>'funding' or m.from_account is not null or m.to_account<>account or m.amount_cents<>amount or m.moved_on<>d then raise exception 'Existing funding receipt changed or does not match. Refresh and review it.';end if;
   if exists(select 1 from public.garden_partner_cash_advances where receipt_id=mid and voided_at is null) or exists(select 1 from public.garden_partner_cash_repayments where movement_id=mid and voided_at is null) then raise exception 'This cash movement is already linked.';end if;
   owned=false;
  else
   mid=gen_random_uuid();owned=true;
   perform public.garden_cash_move(mid,d,'funding',null,account,amount,coalesce(p_payload->>'reference',''),left('Partner cash advance received: '||coalesce(p_payload->>'owner','')||' — '||coalesce(p_payload->>'purpose',''),1000));
   select * into m from public.garden_cash_movements where id=mid;
  end if;
  insert into public.garden_partner_cash_advances(id,owner,purpose,received_on,amount_cents,monthly_cents,first_due,receipt_id,owned_receipt,detail,created_by)
  values(aid,p_payload->>'owner',btrim(p_payload->>'purpose'),d,amount,(p_payload->>'monthly_cents')::bigint,(p_payload->>'first_due')::date,mid,owned,to_jsonb(m),auth.uid());
  if ((amount-1)/(p_payload->>'monthly_cents')::bigint)>(2100-extract(year from (p_payload->>'first_due')::date)::int)*12+12-extract(month from (p_payload->>'first_due')::date)::int then raise exception 'Choose repayment terms ending by December 2100.';end if;
  answer=jsonb_build_object('id',aid);
 elsif p_action in ('purchase','repay') then
  aid=(p_payload->>'advance_id')::uuid;select * into a from public.garden_partner_cash_advances where id=aid for update;
  if not found or a.voided_at is not null then raise exception 'Choose an active cash advance.';end if;
  amount=(p_payload->>'amount_cents')::bigint;d=(p_payload->>'paid_on')::date;account=p_payload->>'account';
  if amount is null or amount<=0 or d is null or d<a.received_on or d>today or account is null or account not in ('cash','bank') then raise exception 'Use a positive amount, Cash or Bank, and an actual payment date on or after receipt.';end if;
  if p_action='purchase' then
   select coalesce(sum(amount_cents),0) into used from public.garden_partner_cash_spends where advance_id=aid and voided_at is null;
   if used+amount>a.amount_cents then raise exception 'Purchase links cannot exceed the advance received.';end if;
   if nullif(p_payload->>'expense_id','') is not null then
    eid=(p_payload->>'expense_id')::uuid;select * into e from public.garden_expenses where id=eid for update;
    if not found or e.paid_on<>d or e.payment_kind<>'operating' or e.staff_payment_id is not null or e.amount_cents is distinct from (p_payload->>'expected_total_cents')::bigint or e.category_id::text is distinct from p_payload->>'category_id' or e.reference is distinct from coalesce(p_payload->>'reference','') or e.notes is distinct from coalesce(p_payload->>'notes','') then raise exception 'Existing expense changed or is not an eligible operating purchase. Refresh and review it.';end if;
    owned=false;
   else
    eid=gen_random_uuid();whole=(p_payload->>'total_cents')::bigint;
    if whole is null or whole<amount then raise exception 'Total purchase must cover the advance-funded portion.';end if;
    if not exists(select 1 from public.garden_categories where id=(p_payload->>'category_id')::uuid and kind='expense' and active) then raise exception 'Choose an active expense category.';end if;
    insert into public.garden_expenses(id,paid_on,category_id,payment_kind,amount_cents,reference,notes)
    values(eid,d,(p_payload->>'category_id')::uuid,'operating',whole,coalesce(p_payload->>'reference',''),btrim(p_payload->>'notes'));
    select * into e from public.garden_expenses where id=eid;owned=true;
   end if;
   select coalesce(sum(amount_cents),0) into other from public.garden_partner_cash_spends where expense_id=eid and voided_at is null;
   if other+amount>e.amount_cents then raise exception 'Funding links cannot exceed the purchase amount.';end if;
   if nullif(p_payload->>'allocation_id','') is not null then
    cid=(p_payload->>'allocation_id')::uuid;select * into c from public.garden_cash_allocations where id=cid for update;
    select coalesce(sum(amount_cents),0) into other from public.garden_partner_cash_spends where allocation_id=cid and voided_at is null;
    if c.id is null or c.expense_id is distinct from eid or c.account<>account or c.posted_on<>d or other+amount>c.amount_cents then raise exception 'Account assignment changed or has insufficient unlinked funds.';end if;
    allocated=false;
   else
    cid=gen_random_uuid();perform public.garden_cash_allocate(cid,'expenses',eid,account,case when owned then e.amount_cents else amount end,d);
    select * into c from public.garden_cash_allocations where id=cid;allocated=true;
   end if;
   insert into public.garden_partner_cash_spends(id,advance_id,expense_id,allocation_id,amount_cents,owned_expense,owned_allocation,detail,created_by)
   values(p_id,aid,eid,cid,amount,owned,allocated,jsonb_build_object('expense',to_jsonb(e),'allocation',to_jsonb(c)),auth.uid());
  else
   select coalesce(sum(amount_cents),0) into used from public.garden_partner_cash_repayments where advance_id=aid and voided_at is null;
   if used+amount>a.amount_cents then raise exception 'Repayment cannot exceed the outstanding debt.';end if;
   if nullif(p_payload->>'movement_id','') is not null then
    mid=(p_payload->>'movement_id')::uuid;select * into m from public.garden_cash_movements where id=mid for update;
    if not found or m.kind<>'funding' or m.to_account is not null or m.from_account<>account or m.amount_cents<>amount or m.moved_on<>d then raise exception 'Existing repayment changed or does not match. Refresh and review it.';end if;
    if exists(select 1 from public.garden_partner_cash_repayments where movement_id=mid and voided_at is null) or exists(select 1 from public.garden_partner_cash_advances where receipt_id=mid and voided_at is null) then raise exception 'This cash movement is already linked.';end if;
    owned=false;
   else
    mid=gen_random_uuid();owned=true;perform public.garden_cash_move(mid,d,'funding',account,null,amount,coalesce(p_payload->>'reference',''),left('Partner cash advance repayment: '||a.owner||' — '||a.purpose,1000));
    select * into m from public.garden_cash_movements where id=mid;
   end if;
   insert into public.garden_partner_cash_repayments(id,advance_id,paid_on,amount_cents,movement_id,owned_movement,detail,created_by)
   values(p_id,aid,d,amount,mid,owned,to_jsonb(m),auth.uid());
  end if;
  answer=jsonb_build_object('id',p_id,'advance_id',aid);
 elsif p_action in ('void_receipt','void_purchase','void_repayment') then
  reason=btrim(p_payload->>'reason');
  if reason is null or length(reason) not between 1 and 1000 then raise exception 'A correction reason is required.';end if;
  aid=(p_payload->>'record_id')::uuid;
  if p_action='void_receipt' then
   select * into a from public.garden_partner_cash_advances where id=aid for update;
   if not found or a.voided_at is not null then raise exception 'Active advance not found.';end if;
   if exists(select 1 from public.garden_partner_cash_spends where advance_id=aid and voided_at is null) or exists(select 1 from public.garden_partner_cash_repayments where advance_id=aid and voided_at is null) then raise exception 'Correct linked purchases and repayments before voiding this receipt.';end if;
   update public.garden_partner_cash_advances set voided_at=now(),void_reason=reason,receipt_id=null where id=aid;
   if a.owned_receipt then delete from public.garden_cash_movements where id=a.receipt_id;end if;
  elsif p_action='void_purchase' then
   select * into s from public.garden_partner_cash_spends where id=aid for update;
   if not found or s.voided_at is not null then raise exception 'Active purchase link not found.';end if;
   if s.owned_expense and exists(select 1 from public.garden_partner_cash_spends where expense_id=s.expense_id and id<>s.id and voided_at is null) then raise exception 'Unlink other advances from this expense first.';end if;
   if s.owned_allocation and exists(select 1 from public.garden_partner_cash_spends where allocation_id=s.allocation_id and id<>s.id and voided_at is null) then raise exception 'Unlink other advances from this account assignment first.';end if;
   update public.garden_partner_cash_spends set voided_at=now(),void_reason=reason where id=aid;
   if s.owned_expense then delete from public.garden_expenses where id=s.expense_id;
   elsif s.owned_allocation then delete from public.garden_cash_allocations where id=s.allocation_id;end if;
  else
   select * into r from public.garden_partner_cash_repayments where id=aid for update;
   if not found or r.voided_at is not null then raise exception 'Active repayment not found.';end if;
   update public.garden_partner_cash_repayments set voided_at=now(),void_reason=reason,movement_id=null where id=aid;
   if r.owned_movement then delete from public.garden_cash_movements where id=r.movement_id;end if;
  end if;
  answer=jsonb_build_object('id',aid);
 else raise exception 'Unknown partner cash advance action.';
 end if;
 insert into public.garden_partner_cash_actions(id,action,actor_id,payload_hash,result) values(p_id,p_action,auth.uid(),hash,answer);
 perform set_config('gardens.partner_cash_write','off',true);
 return answer;
end;$$;

create function public.garden_partner_cash_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare linked boolean=false;item uuid;begin
 if current_user=(select pg_get_userbyid(proowner) from pg_proc where oid='public.garden_partner_cash_command(text,uuid,jsonb)'::regprocedure) and coalesce(current_setting('gardens.partner_cash_write',true),'')='on' then
  if tg_op='DELETE' then return old;end if;return new;
 end if;
 item=old.id;
 if tg_table_name='garden_cash_movements' then
  linked=exists(select 1 from public.garden_partner_cash_advances where receipt_id=item and voided_at is null) or exists(select 1 from public.garden_partner_cash_repayments where movement_id=item and voided_at is null);
 elsif tg_table_name='garden_expenses' then
  linked=exists(select 1 from public.garden_partner_cash_spends where expense_id=item and voided_at is null);
 elsif tg_table_name='garden_cash_allocations' then
  linked=exists(select 1 from public.garden_partner_cash_spends where allocation_id=item and voided_at is null);
 end if;
 if linked then raise exception 'Use Partner cash advances to correct this linked entry.' using errcode='23514';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
do $$declare t text;definition text;begin
 foreach t in array array['garden_cash_movements','garden_expenses','garden_cash_allocations'] loop
  execute format('create trigger partner_cash_guard before update or delete on public.%I for each row execute function public.garden_partner_cash_guard()',t);
 end loop;
 definition=pg_get_functiondef('public.garden_snapshot()'::regprocedure);
 if position('''partners'',case' in definition)=0 then raise exception 'Unexpected finance snapshot definition.';end if;
 execute replace(definition,'''partners'',case','''partner_cash'',case when public.garden_is_member() then public.garden_partner_cash_snapshot() else null end,''partners'',case');
end;$$;
revoke all on function public.garden_partner_cash_snapshot(),public.garden_partner_cash_command(text,uuid,jsonb),public.garden_partner_cash_guard() from public,anon,authenticated;
grant execute on function public.garden_partner_cash_snapshot(),public.garden_partner_cash_command(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
