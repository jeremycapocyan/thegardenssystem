-- Effective-dated closing days. Historical periods and finalized snapshots remain intact.
create table public.garden_payroll_cutoffs(
 id uuid primary key default gen_random_uuid(),effective_from date not null unique,
 first_day integer not null check(first_day between 1 and 27),
 second_day integer not null check(second_day>first_day and second_day<=31),
 reason text not null check(length(btrim(reason)) between 1 and 500),created_at timestamptz not null default now()
);
alter table public.garden_payroll_cutoffs enable row level security;
revoke all on public.garden_payroll_cutoffs from public,anon,authenticated;
grant select on public.garden_payroll_cutoffs to authenticated;
create policy cutoff_calendar_read on public.garden_payroll_cutoffs for select to authenticated using(
 public.garden_is_team_admin() or exists(select 1 from public.garden_profiles where id=auth.uid() and active and role='employee')
);
insert into public.garden_payroll_cutoffs(effective_from,first_day,second_day,reason)
 values('2000-01-01',15,31,'Original semi-monthly payroll schedule');
-- Safely choose the first boundary after any already-finalized period.
insert into public.garden_payroll_cutoffs(effective_from,first_day,second_day,reason)
 select greatest(date '2026-11-01',coalesce(max(period_end)+1,date '2026-11-01')),12,28,'Owner requested cutoffs on the 12th and 28th'
 from public.garden_payroll;
create trigger payroll_cutoff_audit after insert on public.garden_payroll_cutoffs for each row execute function public.garden_log_staff_change();

create function public.garden_payroll_bounds(p_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.garden_payroll_cutoffs;m date;last_day integer;n integer;candidate date;previous date;finish date;change_day date;begin
 if p_day is null or p_day not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose a valid payroll date.';end if;
 select * into r from public.garden_payroll_cutoffs where effective_from<=p_day order by effective_from desc limit 1;
 if not found then raise exception 'Payroll schedule unavailable.';end if;
 for m in select generate_series(date_trunc('month',p_day)-interval '1 month',date_trunc('month',p_day)+interval '1 month',interval '1 month')::date loop
  last_day=extract(day from m+interval '1 month'-interval '1 day')::integer;
  foreach n in array array[r.first_day,r.second_day] loop
   candidate=m+least(n,last_day)-1;
   if candidate<p_day and (previous is null or candidate>previous) then previous=candidate;end if;
   if candidate>=p_day and (finish is null or candidate<finish) then finish=candidate;end if;
  end loop;
 end loop;
 select min(effective_from) into change_day from public.garden_payroll_cutoffs where effective_from>p_day;
 return jsonb_build_object('start',greatest(previous+1,r.effective_from),'end',least(finish,coalesce(change_day-1,finish)),
 'first_day',r.first_day,'second_day',r.second_day,'effective_from',r.effective_from);
end;$$;
revoke all on function public.garden_payroll_bounds(date) from public,anon,authenticated;

create function public.garden_change_payroll_cutoffs(p_effective date,p_first integer,p_second integer,p_reason text) returns void
language plpgsql security definer set search_path='' as $$declare bounds jsonb;today date=(now() at time zone 'Asia/Manila')::date;begin
 if not public.garden_is_team_admin() then raise exception 'Employee and payroll management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens_payroll_cutoffs'));
 if p_first is null or p_second is null or p_first not between 1 and 27 or p_second<=p_first or p_second>31 or p_reason is null or length(btrim(p_reason)) not between 1 and 500 then raise exception 'Choose two increasing cutoff days and enter a reason.';end if;
 bounds=public.garden_payroll_bounds(p_effective);
 if p_effective<>(bounds->>'start')::date or p_effective<(public.garden_payroll_bounds(today)->>'start')::date
 or p_effective<=(select max(effective_from) from public.garden_payroll_cutoffs) then raise exception 'Choose the start of a current or future payroll period after the latest schedule version.';end if;
 if exists(select 1 from public.garden_payroll where period_end>=p_effective) then raise exception 'Finalized payroll is locked. Choose a later effective date.';end if;
 insert into public.garden_payroll_cutoffs(effective_from,first_day,second_day,reason) values(p_effective,p_first,p_second,btrim(p_reason));
end;$$;
revoke all on function public.garden_change_payroll_cutoffs(date,integer,integer,text) from public,anon;
grant execute on function public.garden_change_payroll_cutoffs(date,integer,integer,text) to authenticated;

