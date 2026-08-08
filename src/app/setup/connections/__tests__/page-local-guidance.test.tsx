/**
 * cinatra#2501 — the Connections step must not dead-end a LOCAL install.
 *
 * Two defects, both pure copy/predicate on the server component:
 *  1. With `NANGO_SERVER_URL` set, the Server URL helper claimed "Leave blank
 *     to use the default hosted service". Blank actually KEEPS the
 *     env-configured server — the opposite of what it said. (Env-management
 *     says only that the value comes from the environment; it does not say the
 *     target is local, so the copy must not claim that either.)
 *  2. The Secret key field is required with no key on file and said nothing
 *     about where a key comes from. The bundled local Nango DOES have one:
 *     `FLAG_AUTH_ENABLED=false` disables its dashboard auth, not its API
 *     secret-key auth, and first boot seeds a real key for the `dev`
 *     environment (see scripts/ci/works-after/nango.sh).
 *
 * The requirement itself is deliberately UNCHANGED and is asserted here as a
 * regression fence: `getNangoStatus()` reports "connected" only for a non-empty
 * saved secret key, so an optional field would let an operator submit blank and
 * be bounced back to this step forever with no message at all.
 *
 * renderToStaticMarkup over the server component with the nango seam stubbed —
 * same convention as ../../key/__tests__/page-card-removal.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/app/campaigns/actions", () => ({
  saveNangoConnectionAction: vi.fn(),
}));
vi.mock("@/lib/setup-wizard", () => ({
  getSetupWizardSteps: vi.fn().mockResolvedValue([]),
  getFirstIncompleteStep: vi.fn().mockReturnValue(null),
}));

const getNangoStatus = vi.fn();
const getNangoSettings = vi.fn();
const getNangoSettingsEnvManaged = vi.fn();

vi.mock("@/lib/nango-system", () => ({
  getNangoStatus: () => getNangoStatus(),
  getNangoSettings: () => getNangoSettings(),
  getNangoSettingsEnvManaged: () => getNangoSettingsEnvManaged(),
}));

type Scenario = {
  envManaged?: { secretKey?: boolean; serverUrl?: boolean };
  settings?: { secretKey?: string; serverUrl?: string };
};

async function renderConnectionsPage(scenario: Scenario = {}): Promise<string> {
  getNangoStatus.mockReturnValue({ status: "not_connected", detail: "" });
  getNangoSettings.mockReturnValue(scenario.settings ?? {});
  getNangoSettingsEnvManaged.mockReturnValue({
    secretKey: scenario.envManaged?.secretKey ?? false,
    serverUrl: scenario.envManaged?.serverUrl ?? false,
  });
  const { default: SetupNangoPage } = await import("../page");
  return renderToStaticMarkup((await SetupNangoPage()) as ReactElement);
}

/** The one `required` attribute on the page belongs to the secret-key input. */
function secretKeyIsRequired(html: string): boolean {
  const field = html.match(/<input[^>]*name="secretKey"[^>]*>/)?.[0] ?? "";
  return /required/.test(field);
}

/**
 * The help text rendered immediately after the secret-key input, with tags
 * stripped. Asserting on the whole document would match Tailwind utility class
 * names (`placeholder:text-muted-foreground`) and the URL field's own
 * `placeholder` attribute — noise that has nothing to do with the copy.
 */
function secretKeyHelpText(html: string): string {
  const after = html.split(/<input[^>]*name="secretKey"[^>]*>/)[1] ?? "";
  let text = after.match(/<span[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
  // Strip to a fixpoint: a single pass can re-expose a tag assembled from the
  // removed fragments, which is also what CodeQL's multi-character-sanitization
  // rule flags.
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  }
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Server URL helper (cinatra#2501)", () => {
  it("does NOT claim blank means hosted when the URL is env-managed", async () => {
    const html = await renderConnectionsPage({ envManaged: { serverUrl: true } });
    expect(html).not.toContain("Leave blank to use the default hosted service");
    expect(html).toContain("NANGO_SERVER_URL");
    expect(html).toContain("leave blank to keep it");
    // ...and does not overclaim in the other direction either: an env-set URL
    // can perfectly well point at the hosted service.
    expect(html).not.toMatch(/self-hosted/i);
    expect(html).not.toContain("The hosted service is not used");
  });

  it("keeps the default-service wording when there is no env override", async () => {
    const html = await renderConnectionsPage({ envManaged: { serverUrl: false } });
    expect(html).toContain("Leave blank to use the default hosted service");
    expect(html).not.toContain("NANGO_SERVER_URL");
  });
});

describe("Secret key guidance (cinatra#2501)", () => {
  // The old page offered NOTHING here — the field was required with no help
  // text at all. It now names both sources of a REAL key.
  it("names the dashboard source and the local server's seeded key", async () => {
    const html = await renderConnectionsPage();
    expect(html).toContain("Environment Settings → Secret Key");
    expect(html).toContain("_nango_environments");
  });

  it("says the same thing whether or not the server URL is env-managed", async () => {
    // Env-management says nothing about WHICH Nango is targeted (an env var can
    // point at the hosted service), so it must not steer the key guidance.
    const envManagedHtml = await renderConnectionsPage({ envManaged: { serverUrl: true } });
    expect(envManagedHtml).toContain("Environment Settings → Secret Key");
    expect(envManagedHtml).toContain("_nango_environments");
  });

  it("NEVER tells the operator a made-up value will do", async () => {
    // `FLAG_AUTH_ENABLED=false` disables the bundled server's DASHBOARD auth,
    // not its API secret-key auth (scripts/ci/works-after/nango.sh says so
    // explicitly). A placeholder would complete the wizard and then 401 on
    // every Nango call — a falsely-configured install, worse than the dead end.
    for (const scenario of [{}, { envManaged: { serverUrl: true } }]) {
      const help = secretKeyHelpText(await renderConnectionsPage(scenario));
      expect(help).not.toMatch(/any value/i);
      expect(help).not.toMatch(/placeholder/i);
      expect(help).not.toMatch(/ignore[sd]?\b/i);
      expect(help).toContain("A made-up value is not accepted");
    }
  });

  it("keeps the rotate-or-keep wording when a key is already saved", async () => {
    const html = await renderConnectionsPage({
      envManaged: { serverUrl: true },
      settings: { secretKey: "already-saved" },
    });
    expect(html).toContain("Leave blank to keep the current saved key.");
    expect(html).not.toContain("_nango_environments");
  });
});

describe("Secret key requirement is intentionally unchanged (cinatra#2501)", () => {
  it("stays required with an env-managed server URL and no key on file", async () => {
    // Making it optional here would produce a SILENT dead end: a blank submit
    // saves nothing, getNangoStatus() stays "not_connected", and the wizard
    // routes straight back to this step.
    const html = await renderConnectionsPage({ envManaged: { serverUrl: true } });
    expect(secretKeyIsRequired(html)).toBe(true);
  });

  it("stays required with no server URL override and no key on file", async () => {
    expect(secretKeyIsRequired(await renderConnectionsPage())).toBe(true);
  });

  it("is NOT required once an env override supplies the key", async () => {
    const html = await renderConnectionsPage({ envManaged: { secretKey: true } });
    expect(secretKeyIsRequired(html)).toBe(false);
  });

  it("is NOT required once a key is saved in settings", async () => {
    const html = await renderConnectionsPage({ settings: { secretKey: "saved" } });
    expect(secretKeyIsRequired(html)).toBe(false);
  });
});
