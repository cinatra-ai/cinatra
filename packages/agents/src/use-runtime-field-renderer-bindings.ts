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
// bundles stay unchanged. Every failure path degrades silently — resolution
// falls back to the schema-field path.

import { useEffect, useState } from "react";

export function useRuntimeFieldRendererBindings(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getRuntimeFieldRendererBindingsAction } = await import(
          "./server-actions"
        );
        const bindings = await getRuntimeFieldRendererBindingsAction();
        if (cancelled || !Array.isArray(bindings) || bindings.length === 0) {
          return;
        }
        const { registerFieldRendererBindings } = await import(
          "./register-default-renderers"
        );
        registerFieldRendererBindings(bindings);
        if (!cancelled) setVersion((v) => v + 1);
      } catch {
        // Degrade silently: resolution falls back to the schema-field path.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
