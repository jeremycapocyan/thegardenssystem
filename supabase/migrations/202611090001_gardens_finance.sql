-- The Gardens: one shared workspace, authorized members only.
-- No application user is made an administrator automatically.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
set search_path = public, extensions;

create table public.garden_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  role text not null check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);
create or replace function public.garden_is_member() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.garden_profiles where id = (select auth.uid())); $$;
create or replace function public.garden_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.garden_profiles where id = (select auth.uid()) and role = 'admin'); $$;
revoke all on function public.garden_is_member(), public.garden_is_admin() from public, anon;
grant execute on function public.garden_is_member(), public.garden_is_admin() to authenticated;

create table public.garden_categories (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('income','expense')),
  name text not null check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id)
);
create unique index garden_category_name_unique on public.garden_categories(kind,lower(btrim(name)));
create table public.garden_fixed_bills (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check(length(btrim(code)) between 1 and 40),
  name text not null check(length(btrim(name)) between 1 and 120),
  category_id uuid not null references public.garden_categories(id),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id)
);
create table public.garden_bill_terms (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.garden_fixed_bills(id) on delete cascade,
  start_month date not null check(extract(day from start_month)=1),
  end_month date check(extract(day from end_month)=1 and end_month>=start_month),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999),
  due_day integer not null check(due_day between 1 and 31),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  constraint garden_bill_terms_no_overlap exclude using gist
    (bill_id with =, daterange(start_month, case when end_month is null then null else (end_month+interval '1 month')::date end,'[)') with &&)
);
create table public.garden_installments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check(length(btrim(code)) between 1 and 40),
  name text not null check(length(btrim(name)) between 1 and 120),
  category_id uuid not null references public.garden_categories(id),
  total_cents bigint not null check(total_cents between 1 and 999999999999),
  monthly_cents bigint not null check(monthly_cents between 1 and 999999999999),
  first_due date not null check(first_due between date '2000-01-01' and date '9998-12-31'),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id)
);
create table public.garden_income (
  id uuid primary key default gen_random_uuid(),
  business_date date not null check(business_date between date '2000-01-01' and date '9998-12-31'),
  category_id uuid not null references public.garden_categories(id),
  amount_cents bigint not null check(amount_cents between 0 and 999999999999),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  unique(business_date,category_id)
);
create table public.garden_expenses (
  id uuid primary key default gen_random_uuid(),
  paid_on date not null check(paid_on between date '2000-01-01' and date '9998-12-31'),
  category_id uuid not null references public.garden_categories(id),
  payment_kind text not null check(payment_kind in ('operating','fixed','installment')),
  fixed_bill_id uuid references public.garden_fixed_bills(id),
  installment_id uuid references public.garden_installments(id),
  due_month date check(extract(day from due_month)=1),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999),
  reference text not null default '' check(length(reference)<=120),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id),
  check((payment_kind='operating' and fixed_bill_id is null and installment_id is null and due_month is null)
     or (payment_kind='fixed' and fixed_bill_id is not null and installment_id is null and due_month is not null)
     or (payment_kind='installment' and fixed_bill_id is null and installment_id is not null and due_month is not null))
);
create index garden_expenses_paid_on on public.garden_expenses(paid_on);
create index garden_expenses_bill_month on public.garden_expenses(fixed_bill_id,due_month,paid_on);
create index garden_expenses_installment on public.garden_expenses(installment_id,paid_on);
create table public.garden_payouts (
  id uuid primary key default gen_random_uuid(),
  paid_on date not null check(paid_on between date '2000-01-01' and date '9998-12-31'),
  owner text not null check(owner in ('Genesis','Ken','Jeremy')),
  settlement_month date not null check(extract(day from settlement_month)=1),
  amount_cents bigint not null check(amount_cents between 1 and 999999999999),
  reference text not null default '' check(length(reference)<=120),
  notes text not null default '' check(length(notes)<=1000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id), updated_by uuid references auth.users(id)
);
create index garden_payouts_month_owner on public.garden_payouts(settlement_month,owner,paid_on);
create table public.garden_audit (
  id bigint generated always as identity primary key,
  record_id uuid, table_name text not null, action text not null,
  before_record jsonb, after_record jsonb, actor_id uuid,
  occurred_at timestamptz not null default now()
);

