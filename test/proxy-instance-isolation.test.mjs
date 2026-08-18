// TWO startProxy() HANDLES IN ONE PROCESS MUST NOT SHARE MUTABLE STATE.
//
// package.json exports "./proxy/server", and handleHealth was changed in this
// same PR from a `_listenPort` module global to req.socket.localPort for
// exactly this reason — its comment says "a consumer may run more than one".
// Two more globals were left behind, and one of them I added later in this same
// PR while the reason was written three screens above:
//
//   liveResponses   a module-level Set every instance adds to. A forced close in
//                   one instance ends the other's in-flight responses, and
//                   forcedCloseLine reports the other's cuts as its own.
//   _draining       a module-level flag. Draining one instance stamps
//                   `Connection: close` on the other's replies.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs"), "utf8");

describe("instance isolation", () => {
  it("keeps in-flight responses per server, not per module", () => {
    // ANCHOR ON THE CREATOR, because that is what a second consumer calls a
    // second time. A module-level Set is one Set for both of them.
    const at = src.indexOf("export function createProxyServer(");
    assert.ok(at > 0, "createProxyServer is gone or renamed — this guard watches nothing");
    assert.doesNotMatch(src.slice(0, at), /^export const liveResponses = new Set\(\);$/m,
      "liveResponses is a module-level Set shared by every startProxy() instance — " +
      "a forced close in one ends the other's in-flight responses, and the cut " +
      "count reports the other's work as its own");
  });

  it("keeps the draining flag per server, not per module", () => {
    const at = src.indexOf("export function createProxyServer(");
    assert.ok(at > 0, "createProxyServer is gone or renamed — this guard watches nothing");
    assert.doesNotMatch(src.slice(0, at), /^let _draining = false;$/m,
      "_draining is a module-level flag — draining one instance stamps " +
      "Connection: close on another instance's replies, telling its clients to " +
      "reconnect away from a proxy that is not going anywhere");
  });
});
