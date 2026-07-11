import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit tests for the project INSTANTIATION primitive (cinatra#1032
// deliverable 3). The instance store and the installed-payload resolvers are
// mocked; the POLICY layers run REAL: template validation + the exact-match
// worker-ref rule (via the real contract), the PM-seat consumes predicate
// (real manifests), the four-branch provider selection, and the sticky/drift
// predicate. Proven here:
//   - the PM-SEAT kind gate: only a pm-work-store-bound agent can own a
//     project template (unresolvable manifest / missing / optional binding
//     all refuse, fail-closed);
//   - provider selection wiring: all four branches + blank configured id;
//   - stickiness: re-instantiation is idempotent; template/seat/provider
//     drift refuses LOUDLY; a lost creation race converges.

const mocks = vi.hoisted(() => ({
  createProjectInstance: vi.fn(),
  readProjectInstance: vi.fn(),
  resolveInstalledAgentManifest: vi.fn(),
  resolveInstalledProjectTemplate: vi.fn(),
  listPmWorkStores: vi.fn(() => [] as Array<{ providerId: string }>),
}));

vi.mock("@cinatra-ai/agents/project-instance-store", () => ({
  createProjectInstance: mocks.createProjectInstance,
  readProjectInstance: mocks.readProjectInstance,
}));
vi.mock("@/lib/project-template-resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-template-resolve")>();
  return {
    ...actual,
    resolveInstalledAgentManifest: mocks.resolveInstalledAgentManifest,
    resolveInstalledProjectTemplate: mocks.resolveInstalledProjectTemplate,
  };
});
// Mock ONLY the registry read (listPmWorkStores); the selection policy and
// the persisted-provider seam run real.
vi.mock("@cinatra-ai/sdk-extensions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/sdk-extensions")>();
  return { ...actual, listPmWorkStores: mocks.listPmWorkStores };
});

import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  type ProjectTemplate,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { instantiateProject } from "@/lib/project-instantiation";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";
const TEMPLATE_PKG = "@cinatra-ai/release-announcement-agent";
const PM_PKG = "@cinatra-ai/project-manager-agent";

const template: ProjectTemplate = {
  formatVersion: PROJECT_TEMPLATE_FORMAT_VERSION,
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      worker: {
        role: "draft-writer",
        packageName: WORKER_PKG,
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    },
  ],
};

/** The template package's manifest, with the worker declared as a REAL
 *  cinatra.dependencies edge — judged by the real exact-match rule. */
const templateManifest = (edges: unknown[] = [
  {
    packageName: WORKER_PKG,
    kind: "agent",
    edgeType: "runtime",
    versionConstraint: { kind: "exact", version: "1.0.0" },
    requirement: "required",
  },
]) => ({ name: TEMPLATE_PKG, cinatra: { dependencies: edges } });

const pmSeatManifest = (consumes: unknown = [
  { primitive: "pm-work-store", requirement: "required" },
]) => ({
  manifest: { name: PM_PKG, cinatra: { consumes } },
  storeDir: "/store/pm",
  digest: "digest-pm",
});

