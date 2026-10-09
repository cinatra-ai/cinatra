// @vitest-environment jsdom
/**
 * cinatra#3582 — A START FIELD AN AGENT DECLARES REQUIRED CANNOT BE PASSED BLANK.
 *
 * The issue: the Blog Idea Generator declares `brief` required (its StartNode
 * carries `metadata.cinatra.required: ["brief"]` and declares no `default` for
 * it), and the run's setup screen still let a person press Continue with the
 * box empty — the label even read "(optional)". The run then started, failed at
 * its first step, and no message named the field that was empty.
 *
 * This suite is the ENUMERATING one the issue's fifth acceptance item asks for:
 * ONE ROW PER START-FIELD KIND the renderer draws, so the contract is "no kind
 * submits a blank for a field that is not declared optional" rather than "the
 * two kinds one report named". The table is CLOSED AGAINST THE SOURCE at the
 * bottom of this file: the number of "(optional)" label sites in
 * schema-field-renderer.tsx must equal the number of rows here, so a kind added
 * later without a row fails this suite rather than first in a picture round.
 *
 * Three more arms ride the same table: the declared MINIMUM LENGTH on the four
 * text kinds that carry a Continue, the cinatra#3452 road (a required field
 * that declares a default is answered by that default, so an empty box still
 * submits), and the server + setup-loop arms, which drive the real
 * `approveReviewTaskInternal` and the real pending-field reading.
 *
 * This file asserts NO width, NO colour and NO layout — jsdom lays nothing out.
 * The drawing of the two states (Continue unavailable while the box is blank,
 * available once it is filled, in both palettes) is measured by the picture
 * round on a real run's setup screen, which this suite does not attempt.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/setup-required-start-field-is-gated-for-every-kind.test.tsx
 */
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Stub lucide-react so jsdom does not hit React-version mismatches.
// (Same pattern as schema-field-renderer-multiline.test.tsx.)
// ---------------------------------------------------------------------------
vi.mock("lucide-react", async (orig) => ({
  ...(await orig<typeof import("lucide-react")>()),
  ArrowRight: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "arrow-right", className }),
  LinkIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "link", className }),
  MailIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "mail", className }),
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUp: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  Check: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  CheckIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "check", className }),
  ChevronDownIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-down", className }),
  ChevronUpIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "chevron-up", className }),
  XIcon: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "x", className }),
  X: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "x", className }),
  Loader2: ({ className }: { className?: string }) =>
    React.createElement("span", { "data-icon": "loader2", className }),
}));

// ---------------------------------------------------------------------------
// The SERVER harness — the same mock shape approve-setup-field.test.ts uses, so
// the server arms below drive the REAL approveReviewTaskInternal rather than a
// restatement of its rule.
// ---------------------------------------------------------------------------
const dbWrites: Array<{ op: string; table: string; set: Record<string, unknown>; where: unknown }> = [];

const kernelAnswers = vi.hoisted(() => ({
  organization: { archivedAt: null as string | null, archiveEpoch: 0 } as
    | { archivedAt: string | null; archiveEpoch: number }
    | null,
  leaseHeld: false,
}));

const dbMock = vi.hoisted(() => {
  const state = { updateCalls: 0 };
  const update = () => {
    state.updateCalls += 1;
    return {
      set: (payload: Record<string, unknown>) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            (globalThis as { __dbWrites__?: unknown[] }).__dbWrites__?.push({
              op: "update",
              table: "agent_runs",
              set: payload,
              where: condition,
            });
            return [{ id: "updated-row" }];
          },
        }),
      }),
    };
  };
  return { state, baseTx: { update, execute: async () => ({ rows: [] }) } };
});
(globalThis as { __dbWrites__?: unknown[] }).__dbWrites__ = dbWrites;

vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

vi.mock("../db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import(
    "@cinatra-ai/org-write-kernel/testing"
  );
  const tx = wrapTxWithOrgWriteKernel(dbMock.baseTx, kernelAnswers);
  return {
    db: { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
    agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
  };
});

const bgJobs = vi.hoisted(() => ({
  enqueueBackgroundJob: vi.fn(),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("@/lib/background-jobs", () => bgJobs);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  writeHitlPrompt: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
}));

vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";
import { approveReviewTaskInternal } from "../review-task-actions";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

