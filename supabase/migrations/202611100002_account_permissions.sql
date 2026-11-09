-- Account administration is separate from finance and private staff management.
alter table public.garden_profiles
  add column active boolean not null default true,
  add column is_owner boolean not null default false,
  add column finance_access boolean not null default true,
  add column team_access boolean not null default true,
  add column manage_accounts boolean not null default false;
-- Preserve the original administrator's access. Never promote a newly invited account.
update public.garden_profiles set is_owner=true,manage_accounts=true
where role='admin' and (select count(*) from public.garden_profiles where role='admin')=1;
update public.garden_profiles set finance_access=false,team_access=false where role='employee';
update public.garden_profiles set team_access=false where role='viewer';
create unique index garden_one_owner on public.garden_profiles(is_owner) where is_owner;

create function public.garden_has_access(p_scope text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.garden_profiles where id=auth.uid() and active and role='admin'
 and (is_owner or case p_scope when 'finance' then finance_access when 'team' then team_access when 'accounts' then manage_accounts else false end));
$$;
create or replace function public.garden_is_admin() returns boolean
language sql stable security definer set search_path='' as $$select public.garden_has_access('finance');$$;
create function public.garden_is_team_admin() returns boolean
language sql stable security definer set search_path='' as $$select public.garden_has_access('team');$$;
create function public.garden_can_manage_accounts() returns boolean
language sql stable security definer set search_path='' as $$select public.garden_has_access('accounts');$$;
create or replace function public.garden_is_member() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.garden_profiles where id=auth.uid() and active and
 (role='viewer' or (role='admin' and (is_owner or finance_access))));
$$;
create or replace function public.garden_own_employee(p_employee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.garden_employees e join public.garden_profiles p on p.id=e.profile_id
 where e.id=p_employee and p.id=auth.uid() and p.active and p.role='employee');
$$;
revoke all on function public.garden_has_access(text),public.garden_is_team_admin(),public.garden_can_manage_accounts() from public,anon;
grant execute on function public.garden_has_access(text),public.garden_is_team_admin(),public.garden_can_manage_accounts() to authenticated;

alter policy own_profile on public.garden_profiles using(id=auth.uid() or public.garden_can_manage_accounts());
alter policy staff_employee_read on public.garden_employees using(public.garden_is_team_admin() or public.garden_own_employee(id));
do $$ declare t text; f regprocedure; definition text;begin
 foreach t in array array['garden_employee_schedules','garden_schedule_overrides','garden_attendance','garden_attendance_events','garden_staff_requests','garden_payroll','garden_staff_cash','garden_advance_recoveries'] loop
   execute format('alter policy staff_own_read on public.%I using(public.garden_is_team_admin() or public.garden_own_employee(employee_id))',t);
 end loop;
 foreach t in array array['garden_court_qr','garden_staff_settings'] loop
   execute format('alter policy staff_admin_read on public.%I using(public.garden_is_team_admin())',t);
 end loop;
 -- Keep the already-tested payroll bodies; only replace their management gate.
 foreach f in array array['public.garden_team_command(text,jsonb)'::regprocedure,'public.garden_payroll_preview(uuid,date)'::regprocedure,'public.garden_team_snapshot()'::regprocedure] loop
   definition=pg_get_functiondef(f);
   definition=replace(definition,'public.garden_is_admin()','public.garden_is_team_admin()');
   if f='public.garden_team_command(text,jsonb)'::regprocedure then
     definition=replace(definition,'if actor is null then','if actor is null or not exists(select 1 from public.garden_profiles where id=actor and active) then');
   end if;
   execute definition;
 end loop;
