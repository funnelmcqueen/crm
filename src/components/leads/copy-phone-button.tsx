"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { formatPhoneDisplay } from "@/lib/domain/phone";

export function CopyPhoneButton({ phone }: { phone: string }) {
  const display = formatPhoneDisplay(phone);

  async function copy() {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success("Phone number copied");
    } catch {
      toast.error("Could not copy. Long-press the number to copy it.");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy phone number ${display}`}
      className="group -mx-2 inline-flex min-h-12 items-center gap-2 rounded-lg px-2 text-lg font-bold tabular-nums outline-none transition-colors duration-100 select-text hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {display}
      <Copy aria-hidden className="size-4 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}
