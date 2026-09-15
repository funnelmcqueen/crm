"use client";

// CONTRACT STUB: the stage 3 dialer agent replaces the implementation. Keep the export name and props.
import { Button } from "@/components/ui/button";
import type { DialableLead } from "@/lib/dialer/types";

export interface CallButtonProps {
  lead: DialableLead;
  size?: "default" | "lg";
  label?: string;
  className?: string;
}

export function CallButton({ label = "CALL", className }: CallButtonProps) {
  return (
    <Button type="button" disabled className={className}>
      {label}
    </Button>
  );
}
