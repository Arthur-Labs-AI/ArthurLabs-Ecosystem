/** Time wording. Pure and clock-injectable so it can be tested without a real "now". */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "just now", "34 min ago", "2 h ago", "Yesterday", "3 d ago", then a short date. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = now.getTime() - then.getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY && startOfDay(then) === startOfDay(now)) return `${Math.floor(diff / HOUR)} h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} d ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Group heading for a day: "Today", "Yesterday", or a weekday and date. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return then.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function isSameDay(a: string, b: Date = new Date()): boolean {
  const then = new Date(a);
  return !Number.isNaN(then.getTime()) && startOfDay(then) === startOfDay(b);
}

/** "Fri 2 Oct, 14:32" in the user's locale. */
export function formatMoment(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  return `${then.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
