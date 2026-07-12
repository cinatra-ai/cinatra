import { describe, it, expect, vi } from "vitest";

// #1214 — the in-admin CMS content-editor agent set is DATA-DRIVEN from the
// `relayAgentPackage` bindings (core→extension instance-coupling ban: no
// extension package is named in host code), derived from the widget-stream
// UNION (widget-stream runtime trust, slice 2): the generated build-time map ∪
// the approved-and-serve-time-verified runtime metadata grants — NEVER the raw
// on-disk manifest. This proves: build membership is unchanged; an approved +
// fully-verified runtime grant contributes its relay target; an unapproved /
// hash-drifted / unverifiable one contributes nothing; a runtime-arm failure
// leaves the build-time set undisturbed (fail closed on the runtime arm only).

vi.mock("@/lib/generated/extensions.server", () => ({
  GENERATED_WIDGET_STREAM_AGENTS: {
    "wordpress-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/wordpress-mcp-connector",
      factory: "createWordPressWidgetChatTool",
      label: "WordPress",
      subjectNoun: "post",
      skillCapability: "widget-chat.wordpress-content-editor",
      relayAgentPackage: "@cinatra-ai/wordpress-agent",
      contextFields: [],
      auth: {},
    },
    "drupal-content-editor": {
      load: async () => ({}),
      packageName: "@cinatra-ai/drupal-mcp-connector",
      factory: "createDrupalWidgetChatTool",
      label: "Drupal",
      subjectNoun: "node",
      skillCapability: "widget-chat.drupal-content-editor",
      relayAgentPackage: "@cinatra-ai/drupal-agent",
      contextFields: [],
      auth: {},
    },
    // A widget-stream entry WITHOUT a relayAgentPackage — the host runs the
    // LLM itself (no relay agent), so it contributes no content-editor package.
    "acme-widget": {
      load: async () => ({}),
      packageName: "@cinatra-ai/acme-connector",
      factory: "createAcmeWidgetChatTool",
      label: "Acme",
      subjectNoun: "thing",
      skillCapability: "widget-chat.acme-widget",
      contextFields: [],
      auth: {},
    },
  },
}));

import {
  inAdminCmsContentEditorAgentPackages,
  isInAdminCmsContentEditorPackage,
  type WidgetStreamRuntimeResolveDeps,
} from "@/lib/widget-stream-agents.server";
import {
  canonicalJsonStringify,
  computeWidgetStreamBindingHashV2,
  type WidgetStreamMetadataCanonV2,
  type WidgetStreamMetadataGrantClaim,
} from "@/lib/extension-capability-ownership-grants";

const RUNTIME_PKG = "@cinatra-ai/newcms-connector";
const RUNTIME_SLUG = "newcms-content-editor";
const RUNTIME_RELAY = "@cinatra-ai/newcms-agent";
const RUNTIME_TOKEN_KEY = "newcms_widget_auth";
const DIGEST = "c".repeat(64);

function runtimeCanon(): WidgetStreamMetadataCanonV2 {
  return {
    v: 2,
    agentSlug: RUNTIME_SLUG,
    packageName: RUNTIME_PKG,
    moduleExportKey: "./widget-chat-tool",
    factory: "createNewCmsWidgetChatTool",
    relayAgentPackage: RUNTIME_RELAY,
    skillCapability: `widget-chat.${RUNTIME_SLUG}`,
    contextFields: [{ key: "postId", maxLength: 32 }],
    label: "NewCMS",
    subjectNoun: "post",
    auth: {
      tokenConfigKey: RUNTIME_TOKEN_KEY,
      instancesConfigKey: "newcms",
      requiredInstanceFields: ["id", "name"],
      requireUserToken: true,
    },
  };
}

function runtimeClaim(canon = runtimeCanon()): WidgetStreamMetadataGrantClaim {
  return {
    agentSlug: canon.agentSlug,
    packageName: canon.packageName,
    canon,
    canonJson: canonicalJsonStringify(canon),
    bindingHashV2: computeWidgetStreamBindingHashV2(canon),
  };
}

type Row = {
  id: string;
  package_name: string;
  org_id: string | null;
  agent_slug: string;
  binding_hash_v2: string;
  canon_json: string;
  status: string;
  approved_by: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  row_version: number;
};

function approvedRow(claim = runtimeClaim(), overrides?: Partial<Row>): Row {
  return {
    id: "g-1",
    package_name: claim.packageName,
    org_id: null,
    agent_slug: claim.agentSlug,
    binding_hash_v2: claim.bindingHashV2,
    canon_json: claim.canonJson,
    status: "approved",
    approved_by: "admin-1",
    revoked_by: null,
    revoked_at: null,
    row_version: 1,
    ...overrides,
  };
}

