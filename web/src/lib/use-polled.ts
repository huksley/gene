import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, UnauthorizedError } from "./api";

const POLL_MS = 10_000;

export type Polled<T> = {
  data: T | null;
  error: string | null;
  /** 401: "missing" (no token yet) or "rejected" (the saved one failed). */
  auth: "ok" | "missing" | "rejected";
  loading: boolean;
  fetchedAt: number | null;
  refresh: () => void;
};

/**
 * Poll an API path while the tab is visible; refetch at once when it comes back or the
 * path changes. A null path pauses polling (and keeps the last data).
 */
export const usePolled = <T,>(path: string | null): Polled<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<Polled<T>["auth"]>("ok");
  const [loading, setLoading] = useState(path !== null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (path === null) return;
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    try {
      setData(await apiGet<T>(path, ctrl.signal));
      setError(null);
      setAuth("ok");
      setFetchedAt(Date.now());
    } catch (e) {
      if (ctrl.signal.aborted) return;
      if (e instanceof UnauthorizedError) setAuth(e.hadToken ? "rejected" : "missing");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (inflight.current === ctrl) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (path === null) return;
    void load();
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      inflight.current?.abort();
    };
  }, [load, path]);

  return { data, error, auth, loading, fetchedAt, refresh: () => void load() };
};
