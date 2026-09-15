/** Twilio SIDs: a two-letter type prefix plus 32 hex characters. Checked before any SID reaches a URL. */
export const CALL_SID_PATTERN = /^CA[0-9a-fA-F]{32}$/;
export const RECORDING_SID_PATTERN = /^RE[0-9a-fA-F]{32}$/;
export const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
export const PHONE_NUMBER_SID_PATTERN = /^PN[0-9a-fA-F]{32}$/;
export const APPLICATION_SID_PATTERN = /^AP[0-9a-fA-F]{32}$/;

export function isCallSid(value: unknown): value is string {
  return typeof value === "string" && CALL_SID_PATTERN.test(value);
}

export function isRecordingSid(value: unknown): value is string {
  return typeof value === "string" && RECORDING_SID_PATTERN.test(value);
}
