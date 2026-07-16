"use client";

import {
  Component,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import {
  classifyImportFailure,
  type FreshnessPreflightVerdict,
  type RuntimeRendererFloorReason,
  type SerializedRuntimeRendererDescriptor,
} from "@/lib/artifacts/runtime-renderer-descriptor";
import {
  assertSingleReactIdentity,
  isHostModuleRegistryInitialized,
} from "@/lib/artifacts/host-module-registry";

import { DynamicRendererFloor } from "./dynamic-renderer-floor";

// The CLIENT LOADER SEAM (epic #1620 M1 Slice A — cinatra#1630, plan §2.5–§2.6).
// The ONE sanctioned variable-URL `import()` in the codebase (G4 carve-out; the
// AST ratchet `scripts/audit/no-variable-url-dynamic-import.mjs` forbids it
// everywhere else). It runs, in order:
//   1. a fail-closed freshness PREFLIGHT (still-admitted: current digest,
//      signature, extension still installed/active — ruling 8) — injected so the
//      pure verdict logic stays server-side + tested;
//   2. `import(descriptor.digestPinnedUrl)` behind a bounded, timeout-capped
//      skeleton (late completion is IGNORED — it cannot cancel module eval or
//      undo top-level effects, stated honestly);
//   3. a single-React-identity conformance assert + a default-export check;
//   4. a React error boundary around the mounted renderer.
// EVERY non-mounted state renders the never-blank floor with a side-data reason.
//
// The live render + real import proof rides the json-artifact slice (Slice B);
// this component is the seam it drives.

const DEFAULT_TIMEOUT_MS = 8000;

type LoaderState =
  | { phase: "loading" }
  | { phase: "floor"; reason: RuntimeRendererFloorReason }
  | { phase: "mounted"; Component: ComponentType<ArtifactRendererProps> };

/** A React error boundary that degrades a render/lifecycle throw to the floor
 * (LOGICAL containment only — not a security boundary; plan §2.6). */
class RendererErrorBoundary extends Component<
  { onError: () => void; fallback: ReactNode; children: ReactNode },
  { crashed: boolean }
> {
  constructor(props: { onError: () => void; fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  componentDidCatch(): void {
    this.props.onError();
  }
  render(): ReactNode {
    return this.state.crashed ? this.props.fallback : this.props.children;
  }
}

export function DynamicRendererLoader({
  descriptor,
  props,
  fallback,
  preflight,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  descriptor: SerializedRuntimeRendererDescriptor;
  props: ArtifactRendererProps;
  /** The host's generic floor node — rendered on EVERY failure (never blank). */
  fallback: ReactNode;
  /** The fail-closed freshness preflight (REQUIRED — no fail-open default; the
   * host wires it to a server check that re-confirms the descriptor is still
   * admitted: current digest, signature, extension still installed/active). */
  preflight: () => Promise<FreshnessPreflightVerdict>;
  timeoutMs?: number;
}): ReactNode {
  const [state, setState] = useState<LoaderState>({ phase: "loading" });
  // A render-failure toggle the error boundary flips (kept out of the effect).
  const [renderFailed, setRenderFailed] = useState(false);

  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    // A server-supplied reason short-circuits to the floor (no import) — handled
    // directly in render below, so the effect just does nothing (no import).
    if (descriptor.reason) return;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!cancelledRef.current) setState({ phase: "floor", reason: classifyImportFailure("timeout") });
    }, timeoutMs);

    void (async () => {
      try {
        // 0. INIT-BEFORE-IMPORT (fail-closed, plan §2.3): the host
        // module-registry shim MUST be initialized before importing a renderer,
        // or its externalized `import "react"` cannot resolve to the host
        // singleton. If the shim is not ready, floor (transient) — never import.
        if (!isHostModuleRegistryInitialized()) {
          clearTimeout(timer);
          setState({ phase: "floor", reason: "materializing" });
          return;
        }
        // 1. Fail-closed freshness preflight (still admitted?) — always run.
        const verdict = await preflight();
        if (cancelledRef.current || timedOut) return;
        if (!verdict.ok) {
          clearTimeout(timer);
          setState({ phase: "floor", reason: verdict.reason });
          return;
        }
        // 2. The sanctioned variable-URL dynamic import (G4 carve-out) — the ONE
        // sanctioned client loader seam (allowlisted by the AST ratchet
        // scripts/audit/no-variable-url-dynamic-import.mjs).
        const mod: unknown = await import(/* webpackIgnore: true */ descriptor.digestPinnedUrl);
        if (cancelledRef.current || timedOut) return; // late completion ignored

        const candidate = (mod as { default?: unknown }).default;
        if (typeof candidate !== "function") {
          clearTimeout(timer);
          setState({ phase: "floor", reason: classifyImportFailure("invalid-export") });
          return;
        }
        // 3. Single-React-identity conformance (AC-10). A second React copy throws.
        const observedReact = (mod as { __cinatraReact?: unknown }).__cinatraReact;
        if (observedReact !== undefined) assertSingleReactIdentity(observedReact);

        clearTimeout(timer);
        setState({ phase: "mounted", Component: candidate as ComponentType<ArtifactRendererProps> });
      } catch {
        if (cancelledRef.current || timedOut) return;
        clearTimeout(timer);
        setState({ phase: "floor", reason: classifyImportFailure("import-rejected") });
      }
    })();

    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
    // descriptor identity (digest-pinned URL) is the effect key.
  }, [descriptor, preflight, timeoutMs]);

  // A server-supplied floor reason short-circuits without any import (handled in
  // render so the effect never calls setState synchronously).
  if (descriptor.reason) {
    return (
      <DynamicRendererFloor
        packageName={descriptor.tuple.packageName}
        slot={descriptor.tuple.slot}
        reason={descriptor.reason}
        fallback={fallback}
      />
    );
  }

  if (renderFailed) {
    return (
      <DynamicRendererFloor
        packageName={descriptor.tuple.packageName}
        slot={descriptor.tuple.slot}
        reason={classifyImportFailure("render-failure")}
        fallback={fallback}
      />
    );
  }

  if (state.phase === "floor") {
    return (
      <DynamicRendererFloor
        packageName={descriptor.tuple.packageName}
        slot={descriptor.tuple.slot}
        reason={state.reason}
        fallback={fallback}
      />
    );
  }

  if (state.phase === "loading") {
    // The bounded, timeout-capped skeleton (replaced by the floor on timeout).
    return <div data-dynamic-renderer-skeleton aria-busy="true" className="animate-pulse h-24 rounded-md bg-muted" />;
  }

  const Renderer = state.Component;
  return (
    <RendererErrorBoundary
      onError={() => setRenderFailed(true)}
      fallback={
        <DynamicRendererFloor
          packageName={descriptor.tuple.packageName}
          slot={descriptor.tuple.slot}
          reason={classifyImportFailure("render-failure")}
          fallback={fallback}
        />
      }
    >
      <Renderer {...props} />
    </RendererErrorBoundary>
  );
}
