// The promotion ROUND TRIP on the app side — epic #1705 AC5, the clause
// "promotion produces a rebuilt cached env" (surface + write half).
//
// `agent-execution-config-load.test.ts` proves a candidate is SURFACED from
// observed installs; `packages/execution-plane/src/__tests__/environment-promotion-rebuild.test.ts`
// (and its real-docker e2e sibling) prove a promoted DECLARATION rebuilds and
// then caches. This file joins them at the seam epic D8 names — the agent's
// ORDINARY config-approval path — by driving the two production surfaces
// themselves rather than a description of them:
//
//   - the real editor component, rendered, for what the affordance OFFERS;
//   - the real server action, invoked, for what actually gets WRITTEN.
//
// The one thing that cannot be exercised: the observation PRODUCER. No product
// code records a run's ad-hoc L2 installs yet (`agent-execution-config-load.ts`
// defaults `readObservations` to `noObservations()`), so the observations here
// are injected through that existing seam, exactly as a producer would supply
// them. See the AC5 disposition on #1705.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const requireAdminSession = vi.fn(async () => ({}) as never);
const readAgentTemplateByPackageName = vi.fn();
const writeAgentExecutionConfig = vi.fn();
const readManifestEnvironmentClaim = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: (...args: unknown[]) => requireAdminSession(...(args as [])),
}));
// The action resolves AUTHORITY through the loader's manifest reader; that
// boundary is doubled (there is no extension store in a unit run), everything
// else in the action — the parser, the authority rule, the write — is real.
vi.mock("@/lib/execution/agent-execution-config-load", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readManifestEnvironmentClaim: (...args: unknown[]) =>
    readManifestEnvironmentClaim(...args),
}));
vi.mock("@cinatra-ai/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The submission PARSER stays real — it is the fail-closed contract under
  // test. Only the store reads/writes are doubled.
  readAgentTemplateByPackageName: (...args: unknown[]) =>
    readAgentTemplateByPackageName(...args),
  writeAgentExecutionConfig: (...args: unknown[]) => writeAgentExecutionConfig(...args),
}));

import { serializeExecutionEnvironmentForStorage } from "@cinatra-ai/agents/execution-config";
import type { ExecutionEnvironmentManager } from "@cinatra-ai/sdk-extensions";
import { applyPromotion } from "@cinatra-ai/execution-plane/environment/promotion";
import { AgentExecutionConfigClient } from "@/components/execution/agent-execution-config-client";
import { saveAgentExecutionConfigAction } from "@/lib/execution/agent-execution-config-actions";
import { loadAgentExecutionConfig } from "@/lib/execution/agent-execution-config-load";

const IDENT = { packageName: "@cinatra-ai/some-agent", displayName: "Some Agent" };

/** `pandoc` ad hoc on 6 of the last 10 runs (clears the 50% default). */
const OBSERVED = Array.from({ length: 6 }, (_, i) => ({
  runId: `r${i}`,
  manager: "os" as const,
  packageName: "pandoc",
})).concat(
  Array.from({ length: 4 }, (_, i) => ({
    runId: `r${i + 6}`,
    manager: "os" as const,
    packageName: "jq",
  })),
);

function templateStub(overrides: Record<string, unknown> = {}) {
  return async () => ({ id: "t_1", packageName: IDENT.packageName, ...overrides }) as never;
}

async function loadWithObservations(over: Record<string, unknown> = {}) {
  return loadAgentExecutionConfig(IDENT, {
    readManifestEnvironment: async () => ({
      environment: null,
      readFailed: false,
      packaged: false,
    }),
    readTemplate: templateStub({
      executionEnvironment: { pip: ["pandas"] },
      executionEnabled: true,
    }),
    readObservations: async () => OBSERVED,
    serviceState: () => "ready",
    ...over,
  });
}

/**
 * The editor text a human ends up submitting after clicking Add. This MIRRORS
 * `addEntry` in `src/components/execution/agent-execution-config-client.tsx`
 * (append unless already present) — the client's state transition is React-local
 * and the root vitest env is node, so the interaction itself is not simulated.
 * What IS driven for real: the component render below (the affordance exists and
 * is bound to the candidate) and the server action (what the click's Save
 * actually writes).
 */
function editorTextAfterAdd(
  text: Record<ExecutionEnvironmentManager, string>,
  manager: ExecutionEnvironmentManager,
  entry: string,
): Record<ExecutionEnvironmentManager, string> {
  const lines = text[manager].split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.includes(entry)) return text;
  return { ...text, [manager]: [...lines, entry].join("\n") };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("the promotion affordance the surface actually renders", () => {
  it("offers a candidate-bound Add on a config-owned recipe", async () => {
    const view = await loadWithObservations();
    const html = renderToStaticMarkup(
      <AgentExecutionConfigClient view={view} save={async () => ({ ok: true }) as const} />,
    );
    expect(html).toContain("execution-promotion-list");
    expect(html).toContain("execution-promote");
    expect(html).toContain("pandoc");
    // 4/10 does not clear the threshold — the affordance suggests one thing.
    expect(html).not.toContain(">jq<");
  });

  it("offers NO Add on a package-owned recipe — that promotion travels the package's review path (D8)", async () => {
    const view = await loadWithObservations({
      readManifestEnvironment: async () => ({
        environment: { pip: ["pandas"] },
        readFailed: false,
        packaged: true,
      }),
    });
    const html = renderToStaticMarkup(<AgentExecutionConfigClient view={view} />);
    // The suggestion is still INFORMED by real observations…
    expect(html).toContain("execution-promotion-list");
    expect(html).toContain("pandoc");
    // …but there is no in-place promotion control at all.
    expect(html).not.toContain("execution-promote");
    expect(html).not.toContain("execution-config-save");
  });
});

