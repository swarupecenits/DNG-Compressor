/** Human-friendly number formatting for the UI. */

const UNITS = ["B", "KB", "MB", "GB"] as const;

/** Formats a byte count with decimal units, e.g. 29_195_592 -> "29.2 MB". */
export function formatBytes(bytes: number): string {
  let value = Math.abs(bytes);
  let unit = 0;
  let text = value.toFixed(0);
  // Decide on the unit after rounding, so 999_950 reads "1.0 MB" rather than "1000 KB".
  while (Number(text) >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
    text = value.toFixed(1);
    if (Number(text) >= 100) text = value.toFixed(0);
  }
  return `${bytes < 0 ? "−" : ""}${text} ${UNITS[unit]}`;
}

/** Relative change as a signed percentage, e.g. (100, 74) -> "−26%". */
export function formatChange(before: number, after: number): string {
  if (before <= 0) return "0%";
  const percent = ((after - before) / before) * 100;
  const rounded = Math.abs(percent) < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
  if (rounded === 0) return "0%";
  return `${rounded < 0 ? "−" : "+"}${Math.abs(rounded)}%`;
}

/** Formats a duration, e.g. 4_200 -> "4.2 s", 75_000 -> "1 min 15 s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)} s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Rough time left for a progress note, e.g. 42_000 -> "about 40 s left". */
export function formatEta(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 5) return "a few seconds left";
  if (seconds < 55) return `about ${Math.round(seconds / 5) * 5} s left`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about a minute left" : `about ${minutes} min left`;
}

/** "IMG_0042.DNG" -> "IMG_0042-jxl.DNG" (keeps the extension's case). */
export function outputName(name: string): string {
  const match = /^(.*?)(\.dng)?$/i.exec(name);
  const base = match?.[1] || "photo";
  return `${base}-jxl${match?.[2] ?? ".dng"}`;
}
