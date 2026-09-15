/**
 * The platform-supplied flow-input set (cinatra#3003).
 *
 * Two chokepoints read the SAME constant — the pre-dispatch satisfiability
 * guard and OAS-RUNTIME-014 — and the dispatcher keys its run-id write off it.
 * These tests pin the facts that make that safe:
 *   1. membership is the LOADER BOUNDARY, not "dispatch wrote it": the run
 *      token is written and then scrubbed, so it is not a flow input;
 *   2. the reserved run-token spelling has not drifted from its TS owner;
 *   3. the bounded exemption map cannot grow unnoticed;
 *   4. the runtime guard does NOT honour `required` for a hidden input — the
 *      setup loop drops hidden fields from `pendingFields` regardless.
 */

import { describe, it, expect } from "vitest";

import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";
import { buildWayflowInitialMessagePayload } from "../wayflow-dispatch-payload";
import {
  findUnsatisfiableHiddenInputs,
  assertUnsatisfiableHiddenInputs,
} from "../input-schema-resolver";
import {
  PLATFORM_SUPPLIED_FLOW_INPUTS,
  PLATFORM_SUPPLIED_RUN_ID_KEY,
  PLATFORM_SUPPLIED_RUN_ID_ALIAS,
  PLATFORM_SUPPLIED_RUN_TOKEN_KEY,
  OAS_RUNTIME_014_EXEMPTIONS,
  isPlatformSuppliedFlowInput,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data module (allowJs)
} from "../../../../scripts/extensions/platform-supplied-flow-inputs.mjs";

const SUPPLIED = PLATFORM_SUPPLIED_FLOW_INPUTS as readonly string[];

