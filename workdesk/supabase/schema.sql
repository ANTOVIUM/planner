create table public.workdesk_records (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check (kind in ('order','payment','expense','time','task','settings')),
 data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 100000),
 revision integer not null default 1 check (revision > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index workdesk_user_kind on public.workdesk_records(user_id,kind);
create unique index workdesk_one_settings on public.workdesk_records(user_id) where kind = 'settings';
alter table public.workdesk_records enable row level security;
revoke all on public.workdesk_records from anon, authenticated;
grant select,insert,update,delete on public.workdesk_records to authenticated;
create policy workdesk_select on public.workdesk_records for select to authenticated using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous'),'false') = 'false');
create policy workdesk_insert on public.workdesk_records for insert to authenticated with check ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous'),'false') = 'false');
create policy workdesk_update on public.workdesk_records for update to authenticated using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous'),'false') = 'false') with check ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous'),'false') = 'false');
create policy workdesk_delete on public.workdesk_records for delete to authenticated using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous'),'false') = 'false');
create index workdesk_relations on public.workdesk_records(user_id, (data->>'orderId')) where kind in ('payment','expense','time','task');
create function public.workdesk_validate_record() returns trigger language plpgsql security invoker set search_path = '' as $$
declare
 owner_id uuid;
 d jsonb;
 k text;
 oid text;
 parent jsonb;
 payment_total numeric;
 net numeric;
begin
 owner_id := case when TG_OP = 'DELETE' then OLD.user_id else NEW.user_id end;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text, 179139));
 if TG_OP = 'UPDATE' and (NEW.user_id <> OLD.user_id or NEW.kind <> OLD.kind) then
  raise exception 'Нельзя менять владельца или тип записи';
 end if;
 if TG_OP = 'DELETE' then
  if OLD.kind = 'order' and exists(select 1 from public.workdesk_records r where r.user_id=owner_id and r.data->>'orderId'=OLD.id::text) then
   raise exception 'У заказа есть связанные записи. Используй статус Отменен';
  end if;
 else
  d:=NEW.data; k:=NEW.kind;
  if k in ('order','task') and (coalesce(length(trim(d->>'title')),0)=0 or length(d->>'title')>250) then raise exception 'Укажи название'; end if;
  if k='order' then
   if jsonb_typeof(d->'price') <> 'number' or jsonb_typeof(d->'fee') <> 'number' or (d->>'price')::numeric<0 or (d->>'fee')::numeric<0 or (d->>'fee')::numeric>(d->>'price')::numeric then raise exception 'Проверь стоимость и комиссию'; end if;
   if d->>'status' not in ('new','working','revision','delivered','done','cancelled') then raise exception 'Проверь статус'; end if;
   if coalesce(d->>'deadline','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Укажи срок'; end if;
   perform (d->>'deadline')::date;
   select coalesce(sum(case when r.data->>'type'='refund' then -(r.data->>'amount')::numeric else (r.data->>'amount')::numeric end),0) into payment_total from public.workdesk_records r where r.user_id=owner_id and r.kind='payment' and r.data->>'orderId'=NEW.id::text;
   if payment_total>(d->>'price')::numeric-(d->>'fee')::numeric then raise exception 'Сумма заказа меньше записанных платежей'; end if;
  end if;
  if k in ('payment','expense') then
   if jsonb_typeof(d->'amount') is distinct from 'number' or (d->>'amount')::numeric<=0 or (d->>'amount')::numeric>1000000000 then raise exception 'Проверь сумму'; end if;
  end if;
  if k='payment' and (coalesce(d->>'type','') not in ('receipt','refund') or coalesce(d->>'orderId','')='') then raise exception 'Выбери заказ и вид платежа'; end if;
  if k='time' and (jsonb_typeof(d->'minutes') is distinct from 'number' or (d->>'minutes')::numeric<=0 or (d->>'minutes')::numeric>1440 or coalesce(d->>'type','') not in ('work','rework')) then raise exception 'Проверь длительность и вид работы'; end if;
  if k in ('payment','expense','time') then
   if coalesce(d->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Укажи дату'; end if;
   perform (d->>'date')::date;
  end if;
  if coalesce(d->>'orderId','')<>'' then
   select r.data into parent from public.workdesk_records r where r.id::text=d->>'orderId' and r.user_id=owner_id and r.kind='order';
   if parent is null then raise exception 'Заказ не найден в твоем аккаунте'; end if;
  end if;
  if TG_OP='UPDATE' then NEW.revision:=OLD.revision+1; end if;
  NEW.updated_at:=pg_catalog.now();
 end if;
 if (TG_OP<>'INSERT' and OLD.kind='payment') or (TG_OP<>'DELETE' and NEW.kind='payment') then
  for oid in select distinct v from unnest(array[case when TG_OP<>'INSERT' then OLD.data->>'orderId' end,case when TG_OP<>'DELETE' then NEW.data->>'orderId' end]) t(v) where v is not null and v<>'' loop
   select (r.data->>'price')::numeric-(r.data->>'fee')::numeric into net from public.workdesk_records r where r.id::text=oid and r.user_id=owner_id and r.kind='order';
   select coalesce(sum(case when r.data->>'type'='refund' then -(r.data->>'amount')::numeric else (r.data->>'amount')::numeric end),0) into payment_total from public.workdesk_records r where r.user_id=owner_id and r.kind='payment' and r.data->>'orderId'=oid and r.id<>case when TG_OP='INSERT' then NEW.id else OLD.id end;
   if TG_OP<>'DELETE' and NEW.data->>'orderId'=oid then payment_total:=payment_total+case when NEW.data->>'type'='refund' then -(NEW.data->>'amount')::numeric else (NEW.data->>'amount')::numeric end; end if;
   if net is null or payment_total<0 or payment_total>net then raise exception 'Платеж нарушает баланс заказа. Проверь поступления и возвраты'; end if;
  end loop;
 end if;
 if TG_OP='DELETE' then return OLD; end if;
 return NEW;
end;
$$;
revoke all on function public.workdesk_validate_record() from public;
create trigger workdesk_record_guard before insert or update or delete on public.workdesk_records for each row execute function public.workdesk_validate_record();
