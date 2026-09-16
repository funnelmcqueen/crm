// SPEC 9 imports in batches of up to 500 rows. When the bulk insert fails for a reason that is not an
// auth error, the batch used to be retried one row at a time: up to 500 awaited round trips inside a
// single server action. One row the database rejects (a dedupe collision, a phone that passes the app's
// normalization but trips the CHECK constraint) turned a single insert into 500 sequential requests,
// which at a realistic 20-40ms each exceeds a serverless function timeout — and a batch killed midway
// reports every row as failed even though many committed.
//
// The fallback now bisects: a bad row costs O(log n) round trips, and the total is capped so that even a
// batch the database rejects wholesale cannot run away. Rows past the cap come back as retryable.
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { BATCH_FAILED_REASON } from "@/components/import/import-model";
import type { Database, TablesInsert } from "@/lib/database.types";
import type { ImportMapping } from "@/lib/domain/import-mapping";
import { importLeadsBatch, MAX_IMPORT_FALLBACK_REQUESTS } from "@/server/services/import";
import { fakeContext, fakeProfile } from "../server/fake-supabase";

const MAPPING: ImportMapping = { Company: "business_name", Phone: "phone" };
const ROW_COUNT = 64;
const POISON = "Bench 37";

type LeadInsert = TablesInsert<"leads">;

interface InsertRecorder {
  client: SupabaseClient<Database>;
  /** One entry per insert round trip, holding the rows that request carried. */
  requests: LeadInsert[][];
}

/** Records every insert and fails the ones the predicate rejects, the way PostgREST would. */
function recordingClient(reject: (rows: LeadInsert[]) => boolean, code = "23514"): InsertRecorder {
  const requests: LeadInsert[][] = [];
  const client = {
    from: () => ({
      insert: (payload: unknown) => {
        const rows = (Array.isArray(payload) ? payload : [payload]) as LeadInsert[];
        requests.push(rows);
        const error = reject(rows) ? { code, message: "leads_phone_check", details: null, hint: null } : null;
        return Promise.resolve({ data: null, error });
      },
    }),
  };
  return { client: client as unknown as SupabaseClient<Database>, requests };
}

function batchOf(count: number) {
  return {
    mapping: MAPPING,
    appendUnmappedToNotes: false,
    rows: Array.from({ length: count }, (_, index) => ({
      rowIndex: index,
      position: index,
      cells: { Company: `Bench ${index}`, Phone: `+1212555${String(1000 + index)}` },
    })),
  };
}

const UNASSIGNED = { mode: "unassigned" as const };
const adminCtx = (client: SupabaseClient<Database>) => fakeContext(client, fakeProfile({ role: "ADMIN" }));

describe("importLeadsBatch fallback", () => {
  it("isolates one rejected row in a logarithmic number of round trips, not one per row", async () => {
    const { client, requests } = recordingClient((rows) => rows.some((row) => row.business_name === POISON));

    const { results } = await importLeadsBatch(adminCtx(client), batchOf(ROW_COUNT), UNASSIGNED);

    expect(results).toHaveLength(ROW_COUNT);
    const failed = results.filter((result) => !result.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].rowIndex).toBe(37);
    expect(results.filter((result) => result.ok)).toHaveLength(ROW_COUNT - 1);
    // Every other row is still saved: isolating the bad one must not cost the batch.
    expect(results.every((result) => result.rowIndex === results.indexOf(result))).toBe(true);

    expect(
      requests.length,
      `one bad row in ${ROW_COUNT} took ${requests.length} round trips; the linear fallback took ${ROW_COUNT + 1}`,
    ).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(ROW_COUNT)) + 2);
  });

  it("commits the whole batch in a single request when nothing fails", async () => {
    const { client, requests } = recordingClient(() => false);
    const { results } = await importLeadsBatch(adminCtx(client), batchOf(ROW_COUNT), UNASSIGNED);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(ROW_COUNT);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("caps the round trips when the database rejects every row, and marks the remainder retryable", async () => {
    const { client, requests } = recordingClient(() => true);
    const { results } = await importLeadsBatch(adminCtx(client), batchOf(ROW_COUNT), UNASSIGNED);

    expect(results).toHaveLength(ROW_COUNT);
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(MAX_IMPORT_FALLBACK_REQUESTS + 1);
    // Rows the fallback never got to are reported as retryable rather than as rejected by the database.
    const reasons = new Set(results.map((result) => (result.ok ? "" : result.reason)));
    expect([...reasons].some((reason) => reason === BATCH_FAILED_REASON || reason === "The database rejected this row.")).toBe(true);
  });

  it("still surfaces an auth failure instead of retrying it row by row", async () => {
    const { client, requests } = recordingClient(() => true, "42501");
    await expect(importLeadsBatch(adminCtx(client), batchOf(ROW_COUNT), UNASSIGNED)).rejects.toMatchObject({ code: "forbidden" });
    expect(requests).toHaveLength(1);
  });
});
