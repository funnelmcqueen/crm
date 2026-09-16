"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { listImportAgentsAction } from "@/server/actions/import";
import type { ImportAgentOption } from "@/server/services/import";
import { formatCount, splitPreview, type ImportAssignment } from "./import-model";

export interface AssignStepProps {
  /** Rows that will be inserted. */
  total: number;
  assignment: ImportAssignment;
  onAssignmentChange: (assignment: ImportAssignment) => void;
}

const OPTION = "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors duration-100 has-[[aria-checked=true]]:border-primary";

export function isAssignmentComplete(assignment: ImportAssignment): boolean {
  if (assignment.mode === "agent") return assignment.agentId !== "";
  if (assignment.mode === "split") return assignment.agentIds.length > 0;
  return true;
}

export function AssignStep({ total, assignment, onAssignmentChange }: AssignStepProps) {
  const [agents, setAgents] = useState<ImportAgentOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [lastAgentId, setLastAgentId] = useState("");
  const [lastSplitIds, setLastSplitIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    listImportAgentsAction()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAgents(result.data);
          setLoadError(null);
        } else {
          setLoadError(result.error.message);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load the agent list.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const agentId = assignment.mode === "agent" ? assignment.agentId : lastAgentId;
  const splitIds = assignment.mode === "split" ? assignment.agentIds : lastSplitIds;
  const counts = splitPreview(total, splitIds.length);

  function chooseMode(mode: string) {
    if (mode === "agent") onAssignmentChange({ mode: "agent", agentId });
    else if (mode === "split") onAssignmentChange({ mode: "split", agentIds: splitIds });
    else onAssignmentChange({ mode: "unassigned" });
  }

  function toggleSplit(id: string, checked: boolean) {
    const selected = new Set(splitIds);
    if (checked) selected.add(id);
    else selected.delete(id);
    // Keep the agent list order so the split preview and the server assign the same blocks.
    const next = (agents ?? []).filter((agent) => selected.has(agent.id)).map((agent) => agent.id);
    setLastSplitIds(next);
    onAssignmentChange({ mode: "split", agentIds: next });
  }

  return (
    <section aria-labelledby="import-assign-title" className="flex flex-col gap-4">
      <div>
        <h2 id="import-assign-title" className="text-lg font-bold">
          Assign
        </h2>
        <p className="text-sm text-muted-foreground">
          Who gets the <span className="font-extrabold text-foreground tabular-nums">{formatCount(total)}</span> new {total === 1 ? "lead" : "leads"}?
        </p>
      </div>

      <RadioGroup value={assignment.mode} onValueChange={chooseMode} aria-label="Assignment" className="gap-2">
        <label htmlFor="import-assign-unassigned" className={OPTION}>
          <RadioGroupItem id="import-assign-unassigned" value="unassigned" />
          <span className="flex flex-col">
            <span className="font-semibold">Leave unassigned</span>
            <span className="text-xs text-muted-foreground">Only admins see them until they are assigned.</span>
          </span>
        </label>
        <label htmlFor="import-assign-agent" className={OPTION}>
          <RadioGroupItem id="import-assign-agent" value="agent" />
          <span className="font-semibold">All to one agent</span>
        </label>
        <label htmlFor="import-assign-split" className={OPTION}>
          <RadioGroupItem id="import-assign-split" value="split" />
          <span className="flex flex-col">
            <span className="font-semibold">Split evenly across agents</span>
            <span className="text-xs text-muted-foreground">For example 34 / 33 / 33.</span>
          </span>
        </label>
      </RadioGroup>

      {assignment.mode !== "unassigned" ? (
        loadError ? (
          <Alert variant="destructive">
            <AlertTitle>Agents could not be loaded</AlertTitle>
            <AlertDescription>
              {loadError}
              <Button variant="outline" className="mt-2 h-12" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : agents === null ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading agents">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : agents.length === 0 ? (
          <Alert>
            <AlertTitle>No active agents</AlertTitle>
            <AlertDescription>Create or reactivate an agent first, or leave the leads unassigned.</AlertDescription>
          </Alert>
        ) : assignment.mode === "agent" ? (
          <Select
            value={assignment.agentId === "" ? undefined : assignment.agentId}
            onValueChange={(id) => {
              setLastAgentId(id);
              onAssignmentChange({ mode: "agent", agentId: id });
            }}
          >
            <SelectTrigger aria-label="Agent" className="w-full px-3 data-[size=default]:h-12 sm:max-w-sm">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id} className="min-h-12">
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex flex-col gap-2">
            <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Agents in the split">
              {agents.map((agent) => {
                const position = splitIds.indexOf(agent.id);
                const id = `import-split-${agent.id}`;
                return (
                  <li key={agent.id}>
                    <label htmlFor={id} className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 transition-colors duration-100 hover:bg-muted">
                      <Checkbox id={id} checked={position !== -1} onCheckedChange={(checked) => toggleSplit(agent.id, checked === true)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{agent.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{agent.email}</span>
                      </span>
                      {position !== -1 ? (
                        <span className="font-extrabold tabular-nums">{formatCount(counts[position] ?? 0)}</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {splitIds.length === 0 ? (
                "Choose at least one agent."
              ) : (
                <>
                  Split: <span className="font-extrabold text-foreground tabular-nums">{counts.map(formatCount).join(" / ")}</span>
                </>
              )}
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}
