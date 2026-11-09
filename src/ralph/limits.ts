// ---------------------------------------------------------------------------
// Usage-limit detection. A `claude -p` session that hits its 5-hour (or
// weekly) cap ends with a plain-text message such as
//   "You've hit your 5-hour limit · resets 2:30pm (Europe/London)"
// and exits as if it finished. The loop must read that as "interrupted", wait
// out the reset, and re-run the same iteration. Pure: no clock or process
// access beyond what the caller passes in.
// ---------------------------------------------------------------------------

import type { RateLimitInfo } from "./stream";

/**
 * True when an agent text block is the CLI's usage-limit notice rather than the
 * agent's own prose. Anchored to the start of the block so an agent writing
 * about rate limits does not trip it.
 */
export function isUsageLimitMessage(text: string): boolean {
  const t = text.trim();
  return (
    /^(?:you've|you have) (?:hit|reached) your\b[^\n]*\blimit\b/i.test(t) ||
    /^claude(?: ai)? usage limit reached/i.test(t)
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the limit in `message` resets, in epoch ms, or undefined if it cannot
 * be read. Understands
 *   "… resets 2:30pm (Europe/London)", "… resets 9am", "… resets Nov 12, 9am (UTC)",
 *   "Claude AI usage limit reached|1736985600" (epoch seconds).
 * A wall-clock time with no date is the next occurrence after `now`. A missing
 * or unknown timezone falls back to the machine's own.
 */
export function parseResetTime(message: string, now: number): number | undefined {
  const epoch = /usage limit reached\|(\d{9,})/i.exec(message);
  if (epoch) return Number(epoch[1]) * 1000;

  const m =
    /resets\s+(?:(?:on\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      message,
    );
  if (!m) return undefined;

  const [, monthName, dayStr, hourStr, minStr, ampm, tzRaw] = m;
  let hour = Number(hourStr);
  const minute = minStr ? Number(minStr) : 0;
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  } else if (!minStr) {
    // A bare number with neither minutes nor am/pm is not a time.
    return undefined;
  }
  if (hour > 23 || minute > 59) return undefined;

  const tz = validTimeZone(tzRaw?.trim());
  const today = partsInZone(now, tz);

  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase());
    if (month < 0) return undefined;
    const day = Number(dayStr);
    let at = zonedToUtc(today.year, month, day, hour, minute, tz);
    // "resets Jan 2" read on Dec 30 means next year.
    if (at < now - 24 * 60 * 60 * 1000) at = zonedToUtc(today.year + 1, month, day, hour, minute, tz);
    return at;
  }

  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, tz);
  if (at <= now) {
    const tomorrow = new Date(Date.UTC(today.year, today.month, today.day + 1));
    at = zonedToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      hour,
      minute,
      tz,
    );
  }
  return at;
}

/** What `runTracked` should do about the usage window after an iteration. */
export type LimitVerdict =
  /** Fine, carry on. */
  | { kind: "none" }
  /** The iteration was cut off by the limit: wait, then re-run it. */
  | { kind: "hit"; resetsAt?: number; message?: string }
  /** It finished, but the window is nearly spent: wait before the next one. */
  | { kind: "warning"; resetsAt?: number };

/**
 * Read an iteration's limit state off its digest: the CLI's limit message (the
 * signal that reliably appears when a session is cut off) and the structured
 * five-hour `rate_limit_event`. The structured `resetsAt` wins when present —
 * it is exact — and the message's wall-clock time is the fallback.
 */
export function limitVerdict(
  limitMessage: string | undefined,
  rateLimit: RateLimitInfo | undefined,
  now: number,
): LimitVerdict {
  const structured = rateLimit?.resetsAt !== undefined ? rateLimit.resetsAt * 1000 : undefined;
  const future = (t: number | undefined) => (t !== undefined && t > now ? t : undefined);

  if (limitMessage !== undefined || rateLimit?.status === "rejected") {
    const resetsAt =
      future(structured) ??
      (limitMessage !== undefined ? future(parseResetTime(limitMessage, now)) : undefined);
    return { kind: "hit", resetsAt, message: limitMessage };
  }
  if (rateLimit?.status !== undefined && rateLimit.status !== "allowed") {
    return { kind: "warning", resetsAt: future(structured) };
  }
  return { kind: "none" };
}

function validTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Wall-clock parts of instant `ms` in `tz` (undefined: the machine's zone). Month is 0-based. */
function partsInZone(ms: number, tz: string | undefined): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month") - 1,
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (positive east of Greenwich). */
function zoneOffset(ms: number, tz: string | undefined): number {
  const p = partsInZone(ms, tz);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

/** The instant at which the wall clock in `tz` reads the given time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = guess - zoneOffset(guess, tz);
  const second = guess - zoneOffset(first, tz);
  return second;
}