const BASE_CONTEXT = { connectedApps: [] as string[] };
const FIELD = "brief";

/**
 * ONE ROW PER DRAWN KIND, in the order the schema-driven fallback chain of
 * schema-field-renderer.tsx tests them. `drawnAt` names the lines that draw the
 * kind and its label, read from the branch chain itself. The registry-matched
 * road (schema-field-renderer.tsx:482-488) is NOT one of these kinds: a
 * renderer resolved from the registry owns its own drawing and its own submit.
 */
type KindRow = {
  kind: string;
  drawnAt: string;
  schema: Record<string, unknown>;
  /** Does this kind draw a Continue of its own? */
  drawsAContinue: boolean;
  /** The id of the control a real answer is typed into. */
  controlId: string;
  /** A real answer for this kind. */
  answer: string;
  /** The value a declared `default` carries for this kind, when it takes that arm. */
  declaredDefault?: unknown;
  /** The four text kinds that carry a Continue take the declared-minimum arm. */
  minimum?: { declared: number; tooShort: string; atLeast: string };
  /**
   * cinatra#3582 (convergence round) — the kinds whose control ALSO submits on
   * Enter (schema-field-renderer.tsx:635, :702, :740, :800). A bar that only
   * sits on the Continue is not a bar: the keyboard is a second door into the
   * same submit.
   */
  enterSubmits?: boolean;
};

const KINDS: KindRow[] = [
  {
    kind: "enum (Select)",
    drawnAt: "497-518, label 502 — no submit control of its own",
    schema: { type: "string", enum: ["alpha", "beta"] },
    drawsAContinue: false,
    controlId: `field-${FIELD}`,
    answer: "alpha",
  },
  {
    kind: "boolean (Checkbox)",
    drawnAt: "521-539, label 533 — no submit control of its own",
    schema: { type: "boolean" },
    drawsAContinue: false,
    controlId: `field-${FIELD}`,
    answer: "true",
  },
  {
    kind: "object single-text",
    drawnAt: "542-556 -> SingleTextObjectField, label 973, Continue 985",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      "x-object-text-property": "text",
    },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "a real brief sentence",
  },
  {
    kind: "object structured",
    drawnAt: "542-556 -> StructuredObjectField, label 1327, Continue 1378",
    schema: {
      type: "object",
      properties: { headline: { type: "string" } },
      required: ["headline"],
    },
    drawsAContinue: true,
    controlId: "field-headline",
    answer: "a real headline",
  },
  {
    kind: "object json",
    drawnAt: "542-556 -> JsonObjectField, label 1510, Continue 1529",
    schema: { type: "object" },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: '{"headline":"a real headline"}',
  },
  {
    kind: "number / integer",
    drawnAt: "575-609, label 586, Continue 602",
    schema: { type: "integer" },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "7",
    declaredDefault: 5,
    enterSubmits: true,
  },
  {
    kind: "array",
    drawnAt: "615-639, label 618, Continue 632",
    schema: { type: "array", items: { type: "string" } },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "one\ntwo",
    declaredDefault: [],
  },
  {
    kind: "string format uri",
    drawnAt: "643-677, label 648, Continue 670",
    schema: { type: "string", format: "uri" },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "https://example.com/a-real-page",
    enterSubmits: true,
    declaredDefault: "https://example.com/declared",
    minimum: {
      declared: 30,
      tooShort: "https://e.co",
      atLeast: "https://example.com/a-real-page",
    },
  },
  {
    kind: "string format email",
    drawnAt: "681-715, label 686, Continue 708",
    schema: { type: "string", format: "email" },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "a-real-person@example.com",
    enterSubmits: true,
    declaredDefault: "declared@example.com",
    minimum: {
      declared: 20,
      tooShort: "a@b.co",
      atLeast: "a-real-person@example.com",
    },
  },
  {
    kind: "string multi-line",
    drawnAt: "719-744, label 722, Continue 737",
    schema: { type: "string", "x-multiline": true },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "a real brief sentence",
    declaredDefault: "a declared default",
    minimum: { declared: 20, tooShort: "too short", atLeast: "a real brief sentence" },
  },
  {
    kind: "string single-line",
    drawnAt: "746-771, label 748, Continue 764",
    schema: { type: "string" },
    drawsAContinue: true,
    controlId: `field-${FIELD}`,
    answer: "a real brief sentence",
    enterSubmits: true,
    declaredDefault: "a declared default",
    minimum: { declared: 20, tooShort: "too short", atLeast: "a real brief sentence" },
  },
];

