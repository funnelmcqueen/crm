// A lead's local time zone from its address (docs/DEVIATIONS.md D46). The dominant zone per US state: split
// states (the Florida panhandle, El Paso) use their larger zone. Anything outside the US is a guess.

const STATE_ZONES: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};

const US_COUNTRY = new Set(["", "us", "usa", "united states", "united states of america"]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

export interface LeadTimeZone {
  timeZone: string;
  /** True when the address gave nothing to go on and `fallback` (the agent's zone) is shown instead. */
  isGuess: boolean;
}

export function leadTimeZone(lead: { state: string | null; country: string | null }, fallback: string): LeadTimeZone {
  if (US_COUNTRY.has(normalize(lead.country))) {
    const state = normalize(lead.state);
    const code = state.length === 2 ? state.toUpperCase() : STATE_NAMES[state];
    const zone = code ? STATE_ZONES[code] : undefined;
    if (zone) return { timeZone: zone, isGuess: false };
  }
  return { timeZone: fallback, isGuess: true };
}
