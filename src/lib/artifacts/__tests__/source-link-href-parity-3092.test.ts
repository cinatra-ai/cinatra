import { describe, expect, it, vi } from "vitest";

// cinatra#3092 — ONE URL RULE FOR THE SOURCE LINK.
//
// The review card and the review island open a CMS page's address only when
// the canonical source-link rule would admit it: `safeHttpHref` in
// `artifact-service.ts`, applied by `connectorRefSourceUrl` to every "Open in
// source application" address. Neither of those client modules may load the
// artifact service, so they use its mirror `sourceLinkHref` in
// `@cinatra-ai/agent-ui-protocol/renderable-views`. This suite pins the mirror
// equal to the canonical rule over a table of cases, so the two cannot drift.
//
// The mirror is new with cinatra#3092; it is read off the module inside the
// test, so before the change the file still loads and the test fails.

vi.mock("@/lib/objects-store", () => ({ listObjectsByFilter: vi.fn(), getObjectById: vi.fn() }));
vi.mock("../artifact-retention", () => ({ tombstoneArtifact: vi.fn() }));
vi.mock("../artifact-creation", () => ({ createSemanticArtifact: vi.fn() }));
vi.mock("../semantic-assertion-store", () => ({
  listEligibleAssertions: vi.fn().mockReturnValue([]),
  listEligibleAssertionsForArtifacts: vi.fn().mockReturnValue(new Map()),
  listArtifactIdsForExtension: vi.fn(),
  primaryExtensionFor: vi.fn().mockReturnValue("@cinatra-ai/default-artifact"),
}));
vi.mock("@/lib/objects/effective-identity", () => ({
  resolveArtifactEffectiveIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactEffectiveIdentity: vi.fn(),
}));
vi.mock("@/lib/objects/presentation-identity", () => ({
  resolveArtifactPresentationIdentities: vi.fn().mockReturnValue(new Map()),
  resolveArtifactPresentationIdentity: vi.fn(),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: vi.fn() }));

import * as views from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { connectorRefSourceUrl } from "../artifact-service";

/** Built at run time so no URI with a password sits in the file. */
const withCredentials = (scheme: string) => `${scheme}://${["editor", "pw"].join(":")}@acme.example/edit`;

const CASES: unknown[] = [
  "https://acme.example/wp-admin/post.php?post=42&action=edit",
  "http://cms.lan:8080/node/7/edit",
  "http://192.168.1.20/node/7",
  "HTTPS://ACME.example",
  "https:acme.example",
  "http://acme.example/a b",
  "https://acme.example/#frag",
  withCredentials("https"),
  withCredentials("http"),
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,hi",
  "ftp://acme.example/",
  "mailto:someone@acme.example",
  "//acme.example/path",
  "/relative/path",
  "relative",
  "",
  " https://acme.example/ ",
  "https://",
  "http://[::1]:3000/",
  42,
  null,
  undefined,
  { href: "https://acme.example/" },
];

describe("the mirrored source-link rule equals the canonical one", () => {
  it("answers exactly what connectorRefSourceUrl answers, for every case", () => {
    const sourceLinkHref = (views as { sourceLinkHref?: (raw: unknown) => string | null }).sourceLinkHref;
    // red-first-expect: expected 'undefined' to be 'function'
    expect(typeof sourceLinkHref).toBe("function");
    for (const raw of CASES) {
      expect({ raw, mirror: sourceLinkHref!(raw) }).toEqual({
        raw,
        mirror: connectorRefSourceUrl({ connectorRef: { url: raw } }),
      });
    }
  });
});
