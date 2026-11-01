// Whether the app can tell it is installed on a phone rather than open in a browser tab.
//
// This decides nothing — it only labels a row in the sign-in log — but it is the kind of check that
// quietly answers "no" for ever if it is written against the wrong browser API, and a log that calls
// every phone a browser would not answer the question it exists for.

import { afterEach, describe, expect, it } from "vitest";
import { installedApp } from "../web/src/api";

const asWindow = (w: unknown) => {
  (globalThis as { window?: unknown }).window = w;
};
afterEach(() => delete (globalThis as { window?: unknown }).window);

const media = (standalone: boolean, fullscreen = false) => (q: string) => ({
  matches: /display-mode:\s*standalone/.test(q) ? standalone : /display-mode:\s*fullscreen/.test(q) ? fullscreen : false,
});

describe("telling the installed app from a browser tab", () => {
  it("says yes when the page runs without the browser's own chrome", () => {
    asWindow({ matchMedia: media(true), navigator: {} });
    expect(installedApp()).toBe(true);
  });

  it("says yes for an app opened full screen", () => {
    asWindow({ matchMedia: media(false, true), navigator: {} });
    expect(installedApp()).toBe(true);
  });

  it("says yes on iOS, which answers the older question instead", () => {
    asWindow({ matchMedia: media(false), navigator: { standalone: true } });
    expect(installedApp()).toBe(true);
  });

  it("says no in an ordinary browser tab", () => {
    asWindow({ matchMedia: media(false), navigator: { standalone: false } });
    expect(installedApp()).toBe(false);
  });

  it("says no rather than throwing where the browser offers neither answer", () => {
    asWindow({ navigator: {} });
    expect(installedApp()).toBe(false);
    asWindow({
      matchMedia: () => {
        throw new Error("blocked");
      },
      navigator: {},
    });
    expect(installedApp()).toBe(false);
  });

  it("says no where there is no window at all, so a server-side render cannot crash on it", () => {
    expect(installedApp()).toBe(false);
  });
});