const persisted = (over: Partial<Record<string, unknown>> = {}) => ({
  orgId: "org-A",
  projectRef: "proj-1",
  projectId: null,
  templatePackage: TEMPLATE_PKG,
  templateId: "launch-plan",
  templateDigest: "digest-t",
  pmAgentPackage: PM_PKG,
  providerId: "plane",
  providerMode: "auto",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const baseInput = () => ({
  orgId: "org-A",
  projectRef: "proj-1",
  templatePackage: TEMPLATE_PKG,
  pmAgentPackage: PM_PKG,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readProjectInstance.mockResolvedValue(null);
  mocks.createProjectInstance.mockImplementation(async (input: Record<string, unknown>) => ({
    created: true,
    instance: persisted(input),
  }));
  mocks.resolveInstalledProjectTemplate.mockResolvedValue({
    ok: true,
    template,
    digest: "digest-t",
    manifest: templateManifest(),
  });
  mocks.resolveInstalledAgentManifest.mockResolvedValue(pmSeatManifest());
  mocks.listPmWorkStores.mockReturnValue([{ providerId: "plane" }]);
});

describe("PM-seat kind gate (fail-closed)", () => {
  it("instantiates when the seat declares the required pm-work-store binding", async () => {
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({
      status: "instantiated",
      instance: { pmAgentPackage: PM_PKG, providerId: "plane", providerMode: "auto" },
    });
  });

  it("refuses a seat with NO consumes declaration", async () => {
    mocks.resolveInstalledAgentManifest.mockResolvedValue({
      manifest: { name: PM_PKG, cinatra: {} },
      storeDir: "/store/pm",
      digest: "d",
    });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
    expect(mocks.createProjectInstance).not.toHaveBeenCalled();
  });

  it("refuses an OPTIONAL pm-work-store declaration (optional does not confer the seat)", async () => {
    mocks.resolveInstalledAgentManifest.mockResolvedValue(
      pmSeatManifest([{ primitive: "pm-work-store", requirement: "optional" }]),
    );
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });

  it("refuses fail-closed when the seat manifest is unresolvable", async () => {
    mocks.resolveInstalledAgentManifest.mockResolvedValue(null);
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });

  it("refuses a MALFORMED consumes block fail-closed (the parser is fail-loud; the seat is not conferred)", async () => {
    mocks.resolveInstalledAgentManifest.mockResolvedValue(
      pmSeatManifest(null), // explicit null is malformed by the consumes contract
    );
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "NOT_PM_SEAT" });
  });
});

describe("template authority (installed bytes, real contract)", () => {
  it("refuses when the template package is not installed", async () => {
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: false, reason: "not_installed" });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "TEMPLATE_UNRESOLVED" });
  });

  it("refuses when the installed package ships no template", async () => {
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({ ok: false, reason: "no_template" });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "TEMPLATE_UNRESOLVED" });
  });

  it("refuses an installed-but-invalid template", async () => {
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: false,
      reason: "template_invalid",
      detail: "[bad_task_id] tasks[0].id",
    });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "TEMPLATE_INVALID" });
  });

  it("re-asserts the exact-match worker-ref rule against the installed manifest (real rule)", async () => {
    // Same worker package, but the manifest edge pins a DIFFERENT version.
    mocks.resolveInstalledProjectTemplate.mockResolvedValue({
      ok: true,
      template,
      digest: "digest-t",
      manifest: templateManifest([
        {
          packageName: WORKER_PKG,
          kind: "agent",
          edgeType: "runtime",
          versionConstraint: { kind: "exact", version: "9.9.9" },
          requirement: "required",
        },
      ]),
    });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "TEMPLATE_INVALID" });
    expect(mocks.createProjectInstance).not.toHaveBeenCalled();
  });
});

describe("provider selection wiring (four branches, fail-closed)", () => {
  it("configured wins over auto when several are connected", async () => {
    mocks.listPmWorkStores.mockReturnValue([{ providerId: "plane" }, { providerId: "github" }]);
    const out = await instantiateProject({ ...baseInput(), configuredProviderId: "github" });
    expect(out).toMatchObject({
      status: "instantiated",
      instance: { providerId: "github", providerMode: "configured" },
    });
  });

  it("fails closed when the configured provider is not connected", async () => {
    const out = await instantiateProject({ ...baseInput(), configuredProviderId: "jira" });
    expect(out).toMatchObject({ status: "rejected", code: "PROVIDER_CONFIGURED_NOT_CONNECTED" });
    expect(mocks.createProjectInstance).not.toHaveBeenCalled();
  });

  it("fails closed when NO provider is connected", async () => {
    mocks.listPmWorkStores.mockReturnValue([]);
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "PROVIDER_NONE_CONNECTED" });
  });

  it("fails closed (never guesses) when SEVERAL providers are connected and none is configured", async () => {
    mocks.listPmWorkStores.mockReturnValue([{ providerId: "plane" }, { providerId: "github" }]);
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "PROVIDER_AMBIGUOUS" });
  });

  it("rejects a blank configured provider id as INVALID_INPUT", async () => {
    const out = await instantiateProject({ ...baseInput(), configuredProviderId: "  " });
    expect(out).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
  });
});

