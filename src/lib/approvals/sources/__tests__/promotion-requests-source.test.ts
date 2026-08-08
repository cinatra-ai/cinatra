// cinatra#1560 (E10 of #1549) — the single shared promotion ApprovalSource.
//
// Proves: (1) the subject-type discriminator round-trips through the row id and
// routes decide to the right subject backend; (2) contract conformance +
// registry-parity (the heavy source spreads the light contract — same fn refs);
// (3) eligibility — DORMANT (`not_configured`) while every subject backend is
// unplugged, READY + self-gated once one is; (4) the decide round-trip against
// the EXACT seam #1381/#1437 implement (approve/reject/CAS-supersede/never-
// narrow/secret-scan/authorization), via a FIXTURE backend; (5) a subject
// backend failure PROPAGATES (so the unified feed degrades soundly, never a
// partial "ready"). No DB, no network — the seam is exercised directly.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Inert Badge — the render smoke asserts the plain text the source emits.
vi.mock("@/components/ui/badge", () => ({ Badge: () => null }));

import {
  buildPromotionSource,
  promotionRequestsSource,
} from "../promotion-requests";
import { promotionRequestsContract } from "../promotion-requests.contract";
import {
  buildPromotionContract,
  formatPromotionRowId,
  parsePromotionRowId,
  type PromotionBackend,
  type PromotionBackendRow,
  type PromotionDecideArgs,
  type PromotionDecideOutcome,
  type PromotionSubjectAdapter,
} from "../promotion-subjects";
import { PROMOTION_SOURCE_ID } from "../source-ids";
import type { ApprovalSource, ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

// --- fixture backend (the exact seam #1381/#1437 implement) -----------------

interface FixtureCfg {
  inbox?: PromotionBackendRow[];
  mine?: PromotionBackendRow[];
  decide?: (args: PromotionDecideArgs) => PromotionDecideOutcome | Promise<PromotionDecideOutcome>;
  canReview?: (v: ApprovalViewer) => boolean;
  canRequest?: (v: ApprovalViewer) => boolean;
  throwOnInbox?: boolean;
}

function fixtureBackend(cfg: FixtureCfg = {}): PromotionBackend {
  return {
    canReview: cfg.canReview ?? ((v) => v.isAdmin),
    canRequest: cfg.canRequest ?? (() => true),
    async listInbox() {
      if (cfg.throwOnInbox) throw new Error("backend boom");
      return cfg.inbox ?? [];
    },
    async listMine() {
      return cfg.mine ?? [];
    },
    async countInbox() {
      return (cfg.inbox ?? []).length;
    },
    async countMine() {
      return (cfg.mine ?? []).length;
    },
    async decide(args) {
      return cfg.decide ? cfg.decide(args) : { ok: true };
    },
  };
}

function backendRow(over: Partial<PromotionBackendRow> = {}): PromotionBackendRow {
  return {
    subjectId: "s-1",
    title: "Row 1",
    status: "pending",
    createdAt: "2026-07-14T00:00:00.000Z",
    version: "v-1",
    ...over,
  };
}

/** Build a fixture-backed source over the same DI path production uses. */
function sourceWith(adapters: PromotionSubjectAdapter[]): ApprovalSource {
  return buildPromotionSource(buildPromotionContract(adapters), adapters);
}

function adapter(
  subjectType: string,
  kindLabel: string,
  backend: PromotionBackend | null,
): PromotionSubjectAdapter {
  return { subjectType, kindLabel, backend };
}

// ---------------------------------------------------------------------------

describe("subject-type discriminator (row id)", () => {
  it("round-trips format ⇄ parse", () => {
    expect(parsePromotionRowId(formatPromotionRowId("memory", "abc"))).toEqual({
      subjectType: "memory",
      subjectId: "abc",
    });
  });

  it("splits at the FIRST colon so a subjectId may contain colons", () => {
    const id = formatPromotionRowId("artifact", "@cinatra-ai/dynamic:foo:bar");
    expect(id).toBe("artifact:@cinatra-ai/dynamic:foo:bar");
    expect(parsePromotionRowId(id)).toEqual({
      subjectType: "artifact",
      subjectId: "@cinatra-ai/dynamic:foo:bar",
    });
  });

  it("rejects a malformed id (no colon / empty subjectType / empty subjectId)", () => {
    expect(parsePromotionRowId("nocolon")).toBeNull();
    expect(parsePromotionRowId(":abc")).toBeNull();
    expect(parsePromotionRowId("memory:")).toBeNull();
    expect(parsePromotionRowId("")).toBeNull();
  });
});

describe("contract conformance & registry parity", () => {
  it("the production source spreads the light contract (SAME fn references)", () => {
    expect(promotionRequestsSource.id).toBe(PROMOTION_SOURCE_ID);
    expect(promotionRequestsSource.counts).toBe(promotionRequestsContract.counts);
    expect(promotionRequestsSource.appliesTo).toBe(promotionRequestsContract.appliesTo);
    expect(promotionRequestsSource.availability).toBe(promotionRequestsContract.availability);
    expect(promotionRequestsSource.inboxActionable).toBe(promotionRequestsContract.inboxActionable);
  });

  it("implements the full ApprovalSource surface", () => {
    for (const k of ["title", "fetchInbox", "fetchMine", "rowRenderer"] as const) {
      expect(promotionRequestsSource[k]).toBeDefined();
    }
    expect(typeof promotionRequestsSource.actions.decide).toBe("function");
  });

  it("every fetched row is normalized: sourceId=promotion-requests, id=<subjectType>:<subjectId>", async () => {
    const src = sourceWith([
      adapter("memory", "Memory", fixtureBackend({ inbox: [backendRow({ subjectId: "m1" })] })),
    ]);
    const env = await src.fetchInbox(admin);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0].sourceId).toBe(PROMOTION_SOURCE_ID);
    expect(env.rows[0].id).toBe("memory:m1");
    expect(env.rows[0].version).toBe("v-1");
    // CAS token is the PUBLIC version; raw carries only the discriminator/detail.
    expect(env.rows[0].raw).toMatchObject({ subjectType: "memory", kindLabel: "Memory" });
  });
});

