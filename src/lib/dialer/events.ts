/** Fired on window after anything that can change the unheard voicemail count (the badge refetches). */
export const VOICEMAILS_CHANGED_EVENT = "fmq:voicemails-changed";

export function notifyVoicemailsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VOICEMAILS_CHANGED_EVENT));
}
