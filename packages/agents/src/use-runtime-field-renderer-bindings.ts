"use client";

// useRuntimeFieldRendererBindings (cinatra#151 Stage 5) — SOURCE B client
// trigger of the two-source field-renderer binding registration.
//
// The HITL panel surfaces (AgenticRunPanel, OrchestratorStepperPanel) call
// this hook on mount: it fetches the bindings declared by RUNTIME-installed
// agent packages (getRuntimeFieldRendererBindingsAction — enumeration-only,
// session-guarded, public renderer metadata) and registers them into the
// client registry idempotently (replace-by-id). The internal state bump
// re-renders the calling panel so renderer resolution picks up the new
// entries — on a prod image where an agent is not bundled, its gate shows
// the schema-field fallback for at most one fetch round-trip and then the
// bespoke renderer.
//
// Build-time (generated) bindings are NOT fetched here — they are compiled
// into the registry synchronously at module init
// (ensureDefaultFieldRenderersRegistered), preserving the retired hand map's
// timing for every bundled agent.
//
// Both imports are DELIBERATELY lazy: the action module and the registration
// module (which owns the full renderer component table) only load when
// runtime bindings actually exist, so panel test graphs and first-paint
// bundles stay unchanged. A failure is recorded, never thrown
// (`settleRuntimeRendererBindings`): a mid-run screen whose binding has not
// loaded, or failed to load, holds its Continue (`continueHeldByRenderer`,
// cinatra#3470) rather than sending an answer its renderer never drew.

// The read itself, shared with a gate's fresh read, lives beside the store it
// records into (`readRuntimeRendererBindings`, cinatra#3470).

import { useEffect, useState } from "react";
import { readRuntimeRendererBindings } from "./field-renderer-registry";

export function useRuntimeFieldRendererBindings(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void readRuntimeRendererBindings().then((answered) => {
      if (answered && !cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);
}