describe("eligibility — dormant vs configured", () => {
  it("is DORMANT (not_configured) while every subject backend is unplugged (fixture registry)", async () => {
    // The dormancy SEMANTICS — exercised via the DI seam over an all-null
    // registry (the shipped registry now plugs the artifact backend, #1437).
    const src = sourceWith([adapter("memory", "Memory", null), adapter("artifact", "Artifact", null)]);
    expect(src.availability(admin)).toBe("not_configured");
    expect(src.appliesTo(admin, "inbox")).toBe(false);
    expect(src.appliesTo(admin, "mine")).toBe(false);
    expect(await src.counts(admin)).toEqual({ inbox: 0, mine: 0 });
    // A dormant source produces no rows even if fetched directly.
    expect((await src.fetchInbox(admin)).rows).toEqual([]);
    expect((await src.fetchMine(admin)).rows).toEqual([]);
  });

  it("the SHIPPED source is READY now that the artifact backend is plugged in (#1437)", () => {
    // Cheap gates only — no counts()/fetch() here (those hit the real store).
    expect(promotionRequestsSource.availability(admin)).toBe("ready");
    // Review gate is admin-only; request gate is any member.
    expect(promotionRequestsSource.appliesTo(admin, "inbox")).toBe(true);
    expect(promotionRequestsSource.appliesTo(member, "inbox")).toBe(false);
    expect(promotionRequestsSource.appliesTo(member, "mine")).toBe(true);
    expect(promotionRequestsSource.appliesTo(admin, "mine")).toBe(true);
  });

  it("becomes READY once a subject backend is plugged in", () => {
    const src = sourceWith([adapter("memory", "Memory", fixtureBackend())]);
    expect(src.availability(admin)).toBe("ready");
  });

  it("appliesTo/counts self-gate per subject (review=admin, request=any member)", async () => {
    const src = sourceWith([
      adapter("memory", "Memory", fixtureBackend({ inbox: [backendRow()], mine: [backendRow()] })),
    ]);
    // inbox = review gate (admin only); mine = request gate (any member).
    expect(src.appliesTo(admin, "inbox")).toBe(true);
    expect(src.appliesTo(member, "inbox")).toBe(false);
    expect(src.appliesTo(member, "mine")).toBe(true);
    expect(await src.counts(admin)).toEqual({ inbox: 1, mine: 1 });
    // Non-admin: inbox self-gated to 0; own requests still counted.
    expect(await src.counts(member)).toEqual({ inbox: 0, mine: 1 });
  });

  it("federates ≥2 subject types through ONE source; counts sum", async () => {
    const src = sourceWith([
      adapter("memory", "Memory", fixtureBackend({ inbox: [backendRow({ subjectId: "m1" })] })),
      adapter("artifact", "Artifact", fixtureBackend({ inbox: [backendRow({ subjectId: "a1" })] })),
    ]);
    const env = await src.fetchInbox(admin);
    expect(env.rows.map((r) => r.id).sort()).toEqual(["artifact:a1", "memory:m1"]);
    expect(await src.counts(admin)).toEqual({ inbox: 2, mine: 0 });
  });
});

