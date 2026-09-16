import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsSectionProps {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({ id, title, description, children, className }: SettingsSectionProps) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className={cn("flex flex-col gap-4 rounded-xl border bg-card p-4 md:p-5", className)}>
      <div>
        <h2 id={`${id}-title`} className="text-lg font-bold">
          {title}
        </h2>
        {description ? <div className="mt-0.5 text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}
