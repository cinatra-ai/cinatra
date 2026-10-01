/**
 * THE CONNECTOR ROUTE'S SERVER-RENDERED TITLE (cinatra#3235, acceptance 7).
 *
 * `generateMetadata` on the dispatch route returned the display name plus
 * " | Connectors" INSIDE the root layout's `"%s | Cinatra"` template, so the
 * effective server-rendered title carried a doubled suffix before the client
 * effect overwrote it; and it resolved through the static catalog ALONE, so a
 * trusted runtime-only connector — one the page itself renders through the
 * runtime card record — was titled "Not found" on a page that is not a
 * not-found page.
 *
 * Both halves are locked here on the REAL `generateMetadata` export of the
 * route module: the title it returns is composed against the root template
 * this repository's own layout declares (bare display name in, exactly one
 * " | Cinatra" out), and it is resolved by the SAME resolver the page body
 * asks, fail-closed on every refusal the body refuses. The page BODY is an
 * async server component that cannot be rendered in this tier, so the one
 * claim about the body — that it asks that same resolver, and that it
 * publishes the route's own four-segment crumb prefix — is locked as a SOURCE
 * claim, as the route's other composition contract is
 * (`connector-crumb-contributions.test.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getConnectorRegistryEntryBySlug = vi.fn();
const enforceConnectorPolicy = vi.fn();
const resolveRuntimeConnectorCardRecord = vi.fn();

// PARTIAL mocks: this route's graph pulls the readiness-probe registry, the
// extension host wiring and the server-action bridge as side-effect imports,
// and those modules read OTHER exports of the same files at import time. Only
// the three seams this route's identity resolution actually consults are
// replaced; everything else stays real.
vi.mock("@/lib/auth-session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getActorContext: async () => undefined,
}));
vi.mock("@/lib/connectors-registry.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConnectorRegistryEntryBySlug: (slug: string) =>
    getConnectorRegistryEntryBySlug(slug),
}));
vi.mock("@/lib/connector-policy", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enforceConnectorPolicy: (...args: unknown[]) => enforceConnectorPolicy(...args),
}));
vi.mock("@/lib/extension-install-resolution", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveRuntimeConnectorCardRecord: (...args: unknown[]) =>
    resolveRuntimeConnectorCardRecord(...args),
}));

import { generateMetadata } from "@/app/connectors/[vendor]/[slug]/[subroute]/page";
import { CONNECTOR_ROUTE_NOT_FOUND_TITLE } from "@/lib/connector-route-identity.server";
import { resolveConnectorRouteIdentity } from "@/lib/connector-route-identity.server";

const ROUTE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const LAYOUT = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "layout.tsx"),
  "utf8",
);

/** The ROOT template, read from the layout that actually declares it. */
const ROOT_TITLE_TEMPLATE = (() => {
  const match = LAYOUT.match(/template:\s*"([^"]+)"/);
  if (!match) throw new Error("the root layout declares no title template");
  return match[1];
})();

/**
 * The title a reader's tab actually shows for this route: what the route's own
 * `generateMetadata` returns, composed by the root template that wraps it.
 */
const effectiveTitleFor = async (params: {
  vendor: string;
  slug: string;
  subroute: string;
}) => {
  const metadata = await generateMetadata({ params: Promise.resolve(params) });
  const title = metadata.title;
  if (typeof title !== "string") {
    throw new Error(`the route returned a non-string title: ${String(title)}`);
  }
  return ROOT_TITLE_TEMPLATE.replace("%s", title);
};

const NOT_FOUND_TITLE = `${CONNECTOR_ROUTE_NOT_FOUND_TITLE} | Cinatra`;

const CATALOG_ENTRY = {
  packageId: "@cinatra-ai/openai-connector",
  slug: "openai-connector",
  vendor: "cinatra-ai",
  setupSubroute: "setup",
  displayName: "OpenAI",
};

const RUNTIME_CARD = {
  packageName: "@cinatra-ai/google-appointment-schedules-connector",
  vendor: "cinatra-ai",
  slug: "google-appointment-schedules-connector",
  displayName: "Google Appointment Schedules",
};

