"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPhoneDisplay } from "@/lib/domain/phone";
import {
  formatCount,
  rowNumber,
  type DuplicateDecision,
  type DuplicateDecisions,
  type ImportPreview,
  type PreviewRow,
} from "./import-model";
import { StatCell } from "./step-actions";

const PAGE = 100;

type DuplicateRow = Extract<PreviewRow, { status: "duplicate" }>;
type InvalidRow = Extract<PreviewRow, { status: "invalid" }>;

export interface PreviewStepProps {
  fileName: string;
  preview: ImportPreview;
  decisions: DuplicateDecisions;
  onDecide: (rowIndex: number, decision: DuplicateDecision) => void;
  onDecideAll: (decision: DuplicateDecision) => void;
}

export function PreviewStep({ fileName, preview, decisions, onDecide, onDecideAll }: PreviewStepProps) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  const duplicates = useMemo(() => preview.rows.filter((row): row is DuplicateRow => row.status === "duplicate"), [preview]);
  const invalid = useMemo(() => preview.rows.filter((row): row is InvalidRow => row.status === "invalid"), [preview]);
  const [duplicateLimit, setDuplicateLimit] = useState(PAGE);
  const [invalidLimit, setInvalidLimit] = useState(PAGE);
  const importAnyway = duplicates.filter((row) => decisions[row.rowIndex] === "import").length;

  return (
    <section aria-labelledby="import-preview-title" className="flex flex-col gap-6">
      <div className="rounded-xl border bg-card p-4">
        <h2 id="import-preview-title" className="text-lg font-bold">
          {t["Review"]}
        </h2>
        <p className="mt-1 text-base font-bold tabular-nums" aria-live="polite">
          {formatCount(preview.counts.ready)} {t["ready"]} · {formatCount(preview.counts.duplicates)} {t["possible duplicates"]} · {formatCount(preview.counts.invalid)} {t["invalid"]}
        </p>
        <p className="truncate text-sm text-muted-foreground">
          {formatCount(preview.counts.total)} {preview.counts.total === 1 ? t["row"] : t["rows"]} · {fileName}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-4">
          <StatCell label={t["Ready"]} value={formatCount(preview.counts.ready)} />
          <StatCell label={t["Possible duplicates"]} value={formatCount(preview.counts.duplicates)} />
          <StatCell label={t["Invalid"]} value={formatCount(preview.counts.invalid)} className={preview.counts.invalid > 0 ? "text-destructive" : undefined} />
        </div>
      </div>

      {duplicates.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="font-bold">{t["Possible duplicates"]}</h3>
              <p className="text-sm text-muted-foreground">
                {t["{count} of {total} will be imported anyway. Nothing is merged or deleted."].replace("{count}", formatCount(importAnyway)).replace("{total}", formatCount(duplicates.length))}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="h-12 px-4" onClick={() => onDecideAll("skip")}>
                {t["Skip all duplicates"]}
              </Button>
              <Button variant="outline" className="h-12 px-4" onClick={() => onDecideAll("import")}>
                {t["Import all duplicates"]}
              </Button>
            </div>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {duplicates.slice(0, duplicateLimit).map((row) => {
              const decision = decisions[row.rowIndex] ?? "skip";
              const label = `${t["Row"]} ${rowNumber(row.rowIndex)}`;
              return (
                <li key={row.rowIndex} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      <span className="mr-2 text-xs font-bold text-muted-foreground tabular-nums">{label}</span>
                      {row.lead.business_name}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {[row.lead.city, formatPhoneDisplay(row.lead.phone)].filter(Boolean).join(" · ")}
                    </p>
                    <p className="text-sm">{t["Same {what} as {targets}"].replace("{what}", row.duplicate.reasons.map((reason) => reason === "phone" ? t["phone"] : reason === "domain" ? t["website"] : t["business name and city"]).join(", ")).replace("{targets}", [...row.duplicate.existing.map((lead) => lead.city ? `${lead.businessName} (${lead.city})` : lead.businessName), ...row.duplicate.earlierRowIndexes.map((index) => `${t["row"]} ${rowNumber(index)}`)].join(", "))}</p>
                  </div>
                  <div role="group" aria-label={t["{row}: skip or import"].replace("{row}", label)} className="flex shrink-0 gap-1 rounded-lg border p-0.5">
                    <Button
                      type="button"
                      variant={decision === "skip" ? "secondary" : "ghost"}
                      aria-pressed={decision === "skip"}
                      className="h-12 flex-1 px-4"
                      onClick={() => onDecide(row.rowIndex, "skip")}
                    >
                      {t["Skip"]}
                    </Button>
                    <Button
                      type="button"
                      variant={decision === "import" ? "secondary" : "ghost"}
                      aria-pressed={decision === "import"}
                      className="h-12 flex-1 px-4"
                      onClick={() => onDecide(row.rowIndex, "import")}
                    >
                      {t["Import anyway"]}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {duplicates.length > duplicateLimit ? (
            <Button variant="ghost" className="h-12 w-full" onClick={() => setDuplicateLimit((limit) => limit + PAGE)}>
              {t["Show {count} more duplicates"].replace("{count}", formatCount(Math.min(PAGE, duplicates.length - duplicateLimit)))}
            </Button>
          ) : null}
        </div>
      ) : null}

      {invalid.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div>
            <h3 className="font-bold">{t["Invalid rows"]}</h3>
            <p className="text-sm text-muted-foreground">{t["These rows are not imported. They are included in the download at the end."]}</p>
          </div>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {invalid.slice(0, invalidLimit).map((row) => (
              <li key={row.rowIndex} className="flex flex-col gap-1 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
                <span className="text-xs font-bold text-muted-foreground tabular-nums">{t["Row"]} {rowNumber(row.rowIndex)}</span>
                <span className="text-sm font-semibold text-destructive md:text-right">{locale === "de" ? t["Invalid row; check its values."] : row.reasons.join(" · ")}</span>
              </li>
            ))}
          </ul>
          {invalid.length > invalidLimit ? (
            <Button variant="ghost" className="h-12 w-full" onClick={() => setInvalidLimit((limit) => limit + PAGE)}>
              {t["Show {count} more invalid rows"].replace("{count}", formatCount(Math.min(PAGE, invalid.length - invalidLimit)))}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
