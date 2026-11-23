const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** "3 min. ago", "in 20 sec." — coarse, for at-a-glance columns. */
export const relative = (at: string | number | undefined, now = Date.now()): string => {
  if (at === undefined) return "—";
  const t = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(s, "second");
  if (abs < 45 * 60) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 22 * 3600) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
};

export const clock = (at: string | number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const dateTime = (at: string | number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Today", "Yesterday", "Mon, 17 Nov". */
export const dayLabel = (at: string): string => {
  const d = new Date(at);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

export const dayKey = (at: string): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export const duration = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export const tokens = (n: number | undefined): string => {
  if (!n) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** A short label for a change-request URL: "!12", "#34", or the host. */
export const linkLabel = (url: string): string => {
  const mr = /merge_requests\/(\d+)/.exec(url);
  if (mr) return `!${mr[1]}`;
  const pr = /\/pull\/(\d+)/.exec(url);
  if (pr) return `#${pr[1]}`;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
