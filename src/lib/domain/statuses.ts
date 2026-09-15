/** Same order as the `lead_status` enum (SPEC section 6). */
export const LEAD_STATUSES = [
  'NEW',
  'TO_CALL',
  'NO_ANSWER',
  'VOICEMAIL',
  'CONNECTED',
  'INTERESTED',
  'FOLLOW_UP',
  'APPOINTMENT',
  'PROPOSAL',
  'CLIENT',
  'NOT_INTERESTED',
  'DO_NOT_CONTACT',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

export const STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  NEW: 'New',
  TO_CALL: 'To Call',
  NO_ANSWER: 'No Answer',
  VOICEMAIL: 'Voicemail',
  CONNECTED: 'Connected',
  INTERESTED: 'Interested',
  FOLLOW_UP: 'Follow Up',
  APPOINTMENT: 'Appointment',
  PROPOSAL: 'Proposal',
  CLIENT: 'Client',
  NOT_INTERESTED: 'Not Interested',
  DO_NOT_CONTACT: 'Do Not Contact',
};

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'gold' | 'danger' | 'muted';

/** Semantic badge tone per status. Gold is reserved for the win (CLIENT). */
export const STATUS_TONE: Readonly<Record<LeadStatus, StatusTone>> = {
  NEW: 'neutral',
  TO_CALL: 'info',
  NO_ANSWER: 'warning',
  VOICEMAIL: 'warning',
  CONNECTED: 'info',
  INTERESTED: 'success',
  FOLLOW_UP: 'warning',
  APPOINTMENT: 'success',
  PROPOSAL: 'success',
  CLIENT: 'gold',
  NOT_INTERESTED: 'muted',
  DO_NOT_CONTACT: 'danger',
};

export type PipelineColumnKey =
  | 'NEW'
  | 'TO_CALL'
  | 'CONNECTED'
  | 'INTERESTED'
  | 'APPOINTMENT'
  | 'PROPOSAL'
  | 'CLIENT'
  | 'NOT_INTERESTED'
  | 'DO_NOT_CONTACT';

export interface PipelineColumn {
  readonly key: PipelineColumnKey;
  readonly label: string;
  /** Statuses whose cards sit in this column. */
  readonly statuses: readonly LeadStatus[];
  /** Status set when a card is dropped on this column. */
  readonly dropStatus: LeadStatus;
  /** Hidden behind "Show closed". */
  readonly closed: boolean;
}

export const PIPELINE_COLUMNS: readonly PipelineColumn[] = [
  { key: 'NEW', label: 'New', statuses: ['NEW'], dropStatus: 'NEW', closed: false },
  {
    key: 'TO_CALL',
    label: 'To Call',
    statuses: ['TO_CALL', 'NO_ANSWER', 'VOICEMAIL'],
    dropStatus: 'TO_CALL',
    closed: false,
  },
  {
    key: 'CONNECTED',
    label: 'Connected',
    statuses: ['CONNECTED', 'FOLLOW_UP'],
    dropStatus: 'CONNECTED',
    closed: false,
  },
  { key: 'INTERESTED', label: 'Interested', statuses: ['INTERESTED'], dropStatus: 'INTERESTED', closed: false },
  { key: 'APPOINTMENT', label: 'Appointment', statuses: ['APPOINTMENT'], dropStatus: 'APPOINTMENT', closed: false },
  { key: 'PROPOSAL', label: 'Proposal', statuses: ['PROPOSAL'], dropStatus: 'PROPOSAL', closed: false },
  { key: 'CLIENT', label: 'Client', statuses: ['CLIENT'], dropStatus: 'CLIENT', closed: false },
];

export const CLOSED_PIPELINE_COLUMNS: readonly PipelineColumn[] = [
  {
    key: 'NOT_INTERESTED',
    label: 'Not Interested',
    statuses: ['NOT_INTERESTED'],
    dropStatus: 'NOT_INTERESTED',
    closed: true,
  },
  {
    key: 'DO_NOT_CONTACT',
    label: 'Do Not Contact',
    statuses: ['DO_NOT_CONTACT'],
    dropStatus: 'DO_NOT_CONTACT',
    closed: true,
  },
];

export function pipelineColumnFor(status: LeadStatus): PipelineColumn {
  const column = [...PIPELINE_COLUMNS, ...CLOSED_PIPELINE_COLUMNS].find((c) => c.statuses.includes(status));
  if (!column) throw new RangeError(`Unknown lead status: ${String(status)}`);
  return column;
}

const PIPELINE_BADGES: Partial<Record<LeadStatus, string>> = {
  NO_ANSWER: 'No answer',
  VOICEMAIL: 'Voicemail',
  FOLLOW_UP: 'Follow-up',
};

/** Badge for cards that share a column with other statuses (e.g. NO_ANSWER inside TO CALL). */
export function pipelineBadgeFor(status: LeadStatus): string | null {
  return PIPELINE_BADGES[status] ?? null;
}

export function isDialable(status: LeadStatus): boolean {
  return status !== 'DO_NOT_CONTACT';
}
