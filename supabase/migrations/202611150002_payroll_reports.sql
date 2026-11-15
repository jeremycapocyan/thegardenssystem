-- Report artifacts and mail credentials are never browser-readable tables.
create table public.garden_payroll_reports(
 id uuid primary key,payroll_id uuid not null references public.garden_payroll,created_by uuid not null references public.garden_profiles,
 data jsonb not null,created_at timestamptz not null default now(),state text not null default 'creating' check(state in ('creating','ready')),
 render_token uuid not null default gen_random_uuid(),render_until timestamptz not null default now()+interval '90 seconds',
 sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),file_bytes integer check(file_bytes>0),
 check(state<>'ready' or (sha256 is not null and file_bytes is not null))
);
create index garden_reports_payroll on public.garden_payroll_reports(payroll_id,created_at desc);
create table public.garden_payroll_deliveries(
 id uuid primary key,report_id uuid not null references public.garden_payroll_reports,actor_id uuid not null references public.garden_profiles,
 recipient text not null,status text not null default 'reserved' check(status in ('reserved','sending','sent','failed','unconfirmed')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),gmail_message_id text,error_code text
);
create index garden_deliveries_report on public.garden_payroll_deliveries(report_id,created_at desc);
create unique index garden_report_one_dispatch on public.garden_payroll_deliveries(report_id) where status in ('reserved','sending');
create table public.garden_payroll_mail_connection(
 id boolean primary key default true check(id),version uuid not null default gen_random_uuid(),sender text not null check(sender='theplaymakers2026@gmail.com'),
 encrypted_token text not null,connected boolean not null default true,connected_by uuid not null references public.garden_profiles,updated_at timestamptz not null default now()
);
create table public.garden_payroll_oauth_state(
 state_hash text primary key,actor_id uuid not null references public.garden_profiles,encrypted_verifier text not null,expires_at timestamptz not null,used boolean not null default false
);
do $$declare n text;begin
 foreach n in array array['garden_payroll_reports','garden_payroll_deliveries','garden_payroll_mail_connection','garden_payroll_oauth_state'] loop
 execute format('alter table public.%I enable row level security',n);
 execute format('revoke all on public.%I from public,anon,authenticated',n);
 if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant select,insert,update,delete on public.%I to service_role',n);end if;
 end loop;
end;$$;
-- No generic snapshot audit on OAuth/credential tables, including encrypted values.
do $$begin
 if to_regclass('storage.buckets') is not null then
 insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('garden-payroll-reports','garden-payroll-reports',false,10485760,array['application/pdf']) on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf'];
 execute $policy$create policy gardens_reports_server_only on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'garden-payroll-reports') with check(bucket_id<>'garden-payroll-reports')$policy$;
 end if;
end;$$;

create function public.garden_report_actor(p_actor uuid,p_owner boolean default false) returns void
language plpgsql stable security definer set search_path='' as $$begin
 if not exists(select 1 from public.garden_profiles where id=p_actor and active and role='admin' and (case when p_owner then is_owner else is_owner or team_access end)) then
 raise exception 'Employee and payroll management permission required.' using errcode='42501';end if;
end;$$;
revoke all on function public.garden_report_actor(uuid,boolean) from public,anon,authenticated;

