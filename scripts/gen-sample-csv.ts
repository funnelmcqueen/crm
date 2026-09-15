// npm run samples:csv → samples/leads.csv (header + 100 rows) for exercising the admin import.
// Headers deliberately differ from CRM field names so the mapping screen has work to do.
// Output is deterministic; rerunning produces a byte-identical file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { isMainModule } from './lib/main-module';
import { mulberry32, pick, randInt, shuffle } from './lib/prng';
import { seedLead } from './lib/seed-data';

export const CSV_HEADERS = [
  'Company',
  'Contact Person',
  'Phone Number',
  'E-mail',
  'Website URL',
  'Street Address',
  'City',
  'State',
  'Country',
  'Lead Source',
  'Notes',
  'Industry',
  'Employees',
] as const;

export type SampleCsvHeader = (typeof CSV_HEADERS)[number];
export type SampleCsvRow = Record<SampleCsvHeader, string>;

export const SAMPLE_ROW_COUNT = 100;
const CSV_PRNG_SEED = 20260915;

/**
 * What the import preview should report for this file, assuming a row that is both a
 * duplicate and invalid counts as invalid, and only the later row of an in-file pair is flagged.
 */
export const EXPECTED_IMPORT_PREVIEW = { ready: 92, possibleDuplicates: 5, invalid: 3 } as const;

/** 0-based data-row indexes (header excluded) of the intentional test rows. */
export const SPECIAL_ROWS = {
  invalidMissingCompany: 7,
  seedDuplicateByPhone: 12,
  formulaNote: 40,
  seedDuplicateByWebsite: 29,
  seedDuplicateByNameCity: 47,
  invalidPhoneNA: 58,
  invalidPhoneTooShort: 76,
  inFilePhonePair: [20, 64],
  inFileWebsitePair: [35, 91],
  notesWithCommaAndQuotes: 15,
  notesWithNewline: 23,
  notesWithCommaQuotesNewline: 52,
} as const;

// Area codes deliberately disjoint from the seed leads (only the intentional duplicates reuse seed phones).
const MARKETS = [
  { areaCode: '646', city: 'New York', state: 'NY' },
  { areaCode: '347', city: 'Brooklyn', state: 'NY' },
  { areaCode: '872', city: 'Chicago', state: 'IL' },
  { areaCode: '469', city: 'Dallas', state: 'TX' },
  { areaCode: '737', city: 'Austin', state: 'TX' },
  { areaCode: '346', city: 'Houston', state: 'TX' },
  { areaCode: '628', city: 'San Francisco', state: 'CA' },
  { areaCode: '424', city: 'Los Angeles', state: 'CA' },
  { areaCode: '858', city: 'San Diego', state: 'CA' },
  { areaCode: '971', city: 'Portland', state: 'OR' },
  { areaCode: '480', city: 'Scottsdale', state: 'AZ' },
  { areaCode: '725', city: 'Las Vegas', state: 'NV' },
  { areaCode: '470', city: 'Atlanta', state: 'GA' },
  { areaCode: '786', city: 'Miami', state: 'FL' },
  { areaCode: '720', city: 'Denver', state: 'CO' },
  { areaCode: '629', city: 'Nashville', state: 'TN' },
  { areaCode: '980', city: 'Charlotte', state: 'NC' },
] as const;

const NAME_PREFIXES = [
  'Summit', 'Evergreen', 'Blue Ridge', 'Ironwood', 'Silver Oak', 'Keystone', 'Northstar', 'Redwood', 'Cornerstone', 'Clearwater',
  'Granite Peak', 'Oak Hollow', 'Maple Leaf', 'Copper Canyon', 'Bright Harbor', 'Twin Pines', 'Lakeside', 'Pioneer', 'Hometown', 'Riverbend',
] as const;

const INDUSTRIES = [
  { industry: 'Plumbing', noun: 'Plumbing' },
  { industry: 'Roofing', noun: 'Roofing' },
  { industry: 'Dental', noun: 'Dental Studio' },
  { industry: 'Fitness', noun: 'Fitness' },
  { industry: 'Landscaping', noun: 'Landscaping' },
  { industry: 'Legal', noun: 'Law Office' },
  { industry: 'Bakery', noun: 'Bakery' },
  { industry: 'Automotive', noun: 'Auto Repair' },
  { industry: 'HVAC', noun: 'Heating & Air' },
  { industry: 'Veterinary', noun: 'Animal Clinic' },
] as const;

