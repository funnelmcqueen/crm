"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { toast } from "sonner";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, requestEmailChangeAction, updateOwnNameAction } from "@/server/actions/settings";

const INPUT_CLASS = "h-12 text-base lg:text-sm";
const MIN_PASSWORD = 10;

function Message({ tone, children }: { tone: "error" | "info"; children: string | null }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={tone === "error" ? "min-h-5 text-sm font-semibold text-destructive" : "min-h-5 text-sm text-muted-foreground"}
    >
      {children ?? ""}
    </p>
  );
}

export function NameForm({ name }: { name: string }) {
  const t = useTranslations("operations");
  const { locale } = useLocale();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== name;

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateOwnNameAction(value);
      if (result.ok) {
        setValue(result.data.name);
        toast.success(t.nameSaved);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor="settings-name">Name</Label>
      <div className="flex gap-2">
        <Input
          id="settings-name"
          required
          maxLength={200}
          autoComplete="name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
        <Button type="submit" className="h-12 px-4 font-bold" disabled={pending || !dirty}>
          {pending ? t.saving : t.save}
        </Button>
      </div>
      <Message tone="error">{error}</Message>
    </form>
  );
}

export type EmailChangeNotice = "confirmed" | "failed" | "invalid" | null;

export function EmailForm({ email, notice }: { email: string; notice: EmailChangeNotice }) {
  const t = useTranslations("operations");
  const { locale } = useLocale();
  const noticeText = { confirmed: { tone: "info" as const, text: t.emailConfirmed }, failed: { tone: "error" as const, text: t.emailFailed }, invalid: { tone: "error" as const, text: t.emailInvalid } };
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(notice ? noticeText[notice].text : null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    const requested = value.trim();
    startTransition(async () => {
      const result = await requestEmailChangeAction(requested);
      if (!result.ok) {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
        return;
      }
      setValue("");
      if (result.data.pending) {
        setInfo(locale === "de" ? `Prüfe beide Postfächer: Bestätige die Änderung über die Links an ${email} und ${requested}. Bis dahin meldest du dich mit ${email} an.` : `Check both inboxes: confirm the change from the links sent to ${email} and ${requested}. Until then you sign in with ${email}.`);
      } else {
        setInfo(locale === "de" ? `Deine E-Mail-Adresse ist jetzt ${result.data.email}. Verwende sie bei der nächsten Anmeldung.` : `Your email is now ${result.data.email}. Use it the next time you sign in.`);
        toast.success(t.emailChanged);
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor="settings-email">{t.email}</Label>
      <p className="text-sm">
        <span className="text-muted-foreground">{t.current}</span> <span className="font-semibold break-all">{email}</span>
      </p>
      <div className="flex gap-2">
        <Input
          id="settings-email"
          type="email"
          inputMode="email"
          required
          autoComplete="email"
          placeholder={t.newEmail}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
        />
        <Button type="submit" variant="outline" className="h-12 px-4" disabled={pending || value.trim() === ""}>
          {pending ? t.sending : t.change}
        </Button>
      </div>
      {error ? (
        <Message tone="error">{error}</Message>
      ) : (
        <Message tone={notice && info === noticeText[notice].text ? noticeText[notice].tone : "info"}>{info}</Message>
      )}
    </form>
  );
}

export function PasswordForm() {
  const t = useTranslations("operations");
  const { locale } = useLocale();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (next.length < MIN_PASSWORD) {
      setError(locale === "de" ? `Verwende mindestens ${MIN_PASSWORD} Zeichen.` : `Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (next !== confirm) {
      setError(t.passwordMismatch);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await changePasswordAction({ currentPassword: current, newPassword: next });
      if (result.ok) {
        setCurrent("");
        setNext("");
        setConfirm("");
        toast.success(t.passwordChanged);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t.password}</p>
      {/* Lets password managers attach the new password to the right account. */}
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-current-password" className="text-xs text-muted-foreground">
          {t.currentPassword}
        </Label>
        <Input
          id="settings-current-password"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-new-password" className="text-xs text-muted-foreground">
            {t.newPassword} <span className="font-normal">{t.characters10}</span>
          </Label>
          <Input
            id="settings-new-password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            maxLength={72}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-confirm-password" className="text-xs text-muted-foreground">
            {t.confirmPassword}
          </Label>
          <Input
            id="settings-confirm-password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            maxLength={72}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <Message tone="error">{error}</Message>
      <div>
        <Button type="submit" variant="outline" className="h-12 px-4" disabled={pending}>
          {pending ? t.changing : t.changePassword}
        </Button>
      </div>
    </form>
  );
}
