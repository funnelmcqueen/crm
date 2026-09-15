// Declarative seed plan shared by scripts/seed.ts and scripts/gen-sample-csv.ts.
// Everything here is fictional: businesses, people, `.test` domains, and phones in the
// reserved 555-0100..0199 range. Timestamps are relative (days ago / fractions of today)
// and are resolved against "now" in the caller's timezone by scripts/seed.ts.

export type UserKey = 'admin' | 'alex' | 'blair' | 'casey' | 'dana';
export type AgentKey = Exclude<UserKey, 'admin'>;
export type NumberKey = 'alex' | 'blair' | 'pool';

export type LeadStatus =
  | 'NEW'
  | 'TO_CALL'
  | 'NO_ANSWER'
  | 'VOICEMAIL'
  | 'CONNECTED'
  | 'INTERESTED'
  | 'FOLLOW_UP'
  | 'APPOINTMENT'
  | 'PROPOSAL'
  | 'CLIENT'
  | 'NOT_INTERESTED'
  | 'DO_NOT_CONTACT';

export type CallOutcome =
  | 'NO_ANSWER'
  | 'VOICEMAIL'
  | 'CONNECTED'
  | 'INTERESTED'
  | 'FOLLOW_UP'
  | 'APPOINTMENT'
  | 'NOT_INTERESTED'
  | 'WRONG_NUMBER';

export const LEAD_STATUSES: readonly LeadStatus[] = [
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
];

