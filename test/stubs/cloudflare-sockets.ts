// The Worker's socket API does not exist in Node, where the tests run. Most of the suite never sends —
// mail is either not configured or a fake Mailer — so by default reaching this is a mistake worth
// hearing about rather than a silent no-op.
//
// `silentServer()` is the exception: it takes the connection and then says nothing at all, which is the
// one failure that used to hang for ever. A test can arm it to prove the deadline fires.

type Stub = (() => unknown) | null;
let stub: Stub = null;

/** Behaves like a mail server that accepts a connection and never speaks. Returns a reset function. */
export function silentServer(): () => void {
  stub = () => ({
    opened: Promise.resolve({ remoteAddress: null, localAddress: null }),
    closed: new Promise(() => undefined),
    readable: new ReadableStream<Uint8Array>({ start() {} }), // never enqueues, never closes
    writable: new WritableStream<Uint8Array>({ write() {} }),
    close: () => Promise.resolve(),
    startTls: () => stub!(),
  });
  return () => (stub = null);
}

/** Behaves like a port that goes nowhere: the connection itself never opens. */
export function deadPort(): () => void {
  stub = () => ({
    opened: new Promise(() => undefined),
    closed: new Promise(() => undefined),
    readable: new ReadableStream<Uint8Array>({ start() {} }),
    writable: new WritableStream<Uint8Array>({ write() {} }),
    close: () => Promise.resolve(),
    startTls: () => stub!(),
  });
  return () => (stub = null);
}

export function connect(): unknown {
  if (stub) return stub();
  throw new Error("cloudflare:sockets is not available in tests; mail should be stubbed or unconfigured");
}
