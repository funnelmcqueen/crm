"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { formatNumber } from "@/lib/i18n/format";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { updateAgentTargetAction, updateCompanySettingsAction } from "@/server/actions/settings";
import type { AgentTargetRow, CompanySettings } from "@/server/services/settings";
import { TimeZoneSelect } from "./time-zone-select";

const INPUT_CLASS = "h-12 text-base lg:text-sm";
const MAX_GREETING = 500;

function parseTarget(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n <= 1000 ? n : null;
}

export function CompanySettingsForm({ company }: { company: CompanySettings }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [form, setForm] = useState({
    companyName: company.companyName,
    target: String(company.defaultDailyTarget),
    timezone: company.defaultTimezone,
    greeting: company.voicemailGreeting,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const greetingLength = form.greeting.trim().length;
  const tooLong = greetingLength > MAX_GREETING;

  function submit(event: FormEvent) {
    event.preventDefault();
    const target = parseTarget(form.target);
    if (target === null) {
      setError(locale === "de" ? "Gib ein Standard-Tagesziel zwischen 0 und 1000 ein." : "Enter a default daily target between 0 and 1000.");
      return;
    }
    if (tooLong) {
      setError(locale === "de" ? `Die Mailboxansage darf höchstens ${MAX_GREETING} Zeichen enthalten.` : `The voicemail greeting can be at most ${MAX_GREETING} characters.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateCompanySettingsAction({
        company_name: form.companyName,
        default_daily_target: target,
        default_timezone: form.timezone,
        voicemail_greeting: form.greeting,
      });
      if (result.ok) {
        setForm({
          companyName: result.data.companyName,
          target: String(result.data.defaultDailyTarget),
          timezone: result.data.defaultTimezone,
          greeting: result.data.voicemailGreeting,
        });
        toast.success(t.companySaved);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="company-name">{t.companyName}</Label>
        <Input
          id="company-name"
          required
          maxLength={100}
          value={form.companyName}
          onChange={(e) => setForm((prev) => ({ ...prev, companyName: e.target.value }))}
          className={INPUT_CLASS}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="company-target">{t.defaultCalls}</Label>
          <Input
            id="company-target"
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
          <Label htmlFor="company-timezone">{t.defaultTimezone}</Label>
          <TimeZoneSelect
            id="company-timezone"
            value={form.timezone}
            onChange={(timezone) => setForm((prev) => ({ ...prev, timezone }))}
            disabled={pending}
          />
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t.newAgentsDefaults}</p>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="company-greeting">{t.voicemailGreeting}</Label>
          <span
            id="company-greeting-count"
            aria-live="polite"
            className={cn("text-xs tabular-nums", tooLong ? "font-semibold text-destructive" : "text-muted-foreground")}
          >
            {formatNumber(greetingLength, locale)}/{formatNumber(MAX_GREETING, locale)}
          </span>
        </div>
        <Textarea
          id="company-greeting"
          required
          rows={4}
          aria-describedby="company-greeting-count company-greeting-help"
          aria-invalid={tooLong || undefined}
          value={form.greeting}
          onChange={(e) => setForm((prev) => ({ ...prev, greeting: e.target.value }))}
          className="min-h-28 text-base lg:text-sm"
        />
        <p id="company-greeting-help" className="text-xs text-muted-foreground">
          {locale === "de" ? "Wird Anrufern vor dem Signalton vorgespielt, wenn niemand antwortet." : "Read to callers before the beep when nobody answers."}
        </p>
      </div>
      <p role="alert" aria-live="polite" className="min-h-5 text-sm font-semibold text-destructive">
        {error ?? ""}
      </p>
      <div>
        <Button type="submit" className="h-12 px-5 font-bold" disabled={pending || tooLong}>
          {pending ? t.saving : locale === "de" ? "Unternehmenseinstellungen speichern" : "Save company settings"}
        </Button>
      </div>
    </form>
  );
}

function AgentTargetRowForm({ row }: { row: AgentTargetRow }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [saved, setSaved] = useState(row.dailyCallTarget);
  const [value, setValue] = useState(String(row.dailyCallTarget));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const parsed = parseTarget(value);
  const dirty = parsed !== saved;
  const inputId = `agent-target-${row.userId}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (parsed === null) {
      setError("0 to 1000");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateAgentTargetAction(row.userId, parsed);
      if (result.ok) {
        setSaved(result.data.dailyCallTarget);
        setValue(String(result.data.dailyCallTarget));
        toast.success(`${row.name}: ${formatNumber(result.data.dailyCallTarget, locale)} ${t.callsADay}`);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <li>
      <form onSubmit={submit} className="flex items-center gap-3 py-2">
        <label htmlFor={inputId} className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {row.name}
            {row.active ? null : <span className="ml-2 text-xs font-semibold text-destructive">{locale === "de" ? "Deaktiviert" : "Disabled"}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{row.email}</span>
          {error ? (
            <span role="alert" className="block text-xs font-semibold text-destructive">
              {error}
            </span>
          ) : null}
        </label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={0}
          max={1000}
          step={1}
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={parsed === null || undefined}
          className="h-12 w-24 text-right text-base font-extrabold tabular-nums lg:text-sm"
        />
        <Button type="submit" variant={dirty ? "default" : "outline"} className="h-12 min-w-20 px-2 font-bold" disabled={pending || !dirty}>
          {pending ? "…" : t.save}
        </Button>
      </form>
    </li>
  );
}

export function AgentTargetsList({ rows }: { rows: AgentTargetRow[] }) {
  const t = useTranslations("operations");
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t.noAgents}</p>;
  return (
    <ul className="flex flex-col divide-y">
      {rows.map((row) => (
        <AgentTargetRowForm key={row.userId} row={row} />
      ))}
    </ul>
  );
}
