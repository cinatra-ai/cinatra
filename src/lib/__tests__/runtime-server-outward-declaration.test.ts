/**
 * A tool whose registration declares that it acts outward, called through the
 * runtime server on an agent run's frame (cinatra#3745).
 *
 * The runtime server plans every registration once, and its call-time wrapper
 * hands the boundary `declaresOutward` from that planned entry. On an agent
 * run's frame the boundary then holds a declared tool exactly as it holds a
 * tool of its name list, and the tool's handler is not invoked.
 *
 * These cases drive the real `createMcpRuntimeServer` choke point, the real
 * capability plan and the real `enforceMcpBoundary`. Only the audit writer,
 * the classification reader and the extension-registry reader are test
 * doubles; every double is restored after each case. The server's lazy import
 * of the boundary resolves in this root tier.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionMcpToolConfig } from "@cinatra-ai/sdk-extensions/mcp-contract";
import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { createMcpRuntimeServer } from "../../../packages/mcp-server/src/runtime-server";
import {
  mcpRequestContextStorage,
  type McpRequestContext,
} from "../../../packages/mcp-server/src/request-context";

const REASON = "outward_effect_requires_recorded_decision";

// An invented tool name outside the rule's name list.
const TOOL = "example_outward_tool";

const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;

const runMemberFrame = (): McpRequestContext =>
  ({ orgId: "org-1", userId: "user-1", runId: "run-1" }) as McpRequestContext;

type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

/**
 * Build a runtime server holding one tool registered with `config`, and return
 * a function that calls it inside `frame` plus the record of handler calls.
 */
async function buildOneTool(config: unknown) {
  const handled: string[] = [];
  const runtime = await createMcpRuntimeServer({
    name: "outward-declaration-test",
    version: "0.0.0",
    registerCapabilities: (toolServer) => {
      (
        toolServer.registerTool as unknown as (
          n: string,
          c: unknown,
          h: (...a: unknown[]) => unknown,
        ) => unknown
      )(TOOL, config, async () => {
        handled.push(TOOL);
        return { content: [{ type: "text", text: "served" }] };
      });
    },
  });
  const registry = (
    runtime as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
    }
  )._registeredTools;
  const entry = registry[TOOL];
  if (!entry) throw new Error(`"${TOOL}" is not registered`);
  return {
    handled,
    call: async (frame: McpRequestContext): Promise<ToolResult> =>
      (await mcpRequestContextStorage.run(frame, () => entry.handler({}, {}))) as ToolResult,
  };
}

describe("the runtime server hands the boundary the outward declaration of the planned entry", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => (name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)));
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("answers a tool whose registration declares outward with the named reason on a run's frame, without invoking its handler", async () => {
    const config = {
      title: TOOL,
      description: TOOL,
      outward: {},
    } satisfies ExtensionMcpToolConfig;
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });

  it("serves the same tool registered without the declaration on a run's frame by the boundary's other rules", async () => {
    const config = { title: TOOL, description: TOOL } satisfies ExtensionMcpToolConfig;
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toBe("served");
    expect(built.handled).toEqual([TOOL]);
  });

  it("answers a tool whose registration declares a value the host cannot read with the named reason on a run's frame", async () => {
    const built = await buildOneTool({ title: TOOL, description: TOOL, outward: "yes" });
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });

  it("decides with the declaration read at registration, whatever a later read of the config answers", async () => {
    let reads = 0;
    const config: Record<string, unknown> = { title: TOOL, description: TOOL };
    Object.defineProperty(config, "outward", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? {} : undefined;
      },
    });
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });
});
