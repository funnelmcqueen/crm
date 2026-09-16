-- localbase auth compatibility views
--
-- Applied by localbase/db.ts on EVERY boot, after bootstrap.sql and before the migrations, so a data
-- directory created before something was added here still gets it. Everything here must be idempotent.
--
-- localbase keeps its GoTrue state in localbase.sessions / localbase.refresh_tokens. App SQL that real
-- Supabase supports against the auth schema reaches that state through these views instead, with the
-- hosted column names. Expose only what migrations actually use.

-- auth.sessions: public.revoke_user_sessions deletes from it. A single-table view is auto-updatable, so
-- the delete lands on localbase.sessions and cascades to localbase.refresh_tokens, as it does on hosted
-- Supabase.
create or replace view auth.sessions as
  select s.id, s.user_id, s.aal, s.created_at, s.updated_at
    from localbase.sessions s;

revoke all on auth.sessions from public, anon, authenticated, service_role;
