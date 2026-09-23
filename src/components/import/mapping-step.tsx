"use client";

import { Check, CircleAlert } from "lucide-react";
import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CRM_IMPORT_FIELDS, isImportFieldKey, type ImportFieldKey, type ImportMapping } from "@/lib/domain/import-mapping";
import { cn } from "@/lib/utils";
import type { ParsedImportFile } from "./import-model";

const SKIP = "__skip";
const SAMPLE_ROWS = 25;
const REQUIRED_FIELDS = CRM_IMPORT_FIELDS.filter((field) => field.required);

export interface MappingStepProps {
  file: ParsedImportFile;
  mapping: ImportMapping;
  onMappingChange: (header: string, field: ImportFieldKey | null) => void;
  appendUnmapped: boolean;
  onAppendUnmappedChange: (value: boolean) => void;
}

export function MappingStep({ file, mapping, onMappingChange, appendUnmapped, onAppendUnmappedChange }: MappingStepProps) {
  const samples = useMemo(() => {
    const rows = file.rows.slice(0, SAMPLE_ROWS);
    return file.headers.map((header) => rows.map((row) => (row[header] ?? "").trim()).find((value) => value !== "") ?? "");
  }, [file]);

  const usage = new Map<ImportFieldKey, number>();
  for (const value of Object.values(mapping)) if (value) usage.set(value, (usage.get(value) ?? 0) + 1);

  return (
    <section aria-labelledby="import-mapping-title" className="flex flex-col gap-4">
      <div>
        <h2 id="import-mapping-title" className="text-lg font-bold">
          Map columns
        </h2>
        <p className="text-sm text-muted-foreground">Match each CSV column to a CRM field. Business name and phone are required.</p>
      </div>

      <ul className="flex flex-wrap gap-2" aria-label="Required fields">
        {REQUIRED_FIELDS.map((field) => {
          const mapped = usage.has(field.key);
          return (
            <li
              key={field.key}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold",
                mapped ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {mapped ? <Check aria-hidden className="size-3.5" /> : <CircleAlert aria-hidden className="size-3.5" />}
              {field.label}
              <span className="sr-only">{mapped ? " is mapped" : " is not mapped yet"}</span>
            </li>
          );
        })}
      </ul>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16rem] gap-4 border-b px-4 py-2 text-xs font-semibold text-muted-foreground md:grid">
          <span>CSV column</span>
          <span>Example value</span>
          <span>CRM field</span>
        </div>
        <ul className="divide-y">
          {file.headers.map((header, index) => {
            const value = mapping[header];
            const field = isImportFieldKey(value) ? value : null;
            const id = `import-map-${index}`;
            const shared = field !== null && field !== "notes" && (usage.get(field) ?? 0) > 1;
            return (
              <li key={header} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16rem] md:items-center md:gap-4">
                <label htmlFor={id} className="min-w-0 truncate font-semibold">
                  {header.trim() || `Column ${index + 1}`}
                </label>
                <span className="min-w-0 truncate text-sm text-muted-foreground">{samples[index] || "—"}</span>
                <div className="flex flex-col gap-1">
                  <Select value={field ?? SKIP} onValueChange={(next) => onMappingChange(header, isImportFieldKey(next) ? next : null)}>
                    <SelectTrigger id={id} className="w-full px-3 data-[size=default]:h-12">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="end">
                      <SelectItem value={SKIP} className="min-h-12">
                        Don&apos;t import
                      </SelectItem>
                      {CRM_IMPORT_FIELDS.map((option) => (
                        <SelectItem key={option.key} value={option.key} className="min-h-12">
                          {option.label}
                          {option.required ? " (required)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {shared ? <span className="text-xs text-muted-foreground">Mapped more than once: later values go to notes.</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex min-h-12 items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
        <Label htmlFor="import-append-unmapped" className="flex cursor-pointer flex-col items-start gap-0.5">
          <span className="font-semibold">Append unmapped columns to notes</span>
          <span className="text-xs font-normal text-muted-foreground">Adds lines like &quot;Employees: 12&quot; so nothing is lost.</span>
        </Label>
        <Switch id="import-append-unmapped" checked={appendUnmapped} onCheckedChange={onAppendUnmappedChange} />
      </div>
    </section>
  );
}