describe("platform-supplied flow inputs", () => {
  it("pins the run-token spelling against its TypeScript owner", () => {
    // The .mjs module is dependency-free, so it re-declares the literal rather
    // than importing it. If src/lib/agent-run-token.ts ever renames the key,
    // this equality is what catches the drift.
    expect(PLATFORM_SUPPLIED_RUN_TOKEN_KEY).toBe(CINATRA_RUN_TOKEN_MESSAGE_KEY);
  });

  it("is exactly the run id and its loader alias", () => {
    expect([...SUPPLIED].sort()).toEqual(
      [PLATFORM_SUPPLIED_RUN_ID_KEY, PLATFORM_SUPPLIED_RUN_ID_ALIAS].sort(),
    );
    // docker/wayflow/agent_loader.py::_extract_start_inputs copies
    // cinatra_run_id across to agent_run_id, so a flow declaring EITHER
    // spelling is served without a default.
    expect(PLATFORM_SUPPLIED_RUN_ID_ALIAS).toBe("agent_run_id");
  });

  it("EXCLUDES the run token — dispatch writes it, the loader scrubs it", () => {
    // The membership test is the loader boundary, not the dispatch write.
    // `_extract_and_scrub_run_token` POPS the key out of the message text part
    // BEFORE `_extract_start_inputs` parses the start inputs, so the token
    // never reaches `start_conversation(inputs=...)`. A flow declaring it as an
    // undefaulted input would still be refused — exempting it here would be a
    // false claim, so the payload's own key is deliberately NOT in the set.
    const payload = buildWayflowInitialMessagePayload({
      inputParams: { topic: "hello" },
      runId: "11111111-2222-3333-4444-555555555555",
      runToken: "raw-token",
    });
    expect(Object.keys(payload)).toContain(PLATFORM_SUPPLIED_RUN_TOKEN_KEY);
    expect(isPlatformSuppliedFlowInput(PLATFORM_SUPPLIED_RUN_TOKEN_KEY)).toBe(false);
  });

  it("covers the dispatch-written key that DOES survive the loader", () => {
    const payload = buildWayflowInitialMessagePayload({
      inputParams: { topic: "hello" },
      runId: "11111111-2222-3333-4444-555555555555",
      runToken: "raw-token",
    });
    // The run id is written by the dispatcher and survives into the start
    // inputs, so the guard must never refuse a flow that relies on it.
    expect(payload[PLATFORM_SUPPLIED_RUN_ID_KEY]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(isPlatformSuppliedFlowInput(PLATFORM_SUPPLIED_RUN_ID_KEY)).toBe(true);
  });

  it("does NOT claim packageSlug — no product path writes it", () => {
    expect(isPlatformSuppliedFlowInput("packageSlug")).toBe(false);
  });

  it("pins the exemption map verbatim so it cannot grow unnoticed", () => {
    expect(
      Object.fromEntries(
        Object.entries(
          OAS_RUNTIME_014_EXEMPTIONS as Record<string, readonly string[]>,
        ).map(([k, v]) => [k, [...v]]),
      ),
    ).toEqual({
      "@cinatra-ai/email-drafting-agent": ["campaignId", "confirmedRecipients"],
      "@cinatra-ai/email-follow-up-agent": ["campaignId"],
      "@cinatra-ai/email-test-delivery-agent": ["campaignId"],
      "@cinatra-ai/context-selection-agent": [
        "parentPackageName",
        "parentRunId",
        "slotId",
      ],
    });
  });
});

describe("findUnsatisfiableHiddenInputs — the pre-dispatch rule", () => {
  const hidden = (extra: Record<string, unknown> = {}) => ({
    type: "string",
    title: "x",
    "x-hidden": true,
    ...extra,
  });

  it("flags a hidden, undefaulted, unsupplied input", () => {
    const bad = findUnsatisfiableHiddenInputs({
      properties: { spec: { type: "string" }, packageSlug: hidden() },
      alreadySupplied: { spec: "build me an agent" },
      packageName: "@cinatra-ai/author-agent",
      packageVersion: "0.1.1",
    });
    expect(bad).toEqual([
      { agent: "@cinatra-ai/author-agent@0.1.1", input: "packageSlug" },
    ]);
  });

  it("clears once the package declares a default", () => {
    expect(
      findUnsatisfiableHiddenInputs({
        properties: {
          spec: { type: "string" },
          packageSlug: hidden({ default: "" }),
        },
        alreadySupplied: { spec: "s" },
        packageName: "@cinatra-ai/author-agent",
        packageVersion: "0.1.2",
      }),
    ).toEqual([]);
  });

  it("clears when the value was pre-supplied on the run", () => {
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { packageSlug: hidden() },
        alreadySupplied: { packageSlug: "@acme/new-agent" },
        packageName: "@cinatra-ai/author-agent",
      }),
    ).toEqual([]);
  });

  it("still flags a hidden input the schema marks REQUIRED — the setup form skips it", () => {
    // execution.ts's `pendingFields` filter drops every `x-hidden` field before
    // it ever checks presence, so `required` does not get a hidden field
    // collected. Only a pre-supplied value satisfies it — proven by the
    // campaign orchestrators, which supply `campaignId` on the run rather than
    // through the form.
    const props = {
      campaignId: hidden(),
    };
    expect(
      findUnsatisfiableHiddenInputs({
        properties: props,
        alreadySupplied: {},
        packageName: "@acme/required-hidden-agent",
      }),
    ).toEqual([{ agent: "@acme/required-hidden-agent", input: "campaignId" }]);
    // ...and clears the moment the caller actually supplies it.
    expect(
      findUnsatisfiableHiddenInputs({
        properties: props,
        alreadySupplied: { campaignId: "c-1" },
        packageName: "@acme/required-hidden-agent",
      }),
    ).toEqual([]);
  });

  it("clears for an input the platform supplies", () => {
    for (const supplied of SUPPLIED) {
      expect(
        findUnsatisfiableHiddenInputs({
          properties: { [supplied]: hidden() },
          alreadySupplied: {},
          packageName: "@acme/platform-fed-agent",
        }),
        `${supplied} survives the loader into the start inputs`,
      ).toEqual([]);
    }
  });

  it("does NOT clear for the scrubbed run token", () => {
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { [PLATFORM_SUPPLIED_RUN_TOKEN_KEY]: hidden() },
        alreadySupplied: {},
        packageName: "@acme/token-declaring-agent",
      }),
    ).toEqual([
      { agent: "@acme/token-declaring-agent", input: PLATFORM_SUPPLIED_RUN_TOKEN_KEY },
    ]);
  });

  it("ignores VISIBLE inputs — only the hidden class is unsatisfiable", () => {
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { tone: { type: "string" } },
        alreadySupplied: {},
        packageName: "@acme/visible-agent",
      }),
    ).toEqual([]);
  });

  it("honours the bounded per-(package, input) exemption and nothing wider", () => {
    const probe = (packageName: string, input: string) =>
      findUnsatisfiableHiddenInputs({
        properties: { [input]: hidden() },
        alreadySupplied: {},
        packageName,
        packageVersion: null,
      });
    expect(probe("@cinatra-ai/email-drafting-agent", "confirmedRecipients")).toEqual([]);
    expect(probe("@cinatra-ai/email-drafting-agent", "somethingElse")).toHaveLength(1);
    expect(probe("@acme/copycat-agent", "confirmedRecipients")).toHaveLength(1);
  });

  it("names the agent without a version when the template carries none", () => {
    expect(
      findUnsatisfiableHiddenInputs({
        properties: { ghost: hidden() },
        alreadySupplied: {},
        packageName: "@acme/versionless-agent",
        packageVersion: null,
      }),
    ).toEqual([{ agent: "@acme/versionless-agent", input: "ghost" }]);
  });
});

