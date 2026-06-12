import "server-only";

import { randomUUID } from "node:crypto";
import { buildA2aBearerToken } from "@cinatra-ai/llm";
import { createExternalA2AClient, type Task } from "@cinatra-ai/a2a";

// Host-side A2A blocking-dispatch helper shared by the Drupal + WordPress
// content-editor connectors. The non-SDK runtime edges — `@cinatra-ai/llm`
// (buildA2aBearerToken) + `@cinatra-ai/a2a` (createExternalA2AClient / Task) —
// live HERE and are delivered to each connector via its `deps.dispatchContentEditor`
// binding (the `@cinatra-ai/host:content-editor-dispatch` service published
// by register-host-connector-services.ts). The connector keeps only the
// `stripCodeFences` + `JSON.parse` of the returned text.
//
// Behavior: mint the A2A bearer for the "openai" provider, open the external A2A
// client, send a single text-mode task carrying `payload`, then walk
// `task.history` (NOT `task.artifacts` — WayFlow's A2AAgentWorker raises
// NotImplementedError on artifact reads) for the last agent/assistant message and
// return its concatenated text.

export type ContentEditorDispatchInput = {
  /** Resolved A2A endpoint for the content-editor agent. */
  agentUrl: string;
  /**
   * Input envelope forwarded as the A2A message text. Accepted as `unknown`
   * because the two consumers differ: the drupal connector pre-serializes
   * (`JSON.stringify(input)` → string), the wordpress connector passes the raw
   * object. A non-string payload is JSON-serialized here so the A2A `text` part
   * is never `[object Object]`.
   */
  payload: unknown;
  /** Blocking budget in ms (connectors pass 300_000 to align with /chat). */
  timeoutMs: number;
};

export async function dispatchContentEditorViaA2A(
  input: ContentEditorDispatchInput,
): Promise<string> {
  const a2aBearer = await buildA2aBearerToken("openai");
  const client = await createExternalA2AClient({
    agentUrl: input.agentUrl,
    credentials: a2aBearer ? { token: a2aBearer } : undefined,
    timeoutMs: input.timeoutMs,
  });

  const text =
    typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);
  const task: Task = await client.sendTask({
    message: {
      role: "user",
      kind: "message",
      messageId: randomUUID(),
      parts: [{ kind: "text", text }],
    },
    configuration: { acceptedOutputModes: ["text"] },
  });

  // A2A spec roles are "user" | "agent"; historical Cinatra runs may carry
  // "assistant" — accept both on the READ side only (producers MUST emit "agent").
  const history: ReadonlyArray<{
    role?: string;
    parts?: Array<{ kind?: string; text?: string }>;
  }> = task.history ?? [];
  const lastAgent = history
    .slice()
    .reverse()
    .find((m) => m?.role === "agent" || m?.role === "assistant");

  return (
    lastAgent?.parts
      ?.filter(
        (p): p is { kind: "text"; text: string } =>
          p.kind === "text" && typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("") ?? ""
  );
}
