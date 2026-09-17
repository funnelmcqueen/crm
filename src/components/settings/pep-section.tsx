"use client";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PEP_SETTINGS, PEP_SETTING_HINTS, PEP_SETTING_LABELS, type PepSetting } from "@/lib/domain/pep-talk";
import { usePepSetting } from "@/lib/pep/storage";

function isPepSetting(value: string): value is PepSetting {
  return (PEP_SETTINGS as readonly string[]).includes(value);
}

/** Between-calls lines: level, or off entirely (docs/DEVIATIONS.md D45). */
export function PepSection() {
  const [setting, setSetting] = usePepSetting();

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup
        value={setting}
        onValueChange={(value) => {
          if (isPepSetting(value)) setSetting(value);
        }}
        aria-label="Between-calls lines"
        className="gap-2"
      >
        {PEP_SETTINGS.map((option) => {
          const id = `pep-${option}`;
          return (
            <Label
              key={option}
              htmlFor={id}
              className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors duration-100 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/10"
            >
              <RadioGroupItem id={id} value={option} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-bold">{PEP_SETTING_LABELS[option]}</span>
                <span className="text-sm text-muted-foreground">{PEP_SETTING_HINTS[option]}</span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">Saved on this device only. Nobody is told what you pick.</p>
    </div>
  );
}