describe("stickiness (a project never silently migrates)", () => {
  it("re-instantiation with the same binding is idempotent (already_instantiated)", async () => {
    mocks.readProjectInstance.mockResolvedValue(persisted());
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "already_instantiated", instance: { providerId: "plane" } });
    expect(mocks.createProjectInstance).not.toHaveBeenCalled();
  });

  it("an AUTO re-instantiation converges onto the persisted provider even when the connected set changed", async () => {
    mocks.readProjectInstance.mockResolvedValue(persisted({ providerId: "plane" }));
    // Today a different provider would win auto-selection — stickiness ignores that.
    mocks.listPmWorkStores.mockReturnValue([{ providerId: "github" }]);
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "already_instantiated", instance: { providerId: "plane" } });
  });

  it("REFUSES loudly when a configured provider differs from the persisted one (INSTANCE_DRIFT)", async () => {
    mocks.readProjectInstance.mockResolvedValue(persisted({ providerId: "plane" }));
    const out = await instantiateProject({ ...baseInput(), configuredProviderId: "github" });
    expect(out).toMatchObject({ status: "rejected", code: "INSTANCE_DRIFT" });
  });

  it("REFUSES a different template package / template id / seat under the same project ref", async () => {
    mocks.readProjectInstance.mockResolvedValue(persisted({ templatePackage: "@cinatra-ai/other" }));
    expect(await instantiateProject(baseInput())).toMatchObject({
      status: "rejected",
      code: "INSTANCE_DRIFT",
    });

    mocks.readProjectInstance.mockResolvedValue(persisted({ templateId: "other-template" }));
    expect(await instantiateProject(baseInput())).toMatchObject({
      status: "rejected",
      code: "INSTANCE_DRIFT",
    });

    mocks.readProjectInstance.mockResolvedValue(persisted({ pmAgentPackage: "@cinatra-ai/rogue" }));
    expect(await instantiateProject(baseInput())).toMatchObject({
      status: "rejected",
      code: "INSTANCE_DRIFT",
    });
  });

  it("a LOST creation race converges through the drift predicate (matching row → already_instantiated)", async () => {
    mocks.createProjectInstance.mockResolvedValue({ created: false, instance: persisted() });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "already_instantiated" });
  });

  it("a LOST creation race with a DIFFERENT persisted binding refuses (INSTANCE_DRIFT)", async () => {
    mocks.createProjectInstance.mockResolvedValue({
      created: false,
      instance: persisted({ pmAgentPackage: "@cinatra-ai/rogue" }),
    });
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "rejected", code: "INSTANCE_DRIFT" });
  });
});

describe("contract hygiene", () => {
  it("rejects blank identity inputs", async () => {
    for (const patch of [{ orgId: " " }, { projectRef: "" }, { templatePackage: " " }, { pmAgentPackage: "" }]) {
      const out = await instantiateProject({ ...baseInput(), ...patch });
      expect(out).toMatchObject({ status: "rejected", code: "INVALID_INPUT" });
    }
    expect(mocks.resolveInstalledProjectTemplate).not.toHaveBeenCalled();
  });

  it("never throws — a store failure resolves to the structured catch-all", async () => {
    mocks.createProjectInstance.mockRejectedValue(new Error("db down"));
    const out = await instantiateProject(baseInput());
    expect(out).toMatchObject({ status: "failed", code: "PROJECT_INSTANTIATION_FAILED" });
  });
});
