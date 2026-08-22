/**
 * The schedule-proposal PRODUCER seam (cinatra#2569, epic #2564 S5).
 *
 * S1 left `trigger_schedule_proposal` REGISTERED-BUT-UNMINTABLE with a named
 * seam; this suite proves the seam is filled the way S1 specified and NOT one
 * inch wider:
 *
 *   - the producer tuple is exact — only the first-party server, only this tool;
 *   - the tool name carries no denied verb token, so the chat policy admits it
 *     WITHOUT weakening the backstop that makes the decision class unreachable;
 *   - propose writes nothing and every denial is the ONE generic sentence;
 *   - the confirm/adjust/arm class has no MCP primitive on any surface.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

import {
  LIFECYCLE_PRODUCER_TOOLS,
  LIFECYCLE_REFUSAL_RESULT,
  buildLifecycleViewEnvelope,
  recognizeLifecycleViewEnvelope,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { isCoreDelegatedChatAdmitted } from "@cinatra-ai/mcp-server/core-delegated-chat-surface";
import { isDelegatedWidgetMcpToolAllowed } from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";
import { SCHEDULE_PROPOSAL_TOOL_NAME } from "../schedule-proposal-mcp";
import inventory from "@/lib/authz/__generated__/inventory.json";
import { PRIMITIVE_CLASSIFICATIONS } from "@/lib/authz/inventory-augment";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-schedule-proposal-producer";
});

const REF = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("S1's named producer seam is filled — and only by this tool", () => {
  it("registers exactly the one producer for trigger_schedule_proposal", () => {
    expect(LIFECYCLE_PRODUCER_TOOLS.trigger_schedule_proposal).toEqual([
      SCHEDULE_PROPOSAL_TOOL_NAME,
    ]);
  });

  it("mints a DATA_PART for the first-party (server, tool) tuple", () => {
    const envelope = buildLifecycleViewEnvelope({
      viewType: "trigger_schedule_proposal",
      ref: REF,
    })!;
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: "cinatra",
        toolName: SCHEDULE_PROPOSAL_TOOL_NAME,
        result: envelope,
      }),
    ).toEqual({
      viewType: "trigger_schedule_proposal",
      schemaVersion: 1,
      ref: REF,
    });
  });

  it("mints NOTHING for an external server returning byte-identical bytes", () => {
    const envelope = buildLifecycleViewEnvelope({
      viewType: "trigger_schedule_proposal",
      ref: REF,
    })!;
    for (const serverLabel of ["Cinatra", " cinatra ", "cinatra-", "acme", ""]) {
      expect(
        recognizeLifecycleViewEnvelope({
          serverLabel,
          toolName: SCHEDULE_PROPOSAL_TOOL_NAME,
          result: envelope,
        }),
      ).toBeNull();
    }
  });

  it("mints NOTHING from a sibling first-party tool — the allowlist is per-viewType", () => {
    const envelope = buildLifecycleViewEnvelope({
      viewType: "trigger_schedule_proposal",
      ref: REF,
    })!;
    for (const toolName of [
      "artifact_review_gate_render",
      "verification_record_render",
      "artifact_review_gates_list",
      "agent_run",
    ]) {
      expect(
        recognizeLifecycleViewEnvelope({
          serverLabel: "cinatra",
          toolName,
          result: envelope,
        }),
      ).toBeNull();
    }
  });

  it("cannot mint a REVIEW GATE card, even though it is first-party", () => {
    const envelope = buildLifecycleViewEnvelope({
      viewType: "artifact_review_gate",
      ref: REF,
    })!;
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: "cinatra",
        toolName: SCHEDULE_PROPOSAL_TOOL_NAME,
        result: envelope,
      }),
    ).toBeNull();
  });

  it("mints nothing from the refusal sentence", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: "cinatra",
        toolName: SCHEDULE_PROPOSAL_TOOL_NAME,
        result: LIFECYCLE_REFUSAL_RESULT,
      }),
    ).toBeNull();
  });
});

describe("the tool NAME is discoverable, classified, and pinned", () => {
  it("equals the literal the registration actually uses", () => {
    expect(SCHEDULE_PROPOSAL_TOOL_NAME).toBe("schedule_proposal_render");
  });

  it("appears in the AUTHZ INVENTORY — an MCP primitive is never unclassified", () => {
    // The inventory generator discovers primitives by statically matching
    // `server.registerTool("<name>"`. Registering through a CONSTANT makes a
    // tool invisible to it, so this assertion is what stops a well-meaning
    // refactor from silently dropping this primitive out of the authz record.
    const entry = (inventory as { primitives: { primitiveName: string; file: string }[] })
      .primitives.find((p) => p.primitiveName === SCHEDULE_PROPOSAL_TOOL_NAME);
    expect(entry).toBeDefined();
    expect(entry!.file).toBe("src/lib/lifecycle/schedule-proposal-mcp.ts");
    expect(PRIMITIVE_CLASSIFICATIONS[SCHEDULE_PROPOSAL_TOOL_NAME]).toEqual({
      resourceType: "agent_run",
      action: "read",
      status: "enforced",
    });
  });
});

describe("the tool NAME keeps the decision-verb backstop intact", () => {
  it("is chat-reachable", () => {
    expect(isCoreDelegatedChatAdmitted(SCHEDULE_PROPOSAL_TOOL_NAME)).toBe(true);
  });

  it("carries none of the denied verb tokens — so it needs no override entry", () => {
    const tokens = SCHEDULE_PROPOSAL_TOOL_NAME.split("_");
    for (const denied of [
      "trigger",
      "create",
      "update",
      "confirm",
      "arm",
      "approve",
      "decide",
      "resume",
      "delete",
    ]) {
      expect(tokens).not.toContain(denied);
    }
  });

  it("IS widget-reachable — first-party parity (corrected 2026-08-11)", () => {
    // The withheld row was invented: a signed-in widget reader is the same
    // person with the same rights, so the proposal reaches them as it reaches
    // first-party chat. What still stops anything from being ARMED is the name
    // itself — it carries no denied verb token, and there is no
    // transport-reachable primitive that confirms (asserted just above and in
    // the test below). Argument order is (kind, name) — the policy is kind-keyed.
    expect(isDelegatedWidgetMcpToolAllowed("wordpress", SCHEDULE_PROPOSAL_TOOL_NAME)).toBe(
      true,
    );
    expect(isDelegatedWidgetMcpToolAllowed("drupal", SCHEDULE_PROPOSAL_TOOL_NAME)).toBe(
      true,
    );
  });

  it("a widget frame with NO lifecycle grant proposes nothing", async () => {
    // The grant, not the surface, is the gate. A widget session whose sign-in
    // predates the lifecycle grant reaches the tool and achieves nothing — the
    // same fixed refusal every other denial produces. The positive control is
    // the granted frame right after it.
    const widgetStore = (lifecycleRead: boolean | undefined) => ({
      userId: "u-widget",
      orgId: "org-1",
      delegatedActor: {
        delegation: "public_site_widget",
        userId: "u-widget",
        orgId: "org-1",
        instanceId: "inst-1",
        kind: "wordpress",
        jti: "j1",
        platformRole: "member",
        ...(lifecycleRead === undefined ? {} : { lifecycleRead }),
      },
    });
    const run = async (store: unknown) => {
      vi.resetModules();
      vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
        proposeTriggerSchedule: vi
          .fn()
          .mockResolvedValue({ ok: true, token: "proposal-token-1" }),
      }));
      vi.doMock("@cinatra-ai/mcp-server", () => ({
        mcpRequestContextStorage: { getStore: () => store },
      }));
      const mod = await import("../schedule-proposal-mcp");
      const result = await mod.handleScheduleProposalRender({
        templateId: "tpl-1",
        schedule: { kind: "immediate" },
      });
      vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
      vi.doUnmock("@cinatra-ai/mcp-server");
      return result.content[0].text as string;
    };
    expect(await run(widgetStore(undefined))).toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(await run(widgetStore(false))).toBe(LIFECYCLE_REFUSAL_RESULT);
    // GRANTED: the same frame, the same code, a minted card.
    expect(await run(widgetStore(true))).not.toBe(LIFECYCLE_REFUSAL_RESULT);
    vi.resetModules();
  });

  it("leaves the trigger MUTATION primitives denied on chat, exactly as before", () => {
    for (const name of [
      "agent_run_trigger_set",
      "agent_run_trigger_delete",
      // The names a propose primitive might plausibly have been given — every
      // one of them is denied by a whole-token verb, which is the reason the
      // shipped name avoids them all.
      "agent_run_trigger_propose",
      "schedule_proposal_confirm",
      "schedule_proposal_arm",
      "trigger_schedule_create",
    ]) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(false);
    }
  });
});

describe("the producer PROPOSES and nothing more", () => {
  it("mints an envelope whose ref is the proposal token, and writes nothing", async () => {
    // The module is already loaded (the name constant is statically imported),
    // so the registry has to be reset before the mocks can take effect.
    vi.resetModules();
    const proposeTriggerSchedule = vi.fn().mockResolvedValue({
      ok: true,
      token: REF,
      expiresAt: 0,
    });
    vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
      proposeTriggerSchedule,
    }));
    vi.doMock("@cinatra-ai/mcp-server", () => ({
      mcpRequestContextStorage: {
        getStore: () => ({ userId: "u1", orgId: "o1" }),
      },
    }));
    const mod = await import("../schedule-proposal-mcp");
    const result = await mod.handleScheduleProposalRender({
      templateId: "tpl-1",
      schedule: { kind: "immediate" },
    });
    expect(result.content[0].text).toContain("$cinatraLifecycleView");
    expect(result.content[0].text).toContain(REF);
    expect(proposeTriggerSchedule).toHaveBeenCalledWith({
      templateId: "tpl-1",
      userId: "u1",
      orgId: "o1",
      schedule: { kind: "immediate" },
    });
    vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
    vi.doUnmock("@cinatra-ai/mcp-server");
    vi.resetModules();
  });

  it("returns the ONE generic sentence for every denial — no ids, no counts, no reason", async () => {
    const cases: {
      name: string;
      store: unknown;
      propose: unknown;
      input: unknown;
    }[] = [
      {
        name: "no principal",
        store: { orgId: "o1" },
        propose: { ok: true, token: REF, expiresAt: 0 },
        input: { templateId: "tpl-1", schedule: { kind: "immediate" } },
      },
      {
        name: "no org",
        store: { userId: "u1" },
        propose: { ok: true, token: REF, expiresAt: 0 },
        input: { templateId: "tpl-1", schedule: { kind: "immediate" } },
      },
      {
        name: "an A2A frame — a proposal has no person to ask",
        store: { userId: "u1", orgId: "o1", a2aActorContext: { userId: "u1", orgId: "o1" } },
        propose: { ok: true, token: REF, expiresAt: 0 },
        input: { templateId: "tpl-1", schedule: { kind: "immediate" } },
      },
      {
        name: "the service refused",
        store: { userId: "u1", orgId: "o1" },
        propose: { ok: false },
        input: { templateId: "tpl-1", schedule: { kind: "immediate" } },
      },
      {
        name: "a raw cron instead of the builder's selections",
        store: { userId: "u1", orgId: "o1" },
        propose: { ok: true, token: REF, expiresAt: 0 },
        input: { templateId: "tpl-1", schedule: { kind: "cron", cronExpression: "0 9 * * 1-5" } },
      },
      {
        name: "an out-of-range selection",
        store: { userId: "u1", orgId: "o1" },
        propose: { ok: true, token: REF, expiresAt: 0 },
        input: {
          templateId: "tpl-1",
          schedule: {
            kind: "recurring",
            timezone: "UTC",
            selection: {
              frequency: "weekly",
              interval: 1,
              weekdays: [9],
              dayOfMonth: 1,
              monthlyMode: "date",
              nthWeek: 1,
              monthlyWeekday: 0,
              quarterAnchor: "start",
              yearlyMonth: 1,
              hour: 9,
              minute: 0,
            },
          },
        },
      },
      {
        name: "the service threw",
        store: { userId: "u1", orgId: "o1" },
        propose: "throw",
        input: { templateId: "tpl-1", schedule: { kind: "immediate" } },
      },
    ];

    const texts: string[] = [];
    for (const c of cases) {
      vi.resetModules();
      vi.doMock("@cinatra-ai/agents/trigger-schedule-propose", () => ({
        proposeTriggerSchedule:
          c.propose === "throw"
            ? vi.fn().mockRejectedValue(new Error("store exploded: run r-9 in org o-3"))
            : vi.fn().mockResolvedValue(c.propose),
      }));
      vi.doMock("@cinatra-ai/mcp-server", () => ({
        mcpRequestContextStorage: { getStore: () => c.store },
      }));
      const mod = await import("../schedule-proposal-mcp");
      const result = await mod.handleScheduleProposalRender(c.input);
      texts.push(result.content[0].text);
      expect(result.content[0].text, c.name).toBe(LIFECYCLE_REFUSAL_RESULT);
      // Nothing about the failure leaks into a durable, model-visible result.
      expect(result.content[0].text).not.toContain("r-9");
      expect(result.content[0].text).not.toContain("o-3");
      vi.doUnmock("@cinatra-ai/agents/trigger-schedule-propose");
      vi.doUnmock("@cinatra-ai/mcp-server");
    }
    // Every refusal is the SAME string — indistinguishable by construction.
    expect(new Set(texts).size).toBe(1);
    vi.resetModules();
  });
});
