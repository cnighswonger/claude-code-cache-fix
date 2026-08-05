// Wait for a child, but never forever.
//
// `node --test` has NO default test timeout, so a single `await new
// Promise(r => child.on("exit", r))` that never resolves hangs the entire run:
// the case cannot fail, the file never finishes, and the job idles to GitHub's
// 360-minute cap with nothing reported. Measured on run 31033461473 — node 20
// and 22 finished while node 18 sat `in_progress` past 28 minutes and no check
// ever said "failed". A red check is information; one that never resolves is not.
//
// SIGKILL on the way out, not merely a rejection. A child that ignored SIGTERM
// still holds the runner's stdout pipe, and an unresolved pipe hangs the run for
// the same reason the await did — so killing it is what turns the failure into a
// failure. Same lesson as the held-port file, where SIGKILLed launchers left
// proxies holding the pipes and one file took 300 s.
//
// Shared rather than copied into each test file: three files had the identical
// unbounded wait, and the copy nobody remembers to fix is the one that hangs.
export function withDeadline(p, ms, child, what) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        rej(new Error(`${what} within ${ms}ms`));
      }, ms);
    }),
  ]);
}

// The common case: a child was signalled and must exit. Resolves to its exit
// code, throws if it never goes.
export function exitWithin(child, ms, what) {
  return withDeadline(
    new Promise((r) => child.on("exit", (code, signal) => r(code ?? signal))),
    ms, child, what);
}
