/**
 * Talk time shown the same way on every screen (agent dashboard, admin dashboard, agents list, drill-down):
 * "0m", "45s", "12m", "1h 05m". Negative or invalid input counts as zero. Reports and team totals show
 * whole talk minutes instead (round(seconds / 60)).
 */
export function formatTalkTime(seconds: number | null | undefined): string {
  const total = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  if (total === 0) return "0m";
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}
