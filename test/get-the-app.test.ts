// Handing out the Android app from inside the dealership's own site.
//
// The point of doing it this way rather than from a public address is that the file cannot be taken
// by somebody who has not signed in, so that is what most of this tests. The rest is the awkward
// cases: no build published, a record pointing at a file that is not there, and a record that is not
// readable — each of which must say so rather than serving something broken to a phone.

import { beforeAll, describe, expect, it } from "vitest";
import { makeDealer, makeWorld, type Dealer, type World } from "./harness";

let w: World;
let d: Dealer;

const APK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
const KEY = "app/vineeti-1.2.0.apk";
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: "1.2.0", version_code: 7, key: KEY, size: APK.byteLength, sha256: "abc123", host: "adityamotors.mh.jbrconsulting.in", built_at: "2026-10-13T09:00:00Z", ...over });

const publish = async (recordText = record()) => {
  await w.files.put(KEY, APK, { httpMetadata: { contentType: "application/vnd.android.package-archive" } });
  await w.files.put("app/latest.json", new TextEncoder().encode(recordText), { httpMetadata: { contentType: "application/json" } });
};

beforeAll(async () => {
  w = makeWorld("2026-10-13 10:00");
  d = await makeDealer(w, "app-mahindra");
});

describe("before anything has been published", () => {
  it("says there is no build rather than failing", async () => {
    const res = await w.api("GET", "/api/app", undefined, d.users.se1.session);
    expect(res.status).toBe(200);
    expect(res.body.build).toBeNull();
  });

  it("refuses the download with a plain answer", async () => {
    const res = await w.api("GET", "/api/app/download", undefined, d.users.se1.session);
    expect(res.status).toBe(404);
  });
});

describe("once a build is published", () => {
  beforeAll(() => publish());

  it("offers it to anybody who works here, whatever their role", async () => {
    for (const who of ["admin", "se1", "accounts", "auditor", "sm"] as const) {
      const res = await w.api("GET", "/api/app", undefined, d.users[who].session);
      expect(res.status).toBe(200);
      expect(res.body.build).toMatchObject({ version: "1.2.0", version_code: 7, size: APK.byteLength, sha256: "abc123" });
    }
  });

  it("hands over the file as something Android will install", async () => {
    const res = await w.api("GET", "/api/app/download", undefined, d.users.se1.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("Content-Disposition")).toContain("vineeti-1.2.0.apk");
    // Nothing on the way between here and the phone should keep a copy.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("gives nothing to somebody who has not signed in — which is the whole reason it is not on a public address", async () => {
    expect((await w.api("GET", "/api/app")).status).toBe(401);
    expect((await w.api("GET", "/api/app/download")).status).toBe(401);
  });

  it("serves the published build and nothing else, whatever the caller asks for", async () => {
    // Something else in the same bucket: a support ticket's attachment, which has no business being
    // reachable from here. The download takes its key from the published record, never from the
    // caller, so naming another object changes nothing.
    await w.files.put("tickets/someone/secret.pdf", new TextEncoder().encode("a customer's document"), {});
    const plain = await w.api("GET", "/api/app/download", undefined, d.users.se1.session);
    for (const asked of ["tickets/someone/secret.pdf", "app/latest.json", "../tickets/someone/secret.pdf"]) {
      const res = await w.api("GET", `/api/app/download?key=${encodeURIComponent(asked)}`, undefined, d.users.se1.session);
      expect(res.status).toBe(200);
      expect(res.body).toBe(plain.body);
      expect(res.body).not.toContain("a customer's document");
    }
  });
});

describe("when the published record and the bucket disagree", () => {
  it("says the file is missing rather than serving an empty download", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d2 = await makeDealer(w2, "app-broken");
    await w2.files.put("app/latest.json", new TextEncoder().encode(record()), { httpMetadata: { contentType: "application/json" } });
    const res = await w2.api("GET", "/api/app/download", undefined, d2.users.se1.session);
    expect(res.status).toBe(404);
  });

  it("treats a record it cannot read as no build at all", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d2 = await makeDealer(w2, "app-garbled");
    await w2.files.put("app/latest.json", new TextEncoder().encode("not json at all"), { httpMetadata: { contentType: "application/json" } });
    expect((await w2.api("GET", "/api/app", undefined, d2.users.se1.session)).body.build).toBeNull();
    expect((await w2.api("GET", "/api/app/download", undefined, d2.users.se1.session)).status).toBe(404);
  });

  it("treats a record missing the things it needs as no build", async () => {
    const w2 = makeWorld("2026-10-13 10:00");
    const d2 = await makeDealer(w2, "app-partial");
    await w2.files.put("app/latest.json", new TextEncoder().encode(JSON.stringify({ version: "1.0.0" })), {});
    expect((await w2.api("GET", "/api/app", undefined, d2.users.se1.session)).body.build).toBeNull();
  });
});
