// Session handling: who is signed in, and which of the three states the app is in
// (signed out, must set a new password, or signed in with the full shell).

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, errorMessage, setSessionHandlers } from "./api";
import { Shell } from "./components/Shell";
import { ToastProvider } from "./components/Toast";
import { StatusBars } from "./components/AppBars";
import { ErrorBox } from "./components/ui";
import { setTimeZone } from "./format";
import { ChangePasswordScreen, LoginScreen } from "./pages/Login";
import { PRODUCT, productName } from "./product";
import { Splash } from "./components/Splash";
import { RouterProvider, useRouter } from "./router";
import { SessionContext, type Session } from "./session";
import type { Me, Permission } from "./types";

export function App() {
  return (
    <RouterProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </RouterProvider>
  );
}

function Root() {
  const { navigate } = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [phase, setPhase] = useState<"loading" | "anon" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // Set when the server refuses a call until the password is changed, even if /me has not said so yet.
  const [passwordRequired, setPasswordRequired] = useState(false);
  // The splash screen stays up for a moment even when the session answers at once, so it does not flash.
  const [splash, setSplash] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setSplash(false), 1400);
    return () => window.clearTimeout(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const m = await api.me();
      setTimeZone(m.tenant.timezone);
      document.title = `${m.tenant.name} · ${productName(m.app_name)}`;
      setMe(m);
      setPasswordRequired(m.user.mustChangePassword);
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setPhase("anon");
      } else {
        setError(errorMessage(e));
        setPhase((p) => (p === "ready" ? p : "error"));
      }
    }
  }, []);

  useEffect(() => {
    setSessionHandlers({
      // Session expired or signed out elsewhere: back to the sign-in screen.
      unauthorized: () => {
        setMe(null);
        setPhase("anon");
      },
      // An administrator reset the password while the user was working: nothing else is allowed until it is replaced.
      passwordChangeRequired: () => setPasswordRequired(true),
    });
    void load();
    return () => setSessionHandlers(null);
  }, [load]);

  // Opened without a connection: try again by itself as soon as the connection is back.
  useEffect(() => {
    if (phase !== "error") return;
    const retry = () => void load();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [phase, load]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
    setPasswordRequired(false);
    setPhase("anon");
    document.title = PRODUCT;
    navigate("/", { replace: true });
  }, [navigate]);

  const session = useMemo<Session | null>(() => {
    if (!me) return null;
    const names = new Map(me.all_outlets.map((o) => [o.id, o.name]));
    return {
      me,
      can: (p: Permission) => me.user.permissions.includes(p),
      refresh: load,
      signOut,
      outletName: (id) => (id ? names.get(id) ?? "another outlet" : "—"),
      myOutlets: me.outlets.filter((o) => o.is_active),
      worksAt: (outletId) => me.user.allOutlets || me.user.outletIds.includes(outletId),
      roleLabel: (role) => (me.role_labels as Record<string, string>)[role] ?? role,
    };
  }, [me, load, signOut]);

  if (phase === "loading" || splash) return <Splash />;
  if (phase === "error") {
    // Typically: the app was opened from the home screen with no connection.
    return (
      <div className="gate-wrap">
        <StatusBars />
        <div className="gate">
          <p className="gate-product">{PRODUCT}</p>
          <ErrorBox message={error} onRetry={() => void load()} />
        </div>
      </div>
    );
  }
  if (phase === "anon" || !session) return <LoginScreen onSignedIn={load} />;

  return (
    <SessionContext.Provider value={session}>
      {/* Until the password is replaced the server refuses everything else, so nothing else is mounted or fetched. */}
      {session.me.user.mustChangePassword || passwordRequired ? <ChangePasswordScreen /> : <Shell />}
    </SessionContext.Provider>
  );
}