const FIRST_NAMES = [
  'Aaron', 'Beth', 'Carmen', 'Derek', 'Elena', 'Felix', 'Gina', 'Hector', 'Irene', 'Jamal', 'Kara', 'Leo', 'Monica',
  'Nate', 'Olga', 'Pete', 'Quinn', 'Rita', 'Stan', 'Tina', 'Umar', 'Vera', 'Wes', 'Yara', 'Zack',
] as const;

const LAST_NAMES = [
  'Abbott', 'Barnes', 'Castillo', 'Dawson', 'Ellis', 'Flores', 'Gibson', 'Hayes', 'Ingram', 'Jacobs', 'Keller', 'Lambert', 'Mercer',
  'Nolan', 'Owens', 'Pruitt', 'Quintero', 'Ramsey', 'Sutton', 'Tucker', 'Underwood', 'Vaughn', 'Whitley', 'Young', 'Zamora',
] as const;

const STREETS = ['Main St', 'Oak Ave', 'Market St', 'Commerce Dr', 'Park Blvd', 'Elm St', 'Industrial Pkwy', 'Center St', 'Lake Rd', 'Broadway'] as const;
const COUNTRIES = ['US', 'US', 'US', 'USA', 'United States'] as const;
const SOURCES = ['Google Maps', 'Yelp', 'Referral', 'Website', 'Cold List', 'Trade Show', 'LinkedIn'] as const;
const EMPLOYEES = ['1-5', '6-10', '11-25', '26-50', '3', '12', '40'] as const;
const PLAIN_NOTES = [
  'Asked for a brochure.',
  'Seasonal business.',
  'Owner is usually on site.',
  'Runs two service trucks.',
  'Recently renovated.',
  'Opens at 7am.',
] as const;

function lineFor(index: number): string {
  return String(100 + index).padStart(4, '0');
}

/** Four human formats; all normalize to +1<area>555<line>. */
function formatPhone(areaCode: string, line: string, style: number): string {
  switch (style % 4) {
    case 0:
      return `(${areaCode}) 555-${line}`;
    case 1:
      return `${areaCode}.555.${line}`;
    case 2:
      return `+1 ${areaCode} 555 ${line}`;
    default:
      return `${areaCode}555${line}`;
  }
}

function formatWebsite(domain: string, style: number): string {
  switch (style % 4) {
    case 0:
      return domain;
    case 1:
      return `www.${domain}`;
    case 2:
      return `https://${domain}`;
    default:
      return `http://www.${domain}/`;
  }
}

