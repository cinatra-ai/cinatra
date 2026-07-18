// @cinatra-ai/wordpress:post external-pointer type registration (cinatra#1464).
//
// Requirements:
//   - registerAllObjectTypes() registers "@cinatra-ai/wordpress:post" as a
//     `content` type;
//   - its identityKey keys rows to instance + WordPress post id via
//     `<connectorId>:<externalId>` (externalId being the site-scoped
//     `<instanceId>:<postId>`), and returns null when either part is missing;
//   - its schema is the connectorRef external-pointer envelope (a strict
//     lifecycle pointer), accepting a well-formed pointer and rejecting a
//     malformed reference state / a missing connectorRef.

import { describe, it, expect, beforeAll, vi } from "vitest";

// Mock server-only (node test runner cannot resolve Next.js server-only).
vi.mock("server-only", () => ({}));

// generic-renderers uses React (JSX); mock to keep the test pure TS.
vi.mock("./generic-renderers", () => ({
  GenericObjectListRow: vi.fn(),
  GenericObjectCard: vi.fn(),
  GenericObjectDetail: vi.fn(),
  MemoryConceptListRow: vi.fn(),
  MemoryConceptCard: vi.fn(),
  MemoryConceptDetail: vi.fn(),
}));

import { objectTypeRegistry } from "../registry";
import { registerAllObjectTypes } from "../integration/register-types";

const TYPE_ID = "@cinatra-ai/wordpress:post";
const CONNECTOR_ID = "@cinatra-ai/wordpress-mcp-connector";

/** A well-formed connectorRef external-pointer envelope for a WordPress post. */
function pointerData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactType: "connector-ref",
    originKind: "external_link",
    mime: "text/html",
    title: "Hello World",
    excerpt: "An intro",
    connectorRef: {
      url: "https://blog.example.com/?p=42",
      connectorId: CONNECTOR_ID,
      externalId: "site-1:42",
      resolvedMimeType: "text/html",
      state: "linked",
      lastVerifiedAt: "2026-07-18T00:00:00.000Z",
      remoteVersion: "2026-07-18T00:00:00",
      title: "Hello World",
      excerpt: "An intro",
    },
    ...overrides,
  };
}

describe("@cinatra-ai/wordpress:post external-pointer type registration", () => {
  beforeAll(() => {
    // Idempotent — safe to call multiple times.
    registerAllObjectTypes();
  });

  it("is present in the registry as a `content` type after registerAllObjectTypes", () => {
    const resolved = objectTypeRegistry.resolve(TYPE_ID);
    expect(resolved).not.toBeNull();
    expect(resolved!.category).toBe("content");
  });

  it("identityKey keys rows to <connectorId>:<externalId> (instance + post id)", () => {
    const identityKey = objectTypeRegistry.resolve(TYPE_ID)!.identityKey!;
    expect(typeof identityKey).toBe("function");
    expect(identityKey(pointerData())).toBe(`${CONNECTOR_ID}:site-1:42`);
  });

  it("identityKey returns null when connectorId or externalId is missing/non-string", () => {
    const identityKey = objectTypeRegistry.resolve(TYPE_ID)!.identityKey!;
    expect(identityKey({})).toBeNull();
    expect(identityKey({ connectorRef: {} })).toBeNull();
    expect(identityKey({ connectorRef: { connectorId: CONNECTOR_ID } })).toBeNull();
    expect(identityKey({ connectorRef: { externalId: "site-1:42" } })).toBeNull();
    expect(
      identityKey({ connectorRef: { connectorId: CONNECTOR_ID, externalId: 42 } }),
    ).toBeNull();
  });

  it("schema accepts a well-formed connectorRef pointer envelope", () => {
    const schema = objectTypeRegistry.resolve(TYPE_ID)!.schema;
    expect(schema.safeParse(pointerData()).success).toBe(true);
  });

  it("schema rejects an invalid reference state and a missing connectorRef", () => {
    const schema = objectTypeRegistry.resolve(TYPE_ID)!.schema;
    expect(
      schema.safeParse(pointerData({ connectorRef: { ...(pointerData().connectorRef as object), state: "bogus" } }))
        .success,
    ).toBe(false);
    const withoutRef = pointerData();
    delete (withoutRef as Record<string, unknown>).connectorRef;
    expect(schema.safeParse(withoutRef).success).toBe(false);
  });
});
