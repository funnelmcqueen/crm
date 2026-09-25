"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { getAppErrorMessage } from "@/lib/i18n/app-error-message";
import { FlaskConical, Plus, TriangleAlert } from "lucide-react";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { formatPhoneDisplay, normalizePhone } from "@/lib/domain/phone";
import { addPhoneNumberAction } from "@/server/actions/phone-numbers";
import type { NumberVerificationMode } from "@/server/services/phone-numbers";

export interface AddNumberDialogProps {
  mode: NumberVerificationMode;
}

const LABEL_MAX = 100;

function ModeNote({ mode }: { mode: NumberVerificationMode }) {
  const t = useTranslations("admin");
  if (mode === "mock") {
    return (
      <div role="note" className="flex gap-3 rounded-lg border border-gold/60 bg-muted/60 p-3 text-sm">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-gold" />
        <div>
          <p className="font-bold">{t["Mock mode: not verified with Twilio"]}</p>
          <p className="text-muted-foreground">{t["Only fictional 555-01xx numbers are accepted, and a fake Twilio SID is stored."]}</p>
        </div>
      </div>
    );
  }
  if (mode === "unavailable") {
    return (
      <div role="alert" className="flex gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="font-bold">{t["Twilio is not configured"]}</p>
          <p className="text-muted-foreground">
            {t["Numbers cannot be verified until the Twilio environment variables are set on the server."]}
          </p>
        </div>
      </div>
    );
  }
  return null;
}

export function AddNumberDialog({ mode }: AddNumberDialogProps) {
  const t = useTranslations("admin");
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [e164, setE164] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const normalized = e164.trim() === "" ? null : normalizePhone(e164);
  const disabled = mode === "unavailable" || pending;

  function onOpenChange(next: boolean) {
    if (next) {
      setE164("");
      setLabel("");
      setError(null);
    }
    setOpen(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addPhoneNumberAction({ e164, label });
      if (result.ok) {
        toast.success(t["Added {number} to the pool"].replace("{number}", formatPhoneDisplay(result.data.e164)));
        setOpen(false);
      } else {
        setError(getAppErrorMessage(result.error.code, locale, result.error.message));
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="h-12 gap-2 px-5 font-bold">
          <Plus aria-hidden />
          {t["Add number"]}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t["Add a Twilio number"]}</DialogTitle>
            <DialogDescription>
              {t["Enter a number you already bought in Twilio. The CRM looks it up in your account, points its voice handler at the TwiML App and adds it to the shared pool."]}
            </DialogDescription>
          </DialogHeader>

          <ModeNote mode={mode} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-number-e164">{t["Number (E.164)"]}</Label>
            <Input
              id="add-number-e164"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+14155550150"
              required
              maxLength={40}
              value={e164}
              disabled={disabled}
              aria-describedby="add-number-e164-hint"
              aria-invalid={normalized !== null && !normalized.ok}
              onChange={(event) => setE164(event.target.value)}
              className="h-12 text-base tabular-nums lg:text-sm"
            />
            <p id="add-number-e164-hint" className="min-h-5 text-xs text-muted-foreground tabular-nums">
              {normalized === null
                ? t["Country code first, e.g. +1 for the US."]
                : normalized.ok
                  ? t["Saves as {number}"].replace("{number}", normalized.e164)
                  : t["Not a valid phone number yet."]}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-number-label">{t["Label (optional)"]}</Label>
            <Input
              id="add-number-label"
              placeholder={t["Main line, Chicago local…"]}
              maxLength={LABEL_MAX}
              value={label}
              disabled={disabled}
              onChange={(event) => setLabel(event.target.value)}
              className="h-12 text-base lg:text-sm"
            />
          </div>

          <p role="alert" aria-live="polite" className="min-h-5 text-sm font-semibold text-destructive">
            {error ?? ""}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" className="h-12" onClick={() => setOpen(false)} disabled={pending}>
              {t["Cancel"]}
            </Button>
            <Button type="submit" className="h-12 font-bold" disabled={disabled || normalized === null || !normalized.ok}>
              {pending ? t["Checking Twilio…"] : t["Add number"]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
