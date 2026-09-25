import type { Locale } from "@/lib/i18n/locales";
import en from "@/lib/i18n/messages/en/admin";
import de from "@/lib/i18n/messages/de/admin";

/** Localize client CSV validation without changing imported cells or download headers. */
export function getImportValidationMessage(message: string, locale: Locale): string {
  if (locale === "en") return message;
  const t = locale === "de" ? de : en;
  const direct = [
    "Choose a .csv file.",
    "This file is larger than 10 MB. Split it into smaller files and import them one at a time.",
    "This file is empty.",
    "This file has no header row. The first line must name the columns.",
    "This file has a header row but no data rows.",
  ] as const;
  for (const key of direct) if (message === key) return t[key];

  let match = /^This file has ([\d,]+) columns\. The limit is (\d+)\.$/.exec(message);
  if (match) return t["This file has {count} columns. The limit is {limit}."].replace("{count}", match[1]).replace("{limit}", match[2]);
  match = /^A column name is longer than (\d+) characters\.$/.exec(message);
  if (match) return t["A column name is longer than {limit} characters."].replace("{limit}", match[1]);
  match = /^This file has an unclosed quote(?: near row ([\d,]+))?, so the rows after it cannot be read\. Fix the quoting and upload it again\.$/.exec(message);
  if (match) return (match[1] ? t["This file has an unclosed quote near row {row}, so the rows after it cannot be read. Fix the quoting and upload it again."].replace("{row}", match[1]) : t["This file has an unclosed quote, so the rows after it cannot be read. Fix the quoting and upload it again."]);
  match = /^This file has ([\d,]+) rows\. The limit is ([\d,]+); split it into smaller files\.$/.exec(message);
  if (match) return t["This file has {count} rows. The limit is {limit}; split it into smaller files."].replace("{count}", match[1]).replace("{limit}", match[2]);
  return t["This file could not be read. Check that it is a CSV file."];
}
