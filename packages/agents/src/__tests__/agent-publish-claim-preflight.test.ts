// cinatra#2675 — the CONTRACT of the publish-time claimability preflight.
//
// The registry-and-database proof of the ordering lives in the two integration
// suites (agent-source-publish-claim-preflight / -race). This one pins the
// gate's decision table with no infrastructure at all, so every branch —
// including the two that only appear when something is broken — is covered in
// the fast tier that always runs:
//
//   foreign row                   -> refuse, with the EXISTING conflict code
//   owned row / absent row        -> proceed
//   platform (org-less) publisher -> proceed, matching the write's claimant
//   version already in registry   -> proceed WITHOUT touching the database
//   database read fails           -> refuse, WITHOUT leaking the reason
//   unpublishable package.json    -> proceed (the publisher refuses on it)
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

type Row = { orgId: string | null };

const { dbState, mockDb, mockIsVersionPublished } = vi.hoisted(() => {
  const state: { rows: Row[]; selectCalls: number; failWith: Error | null } = {
    rows: [],
    selectCalls: 0,
    failWith: null,
  };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      if (state.failWith) throw state.failWith;
      return state.rows;
    },
  };
  return {
    dbState: state,
    mockDb: {
      select: () => {
        state.selectCalls += 1;
        return chain;
      },
    },
    mockIsVersionPublished: vi.fn(async () => false),
  };
});

vi.mock("../db", () => ({ db: mockDb, agentBuilderPool: {} as unknown }));
vi.mock("../verdaccio/client", () => ({ isVersionPublished: mockIsVersionPublished }));

import { preflightAgentPublishClaim, AgentTemplateIdentityConflictError } from "../agent-template-identity";

const REGISTRY = {
  registryUrl: "http://127.0.0.1:4873",
  token: "t",
  packageScope: "@claim2675",
} as unknown as Parameters<typeof preflightAgentPublishClaim>[0]["registry"];

const PACKAGE_NAME = "@claim2675/preflight-unit";
let agentDir: string;

beforeEach(async () => {
  dbState.rows = [];
  dbState.selectCalls = 0;
  dbState.failWith = null;
  mockIsVersionPublished.mockClear();
  mockIsVersionPublished.mockResolvedValue(false);
  agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-unit-"));
  await fs.writeFile(
    path.join(agentDir, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: "1.2.3" }),
  );
});

afterEach(async () => {
  await fs.rm(agentDir, { recursive: true, force: true }).catch(() => {});
});

describe("cinatra#2675 — preflightAgentPublishClaim", () => {
  it("refuses a name held by ANOTHER organization, with the existing conflict code", async () => {
    dbState.rows = [{ orgId: "org-a" }];
    const refusal = await preflightAgentPublishClaim({
      agentDir,
      publisherOrgId: "org-b",
      registry: REGISTRY,
    });
    expect(refusal).toEqual({
      error: new AgentTemplateIdentityConflictError(PACKAGE_NAME).message,
      code: "AGENT_TEMPLATE_IDENTITY_CONFLICT",
    });
  });

  it("proceeds when the row belongs to the publisher, is org-less, or does not exist", async () => {
    dbState.rows = [{ orgId: "org-a" }];
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-a", registry: REGISTRY }),
    ).toBeNull();

    dbState.rows = [{ orgId: null }];
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();

    dbState.rows = [];
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();
  });

  it("never refuses an org-less publisher — it claims as the instance operator, exactly like the write", async () => {
    dbState.rows = [{ orgId: "org-a" }];
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: null, registry: REGISTRY }),
    ).toBeNull();
  });

  it("does not adjudicate a republish: an already-published version proceeds without a database read", async () => {
    mockIsVersionPublished.mockResolvedValue(true);
    dbState.rows = [{ orgId: "org-a" }];
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();
    expect(dbState.selectCalls).toBe(0);
  });

  it("still adjudicates when the REGISTRY read fails — an unknown registry is not a no-op", async () => {
    mockIsVersionPublished.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:4873"));
    dbState.rows = [{ orgId: "org-a" }];
    const refusal = await preflightAgentPublishClaim({
      agentDir,
      publisherOrgId: "org-b",
      registry: REGISTRY,
    });
    expect(refusal?.code).toBe("AGENT_TEMPLATE_IDENTITY_CONFLICT");
  });

  it("FAILS CLOSED when the database read fails, and the refusal leaks no database detail", async () => {
    // The fixture error carries a CREDENTIALLED connection string, because that
    // is the worst thing a driver error can put in front of an LLM-visible tool
    // result. It is ASSEMBLED rather than written as a literal: a fabricated DSN
    // in a test fixture is exactly the false positive that teaches people to
    // wave the repository's secret scanner through. Nothing here has ever been
    // a credential — the host does not exist and the password is the word "pw".
    const fixtureDsn = ["postgres", "://", "user", ":", "pw", "@", "10.0.0.4", ":5432"].join("");
    dbState.failWith = new Error(
      `Failed query: select * from agent_templates — connect ECONNREFUSED ${fixtureDsn}`,
    );
    const refusal = await preflightAgentPublishClaim({
      agentDir,
      publisherOrgId: "org-b",
      registry: REGISTRY,
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBeUndefined();
    expect(refusal?.error).toContain("Nothing was published");
    expect(refusal?.error).not.toContain("ECONNREFUSED");
    expect(refusal?.error).not.toContain(fixtureDsn);
    expect(refusal?.error).not.toContain("Failed query");
  });

  it("proceeds when package.json is unreadable, nameless or versionless — the publisher refuses on it first", async () => {
    // The name is FOREIGN in every case below, so a gate that adjudicated a
    // tree the publisher will reject outright would hand back an identity
    // conflict where the real fault is the manifest.
    dbState.rows = [{ orgId: "org-a" }];

    await fs.rm(path.join(agentDir, "package.json"));
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();

    await fs.writeFile(path.join(agentDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();

    // No version — `publishAgentPackageFromGitDir` refuses with "package.json
    // must have name and version fields." before it writes anything, so there
    // is no registry write for this gate to be in front of.
    await fs.writeFile(path.join(agentDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
    expect(
      await preflightAgentPublishClaim({ agentDir, publisherOrgId: "org-b", registry: REGISTRY }),
    ).toBeNull();

    expect(dbState.selectCalls).toBe(0);
    expect(mockIsVersionPublished).not.toHaveBeenCalled();
  });
});