-- Retain the salary math and existing authorization; only replace period boundaries.
do $$declare definition text;old_boundary text;new_boundary text;begin
 definition=pg_get_functiondef('public.garden_payroll_preview(uuid,date)'::regprocedure);
 definition=replace(definition,chr(13),'');
 old_boundary=$old$  if extract(day from p_start) not in (1,16) or p_start is null or p_start not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose the 1st or 16th as the payroll start.';end if;
  finish=case when extract(day from p_start)=1 then p_start+14 else (date_trunc('month',p_start)+interval '1 month'-interval '1 day')::date end;$old$;
 new_boundary=$new$  if p_start is distinct from (public.garden_payroll_bounds(p_start)->>'start')::date then raise exception 'Choose the start of a payroll cutoff period.';end if;
  finish=(public.garden_payroll_bounds(p_start)->>'end')::date;$new$;
 if position(old_boundary in definition)=0 then raise exception 'Existing payroll boundary definition not recognized.';end if;
 execute replace(definition,old_boundary,new_boundary);
 definition=pg_get_functiondef('public.garden_team_snapshot()'::regprocedure);
 execute replace(definition,'''employees'',coalesce(','''cutoff_rules'',coalesce((select jsonb_agg(to_jsonb(t) order by effective_from) from public.garden_payroll_cutoffs t),''[]''),''employees'',coalesce(');
 definition=pg_get_functiondef('public.garden_team_command(text,jsonb)'::regprocedure);
 execute replace(definition,'  if p_action not in (',$lock$  if p_action='finalize' then perform pg_advisory_xact_lock_shared(hashtext('gardens_payroll_cutoffs'));end if;
  if p_action not in ($lock$);
 definition=pg_get_functiondef('public.garden_timesheet_report(date,date,uuid)'::regprocedure);
 definition=replace(definition,'cutoff=date_trunc(''month'',p_start)::date+case when extract(day from p_start)>15 then 15 else 0 end;',
 'cutoff=(public.garden_payroll_bounds(p_start)->>''start'')::date;');
 definition=replace(definition,'next_cutoff=case when extract(day from cutoff)=1 then cutoff+15 else (date_trunc(''month'',cutoff)+interval ''1 month'')::date end;',
 'next_cutoff=(public.garden_payroll_bounds(cutoff)->>''end'')::date+1;');
 execute definition;
end;$$;
-- A final invariant prevents any overlapping salary statements for an employee.
alter table public.garden_payroll add constraint garden_payroll_valid_dates check(period_end>=period_start);
alter table public.garden_payroll add constraint garden_payroll_no_overlap exclude using gist(employee_id with =,daterange(period_start,period_end,'[]') with &&);

create function public.garden_payroll_cutoff_summary(p_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare bounds jsonb;finish date;e public.garden_employees;p public.garden_payroll;preview jsonb;
 people jsonb='[]';row_data jsonb;sums jsonb;paid bigint;gross bigint;recovery bigint;payable bigint;begin
 if not public.garden_is_team_admin() then raise exception 'Employee and payroll management permission required.' using errcode='42501';end if;
 bounds=public.garden_payroll_bounds(p_start);finish=(bounds->>'end')::date;
 if p_start is distinct from (bounds->>'start')::date then raise exception 'Choose the start of a payroll cutoff period.';end if;
 for e in select * from public.garden_employees where (started_on<=finish and (ended_on is null or ended_on>=p_start))
 or exists(select 1 from public.garden_payroll where employee_id=garden_employees.id and period_start=p_start) order by name,id loop
  select * into p from public.garden_payroll where employee_id=e.id and period_start=p_start;
  preview=case when p.id is not null then p.snapshot else public.garden_payroll_preview(e.id,p_start) end;
  gross=case when p.id is not null then p.gross_cents else (preview->>'gross_cents')::bigint end;
  recovery=case when p.id is not null then p.recovery_cents else (preview->>'recovery_cents')::bigint end;
  payable=gross-recovery;
  select coalesce(sum(amount_cents),0) into paid from public.garden_staff_cash where kind='salary' and payroll_id=p.id;
  row_data=jsonb_build_object('employee_id',e.id,'name',e.name,'employee_code',e.employee_code,'active',e.active,
   'finalized',p.id is not null,'blockers',case when p.id is not null then '[]'::jsonb else preview->'blockers' end,
   'gross_cents',gross,'recovery_cents',recovery,'payable_cents',payable,'paid_cents',paid,'balance_cents',payable-paid);
  people=people||jsonb_build_array(row_data);
 end loop;
 select jsonb_build_object('gross_cents',coalesce(sum((value->>'gross_cents')::bigint),0),
 'recovery_cents',coalesce(sum((value->>'recovery_cents')::bigint),0),'payable_cents',coalesce(sum((value->>'payable_cents')::bigint),0),
 'paid_cents',coalesce(sum((value->>'paid_cents')::bigint),0),'balance_cents',coalesce(sum((value->>'balance_cents')::bigint),0),
 'finalized_payable_cents',coalesce(sum(case when (value->>'finalized')::boolean then (value->>'payable_cents')::bigint else 0 end),0),
 'finalized_count',count(*) filter(where (value->>'finalized')::boolean),'draft_count',count(*) filter(where not (value->>'finalized')::boolean)) into sums from jsonb_array_elements(people);
 return jsonb_build_object('start',p_start,'end',finish,'employees',people,'totals',sums);
end;$$;
revoke all on function public.garden_payroll_cutoff_summary(date) from public,anon;
grant execute on function public.garden_payroll_cutoff_summary(date) to authenticated;
notify pgrst,'reload schema';
