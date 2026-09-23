// EXECUTE privileges on every public function, checked in the catalog and by calling them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminSqlRows,
  anonRows,
  bootDb,
  createAuthUser,
  pgError,
  serviceRows,
  userRows,
  type PGlite,
} from '../helpers/pglite';

type Access = 'none' | 'service' | 'api' | 'public_api';

/**
 * Every function in schema public must be listed here. A later migration that adds a function
 * must add it with a deliberate access level.
 * none: trigger functions (no API role). service: service_role only. api: authenticated + service_role.
 * public_api: anon too.
 */
const MATRIX: Record<string, Access> = {
  // triggers
  set_updated_at: 'none',
  profiles_validate_timezone: 'none',
  settings_validate_timezone: 'none',
  handle_new_auth_user: 'none',
  handle_auth_user_email_changed: 'none',
  follow_ups_sync_lead: 'none',
  profiles_guard: 'none',
  leads_guard: 'none',
  follow_ups_guard: 'none',
  leads_move_open_follow_ups: 'none',
  reject_deleted_owner: 'none',
  // internal helper called only by definer RPCs
  apply_rate_limit: 'none',
  // service-only
  lead_earliest_open_follow_up: 'service',
  claim_caller_id: 'service',
  apply_call_status: 'service',
  record_voicemail: 'service',
  get_voicemail_recording: 'service',
  // API
  is_privileged_role: 'api',
  is_admin: 'api',
  is_active_user: 'api',
  can_access_lead: 'api',
  outcome_to_status: 'api',
  log_call: 'api',
  get_next_lead: 'api',
  create_outbound_call: 'api',
  create_manual_outbound_call: 'api',
  get_lead_call_history: 'api',
  mark_voicemail_heard: 'api',
  list_voicemails: 'api',
  unheard_voicemail_count: 'api',
  reassign_leads: 'api',
  search_leads: 'api',
  list_lead_sources: 'api',
  touch_device_presence: 'api',
  consume_rate_limit: 'api',
  get_company_name: 'public_api',
  // stage 6 (dashboards)
  get_my_dashboard: 'api',
  admin_agent_rows: 'api',
  admin_team_totals: 'api',
  // delete agent (D40)
  admin_agent_delete_check: 'api',
  admin_delete_agent: 'api',
  revoke_user_sessions: 'service',
  // bulk lead actions (SECURITY INVOKER: RLS and the guards scope them)
  search_lead_ids: 'api',
  bulk_set_lead_status: 'api',
  bulk_assign_leads: 'api',
  bulk_schedule_follow_ups: 'api',
  bulk_complete_follow_ups: 'api',
  bulk_set_lead_source: 'api',
  bulk_delete_leads: 'api',
  export_selected_leads: 'api',
  // skipped queue
  skip_lead: 'api',
  resume_skipped_lead: 'api',
  list_skipped_leads: 'api',
  leads_resolve_skips: 'none',
  follow_ups_resolve_skips: 'none',
  // agent Today dashboard
  get_my_call_days: 'api',
  my_caller_id_available: 'api',
  // closer calendar booking (D46)
  set_lead_business_type: 'api',
  bulk_set_business_type: 'api',
  begin_appointment: 'api',
  confirm_appointment: 'api',
  abandon_appointment: 'api',
  cancel_appointment: 'api',
  booked_intervals: 'api',
  get_calendar_status: 'api',
  // Google Calendar connection (D47)
  set_bookable_hours: 'api',
  connect_calendar: 'api',
  disconnect_calendar: 'api',
  mark_calendar_broken: 'service',
  // A calendar per agent (D48)
  set_agent_calendar_id: 'service',
  clear_agent_calendars: 'service',
  // stage 7 (follow-ups)
  list_follow_ups: 'api',
  follow_up_tab_counts: 'api',
  // stage 8 (pipeline)
  pipeline_column: 'api',
  // stage 9 (import/export)
  find_duplicate_leads: 'api',
  export_leads: 'api',
  // call history (20260923002000)
  list_call_history: 'api',
  // stage 10 (agents, numbers, reports)
  admin_agent_activity: 'api',
  admin_phone_number_rows: 'api',
  admin_report_agents: 'api',
  admin_report_numbers: 'api',
  admin_report_totals: 'api',
};

const INVOKER = new Set([
  'is_privileged_role',
  'outcome_to_status',
  'search_leads',
  'list_lead_sources',
  'list_follow_ups',
  'follow_up_tab_counts',
  'pipeline_column',
  'find_duplicate_leads',
  'export_leads',
  'search_lead_ids',
  'bulk_set_lead_status',
  'bulk_assign_leads',
  'bulk_schedule_follow_ups',
  'bulk_complete_follow_ups',
  'bulk_set_lead_source',
  'bulk_delete_leads',
  'export_selected_leads',
  'list_skipped_leads',
  'bulk_set_business_type',
]);