beforeEach(() => {
  getConnectorRegistryEntryBySlug.mockReturnValue(undefined);
  enforceConnectorPolicy.mockReturnValue({ allowed: true });
  resolveRuntimeConnectorCardRecord.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cinatra#3235 — the connector route's effective rendered title", () => {
  it("titles a catalog connector with its display name and ONE suffix", async () => {
    getConnectorRegistryEntryBySlug.mockReturnValue(CATALOG_ENTRY);
    const title = await effectiveTitleFor({
      vendor: "cinatra-ai",
      slug: "openai-connector",
      subroute: "setup",
    });
    expect(title).toBe("OpenAI | Cinatra");
    expect(title).not.toContain("| Connectors");
    expect(title.match(/ \| Cinatra/g)).toHaveLength(1);
    // The route hands the template a BARE name — the composition is the root's.
    const metadata = await generateMetadata({
      params: Promise.resolve({
        vendor: "cinatra-ai",
        slug: "openai-connector",
        subroute: "setup",
      }),
    });
    expect(metadata.title).toBe("OpenAI");
  });

  it("titles a TRUSTED RUNTIME-ONLY connector with its display name", async () => {
    resolveRuntimeConnectorCardRecord.mockResolvedValue(RUNTIME_CARD);
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "google-appointment-schedules-connector",
        subroute: "setup",
      }),
    ).toBe("Google Appointment Schedules | Cinatra");
  });

  it("fails closed on a wrong vendor", async () => {
    getConnectorRegistryEntryBySlug.mockReturnValue(CATALOG_ENTRY);
    expect(
      await effectiveTitleFor({
        vendor: "someone-else",
        slug: "openai-connector",
        subroute: "setup",
      }),
    ).toBe(NOT_FOUND_TITLE);
  });

  it("fails closed on an unknown slug", async () => {
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "no-such-connector",
        subroute: "setup",
      }),
    ).toBe(NOT_FOUND_TITLE);
  });

  it("fails closed on a non-canonical subroute, catalog and runtime alike", async () => {
    getConnectorRegistryEntryBySlug.mockReturnValue(CATALOG_ENTRY);
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "openai-connector",
        subroute: "configure",
      }),
    ).toBe(NOT_FOUND_TITLE);

    getConnectorRegistryEntryBySlug.mockReturnValue(undefined);
    resolveRuntimeConnectorCardRecord.mockResolvedValue(RUNTIME_CARD);
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "google-appointment-schedules-connector",
        subroute: "configure",
      }),
    ).toBe(NOT_FOUND_TITLE);
  });

  it("fails closed where the catalog policy refuses the read", async () => {
    getConnectorRegistryEntryBySlug.mockReturnValue(CATALOG_ENTRY);
    enforceConnectorPolicy.mockReturnValue({ allowed: false, reason: "denied" });
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "openai-connector",
        subroute: "setup",
      }),
    ).toBe(NOT_FOUND_TITLE);
  });

  it("fails closed where the trusted runtime card names another vendor or slug", async () => {
    resolveRuntimeConnectorCardRecord.mockResolvedValue({
      ...RUNTIME_CARD,
      vendor: "someone-else",
    });
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "google-appointment-schedules-connector",
        subroute: "setup",
      }),
    ).toBe(NOT_FOUND_TITLE);

    resolveRuntimeConnectorCardRecord.mockResolvedValue({
      ...RUNTIME_CARD,
      slug: "another-connector",
    });
    expect(
      await effectiveTitleFor({
        vendor: "cinatra-ai",
        slug: "google-appointment-schedules-connector",
        subroute: "setup",
      }),
    ).toBe(NOT_FOUND_TITLE);
  });

  it("resolves the identity through the shared resolver, not a catalog-only read", async () => {
    // The runtime arm is reached at all only because the route asks the shared
    // resolver: a catalog-only metadata path never consults the card record.
    resolveRuntimeConnectorCardRecord.mockResolvedValue(RUNTIME_CARD);
    await effectiveTitleFor({
      vendor: "cinatra-ai",
      slug: "google-appointment-schedules-connector",
      subroute: "setup",
    });
    expect(resolveRuntimeConnectorCardRecord).toHaveBeenCalledWith(
      "@cinatra-ai/google-appointment-schedules-connector",
      undefined,
    );
  });

  it("marks ONLY the absent-runtime-install refusal for the marketplace redirect", async () => {
    const absent = await resolveConnectorRouteIdentity(
      { vendor: "cinatra-ai", slug: "no-such-connector", subroute: "setup" },
      undefined,
    );
    expect(absent).toEqual({ kind: "refused", considerMarketplaceRedirect: true });

    getConnectorRegistryEntryBySlug.mockReturnValue(CATALOG_ENTRY);
    const wrongVendor = await resolveConnectorRouteIdentity(
      { vendor: "someone-else", slug: "openai-connector", subroute: "setup" },
      undefined,
    );
    expect(wrongVendor).toEqual({ kind: "refused", considerMarketplaceRedirect: false });
  });
});

describe("cinatra#3235 — the page BODY asks that same resolution", () => {
  it("resolves the body's identity through the SAME resolver", () => {
    expect(ROOT_TITLE_TEMPLATE).toBe("%s | Cinatra");
    expect(ROUTE).toContain(
      'import {\n  connectorRouteTitle,\n  resolveConnectorRouteIdentity,\n} from "@/lib/connector-route-identity.server";',
    );
    // Two callers, one resolution: the metadata and the body.
    expect(ROUTE.match(/await resolveConnectorRouteIdentity\(/g)).toHaveLength(2);
    // The body still owns its own gates — the redirect decision and the 404.
    expect(ROUTE).toContain("considerMarketplaceRedirect");
    expect(ROUTE).toContain("redirect(redirectDecision.target)");
    expect(ROUTE).toContain("notFound();");
  });

  it("publishes the display name for the route's OWN four-segment path", () => {
    expect(ROUTE).toContain(
      "prefix: `/connectors/${encodeURIComponent(vendor)}/${encodeURIComponent(slug)}/${encodeURIComponent(subroute)}`",
    );
    // The same server-authorized label the connector crumb carries.
    expect(ROUTE.match(/label: displayName,/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