describe("decide round-trip (routes by prefix; subject backend owns authz + CAS)", () => {
  function routingSource(spy: { memory: ReturnType<typeof vi.fn>; artifact: ReturnType<typeof vi.fn> }) {
    return sourceWith([
      adapter("memory", "Memory", fixtureBackend({ decide: spy.memory as never })),
      adapter("artifact", "Artifact", fixtureBackend({ decide: spy.artifact as never })),
    ]);
  }

  it("approve routes to the correct subject, stripping the prefix; forwards reason+version", async () => {
    const memory = vi.fn(async () => ({ ok: true }) as PromotionDecideOutcome);
    const artifact = vi.fn(async () => ({ ok: true }) as PromotionDecideOutcome);
    const src = routingSource({ memory, artifact });

    const res = await src.actions.decide(
      { rowId: "artifact:a-9", action: "approve", expectedVersion: "v-9" },
      admin,
    );
    expect(res).toEqual({ ok: true });
    expect(memory).not.toHaveBeenCalled();
    expect(artifact).toHaveBeenCalledTimes(1);
    expect(artifact).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: "a-9", action: "approve", expectedVersion: "v-9", viewer: admin }),
    );
  });

  it("reject forwards the TRIMMED reason", async () => {
    const memory = vi.fn(async () => ({ ok: true }) as PromotionDecideOutcome);
    const src = routingSource({ memory, artifact: vi.fn() });
    await src.actions.decide({ rowId: "memory:m-1", action: "reject", reason: "  not useful  " }, admin);
    expect(memory).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: "m-1", action: "reject", reason: "not useful" }),
    );
  });

  it("refuses a reasonless / whitespace-only reject WITHOUT touching a backend (reason_required)", async () => {
    const memory = vi.fn(async () => ({ ok: true }) as PromotionDecideOutcome);
    const src = routingSource({ memory, artifact: vi.fn() });
    for (const bad of [undefined, "", "   "]) {
      const res = await src.actions.decide(
        { rowId: "memory:m-1", action: "reject", ...(bad === undefined ? {} : { reason: bad }) },
        admin,
      );
      expect(res).toMatchObject({ ok: false, kind: "refused", code: "reason_required" });
    }
    expect(memory).not.toHaveBeenCalled();
  });

  it.each([
    ["stale_snapshot", "refused"],
    ["version_required", "refused"],
    ["narrowing", "refused"],
    ["invalid_state", "refused"],
    ["conflict", "refused"],
    ["not_found", "refused"],
    ["not_authorized", "forbidden"],
    ["secret_scan", "forbidden"],
    ["transient", "transient"],
  ] as const)("maps subject outcome '%s' onto kind '%s'", async (code, kind) => {
    const src = sourceWith([
      adapter("memory", "Memory", fixtureBackend({ decide: () => ({ ok: false, code, message: `m-${code}` }) })),
    ]);
    const res = await src.actions.decide({ rowId: "memory:x", action: "approve" }, admin);
    expect(res).toMatchObject({ ok: false, kind, code, message: `m-${code}` });
  });

  it("refuses a malformed / unknown-subject / unknown-action row WITHOUT touching a backend", async () => {
    const decide = vi.fn(async () => ({ ok: true }) as PromotionDecideOutcome);
    const src = sourceWith([adapter("memory", "Memory", fixtureBackend({ decide: decide as never }))]);

    expect(await src.actions.decide({ rowId: "nocolon", action: "approve" }, admin)).toMatchObject({
      ok: false,
      kind: "refused",
      code: "not_found",
    });
    expect(await src.actions.decide({ rowId: "artifact:x", action: "approve" }, admin)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await src.actions.decide({ rowId: "memory:x", action: "bogus" }, admin)).toMatchObject({
      ok: false,
      code: "unknown_action",
    });
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("failure semantics & rendering", () => {
  it("a subject backend failure PROPAGATES (feed degrades soundly; no partial ready)", async () => {
    const src = sourceWith([
      adapter("memory", "Memory", fixtureBackend({ inbox: [backendRow()] })),
      adapter("artifact", "Artifact", fixtureBackend({ throwOnInbox: true })),
    ]);
    await expect(src.fetchInbox(admin)).rejects.toThrow("backend boom");
  });

  it("rowRenderer emits the title, kind label and scope line (smoke)", async () => {
    const src = sourceWith([
      adapter(
        "memory",
        "Memory",
        fixtureBackend({
          inbox: [
            backendRow({
              title: "Quarterly insight",
              detail: { fromScope: "Private", toScope: "Organization", requestedBy: "Ada" },
            }),
          ],
        }),
      ),
    ]);
    const env = await src.fetchInbox(admin);
    const html = renderToStaticMarkup(src.rowRenderer(env.rows[0], { direction: "inbox" }) as never);
    expect(html).toContain("Quarterly insight");
    expect(html).toContain("Private → Organization");
    expect(html).toContain("by Ada");
  });
});