-- Category kind and obligation references are checked in the database, not just forms.
create or replace function public.garden_validate_record() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare expected_kind text; actual_kind text; agreement public.garden_installments; final_month date;
begin
  if tg_table_name='garden_categories' then
    new.name=btrim(new.name);
    if tg_op='UPDATE' and new.kind<>old.kind then raise exception 'A category kind cannot be changed. Archive it and create a new category.' using errcode='23514';end if;
  elsif tg_table_name in ('garden_income','garden_expenses','garden_fixed_bills','garden_installments') then
    expected_kind=case when tg_table_name='garden_income' then 'income' else 'expense' end;
    select kind into actual_kind from public.garden_categories where id=new.category_id;
    if actual_kind is distinct from expected_kind then raise exception 'Choose a category of the correct type.' using errcode='23514';end if;
  end if;
  if tg_table_name='garden_expenses' then
    if new.payment_kind='fixed' and not exists(
      select 1 from public.garden_bill_terms t where t.bill_id=new.fixed_bill_id and t.start_month<=new.due_month and (t.end_month is null or t.end_month>=new.due_month)
    ) then raise exception 'This bill has no terms for the selected due month.' using errcode='23514';end if;
    if new.payment_kind='installment' then
      select * into agreement from public.garden_installments where id=new.installment_id;
      if not found then raise exception 'Choose an existing installment agreement.' using errcode='23503';end if;
      final_month=(date_trunc('month',agreement.first_due)+(ceil(agreement.total_cents::numeric/agreement.monthly_cents)-1)*interval '1 month')::date;
      if new.due_month<date_trunc('month',agreement.first_due)::date or new.due_month>final_month then raise exception 'The due month is outside this installment payment schedule.' using errcode='23514';end if;
    end if;
  end if;
  if tg_op='INSERT' then new.created_by=auth.uid();new.created_at=now();
  else new.created_by=old.created_by;new.created_at=old.created_at;end if;
  new.updated_by=auth.uid();new.updated_at=now();return new;
end;$$;

create or replace function public.garden_log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.garden_audit(record_id,table_name,action,before_record,after_record,actor_id)
  values(case when tg_op='DELETE' then old.id else new.id end,tg_table_name,tg_op,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    case when tg_op='DELETE' then null else to_jsonb(new) end,auth.uid());
  return null;
end;$$;
revoke all on function public.garden_validate_record(),public.garden_log_change() from public, anon, authenticated;

do $$ declare t text;begin
  foreach t in array array['garden_categories','garden_fixed_bills','garden_bill_terms','garden_installments','garden_income','garden_expenses','garden_payouts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon',t);
    execute format('grant select,insert,update,delete on public.%I to authenticated',t);
    execute format('create policy member_read on public.%I for select to authenticated using ((select public.garden_is_member()))',t);
    execute format('create policy admin_insert on public.%I for insert to authenticated with check ((select public.garden_is_admin()))',t);
    execute format('create policy admin_update on public.%I for update to authenticated using ((select public.garden_is_admin())) with check ((select public.garden_is_admin()))',t);
    execute format('create policy admin_delete on public.%I for delete to authenticated using ((select public.garden_is_admin()))',t);
    execute format('create trigger validate_record before insert or update on public.%I for each row execute function public.garden_validate_record()',t);
    execute format('create trigger log_change after insert or update or delete on public.%I for each row execute function public.garden_log_change()',t);
  end loop;
end;$$;
alter table public.garden_profiles enable row level security;
alter table public.garden_audit enable row level security;
revoke all on public.garden_profiles,public.garden_audit from anon,authenticated;
grant select on public.garden_profiles,public.garden_audit to authenticated;
create policy own_profile on public.garden_profiles for select to authenticated using(id=(select auth.uid()) or (select public.garden_is_admin()));
create policy admin_audit on public.garden_audit for select to authenticated using((select public.garden_is_admin()));

