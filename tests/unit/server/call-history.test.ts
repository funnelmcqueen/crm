import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/server/context';
import { listCallHistory } from '@/server/services/calls';

const agentId = randomUUID();
const otherId = randomUUID();
const callId = randomUUID();
const leadId = randomUUID();

const row = {
  call_id: callId,
  created_at: '2026-09-23T12:00:00+00:00',
  lead_id: leadId,
  business_name: 'Acme Roofing',
  contact_name: 'Sam',
  remote_e164: '+12125550100',
  user_id: agentId,
  agent_name: 'Call Agent',
  direction: 'INBOUND',
  outcome: null,
  call_status: 'no-answer',
  duration_seconds: 0,
  has_voicemail: false,
  voicemail_duration_seconds: null,
  handled_at: null,
  total_count: 1,
};

function context(role: 'AGENT' | 'ADMIN', result: unknown[] = [row]) {
  const rpc = vi.fn().mockResolvedValue({ data: result, error: null });
  const ctx = { userId: agentId, profile: { active: true, role }, supabase: { rpc } } as unknown as RequestContext;
  return { ctx, rpc };
}

describe('listCallHistory', () => {
  it('normalizes a call and supplies the agent-owned history scope', async () => {
    const { ctx, rpc } = context('AGENT');
    const result = await listCallHistory(ctx, { tab: 'all', agentId: otherId });
    expect(result).toMatchObject({ page: 1, pageSize: 50, total: 1, tab: 'all' });
    expect(result.rows[0]).toEqual({
      id: callId, createdAt: '2026-09-23T12:00:00+00:00', leadId, businessName: 'Acme Roofing',
      contactName: 'Sam', remoteE164: '+12125550100', userId: agentId, agentName: null,
      direction: 'INBOUND', outcome: null, callStatus: 'no-answer', durationSeconds: 0,
      hasVoicemail: false, voicemailDurationSeconds: null, handledAt: null,
    });
    expect(rpc).toHaveBeenCalledWith('list_call_history', { p_tab: 'all', p_limit: 50, p_offset: 0 });
  });

  it('sends the admin agent filter and requested page', async () => {
    const { ctx, rpc } = context('ADMIN');
    await listCallHistory(ctx, { tab: 'missed', agentId: otherId, page: 2 });
    expect(rpc).toHaveBeenCalledWith('list_call_history', { p_tab: 'missed', p_agent_id: otherId, p_limit: 50, p_offset: 50 });
  });

  it('rejects malformed filters and inactive sessions before any query', async () => {
    const { ctx, rpc } = context('AGENT');
    await expect(listCallHistory(ctx, { tab: 'bogus' })).rejects.toMatchObject({ code: 'validation' });
    await expect(listCallHistory(ctx, { tab: 'all', agentId: 'bad-id' })).rejects.toMatchObject({ code: 'validation' });
    await expect(listCallHistory(ctx, { tab: 'all', page: 0 })).rejects.toMatchObject({ code: 'validation' });
    await expect(listCallHistory({ ...ctx, profile: { ...ctx.profile, active: false } }, { tab: 'all' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