/**
 * Mount ONE field the way the run's setup screen mounts it: the per-field gate
 * hands the renderer the field's own schema and NO `required` prop, so the
 * declaration reaches the screen as the gate's `x-required` hint
 * (execution.ts, the per-field gate's buildArtifact).
 */
function mountField(
  schema: Record<string, unknown>,
  opts: { required?: boolean } = {},
) {
  const submits: unknown[] = [];
  const view = render(
    <SchemaFieldRenderer
      fieldName={FIELD}
      schema={schema}
      value={undefined}
      required={opts.required}
      onChange={(next: unknown) => {
        submits.push(next);
      }}
      context={BASE_CONTEXT}
    />,
  );
  return { submits, view };
}

function typeInto(controlId: string, value: string) {
  const el = document.getElementById(controlId);
  if (!el) throw new Error(`no control #${controlId} on screen`);
  fireEvent.change(el, { target: { value } });
}

/**
 * Let a press settle. Every Continue road here is async (the object legs flush
 * their sub-fields first), so "nothing was submitted" is only a true reading
 * once the chain the press started has finished.
 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function pressContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
}

/** The keyboard road into the same submit (Enter on the field's own control). */
function pressEnter(controlId: string) {
  const el = document.getElementById(controlId);
  if (!el) throw new Error(`no control #${controlId} on screen`);
  fireEvent.keyDown(el, { key: "Enter" });
}

/**
 * The renderer's own source, read from disk. Resolved from the working
 * directory rather than from `import.meta.url`, which the test runner does not
 * hand out as a `file:` URL.
 */
