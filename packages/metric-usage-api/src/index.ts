import { EventEmitter } from "node:events";
import type { UsageEvent } from "./types";

export type { UsageEvent, LlmUsageEvent, ApolloUsageEvent } from "./types";

declare global {
  var __cinatraUsageEventEmitter: EventEmitter | undefined;
}

function getEmitter(): EventEmitter {
  if (!globalThis.__cinatraUsageEventEmitter) {
    globalThis.__cinatraUsageEventEmitter = new EventEmitter();
    globalThis.__cinatraUsageEventEmitter.setMaxListeners(20);
  }
  return globalThis.__cinatraUsageEventEmitter;
}

export function emitUsageEvent(event: UsageEvent): void {
  try {
    getEmitter().emit("usage", event);
  } catch {
    // Intentionally swallowed — metric collection must never break LLM calls
  }
}

export function onUsageEvent(handler: (event: UsageEvent) => void): () => void {
  const emitter = getEmitter();
  emitter.on("usage", handler);
  return () => emitter.off("usage", handler);
}

export { createMetricUsageMcpModule } from "./mcp/module";