end;$$;
-- Finance administrators must not read medical/HR snapshots from the audit table.
alter policy admin_audit on public.garden_audit using(
 (table_name='garden_profiles' and public.garden_can_manage_accounts()) or
 (table_name in ('garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_admin()) or
 (table_name not in ('garden_profiles','garden_categories','garden_income','garden_expenses','garden_fixed_bills','garden_bill_terms','garden_installments','garden_payouts') and public.garden_is_team_admin())
);
create trigger garden_profile_audit after insert or update or delete on public.garden_profiles
for each row execute function public.garden_log_staff_change();

-- Only trusted server endpoints can assign roles. Re-check the actor inside the
-- transaction so a revoked/stale server session cannot grant access.
create function public.garden_manage_account(p_actor uuid,p_user uuid,p_name text,p_role text,
 p_finance boolean,p_team boolean,p_accounts boolean,p_active boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor public.garden_profiles; target public.garden_profiles;begin
 perform pg_advisory_xact_lock(hashtext('gardens_account_permissions'));
 select * into actor from public.garden_profiles where id=p_actor for update;
 select * into target from public.garden_profiles where id=p_user for update;
 if actor.id is null or not actor.active or actor.role<>'admin' or not(actor.is_owner or actor.manage_accounts) then
   raise exception 'Account management permission required.' using errcode='42501';end if;
 if p_user=p_actor or coalesce(target.is_owner,false) then
   raise exception 'Your own account and the workspace owner are protected.' using errcode='42501';end if;
 if p_name is null or length(btrim(p_name)) not between 1 and 100 or p_role is null or p_role not in ('admin','viewer','employee')
 or p_finance is null or p_team is null or p_accounts is null or p_active is null then raise exception 'Invalid account details.';end if;
 if target.id is not null and (target.role='employee')<>(p_role='employee') then
   raise exception 'Employee accounts cannot be converted to administrator or viewer accounts. Use a separate email.';end if;
 if p_role='employee' and not exists(select 1 from public.garden_employees where profile_id=p_user) then
   raise exception 'Register and link the employee before managing their account.';end if;
 if p_role='admin' and not(p_finance or p_team or p_accounts) then raise exception 'Select at least one administrator permission.';end if;
 if p_role<>'admin' then p_finance=(p_role='viewer');p_team=false;p_accounts=false;end if;
 if not actor.is_owner and (
   ((p_finance or coalesce(target.role='viewer' or (target.role='admin' and target.finance_access),false)) and not actor.finance_access) or
   ((p_team or coalesce(target.role='admin' and target.team_access,false)) and not actor.team_access) or
   ((p_accounts or coalesce(target.role='admin' and target.manage_accounts,false)) and not actor.manage_accounts)) then
   raise exception 'You can only grant or manage permissions within your own access.' using errcode='42501';end if;
 -- Stamp the real initiating account in the audit trail, not the service identity.
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 insert into public.garden_profiles(id,display_name,role,active,finance_access,team_access,manage_accounts)
 values(p_user,btrim(p_name),p_role,p_active,p_finance,p_team,p_accounts)
 on conflict(id) do update set display_name=excluded.display_name,role=excluded.role,active=excluded.active,
 finance_access=excluded.finance_access,team_access=excluded.team_access,manage_accounts=excluded.manage_accounts;
end;$$;
revoke all on function public.garden_manage_account(uuid,uuid,text,text,boolean,boolean,boolean,boolean) from public,anon,authenticated;
create function public.garden_provision_employee(p_actor uuid,p_employee uuid,p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor public.garden_profiles; e public.garden_employees;target public.garden_profiles;begin
 perform pg_advisory_xact_lock(hashtext('gardens_account_permissions'));
 select * into actor from public.garden_profiles where id=p_actor for update;
 if actor.id is null or not actor.active or actor.role<>'admin' or not(actor.is_owner or actor.manage_accounts) then
   raise exception 'Account management permission required.' using errcode='42501';end if;
 select * into e from public.garden_employees where id=p_employee for update;
 if e.id is null or not e.active then raise exception 'Choose an active registered employee.';end if;
 select * into target from public.garden_profiles where id=p_user for update;
 if target.id is not null and (target.role<>'employee' or not target.active) then raise exception 'Account belongs to an administrator, viewer, or disabled employee.';end if;
 perform set_config('request.jwt.claim.sub',p_actor::text,true);
 perform public.garden_bind_employee(p_employee,p_user);
 perform public.garden_manage_account(p_actor,p_user,e.name,'employee',false,false,false,true);
end;$$;
revoke all on function public.garden_provision_employee(uuid,uuid,uuid) from public,anon,authenticated;
do $$begin if exists(select 1 from pg_roles where rolname='service_role') then
 grant execute on function public.garden_manage_account(uuid,uuid,text,text,boolean,boolean,boolean,boolean) to service_role;
 grant execute on function public.garden_provision_employee(uuid,uuid,uuid) to service_role;
end if;end;$$;
notify pgrst,'reload schema';
