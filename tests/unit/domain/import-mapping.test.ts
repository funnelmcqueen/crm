import { describe, expect, it } from 'vitest';
import {
  CRM_IMPORT_FIELDS,
  IMPORT_FIELD_KEYS,
  countryCodeFromName,
  guessMapping,
  missingRequiredImportFields,
  normalizeHeader,
  validateImportRow,
  type ImportFieldKey,
  type ImportMapping,
} from '../../../src/lib/domain/import-mapping';

describe('CRM_IMPORT_FIELDS', () => {
  it('lists the fields in order with only business name and phone required', () => {
    expect(CRM_IMPORT_FIELDS.map((field) => field.key)).toEqual([...IMPORT_FIELD_KEYS]);
    expect(IMPORT_FIELD_KEYS).toEqual([
      'business_name',
      'contact_name',
      'phone',
      'email',
      'website',
      'address',
      'city',
      'state',
      'country',
      'source',
      'notes',
    ]);
    expect(CRM_IMPORT_FIELDS.filter((field) => field.required).map((field) => field.key)).toEqual(['business_name', 'phone']);
    for (const field of CRM_IMPORT_FIELDS) expect(field.label.length).toBeGreaterThan(0);
  });

  it('includes the documented synonyms', () => {
    const synonyms = (key: ImportFieldKey) => CRM_IMPORT_FIELDS.find((field) => field.key === key)?.synonyms ?? [];
    expect(synonyms('business_name')).toEqual(expect.arrayContaining(['Company', 'Business', 'Company Name', 'Account']));
    expect(synonyms('contact_name')).toEqual(expect.arrayContaining(['Contact', 'Contact Person', 'Name', 'Owner']));
    expect(synonyms('phone')).toEqual(expect.arrayContaining(['Phone Number', 'Tel', 'Mobile']));
    expect(synonyms('email')).toEqual(expect.arrayContaining(['E-mail', 'Email Address']));
    expect(synonyms('website')).toEqual(expect.arrayContaining(['Website URL', 'URL', 'Site', 'Domain']));
    expect(synonyms('address')).toEqual(expect.arrayContaining(['Street', 'Street Address']));
    expect(synonyms('source')).toEqual(expect.arrayContaining(['Lead Source']));
    expect(synonyms('notes')).toEqual(expect.arrayContaining(['Comments']));
  });

  it('never shares a normalized term between two fields', () => {
    const owner = new Map<string, ImportFieldKey>();
    for (const field of CRM_IMPORT_FIELDS) {
      for (const term of [field.key, field.label, ...field.synonyms]) {
        const squashed = normalizeHeader(term).replace(/ /g, '');
        const existing = owner.get(squashed);
        if (existing !== undefined) expect(existing).toBe(field.key);
        owner.set(squashed, field.key);
      }
    }
  });
});

describe('normalizeHeader', () => {
  it.each([
    ['\uFEFFE-mail_Address ', 'e mail address'],
    ['businessName', 'business name'],
    ['Phone #', 'phone'],
    ['Address1', 'address 1'],
    ['Téléphone', 'telephone'],
    ['  ', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeHeader(input)).toBe(expected);
  });
});

