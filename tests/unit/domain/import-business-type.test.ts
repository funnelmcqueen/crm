import { describe, expect, it } from "vitest";
import { guessMapping, validateImportRow } from "@/lib/domain/import-mapping";

describe("business type import column", () => {
  it.each(["Business Type", "Category", "Industry", "Type"])("auto-maps a %s header", (header) => {
    expect(guessMapping(["Business Name", "Phone", header])[header]).toBe("business_type");
  });

  it("stores a recognised type and keeps an unrecognised one in the notes", () => {
    const mapping = guessMapping(["Business Name", "Phone", "Category"]);
    const known = validateImportRow({ "Business Name": "Swan Motel", Phone: "(941) 555-0142", Category: "Hotel / motel" }, mapping, { appendUnmappedToNotes: true });
    expect(known).toMatchObject({ ok: true, lead: { business_type: "hotel_motel", notes: null } });

    const unknown = validateImportRow({ "Business Name": "Smile Co", Phone: "(941) 555-0143", Category: "Dentist" }, mapping, { appendUnmappedToNotes: true });
    expect(unknown).toMatchObject({ ok: true, lead: { business_type: null, notes: "Business type: Dentist" } });
  });

  it("leaves the type blank when the column is absent", () => {
    const mapping = guessMapping(["Business Name", "Phone"]);
    expect(validateImportRow({ "Business Name": "Swan Motel", Phone: "(941) 555-0142" }, mapping, { appendUnmappedToNotes: true })).toMatchObject({
      ok: true,
      lead: { business_type: null },
    });
  });
});