create function public.garden_prepare_payroll_report(p_actor uuid,p_payroll uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.garden_payroll;e public.garden_employees;r public.garden_payroll_reports;paid bigint;payments jsonb;stamp timestamptz;payload jsonb;begin
 perform public.garden_report_actor(p_actor);
 if p_id is null or p_payroll is null then raise exception 'Choose a finalized payroll statement.';end if;
 perform pg_advisory_xact_lock(hashtextextended('report:'||p_id::text,0));
 select * into r from public.garden_payroll_reports where id=p_id for update;
 if found then
  if r.payroll_id<>p_payroll or r.created_by<>p_actor then raise exception 'Report reference already used.';end if;
  if r.state='ready' or r.render_until>now() then return jsonb_build_object('report',to_jsonb(r)-'render_token','claimed',false);end if;
  update public.garden_payroll_reports set render_token=gen_random_uuid(),render_until=now()+interval '90 seconds' where id=p_id returning * into r;
  return jsonb_build_object('report',to_jsonb(r),'claimed',true);
 end if;
 select * into p from public.garden_payroll where id=p_payroll;
 if not found then raise exception 'Finalize payroll before generating this report.';end if;
 perform pg_advisory_xact_lock(hashtext(p.employee_id::text));
 select * into e from public.garden_employees where id=p.employee_id;
 stamp=clock_timestamp();
 select coalesce(sum(amount_cents),0),coalesce(jsonb_agg(jsonb_build_object('paid_on',paid_on,'amount_cents',amount_cents,'reference',reference) order by paid_on,created_at,id),'[]')
 into paid,payments from public.garden_staff_cash where kind='salary' and payroll_id=p.id;
 payload=jsonb_build_object('id',p_id,'employee',jsonb_build_object('id',e.id,'name',e.name,'employee_code',e.employee_code,'email',e.email),
 'statement',to_jsonb(p),'payments',payments,'paid_cents',paid,'balance_cents',p.payable_cents-paid,
 'payment_status',case when paid>=p.payable_cents then 'Paid' when paid>0 then 'Partially paid' else 'Unpaid' end,
 'generated_at',stamp,'prepared_by',(select display_name from public.garden_profiles where id=p_actor));
 insert into public.garden_payroll_reports(id,payroll_id,created_by,data) values(p_id,p_payroll,p_actor,payload) returning * into r;
 return jsonb_build_object('report',to_jsonb(r),'claimed',true);
end;$$;
create function public.garden_finish_payroll_report(p_id uuid,p_token uuid,p_hash text,p_bytes integer) returns void
language plpgsql security definer set search_path='' as $$begin
 update public.garden_payroll_reports set state='ready',sha256=p_hash,file_bytes=p_bytes where id=p_id and render_token=p_token and state='creating';
 if not found then raise exception 'Report creation was not confirmed. Refresh report history.';end if;
end;$$;

create function public.garden_payroll_report_history(p_payroll uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform public.garden_report_actor(auth.uid());
 return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'payroll_id',r.payroll_id,'created_at',r.created_at,'state',r.state,
 'recipient',r.data->'employee'->>'email','payment_status',r.data->>'payment_status','paid_cents',r.data->'paid_cents','balance_cents',r.data->'balance_cents','can_retry',r.state='creating' and r.render_until<=now() and r.created_by=auth.uid(),
 'deliveries',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'status',case when d.status='sending' and d.updated_at<now()-interval '2 minutes' then 'unconfirmed' when d.status='reserved' and d.updated_at<now()-interval '2 minutes' then 'failed' else d.status end,
 'recipient',d.recipient,'created_at',d.created_at,'updated_at',d.updated_at,'error_code',d.error_code) order by d.created_at desc) from public.garden_payroll_deliveries d where d.report_id=r.id),'[]')) order by r.created_at desc) from public.garden_payroll_reports r where r.payroll_id=p_payroll),'[]');
end;$$;
revoke all on function public.garden_payroll_report_history(uuid) from public,anon;
grant execute on function public.garden_payroll_report_history(uuid) to authenticated;

create function public.garden_begin_report_delivery(p_actor uuid,p_report uuid,p_id uuid,p_resend boolean,p_ack boolean) returns jsonb
language plpgsql security definer set search_path='' as $$declare r public.garden_payroll_reports;d public.garden_payroll_deliveries;email text;begin
 perform public.garden_report_actor(p_actor);
 if p_id is null then raise exception 'Delivery reference required.';end if;
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||p_report::text,0));
 select * into r from public.garden_payroll_reports where id=p_report for update;
 if r.id is null or r.state<>'ready' then raise exception 'Generate and preview a finalized report first.';end if;
 select * into d from public.garden_payroll_deliveries where id=p_id;
 if found then
  if d.report_id<>p_report or d.actor_id<>p_actor then raise exception 'Delivery reference already used.';end if;
  return jsonb_build_object('claimed',false,'delivery',to_jsonb(d));
 end if;
 update public.garden_payroll_deliveries set status=case when status='sending' then 'unconfirmed' else 'failed' end,error_code='confirmation_timeout',updated_at=now()
 where report_id=p_report and status in ('reserved','sending') and updated_at<now()-interval '2 minutes';
 if exists(select 1 from public.garden_payroll_deliveries where report_id=p_report and status in ('reserved','sending')) then raise exception 'A send is already in progress. Refresh its status.';end if;
 if exists(select 1 from public.garden_payroll_deliveries where report_id=p_report and status in ('sent','unconfirmed')) and not coalesce(p_resend,false) then raise exception 'Choose the explicit resend action for this report.';end if;
 if exists(select 1 from public.garden_payroll_deliveries where report_id=p_report and status='unconfirmed') and not coalesce(p_ack,false) then raise exception 'Check Gmail Sent first and acknowledge that a resend may duplicate an email.';end if;
 select e.email into email from public.garden_payroll p join public.garden_employees e on e.id=p.employee_id where p.id=r.payroll_id;
 if email is distinct from r.data->'employee'->>'email' then raise exception 'Employee email changed. Generate a new report before sending.';end if;
 if not exists(select 1 from public.garden_payroll_mail_connection where connected) then raise exception 'Connect the payroll Gmail sender first.';end if;
 insert into public.garden_payroll_deliveries(id,report_id,actor_id,recipient) values(p_id,p_report,p_actor,email) returning * into d;
 return jsonb_build_object('claimed',true,'delivery',to_jsonb(d),'report',to_jsonb(r));
