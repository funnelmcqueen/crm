-- End every Supabase Auth session of one user (docs/DEVIATIONS.md D31).
--
-- Disabling, reactivating and deleting an agent all end the agent's sessions. The app used to call
-- DELETE /auth/v1/admin/users/<id>/sessions, which only localbase implemented: hosted Supabase Auth has
-- no admin route that signs a user out by id (auth-js's admin.signOut needs that user's own access
-- token). This function does what that route stood for, and what Auth's own "sign out everywhere" does
-- (models.Logout): delete the user's rows in auth.sessions. Their refresh tokens go with them
-- (auth.refresh_tokens.session_id is ON DELETE CASCADE), and /auth/v1/user rejects an access token whose
-- session_id no longer exists, which is what getUser() in src/proxy.ts and the request context call.
--
-- Service role only: the server calls it with the Auth admin client, next to the ban.

create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;

  delete from auth.sessions s
   where s.user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
