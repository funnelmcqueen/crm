"use client";

import { Phone, PhoneOff } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { IncomingContext } from "@/lib/dialer/state";
import { STATUS_TONE, type StatusTone } from "@/lib/domain/statuses";
import { useTranslations } from "@/components/i18n/locale-provider";
import { cn } from "@/lib/utils";

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  neutral: "bg-muted text-foreground",
  info: "bg-secondary text-foreground ring-1 ring-border",
  warning: "bg-accent text-foreground",
  success: "bg-success/15 text-success",
  gold: "bg-gold text-gold-foreground",
  danger: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

export interface IncomingCallDialogProps {
  context: IncomingContext;
  onAccept(): void;
  onDecline(): void;
}

/** Shows the caller's lead only when it is the agent's own lead; everything else is "Unknown caller". */
export function IncomingCallDialog({ context, onAccept, onDecline }: IncomingCallDialogProps) {
  return <Dialog open><IncomingCallContent context={context} onAccept={onAccept} onDecline={onDecline} /></Dialog>;
}

export function IncomingCallContent({ context, onAccept, onDecline }: IncomingCallDialogProps) {
  return (
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="gap-5 p-5 sm:max-w-md"
      >
        <IncomingCallBody context={context} onAccept={onAccept} onDecline={onDecline} />
      </DialogContent>
  );
}

export function IncomingCallBody({ context, onAccept, onDecline }: IncomingCallDialogProps) {
  const t = useTranslations("workspace");
  return (
    <>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-bold tracking-wide text-primary uppercase">{t.incomingCall}</p>
          {context.status === "loading" ? (
            <>
              <DialogTitle className="sr-only">{t.incomingCall}</DialogTitle>
              <Skeleton className="h-7 w-3/4" />
              <Skeleton className="h-5 w-1/2" />
              <DialogDescription className="sr-only">{t.lookingUpCaller}</DialogDescription>
            </>
          ) : context.status === "lead" ? (
            <>
              <DialogTitle className="text-2xl leading-tight font-extrabold">{context.lead.businessName}</DialogTitle>
              <DialogDescription className="text-base text-muted-foreground">
                {context.lead.contactName || t.noContactName}
              </DialogDescription>
              <span
                className={cn(
                  "mt-1 inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-bold",
                  TONE_CLASS[STATUS_TONE[context.lead.status]],
                )}
              >
                {t.statuses[context.lead.status]}
              </span>
            </>
          ) : (
            <>
              <DialogTitle className="text-2xl leading-tight font-extrabold">{t.unknownCaller}</DialogTitle>
              <DialogDescription className="text-base text-muted-foreground">
                {t.unknownCallerDescription}
              </DialogDescription>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onDecline}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border bg-card text-base font-bold outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-5"
          >
            <PhoneOff aria-hidden />
            {t.decline}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onAccept}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-primary text-base font-extrabold text-primary-foreground outline-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:size-5"
          >
            <Phone aria-hidden />
            {t.accept}
          </button>
        </div>
    </>
  );
}
