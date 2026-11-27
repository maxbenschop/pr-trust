export type DurationUnit = "d" | "w" | "mo" | "y";
export type Duration = { amount: number; unit: DurationUnit };

const PATTERN = /^(\d+)\s*(d|w|mo|y)$/;

/** Parses "30d", "8w", "24mo" or "2y". Returns null when the text is not a duration. */
export function parseDuration(text: string): Duration | null {
  const match = PATTERN.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return { amount, unit: match[2] as DurationUnit };
}

/** Calendar-aware subtraction in UTC. */
export function subtractDuration(at: Date, duration: Duration): Date {
  const result = new Date(at.getTime());
  switch (duration.unit) {
    case "d":
      result.setUTCDate(result.getUTCDate() - duration.amount);
      break;
    case "w":
      result.setUTCDate(result.getUTCDate() - duration.amount * 7);
      break;
    case "mo":
      result.setUTCMonth(result.getUTCMonth() - duration.amount);
      break;
    case "y":
      result.setUTCFullYear(result.getUTCFullYear() - duration.amount);
      break;
  }
  return result;
}

export function formatDuration(duration: Duration): string {
  const names: Record<DurationUnit, [string, string]> = {
    d: ["day", "days"],
    w: ["week", "weeks"],
    mo: ["month", "months"],
    y: ["year", "years"],
  };
  const [one, many] = names[duration.unit];
  return `${duration.amount} ${duration.amount === 1 ? one : many}`;
}
