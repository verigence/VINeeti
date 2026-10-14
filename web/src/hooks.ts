import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import { useToast } from "./components/Toast";
import { useRouter } from "./router";
import { useAlerts } from "./session";

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  /** True until the first answer arrives (or after the inputs change). */
  loading: boolean;
  /** True while fresh data is being fetched behind data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
}

/** Loads data when the screen opens and whenever `key` changes; `reload` refreshes after an action. */
export function useLoad<T>(fn: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean; refreshing: boolean; key: string }>({ data: undefined, error: null, loading: true, refreshing: false, key });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async (fresh: boolean, forKey: string) => {
    const mine = ++seq.current;
    setState((s) => (fresh ? { data: undefined, error: null, loading: true, refreshing: false, key: forKey } : { ...s, refreshing: true }));
    try {
      const data = await fnRef.current();
      if (mine === seq.current) setState({ data, error: null, loading: false, refreshing: false, key: forKey });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ data: fresh ? undefined : s.data, error: errorMessage(e), loading: false, refreshing: false, key: forKey }));
    }
  }, []);

  useEffect(() => {
    void run(true, key);
  }, [key, run]);

  const reload = useCallback(() => run(false, key), [run, key]);
  // While the inputs have changed but the effect has not run yet, do not show the previous answer.
  if (state.key !== key) return { data: undefined, error: null, loading: true, refreshing: false, reload };
  return { data: state.data, error: state.error, loading: state.loading, refreshing: state.refreshing, reload };
}

export interface Action {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** Runs a request. Shows the success message as a toast; an error is kept in `error` and, unless `quiet`, also shown as a toast. Resolves to undefined on failure. */
  run: <R>(fn: () => Promise<R>, opts?: { success?: string | ((r: R) => string); quiet?: boolean }) => Promise<R | undefined>;
}

export function useAction(): Action {
  const toast = useToast();
  const { reload: refreshBadges } = useAlerts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async <R,>(fn: () => Promise<R>, opts?: { success?: string | ((r: R) => string); quiet?: boolean }): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        const r = await fn();
        const msg = typeof opts?.success === "function" ? opts.success(r) : opts?.success;
        if (msg) toast.ok(msg);
        void refreshBadges();
        return r;
      } catch (e) {
        const msg = errorMessage(e);
        if (alive.current) setError(msg);
        if (!opts?.quiet) toast.error(msg);
        return undefined;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [toast, refreshBadges],
  );

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, clearError, run };
}

/** A value that follows what the user types after a short pause, for search boxes. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Brings the section named in the address (#at-risk, #alarms) into view once the screen has its data. */
export function useHashScroll(ready: boolean) {
  const { hash } = useRouter();
  useEffect(() => {
    if (!ready || hash.length < 2) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash, ready]);
}
