"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { Check, Copy, UserPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { TimeZoneSelect } from "@/components/settings/time-zone-select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/domain/statuses";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import {
  agentDeleteCheckAction,
  bulkReassignAction,
  countReassignableLeadsAction,
  createAgentAction,
  deleteAgentAction,
  setAgentActiveAction,
  updateAgentProfileAction,
} from "@/server/actions/agents";
import type { AgentDeleteCheck, CreateAgentResult } from "@/server/services/agents";
import { formatCount } from "./format";

const INPUT_CLASS = "h-12 text-base lg:text-sm";

function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" aria-live="polite" className="min-h-5 text-sm font-semibold text-destructive">
      {message ?? ""}
    </p>
  );
}

function parseTarget(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n <= 1000 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface CreateAgentDialogProps {
  defaultTarget: number;
  defaultTimezone: string;
}

export function CreateAgentDialog({ defaultTarget, defaultTimezone }: CreateAgentDialogProps) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  const blank = { name: "", email: "", target: String(defaultTarget), timezone: defaultTimezone, primaryLocale: "en" as "en" | "de" };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateAgentResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      setForm(blank);
      setError(null);
    }
    // The one-time password only lives in this dialog's state; closing forgets it.
    setCreated(null);
    setCopied(false);
    setOpen(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const target = parseTarget(form.target);
    if (target === null) {
      setError(t["Target must be between 0 and 1000."]);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createAgentAction({
        name: form.name,
        email: form.email,
        dailyCallTarget: target,
        timezone: form.timezone,
        primaryLocale: form.primaryLocale,
      });
      if (result.ok) {
        setCreated(result.data);
        toast.success(t["{name} was created"].replace("{name}", result.data.name));
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  async function copyPassword() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.password);
      setCopied(true);
    } catch {
      toast.error(t["Copy failed. Select the password and copy it manually."]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="h-12 gap-2 px-4 font-bold">
          <UserPlus aria-hidden />
          {t["Create agent"]}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        // Keep the password on screen until the admin explicitly closes the dialog.
        onInteractOutside={(event) => {
          if (created) event.preventDefault();
        }}
      >
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t["Agent created"]}</DialogTitle>
              <DialogDescription>{t["{name} signs in with {email} and this one-time password."].replace("{name}", created.name).replace("{email}", created.email)}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-muted p-2 pl-3">
              <code
                aria-label={t["One-time password"]}
                className="min-w-0 flex-1 font-mono text-base font-bold break-all select-all"
              >
                {created.password}
              </code>
              <Button type="button" variant="outline" className="h-12 gap-2 px-3" onClick={() => void copyPassword()}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? t["Copied"] : t["Copy"]}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t["Share it securely; the agent can change it in Settings. It is shown only once."]}
            </p>
            {created.warning ? (
              <p role="alert" className="text-sm font-semibold text-destructive">
                {created.warning}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" className="h-12 font-bold" onClick={() => onOpenChange(false)}>
                {t["Done"]}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t["Create agent"]}</DialogTitle>
              <DialogDescription>{t["They get a one-time password to sign in with."]}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-agent-name">{t["Name"]}</Label>
              <Input
                id="create-agent-name"
                required
                maxLength={200}
                autoComplete="off"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-agent-email">{t["Email"]}</Label>
              <Input
                id="create-agent-email"
                type="email"
                inputMode="email"
                required
                autoComplete="off"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                className={INPUT_CLASS}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-agent-target">{t["Daily calls"]}</Label>
                <Input
                  id="create-agent-target"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1000}
                  step={1}
                  required
                  value={form.target}
                  onChange={(e) => setForm((prev) => ({ ...prev, target: e.target.value }))}
                  className={`${INPUT_CLASS} tabular-nums`}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="create-agent-timezone">{t["Time zone"]}</Label>
                <TimeZoneSelect
                  id="create-agent-timezone"
                  value={form.timezone}
                  onChange={(timezone) => setForm((prev) => ({ ...prev, timezone }))}
                  disabled={pending}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-agent-language">{t["Primary language"]}</Label>
              <Select value={form.primaryLocale} onValueChange={(primaryLocale: "en" | "de") => setForm((prev) => ({ ...prev, primaryLocale }))}>
                <SelectTrigger id="create-agent-language" className={INPUT_CLASS} disabled={pending}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">{t["English"]}</SelectItem>
                  <SelectItem value="de">{t["Deutsch"]}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FormError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" className="h-12" onClick={() => onOpenChange(false)} disabled={pending}>
                {t["Cancel"]}
              </Button>
              <Button type="submit" className="h-12 font-bold" disabled={pending}>
                {pending ? t["Creating…"] : t["Create agent"]}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------------

