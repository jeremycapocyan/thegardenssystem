-- Preserve real contributions. Company-funded capital is credited separately,
-- with a recoverable balance; repayment is not a second capital credit.
alter table public.garden_partner_fundings add column capital_equalization jsonb;
create trigger partner_serialize before insert or update or delete on public.garden_capital for each statement execute function public.garden_partner_serialize();
create function public.garden_partner_equalization(p_total bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare positions jsonb='[]';allocations jsonb='[]';person text;recorded bigint;covered bigint;repaid bigint;combined numeric=0;target bigint;v jsonb;fingerprint text;today date=(now() at time zone 'Asia/Manila')::date;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));perform 1 from public.garden_profiles where id=auth.uid() for share;
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 if p_total is null or p_total<=0 or p_total>999999999999 then raise exception 'Enter a positive capital payment within the supported amount.';end if;
 foreach person in array array['Genesis','Ken'] loop
  select coalesce(sum(amount_cents),0) into recorded from public.garden_capital where owner=person and invested_on<=today;
  select coalesce(sum(d.amount_cents),0) into covered from public.garden_partner_debts d join public.garden_partner_fundings f on f.id=d.funding_id where d.owner=person and f.state='funded' and f.funded_on<=today;
  select coalesce(sum(r.amount_cents),0) into repaid from public.garden_owner_recoveries r join public.garden_owner_settlements s on s.id=r.settlement_id join public.garden_partner_debts d on d.id=r.debt_id join public.garden_partner_fundings f on f.id=d.funding_id where d.owner=person and f.state='funded' and f.funded_on<=today and r.effective_on<=today and s.reversed_at is null;
  positions=positions||jsonb_build_array(jsonb_build_object('owner',person,'recorded_cents',recorded,'gardens_funded_cents',covered,'repaid_cents',repaid,'personally_funded_cents',recorded+repaid,'outstanding_cents',covered-repaid,'credited_cents',recorded+covered));combined=combined+recorded+covered;
 end loop;
 if mod(combined+p_total,2)<>0 then raise exception 'This total would require half a centavo. Review the actual payment or record a genuine capital correction before equalizing.';end if;
 target=(combined+p_total)/2;
 for v in select * from jsonb_array_elements(positions) loop
  if target<(v->>'credited_cents')::bigint then raise exception 'This payment is too small to equalize total capital. It must cover the current capital difference.';end if;
  allocations=allocations||jsonb_build_array(jsonb_build_object('owner',v->>'owner','amount_cents',target-(v->>'credited_cents')::bigint));
 end loop;
 select md5(jsonb_build_object('capital',coalesce((select jsonb_agg(jsonb_build_array(id,owner,invested_on,amount_cents) order by id) from public.garden_capital where invested_on<=today),'[]'),
 'funded',coalesce((select jsonb_agg(jsonb_build_array(d.id,d.funding_id,d.owner,d.amount_cents) order by d.id) from public.garden_partner_debts d join public.garden_partner_fundings f on f.id=d.funding_id where f.state='funded' and f.funded_on<=today),'[]'))::text) into fingerprint;
 return jsonb_build_object('total_cents',p_total,'target_cents',target,'positions',positions,'allocations',allocations,'fingerprint',fingerprint);
end;$$;
create function public.garden_partner_check_equalization(p_partners jsonb,p_preview jsonb) returns void language plpgsql security definer set search_path='' as $$
declare actual jsonb;expected jsonb;begin
 if jsonb_typeof(p_partners) is distinct from 'array' then raise exception 'Choose the capital partners.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('owner',x->>'owner','amount_cents',(x->>'amount_cents')::bigint) order by x->>'owner'),'[]') into actual from jsonb_array_elements(p_partners)x;
 select coalesce(jsonb_agg(x order by x->>'owner'),'[]') into expected from jsonb_array_elements(p_preview->'allocations')x where (x->>'amount_cents')::bigint>0;
 if actual<>expected then raise exception 'Allocations must equalize Genesis and Ken''s total credited capital. Calculate the equal capital preview again.';end if;
