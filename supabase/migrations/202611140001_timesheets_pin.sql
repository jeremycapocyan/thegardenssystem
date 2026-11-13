-- Stable public identifiers; PIN credentials are kept in a separate private table.
create sequence public.garden_employee_code_seq;
create function public.garden_next_employee_code() returns text
language plpgsql volatile security definer set search_path='' as $$
declare n text=nextval('public.garden_employee_code_seq')::text;begin
 return 'TG-'||lpad(n,greatest(4,length(n)),'0');
end;$$;
revoke all on sequence public.garden_employee_code_seq from public,anon,authenticated;
revoke all on function public.garden_next_employee_code() from public,anon,authenticated;
alter table public.garden_employees add column employee_code text not null default public.garden_next_employee_code();
alter table public.garden_employees add constraint garden_employee_code_unique unique(employee_code);
create function public.garden_keep_employee_code() returns trigger language plpgsql set search_path='' as $$begin
 if new.employee_code is distinct from old.employee_code then raise exception 'Employee codes are permanent.';end if;return new;
end;$$;
revoke all on function public.garden_keep_employee_code() from public,anon,authenticated;
create trigger keep_employee_code before update on public.garden_employees for each row execute function public.garden_keep_employee_code();
alter table public.garden_attendance_events add column source text not null default 'account' check(source in ('account','pin'));

