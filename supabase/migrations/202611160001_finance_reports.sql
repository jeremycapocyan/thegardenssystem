-- One read-only MVCC snapshot for the complete finance PDF, including ROI.
create function public.garden_finance_report_snapshot() returns jsonb
language plpgsql stable security invoker set search_path='' as $$begin
 if not public.garden_is_member() then
  raise exception 'Finance viewing permission required.' using errcode='42501';
 end if;
 return jsonb_build_object('finance',public.garden_snapshot(),'roi',public.garden_roi_snapshot(),
  'generated_at',statement_timestamp(),'prepared_by',(select display_name from public.garden_profiles where id=auth.uid()));
end;$$;
revoke all on function public.garden_finance_report_snapshot() from public,anon;
grant execute on function public.garden_finance_report_snapshot() to authenticated;
notify pgrst,'reload schema';
