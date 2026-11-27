-- Existing payments/assignments remain unchanged. New HR payment forms choose Cash or Bank.
alter table public.garden_staff_cash add column funding_account text check(funding_account in ('cash','bank'));
alter table public.garden_cash_allocations add column staff_cash_id uuid unique references public.garden_staff_cash;

create function public.garden_staff_allocation_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare linked boolean;begin
 linked=case when tg_op='INSERT' then new.staff_cash_id is not null when tg_op='DELETE' then old.staff_cash_id is not null else old.staff_cash_id is not null or new.staff_cash_id is not null end;
 if linked and (current_user<>(select pg_get_userbyid(proowner) from pg_proc where oid='public.garden_team_command(text,jsonb)'::regprocedure) or coalesce(current_setting('gardens.staff_cash_write',true),'')<>'on') then raise exception 'This account assignment is managed by Payroll. It cannot be changed independently of the payment.' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke all on function public.garden_staff_allocation_guard() from public,anon,authenticated;
create trigger staff_allocation_guard before insert or update or delete on public.garden_cash_allocations for each row execute function public.garden_staff_allocation_guard();

do $m$declare definition text;begin
 definition=replace(pg_get_functiondef('public.garden_team_command(text,jsonb)'::regprocedure),chr(13),'');
 if position('eid=nullif(p_payload->>''employee_id''' in definition)=0 or position('insert into public.garden_staff_cash(id,employee_id,kind,request_id,payroll_id,amount_cents,paid_on,reference)' in definition)=0 then raise exception 'Unexpected payroll command definition; do not apply a partial update.';end if;
 definition=replace(definition,'  eid=nullif(p_payload->>''employee_id''',$lock$  if p_action in ('release','pay') then
    perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
    perform 1 from public.garden_profiles where id=actor for share;
    if not public.garden_is_team_admin() then raise exception 'Employee and payroll management permission required.' using errcode='42501';end if;
  end if;
  eid=nullif(p_payload->>'employee_id'$lock$);
 definition=replace(definition,'if c.id is not null then
      if c.employee_id<>eid',$retry$if c.id is not null then
      if p_payload ? 'account' and c.funding_account is distinct from p_payload->>'account' then raise exception 'Payment reference was already used for a different funding account.';end if;
      if c.reference is distinct from coalesce(p_payload->>'reference','') then raise exception 'Payment reference was already used for different details.';end if;
      if c.employee_id<>eid$retry$);
 definition=replace(definition,'    if day>today then raise exception ''Record actual payments on or before today.'';end if;',$validate$    if day>today then raise exception 'Record actual payments on or before today.';end if;
    if p_payload ? 'account' then
      if p_payload->>'account' is null or p_payload->>'account' not in ('cash','bank') then raise exception 'Choose Cash on hand or Bank as the payment account.';end if;
      if not exists(select 1 from public.garden_cash_settings) then raise exception 'Ask a Finance admin to configure opening balances before assigning this payment account.';end if;
    end if;$validate$);
 definition=replace(definition,'insert into public.garden_staff_cash(id,employee_id,kind,request_id,payroll_id,amount_cents,paid_on,reference)','insert into public.garden_staff_cash(id,employee_id,kind,request_id,payroll_id,amount_cents,paid_on,reference,funding_account)');
 definition=replace(definition,'rid,pid,qty,day,coalesce(p_payload->>''reference'','''')) returning * into c;','rid,pid,qty,day,coalesce(p_payload->>''reference'',''''),p_payload->>''account'') returning * into c;');
 definition=replace(definition,'end,cid);
    return to_jsonb(c);',$allocate$end,cid);
    if c.funding_account is not null and day>=(select start_date from public.garden_cash_settings) then
      perform set_config('gardens.staff_cash_write','on',true);
      insert into public.garden_cash_allocations(id,account,posted_on,expense_id,amount_cents,staff_cash_id,created_by,updated_by)
      select cid,c.funding_account,day,id,qty,cid,actor,actor from public.garden_expenses where staff_payment_id=cid;
      perform set_config('gardens.staff_cash_write','off',true);
    end if;
    return to_jsonb(c);$allocate$);
 if position('insert into public.garden_cash_allocations' in definition)=0 or position('different funding account' in definition)=0 then raise exception 'Payroll account update was incomplete.';end if;
 execute definition;
 definition=replace(pg_get_functiondef('public.garden_prepare_payroll_report(uuid,uuid,uuid)'::regprocedure),chr(13),'');
 definition=replace(definition,'''reference'',reference) order by paid_on','''reference'',reference,''funding_account'',funding_account) order by paid_on');execute definition;
end;$m$;
notify pgrst,'reload schema';