create table public.garden_attendance_pins (
 employee_id uuid primary key references public.garden_employees on delete cascade,
 salt text not null check(salt ~ '^[a-f0-9]{32}$'),pin_hash text not null check(pin_hash ~ '^[a-f0-9]{128}$'),
 version uuid not null default gen_random_uuid(),changed_at timestamptz not null default now()
);
create table public.garden_pin_attempts (
 id uuid primary key default gen_random_uuid(),ip_key text not null check(length(ip_key)=64),
 code_key text not null check(length(code_key)=64),created_at timestamptz not null default now(),
 status text not null default 'pending' check(status in ('pending','failed','success'))
);
create index garden_pin_attempts_ip on public.garden_pin_attempts(ip_key,created_at);
create index garden_pin_attempts_code on public.garden_pin_attempts(code_key,created_at);
alter table public.garden_attendance_pins enable row level security;
alter table public.garden_pin_attempts enable row level security;
revoke all on public.garden_attendance_pins,public.garden_pin_attempts from public,anon,authenticated;
-- Credential tables deliberately have no row-snapshot audit trigger.
create function public.garden_pin_configured(p_employee uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$begin
 if not(public.garden_is_team_admin() or public.garden_can_manage_accounts() or public.garden_own_employee(p_employee)) then
  raise exception 'Employee records are private.' using errcode='42501';end if;
 return exists(select 1 from public.garden_attendance_pins where employee_id=p_employee);
end;$$;
revoke all on function public.garden_pin_configured(uuid) from public,anon;
grant execute on function public.garden_pin_configured(uuid) to authenticated;
-- Expose only the boolean readiness flag in the existing RLS-filtered snapshot.
do $$declare definition text;begin
 definition=pg_get_functiondef('public.garden_team_snapshot()'::regprocedure);
 definition=replace(definition,'jsonb_agg(to_jsonb(t) order by name) from public.garden_employees t',
  'jsonb_agg(to_jsonb(t)||jsonb_build_object(''pin_configured'',public.garden_pin_configured(t.id)) order by name) from public.garden_employees t');
 execute definition;
end;$$;

create function public.garden_set_attendance_pin(p_actor uuid,p_salt text,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare eid uuid;begin
 select id into eid from public.garden_employees where profile_id=p_actor;
 if eid is null then raise exception 'An active employee account is required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext(eid::text));
 perform 1 from public.garden_employees e join public.garden_profiles p on p.id=e.profile_id
  where e.id=eid and e.active and p.active and p.role='employee' for update of e,p;
 if not found then raise exception 'An active employee account is required.' using errcode='42501';end if;
 insert into public.garden_attendance_pins(employee_id,salt,pin_hash) values(eid,p_salt,p_hash)
 on conflict(employee_id) do update set salt=excluded.salt,pin_hash=excluded.pin_hash,version=gen_random_uuid(),changed_at=now();
 insert into public.garden_audit(record_id,table_name,action,after_record,actor_id)
 values(eid,'garden_pin_security','PIN_SET','{"configured":true}'::jsonb,p_actor);
end;$$;
create function public.garden_revoke_attendance_pin(p_employee uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if not public.garden_can_manage_accounts() then raise exception 'Account management permission required.' using errcode='42501';end if;
 if p_employee is null or not exists(select 1 from public.garden_employees where id=p_employee) then raise exception 'Employee not found.';end if;
 perform pg_advisory_xact_lock(hashtext(p_employee::text));
 delete from public.garden_attendance_pins where employee_id=p_employee;
 insert into public.garden_audit(record_id,table_name,action,after_record,actor_id)
 values(p_employee,'garden_pin_security','PIN_REVOKED','{"configured":false}'::jsonb,auth.uid());
end;$$;
revoke all on function public.garden_revoke_attendance_pin(uuid) from public,anon;
grant execute on function public.garden_revoke_attendance_pin(uuid) to authenticated;

create function public.garden_pin_lookup(p_code text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('employee_id',e.id,'salt',c.salt,'pin_hash',c.pin_hash,'version',c.version)
 from public.garden_employees e join public.garden_profiles p on p.id=e.profile_id
 join public.garden_attendance_pins c on c.employee_id=e.id
 where e.employee_code=p_code and e.active and p.active and p.role='employee';
$$;
create function public.garden_pin_reserve(p_ip text,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$declare rid uuid;begin
 if p_ip is null or p_code is null or p_ip !~ '^[a-f0-9]{64}$' or p_code !~ '^[a-f0-9]{64}$' then raise exception 'Invalid rate-limit keys.';end if;
 perform pg_advisory_xact_lock(hashtextextended('pin-ip:'||p_ip,0));
 perform pg_advisory_xact_lock(hashtextextended('pin-code:'||p_code,0));
 delete from public.garden_pin_attempts where created_at<now()-interval '1 day';
 if (select count(*) from public.garden_pin_attempts where ip_key=p_ip and created_at>now()-interval '15 minutes' and status<>'success')>=20
 or (select count(*) from public.garden_pin_attempts where code_key=p_code and created_at>now()-interval '15 minutes' and status<>'success')>=5 then
  return jsonb_build_object('allowed',false);
 end if;
 insert into public.garden_pin_attempts(ip_key,code_key) values(p_ip,p_code) returning id into rid;
 return jsonb_build_object('allowed',true,'attempt_id',rid);
end;$$;
create function public.garden_pin_finish(p_attempt uuid,p_success boolean) returns void
language sql security definer set search_path='' as $$
 update public.garden_pin_attempts set status=case when p_success then 'success' else 'failed' end where id=p_attempt and status='pending';
$$;
create function public.garden_court_code_active(p_court uuid) returns boolean
language sql stable security definer set search_path='' as $$select exists(select 1 from public.garden_court_qr where id=p_court and active);$$;
create function public.garden_clock_by_pin(p_employee uuid,p_version uuid,p_court uuid,p_action text,p_nonce uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.garden_employees;event public.garden_attendance_events;result jsonb;begin
 if p_action is null or p_action not in ('clock_in','clock_out') or p_nonce is null then raise exception 'Choose Time In or Time Out.';end if;
 perform pg_advisory_xact_lock(hashtext(p_employee::text));
 select * into e from public.garden_employees where id=p_employee for update;
 if e.id is null or not e.active or not exists(select 1 from public.garden_profiles where id=e.profile_id and active and role='employee') then
  raise exception 'Employee access is unavailable.' using errcode='42501';end if;
 perform 1 from public.garden_attendance_pins where employee_id=e.id and version=p_version for update;
 if not found then raise exception 'PIN changed. Enter your current PIN.' using errcode='42501';end if;
 if not public.garden_court_code_active(p_court) then raise exception 'This court QR is no longer valid. Scan the current printed code.';end if;
 perform set_config('request.jwt.claim.sub',e.profile_id::text,true);
 result=public.garden_team_command(p_action,jsonb_build_object('id',p_nonce,'qr',p_court));
 update public.garden_attendance_events set source='pin' where id=p_nonce and employee_id=e.id and action=p_action and source<>'pin';
 select * into event from public.garden_attendance_events where id=p_nonce and employee_id=e.id and action=p_action;
 if event.id is null then raise exception 'Attendance was not confirmed.';end if;
 return jsonb_build_object('name',e.name,'action',event.action,'at',event.occurred_at);
end;$$;
-- All credential verification and PIN clock posting is server-only.
revoke all on function public.garden_set_attendance_pin(uuid,text,text),public.garden_pin_lookup(text),public.garden_pin_reserve(text,text),public.garden_pin_finish(uuid,boolean),public.garden_court_code_active(uuid),public.garden_clock_by_pin(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then
 grant execute on function public.garden_set_attendance_pin(uuid,text,text),public.garden_pin_lookup(text),public.garden_pin_reserve(text,text),public.garden_pin_finish(uuid,boolean),public.garden_court_code_active(uuid),public.garden_clock_by_pin(uuid,uuid,uuid,text,uuid) to service_role;
end if;end;$$;

-- One stable database snapshot per export, with finalized daily figures preferred.
create function public.garden_timesheet_report(p_start date,p_end date,p_employee uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare e public.garden_employees;cutoff date;next_cutoff date;snapshot jsonb;is_final boolean;entry jsonb;
 days jsonb;periods jsonb;warnings jsonb;people jsonb='[]';sums jsonb;begin
 if not public.garden_is_team_admin() then raise exception 'Employee and payroll management permission required.' using errcode='42501';end if;
 if p_start is null or p_end is null or p_end<p_start or p_end-p_start>30 or p_start<date '2000-01-01' or p_end>date '2100-12-31' then
  raise exception 'Choose a valid date range of up to 31 days.';end if;
 if p_employee is not null and not exists(select 1 from public.garden_employees where id=p_employee) then raise exception 'Employee not found.';end if;
 for e in select * from public.garden_employees where (p_employee is null or id=p_employee) and started_on<=p_end and (ended_on is null or ended_on>=p_start) order by name,id loop
  days='[]';periods='[]';warnings='[]';
  cutoff=date_trunc('month',p_start)::date+case when extract(day from p_start)>15 then 15 else 0 end;
  while cutoff<=p_end loop
   next_cutoff=case when extract(day from cutoff)=1 then cutoff+15 else (date_trunc('month',cutoff)+interval '1 month')::date end;
   select p.snapshot into snapshot from public.garden_payroll p where p.employee_id=e.id and period_start=cutoff;
   is_final=found;
   if not is_final then snapshot=public.garden_payroll_preview(e.id,cutoff);end if;
   periods=periods||jsonb_build_array(jsonb_build_object('start',cutoff,'end',next_cutoff-1,'finalized',is_final));
   for entry in select value from jsonb_array_elements(snapshot->'days') loop
    if (entry->>'date')::date between greatest(p_start,e.started_on) and least(p_end,coalesce(e.ended_on,p_end)) then
     days=days||jsonb_build_array(entry||jsonb_build_object('finalized',is_final,
      'scheduled_shift',case when (entry->>'scheduled')::boolean then '15:30 - 23:30' else 'Rest day' end,
      'recorded_seconds',case when entry->>'clock_in' is not null and entry->>'clock_out' is not null then greatest(0,extract(epoch from (entry->>'clock_out')::timestamptz-(entry->>'clock_in')::timestamptz)) else null end));
    end if;
   end loop;
   if not is_final then
    for entry in select value from jsonb_array_elements(snapshot->'blockers') loop
     if (entry#>>'{}') !~ '^\d{4}-\d{2}-\d{2}:' then warnings=warnings||jsonb_build_array(entry);
     elsif substring(entry#>>'{}',1,10)::date between p_start and p_end then warnings=warnings||jsonb_build_array(entry);end if;
    end loop;
   end if;
   cutoff=next_cutoff;
  end loop;
  select jsonb_build_object('regular_cents',coalesce(sum((value->>'regular_cents')::bigint),0),
   'deduction_cents',coalesce(sum((value->>'deduction_cents')::bigint),0),'ot_cents',coalesce(sum((value->>'ot_cents')::bigint),0),
   'leave_cents',coalesce(sum((value->>'leave_cents')::bigint),0),'gross_cents',coalesce(sum((value->>'total_cents')::bigint),0),
   'recorded_seconds',coalesce(sum((value->>'recorded_seconds')::numeric),0),'late_seconds',coalesce(sum((value->>'late_seconds')::numeric),0),
   'undertime_seconds',coalesce(sum((value->>'undertime_seconds')::numeric),0),'overtime_seconds',coalesce(sum((value->>'overtime_seconds')::numeric),0),
   'approved_ot_seconds',coalesce(sum((value->>'approved_ot_seconds')::numeric),0)) into sums from jsonb_array_elements(days);
  people=people||jsonb_build_array(jsonb_build_object('id',e.id,'name',e.name,'employee_code',e.employee_code,'days',days,'periods',periods,'warnings',warnings,'totals',sums));
 end loop;
 return jsonb_build_object('start',p_start,'end',p_end,'generated_at',now(),'prepared_by',(select display_name from public.garden_profiles where id=auth.uid()),'employees',people);
end;$$;
revoke all on function public.garden_timesheet_report(date,date,uuid) from public,anon;
grant execute on function public.garden_timesheet_report(date,date,uuid) to authenticated;
notify pgrst,'reload schema';
