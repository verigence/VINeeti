// A very small history-based router: the server answers unknown paths with index.html, so plain
// paths such as /bookings/bkg_123 work on reload and can be shared.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

interface RouterValue {
  path: string;
  search: string;
  /** The #fragment, including the "#", or "". */
  hash: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search, hash: window.location.hash }));

  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search, hash: window.location.hash });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    const url = new URL(to, window.location.origin);
    const samePath = url.pathname === window.location.pathname;
    if (samePath && url.search === window.location.search && url.hash === window.location.hash) {
      // Asking for the section already in the address bar still scrolls to it.
      if (url.hash) setLoc((l) => ({ ...l }));
      return;
    }
    if (opts?.replace) window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    else window.history.pushState(null, "", url.pathname + url.search + url.hash);
    setLoc({ path: url.pathname, search: url.search, hash: url.hash });
    if (!samePath && !url.hash) window.scrollTo(0, 0);
  }, []);

  const value = useMemo(() => ({ ...loc, navigate }), [loc, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("RouterProvider is missing");
  return v;
}

/** Filters kept in the address bar, so a filtered list can be linked to and survives a reload. */
export function useQuery(): [URLSearchParams, (patch: Record<string, string | null | undefined>) => void] {
  const { path, search, navigate } = useRouter();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      navigate(s ? `${path}?${s}` : path, { replace: true });
    },
    [path, navigate],
  );
  return [params, set];
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  to: string;
}

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

/** Matches "/bookings/:id/edit" against a path; returns the named parts or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}
