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
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import { SchemaFieldRenderer } from "./schema-field-renderer";
import { loadFieldRendererComponent } from "./field-renderer-components";

/** Render-time containment: an extension renderer that throws while rendering is
 * caught and replaced by the floor (the pre-render degrade classes are handled
 * by the loader; this covers the throw-during-render half). */
class FieldRendererErrorBoundary extends ReactComponent<
  { fallback: ReactNode; children?: ReactNode },
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
  }

  render(): ReactNode {
    return this.state.crashed ? this.props.fallback : this.props.children;
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
    // CRITICAL — strip `x-renderer` from the schema handed to the floor. The
    // SchemaFieldRenderer floor is REGISTRY-FIRST (it re-resolves via
    // fieldRendererRegistry), so an unstripped `x-renderer` would re-resolve THIS
    // same extension wrapper and recurse until crash — the opposite of the AC4
    // never-blank/never-crash floor. The active x-renderer is preserved on
    // context.xRenderer (the established convention — see FieldRendererContext),
    // matching every other floor-render site (agentic-run-panel,
    // orchestrator-stepper-panel, reviewer-agent-output-renderer).
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
    const floor = createElement(SchemaFieldRenderer, floorProps);
    if (degraded || resolved === null) return floor;
    return createElement(
      FieldRendererErrorBoundary,
      { fallback: floor },
      createElement(resolved, props),
    );
  }
  ExtensionFieldRenderer.displayName = `ExtensionFieldRenderer(${bindingId})`;
  return ExtensionFieldRenderer;
}
