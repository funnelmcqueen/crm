"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTranslations } from "@/components/i18n/locale-provider";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export interface KeypadProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onDigit(digit: string): void;
}

/** DTMF keypad for phone menus during a call. */
export function Keypad({ open, onOpenChange, onDigit }: KeypadProps) {
  const t = useTranslations("workspace");
  const [entered, setEntered] = useState("");

  const press = (key: string) => {
    onDigit(key);
    setEntered((value) => (value + key).slice(-24));
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setEntered("");
        onOpenChange(next);
      }}
    >
      <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div className="mx-auto w-full max-w-sm">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle className="text-lg font-bold">{t.keypad}</SheetTitle>
            <SheetDescription>{t.keypadTones}</SheetDescription>
          </SheetHeader>
          <p
            aria-live="polite"
            className="min-h-9 px-5 text-center text-2xl font-extrabold tracking-widest tabular-nums"
          >
            {entered}
          </p>
          <div
            className="grid grid-cols-3 gap-2 px-5 pt-2"
            onKeyDown={(event) => {
              if (KEYS.includes(event.key as (typeof KEYS)[number]) && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                press(event.key);
              }
            }}
          >
            {KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-label={key === "*" ? t.star : key === "#" ? t.pound : key}
                onClick={() => press(key)}
                className="min-h-14 rounded-xl border bg-card text-2xl font-extrabold tabular-nums outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent"
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
