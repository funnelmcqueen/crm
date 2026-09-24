"use client";

import { CalendarClock, ChevronDown, Download, ListChecks, MoreHorizontal, Store, Tag, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  describeAssignResult,
  describeBusinessTypeResult,
  describeCompletedFollowUps,
  describeDeleteResult,
  describeFollowUpResult,
  describeSourceResult,
  describeStatusResult,
  describeUndoResult,
  leadCount,
  type BulkUndo,
} from "@/lib/domain/bulk-leads";
import { LEAD_STATUSES, STATUS_LABELS, type LeadStatus } from "@/lib/domain/statuses";
import { cn } from "@/lib/utils";
import {
  bulkAssignAction,
  bulkCompleteFollowUpsAction,
  bulkDeleteAction,
  bulkScheduleFollowUpAction,
  bulkSetBusinessTypeAction,
  bulkSetSourceAction,
  bulkUpdateStatusAction,
  listMatchingLeadIdsAction,
  undoBulkChangeAction,
} from "@/server/actions/bulk-leads";
import type { ActionResult } from "@/server/errors";
import { BulkBusinessTypeDialog, BulkConfirmDialog, BulkFollowUpDialog, BulkSourceDialog } from "./bulk-dialogs";
import { selectAllMatchingLabel } from "./selection";
import { useLeadSelectionContext } from "./selection-context";

export interface BulkAgentOption {
  id: string;
  name: string;
}

export interface BulkActionBarProps {
  /** Admin only: active agents and admins a lead can be assigned to. */
  agents: BulkAgentOption[];
  sources: string[];
  tz: string;
  now: number;
}

type OpenDialog = "follow-up" | "source" | "business-type" | "delete" | "clear-follow-ups" | "do-not-contact" | null;

const UNDO_MS = 10_000;
const BUTTON = "h-12 gap-2 px-4";

/**
 * The bulk toolbar above the Leads list, shown while leads are selected. Every change clears the selection when
 * it succeeds (the list re-renders with the new values) and says what happened; assignment and status changes
 * offer Undo. Export keeps the selection.
 */
