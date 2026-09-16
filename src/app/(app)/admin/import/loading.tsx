import { Skeleton } from "@/components/ui/skeleton";

export default function ImportLeadsLoading() {
  return (
    <div role="status" aria-label="Loading import">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="mb-6 flex gap-1">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