function readRendererSource(): string {
  const candidates = [
    path.resolve(process.cwd(), "src/schema-field-renderer.tsx"),
    path.resolve(process.cwd(), "packages/agents/src/schema-field-renderer.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`schema-field-renderer.tsx not found from ${process.cwd()}`);
}

function occurrencesOfOptional(text: string): number {
  return text.split("(optional)").length - 1;
}

afterEach(() => {
  cleanup();
});

describe("cinatra#3582 — every start-field kind refuses a blank for a field that is not declared optional", () => {
  for (const row of KINDS) {
    it(`${row.kind}: a required field (drawn at ${row.drawnAt}) does not submit a blank, and its label never reads (optional)`, async () => {
      const { submits, view } = mountField({ ...row.schema, "x-required": true });

      // The label of a field the agent declared required never calls it optional.
      expect(occurrencesOfOptional(view.container.textContent ?? "")).toBe(0);

      if (row.drawsAContinue) {
        pressContinue();
      } else {
        // The census fact for this kind: it draws no submit control of its own,
        // so a blank cannot be submitted from here at all.
        expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
      }
      await settle();
      expect(submits).toHaveLength(0);

      // ...and once the field carries a real answer the door opens.
      if (row.drawsAContinue) {
        typeInto(row.controlId, row.answer);
        pressContinue();
        await waitFor(() => {
          expect(submits).toHaveLength(1);
        });
      }
    });

    it(`${row.kind}: a field DECLARED OPTIONAL behaves exactly as it does today`, async () => {
      const { submits } = mountField(row.schema, { required: false });

      if (!row.drawsAContinue) {
        expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
        expect(submits).toHaveLength(0);
        return;
      }
      pressContinue();
      await waitFor(() => {
        expect(submits).toHaveLength(1);
      });
    });

    if (row.minimum) {
      const min = row.minimum;
      it(`${row.kind}: a declared minimum length of ${min.declared} is honoured on the screen`, async () => {
        const { submits } = mountField({
          ...row.schema,
          "x-required": true,
          minLength: min.declared,
        });

        typeInto(row.controlId, min.tooShort);
        pressContinue();
        await settle();
        expect(submits).toHaveLength(0);
        // The field draws the reading in the line it already has for one.
        expect(
          screen.queryByText(new RegExp(`at least ${min.declared} characters`, "i")),
        ).not.toBeNull();

        typeInto(row.controlId, min.atLeast);
        pressContinue();
        await waitFor(() => {
          expect(submits).toHaveLength(1);
        });
      });
    }

    if (row.enterSubmits) {
      it(`${row.kind}: the ENTER road takes the SAME bar as the Continue`, async () => {
        const { submits } = mountField({
          ...row.schema,
          "x-required": true,
          ...(row.minimum ? { minLength: row.minimum.declared } : {}),
        });

        // Blank: the keyboard submits nothing, exactly as the Continue does not.
        pressEnter(row.controlId);
        await settle();
        expect(submits).toHaveLength(0);

        if (row.minimum) {
          // Shorter than the declared minimum: the same refusal on this road.
          typeInto(row.controlId, row.minimum.tooShort);
          pressEnter(row.controlId);
          await settle();
          expect(submits).toHaveLength(0);
        }

        // A real answer goes through on the keyboard road as it always did.
        typeInto(row.controlId, row.minimum ? row.minimum.atLeast : row.answer);
        pressEnter(row.controlId);
        await waitFor(() => {
          expect(submits).toHaveLength(1);
        });
      });
    }

    if (row.declaredDefault !== undefined) {
      it(`${row.kind}: cinatra#3452 — a required field that DECLARES A DEFAULT still submits from an empty box`, async () => {
        const { submits } = mountField({
          ...row.schema,
          "x-required": true,
          default: row.declaredDefault,
        });
        pressContinue();
        await waitFor(() => {
          expect(submits).toHaveLength(1);
        });
      });
    }
  }

  it("the table is CLOSED against the source: one row per (optional) label site in schema-field-renderer.tsx", () => {
    const source = readRendererSource();
    expect(occurrencesOfOptional(source)).toBe(KINDS.length);
    expect(KINDS).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// THE SERVER ARMS — whatever a client sent, the approval road refuses a blank
// answer for a declared-required field, and a value shorter than a declared
// minimum, with a reading that names the field.
// ---------------------------------------------------------------------------
describe("cinatra#3582 — approveReviewTaskInternal refuses a blank answer for a required field", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbWrites.length = 0;
    dbMock.state.updateCalls = 0;
    kernelAnswers.organization = { archivedAt: null, archiveEpoch: 0 };
    vi.mocked(resolveOrgRoleForUser).mockResolvedValue("member");
  });

  function armRun(
    runId: string,
    properties: Record<string, Record<string, unknown>>,
    required: string[],
    inputParams: Record<string, unknown> = {},
  ) {
    storeMock.readAgentRunById.mockResolvedValue({
      id: runId,
      templateId: `tpl-${runId}`,
      status: "pending_approval",
      inputParams,
    });
    storeMock.readAgentTemplateById.mockResolvedValue({
      id: `tpl-${runId}`,
      inputSchema: { type: "object", required, properties },
    });
  }

  it("refuses an EMPTY STRING submitted for a declared-required field with no default, naming that field", async () => {
    armRun("run-blank1", { brief: { type: "string" } }, ["brief"]);

    await expect(
      approveReviewTaskInternal("setup-run-blank1", "actor-1", { brief: "" }, "brief"),
    ).rejects.toThrow(/brief/);

    expect(dbWrites).toHaveLength(0);
    expect(bgJobs.enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("refuses a WHITESPACE-ONLY value for a declared-required field, naming that field", async () => {
    armRun("run-blank2", { brief: { type: "string" } }, ["brief"]);

    await expect(
      approveReviewTaskInternal("setup-run-blank2", "actor-1", { brief: "   " }, "brief"),
    ).rejects.toThrow(/brief/);
    expect(dbWrites).toHaveLength(0);
  });

  it("refuses an EMPTY LIST for a declared-required array field, naming that field", async () => {
    armRun("run-blank3", { topics: { type: "array" } }, ["topics"]);

    await expect(
      approveReviewTaskInternal("setup-run-blank3", "actor-1", { topics: [] }, "topics"),
    ).rejects.toThrow(/topics/);
    expect(dbWrites).toHaveLength(0);
  });

  it("cinatra#3452 stands: a required field that declares a DEFAULT is satisfied by that default when submitted blank", async () => {
    armRun("run-blank4", { ideaCount: { type: "integer", default: 5 } }, ["ideaCount"]);

    await approveReviewTaskInternal(
      "setup-run-blank4",
      "actor-1",
      { ideaCount: "" },
      "ideaCount",
    );

    expect(dbWrites.find((w) => w.set?.status === "queued")).toBeDefined();
  });

  it("cinatra#3452 stands: a DECLARED-OPTIONAL field submitted blank is settled, not refused", async () => {
    armRun("run-blank5", { note: { type: "string" } }, ["brief"]);

    await approveReviewTaskInternal("setup-run-blank5", "actor-1", { note: "" }, "note");

    expect(dbWrites.find((w) => w.set?.status === "queued")).toBeDefined();
  });

  it("refuses a value SHORTER than the declared minimum length, naming the field and the minimum", async () => {
    armRun("run-min1", { brief: { type: "string", minLength: 20 } }, ["brief"]);

    await expect(
      approveReviewTaskInternal("setup-run-min1", "actor-1", { brief: "too short" }, "brief"),
    ).rejects.toThrow(/brief[\s\S]*20|20[\s\S]*brief/);
    expect(dbWrites).toHaveLength(0);
  });

  it("accepts a value AT the declared minimum length", async () => {
    armRun("run-min2", { brief: { type: "string", minLength: 20 } }, ["brief"]);

    await approveReviewTaskInternal(
      "setup-run-min2",
      "actor-1",
      { brief: "a real brief sentence" },
      "brief",
    );

    expect(dbWrites.find((w) => w.set?.inputParams !== undefined)).toBeDefined();
  });

  it("THE GROUPED ROAD: a blank answer for a declared-required field is refused there too", async () => {
    armRun("run-grp1", { brief: { type: "string" }, note: { type: "string" } }, ["brief"]);

    await expect(
      approveReviewTaskInternal("setup-run-grp1", "actor-1", { brief: "", note: "ok" }),
    ).rejects.toThrow(/brief/);
    expect(dbWrites).toHaveLength(0);
  });

  it("THE GROUPED ROAD: a value shorter than the declared minimum is refused there too", async () => {
    armRun("run-grp2", { brief: { type: "string", minLength: 20 } }, ["brief"]);

    await expect(
      approveReviewTaskInternal("setup-run-grp2", "actor-1", { brief: "too short" }),
    ).rejects.toThrow(/brief/);
    expect(dbWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE SETUP-LOOP ARMS — a pre-supplied blank value is not an answer, so the run
// still parks on the setup screen and asks for the field.
// ---------------------------------------------------------------------------
describe("cinatra#3582 — a pre-supplied blank value still asks", () => {
  it("a required field the run already carries BLANK is still pending", async () => {
    const { setupFieldIsAlreadyAnswered } = await import("../execution");
    expect(setupFieldIsAlreadyAnswered({ type: "string" }, { brief: "" }, "brief")).toBe(false);
    expect(setupFieldIsAlreadyAnswered({ type: "string" }, { brief: "   " }, "brief")).toBe(false);
    expect(setupFieldIsAlreadyAnswered({ type: "array" }, { topics: [] }, "topics")).toBe(false);
  });

  it("a required field the run carries with a REAL answer is not asked again", async () => {
    const { setupFieldIsAlreadyAnswered } = await import("../execution");
    expect(setupFieldIsAlreadyAnswered({ type: "string" }, { brief: "a real brief" }, "brief")).toBe(true);
    expect(setupFieldIsAlreadyAnswered({ type: "integer" }, { count: 0 }, "count")).toBe(true);
    expect(setupFieldIsAlreadyAnswered({ type: "boolean" }, { flag: false }, "flag")).toBe(true);
  });

  it("a field that DECLARES A DEFAULT is answered by that default and is not asked", async () => {
    const { setupFieldIsAlreadyAnswered } = await import("../execution");
    expect(
      setupFieldIsAlreadyAnswered({ type: "string", default: "" }, { brief: "" }, "brief"),
    ).toBe(true);
  });

  it("a required field the run does not carry at all is pending, exactly as it is today", async () => {
    const { setupFieldIsAlreadyAnswered } = await import("../execution");
    expect(setupFieldIsAlreadyAnswered({ type: "string" }, {}, "brief")).toBe(false);
  });
});
