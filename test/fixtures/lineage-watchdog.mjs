// Spawned by armLineage() (proc-helpers.mjs): outlives the file that armed a
// lineage and sweeps it once that file is gone, however it died. Bare
// `node --test` also runs this file as a test, with no marker: nothing to do.
// LINEAGE_NO_WATCHDOG is set only by the harness cases that measure the
// in-process backstops alone.
import { killStamped } from "../proc-helpers.mjs";

const marker = process.argv[2];
if (!marker || process.env.LINEAGE_NO_WATCHDOG) process.exit(0);

process.stdin.resume();
process.stdin.on("end", () => { killStamped(marker); process.exit(0); });
