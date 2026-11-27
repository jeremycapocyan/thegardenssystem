-- Separate owner distribution policy from actual expenses and cash balances.
-- Same-day repayments keep their recorded order, including concurrent transactions.
alter table public.garden_partner_cash_repayments alter column created_at set default clock_timestamp();
create function public.garden_partner_cost_ledger() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare loan record;ev record;costs jsonb;events jsonb='[]';funded bigint;returned bigint;repaid bigint;
 remaining bigint;take bigint;cost bigint;idx integer;allocations jsonb;begin
 for loan in select * from public.garden_partner_cash_advances where voided_at is null order by id loop
  costs='[]';funded=0;returned=0;repaid=0;
  for ev in
   select s.id,(s.detail->'expense'->>'paid_on')::date as event_date,0 kind,s.amount_cents amount,null::timestamptz recorded_at from public.garden_partner_cash_spends s where s.advance_id=loan.id and s.voided_at is null
   union all select r.id,r.paid_on,1,r.amount_cents,r.created_at from public.garden_partner_cash_repayments r where r.advance_id=loan.id and r.voided_at is null
   order by event_date,kind,recorded_at,id
  loop
   if ev.event_date<loan.received_on or ev.amount<=0 then raise exception 'Advance history is inconsistent. Review receipt, purchase and repayment dates and amounts.';end if;
   allocations='[]';remaining=0;
   if ev.kind=0 then
    funded=funded+ev.amount;
    if funded+returned>loan.amount_cents then raise exception 'Linked funding exceeds cash retained from this advance. Reduce the funded portion or correct the earlier unused-funds return.';end if;
    costs=costs||jsonb_build_array(jsonb_build_object('id',ev.id,'remaining',ev.amount));
   else
    repaid=repaid+ev.amount;if repaid>loan.amount_cents then raise exception 'Repayment cannot exceed the outstanding debt.';end if;
    remaining=ev.amount;
    if jsonb_array_length(costs)>0 then
     for idx in 0..jsonb_array_length(costs)-1 loop
      cost=(costs->idx->>'remaining')::bigint;take=least(remaining,cost);
      if take>0 then allocations=allocations||jsonb_build_array(jsonb_build_object('spend_id',costs->idx->>'id','amount_cents',take));end if;
      costs=jsonb_set(costs,array[idx::text,'remaining'],to_jsonb(cost-take));remaining=remaining-take;
      exit when remaining=0;
     end loop;
    end if;
    returned=returned+remaining;
   end if;
   events=events||jsonb_build_array(jsonb_build_object('id',ev.id,'advance_id',loan.id,'date',ev.event_date,
    'kind',case when ev.kind=0 then 'purchase' else 'repayment' end,'amount_cents',ev.amount,
    'funded_cents',case when ev.kind=0 then ev.amount else 0 end,
    'reimbursed_cost_cents',case when ev.kind=1 then ev.amount-remaining else 0 end,
    'unused_return_cents',remaining,'allocations',allocations));
  end loop;
 end loop;
 return coalesce((select jsonb_agg(value order by value->>'date',case when value->>'kind'='purchase' then 0 else 1 end,value->>'id') from jsonb_array_elements(events)),'[]');
end;$$;
revoke all on function public.garden_partner_cost_ledger() from public,anon,authenticated;

create function public.garden_distribution_basis(p_start date,p_end date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare operating bigint;funded bigint;reimbursed bigint;unused bigint;basis bigint;events jsonb;begin
 if not public.garden_is_member() then raise exception 'Finance viewing permission required.' using errcode='42501';end if;
 if p_start is null or p_end is null or p_start>p_end or p_start<date '2000-01-01' or p_end>date '2100-12-31' then raise exception 'Choose valid payout reporting dates.';end if;
 select coalesce((select sum(amount_cents) from public.garden_income where business_date between p_start and p_end),0)
 -coalesce((select sum(amount_cents) from public.garden_expenses where paid_on between p_start and p_end),0) into operating;
 select coalesce(jsonb_agg(value order by value->>'date',case when value->>'kind'='purchase' then 0 else 1 end,value->>'id'),'[]'),
  coalesce(sum((value->>'funded_cents')::bigint),0),coalesce(sum((value->>'reimbursed_cost_cents')::bigint),0),coalesce(sum((value->>'unused_return_cents')::bigint),0)
 into events,funded,reimbursed,unused from jsonb_array_elements(public.garden_partner_cost_ledger()) where (value->>'date')::date between p_start and p_end;
 basis=operating+funded-reimbursed;
 return jsonb_build_object('version','partner_repayment_v1','start',p_start,'end',p_end,'operating_result_cents',operating,
  'funded_purchases_cents',funded,'reimbursed_cost_cents',reimbursed,'unused_return_cents',unused,'payout_basis_cents',basis,'distributable_cents',greatest(0,basis),'events',events);
end;$$;
revoke all on function public.garden_distribution_basis(date,date) from public,anon,authenticated;
grant execute on function public.garden_distribution_basis(date,date) to authenticated;

create function public.garden_distribution_fingerprint() returns text
language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_object('version','partner_repayment_v1',
 'advances',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_partner_cash_advances t),
 'spends',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_partner_cash_spends t),
 'repayments',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_partner_cash_repayments t),
 'expenses',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_expenses t),
 'income',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_income t),
 'movements',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_cash_movements t),
 'allocations',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_cash_allocations t),
 'settings',(select to_jsonb(t) from public.garden_cash_settings t),
 'settlements',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.garden_owner_settlements t))::text);
