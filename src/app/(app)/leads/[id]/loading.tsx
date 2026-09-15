import { Skeleton } from "@/components/ui/skeleton";

export default function LeadDetailLoading() {
  return (
    <div role="status" aria-label="Loading lead" className="pb-24 md:pb-0">
      <Skeleton className="mb-4 h-5 w-24" />
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <Skeleton className="h-5 w-36" />
        </div>
        <Skeleton className="hidden h-14 w-48 md:block" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_22rem] md:items-start">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-40" />
          </div>
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
            <Skeleton className="h-3 w-24" />
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-6 w-40" />
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          </div>
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-(--bottom-nav-height) z-30 border-t bg-background px-4 py-3 md:hidden">
        <Skeleton className="h-14 w-full" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