export interface EditableAgent {
  userId: string;
  name: string;
  dailyCallTarget: number;
  timezone: string;
  primaryLocale: "en" | "de";
}

export function EditAgentDialog({ agent, onClose }: { agent: EditableAgent; onClose(): void }) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  const [form, setForm] = useState({ name: agent.name, target: String(agent.dailyCallTarget), timezone: agent.timezone, primaryLocale: agent.primaryLocale });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    const target = parseTarget(form.target);
    if (target === null) {
      setError(t["Target must be between 0 and 1000."]);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateAgentProfileAction(agent.userId, {
        name: form.name,
        dailyCallTarget: target,
        timezone: form.timezone,
        primaryLocale: form.primaryLocale,
      });
      if (result.ok) {
        toast.success(t["{name} was updated"].replace("{name}", result.data.name));
        onClose();
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t["Edit agent"]}</DialogTitle>
            <DialogDescription>{t["“Today” in their stats follows this time zone."]}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-name">{t["Name"]}</Label>
            <Input
              id="edit-agent-name"
              required
              maxLength={200}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              className={INPUT_CLASS}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-agent-target">{t["Daily calls"]}</Label>
              <Input
                id="edit-agent-target"
                type="number"
                inputMode="numeric"
                min={0}
                max={1000}
                step={1}
                required
                value={form.target}
                onChange={(e) => setForm((prev) => ({ ...prev, target: e.target.value }))}
                className={`${INPUT_CLASS} tabular-nums`}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="edit-agent-timezone">{t["Time zone"]}</Label>
              <TimeZoneSelect
                id="edit-agent-timezone"
                value={form.timezone}
                onChange={(timezone) => setForm((prev) => ({ ...prev, timezone }))}
                disabled={pending}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-agent-language">{t["Primary language"]}</Label>
            <Select value={form.primaryLocale} onValueChange={(primaryLocale: "en" | "de") => setForm((prev) => ({ ...prev, primaryLocale }))}>
              <SelectTrigger id="edit-agent-language" className={INPUT_CLASS} disabled={pending}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">{t["English"]}</SelectItem>
                <SelectItem value="de">{t["Deutsch"]}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" className="h-12" onClick={onClose} disabled={pending}>
              {t["Cancel"]}
            </Button>
            <Button type="submit" className="h-12 font-bold" disabled={pending}>
              {pending ? t["Saving…"] : t["Save"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Disable / reactivate
// ---------------------------------------------------------------------------------------------

export interface ActiveToggleAgent {
  userId: string;
  name: string;
  active: boolean;
  leadsAssigned: number;
}

export function SetAgentActiveDialog({ agent, onClose }: { agent: ActiveToggleAgent; onClose(): void }) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  const [pending, startTransition] = useTransition();
  const disabling = agent.active;

  function confirm() {
    startTransition(async () => {
      const result = await setAgentActiveAction(agent.userId, !disabling);
      if (result.ok) {
        toast.success((disabling ? t["{name} was disabled"] : t["{name} was reactivated"]).replace("{name}", agent.name));
        onClose();
      } else {
        toast.error(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{(disabling ? t["Disable {name}?"] : t["Reactivate {name}?"]).replace("{name}", agent.name)}</AlertDialogTitle>
          <AlertDialogDescription>
            {disabling ? (
              <>
                {t["Sign-in is blocked right away and any open session stops working. Callbacks go to voicemail."]}{" "}
                {agent.leadsAssigned > 0
                  ? t["Their {count} leads remain assigned until you reassign them."].replace("{count}", formatCount(agent.leadsAssigned))
                  : t["They have no leads assigned."]}{" "}
                {t["Call history and stats are kept."]}
              </>
            ) : (
              t["They can sign in again with their existing password and see their assigned leads."]
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-12" disabled={pending}>
            {t["Cancel"]}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={disabling ? "destructive" : "default"}
            className="h-12 font-bold"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {pending ? (disabling ? t["Disabling…"] : t["Reactivating…"]) : disabling ? t["Disable agent"] : t["Reactivate"]}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

export interface DeletableAgent {
  userId: string;
  name: string;
}

function countText(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

export interface DeleteAgentDialogProps {
  agent: DeletableAgent;
  onClose(): void;
  /** Opens the reassign dialog for this agent (offered while they still have leads). */
  onReassign(): void;
}

export function DeleteAgentDialog({ agent, onClose, onReassign }: DeleteAgentDialogProps) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  // Keyed by `checkKey`, so a check that belongs to an earlier attempt is never shown as current.
  const [loaded, setLoaded] = useState<{ key: number; check: AgentDeleteCheck | null; error: string | null }>({
    key: -1,
    check: null,
    error: null,
  });
  const [checkKey, setCheckKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    agentDeleteCheckAction(agent.userId)
      .then((result) => {
        if (cancelled) return;
        setLoaded(
          result.ok
            ? { key: checkKey, check: result.data, error: null }
            : { key: checkKey, check: null, error: getAppErrorMessage(result.error.code, locale, result.error.message) },
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: checkKey, check: null, error: t["This agent could not be checked. Try again."] });
      });
    return () => {
      cancelled = true;
    };
  }, [agent.userId, checkKey, locale, t]);

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAgentAction(agent.userId);
      if (result.ok) {
        toast.success(t["{name} was deleted"].replace("{name}", agent.name));
        onClose();
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
        // Whatever went wrong (new work was assigned meanwhile, or closing the login stopped half way),
        // check again so the dialog offers what is possible now.
        setCheckKey((key) => key + 1);
      }
    });
  }

  const loading = loaded.key !== checkKey;
  const check = loading ? null : loaded.check;
  const loadError = loading ? null : loaded.error;
  const hasWork = check?.reason === "has_work";
  const unfinished = check?.reason === "deleted" && !check.loginClosed;
  const deletable = check?.deletable === true;

  let title = t["Delete {name}?"].replace("{name}", agent.name);
  let description: ReactNode;
  if (loading) {
    description = t["Checking their leads and follow-ups…"];
  } else if (loadError !== null || check === null) {
    description = loadError ?? t["This agent could not be checked. Try again."];
  } else if (hasWork) {
    title = t["{name} still has work"].replace("{name}", agent.name);
    const work = [
      check.leads > 0 ? countText(check.leads, t["lead"], t["leads"]) : null,
      check.openFollowUps > 0 ? countText(check.openFollowUps, t["open follow-up"], t["open follow-ups"]) : null,
    ]
      .filter(Boolean)
      .join(locale === "de" ? " und " : " and ");
    description = (check.leads > 0 ? t["They still have {work}. Reassign their leads to another agent first (open follow-ups go with the leads). Then you can delete them."] : t["They still have {work} on leads they no longer own. Complete those on the Follow-ups page, then you can delete them."]).replace("{work}", work);
  } else if (unfinished) {
    title = t["Finish deleting {name}?"].replace("{name}", agent.name);
    description = t["They’re already removed from the CRM, but closing their login didn’t finish. Finish now to sign them out for good and free their email for a new agent."];
  } else if (check.reason === "deleted") {
    description = t["This agent was already deleted."];
  } else if (!deletable) {
    description = t["Only agents can be deleted, and never your own account."];
  } else {
    const kept = [
      check.calls > 0 ? countText(check.calls, t["call"], t["calls"]) : null,
      check.completedFollowUps > 0 ? countText(check.completedFollowUps, t["completed follow-up"], t["completed follow-ups"]) : null,
    ].filter(Boolean);
    description = (
      <>
        {t["They’ll be signed out and can’t sign in again. Their email can be reused for a new agent."]}{" "}
        {kept.length > 0 ? t["Their {kept} stay in your reports."].replace("{kept}", kept.join(locale === "de" ? " und " : " and ")) : t["Past calls stay in your reports."]}{" "}
        {check.phoneNumbers > 0
          ? t["{count} phone numbers go back to the pool."].replace("{count}", formatCount(check.phoneNumbers))
          : null}
      </>
    );
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription aria-live="polite">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <FormError message={error} />
        <AlertDialogFooter>
          <AlertDialogCancel className="h-12" disabled={pending}>
            {hasWork ? t["Close"] : t["Cancel"]}
          </AlertDialogCancel>
          {hasWork && check && check.leads > 0 ? (
            <Button type="button" className="h-12 font-bold" onClick={onReassign}>
              {t["Reassign leads"]}
            </Button>
          ) : null}
          {hasWork && check && check.leads === 0 ? (
            <Button asChild className="h-12 font-bold">
              <Link href="/follow-ups">{t["Open Follow-ups"]}</Link>
            </Button>
          ) : null}
          {deletable || unfinished ? (
            <AlertDialogAction
              variant="destructive"
              className="h-12 font-bold"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                confirm();
              }}
            >
              {unfinished ? (pending ? t["Finishing…"] : t["Finish deleting"]) : pending ? t["Deleting…"] : t["Delete agent"]}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Bulk reassign
// ---------------------------------------------------------------------------------------------

const UNASSIGNED = "__unassigned";

export interface ReassignTarget {
  userId: string;
  name: string;
  role: "ADMIN" | "AGENT";
}

export interface ReassignLeadsDialogProps {
  from: { userId: string; name: string };
  targets: ReassignTarget[];
  onClose(): void;
}

export function ReassignLeadsDialog({ from, targets, onClose }: ReassignLeadsDialogProps) {
  const t = useTranslations("admin");
  const w = useTranslations("workspace");
  const { locale } = useLocale();
  const options = targets.filter((t) => t.userId !== from.userId);
  const [target, setTarget] = useState<string>(options.find((t) => t.role === "AGENT")?.userId ?? UNASSIGNED);
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [counted, setCounted] = useState<{ key: string; count: number | null }>({ key: "", count: null });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const countKey = `${from.userId}|${statuses.join(",")}`;
  useEffect(() => {
    let cancelled = false;
    countReassignableLeadsAction(from.userId, statuses)
      .then((result) => {
        if (!cancelled) setCounted({ key: countKey, count: result.ok ? result.data.count : null });
      })
      .catch(() => {
        if (!cancelled) setCounted({ key: countKey, count: null });
      });
    return () => {
      cancelled = true;
    };
  }, [countKey, from.userId, statuses]);

  const loading = counted.key !== countKey;
  const count = loading ? null : counted.count;
  const targetName = target === UNASSIGNED ? null : (options.find((option) => option.userId === target)?.name ?? t["this agent"]);

  function toggleStatus(status: LeadStatus, checked: boolean) {
    setStatuses((prev) =>
      checked ? LEAD_STATUSES.filter((s) => s === status || prev.includes(s)) : prev.filter((s) => s !== status),
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await bulkReassignAction({
        fromUserId: from.userId,
        toUserId: target === UNASSIGNED ? null : target,
        statuses,
      });
      if (result.ok) {
        const moved = formatCount(result.data.count);
        toast.success(targetName ? t["Moved {count} leads to {name}"].replace("{count}", moved).replace("{name}", targetName) : t["Unassigned {count} leads"].replace("{count}", moved));
        onClose();
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next || pending ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t["Reassign {name}’s leads"].replace("{name}", from.name)}</DialogTitle>
            <DialogDescription>{t["Open follow-ups move with the leads. Call history stays with the lead, and stats stay with whoever made the calls."]}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reassign-to">{t["Move to"]}</Label>
            <Select value={target} onValueChange={setTarget} disabled={pending}>
              <SelectTrigger id="reassign-to" className="w-full px-3 text-base data-[size=default]:h-12 lg:text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start" className="max-h-80">
                <SelectItem value={UNASSIGNED} className="min-h-12">
                  {t["Unassigned"]}
                </SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.userId} value={option.userId} className="min-h-12">
                    {option.name}
                    {option.role === "ADMIN" ? ` (${locale === "de" ? "Admin" : "admin"})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t["Only these statuses"]} <span className="font-normal text-muted-foreground">{t["(optional; none = all leads)"]}</span>
            </legend>
            <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
              {LEAD_STATUSES.map((status) => {
                const id = `reassign-status-${status}`;
                return (
                  <label key={status} htmlFor={id} className="flex min-h-12 cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={statuses.includes(status)}
                      onCheckedChange={(checked) => toggleStatus(status, checked === true)}
                      disabled={pending}
                    />
                    {w.statuses[status]}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <p aria-live="polite" className="text-sm">
            {loading ? (
              <span className="text-muted-foreground">{t["Counting leads…"]}</span>
            ) : count === null ? (
              <span className="text-destructive">{t["Could not count the leads."]}</span>
            ) : (
              <span className="font-extrabold tabular-nums">{(targetName ? t["{count} leads will move to {name}."].replace("{name}", targetName) : t["{count} leads will become unassigned."]).replace("{count}", formatCount(count))}</span>
            )}
          </p>

          <FormError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" className="h-12" onClick={onClose} disabled={pending}>
              {t["Cancel"]}
            </Button>
            <Button type="submit" className="h-12 font-bold" disabled={pending || loading || !count}>
              {pending ? t["Reassigning…"] : t["Reassign leads"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
