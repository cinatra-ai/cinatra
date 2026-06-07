import "server-only";

import { spawn } from "node:child_process";

// Minimal thread shape needed by this bridge (matches packages/chat/src/types.ts)
type ThreadForGemini = {
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
};

// ---------------------------------------------------------------------------
// callGeminiCliAssistant
// ---------------------------------------------------------------------------

/**
 * Calls the Gemini CLI in headless JSON mode and returns the response text.
 * Always resolves — returns an error string on failure so the caller can
 * persist it as an assistant message rather than crashing the thread.
 *
 * Uses the logged-in Google OAuth session (no API key required).
 * Invokes: `gemini --output-format json --prompt "<prompt>"`
 * Parses the JSON response field from stdout.
 *
 * Note: `--output-format json` is required for headless operation.
 * The plain `-p/--prompt` mode requires a TTY and hangs when spawned
 * from a server process.
 *
 * @param thread      - The chat thread (last 10 messages used as context)
 * @param userMessage - The new user message that triggered the @gemini mention
 */
export async function callGeminiCliAssistant(thread: ThreadForGemini, userMessage: string): Promise<string> {
  // Build conversation context from the last 10 messages in the thread
  const contextMessages = (thread.messages ?? []).slice(-10);
  const context = contextMessages
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");

  const prompt = context
    ? `${context}\n\nUser: ${userMessage}\n\nRespond directly and concisely.`
    : `${userMessage}\n\nRespond directly and concisely.`;

  return new Promise<string>((resolve) => {
    let stdoutChunks: string[] = [];
    let stderrChunks: string[] = [];
    let settled = false;

    const child = spawn("gemini", ["--output-format", "json", "--prompt", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Enforce 120s timeout
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve("@gemini failed: response timed out after 120s");
      }
    }, 120_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;

      if (code === 0) {
        try {
          const raw = stdoutChunks.join("").trim();
          const parsed = JSON.parse(raw) as { response?: string };
          resolve(parsed.response?.trim() ?? "(empty response)");
        } catch {
          // Fallback: return raw stdout if JSON parse fails
          const text = stdoutChunks.join("").trim();
          resolve(text || "(empty response)");
        }
      } else {
        const stderrTail = stderrChunks.join("").slice(-500).trim();
        resolve(`@gemini failed (exit ${code}): ${stderrTail}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      resolve(`@gemini failed: ${err.message}`);
    });
  });
}
