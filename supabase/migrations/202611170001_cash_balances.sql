-- Cash location is separate from income recognition. Existing records remain unassigned.
create table public.garden_cash_settings (
 id boolean primary key default true check(id), start_date date not null check(start_date between date '2000-01-01' and date '2100-12-31'),
 cash bigint not null check(abs(cash)<=999999999999),bank bigint not null check(abs(bank)<=999999999999),booking bigint not null check(abs(booking)<=999999999999),
 created_at timestamptz not null default now(),created_by uuid references auth.users
);
create table public.garden_cash_allocations (
 id uuid primary key, account text not null check(account in ('cash','bank','booking')),posted_on date not null check(posted_on between date '2000-01-01' and date '2100-12-31'),
 income_id uuid references public.garden_income on delete cascade,expense_id uuid references public.garden_expenses on delete cascade,payout_id uuid references public.garden_payouts on delete cascade,
 amount_cents bigint not null check(amount_cents between 1 and 999999999999),
 check(num_nonnulls(income_id,expense_id,payout_id)=1), created_at timestamptz not null default now(),updated_at timestamptz not null default now(),created_by uuid references auth.users,updated_by uuid references auth.users
);
create index garden_cash_income on public.garden_cash_allocations(income_id);
create index garden_cash_expense on public.garden_cash_allocations(expense_id);
create index garden_cash_payout on public.garden_cash_allocations(payout_id);
create table public.garden_cash_movements (
 id uuid primary key, moved_on date not null check(moved_on between date '2000-01-01' and date '2100-12-31'),
 kind text not null check(kind in ('transfer','funding','adjustment')),
 from_account text check(from_account in ('cash','bank','booking')),to_account text check(to_account in ('cash','bank','booking')),
 amount_cents bigint not null check(amount_cents between 1 and 999999999999),
 reference text not null default '' check(length(reference)<=120),reason text not null check(length(btrim(reason)) between 1 and 1000),
 check((kind='transfer' and from_account is not null and to_account is not null and from_account<>to_account) or (kind<>'transfer' and num_nonnulls(from_account,to_account)=1)),
 created_at timestamptz not null default now(),created_by uuid references auth.users
);
do $$declare t text;begin
 foreach t in array array['garden_cash_settings','garden_cash_allocations','garden_cash_movements'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy finance_read on public.%I for select to authenticated using(public.garden_is_member())',t);
  execute format('create trigger log_change after insert or update or delete on public.%I for each row execute function public.garden_log_change()',t);
 end loop;
end;$$;
-- The existing audit helper expects UUID ids; the singleton settings row uses its own audit below.
drop trigger log_change on public.garden_cash_settings;
create function public.garden_cash_setup(p_date date,p_cash bigint,p_bank bigint,p_booking bigint) returns void
language plpgsql security definer set search_path='' as $$begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 if p_date>(now() at time zone 'Asia/Manila')::date then raise exception 'Opening date cannot be in the future.';end if;
 insert into public.garden_cash_settings(start_date,cash,bank,booking,created_by) values(p_date,p_cash,p_bank,p_booking,auth.uid());
 insert into public.garden_audit(table_name,action,after_record,actor_id) values('garden_cash_settings','INSERT',jsonb_build_object('start_date',p_date,'cash',p_cash,'bank',p_bank,'booking',p_booking),auth.uid());
end;$$;
create function public.garden_cash_allocate(p_id uuid,p_kind text,p_record uuid,p_account text,p_amount bigint,p_posted date default null) returns void
language plpgsql security definer set search_path='' as $$
declare t text; col text; d text; total bigint; paid date; opening date; assigned bigint;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 if p_kind not in ('income','expenses','payouts') or p_kind is null then raise exception 'Choose a finance entry.';end if;
 t='garden_'||p_kind;col=case p_kind when 'income' then 'income_id' when 'expenses' then 'expense_id' else 'payout_id' end;d=case p_kind when 'income' then 'business_date' else 'paid_on' end;
 execute format('select amount_cents,%I from public.%I where id=$1 for update',d,t) into total,paid using p_record;
 if total is null then raise exception 'Finance entry no longer exists.';end if;
 select start_date into opening from public.garden_cash_settings;
 if opening is null or paid<opening then raise exception 'Choose an entry on or after the opening date.';end if;
 p_posted=coalesce(p_posted,paid);
 if p_posted<paid or p_posted>(now() at time zone 'Asia/Manila')::date then raise exception 'Use the actual funds date, on or after the entry date and not in the future.';end if;
 execute format('select coalesce(sum(amount_cents),0) from public.garden_cash_allocations where %I=$1 and id<>$2',col) into assigned using p_record,p_id;
 if p_amount is null or p_amount<=0 or assigned+p_amount>total then raise exception 'Account assignments cannot exceed the finance entry amount.';end if;
 insert into public.garden_cash_allocations(id,account,posted_on,income_id,expense_id,payout_id,amount_cents,created_by,updated_by)
 values(p_id,p_account,p_posted,case when p_kind='income' then p_record end,case when p_kind='expenses' then p_record end,case when p_kind='payouts' then p_record end,p_amount,auth.uid(),auth.uid())
 on conflict(id) do update set account=excluded.account,posted_on=excluded.posted_on,amount_cents=excluded.amount_cents,updated_at=now(),updated_by=auth.uid()
 where garden_cash_allocations.income_id is not distinct from excluded.income_id and garden_cash_allocations.expense_id is not distinct from excluded.expense_id and garden_cash_allocations.payout_id is not distinct from excluded.payout_id;
 if not found then raise exception 'This assignment belongs to another entry.';end if;
end;$$;
create function public.garden_cash_unassign(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 delete from public.garden_cash_allocations where id=p_id;
end;$$;
create function public.garden_cash_move(p_id uuid,p_date date,p_kind text,p_from text,p_to text,p_amount bigint,p_reference text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$declare opening date; prior public.garden_cash_movements;begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 select start_date into opening from public.garden_cash_settings;
 if opening is null or p_date<opening or p_date>(now() at time zone 'Asia/Manila')::date then raise exception 'Choose an actual movement date on or after the opening date.';end if;
 insert into public.garden_cash_movements(id,moved_on,kind,from_account,to_account,amount_cents,reference,reason,created_by)
 values(p_id,p_date,p_kind,p_from,p_to,p_amount,btrim(p_reference),btrim(p_reason),auth.uid()) on conflict(id) do nothing;
 select * into prior from public.garden_cash_movements where id=p_id;
 if row(prior.moved_on,prior.kind,prior.from_account,prior.to_account,prior.amount_cents,prior.reference,prior.reason) is distinct from row(p_date,p_kind,p_from,p_to,p_amount,btrim(p_reference),btrim(p_reason)) then raise exception 'Retry key was already used for another movement.';end if;
end;$$;
-- Parent edits cannot strand assignments or overdraw their original transaction.
create function public.garden_cash_guard_parent() returns trigger
language plpgsql security definer set search_path='' as $$declare assigned bigint;opening date;d date;first_posted date;col text;begin
 col=case tg_table_name when 'garden_income' then 'income_id' when 'garden_expenses' then 'expense_id' else 'payout_id' end;
 execute format('select coalesce(sum(amount_cents),0) from public.garden_cash_allocations where %I=$1',col) into assigned using new.id;
 if assigned>new.amount_cents then raise exception 'Remove or reduce account assignments in Balances before reducing this amount.';end if;
 d=case when tg_table_name='garden_income' then (to_jsonb(new)->>'business_date')::date else (to_jsonb(new)->>'paid_on')::date end;
 execute format('select min(posted_on) from public.garden_cash_allocations where %I=$1',col) into first_posted using new.id;
 select start_date into opening from public.garden_cash_settings;
 if assigned>0 and (d<opening or d>first_posted) then raise exception 'Remove account assignments before changing this entry outside the tracked dates.';end if;
 return new;
end;$$;
do $$declare t text;begin foreach t in array array['garden_income','garden_expenses','garden_payouts'] loop
 execute format('create trigger cash_guard before update on public.%I for each row execute function public.garden_cash_guard_parent()',t);
end loop;end;$$;
create function public.garden_balances_snapshot() returns jsonb
language plpgsql stable security invoker set search_path='' as $$begin
 if not public.garden_is_member() then raise exception 'Finance viewing permission required.' using errcode='42501';end if;
 return jsonb_build_object('settings',(select to_jsonb(t) from public.garden_cash_settings t),'allocations',coalesce((select jsonb_agg(to_jsonb(t)) from public.garden_cash_allocations t),'[]'),'movements',coalesce((select jsonb_agg(to_jsonb(t) order by moved_on,id) from public.garden_cash_movements t),'[]'),'finance',public.garden_snapshot());
end;$$;
revoke all on function public.garden_cash_setup(date,bigint,bigint,bigint),public.garden_cash_allocate(uuid,text,uuid,text,bigint,date),public.garden_cash_unassign(uuid),public.garden_cash_move(uuid,date,text,text,text,bigint,text,text),public.garden_cash_guard_parent(),public.garden_balances_snapshot() from public,anon,authenticated;
grant execute on function public.garden_cash_setup(date,bigint,bigint,bigint),public.garden_cash_allocate(uuid,text,uuid,text,bigint,date),public.garden_cash_unassign(uuid),public.garden_cash_move(uuid,date,text,text,text,bigint,text,text),public.garden_balances_snapshot() to authenticated;
alter policy admin_audit on public.garden_audit using(
 (table_name='garden_profiles' and public.garden_can_manage_accounts()) or
 (table_name in ('garden_cash_settings','garden_cash_allocations','garden_cash_movements','garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_admin()) or
 (table_name not in ('garden_profiles','garden_cash_settings','garden_cash_allocations','garden_cash_movements','garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_team_admin())
);
create or replace function public.garden_finance_report_snapshot() returns jsonb
language plpgsql stable security invoker set search_path='' as $$begin
 if not public.garden_is_member() then raise exception 'Finance viewing permission required.' using errcode='42501';end if;
 return jsonb_build_object('finance',public.garden_snapshot(),'roi',public.garden_roi_snapshot(),'balances',public.garden_balances_snapshot()-'finance',
 'generated_at',statement_timestamp(),'prepared_by',(select display_name from public.garden_profiles where id=auth.uid()));
end;$$;
notify pgrst,'reload schema';
