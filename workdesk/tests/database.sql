begin;
select set_config('workdesk.test_owner',(select id::text from auth.users where not is_anonymous limit 1),true);
select set_config('workdesk.test_order',gen_random_uuid()::text,true);
select set_config('workdesk.test_payment',gen_random_uuid()::text,true);
set local role authenticated;
select set_config('request.jwt.claims',json_build_object('sub',current_setting('workdesk.test_owner'),'role','authenticated','is_anonymous',false)::text,true);
insert into public.workdesk_records(id,user_id,kind,data) values(current_setting('workdesk.test_order')::uuid,current_setting('workdesk.test_owner')::uuid,'order','{"title":"Transactional QA fixture","price":1000,"fee":100,"status":"new","deadline":"2026-10-09"}'::jsonb);
insert into public.workdesk_records(id,user_id,kind,data) values(current_setting('workdesk.test_payment')::uuid,current_setting('workdesk.test_owner')::uuid,'payment',json_build_object('orderId',current_setting('workdesk.test_order'),'amount',500,'type','receipt','date','2026-10-07'));
do $$ declare n integer; begin
 if not exists(select 1 from public.workdesk_records where id=current_setting('workdesk.test_order')::uuid) then raise exception 'Own row not visible'; end if;
 begin
  insert into public.workdesk_records(user_id,kind,data) values(current_setting('workdesk.test_owner')::uuid,'payment',json_build_object('orderId',current_setting('workdesk.test_order'),'amount',500,'type','receipt','date','2026-10-07'));
  raise exception 'Overpayment unexpectedly allowed';
 exception when raise_exception then if SQLERRM='Overpayment unexpectedly allowed' then raise; end if; end;
 begin
  delete from public.workdesk_records where id=current_setting('workdesk.test_order')::uuid;
  raise exception 'Linked order deletion unexpectedly allowed';
 exception when raise_exception then if SQLERRM='Linked order deletion unexpectedly allowed' then raise; end if; end;
 begin
  insert into public.workdesk_records(user_id,kind,data) values(current_setting('workdesk.test_owner')::uuid,'payment',json_build_object('orderId',current_setting('workdesk.test_order'),'amount',501,'type','refund','date','2026-10-07'));
  raise exception 'Overrefund unexpectedly allowed';
 exception when raise_exception then if SQLERRM='Overrefund unexpectedly allowed' then raise; end if; end;
 update public.workdesk_records set data=data||'{"notes":"changed"}',revision=2 where id=current_setting('workdesk.test_order')::uuid and revision=1;
 if not exists(select 1 from public.workdesk_records where id=current_setting('workdesk.test_order')::uuid and revision=2) then raise exception 'Revision update failed'; end if;
 update public.workdesk_records set data=data||'{"notes":"stale"}' where id=current_setting('workdesk.test_order')::uuid and revision=1;
 get diagnostics n = row_count;
 if n<>0 then raise exception 'Stale update unexpectedly allowed'; end if;
end $$;
select set_config('request.jwt.claims',json_build_object('sub',gen_random_uuid()::text,'role','authenticated','is_anonymous',false)::text,true);
do $$ declare n integer; begin
 if exists(select 1 from public.workdesk_records where id=current_setting('workdesk.test_order')::uuid) then raise exception 'Another user can see row'; end if;
 update public.workdesk_records set data='{}' where id=current_setting('workdesk.test_order')::uuid;
 get diagnostics n = row_count;
 if n<>0 then raise exception 'Another user can update row'; end if;
 begin
  insert into public.workdesk_records(user_id,kind,data) values(current_setting('workdesk.test_owner')::uuid,'task','{"title":"denied"}');
  raise exception 'Another user can insert with owner id';
 exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
 begin
  perform count(*) from public.workdesk_records;
  raise exception 'Anon access unexpectedly allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'passed: owner CRUD, cross-account isolation, anonymous denial, overpayment, overrefund, linked-delete guard, stale revision' as result;
rollback;