end;$$;
create function public.garden_dispatch_report_delivery(p_id uuid,p_connection uuid) returns void
language plpgsql security definer set search_path='' as $$declare d public.garden_payroll_deliveries;email text;begin
 select * into d from public.garden_payroll_deliveries where id=p_id for update;
 perform public.garden_report_actor(d.actor_id);
 if d.id is null or d.status<>'reserved' or d.updated_at<now()-interval '2 minutes' then raise exception 'Delivery reservation expired.';end if;
 if not exists(select 1 from public.garden_payroll_mail_connection where connected and version=p_connection) then raise exception 'Gmail connection changed. Reconnect and try again.';end if;
 select e.email into email from public.garden_payroll_reports r join public.garden_payroll p on p.id=r.payroll_id join public.garden_employees e on e.id=p.employee_id where r.id=d.report_id;
 if email is distinct from d.recipient then raise exception 'Employee email changed. Generate a new report.';end if;
 update public.garden_payroll_deliveries set status='sending',updated_at=now() where id=p_id;
end;$$;
create function public.garden_finish_report_delivery(p_id uuid,p_status text,p_message text,p_error text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_status not in ('sent','failed','unconfirmed') or (p_status='sent' and coalesce(length(p_message),0)=0) then raise exception 'Invalid delivery result.';end if;
 update public.garden_payroll_deliveries set status=p_status,gmail_message_id=p_message,error_code=p_error,updated_at=now()
 where id=p_id and status in ('reserved','sending');
end;$$;

create function public.garden_connect_payroll_mail(p_state text,p_encrypted text) returns void
language plpgsql security definer set search_path='' as $$declare s public.garden_payroll_oauth_state;begin
 perform pg_advisory_xact_lock(hashtext('gardens_payroll_mail'));
 select * into s from public.garden_payroll_oauth_state where state_hash=p_state and used and expires_at>now() for update;
 if not found then raise exception 'Gmail authorization expired or was cancelled.';end if;
 perform public.garden_report_actor(s.actor_id,true);
 insert into public.garden_payroll_mail_connection(id,sender,encrypted_token,connected_by) values(true,'theplaymakers2026@gmail.com',p_encrypted,s.actor_id)
 on conflict(id) do update set version=gen_random_uuid(),encrypted_token=excluded.encrypted_token,connected_by=excluded.connected_by,connected=true,updated_at=now();
 delete from public.garden_payroll_oauth_state where state_hash=p_state;
end;$$;
create function public.garden_disconnect_payroll_mail(p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare old_connection jsonb;begin
 perform public.garden_report_actor(p_actor,true);perform pg_advisory_xact_lock(hashtext('gardens_payroll_mail'));
 select to_jsonb(t) into old_connection from public.garden_payroll_mail_connection t where id;
 delete from public.garden_payroll_mail_connection;delete from public.garden_payroll_oauth_state;
 return old_connection;
end;$$;

do $$declare f regprocedure;begin
 foreach f in array array['public.garden_prepare_payroll_report(uuid,uuid,uuid)'::regprocedure,'public.garden_finish_payroll_report(uuid,uuid,text,integer)'::regprocedure,
 'public.garden_begin_report_delivery(uuid,uuid,uuid,boolean,boolean)'::regprocedure,'public.garden_dispatch_report_delivery(uuid,uuid)'::regprocedure,
 'public.garden_finish_report_delivery(uuid,text,text,text)'::regprocedure,'public.garden_connect_payroll_mail(text,text)'::regprocedure,'public.garden_disconnect_payroll_mail(uuid)'::regprocedure] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role',f);end if;
 end loop;
end;$$;
notify pgrst,'reload schema';
