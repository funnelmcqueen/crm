import Link from "next/link";
import { cn } from "@/lib/utils";

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      className={cn(
        "inline-flex min-h-12 items-center rounded-md text-lg font-extrabold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      Funnel&nbsp;<span className="text-primary">McQueen</span>
    </Link>
  );
}