describe("assertUnsatisfiableHiddenInputs — confirm before refuse", () => {
  const hidden = () => ({ type: "string", title: "x", "x-hidden": true });

  /**
   * A minimal mounted OAS declaring one input on the FLOW descriptor — the one
   * pyagentspec starts the conversation from, and therefore the one the confirm
   * step reads.
   */
  const oasWithHidden = (title: string, withDefault: boolean) => ({
    agentspec_version: "26.1.0",
    component_type: "Flow",
    inputs: [{ title, type: "string", ...(withDefault ? { default: "" } : {}) }],
    start_node: { $component_ref: "start" },
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        metadata: { cinatra: { hidden: [title] } },
        inputs: [
          { title, type: "string", ...(withDefault ? { default: "" } : {}) },
        ],
      },
    },
  });

  it("does NOT refuse when the stored schema lost a default the package's OAS declares", async () => {
    // A template installed before `oas-compiler.ts` carried `default` through
    // has a stored schema with no `default` key at all, so the stored view
    // alone cannot tell "the package declares none" from "the compiler of the
    // day dropped it". Re-reading the package's own OAS settles it, and a run
    // that would have succeeded is not killed.
    await expect(
      assertUnsatisfiableHiddenInputs({
        properties: { packageSlug: hidden() },
        alreadySupplied: {},
        packageName: "@acme/legacy-row-agent",
        packageVersion: "1.0.0",
        readOas: async () => oasWithHidden("packageSlug", true),
      }),
    ).resolves.toBeUndefined();
  });

  it("gives the benefit of the doubt when no OAS can be read", async () => {
    await expect(
      assertUnsatisfiableHiddenInputs({
        properties: { ghost: hidden() },
        alreadySupplied: {},
        packageName: "@acme/not-installed-agent",
        readOas: async () => null,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not refuse an input the stored schema invented but the Flow never declares", async () => {
    // A stored schema can carry a key the package's own OAS does not (a stale
    // row, a renamed input). The confirm step cannot corroborate it, so the run
    // proceeds: this guard turns a late runtime refusal into an early named
    // one, it never invents a new way for a working run to die.
    await expect(
      assertUnsatisfiableHiddenInputs({
        properties: { ghost: hidden() },
        alreadySupplied: {},
        packageName: "@acme/stale-row-agent",
        readOas: async () => oasWithHidden("somethingElse", false),
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses, naming the agent and the input, when the OAS confirms it", async () => {
    const failing = () =>
      assertUnsatisfiableHiddenInputs({
        properties: { packageSlug: hidden() },
        alreadySupplied: {},
        packageName: "@cinatra-ai/author-agent",
        packageVersion: "0.1.1",
        readOas: async () => oasWithHidden("packageSlug", false),
      });
    await expect(failing()).rejects.toThrow(/"packageSlug"/);
    await expect(failing()).rejects.toThrow(/@cinatra-ai\/author-agent@0\.1\.1/);
    await expect(failing()).rejects.toThrow(/missing inputs/);
    // The remedy the message offers must be one that actually works.
    await expect(failing()).rejects.toThrow(
      /Naming it in metadata\.cinatra\.required does NOT work/,
    );
    await expect(failing()).rejects.not.toThrow(
      /or name it in the start node's metadata\.cinatra\.required/,
    );
  });

  it("confirms against the FLOW descriptor, not the StartNode copy", async () => {
    // A default that exists only on the StartNode copy does not stop the
    // runtime demanding the input, so it must not clear the suspicion either.
    await expect(
      assertUnsatisfiableHiddenInputs({
        properties: { packageSlug: hidden() },
        alreadySupplied: {},
        packageName: "@acme/start-only-default-agent",
        packageVersion: "1.0.0",
        readOas: async () => ({
          agentspec_version: "26.1.0",
          component_type: "Flow",
          inputs: [{ title: "packageSlug", type: "string" }],
          start_node: { $component_ref: "start" },
          $referenced_components: {
            start: {
              component_type: "StartNode",
              id: "start",
              metadata: { cinatra: { hidden: ["packageSlug"] } },
              inputs: [{ title: "packageSlug", type: "string", default: "" }],
            },
          },
        }),
      }),
    ).rejects.toThrow(/"packageSlug"/);
  });

  it("clears once the caller supplies the value, without reading any OAS", async () => {
    let reads = 0;
    await expect(
      assertUnsatisfiableHiddenInputs({
        properties: { packageSlug: hidden() },
        alreadySupplied: { packageSlug: "@acme/target" },
        packageName: "@cinatra-ai/author-agent",
        packageVersion: "0.1.1",
        readOas: async () => {
          reads += 1;
          return oasWithHidden("packageSlug", false);
        },
      }),
    ).resolves.toBeUndefined();
    // The confirm read is paid ONLY on the path that is about to fail a run.
    expect(reads).toBe(0);
  });
});
