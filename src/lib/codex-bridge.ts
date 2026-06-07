import "server-only";

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal thread shape needed by this bridge (matches packages/chat/src/types.ts)
type ThreadForCodex = {
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
};

// ---------------------------------------------------------------------------
// callCodexAssistant
// ---------------------------------------------------------------------------

/**
 * Calls the Codex CLI in one-shot exec mode and returns the response text.
 * Always resolves — returns an error string on failure so the caller can
 * persist it as an assistant message rather than crashing the thread.
 *
 * @param thread  - The chat thread (last 10 messages used as context)
 * @param userMessage - The new user message that triggered the @chatgpt mention
 */
export async function callCodexCliAssistant(thread: ThreadForCodex, userMessage: string): Promise<string> {
  // Build conversation context from the last 10 messages in the thread
  const contextMessages = (thread.messages ?? []).slice(-10);
  const context = contextMessages
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");

  const prompt = `${context}\n\nUser: ${userMessage}\n\nRespond directly and concisely.`;

  // Create a temp dir for output file
  const tmpDir = mkdtempSync(join(tmpdir(), "chatgpt-"));
  const outFile = join(tmpDir, "response.txt");

  return new Promise<string>((resolve) => {
    let stderrChunks: string[] = [];
    let settled = false;

    const child = spawn(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--output-last-message",
        outFile,
        prompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    // Enforce 120s timeout
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
    }, 120_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;

      try {
        if (code === 0) {
          const text = readFileSync(outFile, "utf8").trim();
          resolve(text);
        } else {
          const stderrTail = stderrChunks.join("").slice(-500).trim();
          resolve(`@chatgpt failed (exit ${code}): ${stderrTail}`);
        }
      } catch (err) {
        resolve(`@chatgpt failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      rmSync(tmpDir, { recursive: true, force: true });
      resolve(`@chatgpt failed: ${err.message}`);
    });
  });
}
