-- SALES-OS v0.1. Dedicated tables; does not change existing Jarvis data.
begin;

create table if not exists public.salesos_members (
  id uuid primary key,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role text not null default 'member' check (role in ('admin','member')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Backend-owned durable objects. JSON payloads preserve the official ChatKit
-- item schema without silently dropping SDK fields. Each namespace has its own
-- owner/id uniqueness; owner is always derived from verified authentication.
create table if not exists public.salesos_records (
  namespace text not null,
  id text not null,
  owner_id uuid not null references public.salesos_members(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(namespace,id)
);
create index if not exists salesos_records_owner_namespace_idx
  on public.salesos_records(owner_id,namespace,updated_at desc);
create index if not exists salesos_records_payload_idx
  on public.salesos_records using gin(data jsonb_path_ops);

alter table public.salesos_members enable row level security;
alter table public.salesos_records enable row level security;
do $$
begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='salesos_members' and policyname='salesos_member_self_read') then
    create policy salesos_member_self_read on public.salesos_members
      for select to authenticated using (auth_user_id=auth.uid());
  end if;
end $$;
-- No direct client record access. Server validates the verified employee on
-- every operation; encrypted OAuth tokens/device credentials stay server-only.
revoke all on public.salesos_records from anon,authenticated;
revoke insert,update,delete on public.salesos_members from anon,authenticated;
grant select on public.salesos_members to authenticated;
grant all on public.salesos_members,public.salesos_records to service_role;

-- Compare-and-swap prevents replay races for one-use OAuth/enrollment tokens,
-- competing device workers and job cancellation. Callable only by our backend.
create or replace function public.salesos_cas_record(
  p_namespace text,p_id text,p_owner_id uuid,p_revision bigint,p_data jsonb
) returns setof public.salesos_records language sql security invoker
set search_path=public as $$
  update public.salesos_records set data=p_data,revision=revision+1,updated_at=now()
  where namespace=p_namespace and id=p_id and owner_id=p_owner_id and revision=p_revision
  returning *;
$$;
revoke all on function public.salesos_cas_record(text,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.salesos_cas_record(text,text,uuid,bigint,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('salesos-files','salesos-files',false,10485760,array[
  'image/png','image/jpeg','image/webp','text/plain','text/markdown','text/csv',
  'application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]) on conflict(id) do nothing;
-- No public/authenticated storage policy: API issues scoped, short-lived links.
commit;
