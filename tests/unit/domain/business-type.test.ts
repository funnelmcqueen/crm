import { describe, expect, it } from "vitest";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  businessTypeFromImportValue,
  guessBusinessType,
  isBusinessType,
  resolveBusinessType,
} from "@/lib/domain/business-type";

describe("guessBusinessType", () => {
  it.each([
    ["Swan Motel", "hotel_motel"],
    ["Kompose Hotel Sarasota", "hotel_motel"],
    ["Maria's Pizzeria & Restaurant", "restaurant"],
    ["Coco Bakery-Restaurant", "restaurant"],
    ["Mama's Soul Eatery", "restaurant"],
    ["Sea Maids Creamery (Icecream & a Li", "cafe_bakery"],
    ["The Café by Mise en Place", "cafe_bakery"],
    ["Windy City Heating & Cooling", "home_services"],
    ["Silver Oak Auto Repair", "auto"],
    ["Luxe Nail Salon", "beauty"],
    ["Corner Market", "retail"],
    ["Casa V. M. Ybor", "other"],
  ])("%s is %s", (name, type) => {
    expect(guessBusinessType(name)).toBe(type);
  });

  it.each(["Innovation Labs", "Spain Imports", "Pizzazz Events", "Shopify Pros"])(
    "does not match a keyword inside a longer word: %s",
    (name) => {
      expect(guessBusinessType(name)).toBe("other");
    },
  );

  it("treats a missing name as other", () => {
    expect(guessBusinessType(null)).toBe("other");
    expect(guessBusinessType("   ")).toBe("other");
  });
});

describe("businessTypeFromImportValue", () => {
  it.each([
    ["Restaurant", "restaurant"],
    ["café / bakery", "cafe_bakery"],
    ["Hotel/Motel", "hotel_motel"],
    ["home_services", "home_services"],
    ["OTHER", "other"],
    ["Pizzeria", "restaurant"],
  ])("maps %s to %s", (value, type) => {
    expect(businessTypeFromImportValue(value)).toBe(type);
  });

  it("returns null for blank or unrecognized values", () => {
    expect(businessTypeFromImportValue("Dentist")).toBeNull();
    expect(businessTypeFromImportValue("")).toBeNull();
    expect(businessTypeFromImportValue(null)).toBeNull();
  });
});

describe("resolveBusinessType", () => {
  it("prefers the stored type and guesses only when it is missing", () => {
    expect(resolveBusinessType("retail", "Swan Motel")).toEqual({ type: "retail", isGuess: false });
    expect(resolveBusinessType(null, "Swan Motel")).toEqual({ type: "hotel_motel", isGuess: true });
  });
});

it("labels every type and recognises only real types", () => {
  for (const type of BUSINESS_TYPES) expect(BUSINESS_TYPE_LABELS[type]).toBeTruthy();
  expect(isBusinessType("beauty")).toBe(true);
  expect(isBusinessType("dentist")).toBe(false);
});