function depsFor(input: {
  rows: Row[];
  claims?: WidgetStreamMetadataGrantClaim[];
  owner?: string | null;
  signed?: Set<string>;
}): WidgetStreamRuntimeResolveDeps {
  const signed = input.signed ?? new Set([RUNTIME_PKG, RUNTIME_RELAY]);
  return {
    metadataGrantDeps: {
      query: async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
        if (text.includes("ORDER BY agent_slug")) {
          return input.rows.filter((r) => r.org_id === null && r.status === "approved") as T[];
        }
        if (text.includes("agent_slug = $1 AND org_id IS NULL AND status = 'approved'")) {
          return input.rows
            .filter(
              (r) =>
                r.agent_slug === values?.[0] && r.org_id === null && r.status === "approved",
            )
            .slice(0, 2) as T[];
        }
        if (text.includes("package_name = $1 AND agent_slug = $2")) {
          return input.rows
            .filter((r) => r.package_name === values?.[0] && r.agent_slug === values?.[1])
            .slice(0, 1) as T[];
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
    },
    ownershipGrantDeps: {
      query: async <T>(text: string, values?: readonly unknown[]): Promise<T[]> => {
        if (text.includes("token_config_key = $1")) {
          const owner = input.owner === undefined ? RUNTIME_PKG : input.owner;
          return (owner && values?.[0] === RUNTIME_TOKEN_KEY
            ? [{ package_name: owner }]
            : []) as T[];
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
    },
    isSignedActivated: (pkg) => signed.has(pkg),
    resolveInstallAnchor: async () => ({
      integrity: "sha512-trusted",
      contentHash: "trusted-content-hash",
      registryUrl: null,
      digest: DIGEST,
      kind: "connector",
    }),
    resolveVerifiedStoreDir: async () => ({ storeDir: "/data/x/" + DIGEST, digest: DIGEST }),
    readClaimsFromStore: async () => input.claims ?? [runtimeClaim()],
  };
}

describe("in-admin CMS content-editor package resolution (#1214, union-derived)", () => {
  it("derives the build-time set from the generated relayAgentPackage bindings", async () => {
    const set = await inAdminCmsContentEditorAgentPackages(depsFor({ rows: [] }));
    expect([...set].sort()).toEqual([
      "@cinatra-ai/drupal-agent",
      "@cinatra-ai/wordpress-agent",
    ]);
    // The relay-less widget-stream entry contributes no content-editor package.
    expect(set.has("@cinatra-ai/acme-connector")).toBe(false);
  });

  it("recognises the build relay-target agent packages as content editors", async () => {
    const deps = depsFor({ rows: [] });
    expect(await isInAdminCmsContentEditorPackage("@cinatra-ai/wordpress-agent", deps)).toBe(
      true,
    );
    expect(await isInAdminCmsContentEditorPackage("@cinatra-ai/drupal-agent", deps)).toBe(true);
  });

  it("includes an APPROVED + fully-serve-time-verified runtime relay target", async () => {
    const deps = depsFor({ rows: [approvedRow()] });
    const set = await inAdminCmsContentEditorAgentPackages(deps);
    expect(set.has(RUNTIME_RELAY)).toBe(true);
    expect(await isInAdminCmsContentEditorPackage(RUNTIME_RELAY, deps)).toBe(true);
  });

  it("excludes an unapproved (pending/revoked) runtime relay target", async () => {
    for (const status of ["pending", "revoked"]) {
      const deps = depsFor({ rows: [approvedRow(runtimeClaim(), { status })] });
      expect(await isInAdminCmsContentEditorPackage(RUNTIME_RELAY, deps)).toBe(false);
    }
  });

  it("excludes a runtime grant that fails serve-time verification (hash drift / de-signed / lost conjunction)", async () => {
    const drifted = runtimeCanon();
    drifted.label = "NewCMS EDITED";
    expect(
      await isInAdminCmsContentEditorPackage(
        RUNTIME_RELAY,
        depsFor({ rows: [approvedRow()], claims: [runtimeClaim(drifted)] }),
      ),
    ).toBe(false);
    expect(
      await isInAdminCmsContentEditorPackage(
        RUNTIME_RELAY,
        depsFor({ rows: [approvedRow()], signed: new Set([RUNTIME_RELAY]) }),
      ),
    ).toBe(false);
    expect(
      await isInAdminCmsContentEditorPackage(
        RUNTIME_RELAY,
        depsFor({ rows: [approvedRow()], owner: "@cinatra-ai/other-connector" }),
      ),
    ).toBe(false);
  });

  it("a build-colliding runtime row contributes nothing (build wins)", async () => {
    const canon = runtimeCanon();
    canon.agentSlug = "wordpress-content-editor"; // collides with the build map
    canon.skillCapability = "widget-chat.wordpress-content-editor"; // own-namespace rule
    canon.relayAgentPackage = "@cinatra-ai/evil-agent";
    const claim = runtimeClaim(canon);
    const deps = depsFor({ rows: [approvedRow(claim)], claims: [claim] });
    const set = await inAdminCmsContentEditorAgentPackages(deps);
    expect(set.has("@cinatra-ai/evil-agent")).toBe(false);
    expect(set.has("@cinatra-ai/wordpress-agent")).toBe(true); // the build binding
  });

  it("a runtime-arm enumeration failure leaves the build-time set undisturbed", async () => {
    const deps = depsFor({ rows: [] });
    deps.metadataGrantDeps = {
      query: async () => {
        throw new Error("db down");
      },
    };
    const set = await inAdminCmsContentEditorAgentPackages(deps);
    expect([...set].sort()).toEqual([
      "@cinatra-ai/drupal-agent",
      "@cinatra-ai/wordpress-agent",
    ]);
  });

  it("fails closed for any other / absent / malformed package", async () => {
    const deps = depsFor({ rows: [] });
    for (const pkg of [
      "@cinatra-ai/apollo-prospecting-agent",
      "@cinatra-ai/wordpress-mcp-connector", // the connector, not the relay agent
      "@cinatra-ai/acme-connector", // relay-less widget's connector
      "wordpress-agent", // unscoped — not the real package name
      "",
      null,
      undefined,
    ]) {
      expect(await isInAdminCmsContentEditorPackage(pkg, deps)).toBe(false);
    }
  });
});
