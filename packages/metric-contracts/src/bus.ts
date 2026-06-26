// The single in-process usage-event bus.
//
// This is the ONLY runtime definition of the emitter — producers
// (metric-usage-api) and the consumer (metric-cost-api) both go through these
// two functions, which share one `globalThis`-pinned EventEmitter instance.
// Keeping it in one module (rather than the previous per-package copy) makes the
// emit -> subscribe identity guaranteed-singular and breaks the package cycle.
import { EventEmitter } from "node:events";
import type { UsageEvent } from "./events";

declare global {
  // eslint-disable-next-line no-var
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
