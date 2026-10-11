import { isValidElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

const ports = vi.hoisted(() => ({
  catalog: vi.fn(), policy: vi.fn(), card: vi.fn(), redirect: vi.fn(), actor: vi.fn(),
}));
vi.mock("@/lib/auth-session", () => ({ getActorContext: ports.actor }));
vi.mock("@/lib/connectors-registry.server", () => ({
  getConnectorRegistryEntryBySlug: ports.catalog,
  resolveConnectorBadgeState: async () => ({ status: "not_connected", count: 0 }),
  hasConnectorReadinessProbe: () => false,
}));
vi.mock("@/lib/connector-policy", () => ({ enforceConnectorPolicy: ports.policy }));
vi.mock("@/lib/extension-install-resolution", () => ({
  resolveRuntimeConnectorCardRecord: ports.card,
  resolveRuntimeConnectorUiRecord: async () => null,
  resolveActiveInstallForActor: async () => null,
  resolveActiveInstallIdForActor: async () => null,
}));
vi.mock("@/lib/connector-setup-redirect", () => ({ resolveConnectorSetupRedirect: ports.redirect }));
vi.mock("@/lib/connector-readiness.server", () => ({}));
vi.mock("@/lib/connector-setup-action-references.server", () => ({}));
vi.mock("@/lib/extensions", () => ({}));
vi.mock("@/lib/extension-ui-registry", () => ({ resolveExtensionUiAction: vi.fn() }));
vi.mock("@/lib/extension-config-hydration", () => ({ resolveSchemaConfigInitialValues: vi.fn() }));
vi.mock("@/lib/extension-host-context", () => ({ createExtensionHostContext: vi.fn() }));
vi.mock("@/lib/generated/extensions.server", () => ({ STATIC_EXTENSION_MANIFEST: {} }));
vi.mock("@/lib/extension-load-guard", () => ({ isDegradedExtensionLoad: () => false }));
vi.mock("@/lib/extension-version-keyed-serving", () => ({ resolveVersionKeyedUiAction: vi.fn() }));
vi.mock("@/lib/extension-schema-config", () => ({ requiresRebuildState: () => ({ message: "Rebuild" }) }));
// Keep page identity, policy decisions, metadata and crumb publication real;
// use its existing error surface so rendering unrelated setup forms is unnecessary.
vi.mock("@/lib/connector-ui-render", () => ({ chooseConnectorUiRender: () => ({ kind: "invalid-schema-config" }) }));
vi.mock("@/lib/connector-readiness-action", () => ({ recheckConnectorReadiness: vi.fn() }));
vi.mock("@/components/extensions/schema-config-connector-setup", () => ({ SchemaConfigConnectorSetup: () => null }));
vi.mock("@/components/extensions/connector-status-probe-card", () => ({ ConnectorStatusProbeCard: () => null }));
vi.mock("@/components/extensions/connection-sharing-section", () => ({ ConnectionSharingSection: () => null }));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/page-content", () => ({ PageContent: () => null }));
vi.mock("@/components/layout/main", () => ({ Main: () => null }));
vi.mock("@cinatra-ai/sdk-ui/connector-setup-columns", () => ({ ConnectorSetupColumns: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (target: string) => { throw new Error(`REDIRECT:${target}`); },
}));

import Page, { generateMetadata } from "../page";
import { CrumbContributions } from "@/components/crumb-contributions";

const actor: ActorContext = { principalType: "HumanUser", principalId: "reader", authSource: "ui", policyVersion: "v2" };
const catalog = { packageId: "@cinatra-ai/openai-connector", vendor: "cinatra-ai", slug: "openai-connector", displayName: "OpenAI", setupSubroute: "setup" };
const runtime = { packageName: "@cinatra-ai/google-appointment-schedules-connector", vendor: "cinatra-ai", slug: "google-appointment-schedules-connector", displayName: "Google Appointment Schedules" };
const paramsFor = (entry = catalog, overrides: Partial<{ vendor: string; slug: string; subroute: string }> = {}) => ({ vendor: entry.vendor, slug: entry.slug, subroute: "setup", ...overrides });
const rootLayout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
const rootTemplate = rootLayout.match(/template:\s*"([^"]+)"/)![1];
async function titleFor(params: ReturnType<typeof paramsFor>) {
  const metadata = await generateMetadata({ params: Promise.resolve(params) });
  expect(typeof metadata.title).toBe("string");
  return rootTemplate.replace("%s", metadata.title as string);
}
function publishedEntries(node: ReactNode): Array<{ prefix: string; label: string }> {
  if (Array.isArray(node)) return node.flatMap(publishedEntries);
  if (!isValidElement<{ children?: ReactNode; entries?: Array<{ prefix: string; label: string }> }>(node)) return [];
  if (node.type === CrumbContributions) return node.props.entries ?? [];
  return publishedEntries(node.props.children);
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.actor.mockResolvedValue(actor);
  ports.catalog.mockReturnValue(catalog);
  ports.policy.mockReturnValue({ allowed: true });
  ports.card.mockResolvedValue(null);
  ports.redirect.mockResolvedValue({ kind: "not-found" });
});

