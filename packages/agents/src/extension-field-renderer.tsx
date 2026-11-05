"use client";

// The extension-shipped field-renderer mount wrapper (cinatra#1625, epic #1620
// S8 — M3 spine). When a binding's component has migrated into its claiming
// extension, register-default-renderers.ts registers THIS wrapper (bound to the
// binding id) in place of the host KIND component. The wrapper lazy-loads the
// extension module through the client resolution wiring and, on ANY failure —
// pre-render degrade (not-in-map / load-failed / invalid-export /
// abi-incompatible) OR a render-time throw — renders the SchemaFieldRenderer
// FLOOR (AC4: never blank/crash). Only the resolved binding's module executes.
//
// While loading, the floor is shown (never blank). The map is empty on day one,
// so this wrapper is never registered in production yet — it is exercised by the
// G2 cutover fixtures until the per-claimant slices migrate real components.

import {
  Component as ReactComponent,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { SchemaOnlyFloorRenderer } from "./schema-field-renderer";
import { loadFieldRendererComponent } from "./field-renderer-components";

/** Render-time containment: an extension renderer that throws while rendering is
 * caught and replaced by the floor (the pre-render degrade classes are handled
 * by the loader; this covers the throw-during-render half). */
class FieldRendererErrorBoundary extends ReactComponent<
  { fallback: ReactNode; onCrash?: () => void; children?: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: unknown): void {
    // Diagnostic only — the floor is already rendered by the fallback branch.
    console.error(
      "[field-renderer] extension renderer threw during render; showing SchemaFieldRenderer floor",
      error,
    );
    this.props.onCrash?.();
  }

  render(): ReactNode {
    if (this.state.crashed) {
      // THE CRASH IS MARKED HERE, in the render that swaps in the floor
      // (cinatra#3562), and not only in `componentDidCatch`: this render runs
      // before the commit that removes the crashed component, so a report the
      // component makes while it is removed (a layout-effect cleanup) already
      // finds the mark. Marking twice is harmless.
      this.props.onCrash?.();
      return this.props.fallback;
    }
    return this.props.children;
  }
}

/**
 * Build the field-renderer registry component for a MIGRATED binding id. The
 * returned component accepts the exact FieldRendererProps shape and never blanks
 * or crashes: it shows the floor while loading and on every degrade.
 */
export function makeExtensionFieldRenderer(
  bindingId: string,
): ComponentType<FieldRendererProps> {
  function ExtensionFieldRenderer(props: FieldRendererProps): ReactNode {
    const [resolved, setResolved] = useState<
      ComponentType<FieldRendererProps> | null
    >(null);
    const [degraded, setDegraded] = useState(false);
    // THE RESOLVED COMPONENT'S VALIDITY REPORTS (cinatra#3562). The host's
    // validity owner belongs to this wrapper, which stays on the screen when
    // the component inside it crashes into the floor. So the wrapper closes
    // the component's reporting road at the crash: what the component reported
    // before it crashed stands (a `false` keeps the gate held, which is
    // fail-closed), and a report that arrives later, `false` or `true`, changes
    // nothing. The floor itself never reports. The mark is set by the
    // boundary's crash callback, from the render that swaps in the floor, so
    // every report from that render on is dropped, the crashed component's
    // own layout-effect cleanup included; a report the component made before
    // it threw (in its render too) counts as its last. It is read only when a
    // report arrives. The guarded report keeps one identity
    // for as long as the host's own report does, so a component that reports
    // in an effect keyed on it does not report again on every render.
    const crashedRef = useRef(false);
    const reportValidity = props.onValidityChange;
    const guardedReport = useCallback(
      (valid: boolean) => {
        if (crashedRef.current) return;
        reportValidity?.(valid);
      },
      [reportValidity],
    );

    useEffect(() => {
      let alive = true;
      setResolved(null);
      setDegraded(false);
      loadFieldRendererComponent({ bindingId })
        .then((result) => {
          if (!alive) return;
          if (result.ok) setResolved(() => result.Component);
          else setDegraded(true);
        })
        .catch(() => {
          // Defensive: the loader is designed not to reject, but the floor is
          // the safety net regardless.
          if (alive) setDegraded(true);
        });
      return () => {
        alive = false;
      };
    }, [bindingId]);

    // Never blank: the floor covers both the loading window and every degrade.
    // The floor is `SchemaOnlyFloorRenderer` — a TRUE registry-bypass floor that
    // does NOT re-enter fieldRendererRegistry, so it cannot re-resolve THIS same
    // wrapper and recurse (cinatra#1625, codex 2026-07-20). Stripping `x-renderer`
    // alone was insufficient: it defeats only STRICT-ID conditions, while a
    // sender-name HEURISTIC (gmail-sender) matches on the field name and survives
    // the strip. We STILL strip `x-renderer` and preserve the active one on
    // context.xRenderer (the established convention — see FieldRendererContext),
    // matching every other floor-render site (agentic-run-panel,
    // orchestrator-stepper-panel, reviewer-agent-output-renderer); the bypass is
    // the load-bearing recursion guard, the strip keeps the floor's own schema
    // clean and context.xRenderer available.
    const { "x-renderer": strippedXRenderer, ...floorSchema } =
      props.schema as { "x-renderer"?: unknown } & Record<string, unknown>;
    const floorProps: FieldRendererProps = {
      ...props,
      schema: floorSchema,
      context: {
        ...props.context,
        xRenderer:
          typeof strippedXRenderer === "string"
            ? strippedXRenderer
            : props.context.xRenderer,
      },
    };
    const floor = createElement(SchemaOnlyFloorRenderer, floorProps);
    if (degraded || resolved === null) return floor;
    const resolvedProps: FieldRendererProps =
      reportValidity === undefined
        ? props
        : { ...props, onValidityChange: guardedReport };
    return createElement(
      FieldRendererErrorBoundary,
      {
        fallback: floor,
        onCrash: () => {
          crashedRef.current = true;
        },
      },
      createElement(resolved, resolvedProps),
    );
  }
  ExtensionFieldRenderer.displayName = `ExtensionFieldRenderer(${bindingId})`;
  return ExtensionFieldRenderer;
}