-- One RPC provides a consistent snapshot and avoids the API's per-query row limit.
create or replace function public.garden_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'categories',coalesce((select jsonb_agg(to_jsonb(t) order by t.name) from public.garden_categories t),'[]'::jsonb),
    'income',coalesce((select jsonb_agg(to_jsonb(t) order by t.business_date desc,t.id) from public.garden_income t),'[]'::jsonb),
    'expenses',coalesce((select jsonb_agg(to_jsonb(t) order by t.paid_on desc,t.id) from public.garden_expenses t),'[]'::jsonb),
    'bills',coalesce((select jsonb_agg(to_jsonb(t) order by t.name) from public.garden_fixed_bills t),'[]'::jsonb),
    'terms',coalesce((select jsonb_agg(to_jsonb(t) order by t.start_month) from public.garden_bill_terms t),'[]'::jsonb),
    'installments',coalesce((select jsonb_agg(to_jsonb(t) order by t.name) from public.garden_installments t),'[]'::jsonb),
    'payouts',coalesce((select jsonb_agg(to_jsonb(t) order by t.paid_on desc,t.id) from public.garden_payouts t),'[]'::jsonb),
    'audit',coalesce((select jsonb_agg(to_jsonb(t)) from (select id,table_name,action,occurred_at from public.garden_audit order by occurred_at desc,id desc limit 100)t),'[]'::jsonb)
  );
$$;
revoke all on function public.garden_snapshot() from public,anon;
grant execute on function public.garden_snapshot() to authenticated;

-- Creating a bill and its first terms is atomic; retries with the same IDs are safe.
create or replace function public.garden_save_bill(p_payload jsonb,p_bill_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare term_id uuid=(p_payload->>'term_id')::uuid;begin
  if not public.garden_is_admin() then raise exception 'Only Jeremy can manage records.' using errcode='42501';end if;
  insert into public.garden_fixed_bills(id,code,name,category_id,notes)
  values(p_bill_id,btrim(p_payload->>'code'),btrim(p_payload->>'name'),(p_payload->>'category_id')::uuid,coalesce(p_payload->>'notes',''))
  on conflict(id) do update set name=excluded.name,category_id=excluded.category_id,notes=excluded.notes;
  perform 1 from public.garden_fixed_bills where id=p_bill_id for update;
  if exists(select 1 from public.garden_bill_terms where id=term_id and bill_id<>p_bill_id) then raise exception 'Invalid bill terms.' using errcode='23514';end if;
  insert into public.garden_bill_terms(id,bill_id,start_month,end_month,amount_cents,due_day)
  values(term_id,p_bill_id,(p_payload->>'start_month')::date,nullif(p_payload->>'end_month','')::date,(p_payload->>'amount_cents')::bigint,(p_payload->>'due_day')::int)
  on conflict(id) do update set start_month=excluded.start_month,end_month=excluded.end_month,amount_cents=excluded.amount_cents,due_day=excluded.due_day;
end;$$;
create or replace function public.garden_revise_bill(p_payload jsonb,p_bill_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare first_month date=(p_payload->>'start_month')::date;previous public.garden_bill_terms;new_id uuid=(p_payload->>'term_id')::uuid;begin
  if not public.garden_is_admin() then raise exception 'Only Jeremy can manage records.' using errcode='42501';end if;
  perform 1 from public.garden_fixed_bills where id=p_bill_id for update;
  if not found then raise exception 'The bill no longer exists.' using errcode='23503';end if;
  if exists(select 1 from public.garden_bill_terms where id=new_id and bill_id=p_bill_id) then return;end if;
  select * into previous from public.garden_bill_terms where bill_id=p_bill_id and start_month<=first_month and (end_month is null or end_month>=first_month) for update;
  if found then
    if first_month<=previous.start_month then raise exception 'New terms must start after the previous terms started.' using errcode='23514';end if;
    update public.garden_bill_terms set end_month=(first_month-interval '1 month')::date where id=previous.id;
  end if;
  perform public.garden_save_bill(p_payload,p_bill_id);
end;$$;
revoke all on function public.garden_save_bill(jsonb,uuid),public.garden_revise_bill(jsonb,uuid) from public,anon;
grant execute on function public.garden_save_bill(jsonb,uuid),public.garden_revise_bill(jsonb,uuid) to authenticated;

insert into public.garden_categories(kind,name) values
('income','Court rental'),('income','Open play'),('income','Paddle rental'),('income','Coaching'),
('income','Events / tournaments'),('income','Food & beverages'),('income','Membership'),('income','Other income'),
('expense','Wages'),('expense','Maintenance & repairs'),('expense','Cleaning'),('expense','Supplies'),
('expense','Marketing'),('expense','Utilities'),('expense','Rent'),('expense','Internet'),
('expense','Permits & licenses'),('expense','Equipment'),('expense','Other expenses');

-- Optional realtime; refresh-on-focus and the Refresh button also work without it.
do $$ declare t text;begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts','garden_categories'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end;$$;
