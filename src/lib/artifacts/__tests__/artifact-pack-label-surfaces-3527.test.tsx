// @vitest-environment jsdom
// Execute the real server page and the real review card. Only authenticated
// storage/transport ports are fixtures; label generation, lookup, server header
// composition and both drawn chips remain production code.
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ArtifactSummary } from "../artifact-service";

const ports = vi.hoisted(() => ({ artifact: {} as ArtifactSummary, gate: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ session: { activeOrganizationId: "org-label" } }),
  requireActorContext: async () => ({ actor: { kind: "user", id: "label-reader" } }),
}));
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: () => ({ kind: "ok", artifact: ports.artifact }),
  readArtifactForSettledReview: () => ({ kind: "ok", artifact: ports.artifact }),
}));
vi.mock("@/lib/artifacts/artifact-read", () => ({ resolveArtifactVersionForServe: () => null }));
vi.mock("@/lib/artifacts/representation-store", () => ({
  resolveEditorRevisionId: async () => null, getRepresentationByIdForReplay: () => null,
}));
vi.mock("@/lib/authz/enforce", () => ({ can: () => false }));
vi.mock("@/lib/authz/build-actor-context", () => ({ buildActorContextFromPrimitive: () => ({}) }));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({ readReviewGate: ports.gate }));
vi.mock("@/lib/artifacts/system-artifact-renderer-registrar", () => ({ ensureActivatedRepresentationProviders: async () => {} }));
vi.mock("@/app/artifacts/[id]/renderer-resolution", () => ({ resolveArtifactDispatchInputs: () => ({}), resolveArtifactDisplayMount: async () => ({ kind: "floor", dispatch: "fallback", slot: "detail", packageName: null, reason: "no-display" }) }));
vi.mock("@/app/artifacts/[id]/renderer-dispatch", () => ({
  pickArtifactRenderer: () => ({ kind: "fallback" }), isSelectionPreparing: () => false,
}));
vi.mock("@/app/artifacts/[id]/review-surface-roads", () => ({ hostArtifactContentBuilder: () => async () => { throw new Error("unused content read"); } }));
vi.mock("@/app/artifacts/[id]/extension-renderer-mount", () => ({ ExtensionRendererMount: () => null }));
vi.mock("@/app/artifacts/[id]/dashboard-pointer-detail", () => ({ DashboardPointerDetail: () => null, DashboardPointerLoading: () => null, DashboardPointerError: () => null }));
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", () => ({ resolveDashboardArtifactPointer: () => { throw new Error("unused dashboard read"); } }));
vi.mock("@/components/page-header-title-sync", () => ({ PageHeaderTitleSync: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  notFound: () => { throw new Error("not found"); }, redirect: () => { throw new Error("redirect"); },
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({ LoadingSpinner: () => null, PromptField: () => null }));
vi.mock("../../../../packages/agents/src/run-window-actions", () => ({
  loadRunWindowConversation: async () => [],
  sendRunWindowTurn: async () => { throw new Error("unexpected review decision"); },
}));

import ArtifactDetailPage from "@/app/artifacts/[id]/page";
import { PageHeader } from "@/components/page-header";
import { artifactKindLabelFor } from "../artifact-kind-label";
import { encodeLifecycleGateRef } from "@/lib/lifecycle/lifecycle-card-ref";
import { readReviewTargetHeaders } from "@/lib/lifecycle/lifecycle-target-headers";
import { LifecycleCardSurfaceProvider } from "../../../../packages/agents/src/lifecycle-card-runtime";
import { ReviewGateCard } from "../../../../packages/agents/src/review-gate-card";

const DECLARED = [
  ["@cinatra-ai/linkedin:post-draft", "LinkedIn post"],
  ["@cinatra-ai/email:body", "Email Artifacts"],
  ["@cinatra-ai/email:sent-email", "Email Artifacts"],
  ["@cinatra-ai/email:received-reply", "Email Artifacts"],
  ["@cinatra-ai/email:recipient", "Email Artifacts"],
  ["@cinatra-ai/drupal:node", "Drupal Artifacts"],
  ["@cinatra-ai/marketing-icp:profile", "Marketing ICP"],
] as const;

function findHeader(node: ReactNode): ReactElement | undefined {
  let found: ReactElement | undefined;
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === PageHeader) found = child;
    else found ??= findHeader(child.props.children);
  });
  return found;
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET ??= "native-label-secret";
  ports.artifact = {
    artifactId: "artifact-label", title: "A pinned draft", objectType: "",
    latestRepresentationRevisionId: null, artifactType: "file", mime: "text/markdown",
    ownerLevel: "team", visibility: "private", ownerId: "team-label", organizationId: "org-label",
    size: 0, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    sourceUrl: null, originKind: "upload", projectId: null, primaryExtension: null, eligibleExtensions: [], effectiveIdentity: { kind: "no-primary" },
    presentationIdentity: { kind: "no-primary" }, presentationSuggestions: [],
  } as ArtifactSummary;
  ports.gate.mockResolvedValue({ pinnedTargets: [{ artifactId: "artifact-label", representationRevisionId: "revision-label" }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("declared pack labels on actual artifact and review surfaces", () => {
  it.each(DECLARED)("the real artifact page chip renders %s as %s", async (objectType, label) => {
    ports.artifact.objectType = objectType;
    const props = { params: Promise.resolve({ id: "artifact-label" }), searchParams: Promise.resolve({ renderer: "generic" }) };
    const output = await ArtifactDetailPage(props);
    // Mount the actual PageHeader returned by the server route, including the
    // actual chip JSX and title component. Do not copy or reconstruct the chip.
    const header = findHeader(output);
    expect(header).toBeDefined();
    const ui = render(header!);
    expect(ui.getByTestId("artifact-kind-label").textContent).toBe(label);
    expect(ui.container.querySelector("h1")?.textContent).toContain("A pinned draft");
  });

  it.each(DECLARED)("the real review card header renders %s as %s", async (objectType, label) => {
    ports.artifact.objectType = objectType;
    const ref = encodeLifecycleGateRef({ runId: "run-label", reviewTaskId: "review-label" })!;
    const state = { state: "pending" as const, canDecide: true as const, canComment: true };
    const headers = await readReviewTargetHeaders({ viewType: "artifact_review_gate", ref, state,
      actorCtx: { actor: { kind: "user", id: "label-reader" }, orgId: "org-label", roleHints: [] } as never });
    expect(headers).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      kind: "artifact_review_gate", state, body: null, targetHeaders: headers,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const ui = render(<LifecycleCardSurfaceProvider host="run_card"><ReviewGateCard
      view={{ viewType: "artifact_review_gate", schemaVersion: 1, ref }} runId="run-label"
    /></LifecycleCardSurfaceProvider>);
    await waitFor(() => expect(ui.container.querySelector("[data-review-target-type]")?.textContent).toBe(label));
    expect(ui.container.querySelector("[data-review-target-revision]")?.textContent).toContain("revision");
    expect(ui.container.querySelector("[data-review-target-type]")?.getAttribute("data-review-target-type")).toBe(label);
  });

  it.each(DECLARED)("the production exact-type reader resolves %s to %s", (objectType, label) => {
    expect(artifactKindLabelFor(objectType)).toBe(label);
  });
  it("preserves the declared package fallback", () => {
    expect(artifactKindLabelFor("@cinatra-ai/linkedin-artifacts")).toBe("LinkedIn post");
  });
  it("preserves the unknown-type floor", () => {
    expect(artifactKindLabelFor("@uninstalled/blog:post")).toBe("Blog");
  });
});