export function BulkActionBar({ agents, sources, tz, now }: BulkActionBarProps) {
  const t = useTranslations("workspace").bulkUi;
  const { locale } = useLocale();
  const countLabel = (n: number) => `${n.toLocaleString(locale === "de" ? "de-DE" : "en-US")} ${n === 1 ? t.lead : t.leads}`;
  const selection = useLeadSelectionContext();
  const { count, ids, isAdmin, total, notice } = selection;
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<OpenDialog>(null);

  if (count === 0) {
    return notice === "filters-changed" ? (
      <p role="status" className="mb-3 flex min-h-12 items-center gap-2 rounded-xl border bg-card px-4 text-sm text-muted-foreground">
        {t.clearedSelection}
        <Button variant="ghost" className="ms-auto h-10 px-3" onClick={selection.dismissNotice}>
          {t.dismiss}
        </Button>
      </p>
    ) : null;
  }

  const selectedIds = [...ids];
  const selectAllLabel = selectAllMatchingLabel(count, total);

  function run<T>(pendingText: string, action: () => Promise<ActionResult<T>>, onSuccess: (data: T) => void) {
    setMessage(pendingText);
    setDialog(null);
    startTransition(async () => {
      let result: ActionResult<T> | null;
      try {
        result = await action();
      } catch {
        result = null;
      }
      if (result === null) {
        setMessage(t.connectionDropped);
        return;
      }
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setMessage("");
      selection.clear();
      onSuccess(result.data);
      restoreFocus();
    });
  }

  /** The toolbar is about to unmount with the focus inside it: hand focus to the list's page checkbox. */
  function restoreFocus() {
    requestAnimationFrame(() => {
      const target =
        [...document.querySelectorAll<HTMLElement>('[data-slot="checkbox"][aria-label$="on this page"]')].find(
          (element) => element.getClientRects().length > 0,
        ) ?? document.getElementById("main-content");
      target?.focus({ preventScroll: true });
    });
  }

  function confirmed(text: string, undo: BulkUndo | null) {
    if (!undo) {
      toast.success(text);
      return;
    }
    toast.success(text, {
      duration: UNDO_MS,
      action: {
        label: t.undo,
        onClick: () => {
          void undoBulkChangeAction(undo).then(
            (result) => (result.ok ? toast.success(describeUndoResult(result.data)) : toast.error(result.error.message)),
            () => toast.error(t.undoFailed),
          );
        },
      },
    });
  }

  function assign(agent: BulkAgentOption | null) {
    run(
      agent ? `Assigning ${leadCount(count)} to ${agent.name}…` : `Unassigning ${leadCount(count)}…`,
      () => bulkAssignAction(selectedIds, agent?.id ?? null),
      (data) => confirmed(describeAssignResult(data, agent?.name ?? null), data.undo),
    );
  }

  function setStatus(status: LeadStatus) {
    run(
      `Moving ${leadCount(count)} to ${STATUS_LABELS[status]}…`,
      () => bulkUpdateStatusAction(selectedIds, status),
      (data) => confirmed(describeStatusResult(data, status), data.undo),
    );
  }

  function chooseStatus(status: LeadStatus) {
    // Only an admin can reopen Do Not Contact (D12), so an agent confirms first, as on the lead page.
    if (status === "DO_NOT_CONTACT" && !isAdmin) setDialog("do-not-contact");
    else setStatus(status);
  }

  function selectAllMatching() {
    setMessage(t.selectingAll);
    startTransition(async () => {
      try {
        const result = await listMatchingLeadIdsAction(selection.filters);
        if (!result.ok) {
          setMessage(result.error.message);
          return;
        }
        selection.replace(result.data.ids);
        setMessage(
          result.data.total > result.data.ids.length
            ? `Selected the first ${leadCount(result.data.ids.length)} of ${result.data.total.toLocaleString("en-US")}.`
            : `Selected all ${leadCount(result.data.ids.length)}.`,
        );
      } catch {
        setMessage(t.selectAllFailed);
      }
    });
  }

  function exportSelected() {
    setMessage(`Preparing a CSV of ${leadCount(count)}…`);
    startTransition(async () => {
      try {
        const response = await fetch("/api/leads/export", {
          method: "POST",
          body: new URLSearchParams({ ids: selectedIds.join(",") }),
          credentials: "same-origin",
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setMessage(
            body?.error === "rate_limited"
              ? t.exportRateLimited
              : t.exportFailed,
          );
          return;
        }
        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") ?? "";
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "funnel-mcqueen-leads.csv";
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setMessage("");
        toast.success(`Exported ${leadCount(count)}.`);
      } catch {
        setMessage(t.exportFailed);
      }
    });
  }

  return (
    <section
      aria-label={t.bulkAria}
      className="sticky top-14 z-20 -mx-4 mb-3 border-y bg-background px-4 py-2 md:top-0 md:mx-0 md:rounded-xl md:border md:px-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="flex min-h-12 items-center gap-2 pe-1 text-sm">
          <ListChecks aria-hidden className="size-5 text-primary" />
          <span>
            <span className="text-base font-extrabold tabular-nums">{count.toLocaleString(locale === "de" ? "de-DE" : "en-US")}</span> {t.selected}
          </span>
        </p>
        {selectAllLabel ? (
          <Button variant="ghost" className="order-last h-12 px-2 font-semibold text-primary sm:order-none sm:px-3" disabled={pending} onClick={selectAllMatching}>
            {selectAllLabel}
          </Button>
        ) : null}
        <Button variant="ghost" className="ms-auto h-12 gap-1 px-3 sm:ms-0" disabled={pending} onClick={selection.clear}>
          <X aria-hidden />
          {t.clearSelection}
        </Button>

        <div className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto">
          {isAdmin ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button className={cn(BUTTON, "font-bold")} disabled={pending}>
                  <UserPlus aria-hidden />
                  {t.assign}
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t.assignTo.replace("{count}", countLabel(count))}</DropdownMenuLabel>
                {agents.length === 0 ? (
                  <DropdownMenuItem disabled className="min-h-12">
                    {t.noAgents}
                  </DropdownMenuItem>
                ) : (
                  agents.map((agent) => (
                    <DropdownMenuItem key={agent.id} className="min-h-12" onSelect={() => assign(agent)}>
                      {agent.name}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="min-h-12 gap-2" onSelect={() => assign(null)}>
                  <UserMinus aria-hidden />
                  {t.unassign}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className={BUTTON} disabled={pending}>
                {t.setStatus}
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
              <DropdownMenuLabel className="text-xs text-muted-foreground">{t.moveTo.replace("{count}", countLabel(count))}</DropdownMenuLabel>
              {LEAD_STATUSES.map((status) => (
                <DropdownMenuItem key={status} className="min-h-12" onSelect={() => chooseStatus(status)}>
                  <StatusBadge status={status} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" className={cn(BUTTON, "hidden sm:inline-flex")} disabled={pending} onClick={() => setDialog("follow-up")}>
            <CalendarClock aria-hidden />
            {t.followUp}
          </Button>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="size-12" aria-label={t.moreActions} disabled={pending}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem className="min-h-12 gap-2 sm:hidden" onSelect={() => setDialog("follow-up")}>
                <CalendarClock aria-hidden />
                {t.setFollowUp}
              </DropdownMenuItem>
              <DropdownMenuItem className="min-h-12 gap-2" onSelect={() => setDialog("clear-follow-ups")}>
                <CalendarClock aria-hidden />
                {t.clearFollowUps}
              </DropdownMenuItem>
              {isAdmin ? (
                <>
                  <DropdownMenuItem className="min-h-12 gap-2" onSelect={() => setDialog("source")}>
                    <Tag aria-hidden />
                    {t.changeSource}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="min-h-12 gap-2" onSelect={() => setDialog("business-type")}>
                    <Store aria-hidden />
                    {t.setBusinessType}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuItem className="min-h-12 gap-2" onSelect={exportSelected}>
                <Download aria-hidden />
                {t.exportCsv}
              </DropdownMenuItem>
              {isAdmin ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-12 gap-2 text-destructive focus:text-destructive"
                    onSelect={() => setDialog("delete")}
                  >
                    <Trash2 aria-hidden />
                    {t.deleteLeads}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t.keptHint}
      </p>
      <p role="status" aria-live="polite" className={cn("text-sm font-semibold", message === "" && "sr-only")}>
        {message}
      </p>

      {dialog === "follow-up" ? (
        <BulkFollowUpDialog
          count={count}
          tz={tz}
          now={now}
          onClose={() => setDialog(null)}
          onSubmit={(due, note) =>
            run(
              `Setting a follow-up on ${leadCount(count)}…`,
              () => bulkScheduleFollowUpAction(selectedIds, due.toISOString(), note),
              (data) => confirmed(describeFollowUpResult(data), null),
            )
          }
        />
      ) : null}
      {dialog === "source" ? (
        <BulkSourceDialog
          count={count}
          sources={sources}
          onClose={() => setDialog(null)}
          onSubmit={(source) =>
            run(
              source === null ? `Clearing the source on ${leadCount(count)}…` : `Setting the source on ${leadCount(count)}…`,
              () => bulkSetSourceAction(selectedIds, source),
              (data) => confirmed(describeSourceResult(data, data.source), null),
            )
          }
        />
      ) : null}
      {dialog === "business-type" ? (
        <BulkBusinessTypeDialog
          count={count}
          onClose={() => setDialog(null)}
          onSubmit={(type) =>
            run(
              type === null ? `Clearing the business type on ${leadCount(count)}…` : `Setting the business type on ${leadCount(count)}…`,
              () => bulkSetBusinessTypeAction(selectedIds, type),
              (data) => confirmed(describeBusinessTypeResult(data, data.businessType), null),
            )
          }
        />
      ) : null}
      {dialog === "clear-follow-ups" ? (
        <BulkConfirmDialog
          title={t.clearFollowUpsTitle.replace("{count}", countLabel(count))}
          description={t.clearFollowUpsDescription}
          confirmLabel={t.clearFollowUps}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(`Clearing follow-ups on ${leadCount(count)}…`, () => bulkCompleteFollowUpsAction(selectedIds), (data) =>
              confirmed(describeCompletedFollowUps(data), null),
            )
          }
        />
      ) : null}
      {dialog === "do-not-contact" ? (
        <BulkConfirmDialog
          title={t.dncTitle.replace("{count}", countLabel(count))}
          description={t.dncDescription}
          confirmLabel={t.markDnc}
          destructive
          onClose={() => setDialog(null)}
          onConfirm={() => setStatus("DO_NOT_CONTACT")}
        />
      ) : null}
      {dialog === "delete" ? (
        <BulkConfirmDialog
          title={t.deleteTitle.replace("{count}", countLabel(count))}
          description={t.deleteDescription.replace("{count}", countLabel(count))}
          confirmLabel={t.delete.replace("{count}", countLabel(count))}
          destructive
          onClose={() => setDialog(null)}
          onConfirm={() =>
            run(`Deleting ${leadCount(count)}…`, () => bulkDeleteAction(selectedIds), (data) => confirmed(describeDeleteResult(data), null))
          }
        />
      ) : null}
    </section>
  );
}
