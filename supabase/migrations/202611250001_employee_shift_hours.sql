-- Effective-dated employee shift hours. Existing schedules retain their original hours.
-- No attendance, finalized payroll, payments or finance entries are rewritten.
alter table public.garden_employee_schedules
 add column start_time time without time zone not null default time '15:30',
 add column end_time time without time zone not null default time '23:30',
 add constraint garden_employee_shift_hours check (
   start_time < end_time and end_time < time '24:00'
   and extract(second from start_time)=0 and extract(second from end_time)=0
 );

-- Internal helper: employees cannot query schedule history through this function.
create function public.garden_staff_shift(p_employee uuid,p_day date)
 returns table(start_time time without time zone,end_time time without time zone)
 language sql stable security definer set search_path='' as $$
 select coalesce(s.start_time,time '15:30'),coalesce(s.end_time,time '23:30')
 from (select 1) seed left join lateral (
  select t.start_time,t.end_time from public.garden_employee_schedules t
  where t.employee_id=p_employee and t.effective_from<=p_day order by t.effective_from desc limit 1
 ) s on true;
$$;
revoke all on function public.garden_staff_shift(uuid,date) from public,anon,authenticated;

create or replace function public.garden_payroll_preview(p_employee uuid,p_start date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare finish date;d date;a public.garden_attendance;r public.garden_staff_requests;working boolean;
  shift_start timestamptz;shift_end timestamptz;regular_seconds numeric;ot_seconds numeric;approved numeric;
  deduction bigint;regular bigint;ot bigint;leave_pay bigint;gross bigint=0;deductions bigint=0;regular_total bigint=0;ot_total bigint=0;leave_total bigint=0;
  scheduled_from time;scheduled_to time;scheduled_seconds numeric;scheduled_pay bigint;
  days jsonb='[]';blockers jsonb='[]';day_status text;released bigint;recovered bigint;balance bigint;recovery bigint;
begin
  if not (public.garden_is_team_admin() or public.garden_own_employee(p_employee)) then raise exception 'Employee records are private.' using errcode='42501';end if;
  if p_start is distinct from (public.garden_payroll_bounds(p_start)->>'start')::date then raise exception 'Choose the start of a payroll cutoff period.';end if;
  finish=(public.garden_payroll_bounds(p_start)->>'end')::date;
  if not exists(select 1 from public.garden_employees where id=p_employee) then raise exception 'Employee not found.';end if;
  if exists(select 1 from public.garden_employees e where e.id=p_employee and e.started_on<=finish and not exists(select 1 from public.garden_employee_schedules s where s.employee_id=e.id and s.effective_from<=greatest(e.started_on,p_start))) then
    blockers=blockers||jsonb_build_array('Add an effective weekly work schedule.');
  end if;
  for d in select generate_series(p_start,finish,interval '1 day')::date loop
    working=public.garden_staff_working(p_employee,d);
    select s.start_time,s.end_time into scheduled_from,scheduled_to from public.garden_staff_shift(p_employee,d) s;
    shift_start=(d+scheduled_from) at time zone 'Asia/Manila';shift_end=(d+scheduled_to) at time zone 'Asia/Manila';
    scheduled_seconds=extract(epoch from shift_end-shift_start);scheduled_pay=round(8125::numeric*scheduled_seconds/3600);
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
        regular_seconds=least(scheduled_seconds,regular_seconds);deduction=round(8125::numeric*(scheduled_seconds-regular_seconds)/3600);
        regular=greatest(0,scheduled_pay-deduction);ot_seconds=greatest(0,extract(epoch from a.clock_out-greatest(a.clock_in,shift_end)));
        approved=least(ot_seconds,coalesce(a.approved_ot_seconds,0));ot=round(8125::numeric*approved/3600);
        if ot_seconds>0 and not a.ot_reviewed then blockers=blockers||jsonb_build_array(d||': overtime needs approval or rejection.');end if;
        day_status=case when a.clock_in>shift_start and a.clock_out<shift_end then 'Late / undertime' when a.clock_in>shift_start then 'Late' when a.clock_out<shift_end then 'Undertime' else 'Present' end;
      end if;
    elsif working and r.id is not null then
      leave_pay=case when r.paid_leave then scheduled_pay else 0 end;
      day_status=case when r.kind='sick' then 'Sick leave' else 'Leave' end||case when r.paid_leave then ' · paid' else ' · unpaid' end;
    elsif working and shift_end<=now() then day_status='Absent';deduction=scheduled_pay;
    end if;
    if working and exists(select 1 from public.garden_staff_requests where employee_id=p_employee and kind in ('leave','sick') and status='pending' and d between start_date and end_date) then blockers=blockers||jsonb_build_array(d||': pending leave request.');end if;
    gross=gross+regular+ot+leave_pay;regular_total=regular_total+regular;ot_total=ot_total+ot;leave_total=leave_total+leave_pay;deductions=deductions+deduction;
    days=days||jsonb_build_array(jsonb_build_object('date',d,'status',day_status,'scheduled',working,'scheduled_start',scheduled_from,'scheduled_end',scheduled_to,'scheduled_seconds',scheduled_seconds,'scheduled_cents',scheduled_pay,'attendance_id',a.id,'clock_in',a.clock_in,'clock_out',a.clock_out,
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
-- Extend the current command in place, retaining QR/PIN rules, permissions and employee locking.
do $migration$ declare definition text;old_part text;new_part text;begin
 definition=replace(pg_get_functiondef('public.garden_team_command(text,jsonb)'::regprocedure),chr(13),'');
 old_part=$old$  cat uuid;week integer[];working boolean;profile_role text;$old$;
 new_part=$new$  cat uuid;week integer[];working boolean;profile_role text;
  scheduled_from time;scheduled_to time;old_shifts jsonb;$new$;
 old_part=replace(old_part,chr(13),'');new_part=replace(new_part,chr(13),'');
 if position(old_part in definition)=0 then raise exception 'Employee command definition not recognized.';end if;
 definition=replace(definition,old_part,new_part);
 old_part=$old$    insert into public.garden_employees(id,name,email,started_on,ended_on,active)$old$;
 new_part=$new$    select s.start_time,s.end_time into scheduled_from,scheduled_to from public.garden_staff_shift(eid,start_day) s;
    if p_payload ? 'start_time' then
      if coalesce(p_payload->>'start_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then raise exception 'Choose valid start and finish times.';end if;
      scheduled_from=(p_payload->>'start_time')::time;
    end if;
    if p_payload ? 'end_time' then
      if coalesce(p_payload->>'end_time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:00)?$' then raise exception 'Choose valid start and finish times.';end if;
      scheduled_to=(p_payload->>'end_time')::time;
    end if;
    if scheduled_from>=scheduled_to then raise exception 'Scheduled finish must be later than start on the same day.';end if;
    if start_day not between date '2000-01-01' and date '2100-12-31' then raise exception 'Choose a valid schedule effective date.';end if;
    select coalesce(jsonb_object_agg(att.id::text,jsonb_build_array(s.start_time,s.end_time)),'{}'::jsonb) into old_shifts
    from public.garden_attendance att cross join lateral public.garden_staff_shift(eid,att.work_date) s
    where att.employee_id=eid and not att.voided;
    insert into public.garden_employees(id,name,email,started_on,ended_on,active)$new$;
 old_part=replace(old_part,chr(13),'');new_part=replace(new_part,chr(13),'');
 if position(old_part in definition)=0 then raise exception 'Employee command definition not recognized.';end if;
 definition=replace(definition,old_part,new_part);
 old_part=$old$    insert into public.garden_employee_schedules(employee_id,effective_from,weekdays) values(eid,start_day,week)
    on conflict(employee_id,effective_from) do update set weekdays=excluded.weekdays;$old$;
 new_part=$new$    insert into public.garden_employee_schedules(employee_id,effective_from,weekdays,start_time,end_time) values(eid,start_day,week,scheduled_from,scheduled_to)
    on conflict(employee_id,effective_from) do update set weekdays=excluded.weekdays,start_time=excluded.start_time,end_time=excluded.end_time;
    -- A changed finish changes recorded overtime. Require a fresh approval rather than silently carrying it over.
    update public.garden_attendance att set approved_ot_seconds=null,ot_reviewed=false
    where att.employee_id=eid and not att.voided and old_shifts->att.id::text is distinct from
      (select jsonb_build_array(s.start_time,s.end_time) from public.garden_staff_shift(eid,att.work_date) s);$new$;
 old_part=replace(old_part,chr(13),'');new_part=replace(new_part,chr(13),'');
 if position(old_part in definition)=0 then raise exception 'Employee command definition not recognized.';end if;
 definition=replace(definition,old_part,new_part);
 old_part=$old$(a.work_date+time '23:30') at time zone 'Asia/Manila'$old$;
 new_part=$new$(a.work_date+(select s.end_time from public.garden_staff_shift(eid,a.work_date) s)) at time zone 'Asia/Manila'$new$;
 old_part=replace(old_part,chr(13),'');new_part=replace(new_part,chr(13),'');
 if position(old_part in definition)=0 then raise exception 'Employee command definition not recognized.';end if;
 definition=replace(definition,old_part,new_part);
 execute definition;
 definition=replace(pg_get_functiondef('public.garden_timesheet_report(date,date,uuid)'::regprocedure),chr(13),'');
 old_part=$old$case when (entry->>'scheduled')::boolean then '15:30 - 23:30' else 'Rest day' end$old$;
 new_part=$new$case when (entry->>'scheduled')::boolean then coalesce(left(entry->>'scheduled_start',5),'15:30')||' - '||coalesce(left(entry->>'scheduled_end',5),'23:30') else 'Rest day' end$new$;
 old_part=replace(old_part,chr(13),'');new_part=replace(new_part,chr(13),'');
 if position(old_part in definition)=0 then raise exception 'Timesheet definition not recognized.';end if;
 execute replace(definition,old_part,new_part);
end;$migration$;
notify pgrst,'reload schema';
