import { join } from "node:path";
import { homedir } from "node:os";

// The Claude Code config root. Honors CLAUDE_CONFIG_DIR, which Claude Code reads
// to relocate its config root away from the default ~/.claude. Without this,
// every proxy's state (quota-status, usage.jsonl, session-mirrors, snapshots,
// oauth) is hardcoded to ~/.claude, so running one proxy per config dir makes
// them clobber each other's account.json. Falls back to ~/.claude when unset.
// Read live (not cached) for test isolation, mirroring config.mjs.
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
