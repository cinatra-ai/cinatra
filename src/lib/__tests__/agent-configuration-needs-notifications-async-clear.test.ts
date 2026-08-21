// cinatra#2882 round 1 — the FOURTH async caller of the notification clear.
//
// `syncAgentConfigurationNeedsNotifications` is an `async` function AWAITED
// from the Extensions-catalog render (`registry-catalog-screen.tsx`), and it
// clears in a LOOP — one keyed DELETE per config-needs entry that has gone
// stale. On the synchronous twin that was one `Atomics.wait` freeze PER KEY on
// a user-facing path, each up to `POSTGRES_SYNC_TIMEOUT_MS` (30s) with no
// timer, no abort listener and no microtask running anywhere in the process.
//
// The sibling file `agent-run-wait-notifications.test.ts` pins the other four
// migrated callers the same way, and for the same reason: the `vi.mock` factory
// below supplies ONLY the async name. A regression to the sync call would
// destructure `undefined`, and — because this reconciler swallows and logs its
// own failures by design — would otherwise pass QUIETLY, having silently
// stopped clearing anything. So the arms read the observable behaviour on both
// sides of that: the async name is what gets called, the clear is genuinely
// AWAITED, and nothing is swallowed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Typed via the vi.fn<Signature>() form rather than a typed implementation, so
// the parameter types are pinned without declaring parameters no default
// implementation reads.
const listNotificationsByDedupeKeyPrefixForUser =
  vi.fn<(args: { userId: string; dedupeKeyPrefix: string }) => unknown[]>();
const createNotificationForRecipient =
  vi.fn<
    (
      recipient: { kind: string; userId: string },
      input: unknown,
    ) => Promise<Array<{ id: string }>>
  >();
// ONLY the async name — see the header.
const deleteNotificationsByDedupeKeyForUserAsync =
  vi.fn<(args: { userId: string; dedupeKey: string }) => Promise<void>>();

// Side-effect host-adapter registration — a no-op in the test.
vi.mock("@/lib/notifications-host", () => ({}));
vi.mock("@cinatra-ai/notifications/server", () => ({
  listNotificationsByDedupeKeyPrefixForUser,
  createNotificationForRecipient,
  deleteNotificationsByDedupeKeyForUserAsync,
}));

import {
  buildConfigurationNeedsNotificationInput,
  configurationNeedsDedupeKey,
  syncAgentConfigurationNeedsNotifications,
  type GatedAgent,
} from "@/lib/agent-configuration-needs-notifications";

function gated(pkg: string, display: string): GatedAgent {
  return {
    agentPackageName: pkg,
    agentDisplayName: display,
    connectors: [
      {
        displayName: "Apollo",
        packageName: "@cinatra-ai/apollo-connector",
        settingsHref: "/connectors/cinatra-ai/apollo/setup",
      },
    ],
  };
}

