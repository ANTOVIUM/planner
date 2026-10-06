-- Proposed, NOT applied. Requires explicit approval to change existing grants.
-- For the existing ANTOVIUM project; no new database or tables.
begin;
alter function public.set_updated_at() set search_path = '';
alter function public.log_task_history() set search_path = '';
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.log_task_history() from public, anon, authenticated;
revoke all privileges on table public.projects, public.tasks, public.thoughts,
  public.user_settings, public.task_history, public.quotes from anon, authenticated;
grant select, insert, update, delete on table public.projects, public.tasks,
  public.thoughts, public.user_settings to authenticated;
grant select, insert on table public.task_history to authenticated;
grant select on table public.quotes to authenticated;
commit;
