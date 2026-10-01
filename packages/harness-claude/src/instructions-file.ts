import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "@claudexor/schema";

/** Keep the native system-append role without putting unbounded text in argv.
 * The adapter owns this private file until the child has exited or been reaped,
 * including cancellation and spawn failure. It never lives in a worktree or
 * the account's native state directory. */
export async function* withClaudeInstructionsFile(
  instructions: string | undefined,
  run: (path: string | undefined) => AsyncIterable<HarnessEvent>,
): AsyncGenerator<HarnessEvent> {
  let directory: string | undefined;
  try {
    let path: string | undefined;
    if (instructions?.trim()) {
      directory = mkdtempSync(join(tmpdir(), "claudexor-claude-instructions-"));
      path = join(directory, "instructions.txt");
      writeFileSync(path, instructions, { encoding: "utf8", mode: 0o600 });
    }
    yield* run(path);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
