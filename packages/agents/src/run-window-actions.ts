"use server";

// The client bridge for a prompt window outside the chat (cinatra#2933,
// lifecycle-b W5b). "use server" at file level so the five windows call opaque
// server-action references instead of pulling the assistant runtime — and the
// run's access rule — into a client chunk.
//
// It adds no rule of its own: every decision (who may type, what is stored,
// which assistant answers) belongs to `@/lib/lifecycle/run-window-turn`, which
// both this bridge and the server components that pre-render the windows call.

import type { RunWindowSurface } from "./run-window-conversation-store";

// THE IMPLEMENTATION IS REACHED LAZILY, and that is load-bearing rather than a
// style choice. The five windows are CLIENT components, and a client component
// reaches a server action through a static import of this module. Under Next
// that import is replaced by an action reference and no server code crosses the
// boundary — but the module graph is real everywhere else, and a static import
// here would put the run store, the run's access policy and the session reader
// into the graph of every test that merely RENDERS one of those five screens.
// The door is this file; what is behind it opens when a caller actually knocks.
async function impl() {
  return import("@/lib/lifecycle/run-window-turn");
}

/** One entry of a window conversation, in the shape the panel renders. */
export type RunWindowEntry = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

export type RunWindowTurnOutcome =
  | { ok: true; entries: RunWindowEntry[] }
  | { ok: false; reason: "denied" | "failed"; message: string };

/**
 * The window's numeric keys are POSITIONS in the stored order, so a re-read
 * after a reload produces the same keys as the turn that wrote the rows.
 */
function toEntries(
  rows: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): RunWindowEntry[] {
  return rows.map((row, index) => ({
    id: index + 1,
    role: row.role,
    content: row.text,
  }));
}

/** Send one message from a window and get the whole exchange back. */
export async function sendRunWindowTurn(input: {
  runId: string;
  surface: RunWindowSurface;
  prompt: string;
  boundCard?: { candidateRefs: string[]; focusedRef: string | null };
}): Promise<RunWindowTurnOutcome> {
  try {
    // Inside the try on purpose: a module that fails to load is a failure of
    // this action, and the caller is owed the same answer it gets for any other
    // failure rather than a rejected promise it has no handler for.
    const { runWindowTurn } = await impl();
    const result = await runWindowTurn(input);
    return { ok: true, entries: toEntries(result.entries) };
  } catch (err) {
    // Read by NAME rather than by `instanceof`: the class lives behind the same
    // dynamic import that may itself be what failed, and a refusal must be
    // recognisable without loading anything.
    if ((err as { name?: unknown } | null)?.name === "RunWindowAccessDenied") {
      return {
        ok: false,
        reason: "denied",
        // The same sentence the box's absence already implies — a person who
        // reaches this by racing a permission change is told, not silently
        // dropped.
        message: "You do not have access to answer this run.",
      };
    }
    return {
      ok: false,
      reason: "failed",
      message: "The assistant could not answer just now — please try again.",
    };
  }
}

/** The stored exchange for the first paint after a reload. */
export async function loadRunWindowConversation(
  runId: string,
): Promise<RunWindowEntry[]> {
  try {
    const { readRunWindowConversation } = await impl();
    return toEntries(await readRunWindowConversation(runId));
  } catch {
    // A window that cannot read its conversation still opens; it simply starts
    // empty rather than breaking the screen it is portalled into.
    return [];
  }
}
