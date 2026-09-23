// A lead's business type and the guess from its name (docs/DEVIATIONS.md D46). Pure.
//
// The stored type always wins; the guess covers leads nobody has categorized yet. Matching is on whole words
// after accents are stripped, so "Innovation" never reads as "inn" and "Spain" never as "spa".

export const BUSINESS_TYPES = [
  "restaurant",
  "cafe_bakery",
  "hotel_motel",
  "home_services",
  "auto",
  "retail",
  "beauty",
  "other",
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABELS: Readonly<Record<BusinessType, string>> = {
  restaurant: "Restaurant",
  cafe_bakery: "Café / bakery",
  hotel_motel: "Hotel / motel",
  home_services: "Home services",
  auto: "Auto",
  retail: "Retail",
  beauty: "Beauty",
  other: "Other",
};

/** Completes "Best for …" in the booking panel. */
export const BUSINESS_TYPE_BEST_FOR: Readonly<Record<BusinessType, string>> = {
  restaurant: "a restaurant",
  cafe_bakery: "a café or bakery",
  hotel_motel: "a hotel or motel",
  home_services: "home services",
  auto: "an auto shop",
  retail: "a store",
  beauty: "a salon",
  other: "this lead",
};

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (BUSINESS_TYPES as readonly string[]).includes(value);
}

/** Guessing order: the first type with a whole-word match wins (Coco Bakery-Restaurant is a restaurant). */
const KEYWORDS: ReadonlyArray<readonly [BusinessType, readonly string[]]> = [
  ["hotel_motel", ["hotel", "motel", "inn", "lodge", "suites", "resort", "hostel", "bed and breakfast", "b&b"]],
  [
    "restaurant",
    ["restaurant", "pizzeria", "pizza", "grill", "bistro", "eatery", "diner", "taqueria", "sushi", "bbq", "steakhouse", "tavern", "cantina", "trattoria"],
  ],
  ["cafe_bakery", ["cafe", "coffee", "bakery", "creamery", "ice cream", "icecream", "donut", "doughnut", "patisserie"]],
  ["auto", ["auto", "automotive", "tire", "tires", "collision", "body shop", "car wash", "mechanic", "transmission"]],
  [
    "home_services",
    ["heating", "cooling", "hvac", "plumbing", "plumber", "roofing", "landscaping", "lawn", "electric", "electrical", "pest", "cleaning", "painting", "construction", "contractor", "remodeling", "pool"],
  ],
  ["beauty", ["salon", "spa", "barber", "barbershop", "nails", "beauty", "lash", "brow", "hair", "tattoo"]],
  ["retail", ["store", "shop", "boutique", "market", "outlet", "supply", "mart"]],
];

/** " word word " form: lowercase, accents stripped, every run of other characters (except &) one space. */
function words(text: string): string {
  const plain = text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
  return ` ${plain.replace(/[^a-z0-9&]+/g, " ").trim()} `;
}

function matchKeywords(text: string): BusinessType | null {
  const haystack = words(text);
  for (const [type, keywords] of KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(` ${keyword} `))) return type;
  }
  return null;
}

export function guessBusinessType(name: string | null | undefined): BusinessType {
  return name ? (matchKeywords(name) ?? "other") : "other";
}

/** Each type by its label ("hotel motel") and by its key ("hotel motel" again for hotel_motel). */
const LABEL_FORMS: ReadonlyArray<readonly [string, BusinessType]> = BUSINESS_TYPES.flatMap(
  (type): Array<readonly [string, BusinessType]> => [
    [words(BUSINESS_TYPE_LABELS[type]).trim(), type],
    [words(type).trim(), type],
  ],
);

/**
 * A CSV "Business type" cell: a label or key ("Hotel / motel", "hotel_motel"), or any value containing a type's
 * keyword ("Pizzeria"). Anything else is null, and import keeps the original text in the notes.
 */
export function businessTypeFromImportValue(value: string | null | undefined): BusinessType | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = words(value).trim();
  const byLabel = LABEL_FORMS.find(([form]) => form === normalized);
  return byLabel ? byLabel[1] : matchKeywords(value);
}

export function resolveBusinessType(
  stored: BusinessType | null,
  name: string | null | undefined,
): { type: BusinessType; isGuess: boolean } {
  return stored ? { type: stored, isGuess: false } : { type: guessBusinessType(name), isGuess: true };
}
