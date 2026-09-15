"use client";

// CONTRACT STUB: the stage 3 dialer agent replaces the implementation. Keep the export names and props.
import type { ReactNode } from "react";
import type { DialerDriverName } from "@/lib/dialer/types";

export interface DialerProviderProps {
  userId: string;
  defaultDriver: DialerDriverName;
  inAppEnabled: boolean;
  timezone: string;
  children: ReactNode;
}

export function DialerProvider({ children }: DialerProviderProps) {
  return <>{children}</>;
}
