"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AgentHitlScreenGate } from "./agent-hitl-screen";
import type { FieldRendererProps } from "./field-renderer-registry";

const HitlRenderInputContext = createContext<{ runId: string; gate: AgentHitlScreenGate } | null>(null);
export function HitlRenderInputProvider({ runId, gate, children }: { runId: string; gate: AgentHitlScreenGate | null; children?: ReactNode }) {
  return <HitlRenderInputContext.Provider value={gate ? { runId, gate } : null}>{children}</HitlRenderInputContext.Provider>;
}

/** A declared render-only field is ALWAYS replaced, including on refusal. It
 * must never fall back to a hostile persisted/model value of the same name.
 * The renderer still receives its original answers and allFieldValues. */
export function useHitlRenderInputValue(bindingId: string, props: FieldRendererProps): unknown {
  const scope = useContext(HitlRenderInputContext);
  const declaration = props.bindingParams?.renderInputs as { siteHost?: unknown } | undefined;
  if (!declaration?.siteHost || !props.value || typeof props.value !== "object" || Array.isArray(props.value)) return props.value;
  const original = props.value as Record<string, unknown>;
  const value = { ...original };
  delete value.siteHost;
  const projection = scope?.gate.renderInputs;
  const spec = declaration.siteHost as Record<string, unknown>;
  const identities = spec.identityFields;
  if (!scope || scope.runId !== props.context.runId || scope.gate.xRenderer !== bindingId || !projection || projection.bindingId !== bindingId || projection.reviewTaskId !== scope.gate.reviewTaskId || spec.instanceField !== projection.instanceField || value[projection.instanceField] !== projection.instanceId || !Array.isArray(identities) || identities.length !== Object.keys(projection.identityValues).length || identities.some(key => typeof key !== "string" || value[key] !== projection.identityValues[key])) return value;
  return { ...value, siteHost: projection.siteHost };
}