interface FnAcl {
  proname: string;
  signature: string;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  public_exec: boolean;
  is_trigger: boolean;
  security_definer: boolean;
  config: string[] | null;
}

let db: PGlite;
let functions: FnAcl[];
const u = { admin: '', agent: '' };

beforeAll(async () => {
  db = await bootDb();
  u.admin = await createAuthUser(db, { role: 'ADMIN' });
  u.agent = await createAuthUser(db);
  functions = await adminSqlRows<FnAcl>(
    db,
    `select p.proname,
            p.oid::regprocedure::text as signature,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
            exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
            p.prorettype = 'trigger'::regtype as is_trigger,
            p.prosecdef as security_definer,
            p.proconfig as config
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
      order by 1, 2`,
  );
});

afterAll(async () => {
  await db?.close();
});

describe('function EXECUTE matrix (catalog)', () => {
  it('lists every public function', () => {
    const unknown = functions.map((f) => f.proname).filter((name) => !(name in MATRIX));
    expect(unknown, 'add new public functions to MATRIX with a deliberate access level').toEqual([]);
    const missing = Object.keys(MATRIX).filter((name) => !functions.some((f) => f.proname === name));
    expect(missing).toEqual([]);
  });

  it('matches the access level of each function', () => {
    const actual = functions.map((f) => ({
      fn: f.signature,
      anon: f.anon,
      authenticated: f.authenticated,
      service_role: f.service_role,
      public: f.public_exec,
    }));
    const expected = functions.map((f) => {
      const access = MATRIX[f.proname];
      return {
        fn: f.signature,
        anon: access === 'public_api',
        authenticated: access === 'api' || access === 'public_api',
        service_role: access !== 'none',
        public: false,
      };
    });
    expect(actual).toEqual(expected);
  });

  it('only get_company_name is executable by anon, and nothing by PUBLIC', () => {
    expect(functions.filter((f) => f.anon).map((f) => f.proname)).toEqual(['get_company_name']);
    expect(functions.filter((f) => f.public_exec).map((f) => f.signature)).toEqual([]);
  });

  it('trigger functions are not executable by any API role', () => {
    const triggers = functions.filter((f) => f.is_trigger);
    expect(triggers.length).toBeGreaterThanOrEqual(9);
    expect(triggers.filter((f) => f.anon || f.authenticated || f.service_role)).toEqual([]);
  });

  it('every function pins search_path to empty', () => {
    expect(functions.filter((f) => !(f.config ?? []).includes('search_path=""')).map((f) => f.signature)).toEqual([]);
  });

  it('only the intended helpers run as SECURITY INVOKER', () => {
    const invokers = functions.filter((f) => !f.is_trigger && !f.security_definer).map((f) => f.proname);
    expect(new Set(invokers)).toEqual(INVOKER);
  });

  it('functions added by later migrations are not granted to PUBLIC or anon by default', async () => {
    await db.exec(`create function public.zz_default_acl_probe() returns int language sql set search_path = '' as 'select 1'`);
    try {
      const [row] = await adminSqlRows<{ anon: boolean; public_exec: boolean }>(
        db,
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
           from pg_proc p where p.proname = 'zz_default_acl_probe'`,
      );
      expect(row).toEqual({ anon: false, public_exec: false });
    } finally {
      await db.exec('drop function public.zz_default_acl_probe()');
    }
  });
});

describe('function EXECUTE matrix (calls)', () => {
  const API_CALLS = [
    `select public.log_call('NO_ANSWER'::public.call_outcome)`,
    `select * from public.get_next_lead()`,
    `select public.create_outbound_call(gen_random_uuid())`,
    `select public.create_manual_outbound_call('+12125550123', 'TEL'::public.call_mode)`,
    `select * from public.get_lead_call_history(gen_random_uuid())`,
    `select public.mark_voicemail_heard(gen_random_uuid())`,
    `select * from public.list_voicemails()`,
    `select public.unheard_voicemail_count()`,
    `select public.reassign_leads('{}'::uuid[], null::uuid)`,
    `select * from public.search_leads()`,
    `select * from public.list_lead_sources()`,
    `select public.touch_device_presence()`,
    `select public.consume_rate_limit('voice_token')`,
    `select public.is_admin()`,
    `select public.can_access_lead(gen_random_uuid())`,
    `select public.get_my_dashboard()`,
    `select * from public.admin_agent_rows()`,
    `select public.admin_team_totals()`,
    `select * from public.list_follow_ups('today')`,
    `select public.follow_up_tab_counts()`,
    `select * from public.pipeline_column(array['NEW']::public.lead_status[])`,
    `select * from public.find_duplicate_leads('{}'::text[], '{}'::text[], '{}'::text[])`,
    `select * from public.export_leads()`,
    `select public.admin_agent_activity(gen_random_uuid(), now() - interval '1 day', now())`,
    `select * from public.admin_phone_number_rows()`,
    `select * from public.admin_report_agents(now() - interval '1 day', now())`,
    `select * from public.admin_report_numbers(now() - interval '1 day', now())`,
    `select public.admin_report_totals(now() - interval '1 day', now())`,
  ];
  const SERVICE_CALLS = [
    `select * from public.claim_caller_id(gen_random_uuid())`,
    `select public.apply_call_status('CAxxx', 'ringing')`,
    `select public.record_voicemail('CAxxx', 'RExxx', 1)`,
    `select public.lead_earliest_open_follow_up(gen_random_uuid())`,
    `select public.get_voicemail_recording(gen_random_uuid(), gen_random_uuid())`,
  ];
  const TRIGGER_CALLS = [`select public.set_updated_at()`, `select public.leads_guard()`, `select public.handle_new_auth_user()`];
  const INTERNAL_CALLS = [`select public.apply_rate_limit(gen_random_uuid(), 'voice_token')`];

  it.each([...API_CALLS, ...SERVICE_CALLS, ...TRIGGER_CALLS, ...INTERNAL_CALLS])('anon is denied: %s', async (sql) => {
    expect((await pgError(anonRows(db, sql))).code).toBe('42501');
  });

  it.each(INTERNAL_CALLS)('no API role, not even service_role, may call internal helpers: %s', async (sql) => {
    expect((await pgError(userRows(db, u.agent, sql))).code).toBe('42501');
    expect((await pgError(serviceRows(db, sql))).code).toBe('42501');
  });

  it('anon may read the company name', async () => {
    expect(await anonRows(db, 'select public.get_company_name() as name')).toEqual([{ name: 'Funnel McQueen' }]);
  });

  it.each([...SERVICE_CALLS, ...TRIGGER_CALLS])('authenticated (agent and admin) is denied: %s', async (sql) => {
    for (const userId of [u.agent, u.admin]) {
      expect((await pgError(userRows(db, userId, sql))).code).toBe('42501');
    }
  });

  it('admin-only RPCs reject agents with 42501', async () => {
    const err = await pgError(userRows(db, u.agent, `select public.reassign_leads(array[gen_random_uuid()], $1::uuid)`, [u.agent]));
    expect(err.code).toBe('42501');
    for (const sql of [
      `select * from public.admin_agent_rows()`,
      `select public.admin_team_totals()`,
      `select * from public.find_duplicate_leads('{}'::text[], '{}'::text[], '{}'::text[])`,
      `select public.admin_agent_activity(gen_random_uuid(), now() - interval '1 day', now())`,
      `select * from public.admin_phone_number_rows()`,
      `select * from public.admin_report_agents(now() - interval '1 day', now())`,
      `select * from public.admin_report_numbers(now() - interval '1 day', now())`,
      `select public.admin_report_totals(now() - interval '1 day', now())`,
    ]) {
      expect((await pgError(userRows(db, u.agent, sql))).code, sql).toBe('42501');
    }
  });

  it('service_role may call the webhook functions', async () => {
    expect(await serviceRows(db, `select * from public.claim_caller_id(gen_random_uuid())`)).toEqual([]);
    expect(await serviceRows(db, `select public.apply_call_status('CA-missing', 'ringing') as ok`)).toEqual([{ ok: false }]);
  });

  it('service-only functions refuse API-role JWT claims even if a grant were widened', async () => {
    for (const role of ['authenticated', 'anon']) {
      const err = await pgError(
        db.transaction(async (tx) => {
          await tx.exec('set local role service_role');
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, sub: u.agent })]);
          return tx.query(`select * from public.claim_caller_id($1)`, [u.agent]);
        }),
      );
      expect(err.code).toBe('42501');
      const recording = await pgError(
        db.transaction(async (tx) => {
          await tx.exec('set local role service_role');
          await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, sub: u.agent })]);
          return tx.query(`select public.get_voicemail_recording(gen_random_uuid(), $1)`, [u.agent]);
        }),
      );
      expect(recording.code).toBe('42501');
    }
  });
});
