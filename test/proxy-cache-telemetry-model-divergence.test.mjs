import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ext, {
  runDivergenceDetector,
  sessionFilePath,
} from "../proxy/extensions/cache-telemetry.mjs";
import { modelFamily } from "../proxy/model-families.mjs";

const SID = "sess-divergence-test";
const NOW = "2026-06-13T15:00:00.000Z";

function setupTmpHome() {
  const dir = mkdtempSync(join(tmpdir(), "ctmd-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  mkdirSync(join(dir, ".claude", "quota-status", "sessions"), { recursive: true });
  ext.__resetForTests();
  return {
    home: dir,
    cleanup: () => {
      process.env.HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
      ext.__resetForTests();
    },
  };
}

// --- modelFamily ---

test("modelFamily: maps known model ids to their family", () => {
  assert.equal(modelFamily("claude-opus-4-7"), "opus");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("claude-sonnet-4-6"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-mythos-2"), "mythos");
});

test("modelFamily: unknown / empty / non-string falls through to 'unknown'", () => {
  assert.equal(modelFamily("nonsense"), "unknown");
  assert.equal(modelFamily(""), "unknown");
  assert.equal(modelFamily(null), "unknown");
  assert.equal(modelFamily(undefined), "unknown");
  assert.equal(modelFamily(123), "unknown");
});

// --- runDivergenceDetector — basic shape ---

test("matched turn → null (no spread) and clears any in-flight counter", () => {
  const { cleanup } = setupTmpHome();
  try {
    // Prime with a divergent turn so there's something to clear.
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    // Now match → null.
    const res = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-7", NOW);
    assert.equal(res, null);
  } finally {
    cleanup();
  }
});

test("missing requestedModel or servedModel → null (no spread)", () => {
  const { cleanup } = setupTmpHome();
  try {
    assert.equal(runDivergenceDetector(SID, "", "claude-opus-4-8", NOW), null);
    assert.equal(runDivergenceDetector(SID, "claude-opus-4-7", null, NOW), null);
    assert.equal(runDivergenceDetector(SID, undefined, undefined, NOW), null);
  } finally {
    cleanup();
  }
});

// --- Cross-family heuristic ---

test("cross-family swap → immediate sticky (Fable → Opus)", () => {
  const { cleanup } = setupTmpHome();
  try {
    const res = runDivergenceDetector(SID, "claude-fable-5", "claude-opus-4-8", NOW);
    assert.deepEqual(res, {
      requested_model: "claude-fable-5",
      served_model: "claude-opus-4-8",
      model_divergence_recent: true,
      model_divergence_sticky: true,
      model_divergence_first_seen: NOW,
    });
  } finally {
    cleanup();
  }
});

test("cross-family swap (Sonnet → Haiku) → immediate sticky", () => {
  const { cleanup } = setupTmpHome();
  try {
    const res = runDivergenceDetector(SID, "claude-sonnet-4-6", "claude-haiku-4-5", NOW);
    assert.equal(res.model_divergence_sticky, true);
  } finally {
    cleanup();
  }
});

// --- Same-family heuristic ---

test("same-family swap × 1 → recent, not sticky (counter=1)", () => {
  const { cleanup } = setupTmpHome();
  try {
    const res = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(res.model_divergence_recent, true);
    assert.equal(res.model_divergence_sticky, false);
    assert.equal(res.model_divergence_first_seen, null);
  } finally {
    cleanup();
  }
});

test("same-family swap × 3 at same target → sticky latches", () => {
  const { cleanup } = setupTmpHome();
  try {
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    const r3 = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(r3.model_divergence_sticky, true);
    assert.equal(r3.model_divergence_first_seen, NOW);
  } finally {
    cleanup();
  }
});

test("same-family swap × 2 at one target then × 1 at a different target → counter resets to 1 (no sticky)", () => {
  const { cleanup } = setupTmpHome();
  try {
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    const r3 = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-7-preview", NOW);
    assert.equal(r3.model_divergence_recent, true);
    assert.equal(r3.model_divergence_sticky, false);
  } finally {
    cleanup();
  }
});

test("sticky persists across subsequent matched turn", () => {
  const { cleanup } = setupTmpHome();
  try {
    runDivergenceDetector(SID, "claude-fable-5", "claude-opus-4-8", NOW); // sticky
    const matched = runDivergenceDetector(SID, "claude-fable-5", "claude-fable-5", "2026-06-13T15:05:00.000Z");
    assert.deepEqual(matched, {
      requested_model: "claude-fable-5",
      served_model: "claude-fable-5",
      model_divergence_recent: false,
      model_divergence_sticky: true,
      model_divergence_first_seen: NOW,
    });
  } finally {
    cleanup();
  }
});

test("same-family swap × 2 then matched at same requested model → counter resets (no sticky)", () => {
  const { cleanup } = setupTmpHome();
  try {
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    // Matched turn: should return null AND clear the counter.
    const matched = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-7", NOW);
    assert.equal(matched, null);
    // Now one more divergent turn should be counter=1 again, not 3.
    const next = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(next.model_divergence_sticky, false);
  } finally {
    cleanup();
  }
});

// --- Pair isolation (Fable r1 B2) ---

test("pair isolation: divergent at opus, matched at haiku (background utility), divergent at opus — opus counter NOT reset by haiku turn", () => {
  const { cleanup } = setupTmpHome();
  try {
    const r1 = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(r1.model_divergence_recent, true);
    // Interleaved background call at a different requestedModel — matched.
    const r2 = runDivergenceDetector(SID, "claude-haiku-4-5", "claude-haiku-4-5", NOW);
    assert.equal(r2, null);
    // Back to the opus pair — counter should advance to 2, not reset to 1.
    const r3 = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(r3.model_divergence_sticky, false);
    // One more confirms the counter — should latch sticky now.
    const r4 = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(r4.model_divergence_sticky, true);
  } finally {
    cleanup();
  }
});

// --- Restart rehydration (Fable r1 B1, Codex r1 B1) ---

test("restart rehydration: persisted sticky + matching requested_model → next turn rehydrates sticky", () => {
  const { cleanup, home } = setupTmpHome();
  try {
    const sessionsDir = join(home, ".claude", "quota-status", "sessions");
    writeFileSync(
      join(sessionsDir, `${SID}.json`),
      JSON.stringify({
        requested_model: "claude-opus-4-7",
        served_model: "claude-opus-4-8",
        model_divergence_sticky: true,
        model_divergence_first_seen: NOW,
      }),
    );
    // Simulate proxy restart — reset module state.
    ext.__resetForTests();
    // Next turn matches the requested_model on disk — rehydrate.
    const matched = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-7", "2026-06-13T16:00:00.000Z");
    // Even though no new divergence this turn, sticky is preserved.
    assert.equal(matched.model_divergence_sticky, true);
    assert.equal(matched.model_divergence_first_seen, NOW);
    assert.equal(matched.model_divergence_recent, false);
  } finally {
    cleanup();
  }
});

test("restart + /model change rehydration guard: persisted requested_model ≠ current → fresh pair, no inherited sticky (Codex r1 B1)", () => {
  const { cleanup, home } = setupTmpHome();
  try {
    const sessionsDir = join(home, ".claude", "quota-status", "sessions");
    writeFileSync(
      join(sessionsDir, `${SID}.json`),
      JSON.stringify({
        requested_model: "claude-opus-4-7",
        served_model: "claude-opus-4-8",
        model_divergence_sticky: true,
        model_divergence_first_seen: NOW,
      }),
    );
    ext.__resetForTests();
    // Next turn arrives at a DIFFERENT requested model — guard refuses
    // to seed; treats it as a fresh pair entry.
    const fresh = runDivergenceDetector(SID, "claude-sonnet-4-6", "claude-sonnet-4-6", "2026-06-13T16:00:00.000Z");
    assert.equal(fresh, null);
    // A divergent turn on the new pair starts at counter=1, no inherited
    // sticky from the persisted opus state.
    const div = runDivergenceDetector(SID, "claude-sonnet-4-6", "claude-sonnet-4-7", "2026-06-13T16:00:00.000Z");
    assert.equal(div.model_divergence_sticky, false);
    assert.equal(div.model_divergence_first_seen, null);
  } finally {
    cleanup();
  }
});

test("rehydration disk-read failure (file missing) is non-fatal — fresh entry", () => {
  const { cleanup } = setupTmpHome();
  try {
    // No file written — sessionFilePath read should ENOENT, caught.
    const res = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(res.model_divergence_recent, true);
    assert.equal(res.model_divergence_sticky, false);
  } finally {
    cleanup();
  }
});

test("rehydration disk-read failure (corrupt JSON) is non-fatal — fresh entry", () => {
  const { cleanup, home } = setupTmpHome();
  try {
    const sessionsDir = join(home, ".claude", "quota-status", "sessions");
    writeFileSync(join(sessionsDir, `${SID}.json`), "{not valid json");
    const res = runDivergenceDetector(SID, "claude-opus-4-7", "claude-opus-4-8", NOW);
    assert.equal(res.model_divergence_recent, true);
    assert.equal(res.model_divergence_sticky, false);
  } finally {
    cleanup();
  }
});

// --- Unknown family ---

test("unknown-family model treated as same-family (counter-based latching, no immediate sticky)", () => {
  const { cleanup } = setupTmpHome();
  try {
    const res = runDivergenceDetector(SID, "claude-unknown-x", "claude-other-y", NOW);
    assert.equal(res.model_divergence_recent, true);
    assert.equal(res.model_divergence_sticky, false);
  } finally {
    cleanup();
  }
});

// --- /model mid-session pair handling ---

test("/model change creates fresh pair entry; return to original resumes prior state", () => {
  const { cleanup } = setupTmpHome();
  try {
    // Opus pair: latch sticky.
    runDivergenceDetector(SID, "claude-fable-5", "claude-opus-4-8", NOW); // sticky immediately
    // /model to sonnet — matched turn, no divergence on the new pair.
    const sonnetMatch = runDivergenceDetector(SID, "claude-sonnet-4-6", "claude-sonnet-4-6", NOW);
    assert.equal(sonnetMatch, null);
    // Return to fable pair via another /model — matched (no new divergence)
    // but sticky from the prior in-memory state persists.
    const fableReturn = runDivergenceDetector(SID, "claude-fable-5", "claude-fable-5", NOW);
    assert.equal(fableReturn.model_divergence_sticky, true);
  } finally {
    cleanup();
  }
});
