"use client";

import { useLocale, useTranslations } from "@/components/i18n/locale-provider";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CALL_MODE_LABELS, CALL_MODE_PREFERENCES, isCallModePreference, useCallModePreference } from "@/lib/dialer/preference";
import type { CallModePreference } from "@/lib/dialer/types";

const DESCRIPTIONS: Record<CallModePreference, string> = {
  auto: "Calls run inside the CRM on a computer. On iPhone, and whenever in-app calling isn't ready, CALL opens your phone's dialer instead (browser calls drop when an iPhone screen locks).",
  "in-app": "Calls run inside the CRM whenever in-app calling is ready, including on phones. If it isn't ready, CALL uses your phone.",
  phone: "CALL always opens your phone's dialer. You log the outcome when you come back.",
};

export function CallModeSection({ inAppAvailable }: { inAppAvailable: boolean }) {
  const { locale } = useLocale();
  const t = useTranslations("operations");
  const [preference, setPreference] = useCallModePreference();

  return (
    <div className="flex flex-col gap-3">
      {inAppAvailable ? null : (
        <p className="rounded-lg border bg-muted/60 p-3 text-sm">
          {t.callModeUnavailable}
        </p>
      )}
      <RadioGroup
        value={preference}
        onValueChange={(value) => {
          if (isCallModePreference(value)) setPreference(value);
        }}
        aria-label={t.callMode}
        className="gap-2"
      >
        {CALL_MODE_PREFERENCES.map((mode) => {
          const id = `call-mode-${mode}`;
          return (
            <Label
              key={mode}
              htmlFor={id}
              className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors duration-100 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/10"
            >
              <RadioGroupItem id={id} value={mode} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-bold">{locale === "de" ? ({ auto: "Automatisch", "in-app": "In der App", phone: "Telefon" } as const)[mode] : CALL_MODE_LABELS[mode]}</span>
                <span className="text-sm text-muted-foreground">{locale === "de" ? ({ auto: "Anrufe laufen am Computer in der CRM-App. Auf dem iPhone und wenn Anrufe in der App nicht bereit sind, öffnet ANRUFEN die Telefon-App (Browseranrufe enden, wenn der iPhone-Bildschirm gesperrt wird).", "in-app": "Anrufe laufen in der CRM-App, sobald Anrufe in der App bereit sind, auch auf Telefonen. Andernfalls öffnet ANRUFEN dein Telefon.", phone: "ANRUFEN öffnet immer die Telefon-App. Nach deiner Rückkehr protokollierst du das Ergebnis." } as const)[mode] : DESCRIPTIONS[mode]}</span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{t.savedDevice}</p>
    </div>
  );
}