export const LEAD_SOURCES = ['Google Maps', 'Referral', 'Yelp', 'Website', 'Cold List'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SEED_PASSWORD = 'McQueen-dev-2026';
export const SEED_ADMIN_EMAIL = 'admin@funnelmcqueen.test';
export const COMPANY_NAME = 'Funnel McQueen';
/** ~100 years: effectively a permanent ban, lifted with ban_duration 'none'. */
export const DISABLED_BAN_DURATION = '876000h';

export interface SeedUser {
  key: UserKey;
  email: string;
  name: string;
  role: 'ADMIN' | 'AGENT';
  timezone: string;
  dailyCallTarget: number;
  disabled: boolean;
}

export const SEED_USERS: readonly SeedUser[] = [
  { key: 'admin', email: SEED_ADMIN_EMAIL, name: 'Velo Admin', role: 'ADMIN', timezone: 'America/New_York', dailyCallTarget: 50, disabled: false },
  { key: 'alex', email: 'alex@funnelmcqueen.test', name: 'Alex Rivera', role: 'AGENT', timezone: 'America/New_York', dailyCallTarget: 50, disabled: false },
  { key: 'blair', email: 'blair@funnelmcqueen.test', name: 'Blair Chen', role: 'AGENT', timezone: 'America/Chicago', dailyCallTarget: 60, disabled: false },
  { key: 'casey', email: 'casey@funnelmcqueen.test', name: 'Casey Morgan', role: 'AGENT', timezone: 'America/Los_Angeles', dailyCallTarget: 40, disabled: false },
  { key: 'dana', email: 'dana@funnelmcqueen.test', name: 'Dana Brooks', role: 'AGENT', timezone: 'America/New_York', dailyCallTarget: 50, disabled: true },
];

export function seedUser(key: UserKey): SeedUser {
  const user = SEED_USERS.find((u) => u.key === key);
  if (!user) throw new Error(`unknown seed user ${key}`);
  return user;
}

export interface SeedPhoneNumber {
  key: NumberKey;
  e164: string;
  label: string;
  assignedTo: AgentKey | null;
}

export const SEED_PHONE_NUMBERS: readonly SeedPhoneNumber[] = [
  { key: 'alex', e164: '+14155550150', label: 'Alex direct', assignedTo: 'alex' },
  { key: 'blair', e164: '+14155550151', label: 'Blair direct', assignedTo: 'blair' },
  { key: 'pool', e164: '+14155550152', label: 'Pool 1', assignedTo: null },
];

/** Caller ID the Twilio webhook would pick: the agent's own number, else the pool. */
export function callerNumberFor(agent: AgentKey): NumberKey {
  return agent === 'alex' || agent === 'blair' ? agent : 'pool';
}

/** Caller of the admin-only unmatched voicemail. Must not match any seed lead. */
export const UNMATCHED_VOICEMAIL = {
  remoteE164: '+13055550199',
  number: 'pool' as NumberKey,
  daysAgo: 1,
  localHour: 18,
  localMinute: 40,
  timezone: 'America/New_York',
  voicemailSeconds: 21,
};

export interface CallPlan {
  /** Whole days before today in the caller's timezone. 0 means earlier today. */
  day: number;
  /** Position within the day: 0..1 across today's window (required for day 0) or across 9:00-17:30 local. */
  at?: number;
  /** null only for an inbound voicemail that nobody has logged yet. */
  outcome: CallOutcome | null;
  /** Defaults to the lead owner. Set to show history made by a previous owner. */
  by?: AgentKey;
  direction?: 'OUTBOUND' | 'INBOUND';
  mode?: 'IN_APP' | 'TEL';
  notes?: string;
  /** Inbound voicemail length; the row gets a recording SID and handled_at null. */
  voicemailSeconds?: number;
}

export type FollowUpDue =
  | { kind: 'now' }
  | { kind: 'overdue'; daysAgo: number }
  | { kind: 'later-today'; fraction: number }
  | { kind: 'upcoming'; daysAhead: number; hour: number }
  | { kind: 'completed'; daysAgo: number };

export interface FollowUpPlan {
  due: FollowUpDue;
  note: string;
}

export interface SeedLead {
  ref: string;
  owner: AgentKey | null;
  businessName: string;
  contactName: string;
  areaCode: string;
  /** Subscriber line inside the fictional range, '0100'..'0199'. */
  line: string;
  email?: string;
  website?: string;
  address: string;
  city: string;
  state: string;
  source: LeadSource;
  status: LeadStatus;
  notes?: string;
  createdDaysAgo: number;
  calls?: CallPlan[];
  followUps?: FollowUpPlan[];
}

export function leadE164(lead: Pick<SeedLead, 'areaCode' | 'line'>): string {
  return `+1${lead.areaCode}555${lead.line}`;
}

export function leadPhoneRaw(lead: Pick<SeedLead, 'areaCode' | 'line'>): string {
  return `(${lead.areaCode}) 555-${lead.line}`;
}

export const SEED_LEADS: readonly SeedLead[] = [
  // Alex Rivera (America/New_York, Alex direct)
  {
    ref: 'alex-01', owner: 'alex', businessName: 'Harbor Point Plumbing', contactName: 'Mike Delgado',
    areaCode: '212', line: '0101', email: 'mike@harborpointplumbing.test', website: 'harborpointplumbing.test',
    address: '418 W 49th St', city: 'New York', state: 'NY', source: 'Google Maps', status: 'NEW', createdDaysAgo: 3,
  },
  {
    ref: 'alex-02', owner: 'alex', businessName: 'Brightside Family Dentistry', contactName: 'Dr. Priya Nair',
    areaCode: '718', line: '0102', website: 'www.brightsidedental.test', address: '72 Court St', city: 'Brooklyn', state: 'NY',
    source: 'Referral', status: 'NEW', createdDaysAgo: 5,
    notes: 'Two locations. The front desk manager handles vendor calls.',
  },
  {
    ref: 'alex-03', owner: 'alex', businessName: 'Empire Roofing & Gutters', contactName: 'Tony Russo',
    areaCode: '516', line: '0103', address: '1180 Hempstead Tpke', city: 'Uniondale', state: 'NY',
    source: 'Cold List', status: 'TO_CALL', createdDaysAgo: 14,
  },
  {
    ref: 'alex-04', owner: 'alex', businessName: 'Steinway Auto Care', contactName: 'Luis Ortega',
    areaCode: '718', line: '0104', address: '31-18 Steinway St', city: 'Astoria', state: 'NY',
    source: 'Yelp', status: 'NO_ANSWER', createdDaysAgo: 20,
    calls: [
      { day: 4, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.08, outcome: 'NO_ANSWER' },
    ],
  },
  {
    ref: 'alex-05', owner: 'alex', businessName: 'Palisade Fitness Club', contactName: 'Jenna Walsh',
    areaCode: '201', line: '0105', email: 'jenna@palisadefitness.test', website: 'https://palisadefitness.test',
    address: '300 Sylvan Ave', city: 'Englewood Cliffs', state: 'NJ', source: 'Google Maps', status: 'NO_ANSWER', createdDaysAgo: 18,
    calls: [
      { day: 6, outcome: 'NO_ANSWER', mode: 'TEL' },
      { day: 2, outcome: 'NO_ANSWER' },
      { day: 1, outcome: 'NO_ANSWER' },
    ],
  },
  {
    ref: 'alex-06', owner: 'alex', businessName: 'Beacon Hill Law Group', contactName: 'Sarah Whitman',
    areaCode: '617', line: '0106', website: 'beaconhilllaw.test', address: '45 Charles St', city: 'Boston', state: 'MA',
    source: 'Website', status: 'VOICEMAIL', createdDaysAgo: 22,
    calls: [
      { day: 5, outcome: 'NO_ANSWER' },
      { day: 2, outcome: 'VOICEMAIL', notes: 'Left a voicemail on the intake line about call handling.' },
      { day: 0, at: 0.6, outcome: null, direction: 'INBOUND', voicemailSeconds: 34 },
    ],
    followUps: [{ due: { kind: 'now' }, note: 'Voicemail received' }],
  },
  {
    ref: 'alex-07', owner: 'alex', businessName: 'Greenway Landscaping', contactName: 'Carlos Mendez',
    areaCode: '516', line: '0107', address: '55 Jericho Tpke', city: 'Mineola', state: 'NY',
    source: 'Google Maps', status: 'CONNECTED', createdDaysAgo: 25,
    calls: [
      { day: 7, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.25, outcome: 'CONNECTED', notes: 'Spoke with Carlos. Busy season, wants the pricing sheet first.' },
    ],
    followUps: [{ due: { kind: 'later-today', fraction: 0.5 }, note: 'Send pricing sheet and call back' }],
  },
  {
    ref: 'alex-08', owner: 'alex', businessName: 'Sweet Crumb Bakery', contactName: 'Hannah Lee',
    areaCode: '212', line: '0108', email: 'orders@sweetcrumbbakery.test', website: 'sweetcrumbbakery.test',
    address: '211 E 14th St', city: 'New York', state: 'NY', source: 'Yelp', status: 'INTERESTED', createdDaysAgo: 16,
    notes: 'Catering orders are about 40% of revenue.',
    calls: [
      { day: 3, outcome: 'VOICEMAIL', mode: 'TEL' },
      { day: 0, at: 0.15, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.45, outcome: 'INTERESTED', direction: 'INBOUND', notes: 'Called back. Wants a demo focused on catering orders.' },
    ],
    followUps: [{ due: { kind: 'upcoming', daysAhead: 1, hour: 11 }, note: 'Demo for catering orders' }],
  },
  {
    ref: 'alex-09', owner: 'alex', businessName: 'Metro Dry Cleaners', contactName: 'David Kim',
    areaCode: '201', line: '0109', address: '88 Newark Ave', city: 'Jersey City', state: 'NJ',
    source: 'Cold List', status: 'FOLLOW_UP', createdDaysAgo: 19,
    calls: [{ day: 0, at: 0.35, outcome: 'FOLLOW_UP', notes: 'Owner is in a budget meeting this week. Call back after it.' }],
    followUps: [{ due: { kind: 'upcoming', daysAhead: 2, hour: 10 }, note: 'Call back after budget meeting' }],
  },
  {
    ref: 'alex-10', owner: 'alex', businessName: 'Cambridge Physical Therapy', contactName: 'Dr. Emily Porter',
    areaCode: '617', line: '0110', email: 'eporter@cambridgept.test', website: 'cambridgept.test',
    address: '1035 Massachusetts Ave', city: 'Cambridge', state: 'MA', source: 'Referral', status: 'APPOINTMENT', createdDaysAgo: 30,
    calls: [
      { day: 8, outcome: 'CONNECTED' },
      { day: 4, outcome: 'INTERESTED', notes: 'Dr. Porter makes the call. Needs to see the scheduling flow.' },
      { day: 0, at: 0.55, outcome: 'APPOINTMENT', notes: 'Booked a walkthrough with Dr. Porter.' },
    ],
    followUps: [
      { due: { kind: 'completed', daysAgo: 4 }, note: 'Confirm who makes the decision' },
      { due: { kind: 'upcoming', daysAhead: 3, hour: 10 }, note: 'Send walkthrough agenda' },
    ],
  },
  {
    ref: 'alex-11', owner: 'alex', businessName: 'Liberty Pest Control', contactName: 'Frank Donnelly',
    areaCode: '718', line: '0111', website: 'libertypestcontrol.test', address: '902 Fulton St', city: 'Brooklyn', state: 'NY',
    source: 'Google Maps', status: 'PROPOSAL', createdDaysAgo: 35,
    notes: 'Proposal sent for three service vans.',
    calls: [
      { day: 9, outcome: 'INTERESTED', mode: 'TEL' },
      { day: 6, outcome: 'APPOINTMENT', notes: 'Meeting set with Frank and his business partner.' },
    ],
    followUps: [{ due: { kind: 'overdue', daysAgo: 1 }, note: 'Check whether they reviewed the proposal' }],
  },
  {
    ref: 'alex-12', owner: 'alex', businessName: 'Hudson Yoga Studio', contactName: 'Maya Goldberg',
    areaCode: '212', line: '0112', email: 'maya@hudsonyoga.test', address: '540 W 21st St', city: 'New York', state: 'NY',
    source: 'Website', status: 'NOT_INTERESTED', createdDaysAgo: 21,
    calls: [
      { day: 3, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.7, outcome: 'NOT_INTERESTED', notes: 'Happy with their current booking provider.' },
    ],
  },

  // Blair Chen (America/Chicago, Blair direct)
  {
    ref: 'blair-01', owner: 'blair', businessName: 'Windy City Heating & Cooling', contactName: 'Ray Kowalski',
    areaCode: '312', line: '0113', website: 'windycityhvac.test', address: '1450 W Fullerton Ave', city: 'Chicago', state: 'IL',
    source: 'Google Maps', status: 'NEW', createdDaysAgo: 2,
  },
  {
    ref: 'blair-02', owner: 'blair', businessName: 'Lakeview Pediatric Dentistry', contactName: 'Dr. Aisha Grant',
    areaCode: '773', line: '0114', email: 'office@lakeviewpeds.test', address: '3130 N Broadway', city: 'Chicago', state: 'IL',
    source: 'Referral', status: 'TO_CALL', createdDaysAgo: 9,
  },
  {
    ref: 'blair-03', owner: 'blair', businessName: 'Lone Star Roofing Co.', contactName: 'Wade Harrell',
    areaCode: '214', line: '0115', address: '2201 Commerce St', city: 'Dallas', state: 'TX',
    source: 'Cold List', status: 'TO_CALL', createdDaysAgo: 12,
  },
  {
    ref: 'blair-04', owner: 'blair', businessName: 'Main Street Dental Care', contactName: 'Dr. Kevin Tran',
    areaCode: '512', line: '0116', website: 'mainstreetdentalcare.test', address: '1812 S Congress Ave', city: 'Austin', state: 'TX',
    source: 'Yelp', status: 'NO_ANSWER', createdDaysAgo: 17,
    calls: [
      { day: 5, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.2, outcome: 'NO_ANSWER' },
    ],
  },
  {
    ref: 'blair-05', owner: 'blair', businessName: 'Bayou City Auto Repair', contactName: 'Marcus Bell',
    areaCode: '713', line: '0117', address: '4410 Washington Ave', city: 'Houston', state: 'TX',
    source: 'Google Maps', status: 'VOICEMAIL', createdDaysAgo: 20,
    calls: [
      { day: 6, outcome: 'NO_ANSWER', mode: 'TEL' },
      { day: 3, outcome: 'VOICEMAIL' },
    ],
    followUps: [{ due: { kind: 'overdue', daysAgo: 1 }, note: 'Second attempt after voicemail' }],
  },
  {
    ref: 'blair-06', owner: 'blair', businessName: 'North Loop CrossFit', contactName: 'Tess Lindqvist',
    areaCode: '612', line: '0118', email: 'tess@northloopcrossfit.test', website: 'northloopcrossfit.test',
    address: '212 N 3rd Ave', city: 'Minneapolis', state: 'MN', source: 'Website', status: 'CONNECTED', createdDaysAgo: 24,
    notes: 'Reassigned from Casey.',
    calls: [
      { day: 8, outcome: 'NO_ANSWER', by: 'casey' },
      { day: 0, at: 0.5, outcome: 'CONNECTED', notes: 'Gym manager is open to a call next week and asked for pricing.' },
    ],
    followUps: [{ due: { kind: 'later-today', fraction: 0.6 }, note: 'Email pricing before end of day' }],
  },
  {
    ref: 'blair-07', owner: 'blair', businessName: 'Pilsen Bakery & Cafe', contactName: 'Rosa Jimenez',
    areaCode: '312', line: '0119', website: 'pilsenbakery.test', address: '1830 S Blue Island Ave', city: 'Chicago', state: 'IL',
    source: 'Yelp', status: 'INTERESTED', createdDaysAgo: 15,
    calls: [
      { day: 4, outcome: 'NO_ANSWER' },
      { day: 0, at: 0.8, outcome: 'INTERESTED', notes: 'Wants online ordering live before the holidays.' },
    ],
    followUps: [{ due: { kind: 'upcoming', daysAhead: 4, hour: 14 }, note: 'Send holiday ordering case study' }],
  },
  {
    ref: 'blair-08', owner: 'blair', businessName: 'Hill Country Landscaping', contactName: 'Dale Whitaker',
    areaCode: '512', line: '0120', address: '9100 Research Blvd', city: 'Austin', state: 'TX',
    source: 'Cold List', status: 'FOLLOW_UP', createdDaysAgo: 26,
    calls: [
      { day: 7, outcome: 'CONNECTED', mode: 'TEL' },
      { day: 4, outcome: 'FOLLOW_UP', notes: 'Call back when his crew is back from a job site.' },
    ],
    followUps: [{ due: { kind: 'overdue', daysAgo: 2 }, note: 'Call back, crew back from job site' }],
  },
  {
    ref: 'blair-09', owner: 'blair', businessName: 'Uptown Law Partners', contactName: 'Angela Foster',
    areaCode: '214', line: '0121', email: 'afoster@uptownlawpartners.test', website: 'uptownlawpartners.test',
    address: '2626 Cole Ave', city: 'Dallas', state: 'TX', source: 'Referral', status: 'APPOINTMENT', createdDaysAgo: 28,
    calls: [
      { day: 9, outcome: 'NO_ANSWER' },
      { day: 5, outcome: 'INTERESTED' },
      { day: 2, outcome: 'APPOINTMENT', direction: 'INBOUND', notes: 'Called back and booked a consult for next week.' },
    ],
    followUps: [{ due: { kind: 'completed', daysAgo: 2 }, note: 'Confirm consult time' }],
  },
  {
    ref: 'blair-10', owner: 'blair', businessName: 'Heights Chiropractic', contactName: 'Dr. Nina Patel',
    areaCode: '713', line: '0122', website: 'heightschiro.test', address: '1901 Yale St', city: 'Houston', state: 'TX',
    source: 'Google Maps', status: 'CLIENT', createdDaysAgo: 38,
    notes: 'Signed the annual plan. Onboarding complete.',
    calls: [
      { day: 10, outcome: 'CONNECTED' },
      { day: 8, outcome: 'APPOINTMENT', notes: 'Demo booked with Dr. Patel and the office manager.' },
    ],
    followUps: [{ due: { kind: 'completed', daysAgo: 6 }, note: 'Send onboarding checklist' }],
  },
  {
    ref: 'blair-11', owner: 'blair', businessName: 'Gold Coast Pet Grooming', contactName: 'Brian Mueller',
    areaCode: '773', line: '0123', address: '1011 N Clark St', city: 'Chicago', state: 'IL',
    source: 'Yelp', status: 'NOT_INTERESTED', createdDaysAgo: 19,
    calls: [{ day: 3, outcome: 'NOT_INTERESTED', mode: 'TEL', notes: 'Books through a franchise system. No need.' }],
  },
  {
    ref: 'blair-12', owner: 'blair', businessName: 'Deep Ellum Print Shop', contactName: 'Jorge Salinas',
    areaCode: '214', line: '0124', email: 'jorge@deepellumprint.test', address: '2700 Elm St', city: 'Dallas', state: 'TX',
    source: 'Google Maps', status: 'NO_ANSWER', createdDaysAgo: 13,
    calls: [{ day: 2, outcome: 'NO_ANSWER' }],
  },

  // Casey Morgan (America/Los_Angeles, pool number)
  {
    ref: 'casey-01', owner: 'casey', businessName: 'Sunset Boulevard Dental', contactName: 'Dr. Lena Park',
    areaCode: '310', line: '0125', website: 'sunsetblvddental.test', address: '8500 Sunset Blvd', city: 'West Hollywood', state: 'CA',
    source: 'Google Maps', status: 'NEW', createdDaysAgo: 1,
  },
  {
    ref: 'casey-02', owner: 'casey', businessName: 'Rain City Plumbing', contactName: 'Owen Fischer',
    areaCode: '206', line: '0126', address: '4020 Leary Way NW', city: 'Seattle', state: 'WA',
    source: 'Cold List', status: 'NEW', createdDaysAgo: 4,
  },
  {
    ref: 'casey-03', owner: 'casey', businessName: 'Rose City Roofing', contactName: 'Grant Olsen',
    areaCode: '503', line: '0127', email: 'grant@rosecityroofing.test', address: '2130 SE Division St', city: 'Portland', state: 'OR',
    source: 'Referral', status: 'TO_CALL', createdDaysAgo: 11,
  },
  {
    ref: 'casey-04', owner: 'casey', businessName: 'Desert Sun Solar', contactName: 'Megan Ruiz',
    areaCode: '602', line: '0128', website: 'desertsunsolar.test', address: '3302 N 24th St', city: 'Phoenix', state: 'AZ',
    source: 'Google Maps', status: 'NO_ANSWER', createdDaysAgo: 23,
    calls: [
      { day: 8, outcome: 'NO_ANSWER', mode: 'TEL' },
      { day: 3, outcome: 'NO_ANSWER' },
    ],
  },
  {
    ref: 'casey-05', owner: 'casey', businessName: 'Mission Bay Fitness', contactName: 'Andre Coleman',
    areaCode: '619', line: '0129', email: 'andre@missionbayfitness.test', website: 'missionbayfitness.test',
    address: '2750 Garnet Ave', city: 'San Diego', state: 'CA', source: 'Yelp', status: 'VOICEMAIL', createdDaysAgo: 21,
    calls: [{ day: 5, outcome: 'VOICEMAIL' }],
    followUps: [{ due: { kind: 'upcoming', daysAhead: 5, hour: 10 }, note: 'Retry after voicemail' }],
  },
  {
    ref: 'casey-06', owner: 'casey', businessName: 'Echo Park Auto Body', contactName: 'Victor Alvarez',
    areaCode: '213', line: '0130', address: '1600 W Sunset Blvd', city: 'Los Angeles', state: 'CA',
    source: 'Google Maps', status: 'VOICEMAIL', createdDaysAgo: 18,
    calls: [
      { day: 7, outcome: 'NO_ANSWER' },
      { day: 2, outcome: 'VOICEMAIL', mode: 'TEL', notes: 'Left a voicemail about fleet repair scheduling.' },
    ],
  },
  {
    ref: 'casey-07', owner: 'casey', businessName: 'Vegas Valley Pool Service', contactName: 'Tammy Nguyen',
    areaCode: '702', line: '0131', website: 'vegasvalleypools.test', address: '5025 S Eastern Ave', city: 'Las Vegas', state: 'NV',
    source: 'Website', status: 'CONNECTED', createdDaysAgo: 27,
    calls: [
      { day: 6, outcome: 'NO_ANSWER' },
      { day: 4, outcome: 'CONNECTED', direction: 'INBOUND', notes: 'Returned our call with general questions. Not ready yet.' },
    ],
  },
  {
    ref: 'casey-08', owner: 'casey', businessName: 'Pike Place Florist', contactName: 'Ingrid Sorensen',
    areaCode: '206', line: '0132', email: 'ingrid@pikeplaceflorist.test', address: '1501 Pike Pl', city: 'Seattle', state: 'WA',
    source: 'Referral', status: 'INTERESTED', createdDaysAgo: 20,
    calls: [{ day: 3, outcome: 'INTERESTED', notes: 'Interested in a wedding season campaign.' }],
    followUps: [{ due: { kind: 'later-today', fraction: 0.3 }, note: 'Send wedding season examples' }],
  },
  {
    ref: 'casey-09', owner: 'casey', businessName: 'Venice Canal Landscaping', contactName: 'Jake Morrison',
    areaCode: '310', line: '0133', address: '1220 Abbot Kinney Blvd', city: 'Venice', state: 'CA',
    source: 'Cold List', status: 'FOLLOW_UP', createdDaysAgo: 22,
    calls: [{ day: 6, outcome: 'FOLLOW_UP', mode: 'TEL', notes: 'Call back once the new foreman starts.' }],
    followUps: [{ due: { kind: 'overdue', daysAgo: 3 }, note: 'Call back, new foreman started' }],
  },
  {
    ref: 'casey-10', owner: 'casey', businessName: 'Camelback Family Law', contactName: 'Rebecca Stone',
    areaCode: '602', line: '0134', email: 'rstone@camelbackfamilylaw.test', website: 'camelbackfamilylaw.test',
    address: '2398 E Camelback Rd', city: 'Phoenix', state: 'AZ', source: 'Website', status: 'APPOINTMENT', createdDaysAgo: 33,
    calls: [
      { day: 9, outcome: 'CONNECTED' },
      { day: 5, outcome: 'APPOINTMENT', notes: 'Consult booked with Rebecca.' },
      { day: 1, outcome: 'NO_ANSWER', notes: 'Confirmation call, no answer.' },
    ],
    followUps: [{ due: { kind: 'upcoming', daysAhead: 7, hour: 13 }, note: 'Consult follow-up' }],
  },
  {
    ref: 'casey-11', owner: 'casey', businessName: 'Pearl District Bakery', contactName: 'Chloe Martin',
    areaCode: '503', line: '0135', website: 'pearldistrictbakery.test', address: '1120 NW Couch St', city: 'Portland', state: 'OR',
    source: 'Yelp', status: 'CLIENT', createdDaysAgo: 40,
    notes: 'Signed. Wants monthly check-ins.',
    calls: [
      { day: 10, outcome: 'INTERESTED' },
      { day: 7, outcome: 'APPOINTMENT', notes: 'Tasting-room meeting with Chloe.' },
    ],
    followUps: [{ due: { kind: 'completed', daysAgo: 5 }, note: 'Kickoff call recap' }],
  },
  {
    ref: 'casey-12', owner: 'casey', businessName: 'Gaslamp Moving Co.', contactName: 'Sam Ortiz',
    areaCode: '619', line: '0136', address: '455 Market St', city: 'San Diego', state: 'CA',
    source: 'Cold List', status: 'DO_NOT_CONTACT', createdDaysAgo: 16,
    notes: 'Number belongs to a residence. Do not call.',
    calls: [{ day: 4, outcome: 'WRONG_NUMBER', notes: 'Wrong number — reached a residence.' }],
  },

  // Dana Brooks (disabled; leads still assigned so the admin warning banner shows)
  {
    ref: 'dana-01', owner: 'dana', businessName: 'Peachtree Pest Solutions', contactName: 'Calvin Reid',
    areaCode: '404', line: '0137', address: '1180 Peachtree St NE', city: 'Atlanta', state: 'GA',
    source: 'Google Maps', status: 'TO_CALL', createdDaysAgo: 30,
  },
  {
    ref: 'dana-02', owner: 'dana', businessName: 'Buckhead Smiles Dental', contactName: 'Dr. Olivia Hart',
    areaCode: '404', line: '0138', website: 'buckheadsmiles.test', address: '3344 Peachtree Rd NE', city: 'Atlanta', state: 'GA',
    source: 'Referral', status: 'NO_ANSWER', createdDaysAgo: 29,
    calls: [
      { day: 10, outcome: 'NO_ANSWER', mode: 'TEL' },
      { day: 8, outcome: 'NO_ANSWER' },
    ],
  },
  {
    ref: 'dana-03', owner: 'dana', businessName: 'Tampa Bay Pressure Washing', contactName: 'Kyle Jensen',
    areaCode: '813', line: '0139', address: '2502 N Rocky Point Dr', city: 'Tampa', state: 'FL',
    source: 'Cold List', status: 'FOLLOW_UP', createdDaysAgo: 28,
    calls: [{ day: 9, outcome: 'FOLLOW_UP', notes: 'Asked for a callback next week.' }],
    followUps: [{ due: { kind: 'overdue', daysAgo: 3 }, note: 'Callback requested' }],
  },
  {
    ref: 'dana-04', owner: 'dana', businessName: 'Ybor City Barbershop', contactName: 'Rafael Cruz',
    areaCode: '813', line: '0140', email: 'rafael@yborcitybarbers.test', address: '1600 E 7th Ave', city: 'Tampa', state: 'FL',
    source: 'Yelp', status: 'INTERESTED', createdDaysAgo: 31,
    calls: [{ day: 7, outcome: 'INTERESTED', notes: 'Liked the appointment reminder idea.' }],
  },

  // Unassigned
  {
    ref: 'pool-01', owner: null, businessName: 'Mile High Garage Doors', contactName: 'Brent Cooper',
    areaCode: '303', line: '0141', website: 'milehighgaragedoors.test', address: '4700 Brighton Blvd', city: 'Denver', state: 'CO',
    source: 'Cold List', status: 'NEW', createdDaysAgo: 6,
  },
  {
    ref: 'pool-02', owner: null, businessName: 'Music Row Recording Studio', contactName: 'Shelby Tate',
    areaCode: '615', line: '0142', email: 'shelby@musicrowstudio.test', address: '1024 16th Ave S', city: 'Nashville', state: 'TN',
    source: 'Website', status: 'NEW', createdDaysAgo: 7,
  },
  {
    ref: 'pool-03', owner: null, businessName: 'Queen City Carpet Cleaning', contactName: 'Derek Hollis',
    areaCode: '704', line: '0143', address: '2315 Freedom Dr', city: 'Charlotte', state: 'NC',
    source: 'Google Maps', status: 'NEW', createdDaysAgo: 8,
  },
  {
    ref: 'pool-04', owner: null, businessName: 'Cherry Creek Dermatology', contactName: 'Dr. Allison Reyes',
    areaCode: '303', line: '0144', website: 'cherrycreekderm.test', address: '3773 Cherry Creek N Dr', city: 'Denver', state: 'CO',
    source: 'Referral', status: 'TO_CALL', createdDaysAgo: 10,
    notes: 'Prefers email before a call.',
  },
  {
    ref: 'pool-05', owner: null, businessName: 'East Nashville Electric', contactName: 'Travis Boone',
    areaCode: '615', line: '0145', address: '1011 Gallatin Ave', city: 'Nashville', state: 'TN',
    source: 'Yelp', status: 'TO_CALL', createdDaysAgo: 12,
  },
];

export function seedLead(ref: string): SeedLead {
  const lead = SEED_LEADS.find((l) => l.ref === ref);
  if (!lead) throw new Error(`unknown seed lead ${ref}`);
  return lead;
}

const OUTCOME_TO_STATUS: Record<CallOutcome, LeadStatus> = {
  NO_ANSWER: 'NO_ANSWER',
  VOICEMAIL: 'VOICEMAIL',
  CONNECTED: 'CONNECTED',
  INTERESTED: 'INTERESTED',
  FOLLOW_UP: 'FOLLOW_UP',
  APPOINTMENT: 'APPOINTMENT',
  NOT_INTERESTED: 'NOT_INTERESTED',
  WRONG_NUMBER: 'DO_NOT_CONTACT',
};

const NO_DOWNGRADE: readonly LeadStatus[] = ['APPOINTMENT', 'PROPOSAL', 'CLIENT'];

/** Same mapping as public.outcome_to_status: no downgrade, and DO_NOT_CONTACT is sticky. */
export function outcomeToStatus(outcome: CallOutcome, current: LeadStatus): LeadStatus {
  if (current === 'DO_NOT_CONTACT') return current;
  if ((outcome === 'NO_ANSWER' || outcome === 'VOICEMAIL') && NO_DOWNGRADE.includes(current)) return current;
  return OUTCOME_TO_STATUS[outcome];
}

/** Calls in chronological order: most days ago first, then by position within the day. */
export function chronologicalCalls(calls: readonly CallPlan[]): CallPlan[] {
  return [...calls].sort((a, b) => b.day - a.day || (a.at ?? 0.5) - (b.at ?? 0.5));
}

export function isConnectedOutcome(outcome: CallOutcome | null): boolean {
  return outcome !== null && outcome !== 'NO_ANSWER' && outcome !== 'VOICEMAIL' && outcome !== 'WRONG_NUMBER';
}

/**
 * Checks the plan's internal consistency (counts, fictional phones, status vs call history,
 * follow-up ownership). Returns human-readable problems; empty means valid.
 */
export function validateSeedPlan(): string[] {
  const problems: string[] = [];
  const leads = SEED_LEADS;

  if (leads.length !== 45) problems.push(`expected 45 leads, got ${leads.length}`);
  const perOwner = new Map<string, number>();
  for (const lead of leads) perOwner.set(lead.owner ?? 'unassigned', (perOwner.get(lead.owner ?? 'unassigned') ?? 0) + 1);
  const expectedOwners: Record<string, number> = { alex: 12, blair: 12, casey: 12, dana: 4, unassigned: 5 };
  for (const [owner, count] of Object.entries(expectedOwners)) {
    if (perOwner.get(owner) !== count) problems.push(`owner ${owner}: expected ${count} leads, got ${perOwner.get(owner) ?? 0}`);
  }

  const refs = new Set<string>();
  const phones = new Set<string>();
  const reservedPhones = new Set<string>([UNMATCHED_VOICEMAIL.remoteE164, ...SEED_PHONE_NUMBERS.map((n) => n.e164)]);
  for (const lead of leads) {
    if (refs.has(lead.ref)) problems.push(`duplicate ref ${lead.ref}`);
    refs.add(lead.ref);
    if (!/^[2-9][0-9]{2}$/.test(lead.areaCode) || lead.areaCode === '555') problems.push(`${lead.ref}: bad area code`);
    if (!/^01[0-9]{2}$/.test(lead.line)) problems.push(`${lead.ref}: line ${lead.line} outside 0100..0199`);
    const e164 = leadE164(lead);
    if (phones.has(e164)) problems.push(`${lead.ref}: duplicate phone`);
    if (reservedPhones.has(e164)) problems.push(`${lead.ref}: phone collides with a Twilio or voicemail number`);
    phones.add(e164);
    if (!lead.businessName.trim()) problems.push(`${lead.ref}: empty business name`);
    if (/[^\x20-\x7e—]/.test(lead.businessName + lead.city)) problems.push(`${lead.ref}: non-ASCII name or city`);
  }

  for (const status of LEAD_STATUSES) {
    if (!leads.some((l) => l.status === status)) problems.push(`status ${status} not covered`);
  }

  let openFollowUps = 0;
  let completedFollowUps = 0;
  let inboundAnswered = 0;
  let inboundVoicemails = 0;
  const todayCallsByAgent = new Map<AgentKey, number>();
  let historyFromPreviousOwner = false;

  for (const lead of leads) {
    const calls = lead.calls ?? [];
    if (lead.owner === null && calls.length > 0) problems.push(`${lead.ref}: unassigned lead with calls`);
    if (lead.owner === null && (lead.followUps ?? []).length > 0) problems.push(`${lead.ref}: unassigned lead with follow-ups`);

    const seenDays = new Map<number, CallPlan[]>();
    for (const call of calls) {
      if (!Number.isInteger(call.day) || call.day < 0 || call.day > 10) problems.push(`${lead.ref}: call day ${call.day} outside 0..10`);
      if (call.day === 0 && (call.at === undefined || call.at <= 0 || call.at >= 1)) problems.push(`${lead.ref}: today's call needs 0 < at < 1`);
      if (call.at !== undefined && (call.at <= 0 || call.at >= 1)) problems.push(`${lead.ref}: at must be in (0, 1)`);
      const sameDay = seenDays.get(call.day) ?? [];
      sameDay.push(call);
      seenDays.set(call.day, sameDay);
      if (call.day >= lead.createdDaysAgo) problems.push(`${lead.ref}: call before the lead was created`);
      const direction = call.direction ?? 'OUTBOUND';
      if (direction === 'OUTBOUND' && call.outcome === null) problems.push(`${lead.ref}: outbound call without outcome`);
      if (call.outcome === null && call.voicemailSeconds === undefined) problems.push(`${lead.ref}: unlogged call must be a voicemail`);
      if (call.voicemailSeconds !== undefined && (direction !== 'INBOUND' || call.outcome !== null)) {
        problems.push(`${lead.ref}: voicemail rows are inbound and unlogged`);
      }
      if (direction === 'INBOUND' && call.mode === 'TEL') problems.push(`${lead.ref}: inbound calls arrive through Twilio`);
      if (call.by !== undefined && call.by !== lead.owner) {
        if (direction !== 'OUTBOUND') problems.push(`${lead.ref}: only outbound history may come from a previous owner`);
        historyFromPreviousOwner = true;
      }
      if (direction === 'INBOUND' && call.outcome !== null) inboundAnswered++;
      if (call.voicemailSeconds !== undefined) inboundVoicemails++;
      const caller = call.by ?? lead.owner;
      if (call.day === 0 && caller) todayCallsByAgent.set(caller, (todayCallsByAgent.get(caller) ?? 0) + 1);
    }
    for (const [day, sameDay] of seenDays) {
      if (sameDay.length > 1 && sameDay.some((c) => c.at === undefined)) problems.push(`${lead.ref}: several calls on day ${day} need explicit at`);
    }

    const logged = chronologicalCalls(calls).filter((c): c is CallPlan & { outcome: CallOutcome } => c.outcome !== null);
    if (logged.length === 0) {
      if (lead.status !== 'NEW' && lead.status !== 'TO_CALL') problems.push(`${lead.ref}: status ${lead.status} without logged calls`);
    } else {
      const derived = logged.reduce<LeadStatus>((status, call) => outcomeToStatus(call.outcome, status), 'NEW');
      const manualMove = (lead.status === 'PROPOSAL' || lead.status === 'CLIENT') && derived === 'APPOINTMENT';
      if (lead.status !== derived && !manualMove) problems.push(`${lead.ref}: status ${lead.status} but calls lead to ${derived}`);
    }

    for (const followUp of lead.followUps ?? []) {
      const due = followUp.due;
      if (due.kind === 'completed') {
        completedFollowUps++;
        if (due.daysAgo < 1) problems.push(`${lead.ref}: completed follow-up must be at least 1 day ago`);
      } else {
        openFollowUps++;
      }
      if (due.kind === 'overdue' && (due.daysAgo < 1 || due.daysAgo > 3)) problems.push(`${lead.ref}: overdue must be 1..3 days`);
      if (due.kind === 'upcoming' && (due.daysAhead < 1 || due.daysAhead > 7)) problems.push(`${lead.ref}: upcoming must be 1..7 days`);
      if (due.kind === 'later-today' && (due.fraction <= 0 || due.fraction >= 1)) problems.push(`${lead.ref}: later-today fraction in (0, 1)`);
    }
    if (lead.status === 'FOLLOW_UP' && !(lead.followUps ?? []).some((f) => f.due.kind !== 'completed')) {
      problems.push(`${lead.ref}: FOLLOW_UP lead without an open follow-up`);
    }
  }

  if (openFollowUps !== 15) problems.push(`expected 15 open follow-ups, got ${openFollowUps}`);
  if (completedFollowUps !== 4) problems.push(`expected 4 completed follow-ups, got ${completedFollowUps}`);
  if (inboundAnswered !== 3) problems.push(`expected 3 answered inbound calls, got ${inboundAnswered}`);
  if (inboundVoicemails !== 1) problems.push(`expected 1 lead voicemail, got ${inboundVoicemails}`);
  if (!historyFromPreviousOwner) problems.push('expected one lead with history from a previous owner');
  const alexToday = todayCallsByAgent.get('alex') ?? 0;
  if (alexToday < 6 || alexToday > 8) problems.push(`expected 6-8 calls today for Alex, got ${alexToday}`);
  if ((todayCallsByAgent.get('blair') ?? 0) !== 3) problems.push(`expected 3 calls today for Blair, got ${todayCallsByAgent.get('blair') ?? 0}`);

  return problems;
}
