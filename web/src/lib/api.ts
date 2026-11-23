const TOKEN_KEY = "gene.ui.token";

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode / blocked storage — the token lives for this page only */
    }
  }
};

let memoryToken: string | null = null;

/**
 * A `?token=` in the URL (a shared link) is saved and stripped from the address bar,
 * so it doesn't linger in history or get copied along.
 */
const adoptUrlToken = (): void => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  setToken(token);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
};

export const getToken = (): string | null => memoryToken ?? storage.get(TOKEN_KEY);

export const setToken = (token: string | null): void => {
  memoryToken = token;
  storage.set(TOKEN_KEY, token);
};

adoptUrlToken();

export class UnauthorizedError extends Error {
  constructor(readonly hadToken: boolean) {
    super("unauthorized");
  }
}

/** GET a JSON API path with the saved token; 401 → {@link UnauthorizedError}. */
export const apiGet = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal
  });
  if (res.status === 401) throw new UnauthorizedError(token !== null);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};

export const prefs = {
  get: (key: string): string | null => storage.get(`gene.ui.${key}`),
  set: (key: string, value: string): void => storage.set(`gene.ui.${key}`, value)
};
