-- Persist each profile's preferred interface language. English remains the default for existing
-- profiles and newly created accounts; only admins may change another profile's preference.
alter table public.profiles
  add column primary_locale text not null default 'en',
  add constraint profiles_primary_locale_allowed check (primary_locale in ('en', 'de'));

-- Extend the admin agent listing with the persisted locale so the edit dialog can manage it.
drop function public.admin_agent_rows();

create function public.admin_agent_rows()
returns table (
  user_id uuid,
  name text,
  email text,
  role public.user_role,
  active boolean,
  in_app_calling_enabled boolean,
  timezone text,
  primary_locale text,
  daily_call_target integer,
  leads_assigned bigint,
  dials_today bigint,
  connected_today bigint,
  interested_today bigint,
  appointments_today bigint,
  talk_seconds_today bigint,
  assigned_numbers text[],
  deleted boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with bounds as (
    select p.id,
           (date_trunc('day', now() at time zone p.timezone) at time zone p.timezone) as day_start,
           ((date_trunc('day', now() at time zone p.timezone) + interval '1 day') at time zone p.timezone) as day_end
      from public.profiles p
     where p.role in ('AGENT', 'ADMIN')
  )
  select p.id,
         p.name,
         p.email,
         p.role,
         p.active,
         p.in_app_calling_enabled,
         p.timezone,
         p.primary_locale,
         p.daily_call_target,
         coalesce(la.leads_assigned, 0)::bigint,
         coalesce(cs.dials, 0)::bigint,
         coalesce(cs.connected, 0)::bigint,
         coalesce(cs.interested, 0)::bigint,
         coalesce(cs.appointments, 0)::bigint,
         coalesce(cs.talk_seconds, 0)::bigint,
         coalesce(nums.e164s, '{}'::text[]),
         p.deleted_at is not null
    from public.profiles p
    join bounds b on b.id = p.id
    left join lateral (
      select count(*) as leads_assigned
        from public.leads l
       where l.assigned_to = p.id
    ) la on true
    left join lateral (
      select count(*) filter (where c.direction = 'OUTBOUND' and (c.outcome is not null or c.provider_call_sid is not null)) as dials,
             count(*) filter (where c.outcome is not null and c.outcome not in ('NO_ANSWER', 'VOICEMAIL', 'WRONG_NUMBER')) as connected,
             count(*) filter (where c.outcome = 'INTERESTED') as interested,
             count(*) filter (where c.outcome = 'APPOINTMENT') as appointments,
             sum(coalesce(c.duration_seconds, 0)) as talk_seconds
        from public.calls c
       where c.user_id = p.id
         and c.created_at >= b.day_start
         and c.created_at < b.day_end
    ) cs on true
    left join lateral (
      select array_agg(n.e164 order by n.e164) as e164s
        from public.phone_numbers n
       where n.assigned_to = p.id
         and n.active
    ) nums on true
   order by p.active desc, lower(p.name), p.email;
end;
$$;

revoke execute on function public.admin_agent_rows() from public, anon;
grant execute on function public.admin_agent_rows() to authenticated, service_role;
