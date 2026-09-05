import { join } from "node:path";
import { readFileSync } from "node:fs";
import { claudeHome } from "../proxy/claude-home.mjs";

// A handover keeps the port alive and, until this existed, kept the CONFIG the
// outgoing holder booted with too — so a switch added afterwards could not reach
// the fleet without dropping the address, and dropping it cuts whatever streams
// across the gap. Re-read CACHE_FIX_* from a file the holder does not own.
//
// EVERY FAILURE IS OFF. Absent, unreadable, malformed, unrecognised: the
// inherited value stands. A handover that refuses because a config file is bad
// is worse than one carrying a stale switch.
//
// Only CACHE_FIX_ keys are honoured, which keeps PATH and LD_PRELOAD out and is
// the limit of what the prefix buys. It is NOT a lower trust level: within the
// prefix this file can set CACHE_FIX_PROXY_UPSTREAM, CACHE_FIX_REQUEST_CAPTURE
// and CACHE_FIX_PROXY_CA_FILE, so write access to it is control of the proxy.
//
// ABSENCE MEANS INHERIT, NEVER UNSET. There is no syntax here that removes a
// key, so deleting a line does not turn a switch off — the value the outgoing
// holder carries stands, and one set through this file is then sticky across
// every later handover. Turn a switch off by its own off value
// (`CACHE_FIX_REQUEST_CAPTURE=0`), not by removing the line.
//
// Own module: the launcher is an executable, so importing it runs the CLI.
// Parsed by hand, not util.parseEnv: measured undefined on node 18, which
// package.json declares as the minimum — there the call throws, outside the try.
export const handoverEnvPath = () =>
  process.env.CACHE_FIX_HANDOVER_ENV || join(claudeHome(), "cache-fix-handover.env");

export function handoverEnv(base, path = handoverEnvPath()) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return base; }
  const out = { ...base };
  // A LINE IS HONOURED ONCE ITS TERMINATOR IS THERE. A half-written file parses
  // cleanly -- `..._UPSTREAM=http://ho` is a well-formed assignment with a broken
  // value -- so dropping the unterminated tail is what makes a truncated write
  // invisible here. It also means a file with no final newline loses its last
  // line, which is the fail-safe direction: the inherited value stands.
  for (const line of text.split("\n").slice(0, -1)) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    if (!k.startsWith("CACHE_FIX_")) continue;
    out[k] = line.slice(eq + 1).trim();
  }
  return out;
}
