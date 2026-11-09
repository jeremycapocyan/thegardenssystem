-- Capital is funding, not business income or an additional expense.
create table public.garden_capital (
 id uuid primary key default gen_random_uuid(), invested_on date not null check(invested_on between date '2000-01-01' and date '2100-12-31'),
 owner text not null check(owner in ('Genesis','Ken','Jeremy')),amount_cents bigint not null check(amount_cents between 1 and 999999999999),
 reference text not null default '' check(length(reference)<=120),notes text not null default '' check(length(notes)<=1000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),created_by uuid references auth.users,updated_by uuid references auth.users
);
-- Mark an existing capital purchase once; never duplicate it in Expenses.
create table public.garden_roi_exclusions (
 id uuid primary key default gen_random_uuid(),expense_id uuid not null unique references public.garden_expenses on delete cascade,
 reason text not null check(length(btrim(reason)) between 1 and 1000),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),created_by uuid references auth.users,updated_by uuid references auth.users
);
create function public.garden_validate_roi() returns trigger
language plpgsql security invoker set search_path='' as $$begin
 if tg_table_name='garden_capital' then
  if new.invested_on>(now() at time zone 'Asia/Manila')::date then raise exception 'Record only capital already contributed.';end if;
 else
  if exists(select 1 from public.garden_expenses where id=new.expense_id and staff_payment_id is not null) then
   raise exception 'Payroll payments are operating cash expenses, not capital purchases.';end if;
 end if;
 return new;
end;$$;
revoke all on function public.garden_validate_roi() from public,anon,authenticated;
do $$ declare t text;begin
 foreach t in array array['garden_capital','garden_roi_exclusions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to authenticated',t);
  execute format('create policy finance_read on public.%I for select to authenticated using(public.garden_is_member())',t);
  execute format('create policy finance_insert on public.%I for insert to authenticated with check(public.garden_is_admin())',t);
  execute format('create policy finance_update on public.%I for update to authenticated using(public.garden_is_admin()) with check(public.garden_is_admin())',t);
  execute format('create policy finance_delete on public.%I for delete to authenticated using(public.garden_is_admin())',t);
  execute format('create trigger validate_record before insert or update on public.%I for each row execute function public.garden_validate_record()',t);
  execute format('create trigger validate_roi before insert or update on public.%I for each row execute function public.garden_validate_roi()',t);
  execute format('create trigger log_change after insert or update or delete on public.%I for each row execute function public.garden_log_change()',t);
 end loop;
end;$$;
-- A role outside finance must not see capital snapshots through the audit table.
alter policy admin_audit on public.garden_audit using(
 (table_name='garden_profiles' and public.garden_can_manage_accounts()) or
 (table_name in ('garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_admin()) or
 (table_name not in ('garden_profiles','garden_capital','garden_roi_exclusions','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_team_admin())
);
create function public.garden_roi_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('capital',coalesce((select jsonb_agg(to_jsonb(t) order by invested_on,id) from public.garden_capital t),'[]'),
 'exclusions',coalesce((select jsonb_agg(to_jsonb(t)) from public.garden_roi_exclusions t),'[]'));
$$;
revoke all on function public.garden_roi_snapshot() from public,anon;
grant execute on function public.garden_roi_snapshot() to authenticated;
notify pgrst,'reload schema';
