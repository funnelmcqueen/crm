"use client";

import { useTranslations } from "@/components/i18n/locale-provider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  reportRangeHref,
  validateLocalRange,
  type LocalDateRange,
  type ReportPreset,
} from "./date-range";

export interface PresetLink {
  preset: ReportPreset;
  label: string;
  href: string;
}

export interface ReportRangePickerProps {
  range: LocalDateRange;
  /** The preset matching the current range, or null for a custom range. */
  preset: ReportPreset | null;
  /** Built on the server with the admin's timezone and the request time. */
  presets: PresetLink[];
  /** Shown when the URL held an unusable range and the default was used. */
  problem: string | null;
  timezone: string;
}

export function ReportRangePicker({ range, preset, presets, problem, timezone }: ReportRangePickerProps) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [error, setError] = useState<string | null>(null);

  // The URL is the state: follow it when it changes (presets, back button).
  const [synced, setSynced] = useState(range);
  if (synced.from !== range.from || synced.to !== range.to) {
    setSynced(range);
    setFrom(range.from);
    setTo(range.to);
    setError(null);
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    const rangeProblem = validateLocalRange(from, to);
    if (rangeProblem) {
      setError(rangeProblem === "invalid_date" ? t["Enter a valid date."] : rangeProblem === "reversed" ? t["The end date must be on or after the start date."] : t["Choose a range of 366 days or less."]);
      return;
    }
    setError(null);
    startTransition(() => router.push(reportRangeHref({ from, to })));
  }

  const message = error ?? problem;

  return (
    <section aria-label={t["Date range"]} className="mb-6 flex flex-col gap-3">
      <nav aria-label={t["Date range presets"]} className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="flex w-max gap-2">
          {presets.map((item) => {
            const selected = item.preset === preset;
            return (
              <li key={item.preset}>
                <Link
                  href={item.href}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "inline-flex h-12 items-center rounded-lg border px-4 text-sm font-semibold whitespace-nowrap outline-none transition-colors duration-100 focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected
                      ? "border-foreground bg-foreground text-background"
                      : "bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <form onSubmit={apply} className="flex flex-wrap items-end gap-2" noValidate>
        <div className="flex min-w-36 flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor="report-from" className="text-xs text-muted-foreground">
            {t["From"]}
          </Label>
          <Input
            id="report-from"
            type="date"
            required
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
            className="h-12 text-base tabular-nums lg:text-sm"
          />
        </div>
        <div className="flex min-w-36 flex-1 flex-col gap-1.5 sm:flex-none">
          <Label htmlFor="report-to" className="text-xs text-muted-foreground">
            {t["To"]}
          </Label>
          <Input
            id="report-to"
            type="date"
            required
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
            className="h-12 text-base tabular-nums lg:text-sm"
          />
        </div>
        <Button
          type="submit"
          variant={preset === null ? "default" : "outline"}
          className="h-12 w-full px-5 font-bold sm:w-auto"
          disabled={pending || (from === range.from && to === range.to)}
        >
          {pending ? t["Loading…"] : t["Apply"]}
        </Button>
        <p className="w-full text-xs text-muted-foreground sm:ml-2 sm:w-auto sm:self-center">
          {t["Dates are inclusive, in {zone}."].replace("{zone}", timezone)}
        </p>
      </form>

      <p role="alert" aria-live="polite" className={cn("text-sm font-semibold text-destructive", !message && "sr-only")}>
        {message ?? ""}
      </p>
    </section>
  );
}
