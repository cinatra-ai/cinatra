import type { HitlGateContext } from "@cinatra-ai/agents/client-entry";

/** Deterministic read inputs for the three #3487 required fixture hosts. */
export const RUN_WINDOW_OWNERSHIP_HOSTS = ["run", "review", "chat"] as const;
export type RunWindowOwnershipHost = (typeof RUN_WINDOW_OWNERSHIP_HOSTS)[number];
export function runWindowOwnershipHost(value: string | string[] | undefined): RunWindowOwnershipHost | null {
  return typeof value === "string" && RUN_WINDOW_OWNERSHIP_HOSTS.some((host) => host === value)
    ? value as RunWindowOwnershipHost : null;
}
export const OWNERSHIP_RUN_ID = "conformance-window-run";
export const OWNERSHIP_REVIEW_REF = "conformance-window-review";
export const OWNERSHIP_REVIEW_VIEW = {
  viewType: "artifact_review_gate", schemaVersion: 1, ref: OWNERSHIP_REVIEW_REF,
} as const;
export const OWNERSHIP_REVIEW_ANSWER = {
  kind: "artifact_review_gate", body: null,
  state: { state: "pending", canDecide: true, canComment: true },
} as const;
// The real schema renderer receives a required, manipulable input. No extension
// package identity or package-specific renderer is fabricated for this fixture.
export const OWNERSHIP_INPUT: HitlGateContext = {
  inputSchema: { type: "object", properties: { subject: { type: "string", title: "Subject" } }, required: ["subject"] },
  xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  childRunId: null, currentValues: { subject: "Fixture subject" }, reviewTaskId: "conformance-input-gate",
};
