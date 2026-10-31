// The Worker's socket API does not exist in Node, where the tests run. Nothing in the suite sends a
// real message — mail is either not configured or a fake Mailer — so reaching this is a mistake worth
// hearing about rather than a silent no-op.
export function connect(): never {
  throw new Error("cloudflare:sockets is not available in tests; mail should be stubbed or unconfigured");
}
