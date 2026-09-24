"use client";

import { Phone } from "lucide-react";
import { useId } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { telHref } from "@/lib/dialer/resolve-mode";
import { activeLeadId, type DialerState } from "@/lib/dialer/state";
import type { DialableLead } from "@/lib/dialer/types";
import { isDialable } from "@/lib/domain/statuses";
import { E164_PATTERN } from "@/lib/domain/phone";
import { cn } from "@/lib/utils";
import { useDialer } from "./dialer-context";
import { useTranslations } from "@/components/i18n/locale-provider";

export interface CallButtonProps {
  lead: DialableLead;
  size?: "default" | "lg";
  label?: string;
  className?: string;
}

function busyLabel(state: DialerState, t: ReturnType<typeof useTranslations>): string {
  switch (state.kind) {
    case "preparing":
    case "tel-pending":
      return t.calling;
    case "ringing":
      return t.ringing;
    case "in-call":
      return t.inCall;
    default:
      return t.logOutcome;
  }
}

export function CallButton({ lead, size = "default", label = "CALL", className }: CallButtonProps) {
  const dialer = useDialer();
  const t = useTranslations("workspace");
  const reasonId = useId();

  const base = cn(
    "inline-flex items-center justify-center gap-2 rounded-xl bg-primary font-extrabold tracking-wide text-primary-foreground uppercase outline-none select-none transition-colors duration-150 hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px [&_svg]:size-5 [&_svg]:shrink-0",
    size === "lg" ? "min-h-14 w-full px-8 text-lg md:w-auto" : "min-h-12 px-5 text-base",
  );
  const accessibleName = t.callAria.replace("{name}", lead.businessName);

  let text = label === "CALL" ? t.callUpper : label === "Call back" ? t.callBack : label;
  let reason: string | null = null;
  if (!dialer) {
    reason = t.callingUnavailable;
  } else if (!isDialable(lead.status)) {
    text = t.statuses.DO_NOT_CONTACT;
    reason = t.dncReason;
  } else if (!E164_PATTERN.test(lead.phone)) {
    text = t.phoneNeeded;
    reason = t.phoneNeededReason;
  } else if (dialer.state.kind !== "idle") {
    if (activeLeadId(dialer.state) === lead.id) text = busyLabel(dialer.state, t);
    reason = dialer.state.kind === "wrap-up" ? t.logLastCallFirst : t.anotherCallActive;
  } else if (dialer.connecting) {
    text = t.connecting;
    reason = t.gettingCallingReady;
  }

  if (reason !== null || !dialer) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-describedby={reasonId}
            className={cn(
              "inline-flex rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              size === "lg" && "w-full md:w-auto",
              className,
            )}
          >
            <button
              type="button"
              disabled
              aria-label={accessibleName}
              className={cn(base, "pointer-events-none flex-1 opacity-50")}
            >
              <Phone aria-hidden />
              {text}
            </button>
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    );
  }

  if (dialer.dialMode === "tel") {
    return (
      <a
        href={telHref(lead.phone)}
        aria-label={accessibleName}
        data-call-mode="tel"
        className={cn(base, className)}
        onClick={(event) => {
          if (!dialer.beginTelCall(lead)) event.preventDefault();
        }}
      >
        <Phone aria-hidden />
        {text}
      </a>
    );
  }

  return (
    <button
      type="button"
      aria-label={accessibleName}
      data-call-mode="in-app"
      className={cn(base, className)}
      onClick={() => dialer.startCall(lead)}
    >
      <Phone aria-hidden />
      {text}
    </button>
  );
}
