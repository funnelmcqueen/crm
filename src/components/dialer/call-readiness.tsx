"use client";

import Link from "next/link";
import { E164_PATTERN } from "@/lib/domain/phone";
import { useDialer } from "./dialer-context";

/** Read-only status; never changes the user's call mode or provider settings. */
export function CallReadiness({ phone }: { phone: string }) {
  const dialer = useDialer();
  if (!E164_PATTERN.test(phone)) return <p role="status" className="text-sm font-semibold text-destructive">A valid phone number is needed. Ask your admin to update this lead.</p>;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {dialer?.connecting ? "Getting calling ready…" : dialer?.dialMode === "in-app"
        ? "Calls connect here in the CRM. Log the outcome when you hang up."
        : "CALL opens your phone app. Return here to log the outcome."}
      {" "}<Link href="/settings" className="inline-flex min-h-12 items-center rounded px-1 font-semibold underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50">Call settings</Link>
    </p>
  );
}
