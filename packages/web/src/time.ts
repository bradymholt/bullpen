/** Coarse on purpose: "when did this last do anything" reads better than a date. */
export function ago(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(epochSeconds * 1000).toLocaleDateString();
}

/** Rough on purpose: "how long did this take" reads better than a precise figure. */
export function took(run: { startedAt: number; endedAt: number | null }): string | null {
  if (!run.endedAt) return null;
  const seconds = Math.max(0, run.endedAt - run.startedAt);
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