describe('guessMapping', () => {
  it('maps a typical lead list', () => {
    expect(
      guessMapping([
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
        'Comments',
      ]),
    ).toEqual({
      Company: 'business_name',
      'Contact Person': 'contact_name',
      'Phone Number': 'phone',
      'E-mail': 'email',
      'Website URL': 'website',
      'Street Address': 'address',
      City: 'city',
      State: 'state',
      Country: 'country',
      'Lead Source': 'source',
      Comments: 'notes',
    });
  });

  it.each<[string, ImportFieldKey]>([
    ['Business', 'business_name'],
    ['Company Name', 'business_name'],
    ['Account', 'business_name'],
    ['Business Name', 'business_name'],
    ['Organization', 'business_name'],
    ['businessName', 'business_name'],
    ['\uFEFFCompany', 'business_name'],
    ['Contact', 'contact_name'],
    ['Name', 'contact_name'],
    ['Owner', 'contact_name'],
    ['Contact Name', 'contact_name'],
    ['Full Name', 'contact_name'],
    ['  contact_name ', 'contact_name'],
    ['Phone', 'phone'],
    ['Tel', 'phone'],
    ['Mobile', 'phone'],
    ['Telephone', 'phone'],
    ['Cell Phone', 'phone'],
    ['PHONE #', 'phone'],
    ['Phone No.', 'phone'],
    ['Téléphone', 'phone'],
    ['Mobile Phone 2', 'phone'],
    ['Company Phone', 'phone'],
    ['Email', 'email'],
    ['E-mail', 'email'],
    ['Email Address', 'email'],
    ['e_mail', 'email'],
    ['E-Mail (work)', 'email'],
    ['Contact Email', 'email'],
    ['Primary Email', 'email'],
    ['Website', 'website'],
    ['URL', 'website'],
    ['Site', 'website'],
    ['Domain', 'website'],
    ['Web Site', 'website'],
    ['Homepage', 'website'],
    ['WebsiteURL', 'website'],
    ['Website (URL)', 'website'],
    ['Business Website', 'website'],
    ['Address', 'address'],
    ['Street', 'address'],
    ['Street Address', 'address'],
    ['Address Line 1', 'address'],
    ['Address1', 'address'],
    ['City', 'city'],
    ['Town', 'city'],
    ['Mailing City', 'city'],
    ['State', 'state'],
    ['Province', 'state'],
    ['State/Province', 'state'],
    ['Country', 'country'],
    ['Source', 'source'],
    ['Lead Source', 'source'],
    ['Notes', 'notes'],
    ['Comments', 'notes'],
    ['Description', 'notes'],
  ])('maps %j to %s', (header, field) => {
    expect(guessMapping([header])).toEqual({ [header]: field });
  });

  it.each(['Zip', 'Rating', 'Category', 'Real Estate', 'Account Number', 'Last Name', ''])('leaves %j unmapped', (header) => {
    expect(guessMapping([header])).toEqual({ [header]: null });
  });

  it('uses each field at most once and lets the best match win', () => {
    expect(guessMapping(['Mobile', 'Phone'])).toEqual({ Mobile: null, Phone: 'phone' });
    expect(guessMapping(['Company', 'Business Name'])).toEqual({ Company: null, 'Business Name': 'business_name' });
    expect(guessMapping(['First Name', 'Last Name'])).toEqual({ 'First Name': 'contact_name', 'Last Name': null });
    expect(guessMapping(['Address Line 2', 'Address Line 1'])).toEqual({ 'Address Line 2': null, 'Address Line 1': 'address' });
    // A header only competes for its best field: "Company Phone" never falls back to business_name.
    expect(guessMapping(['Name', 'Phone', 'Company Phone'])).toEqual({ Name: 'contact_name', Phone: 'phone', 'Company Phone': null });
  });

  it('includes every header and never assigns a field twice', () => {
    const headers = ['Company', 'Business', 'Name', 'Contact', 'Phone', 'Mobile', 'Tel', 'Email', 'Mail', 'URL', 'Website', 'Notes', 'Comments', 'Extra'];
    const mapping = guessMapping(headers);
    expect(Object.keys(mapping)).toEqual(headers);
    const assigned = Object.values(mapping).filter((value) => value !== null);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(mapping).toMatchObject({ Phone: 'phone', Website: 'website', Email: 'email', Notes: 'notes' });
  });

  it('collapses duplicate header names', () => {
    expect(guessMapping(['Phone', 'Phone'])).toEqual({ Phone: 'phone' });
  });

  it('keeps prototype-like headers as plain own keys', () => {
    const mapping = guessMapping(['__proto__', 'constructor', 'toString']);
    expect(Object.keys(mapping)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
    expect(Object.values(mapping)).toEqual([null, null, null]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('missingRequiredImportFields', () => {
  it('reports unmapped required fields', () => {
    expect(missingRequiredImportFields({})).toEqual(['business_name', 'phone']);
    expect(missingRequiredImportFields({ Company: 'business_name', Zip: null })).toEqual(['phone']);
    expect(missingRequiredImportFields({ Company: 'business_name', Tel: 'phone' })).toEqual([]);
  });
});

describe('countryCodeFromName', () => {
  it.each([
    ['USA', 'US'],
    ['U.S.A.', 'US'],
    ['united states', 'US'],
    ['US', 'US'],
    ['GB', 'GB'],
    ['uk', 'GB'],
    ['United Kingdom', 'GB'],
    ['de', 'DE'],
    ['Canada', 'CA'],
    ['México', 'MX'],
  ])('resolves %j to %s', (input, expected) => {
    expect(countryCodeFromName(input)).toBe(expected);
  });

  it.each(['Narnia', '', '  ', 'ZZ', 'constructor', null, undefined])('returns undefined for %j', (input) => {
    expect(countryCodeFromName(input)).toBeUndefined();
  });
});

describe('validateImportRow', () => {
  const mapping: ImportMapping = {
    Company: 'business_name',
    Contact: 'contact_name',
    Phone: 'phone',
    Email: 'email',
    Website: 'website',
    Address: 'address',
    City: 'city',
    State: 'state',
    Country: 'country',
    Source: 'source',
    Notes: 'notes',
    Zip: null,
  };

  const fullRow = {
    Company: '  Acme Plumbing, LLC ',
    Contact: ' Jane Doe ',
    Phone: '(212) 555-0142 ext 7',
    Email: ' jane@acme.example ',
    Website: 'https://www.Acme-Plumbing.example/contact',
    Address: '1 Main St',
    City: 'New York',
    State: 'NY',
    Country: 'USA',
    Source: 'Trade show',
    Notes: 'Prefers mornings',
    Zip: '10001',
    Rating: '4.5',
  };

  it('normalizes a complete row and appends unmapped columns to notes', () => {
    expect(validateImportRow(fullRow, mapping, { appendUnmappedToNotes: true })).toEqual({
      ok: true,
      lead: {
        business_name: 'Acme Plumbing, LLC',
        contact_name: 'Jane Doe',
        phone: '+12125550142',
        phone_raw: '(212) 555-0142 ext 7',
        email: 'jane@acme.example',
        website: 'https://www.Acme-Plumbing.example/contact',
        website_domain: 'acme-plumbing.example',
        address: '1 Main St',
        city: 'New York',
        state: 'NY',
        country: 'USA',
        source: 'Trade show',
        notes: 'Prefers mornings\nZip: 10001\nRating: 4.5',
        dedupe_name_key: 'acmeplumbingllc|newyork',
      },
    });
  });

  it('does not append unmapped columns when the toggle is off', () => {
    const result = validateImportRow(fullRow, mapping, { appendUnmappedToNotes: false });
    expect(result.ok && result.lead.notes).toBe('Prefers mornings');
  });

  it('turns empty strings into null and returns exactly the lead columns', () => {
    const result = validateImportRow({ Company: 'Acme', Phone: '2125550100', Contact: '   ', Email: '', Rating: ' ' }, mapping, {
      appendUnmappedToNotes: true,
    });
    expect(result).toEqual({
      ok: true,
      lead: {
        business_name: 'Acme',
        contact_name: null,
        phone: '+12125550100',
        phone_raw: '2125550100',
        email: null,
        website: null,
        website_domain: null,
        address: null,
        city: null,
        state: null,
        country: null,
        source: null,
        notes: null,
        dedupe_name_key: 'acme|',
      },
    });
  });

  it.each<[Record<string, string>, string[]]>([
    [{ Company: '  ', Phone: '2125550100' }, ['Missing business name']],
    [{ Company: 'Acme', Phone: '' }, ['Missing phone']],
    [{ Company: 'Acme' }, ['Missing phone']],
    [{ Company: 'Acme', Phone: 'call me' }, ['Unusable phone']],
    [{ Company: 'Acme', Phone: '555-0100' }, ['Unusable phone']],
    [{ Phone: '555-0100' }, ['Missing business name', 'Unusable phone']],
    [{}, ['Missing business name', 'Missing phone']],
  ])('rejects %j with %j', (raw, reasons) => {
    expect(validateImportRow(raw, mapping, { appendUnmappedToNotes: true })).toEqual({ ok: false, reasons });
  });

  it('builds notes from unmapped columns alone', () => {
    const result = validateImportRow({ Company: 'Acme', Phone: '2125550100', Zip: '10001', Rating: '' }, mapping, {
      appendUnmappedToNotes: true,
    });
    expect(result.ok && result.lead.notes).toBe('Zip: 10001');
  });

  it('keeps the first value for a field mapped twice and appends the rest', () => {
    const doubled: ImportMapping = { Company: 'business_name', Phone: 'phone', Mobile: 'phone' };
    const both = validateImportRow({ Company: 'Acme', Phone: '2125550100', Mobile: '2125550199' }, doubled, {
      appendUnmappedToNotes: true,
    });
    expect(both.ok && [both.lead.phone, both.lead.notes]).toEqual(['+12125550100', 'Mobile: 2125550199']);
    const fallback = validateImportRow({ Company: 'Acme', Phone: '', Mobile: '2125550199' }, doubled, {
      appendUnmappedToNotes: true,
    });
    expect(fallback.ok && [fallback.lead.phone, fallback.lead.notes]).toEqual(['+12125550199', null]);
  });

  it('joins several notes columns', () => {
    const result = validateImportRow(
      { Company: 'Acme', Phone: '2125550100', 'Note 1': 'first', 'Note 2': 'second' },
      { Company: 'business_name', Phone: 'phone', 'Note 1': 'notes', 'Note 2': 'notes' },
      { appendUnmappedToNotes: false },
    );
    expect(result.ok && result.lead.notes).toBe('first\nsecond');
  });

  it('ignores mapping targets that are not import fields', () => {
    const hostile = { Company: 'business_name', Phone: 'phone', Owner: 'assigned_to', Status: 'status' } as unknown as ImportMapping;
    const result = validateImportRow({ Company: 'Acme', Phone: '2125550100', Owner: 'some-uuid', Status: 'CLIENT' }, hostile, {
      appendUnmappedToNotes: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.lead)).not.toContain('assigned_to');
      expect(Object.keys(result.lead)).not.toContain('status');
      expect(result.lead.notes).toBe('Owner: some-uuid\nStatus: CLIENT');
    }
  });

  it('uses the row country, then the default country, to read national phone numbers', () => {
    const uk = (row: Record<string, string>, defaultCountry?: 'GB' | 'US') =>
      validateImportRow({ Company: 'Acme', Phone: '020 7946 0958', ...row }, mapping, { appendUnmappedToNotes: false, defaultCountry });
    for (const country of ['United Kingdom', 'GB', 'uk']) {
      const result = uk({ Country: country });
      expect(result.ok && result.lead.phone).toBe('+442079460958');
    }
    const byDefault = uk({}, 'GB');
    expect(byDefault.ok && byDefault.lead.phone).toBe('+442079460958');
    expect(uk({})).toEqual({ ok: false, reasons: ['Unusable phone'] });
    const canada = validateImportRow({ Company: 'Acme', Phone: '604 555 0100', Country: 'Canada' }, mapping, { appendUnmappedToNotes: false });
    expect(canada.ok && canada.lead.phone).toBe('+16045550100');
  });

  it('strips NUL characters and flattens papaparse extra cells', () => {
    const result = validateImportRow(
      { Company: 'Ac\u0000me', Phone: '2125550100', Notes: '\u0000', __parsed_extra: ['x', 'y'] },
      mapping,
      { appendUnmappedToNotes: true },
    );
    expect(result.ok && [result.lead.business_name, result.lead.notes]).toEqual(['Acme', 'Extra columns: x, y']);
  });

  it('keeps unparseable websites but gives them no domain', () => {
    const result = validateImportRow({ Company: 'Acme', Phone: '2125550100', Website: 'N/A' }, mapping, { appendUnmappedToNotes: false });
    expect(result.ok && [result.lead.website, result.lead.website_domain]).toEqual(['N/A', null]);
  });

  it('accepts a punctuation-only business name without a dedupe key', () => {
    const result = validateImportRow({ Company: '!!!', Phone: '2125550100' }, mapping, { appendUnmappedToNotes: false });
    expect(result.ok && [result.lead.business_name, result.lead.dedupe_name_key]).toEqual(['!!!', null]);
  });

  it('works end to end with guessMapping', () => {
    const headers = ['Company Name', 'Owner', 'Tel', 'Email Address', 'URL', 'Street', 'City', 'Lead Source', 'Comments', 'Zip'];
    const guessed = guessMapping(headers);
    const raw = Object.fromEntries(
      headers.map((header, i) => [header, ['Blue Door Bakery', 'Sam Lee', '415.555.0177', 'sam@bluedoor.example', 'bluedoor.example', '9 Pine', 'San Francisco', 'Referral', 'Call after 2pm', '94110'][i]]),
    );
    const result = validateImportRow(raw, guessed, { appendUnmappedToNotes: true });
    expect(result).toEqual({
      ok: true,
      lead: {
        business_name: 'Blue Door Bakery',
        contact_name: 'Sam Lee',
        phone: '+14155550177',
        phone_raw: '415.555.0177',
        email: 'sam@bluedoor.example',
        website: 'bluedoor.example',
        website_domain: 'bluedoor.example',
        address: '9 Pine',
        city: 'San Francisco',
        state: null,
        country: null,
        source: 'Referral',
        notes: 'Call after 2pm\nZip: 94110',
        dedupe_name_key: 'bluedoorbakery|sanfrancisco',
      },
    });
  });
});
