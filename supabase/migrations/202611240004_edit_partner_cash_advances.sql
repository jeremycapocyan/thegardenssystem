-- Correct the original receipt/payment in place; never post a second cash effect.
create function public.garden_partner_cash_edit(p_action text,p_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<edit_values>>
declare a public.garden_partner_cash_advances;r public.garden_partner_cash_repayments;m public.garden_cash_movements;prior public.garden_partner_cash_actions;
 opening date;today date=(now() at time zone 'Asia/Manila')::date;d date;first_due date;amount bigint;monthly bigint;paid bigint;spent bigint;
 person text;purpose text;account text;reference text;reason text;hash text;answer jsonb;item uuid;
begin
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext('gardens-partner-finance'));
 perform 1 from public.garden_profiles where id=auth.uid() for share;
 if not public.garden_is_admin() then raise exception 'Finance management permission required.' using errcode='42501';end if;
 hash=md5(p_payload::text);select * into prior from public.garden_partner_cash_actions where id=p_id;
 if found then
  if prior.action<>p_action or prior.actor_id<>auth.uid() or prior.payload_hash<>hash then raise exception 'Retry key belongs to another action.';end if;
  return prior.result;
 end if;
 if p_action not in ('edit_receipt','edit_repayment') or p_action is null then raise exception 'Unknown cash advance edit action.';end if;
 reason=btrim(p_payload->>'reason');if reason is null or length(reason) not between 1 and 1000 then raise exception 'Enter a reason for this edit.';end if;
 select start_date into opening from public.garden_cash_settings;if opening is null then raise exception 'Configure opening balances first.';end if;
 item=(p_payload->>'record_id')::uuid;account=p_payload->>'account';reference=coalesce(p_payload->>'reference','');amount=(p_payload->>'amount_cents')::bigint;
 if amount is null or amount not between 1 and 999999999999 or account is null or account not in ('cash','bank') then raise exception 'Enter a positive peso amount and choose Cash or Bank.';end if;
 perform set_config('gardens.partner_cash_write','on',true);
 if p_action='edit_receipt' then
  select * into a from public.garden_partner_cash_advances where id=item for update;
  if not found or a.voided_at is not null then raise exception 'Choose an active advance to edit.';end if;
  if (to_jsonb(a)-'created_at'-'created_by') is distinct from ((p_payload->'expected')-'created_at'-'created_by') then raise exception 'This advance changed. Close the form, refresh, and review it again.';end if;
  person=p_payload->>'owner';purpose=btrim(p_payload->>'purpose');d=(p_payload->>'received_on')::date;first_due=(p_payload->>'first_due')::date;monthly=(p_payload->>'monthly_cents')::bigint;
  if d is null or d<opening or d>today or first_due is null or first_due<d or first_due>date '2100-12-31' or monthly is null or monthly<1 or monthly>amount then raise exception 'Check receipt date, repayment date and monthly amount.';end if;
  if ((amount-1)/monthly)>(2100-extract(year from first_due)::int)*12+12-extract(month from first_due)::int then raise exception 'Choose repayment terms ending by December 2100.';end if;
  select coalesce(sum(amount_cents),0) into paid from public.garden_partner_cash_repayments where advance_id=item and voided_at is null;
  select coalesce(sum(amount_cents),0) into spent from public.garden_partner_cash_spends where advance_id=item and voided_at is null;
  if amount<paid or amount<spent then raise exception 'Cash received cannot be lower than recorded repayments or linked expense funding.';end if;
  if paid>0 and person is distinct from a.owner then raise exception 'Correct existing repayments before changing the partner.';end if;
  if exists(select 1 from public.garden_partner_cash_repayments where advance_id=item and voided_at is null and paid_on<d) or exists(select 1 from public.garden_partner_cash_spends where advance_id=item and voided_at is null and (detail->'expense'->>'paid_on')::date<d) then raise exception 'Receipt date cannot be after a linked purchase or repayment.';end if;
  select * into m from public.garden_cash_movements where id=a.receipt_id for update;
  if not found or m.kind<>'funding' or m.from_account is not null or m.amount_cents<>a.amount_cents or m.moved_on<>a.received_on or m.to_account is distinct from a.detail->>'to_account' then raise exception 'Linked receipt is inconsistent. Review its history before editing.';end if;
  if not a.owned_receipt and row(amount,d,account,reference) is distinct from row(a.amount_cents,a.received_on,m.to_account,m.reference) then raise exception 'This advance links a pre-existing receipt. Its amount, date, account and reference cannot be edited here.';end if;
  if a.owned_receipt then
   update public.garden_cash_movements set moved_on=d,to_account=account,amount_cents=amount,reference=edit_values.reference,reason=left('Partner cash advance received: '||person||' — '||purpose,1000) where id=a.receipt_id returning * into m;
  end if;
  update public.garden_partner_cash_advances set owner=person,purpose=edit_values.purpose,received_on=d,amount_cents=amount,monthly_cents=monthly,first_due=edit_values.first_due,detail=to_jsonb(m) where id=item;
  answer=jsonb_build_object('id',item,'reason',reason);
 else
  select * into r from public.garden_partner_cash_repayments where id=item for update;
  if not found or r.voided_at is not null then raise exception 'Choose an active repayment to edit.';end if;
  if (to_jsonb(r)-'created_at'-'created_by') is distinct from ((p_payload->'expected')-'created_at'-'created_by') then raise exception 'This repayment changed. Close the form, refresh, and review it again.';end if;
  if not r.owned_movement then raise exception 'This repayment links a pre-existing movement. Remove the link and choose the corrected source instead.';end if;
  select * into a from public.garden_partner_cash_advances where id=r.advance_id for update;
  if not found or a.voided_at is not null then raise exception 'Choose an active cash advance.';end if;
  d=(p_payload->>'paid_on')::date;
  if d is null or d<a.received_on or d<opening or d>today then raise exception 'Use an actual repayment date on or after receipt.';end if;
  select coalesce(sum(amount_cents),0) into paid from public.garden_partner_cash_repayments where advance_id=a.id and id<>item and voided_at is null;
  if paid+amount>a.amount_cents then raise exception 'Repayment cannot exceed the outstanding debt.';end if;
  select * into m from public.garden_cash_movements where id=r.movement_id for update;
  if not found or m.kind<>'funding' or m.to_account is not null or m.amount_cents<>r.amount_cents or m.moved_on<>r.paid_on or m.from_account is distinct from r.detail->>'from_account' then raise exception 'Linked repayment is inconsistent. Review its history before editing.';end if;
  update public.garden_cash_movements set moved_on=d,from_account=account,amount_cents=amount,reference=edit_values.reference,reason=left('Partner cash advance repayment: '||a.owner||' — '||a.purpose,1000) where id=r.movement_id returning * into m;
  update public.garden_partner_cash_repayments set paid_on=d,amount_cents=amount,detail=to_jsonb(m) where id=item;
  answer=jsonb_build_object('id',item,'advance_id',a.id,'reason',reason);
 end if;
 insert into public.garden_partner_cash_actions(id,action,actor_id,payload_hash,result) values(p_id,p_action,auth.uid(),hash,answer);
 perform set_config('gardens.partner_cash_write','off',true);
 return answer;
end;$$;
revoke all on function public.garden_partner_cash_edit(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.garden_partner_cash_edit(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