/** An existing bell entry for `agent`, in the shape the reconciler reads. */
function existingEntry(agent: GatedAgent): Record<string, unknown> {
  const input = buildConfigurationNeedsNotificationInput(agent);
  return {
    id: agent.agentPackageName,
    title: input.title,
    body: input.body ?? "",
    kind: "warning",
    createdAt: "2026-07-10T00:00:00.000Z",
    dedupeKey: input.dedupeKey,
    metadata: input.metadata,
  };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  listNotificationsByDedupeKeyPrefixForUser.mockReset();
  listNotificationsByDedupeKeyPrefixForUser.mockReturnValue([]);
  createNotificationForRecipient.mockReset();
  createNotificationForRecipient.mockResolvedValue([{ id: "notif-1" }]);
  deleteNotificationsByDedupeKeyForUserAsync.mockReset();
  deleteNotificationsByDedupeKeyForUserAsync.mockResolvedValue(undefined);
  // The reconciler is best-effort: it catches everything and logs. A warning
  // is therefore the signature of a swallowed regression, so every arm asserts
  // there was none.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("syncAgentConfigurationNeedsNotifications — the async clear", () => {
  it("clears a now-runnable agent's entry through the ASYNC seam", async () => {
    const wasGated = gated("@cinatra-ai/sales-agent", "Sales Agent");
    listNotificationsByDedupeKeyPrefixForUser.mockReturnValue([
      existingEntry(wasGated),
    ]);

    // Nothing is gated any more, so the existing entry must be cleared.
    await syncAgentConfigurationNeedsNotifications({
      userId: "user-a",
      gatedAgents: [],
    });

    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledTimes(1);
    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledWith({
      userId: "user-a",
      dedupeKey: configurationNeedsDedupeKey("@cinatra-ai/sales-agent"),
    });
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("AWAITS each clear — the loop yields between keys instead of freezing", async () => {
    // THE POINT OF THE MIGRATION, as an observable property rather than a
    // spelling: with the sync twin the whole loop ran to completion inside one
    // synchronous turn, so a timer due mid-clear could not fire until every key
    // had been deleted. Here each clear is a promise the caller awaits, so the
    // event loop gets the gaps.
    const agents = ["a", "b", "c"].map((n) =>
      gated(`@cinatra-ai/${n}-agent`, `${n} Agent`),
    );
    listNotificationsByDedupeKeyPrefixForUser.mockReturnValue(
      agents.map(existingEntry),
    );

    const timerFiredAfterClears: number[] = [];
    let cleared = 0;
    deleteNotificationsByDedupeKeyForUserAsync.mockImplementation(async () => {
      cleared += 1;
      // Resolve on a macrotask, so a clear that is NOT awaited would let the
      // loop run past it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Due immediately: it can only run if the loop yields.
    setTimeout(() => timerFiredAfterClears.push(cleared), 0);

    await syncAgentConfigurationNeedsNotifications({
      userId: "user-a",
      gatedAgents: [],
    });

    expect(deleteNotificationsByDedupeKeyForUserAsync).toHaveBeenCalledTimes(3);
    // The timer ran while the loop was still going — not after it finished,
    // and not before it started.
    expect(timerFiredAfterClears).toHaveLength(1);
    expect(timerFiredAfterClears[0]).toBeGreaterThan(0);
    expect(timerFiredAfterClears[0]).toBeLessThan(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps clears BEFORE creates across the await", async () => {
    // A content-changed entry is cleared and re-inserted on the same
    // `(user_id, dedupe_key)` slot, so the ordering is load-bearing — and an
    // `await` in the middle of a sequence is exactly where an ordering
    // guarantee gets lost. Recorded on one shared log so the interleaving is
    // read directly rather than inferred from two call counts.
    const order: string[] = [];
    const stale = gated("@cinatra-ai/sales-agent", "Sales Agent");
    // One MORE unconfigured connector than the existing entry lists: the
    // reconciler keys staleness on the connector set, so this is a genuine
    // clear-then-recreate rather than a no-op.
    const changed: GatedAgent = {
      ...stale,
      connectors: [
        ...stale.connectors,
        {
          displayName: "Hubspot",
          packageName: "@cinatra-ai/hubspot-connector",
          settingsHref: "/connectors/cinatra-ai/hubspot/setup",
        },
      ],
    };
    listNotificationsByDedupeKeyPrefixForUser.mockReturnValue([
      existingEntry(stale),
    ]);
    deleteNotificationsByDedupeKeyForUserAsync.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push("clear");
    });
    createNotificationForRecipient.mockImplementation(async () => {
      order.push("create");
      return [{ id: "notif-1" }];
    });

    await syncAgentConfigurationNeedsNotifications({
      userId: "user-a",
      gatedAgents: [changed],
    });

    expect(order).toEqual(["clear", "create"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays best-effort — a rejected clear is swallowed, not thrown", async () => {
    // The awaited rejection has to reach the existing catch exactly as the
    // synchronous throw did; a notification write may never fail the render.
    listNotificationsByDedupeKeyPrefixForUser.mockReturnValue([
      existingEntry(gated("@cinatra-ai/sales-agent", "Sales Agent")),
    ]);
    deleteNotificationsByDedupeKeyForUserAsync.mockRejectedValue(
      new Error("Query read timeout"),
    );

    await expect(
      syncAgentConfigurationNeedsNotifications({
        userId: "user-a",
        gatedAgents: [],
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain("Query read timeout");
  });

  it("no userId → no read, no clear, no create", async () => {
    await syncAgentConfigurationNeedsNotifications({
      userId: null,
      gatedAgents: [gated("@cinatra-ai/sales-agent", "Sales Agent")],
    });

    expect(listNotificationsByDedupeKeyPrefixForUser).not.toHaveBeenCalled();
    expect(deleteNotificationsByDedupeKeyForUserAsync).not.toHaveBeenCalled();
    expect(createNotificationForRecipient).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
