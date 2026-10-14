// Installable-app plumbing: the service worker and its "update available" state, the browser's
// install prompt, and whether the device is online. No data is ever stored for offline use.

import { useSyncExternalStore } from "react";

/** Chrome's install prompt event; not in the standard DOM typings. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaState {
  /** A newer version has been downloaded and is waiting for the user to reload. */
  updateWaiting: boolean;
  /** The browser is ready to show its own "install this app" dialog (Android / Chrome). */
  canInstall: boolean;
}

let state: PwaState = { updateWaiting: false, canInstall: false };
let waitingWorker: ServiceWorker | null = null;
let installEvent: InstallPromptEvent | null = null;
let reloadRequested = false;
const listeners = new Set<() => void>();

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own "Install app" button instead of the browser's banner
    installEvent = e as InstallPromptEvent;
    set({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    set({ canInstall: false });
  });
}

export const usePwa = (): PwaState => useSyncExternalStore(subscribe, () => state);

/** Registers the service worker. Called from main.tsx in production builds only. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  window.addEventListener("load", () => {
    sw.register("/sw.js")
      .then((reg) => {
        const check = () => {
          // A waiting worker with no current controller is the very first install, not an update.
          if (reg.waiting && sw.controller) {
            waitingWorker = reg.waiting;
            set({ updateWaiting: true });
          }
        };
        check();
        reg.addEventListener("updatefound", () => {
          const incoming = reg.installing;
          incoming?.addEventListener("statechange", () => {
            if (incoming.state === "installed") check();
          });
        });
        // An app left open for days still learns about a new release when it is looked at again.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => undefined);
        });
      })
      .catch(() => undefined); // the app works without it
  });
  sw.addEventListener("controllerchange", () => {
    // Reload only when the user asked for the update, never by surprise.
    if (reloadRequested) window.location.reload();
  });
}

/** The user chose "Reload": let the waiting version take over, then reload once it has. */
export function applyUpdate() {
  reloadRequested = true;
  if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
  else window.location.reload();
}

/** Shows the browser's install dialog. Resolves to true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = installEvent;
  if (!e) return false;
  installEvent = null;
  set({ canInstall: false });
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  return choice.outcome === "accepted";
}

/** True when the app was opened from the home screen rather than in a browser tab. */
export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone and iPad Safari have no install prompt; the user adds the app from the Share menu. */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

const subscribeOnline = (l: () => void) => {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => {
    window.removeEventListener("online", l);
    window.removeEventListener("offline", l);
  };
};
export const useOnline = (): boolean => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

const subscribePhone = (l: () => void) => {
  const mq = window.matchMedia("(max-width: 860px)");
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};
/** True at phone width (the same breakpoint the stylesheet uses). */
export const usePhone = (): boolean => useSyncExternalStore(subscribePhone, () => window.matchMedia("(max-width: 860px)").matches);