end;$$;
-- Extend commands additively, retaining existing idempotency, guards and checks.
do $$declare definition text;begin
 definition=pg_get_functiondef('public.garden_partner_command(text,uuid,jsonb)'::regprocedure);
 if position('rate integer;' in definition)=0 or position('elsif p_action=''funding_draft'' then' in definition)=0 or position('select start_date into opening from public.garden_cash_settings;' in definition)=0 then raise exception 'Unexpected partner command definition; migration not applied.';end if;
 definition=replace(definition,'rate integer;','rate integer;equalization jsonb;');
 definition=replace(definition,'elsif p_action=''funding_draft'' then',$injection$elsif p_action='funding_draft' then
  if coalesce((p_payload->>'equalize_capital')::boolean,false) or exists(select 1 from jsonb_array_elements(p_payload->'partners')x where x->>'owner' in ('Genesis','Ken')) then
   if (select sum((x->>'amount_cents')::bigint) from jsonb_array_elements(p_payload->'partners')x) is distinct from (p_payload->>'total_cents')::bigint then raise exception 'Partner allocations must equal the supplier payment.';end if;
   equalization=public.garden_partner_equalization((p_payload->>'total_cents')::bigint);
   if p_payload ? 'capital_fingerprint' and p_payload->>'capital_fingerprint' is distinct from equalization->>'fingerprint' then raise exception 'Capital records changed after preview. Calculate equal capital again.' using errcode='40001';end if;
   if coalesce((p_payload->>'equalize_capital')::boolean,false) and not (p_payload ? 'capital_fingerprint') then raise exception 'Calculate the equal capital preview before saving.';end if;
   perform public.garden_partner_check_equalization(p_payload->'partners',equalization);
  end if;
 $injection$);
 definition=replace(definition,'if not found or fund.state<>''draft'' then raise exception ''Choose an unpaid draft capital advance.'';end if;',$injection$if not found or fund.state<>'draft' then raise exception 'Choose an unpaid draft capital advance.';end if;
  if exists(select 1 from public.garden_partner_debts where funding_id=fund.id and owner in ('Genesis','Ken')) then
   equalization=public.garden_partner_equalization(fund.total_cents);
   if fund.capital_equalization is not null and fund.capital_equalization->>'fingerprint' is distinct from equalization->>'fingerprint' then raise exception 'Capital changed since this draft. Void the unpaid draft and create a reviewed equal-capital draft.' using errcode='40001';end if;
   perform public.garden_partner_check_equalization((select jsonb_agg(jsonb_build_object('owner',owner,'amount_cents',amount_cents)) from public.garden_partner_debts where funding_id=fund.id),equalization);
  end if;
 $injection$);
 definition=replace(definition,'perform set_config(''gardens.partner_write'',''off'',true);',$injection$if equalization is not null then
  update public.garden_partner_fundings set capital_equalization=equalization where id=case when p_action='funding_draft' then p_id else fund.id end;
 end if;
 perform set_config('gardens.partner_write','off',true);$injection$);
 execute definition;
 definition=pg_get_functiondef('public.garden_partner_snapshot()'::regprocedure);
 if position('''purchases'',' in definition)=0 then raise exception 'Unexpected partner snapshot definition.';end if;
 definition=replace(definition,'''purchases'',',$injection$'capital_contributions',coalesce((select jsonb_agg(jsonb_build_object('id',id,'owner',owner,'invested_on',invested_on,'amount_cents',amount_cents) order by id) from public.garden_capital),'[]'),
 'purchases',$injection$);
 execute definition;
end;$$;
revoke all on function public.garden_partner_equalization(bigint),public.garden_partner_check_equalization(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.garden_partner_equalization(bigint) to authenticated;
notify pgrst,'reload schema';
