import { ArrowRight } from "lucide-react";
import Link from "next/link";

/** App shell header entry point to the Next Lead flow. Icon-only in the narrow desktop sidebar header. */
export function NextLeadLink() {
  return (
    <Link
      href="/next"
      aria-label="Next lead"
      className="inline-flex min-h-12 items-center gap-1.5 rounded-lg border border-primary px-3 text-sm font-bold text-primary outline-none transition-colors duration-150 hover:bg-primary/10 focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-10 md:px-2.5 [&_svg]:size-4"
    >
      <span className="md:sr-only">Next lead</span>
      <ArrowRight aria-hidden />
    </Link>
  );
}