describe("connector metadata and page share an authorized identity", () => {
  it("uses the root template once for a catalog connector", async () => {
    expect(await titleFor(paramsFor())).toBe("OpenAI | Cinatra");
    expect(ports.policy).toHaveBeenCalledWith(catalog.packageId, actor, "read");
    expect(ports.card).not.toHaveBeenCalled();
  });
  it("names a trusted runtime-only connector and publishes that same full-route label", async () => {
    ports.catalog.mockReturnValue(undefined);
    ports.card.mockResolvedValue(runtime);
    const params = { vendor: runtime.vendor, slug: runtime.slug, subroute: "setup" };
    expect(await titleFor(params)).toBe("Google Appointment Schedules | Cinatra");
    const page = await Page({ params: Promise.resolve(params) });
    expect(publishedEntries(page)).toContainEqual({ prefix: `/connectors/${params.vendor}/${params.slug}/setup`, label: runtime.displayName });
    expect(ports.card).toHaveBeenCalledWith(runtime.packageName, actor);
    expect(ports.policy).not.toHaveBeenCalled();
  });
  it("publishes the catalog name for the connector and its own four-segment route", async () => {
    const page = await Page({ params: Promise.resolve(paramsFor()) });
    expect(publishedEntries(page)).toContainEqual({ prefix: "/connectors/cinatra-ai/openai-connector", label: "OpenAI" });
    expect(publishedEntries(page)).toContainEqual({ prefix: "/connectors/cinatra-ai/openai-connector/setup", label: "OpenAI" });
  });
  it.each([
    ["wrong vendor", { vendor: "someone-else" }],
    ["non-canonical subroute", { subroute: "help" }],
  ])("refuses %s in metadata and page", async (_name, overrides) => {
    const params = paramsFor(catalog, overrides);
    expect(await titleFor(params)).toBe("Not found | Cinatra");
    await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
    expect(ports.policy).not.toHaveBeenCalled();
    expect(ports.card).not.toHaveBeenCalled();
    expect(ports.redirect).not.toHaveBeenCalled();
  });
  it("does not expose a catalog label when its read policy denies the actor", async () => {
    ports.policy.mockReturnValue({ allowed: false });
    expect(await titleFor(paramsFor())).toBe("Not found | Cinatra");
    await expect(Page({ params: Promise.resolve(paramsFor()) })).rejects.toThrow("NOT_FOUND");
    expect(ports.card).not.toHaveBeenCalled();
  });
  it("refuses an unknown slug and keeps marketplace redirection only in the page", async () => {
    ports.catalog.mockReturnValue(undefined);
    const params = paramsFor(catalog, { slug: "unknown" });
    expect(await titleFor(params)).toBe("Not found | Cinatra");
    expect(ports.redirect).not.toHaveBeenCalled();
    ports.redirect.mockResolvedValue({ kind: "redirect", target: "/marketplace/example" });
    await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow("REDIRECT:/marketplace/example");
  });
  it.each([{ vendor: "other-vendor" }, { slug: "other-connector" }])("refuses mismatched runtime identity %j", async (overrides) => {
    ports.catalog.mockReturnValue(undefined);
    ports.card.mockResolvedValue({ ...runtime, ...overrides });
    const params = { vendor: runtime.vendor, slug: runtime.slug, subroute: "setup" };
    expect(await titleFor(params)).toBe("Not found | Cinatra");
    await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
  });
  it("refuses a runtime-only connector's non-canonical subroute without a marketplace redirect", async () => {
    ports.catalog.mockReturnValue(undefined);
    ports.card.mockResolvedValue(runtime);
    const params = { vendor: runtime.vendor, slug: runtime.slug, subroute: "help" };
    expect(await titleFor(params)).toBe("Not found | Cinatra");
    await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
    expect(ports.redirect).not.toHaveBeenCalled();
  });
});
