import { Skeleton } from "@/components/ui/skeleton";

export default function FollowUpsLoading() {
  return (
    <div role="status" aria-label="Loading follow-ups">
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>

      <div className="mb-4 flex gap-2 overflow-hidden border-b pb-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-28 shrink-0" />
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <Skeleton className="h-11 w-full rounded-none" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex h-18 items-center gap-6 border-t px-4">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-4 w-40" />
            <div className="ml-auto flex gap-2">
              <Skeleton className="h-12 w-24" />
              <Skeleton className="h-12 w-28" />
              <Skeleton className="h-12 w-32" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex justify-between gap-3">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-9 w-24" />
            </div>
            <Skeleton className="h-12 w-full" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
