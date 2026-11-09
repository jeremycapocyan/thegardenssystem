-- Employee membership must never inherit the owners' finance permissions.
alter table public.garden_profiles drop constraint garden_profiles_role_check;
alter table public.garden_profiles add constraint garden_profiles_role_check check(role in ('admin','viewer','employee'));
create or replace function public.garden_is_member() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.garden_profiles where id=auth.uid() and role in ('admin','viewer'));
$$;

create table public.garden_employees (
  id uuid primary key default gen_random_uuid(), profile_id uuid unique references auth.users(id),
  name text not null check(length(btrim(name)) between 1 and 100),
  email text not null check(length(email) between 3 and 254),
  started_on date not null check(started_on between date '2000-01-01' and date '2100-12-31'),
  ended_on date check(ended_on>=started_on), active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index garden_employee_email on public.garden_employees(lower(email));
create table public.garden_employee_schedules (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  effective_from date not null, weekdays integer[] not null check(weekdays <@ array[0,1,2,3,4,5,6]),
  unique(employee_id,effective_from)
);
create table public.garden_schedule_overrides (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  work_date date not null, working boolean not null, reason text not null check(length(btrim(reason)) between 1 and 1000),
  unique(employee_id,work_date)
);
create table public.garden_court_qr (
  id uuid primary key default gen_random_uuid(),active boolean not null default true,created_at timestamptz not null default now()
);
create unique index garden_one_active_qr on public.garden_court_qr(active) where active;
insert into public.garden_court_qr default values;
create table public.garden_attendance (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  work_date date not null,clock_in timestamptz not null,clock_out timestamptz check(clock_out>=clock_in),
  approved_ot_seconds numeric check(approved_ot_seconds>=0),ot_reviewed boolean not null default false,
  correction_reason text not null default '' check(length(correction_reason)<=1000),voided boolean not null default false
);
create unique index garden_active_attendance_day on public.garden_attendance(employee_id,work_date) where not voided;
create unique index garden_one_open_session on public.garden_attendance(employee_id) where clock_out is null and not voided;
create table public.garden_attendance_events (
  id uuid primary key,employee_id uuid not null references public.garden_employees,
  attendance_id uuid not null references public.garden_attendance,action text not null check(action in ('clock_in','clock_out')),
  occurred_at timestamptz not null default now()
);
create table public.garden_staff_requests (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  kind text not null check(kind in ('leave','sick','advance')),
  start_date date,end_date date,amount_cents bigint,
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  status text not null default 'pending' check(status in ('pending','approved','rejected','withdrawn')),
  paid_leave boolean,decision_note text not null default '' check(length(decision_note)<=1000),
  created_at timestamptz not null default now(),decided_at timestamptz,
  check((kind='advance' and amount_cents is not null and amount_cents between 1 and 999999999 and start_date is null and end_date is null and paid_leave is null)
    or (kind in ('leave','sick') and start_date is not null and end_date is not null and end_date between start_date and start_date+366 and amount_cents is null)),
  check(kind='advance' or status<>'approved' or paid_leave is not null)
);
create table public.garden_payroll (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  period_start date not null,period_end date not null,
  snapshot jsonb not null,gross_cents bigint not null check(gross_cents>=0),
  recovery_cents bigint not null check(recovery_cents between 0 and gross_cents),
  payable_cents bigint not null check(payable_cents=gross_cents-recovery_cents),
  finalized_at timestamptz not null default now(),unique(employee_id,period_start)
);
create table public.garden_staff_cash (
  id uuid primary key,employee_id uuid not null references public.garden_employees,
  kind text not null check(kind in ('advance','salary')),
  request_id uuid references public.garden_staff_requests,payroll_id uuid references public.garden_payroll,
  amount_cents bigint not null check(amount_cents between 1 and 999999999),
  paid_on date not null check(paid_on between date '2000-01-01' and date '2100-12-31'),
  reference text not null default '' check(length(reference)<=120),created_at timestamptz not null default now(),
  check((kind='advance' and request_id is not null and payroll_id is null) or (kind='salary' and payroll_id is not null and request_id is null))
);
create table public.garden_advance_recoveries (
  id uuid primary key default gen_random_uuid(),employee_id uuid not null references public.garden_employees,
  cash_id uuid not null references public.garden_staff_cash,payroll_id uuid not null references public.garden_payroll,
  amount_cents bigint not null check(amount_cents>0),unique(cash_id,payroll_id)
);
create table public.garden_staff_settings (
  id boolean primary key default true check(id),wages_category_id uuid not null references public.garden_categories
);
insert into public.garden_categories(kind,name) values('expense','Wages') on conflict do nothing;
insert into public.garden_staff_settings(wages_category_id) select id from public.garden_categories where kind='expense' and lower(btrim(name))='wages' limit 1;
alter table public.garden_expenses add column staff_payment_id uuid unique references public.garden_staff_cash;
create index garden_staff_cash_employee on public.garden_staff_cash(employee_id,paid_on);
create index garden_requests_employee on public.garden_staff_requests(employee_id,status);
create index garden_attendance_date on public.garden_attendance(work_date);

create function public.garden_own_employee(p_employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.garden_employees where id=p_employee and profile_id=auth.uid());
$$;
revoke all on function public.garden_own_employee(uuid) from public,anon;
grant execute on function public.garden_own_employee(uuid) to authenticated;
alter table public.garden_employees enable row level security;
revoke all on public.garden_employees from public,anon,authenticated;
grant select on public.garden_employees to authenticated;
create policy staff_employee_read on public.garden_employees for select to authenticated using(public.garden_is_admin() or profile_id=auth.uid());
create function public.garden_log_staff_change() returns trigger language plpgsql security definer set search_path='' as $$
declare before_json jsonb;after_json jsonb;key text;begin
  if tg_op<>'INSERT' then before_json=to_jsonb(old);end if;
  if tg_op<>'DELETE' then after_json=to_jsonb(new);end if;
  key=coalesce(after_json,before_json)->>'id';
  insert into public.garden_audit(record_id,table_name,action,before_record,after_record,actor_id)
  values(case when key ~ '^[a-fA-F0-9-]{36}$' then key::uuid else null end,tg_table_name,tg_op,before_json,after_json,auth.uid());return null;
end;$$;
revoke all on function public.garden_log_staff_change() from public,anon,authenticated;
do $$ declare t text;begin
  foreach t in array array['garden_employee_schedules','garden_schedule_overrides','garden_attendance','garden_attendance_events','garden_staff_requests','garden_payroll','garden_staff_cash','garden_advance_recoveries'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy staff_own_read on public.%I for select to authenticated using(public.garden_is_admin() or public.garden_own_employee(employee_id))',t);
  end loop;
  foreach t in array array['garden_court_qr','garden_staff_settings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy staff_admin_read on public.%I for select to authenticated using(public.garden_is_admin())',t);
  end loop;
  foreach t in array array['garden_employees','garden_employee_schedules','garden_schedule_overrides','garden_court_qr','garden_attendance','garden_attendance_events','garden_staff_requests','garden_payroll','garden_staff_cash','garden_advance_recoveries','garden_staff_settings'] loop
    execute format('create trigger staff_audit after insert or update or delete on public.%I for each row execute function public.garden_log_staff_change()',t);
  end loop;
end;$$;

-- Linked cash expenses are immutable and may only be created by the trusted command.
create function public.garden_guard_staff_expense() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op<>'INSERT' and old.staff_payment_id is not null then raise exception 'Payroll-linked payments cannot be edited or deleted from Expenses.' using errcode='23514';end if;
  if tg_op<>'DELETE' and new.staff_payment_id is not null then
    if tg_op<>'INSERT' or current_user<>(select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc where oid='public.garden_team_command(text,jsonb)'::regprocedure) then
      raise exception 'Record this payment in Payroll or Salary Advances.' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke all on function public.garden_guard_staff_expense() from public,anon,authenticated;
create trigger guard_staff_expense before insert or update or delete on public.garden_expenses for each row execute function public.garden_guard_staff_expense();

create function public.garden_staff_working(p_employee uuid,p_day date) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((select o.working from public.garden_schedule_overrides o where o.employee_id=p_employee and o.work_date=p_day),
    (select extract(dow from p_day)::integer=any(s.weekdays) from public.garden_employee_schedules s where s.employee_id=p_employee and s.effective_from<=p_day order by s.effective_from desc limit 1),false)
    and exists(select 1 from public.garden_employees e where e.id=p_employee and p_day>=e.started_on and (e.ended_on is null or p_day<=e.ended_on));
$$;
revoke all on function public.garden_staff_working(uuid,date) from public,anon,authenticated;

create function public.garden_payroll_preview(p_employee uuid,p_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare finish date;d date;a public.garden_attendance;r public.garden_staff_requests;working boolean;
  shift_start timestamptz;shift_end timestamptz;regular_seconds numeric;ot_seconds numeric;approved numeric;
  deduction bigint;regular bigint;ot bigint;leave_pay bigint;gross bigint=0;deductions bigint=0;regular_total bigint=0;ot_total bigint=0;leave_total bigint=0;
  days jsonb='[]';blockers jsonb='[]';day_status text;released bigint;recovered bigint;balance bigint;recovery bigint;
begin
  if not (public.garden_is_admin() or public.garden_own_employee(p_employee)) then raise exception 'Employee records are private.' using errcode='42501';end if;
  if extract(day from p_start) not in (1,16) or p_start is null or p_start not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose the 1st or 16th as the payroll start.';end if;
  finish=case when extract(day from p_start)=1 then p_start+14 else (date_trunc('month',p_start)+interval '1 month'-interval '1 day')::date end;
  if not exists(select 1 from public.garden_employees where id=p_employee) then raise exception 'Employee not found.';end if;
  if exists(select 1 from public.garden_employees e where e.id=p_employee and e.started_on<=finish and not exists(select 1 from public.garden_employee_schedules s where s.employee_id=e.id and s.effective_from<=greatest(e.started_on,p_start))) then
    blockers=blockers||jsonb_build_array('Add an effective weekly work schedule.');
  end if;
  for d in select generate_series(p_start,finish,interval '1 day')::date loop
    working=public.garden_staff_working(p_employee,d);
    shift_start=(d+time '15:30') at time zone 'Asia/Manila';shift_end=(d+time '23:30') at time zone 'Asia/Manila';
    select * into a from public.garden_attendance where employee_id=p_employee and work_date=d and not voided;
    select * into r from public.garden_staff_requests where employee_id=p_employee and kind in ('leave','sick') and status='approved' and d between start_date and end_date order by created_at limit 1;
    regular_seconds=0;ot_seconds=0;approved=0;deduction=0;regular=0;ot=0;leave_pay=0;
    day_status=case when working then 'Upcoming' else 'Rest day' end;
    if working and shift_end>now() then blockers=blockers||jsonb_build_array(d||': scheduled shift has not finished.');end if;
    if a.id is not null and not working then day_status='Unscheduled work';blockers=blockers||jsonb_build_array(d||': add a workday override or correct this punch.');end if;
    if a.id is not null and r.id is not null and working then day_status='Leave conflict';blockers=blockers||jsonb_build_array(d||': approved leave overlaps attendance.');
    elsif a.id is not null and working then
      if a.clock_out is null then day_status=case when shift_end>now() then 'Timed in' else 'Missing time out' end;blockers=blockers||jsonb_build_array(d||': attendance is still open.');
      else
        regular_seconds=greatest(0,extract(epoch from least(a.clock_out,shift_end)-greatest(a.clock_in,shift_start)));
        regular_seconds=least(28800,regular_seconds);deduction=round(65000::numeric*(28800-regular_seconds)/28800);
        regular=65000-deduction;ot_seconds=greatest(0,extract(epoch from a.clock_out-greatest(a.clock_in,shift_end)));
        approved=least(ot_seconds,coalesce(a.approved_ot_seconds,0));ot=round(65000::numeric*approved/28800);
        if ot_seconds>0 and not a.ot_reviewed then blockers=blockers||jsonb_build_array(d||': overtime needs approval or rejection.');end if;
        day_status=case when a.clock_in>shift_start and a.clock_out<shift_end then 'Late / undertime' when a.clock_in>shift_start then 'Late' when a.clock_out<shift_end then 'Undertime' else 'Present' end;
      end if;
    elsif working and r.id is not null then
      leave_pay=case when r.paid_leave then 65000 else 0 end;
      day_status=case when r.kind='sick' then 'Sick leave' else 'Leave' end||case when r.paid_leave then ' · paid' else ' · unpaid' end;
    elsif working and shift_end<=now() then day_status='Absent';deduction=65000;
    end if;
    if working and exists(select 1 from public.garden_staff_requests where employee_id=p_employee and kind in ('leave','sick') and status='pending' and d between start_date and end_date) then blockers=blockers||jsonb_build_array(d||': pending leave request.');end if;
    gross=gross+regular+ot+leave_pay;regular_total=regular_total+regular;ot_total=ot_total+ot;leave_total=leave_total+leave_pay;deductions=deductions+deduction;
    days=days||jsonb_build_array(jsonb_build_object('date',d,'status',day_status,'scheduled',working,'attendance_id',a.id,'clock_in',a.clock_in,'clock_out',a.clock_out,
      'late_seconds',case when a.id is not null and working then greatest(0,extract(epoch from a.clock_in-shift_start)) else 0 end,
      'undertime_seconds',case when a.clock_out is not null and working then greatest(0,extract(epoch from shift_end-a.clock_out)) else 0 end,
      'regular_seconds',regular_seconds,'overtime_seconds',ot_seconds,'approved_ot_seconds',approved,'ot_reviewed',a.ot_reviewed,
      'deduction_cents',deduction,'regular_cents',regular,'ot_cents',ot,'leave_cents',leave_pay,'total_cents',regular+ot+leave_pay));
  end loop;
  select coalesce(sum(amount_cents),0) into released from public.garden_staff_cash where employee_id=p_employee and kind='advance';
  select coalesce(sum(amount_cents),0) into recovered from public.garden_advance_recoveries where employee_id=p_employee;
  balance=greatest(0,released-recovered);recovery=least(gross,balance);
  return jsonb_build_object('employee_id',p_employee,'period_start',p_start,'period_end',finish,'days',days,'blockers',blockers,
    'regular_cents',regular_total,'deduction_cents',deductions,'ot_cents',ot_total,'leave_cents',leave_total,'gross_cents',gross,
    'advance_balance_cents',balance,'recovery_cents',recovery,'payable_cents',gross-recovery,'daily_cents',65000,'hourly_cents',8125);
end;$$;
revoke all on function public.garden_payroll_preview(uuid,date) from public,anon;
grant execute on function public.garden_payroll_preview(uuid,date) to authenticated;

create function public.garden_team_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'employees',coalesce((select jsonb_agg(to_jsonb(t) order by name) from public.garden_employees t),'[]'),
    'schedules',coalesce((select jsonb_agg(to_jsonb(t) order by effective_from) from public.garden_employee_schedules t),'[]'),
    'overrides',coalesce((select jsonb_agg(to_jsonb(t)) from public.garden_schedule_overrides t),'[]'),
    'attendance',coalesce((select jsonb_agg(to_jsonb(t) order by work_date desc) from public.garden_attendance t where not voided),'[]'),
    'requests',coalesce((select jsonb_agg(to_jsonb(t) order by created_at desc) from public.garden_staff_requests t),'[]'),
    'payroll',coalesce((select jsonb_agg(to_jsonb(t) order by period_start desc) from public.garden_payroll t),'[]'),
    'cash',coalesce((select jsonb_agg(to_jsonb(t) order by paid_on desc,created_at) from public.garden_staff_cash t),'[]'),
    'recoveries',coalesce((select jsonb_agg(to_jsonb(t)) from public.garden_advance_recoveries t),'[]'),
    'qr',case when public.garden_is_admin() then (select to_jsonb(t) from public.garden_court_qr t where active) else null end,
    'settings',(select to_jsonb(t) from public.garden_staff_settings t));
$$;
revoke all on function public.garden_team_snapshot() from public,anon;
grant execute on function public.garden_team_snapshot() to authenticated;

-- All mutations lock the employee row, serializing attendance, approvals and payroll.
create function public.garden_team_command(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare admin boolean=public.garden_is_admin();actor uuid=auth.uid();eid uuid;rid uuid;pid uuid;cid uuid;
  e public.garden_employees;a public.garden_attendance;r public.garden_staff_requests;pr public.garden_payroll;c public.garden_staff_cash;
  stamp timestamptz=clock_timestamp();today date=(clock_timestamp() at time zone 'Asia/Manila')::date;
  day date;start_day date;end_day date;qty bigint;used bigint;remaining bigint;take_amount bigint;preview jsonb;
  cat uuid;week integer[];working boolean;profile_role text;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501';end if;
  if p_action not in ('clock_in','clock_out','request','withdraw') and not admin then raise exception 'Only Jeremy can manage employee records.' using errcode='42501';end if;
  if p_action='qr' then
    update public.garden_court_qr set active=false where active;
    insert into public.garden_court_qr default values returning id into cid;return jsonb_build_object('id',cid);
  elsif p_action='settings' then
    cat=(p_payload->>'category_id')::uuid;
    if not exists(select 1 from public.garden_categories where id=cat and kind='expense' and active) then raise exception 'Choose an active expense category.';end if;
    update public.garden_staff_settings set wages_category_id=cat;return '{}'::jsonb;
  end if;
  eid=nullif(p_payload->>'employee_id','')::uuid;
  rid=nullif(p_payload->>'request_id','')::uuid;pid=nullif(p_payload->>'payroll_id','')::uuid;
  if p_action in ('clock_in','clock_out','request','withdraw') then
    select id into eid from public.garden_employees where profile_id=actor;
  elsif rid is not null then select employee_id into eid from public.garden_staff_requests where id=rid;
  elsif pid is not null then select employee_id into eid from public.garden_payroll where id=pid;
  end if;
  if p_action='employee' and eid is null then eid=(p_payload->>'id')::uuid;end if;
  -- Advisory lock also covers a not-yet-created employee.
  if eid is null then raise exception 'Select an employee.';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(eid::text));
  select * into e from public.garden_employees where id=eid for update;
  if p_action='employee' then
    week=array(select jsonb_array_elements_text(p_payload->'weekdays')::integer);
    start_day=(p_payload->>'effective_from')::date;day=(p_payload->>'started_on')::date;
    if start_day is null or not week <@ array[0,1,2,3,4,5,6] then raise exception 'Choose valid working days and an effective date.';end if;
    if exists(select 1 from public.garden_payroll where employee_id=eid and (period_end>=start_day or (e.id is not null and day<>e.started_on))) then raise exception 'Finalized payroll is locked. Apply schedule changes after its end date.';end if;
    insert into public.garden_employees(id,name,email,started_on,ended_on,active)
    values(eid,btrim(p_payload->>'name'),lower(btrim(p_payload->>'email')),day,case when coalesce((p_payload->>'active')::boolean,true)=false then coalesce(nullif(p_payload->>'ended_on','')::date,greatest(day,today)) else nullif(p_payload->>'ended_on','')::date end,coalesce((p_payload->>'active')::boolean,true))
    on conflict(id) do update set name=excluded.name,email=case when garden_employees.profile_id is null then excluded.email else garden_employees.email end,started_on=excluded.started_on,ended_on=excluded.ended_on,active=excluded.active;
    insert into public.garden_employee_schedules(employee_id,effective_from,weekdays) values(eid,start_day,week)
    on conflict(employee_id,effective_from) do update set weekdays=excluded.weekdays;
    return jsonb_build_object('id',eid);
  end if;
  if e.id is null then raise exception 'Employee not found.';end if;
  if not admin and (e.profile_id is distinct from actor or not e.active) then raise exception 'Your employee account is inactive or unavailable.' using errcode='42501';end if;
  if p_action in ('clock_in','clock_out') then
    cid=(p_payload->>'id')::uuid;
    if exists(select 1 from public.garden_attendance_events where id=cid and employee_id=eid and action=p_action) then return jsonb_build_object('saved',true);end if;
    if not exists(select 1 from public.garden_court_qr where id=(p_payload->>'qr')::uuid and active) then raise exception 'This court QR is no longer valid. Scan the current printed code.';end if;
    select * into a from public.garden_attendance where employee_id=eid and clock_out is null and not voided for update;
    if p_action='clock_in' then
      if a.id is not null then raise exception 'You are already timed in.';end if;
      if today<e.started_on or (e.ended_on is not null and today>e.ended_on) then raise exception 'This date is outside your employment dates.';end if;
      if exists(select 1 from public.garden_payroll where employee_id=eid and today between period_start and period_end) then raise exception 'This payroll period is finalized.';end if;
      insert into public.garden_attendance(employee_id,work_date,clock_in) values(eid,today,stamp) returning * into a;
    else
      if a.id is null then raise exception 'You have no open time-in. Refresh your attendance.';end if;
      if stamp<a.clock_in+interval '60 seconds' then raise exception 'Time in was just recorded. Wait one minute before timing out.';end if;
      update public.garden_attendance set clock_out=stamp where id=a.id;
    end if;
    insert into public.garden_attendance_events(id,employee_id,attendance_id,action,occurred_at) values(cid,eid,a.id,p_action,stamp);
    return jsonb_build_object('saved',true,'at',stamp);
  elsif p_action='request' then
    rid=(p_payload->>'id')::uuid;
    if exists(select 1 from public.garden_staff_requests where id=rid and employee_id=eid) then return jsonb_build_object('id',rid);end if;
    start_day=nullif(p_payload->>'start_date','')::date;end_day=nullif(p_payload->>'end_date','')::date;
    if exists(select 1 from public.garden_payroll where employee_id=eid and start_day<=period_end and end_day>=period_start) then raise exception 'A finalized payroll period cannot receive new leave requests.';end if;
    insert into public.garden_staff_requests(id,employee_id,kind,start_date,end_date,amount_cents,reason)
    values(rid,eid,p_payload->>'kind',start_day,end_day,nullif(p_payload->>'amount_cents','')::bigint,btrim(p_payload->>'reason'));
  elsif p_action='withdraw' then
    update public.garden_staff_requests set status='withdrawn' where id=rid and employee_id=eid and status='pending';
    if not found then raise exception 'Only your pending requests can be withdrawn.';end if;
  elsif p_action in ('decide','cancel_leave') then
    select * into r from public.garden_staff_requests where id=rid for update;
    if (p_action='decide' and r.status<>'pending') or (p_action='cancel_leave' and (r.status<>'approved' or r.kind='advance')) then raise exception 'This request has already been resolved.';end if;
    if r.kind<>'advance' and exists(select 1 from public.garden_payroll where employee_id=eid and r.start_date<=period_end and r.end_date>=period_start) then raise exception 'Finalized payroll is locked.';end if;
    if p_action='cancel_leave' and length(btrim(coalesce(p_payload->>'note','')))=0 then raise exception 'Enter the cancellation reason.';end if;
    if p_action='decide' and p_payload->>'status' not in ('approved','rejected') then raise exception 'Choose approve or reject.';end if;
    if p_payload->>'status'='approved' and r.kind<>'advance' and exists(select 1 from public.garden_staff_requests where employee_id=eid and id<>rid and kind in ('leave','sick') and status='approved' and start_date<=r.end_date and end_date>=r.start_date) then raise exception 'Approved leave requests cannot overlap.';end if;
    update public.garden_staff_requests set status=case when p_action='cancel_leave' then 'withdrawn' else p_payload->>'status' end,
      paid_leave=case when kind='advance' then null else (p_payload->>'paid_leave')::boolean end,
      decision_note=coalesce(p_payload->>'note',''),decided_at=stamp where id=rid;
  elsif p_action='override' then
    day=(p_payload->>'date')::date;
    if exists(select 1 from public.garden_payroll where employee_id=eid and day between period_start and period_end) then raise exception 'Finalized payroll is locked.';end if;
    insert into public.garden_schedule_overrides(employee_id,work_date,working,reason) values(eid,day,(p_payload->>'working')::boolean,btrim(p_payload->>'reason'))
    on conflict(employee_id,work_date) do update set working=excluded.working,reason=excluded.reason;
  elsif p_action='correct' then
    day=(p_payload->>'date')::date;
    if exists(select 1 from public.garden_payroll where employee_id=eid and day between period_start and period_end) then raise exception 'Finalized payroll is locked.';end if;
    if length(btrim(coalesce(p_payload->>'reason','')))=0 then raise exception 'Enter a correction reason.';end if;
    if (p_payload->>'clock_in')::timestamptz>stamp or nullif(p_payload->>'clock_out','')::timestamptz>stamp then raise exception 'Attendance corrections cannot be in the future.';end if;
    if (((p_payload->>'clock_in')::timestamptz at time zone 'Asia/Manila')::date<>day) then raise exception 'Time in must belong to the selected Manila work date.';end if;
    insert into public.garden_attendance(employee_id,work_date,clock_in,clock_out,correction_reason)
    values(eid,day,(p_payload->>'clock_in')::timestamptz,nullif(p_payload->>'clock_out','')::timestamptz,btrim(p_payload->>'reason'))
    on conflict(employee_id,work_date) where not voided do update set clock_in=excluded.clock_in,clock_out=excluded.clock_out,correction_reason=excluded.correction_reason,approved_ot_seconds=null,ot_reviewed=false;
  elsif p_action='void' then
    select * into a from public.garden_attendance where id=(p_payload->>'attendance_id')::uuid and employee_id=eid and not voided;
    if a.id is null then raise exception 'Attendance not found.';end if;
    if exists(select 1 from public.garden_payroll where employee_id=eid and a.work_date between period_start and period_end) then raise exception 'Finalized payroll is locked.';end if;
    if length(btrim(coalesce(p_payload->>'reason','')))=0 then raise exception 'Enter a correction reason.';end if;
    update public.garden_attendance set voided=true,correction_reason=btrim(p_payload->>'reason') where id=a.id;
  elsif p_action='overtime' then
    select * into a from public.garden_attendance where id=(p_payload->>'attendance_id')::uuid and employee_id=eid;
    if a.clock_out is null then raise exception 'Complete attendance before reviewing overtime.';end if;
    if exists(select 1 from public.garden_payroll where employee_id=eid and a.work_date between period_start and period_end) then raise exception 'Finalized payroll is locked.';end if;
    if (p_payload->>'seconds')::numeric<0 or (p_payload->>'seconds')::numeric>greatest(0,extract(epoch from a.clock_out-greatest(a.clock_in,(a.work_date+time '23:30') at time zone 'Asia/Manila'))) then raise exception 'Approved overtime cannot exceed recorded overtime.';end if;
    update public.garden_attendance set approved_ot_seconds=(p_payload->>'seconds')::numeric,ot_reviewed=true where id=a.id;
  elsif p_action='finalize' then
    start_day=(p_payload->>'period_start')::date;
    select * into pr from public.garden_payroll where employee_id=eid and period_start=start_day;
    if pr.id is not null then return to_jsonb(pr);end if;
    preview=public.garden_payroll_preview(eid,start_day);
    if jsonb_array_length(preview->'blockers')>0 then raise exception 'Resolve all attendance, schedule and approval issues before finalizing.';end if;
    insert into public.garden_payroll(employee_id,period_start,period_end,snapshot,gross_cents,recovery_cents,payable_cents)
    values(eid,start_day,(preview->>'period_end')::date,preview,(preview->>'gross_cents')::bigint,(preview->>'recovery_cents')::bigint,(preview->>'payable_cents')::bigint) returning * into pr;
    remaining=pr.recovery_cents;
    for c in select * from public.garden_staff_cash where employee_id=eid and kind='advance' order by paid_on,created_at,id for update loop
      select coalesce(sum(amount_cents),0) into used from public.garden_advance_recoveries where cash_id=c.id;
      take_amount=least(remaining,c.amount_cents-used);
      if take_amount>0 then insert into public.garden_advance_recoveries(employee_id,cash_id,payroll_id,amount_cents) values(eid,c.id,pr.id,take_amount);remaining=remaining-take_amount;end if;
      exit when remaining=0;
    end loop;
    return to_jsonb(pr);
  elsif p_action in ('release','pay') then
    cid=(p_payload->>'id')::uuid;qty=(p_payload->>'amount_cents')::bigint;day=(p_payload->>'paid_on')::date;
    select * into c from public.garden_staff_cash where id=cid;
    if c.id is not null then
      if c.employee_id<>eid or c.amount_cents<>qty or c.paid_on<>day or c.request_id is distinct from rid or c.payroll_id is distinct from pid then raise exception 'Payment reference was already used for different details.';end if;
      return to_jsonb(c);
    end if;
    if day>today then raise exception 'Record actual payments on or before today.';end if;
    if p_action='release' then
      select * into r from public.garden_staff_requests where id=rid and employee_id=eid and kind='advance' and status='approved';
      if r.id is null then raise exception 'Approve the advance request before releasing cash.';end if;
      select coalesce(sum(amount_cents),0) into used from public.garden_staff_cash where request_id=rid;
      remaining=r.amount_cents-used;
    else
      select * into pr from public.garden_payroll where id=pid and employee_id=eid;
      if pr.id is null then raise exception 'Finalize payroll before recording a salary payment.';end if;
      select coalesce(sum(amount_cents),0) into used from public.garden_staff_cash where payroll_id=pid;
      remaining=pr.payable_cents-used;
    end if;
    if qty is null or qty<=0 or qty>remaining then raise exception 'Payment must be positive and cannot exceed the remaining amount.';end if;
    select wages_category_id into cat from public.garden_staff_settings;
    insert into public.garden_staff_cash(id,employee_id,kind,request_id,payroll_id,amount_cents,paid_on,reference)
    values(cid,eid,case when p_action='release' then 'advance' else 'salary' end,rid,pid,qty,day,coalesce(p_payload->>'reference','')) returning * into c;
    insert into public.garden_expenses(paid_on,category_id,payment_kind,amount_cents,reference,notes,staff_payment_id)
    values(day,cat,'operating',qty,c.reference,case when p_action='release' then 'Employee salary advance' else 'Payroll settlement '||pr.period_start||' to '||pr.period_end end,cid);
    return to_jsonb(c);
  else raise exception 'Unknown employee action.';
  end if;
  return jsonb_build_object('saved',true);
end;$$;
revoke all on function public.garden_team_command(text,jsonb) from public,anon;
grant execute on function public.garden_team_command(text,jsonb) to authenticated;

-- Binding an invited account is service-only; no client can grant a role.
create function public.garden_bind_employee(p_employee uuid,p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
declare e public.garden_employees;role_name text;begin
  select * into e from public.garden_employees where id=p_employee for update;
  if e.id is null then raise exception 'Employee not found.';end if;
  select role into role_name from public.garden_profiles where id=p_user;
  if role_name is not null and role_name<>'employee' then raise exception 'This account already belongs to an owner or administrator.';end if;
  if e.profile_id is not null and e.profile_id<>p_user then raise exception 'Employee account is already linked.';end if;
  insert into public.garden_profiles(id,display_name,role) values(p_user,e.name,'employee') on conflict(id) do update set display_name=excluded.display_name;
  update public.garden_employees set profile_id=p_user where id=p_employee;
end;$$;
revoke all on function public.garden_bind_employee(uuid,uuid) from public,anon,authenticated;
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.garden_bind_employee(uuid,uuid) to service_role;end if;end;$$;
notify pgrst,'reload schema';