describe("what the approved promotion actually WRITES (the real server action)", () => {
  it("lands exactly the promoted declaration on the template row", async () => {
    const view = await loadWithObservations();
    const candidate = view.promotionCandidates[0];
    expect(candidate).toEqual({
      manager: "os",
      packageName: "pandoc",
      runCount: 6,
      windowRuns: 10,
    });
    if (!candidate || !view.spec) return;

    readAgentTemplateByPackageName.mockResolvedValue({ id: "t_1" });
    readManifestEnvironmentClaim.mockResolvedValue({
      environment: null,
      readFailed: false,
      packaged: false,
    });
    writeAgentExecutionConfig.mockResolvedValue(true);

    const result = await saveAgentExecutionConfigAction({
      packageName: IDENT.packageName,
      submission: {
        executionEnabled: view.posture,
        ...editorTextAfterAdd(view.editorText, candidate.manager, candidate.packageName),
      },
    });
    expect(result).toEqual({ ok: true });

    // The row is written with the promoted spec — and it is EXACTLY the
    // reviewable proposal the promotion module computes, so the surface never
    // writes a different recipe than the review diff showed.
    expect(writeAgentExecutionConfig).toHaveBeenCalledTimes(1);
    const [templateId, config] = writeAgentExecutionConfig.mock.calls[0]!;
    expect(templateId).toBe("t_1");
    expect(config.environment).toEqual(applyPromotion(view.spec, candidate).after);
    expect(config.environment.os).toEqual(["pandoc"]);
    expect(config.environment.pip).toEqual(["pandas"]);

    // The value the next immutable version snapshot captures — and which the
    // builder hashes its recipe key from — is a DIFFERENT canonical recipe than
    // before the promotion. That difference is what makes the next resolution a
    // cache MISS; the rebuild itself is executed in the execution-plane
    // promotion-rebuild battery (and on real docker in its e2e sibling).
    expect(serializeExecutionEnvironmentForStorage(config.environment)).not.toBe(
      serializeExecutionEnvironmentForStorage(view.spec),
    );
  });

  it("REFUSES the write when the recipe is package-owned (D8, enforced server-side)", async () => {
    const view = await loadWithObservations({
      readManifestEnvironment: async () => ({
        environment: { pip: ["pandas"] },
        readFailed: false,
        packaged: true,
      }),
    });
    readAgentTemplateByPackageName.mockResolvedValue({ id: "t_1" });
    readManifestEnvironmentClaim.mockResolvedValue({
      environment: { pip: ["pandas"] },
      readFailed: false,
      packaged: true,
    });

    const result = await saveAgentExecutionConfigAction({
      packageName: IDENT.packageName,
      // A caller that reproduces the promoted text anyway (the read-only surface
      // renders no Add, but the action never trusts the client).
      submission: {
        executionEnabled: "on",
        ...editorTextAfterAdd(view.editorText, "os", "pandoc"),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toMatch(/package manifest/i);
    expect(writeAgentExecutionConfig).not.toHaveBeenCalled();
  });

  it("REFUSES a promoted entry that cannot form a valid declaration — never sanitizes it", async () => {
    readAgentTemplateByPackageName.mockResolvedValue({ id: "t_1" });
    readManifestEnvironmentClaim.mockResolvedValue({
      environment: null,
      readFailed: false,
      packaged: false,
    });
    const result = await saveAgentExecutionConfigAction({
      packageName: IDENT.packageName,
      submission: { executionEnabled: "on", os: "not a package name", pip: "", npm: "" },
    });
    expect(result.ok).toBe(false);
    expect(writeAgentExecutionConfig).not.toHaveBeenCalled();
  });

  it("a second Add of the same candidate is not a second entry (and not a second rebuild)", async () => {
    const view = await loadWithObservations();
    const candidate = view.promotionCandidates[0]!;
    const once = editorTextAfterAdd(view.editorText, candidate.manager, candidate.packageName);
    const twice = editorTextAfterAdd(once, candidate.manager, candidate.packageName);
    expect(twice).toEqual(once);

    readAgentTemplateByPackageName.mockResolvedValue({ id: "t_1" });
    readManifestEnvironmentClaim.mockResolvedValue({
      environment: null,
      readFailed: false,
      packaged: false,
    });
    writeAgentExecutionConfig.mockResolvedValue(true);
    await saveAgentExecutionConfigAction({
      packageName: IDENT.packageName,
      submission: { executionEnabled: "on", ...once },
    });
    await saveAgentExecutionConfigAction({
      packageName: IDENT.packageName,
      submission: { executionEnabled: "on", ...twice },
    });
    const [, first] = writeAgentExecutionConfig.mock.calls[0]!;
    const [, second] = writeAgentExecutionConfig.mock.calls[1]!;
    expect(serializeExecutionEnvironmentForStorage(second.environment)).toBe(
      serializeExecutionEnvironmentForStorage(first.environment),
    );
  });
});
