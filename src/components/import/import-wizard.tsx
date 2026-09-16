"use client";

import { Download, FileUp, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { guessMapping, missingRequiredImportFields, type ImportFieldKey, type ImportMapping } from "@/lib/domain/import-mapping";
import { cn } from "@/lib/utils";
import { checkImportDuplicatesAction, importLeadsBatchAction } from "@/server/actions/import";
import { AssignStep, isAssignmentComplete } from "./assign-step";
import {
  BATCH_FAILED_REASON,
  buildImportBatches,
  buildImportPlan,
  buildImportPreview,
  buildSkippedRowsCsv,
  checkImportFile,
  checkImportRows,
  chunkDuplicateKeys,
  decideAllDuplicates,
  duplicateKeysFor,
  formatCount,
  parseImportCsv,
  requiredFieldLabels,
  summarizeImport,
  toBatchAssignment,
  type BatchRowResult,
  type DuplicateDecision,
  type ExistingDuplicateLead,
  type ImportAssignment,
  type ImportPreview,
  type ImportResultSummary,
  type ParsedImportFile,
} from "./import-model";
import { MappingStep } from "./mapping-step";
import { PreviewStep } from "./preview-step";
import { StatCell, StepActions } from "./step-actions";

type Step = "upload" | "mapping" | "preview" | "assign" | "importing" | "done";

const STEPS = ["Upload", "Map columns", "Review", "Assign", "Import"] as const;
const STEP_INDEX: Record<Step, number> = { upload: 0, mapping: 1, preview: 2, assign: 3, importing: 4, done: 4 };

interface LoadedFile {
  name: string;
  file: ParsedImportFile;
}

interface ImportProgress {
  batchesDone: number;
  batchesTotal: number;
  rowsDone: number;
  rowsTotal: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Stepper({ step }: { step: Step }) {
  const current = STEP_INDEX[step];
  return (
    <ol aria-label="Import steps" className="mb-6 flex gap-1 text-xs font-semibold">
      {STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? "step" : undefined}
          className={cn("flex min-w-0 flex-1 flex-col gap-1.5", index <= current ? "text-foreground" : "text-muted-foreground")}
        >
          <span aria-hidden className={cn("h-1 rounded-full", index <= current ? "bg-primary" : "bg-muted")} />
          <span className="truncate">
            <span className="tabular-nums">{index + 1}.</span> <span className={index === current ? "" : "max-sm:sr-only"}>{label}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ImportWizard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [mapping, setMapping] = useState<ImportMapping>({});
  const [appendUnmapped, setAppendUnmapped] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, DuplicateDecision>>({});
  const [assignment, setAssignment] = useState<ImportAssignment>({ mode: "unassigned" });
  const [progress, setProgress] = useState<ImportProgress>({ batchesDone: 0, batchesTotal: 0, rowsDone: 0, rowsTotal: 0 });
  const [summary, setSummary] = useState<ImportResultSummary | null>(null);

  useEffect(() => {
    if (step !== "importing") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [step]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    const problem = checkImportFile(file);
    if (problem) {
      setUploadError(problem);
      return;
    }
    setReading(true);
    try {
      const result = parseImportCsv(await file.text());
      if (!result.ok) {
        setUploadError(result.error);
        return;
      }
      setLoaded({ name: file.name, file: result.file });
      setFileSize(file.size);
      setMapping(guessMapping(result.file.headers));
      setPreview(null);
      setDecisions({});
      setSummary(null);
    } catch {
      setUploadError("This file could not be read. Check that it is a CSV file.");
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files[0]);
  }

  async function runPreview() {
    if (!loaded || missingRequiredImportFields(mapping).length > 0) return;
    setChecking(true);
    setCheckError(null);
    // Let the spinner paint before validating a large file on the main thread.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const checks = checkImportRows(loaded.file, mapping, appendUnmapped);
      const existing: ExistingDuplicateLead[] = [];
      for (const chunk of chunkDuplicateKeys(duplicateKeysFor(checks))) {
        const result = await checkImportDuplicatesAction(chunk);
        if (!result.ok) throw new Error(result.error.message);
        existing.push(...result.data);
      }
      setPreview(buildImportPreview(checks, existing));
      setDecisions({});
      setStep("preview");
    } catch (error) {
      setCheckError(error instanceof Error && error.message ? error.message : "The duplicate check failed. Try again.");
    } finally {
      setChecking(false);
    }
  }

  async function runImport() {
    if (!loaded || !preview) return;
    const plan = buildImportPlan(preview, decisions);
    // With nothing to insert ("Finish"), the assignment does not matter.
    if (plan.insert.length > 0 && !isAssignmentComplete(assignment)) return;
    const batches = buildImportBatches(loaded.file, plan);
    const batchAssignment = toBatchAssignment(assignment, plan.insert.length);
    setProgress({ batchesDone: 0, batchesTotal: batches.length, rowsDone: 0, rowsTotal: plan.insert.length });
    setStep("importing");

    const results: BatchRowResult[] = [];
    for (const [index, batch] of batches.entries()) {
      let batchResults: BatchRowResult[];
      try {
        const result = await importLeadsBatchAction({ mapping, appendUnmappedToNotes: appendUnmapped, rows: batch }, batchAssignment);
        batchResults = result.ok
          ? result.data.results
          : batch.map((row) => ({ rowIndex: row.rowIndex, ok: false as const, reason: `Not saved: ${result.error.message}` }));
      } catch {
        // A failed batch never stops the remaining batches.
        batchResults = batch.map((row) => ({ rowIndex: row.rowIndex, ok: false as const, reason: BATCH_FAILED_REASON }));
      }
      results.push(...batchResults);
      setProgress((current) => ({ ...current, batchesDone: index + 1, rowsDone: current.rowsDone + batch.length }));
    }

    setSummary(summarizeImport(preview, plan, results));
    setStep("done");
  }

  function reset() {
    setStep("upload");
    setLoaded(null);
    setPreview(null);
    setDecisions({});
    setSummary(null);
    setAssignment({ mode: "unassigned" });
    setUploadError(null);
    setCheckError(null);
  }

  const missing = missingRequiredImportFields(mapping);
  const plan = preview ? buildImportPlan(preview, decisions) : null;

  return (
    <div>
      <Stepper step={step} />

      {step === "upload" ? (
        <section aria-labelledby="import-upload-title" className="flex flex-col gap-4">
          <h2 id="import-upload-title" className="sr-only">
            Upload
          </h2>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center transition-colors duration-100",
              dragging && "border-primary bg-muted",
            )}
          >
            <div aria-hidden className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {reading ? <Loader2 className="size-6 animate-spin" /> : <FileUp className="size-6" />}
            </div>
            <div className="flex flex-col gap-1">
              <p className="font-bold">Drop a CSV file here</p>
              <p className="text-sm text-muted-foreground">.csv only, up to 10 MB and 50,000 rows. The first row must name the columns.</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              className="sr-only"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
            <Button className="h-12 px-5 font-bold" disabled={reading} onClick={() => inputRef.current?.click()}>
              {reading ? "Reading…" : "Choose CSV file"}
            </Button>
          </div>

          {uploadError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>File not accepted</AlertTitle>
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          ) : null}

          {loaded ? (
            <div className="flex items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{loaded.name}</p>
                <p className="text-sm text-muted-foreground">
                  <span className="font-extrabold text-foreground tabular-nums">{formatCount(loaded.file.rows.length)}</span>{" "}
                  {loaded.file.rows.length === 1 ? "row" : "rows"} · {formatCount(loaded.file.headers.length)} columns · {formatBytes(fileSize)}
                </p>
              </div>
            </div>
          ) : null}

          {loaded ? (
            <StepActions>
              <Button className="h-12 px-6 font-bold" onClick={() => setStep("mapping")}>
                Map columns
              </Button>
            </StepActions>
          ) : null}
        </section>
      ) : null}

      {step === "mapping" && loaded ? (
        <>
          <MappingStep
            file={loaded.file}
            mapping={mapping}
            onMappingChange={(header: string, field: ImportFieldKey | null) => setMapping((current) => ({ ...current, [header]: field }))}
            appendUnmapped={appendUnmapped}
            onAppendUnmappedChange={setAppendUnmapped}
          />
          {checkError ? (
            <Alert variant="destructive" role="alert" className="mt-4">
              <AlertTitle>Preview failed</AlertTitle>
              <AlertDescription>{checkError}</AlertDescription>
            </Alert>
          ) : null}
          <StepActions>
            {missing.length > 0 ? (
              <p className="text-sm text-muted-foreground sm:mr-auto" aria-live="polite">
                Map {requiredFieldLabels(missing).join(" and ")} to continue.
              </p>
            ) : null}
            <Button variant="outline" className="h-12 px-5" disabled={checking} onClick={() => setStep("upload")}>
              Back
            </Button>
            <Button className="h-12 px-6 font-bold" disabled={missing.length > 0 || checking} onClick={() => void runPreview()}>
              {checking ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" /> Checking duplicates…
                </>
              ) : (
                "Preview import"
              )}
            </Button>
          </StepActions>
        </>
      ) : null}

      {step === "preview" && loaded && preview && plan ? (
        <>
          <PreviewStep
            fileName={loaded.name}
            preview={preview}
            decisions={decisions}
            onDecide={(rowIndex, decision) => setDecisions((current) => ({ ...current, [rowIndex]: decision }))}
            onDecideAll={(decision) => setDecisions(decideAllDuplicates(preview, decision))}
          />
          <StepActions>
            <Button variant="outline" className="h-12 px-5" onClick={() => setStep("mapping")}>
              Back
            </Button>
            <Button className="h-12 px-6 font-bold" onClick={() => setStep("assign")}>
              Continue with {formatCount(plan.insert.length)} {plan.insert.length === 1 ? "lead" : "leads"}
            </Button>
          </StepActions>
        </>
      ) : null}

      {step === "assign" && preview && plan ? (
        <>
          <AssignStep total={plan.insert.length} assignment={assignment} onAssignmentChange={setAssignment} />
          <p className="mt-4 text-sm text-muted-foreground">
            {formatCount(plan.skipped.length)} {plan.skipped.length === 1 ? "duplicate" : "duplicates"} skipped · {formatCount(plan.invalid.length)} invalid{" "}
            {plan.invalid.length === 1 ? "row" : "rows"} not imported.
          </p>
          <StepActions>
            <Button variant="outline" className="h-12 px-5" onClick={() => setStep("preview")}>
              Back
            </Button>
            <Button
              className="h-12 px-6 font-bold"
              disabled={plan.insert.length > 0 && !isAssignmentComplete(assignment)}
              onClick={() => void runImport()}
            >
              {plan.insert.length === 0 ? "Finish" : `Import ${formatCount(plan.insert.length)} ${plan.insert.length === 1 ? "lead" : "leads"}`}
            </Button>
          </StepActions>
        </>
      ) : null}

      {step === "importing" ? (
        <section aria-labelledby="import-progress-title" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <h2 id="import-progress-title" className="flex items-center gap-2 text-lg font-bold">
            <Loader2 aria-hidden className="size-5 animate-spin" /> Importing…
          </h2>
          <Progress
            value={progress.rowsTotal === 0 ? 100 : Math.round((progress.rowsDone / progress.rowsTotal) * 100)}
            aria-label="Import progress"
            className="h-2"
          />
          <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
            Batch {formatCount(progress.batchesDone)} of {formatCount(progress.batchesTotal)} · {formatCount(progress.rowsDone)} of{" "}
            {formatCount(progress.rowsTotal)} rows sent. Keep this page open.
          </p>
        </section>
      ) : null}

      {step === "done" && summary && loaded ? (
        <section aria-labelledby="import-result-title" className="flex flex-col gap-4">
          <div className="rounded-xl border bg-card p-4">
            <h2 id="import-result-title" className="text-lg font-bold">
              Import finished
            </h2>
            <p className="text-sm text-muted-foreground">
              {formatCount(summary.counts.total)} {summary.counts.total === 1 ? "row" : "rows"} in {loaded.name}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
              <StatCell label="Inserted" value={formatCount(summary.counts.inserted)} className={summary.counts.inserted > 0 ? "text-gold" : undefined} />
              <StatCell label="Skipped (duplicates)" value={formatCount(summary.counts.skipped)} />
              <StatCell label="Invalid" value={formatCount(summary.counts.invalid)} />
              <StatCell label="Failed" value={formatCount(summary.counts.failed)} className={summary.counts.failed > 0 ? "text-destructive" : undefined} />
            </div>
          </div>

          {summary.counts.failed > 0 ? (
            <Alert variant="destructive">
              <AlertTitle>Some rows were not saved</AlertTitle>
              <AlertDescription>Download the rows below, fix them if needed, and import that file again.</AlertDescription>
            </Alert>
          ) : null}

          <StepActions>
            {summary.counts.total > summary.counts.inserted ? (
              <Button
                variant="outline"
                className="h-12 gap-2 px-5"
                onClick={() =>
                  downloadCsv(
                    `${loaded.name.replace(/\.csv$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-") || "import"}-skipped-and-failed.csv`,
                    buildSkippedRowsCsv(loaded.file, summary, mapping),
                  )
                }
              >
                <Download aria-hidden />
                Download skipped and failed rows
              </Button>
            ) : null}
            <Button variant="outline" className="h-12 px-5" onClick={reset}>
              Import another file
            </Button>
            <Button asChild className="h-12 px-6 font-bold">
              <Link href="/leads">View leads</Link>
            </Button>
          </StepActions>
        </section>
      ) : null}
    </div>
  );
}
