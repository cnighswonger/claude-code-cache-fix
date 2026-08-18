// A HANDLER THAT REPORTS A STDERR FAULT BY WRITING TO STDERR FEEDS ITSELF.
//
// say() catches a SYNCHRONOUS throw, and the premise of the self-heal block is
// that stream faults arrive as ASYNC 'error' events. Measured before the fix:
//   one isolated ENOSPC        -> 1 re-entry, stops on its own
//   every write raises ENOSPC  -> past 50 re-entries in under 500 ms
// The second is the case worth surviving (a full disk, a detached tty), and it
// is the same self-feeding shape as the 22-minute 100% CPU loop this block was
// added to break — reached THROUGH the guard rather than around it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const serverSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "proxy", "server.mjs"), "utf8");

// LIFTED FROM THE SHIPPED FILE, not retyped. A retyped copy passes while the
// real handler loops. The assert is the control: a rename fails the test rather
// than quietly testing a stub.
function liftHandler() {
  const at = serverSrc.indexOf("let saidStreamError = false;");
  assert.ok(at > 0,
    "the stream-error latch is gone or renamed — this test guards nothing, which " +
    "is not the same as the loop being fixed");
  const end = serverSrc.indexOf("};", serverSrc.indexOf("const onStreamError", at)) + 2;
  const src = serverSrc.slice(at, end);
  assert.match(src, /onStreamError/, "the slice does not contain the handler");
  const ns = { say: (s, m) => { try { s.write(m); } catch { } }, process };
  return new Function("say", "process", `${src}\nreturn onStreamError;`)(ns.say, ns.process);
}

describe("stdio error latch", () => {
  it("reports a stream fault once, even when every write raises another", () => {
    const onStreamError = liftHandler();
    let writes = 0;
    const fake = {
      write() {
        writes++;
        // The shape the block's own comment describes: the fault surfaces as an
        // asynchronous event, so a write made from inside the handler produces
        // the handler's next input.
        const e = new Error("no space"); e.code = "ENOSPC";
        if (writes < 200) onStreamError(e);
        return true;
      },
    };
    const real = process.stderr;
    Object.defineProperty(process, "stderr", { value: fake, configurable: true });
    try {
      const e = new Error("no space"); e.code = "ENOSPC";
      onStreamError(e);
    } finally {
      Object.defineProperty(process, "stderr", { value: real, configurable: true });
    }
    assert.equal(writes, 1,
      `the handler wrote ${writes} times for one fault — it is feeding itself, ` +
      `which on a full disk is the 100% CPU loop this block exists to prevent`);
  });

  it("still says nothing at all for EPIPE, so a departed reader costs no latch", () => {
    const onStreamError = liftHandler();
    let writes = 0;
    const fake = { write() { writes++; return true; } };
    const real = process.stderr;
    Object.defineProperty(process, "stderr", { value: fake, configurable: true });
    try {
      for (const code of ["EPIPE", "ERR_STREAM_DESTROYED"]) {
        const e = new Error(code); e.code = code;
        onStreamError(e);
      }
      // PREMISE: the latch is still unspent, or "wrote 0" above would be
      // indistinguishable from a handler that had already latched.
      const e = new Error("no space"); e.code = "ENOSPC";
      onStreamError(e);
    } finally {
      Object.defineProperty(process, "stderr", { value: real, configurable: true });
    }
    assert.equal(writes, 1,
      "EPIPE spent the latch, so a real fault after a departed reader would be silent");
  });
});