function bareDomain(website: string): string {
  return website
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

function applySpecialRows(rows: SampleCsvRow[]): void {
  const at = (index: number): SampleCsvRow => {
    const row = rows[index];
    if (!row) throw new Error(`special row ${index} out of range`);
    return row;
  };

  at(SPECIAL_ROWS.invalidMissingCompany).Company = '';

  const byPhone = seedLead('alex-01');
  Object.assign(at(SPECIAL_ROWS.seedDuplicateByPhone), {
    Company: 'HP Plumbing Services',
    'Phone Number': formatPhone(byPhone.areaCode, byPhone.line, 1),
    'E-mail': '',
    'Website URL': '',
    City: 'Manhattan',
    State: 'NY',
    Industry: 'Plumbing',
    Notes: 'Found on a contractor directory.',
  } satisfies Partial<SampleCsvRow>);

  const byWebsite = seedLead('alex-10');
  if (!byWebsite.website) throw new Error('alex-10 must have a website');
  Object.assign(at(SPECIAL_ROWS.seedDuplicateByWebsite), {
    Company: 'Cambridge PT & Sports Rehab',
    'Phone Number': formatPhone('857', lineFor(SPECIAL_ROWS.seedDuplicateByWebsite), 0),
    'E-mail': '',
    'Website URL': `https://www.${bareDomain(byWebsite.website)}/contact`,
    City: 'Somerville',
    State: 'MA',
    Industry: 'Physical Therapy',
  } satisfies Partial<SampleCsvRow>);

  const byNameCity = seedLead('blair-04');
  Object.assign(at(SPECIAL_ROWS.seedDuplicateByNameCity), {
    Company: byNameCity.businessName.toUpperCase().replace('DENTAL CARE', 'DENTAL-CARE'),
    'Phone Number': formatPhone('737', lineFor(SPECIAL_ROWS.seedDuplicateByNameCity), 3),
    'E-mail': '',
    'Website URL': '',
    City: byNameCity.city.toLowerCase(),
    State: byNameCity.state,
    Industry: 'Dental',
  } satisfies Partial<SampleCsvRow>);

  at(SPECIAL_ROWS.invalidPhoneNA)['Phone Number'] = 'N/A';
  at(SPECIAL_ROWS.invalidPhoneTooShort)['Phone Number'] = '12345';

  const [phoneFirst, phoneSecond] = SPECIAL_ROWS.inFilePhonePair;
  const firstPhoneRow = at(phoneFirst);
  const firstMarket = MARKETS[phoneFirst % MARKETS.length];
  Object.assign(at(phoneSecond), {
    Company: `${firstPhoneRow.Company} LLC`,
    'Phone Number': formatPhone(firstMarket.areaCode, lineFor(phoneFirst), phoneFirst + 2),
    'Website URL': '',
    City: firstPhoneRow.City,
    State: firstPhoneRow.State,
    Industry: firstPhoneRow.Industry,
  } satisfies Partial<SampleCsvRow>);

  const [siteFirst, siteSecond] = SPECIAL_ROWS.inFileWebsitePair;
  const firstSiteRow = at(siteFirst);
  const siteDomain = `${firstSiteRow.Company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`;
  firstSiteRow['Website URL'] = siteDomain;
  at(siteSecond)['Website URL'] = `http://www.${siteDomain}/about-us`;

  at(SPECIAL_ROWS.notesWithCommaAndQuotes).Notes = 'Owner said "call after 3pm, not before"';
  at(SPECIAL_ROWS.notesWithNewline).Notes = 'Gate code 4412\nAsk for the office manager, not the owner';
  at(SPECIAL_ROWS.notesWithCommaQuotesNewline).Notes = 'Met at the expo, "very keen"\nWants pricing, a brochure, and references';
  at(SPECIAL_ROWS.formulaNote).Notes = '=HYPERLINK("https://promo.example.test","Click for details")';
}

export function buildSampleRows(): SampleCsvRow[] {
  const rng = mulberry32(CSV_PRNG_SEED);
  const combos = shuffle(
    rng,
    NAME_PREFIXES.flatMap((prefix) => INDUSTRIES.map((industry) => ({ prefix, industry }))),
  );
  const rows: SampleCsvRow[] = [];
  for (let i = 0; i < SAMPLE_ROW_COUNT; i++) {
    const { prefix, industry } = combos[i];
    const market = MARKETS[i % MARKETS.length];
    const company = `${prefix} ${industry.noun}`;
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const hasEmail = rng() < 0.6;
    const hasWebsite = rng() < 0.5;
    const websiteStyle = randInt(rng, 0, 3);
    const street = `${randInt(rng, 100, 9899)} ${pick(rng, STREETS)}`;
    const country = pick(rng, COUNTRIES);
    const source = pick(rng, SOURCES);
    const note = rng() < 0.3 ? pick(rng, PLAIN_NOTES) : '';
    const employees = pick(rng, EMPLOYEES);
    rows.push({
      Company: company,
      'Contact Person': `${first} ${last}`,
      'Phone Number': formatPhone(market.areaCode, lineFor(i), i),
      'E-mail': hasEmail ? `${first.toLowerCase()}@${slug}.test` : '',
      'Website URL': hasWebsite ? formatWebsite(`${slug}.test`, websiteStyle) : '',
      'Street Address': street,
      City: market.city,
      State: market.state,
      Country: country,
      'Lead Source': source,
      Notes: note,
      Industry: industry.industry,
      Employees: employees,
    });
  }
  applySpecialRows(rows);
  return rows;
}

export function renderSampleCsv(rows: readonly SampleCsvRow[]): string {
  const csv = Papa.unparse(
    { fields: [...CSV_HEADERS], data: rows.map((row) => CSV_HEADERS.map((header) => row[header])) },
    { newline: '\n', escapeFormulae: false },
  );
  return `${csv}\n`;
}

function main(): void {
  const rows = buildSampleRows();
  if (rows.length !== SAMPLE_ROW_COUNT) throw new Error(`expected ${SAMPLE_ROW_COUNT} rows, built ${rows.length}`);
  const outPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'leads.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderSampleCsv(rows), 'utf8');
  const { ready, possibleDuplicates, invalid } = EXPECTED_IMPORT_PREVIEW;
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}: ${rows.length} rows.`);
  console.log(`Expected import preview: ${ready} ready · ${possibleDuplicates} possible duplicates · ${invalid} invalid`);
}

if (isMainModule(import.meta.url)) main();
