// Review round 2: a bulk reassign larger than REASSIGN_CHUNK_SIZE is several reassign_leads calls.
// When a later chunk fails, the earlier chunks have already committed, but the admin was shown a
// plain error with no number in it, so they cannot tell whether anything moved (and a retry moves a
// different set than they expect). The error has to state how many leads moved.
import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import { bulkReassign, REASSIGN_CHUNK_SIZE } from '@/server/services/agents';
import { fakeContext, fakeSupabase, type QueryCall } from './fake-supabase';

const FROM = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TO = 'bbbbbbbb-0000-4000-8000-00000000000b';

const TOTAL = REASSIGN_CHUNK_SIZE + 100;
const LEAD_IDS = Array.from({ length: TOTAL }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`);

/** The first chunk commits, the second fails. */
function failOnSecondChunk() {
  let rpcCalls = 0;
  return (call: QueryCall) => {
    if (call.target === 'from:leads') return { data: LEAD_IDS.map((id) => ({ id })), error: null };
    if (call.target === 'rpc:reassign_leads') {
      rpcCalls += 1;
      const ids = (call.payload as { p_lead_ids: string[] }).p_lead_ids;
      if (rpcCalls === 1) return { data: ids.length, error: null };
      return { data: null, error: { code: '40001', message: 'could not serialize access' } };
    }
    throw new Error(`unexpected call ${call.target}`);
  };
}

describe('a bulk reassign that fails partway', () => {
  it('reports how many leads were already moved', async () => {
    const { client } = fakeSupabase(failOnSecondChunk());
    const error = await bulkReassign(fakeContext(client), { fromUserId: FROM, toUserId: TO }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).message;
    // The admin needs the count in the message they actually see.
    expect(message, `message was: ${message}`).toContain(String(REASSIGN_CHUNK_SIZE));
  });

  it('still reports the full count when every chunk succeeds', async () => {
    const { client } = fakeSupabase((call: QueryCall) => {
      if (call.target === 'from:leads') return { data: LEAD_IDS.map((id) => ({ id })), error: null };
      if (call.target === 'rpc:reassign_leads') {
        return { data: (call.payload as { p_lead_ids: string[] }).p_lead_ids.length, error: null };
      }
      throw new Error(`unexpected call ${call.target}`);
    });
    expect(await bulkReassign(fakeContext(client), { fromUserId: FROM, toUserId: TO })).toEqual({ count: TOTAL });
  });
});
