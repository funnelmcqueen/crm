import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** Usually a lucide icon element, e.g. `<Inbox />`. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6"
        >
          {icon}
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-bold">{title}</p>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