$$;
revoke all on function public.garden_distribution_fingerprint() from public,anon,authenticated;

-- Keep existing command bodies private. Public wrappers add complete-history validation.
alter function public.garden_partner_cash_command(text,uuid,jsonb) rename to garden_partner_cash_command_core;
alter function public.garden_partner_cash_edit(text,uuid,jsonb) rename to garden_partner_cash_edit_core;
revoke all on function public.garden_partner_cash_command_core(text,uuid,jsonb),public.garden_partner_cash_edit_core(text,uuid,jsonb) from public,anon,authenticated;

create function public.garden_partner_cash_command(p_action text,p_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$declare answer jsonb;begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 if not exists(select 1 from public.garden_partner_cash_actions where id=p_id) and p_payload ? 'distribution_expected' and p_payload->>'distribution_expected' is distinct from public.garden_distribution_fingerprint() then
  raise exception 'Finance records changed after review. Refresh the preview before saving.';end if;
 answer=public.garden_partner_cash_command_core(p_action,p_id,p_payload-'distribution_expected');
 perform public.garden_partner_cost_ledger();return answer;
end;$$;
create function public.garden_partner_cash_edit(p_action text,p_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$declare answer jsonb;begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 if not exists(select 1 from public.garden_partner_cash_actions where id=p_id) and p_payload ? 'distribution_expected' and p_payload->>'distribution_expected' is distinct from public.garden_distribution_fingerprint() then
  raise exception 'Finance records changed after review. Refresh the preview before saving.';end if;
 answer=public.garden_partner_cash_edit_core(p_action,p_id,p_payload-'distribution_expected');
 perform public.garden_partner_cost_ledger();return answer;
end;$$;
revoke all on function public.garden_partner_cash_command(text,uuid,jsonb),public.garden_partner_cash_edit(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.garden_partner_cash_command(text,uuid,jsonb),public.garden_partner_cash_edit(text,uuid,jsonb) to authenticated;

-- Preview executes the same validation in a subtransaction and always rolls it back.
-- No finance, audit, action or account record survives preview generation.
create function public.garden_partner_cash_preview(p_action text,p_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare before_state jsonb;after_state jsonb;fingerprint text;repayment jsonb;answer jsonb;retry boolean;begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 fingerprint=public.garden_distribution_fingerprint();
 before_state=public.garden_distribution_basis('2000-01-01','2100-12-31');
 retry=exists(select 1 from public.garden_partner_cash_actions where id=p_id);
 begin
  if p_action in ('edit_receipt','edit_repayment') then
   perform public.garden_partner_cash_edit(p_action,p_id,p_payload-'distribution_expected');
  else perform public.garden_partner_cash_command(p_action,p_id,p_payload-'distribution_expected');end if;
  after_state=public.garden_distribution_basis('2000-01-01','2100-12-31');
  select value into repayment from jsonb_array_elements(after_state->'events') where value->>'kind'='repayment' and value->>'id'=case when p_action='edit_repayment' then p_payload->>'record_id' else p_id::text end;
  raise exception using errcode='GDR01',message='Rollback preview';
 exception when sqlstate 'GDR01' then null;
 end;
 return jsonb_build_object('fingerprint',fingerprint,'before',before_state,'after',after_state,'repayment',repayment,'retry',retry);
end;$$;
revoke all on function public.garden_partner_cash_preview(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.garden_partner_cash_preview(text,uuid,jsonb) to authenticated;

-- Settlement source hashes now include the derived adjustment evidence.
create or replace function public.garden_partner_profit(p_month date) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('income',coalesce((select jsonb_agg(jsonb_build_array(id,business_date,amount_cents) order by id) from public.garden_income where business_date>=p_month and business_date<(p_month+interval '1 month')::date),'[]'),
 'expenses',coalesce((select jsonb_agg(jsonb_build_array(id,paid_on,amount_cents) order by id) from public.garden_expenses where paid_on>=p_month and paid_on<(p_month+interval '1 month')::date),'[]'),
 'distribution',public.garden_distribution_basis(p_month,(p_month+interval '1 month - 1 day')::date));
$$;
do $migration$ declare definition text;old_part text;begin
 definition=replace(pg_get_functiondef('public.garden_partner_preview(date)'::regprocedure),chr(13),'');
 old_part=$old$ select coalesce((select sum(amount_cents) from public.garden_income where business_date>=p_month and business_date<(p_month+interval '1 month')::date),0)-coalesce((select sum(amount_cents) from public.garden_expenses where paid_on>=p_month and paid_on<(p_month+interval '1 month')::date),0) into net;$old$;
 if position(old_part in definition)=0 then raise exception 'Settlement calculation not recognized.';end if;
 definition=replace(definition,old_part,$new$ net=(public.garden_distribution_basis(p_month,(p_month+interval '1 month - 1 day')::date)->>'payout_basis_cents')::bigint;$new$);
 definition=replace(definition,'''month'',p_month,''net_cents'',net,','''month'',p_month,''net_cents'',net,''distribution'',public.garden_distribution_basis(p_month,(p_month+interval ''1 month - 1 day'')::date),');
 execute definition;
end;$migration$;
notify pgrst,'reload schema';
