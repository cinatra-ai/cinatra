import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createMcpRuntimeServer } from "../runtime-server";
import { delegatedChatAllowedToolNames } from "../delegated-chat-tool-policy";

// The registration CHOKE POINT, exercised through the real runtime server
// (cinatra#2771).
//
// `policedRegisterTool` is the one place BOTH registration paths converge: a
// manifest-discovered connector calls `server.registerTool(name, config,
// handler)` directly, and a `ctx.mcp.registerTool` extension arrives via the
// replay in `@/lib/mcp-server`, which rebuilds a config and now carries the
// declaration on it. Reading the declaration here is what makes it binding on
// both without a second registration walk (the walk itself is #2817's).
//
// The observable used below is the choke point's own return value: a REFUSED
// registration returns `undefined` and never reaches the SDK server, so the
// tool is invisible to `tools/list` and unresolvable by `tools/call`. An
// ACCEPTED one returns the SDK's registered-tool handle. That is a direct read
// of the decision, not a proxy for it.

const ADMITTED = delegatedChatAllowedToolNames()[0]!;
const DENIED_FAMILY = "permissions_grant_list";
const DENIED_VERB = "objects_delete";
const UNLISTED = "acme_widget_catalog_list";

/**
 * Register `(name, config)` through a real delegated-chat runtime server and
 * report whether the choke point admitted it.
 */
async function registers(name: string, config: Record<string, unknown>): Promise<boolean> {
  // Descriptors, not a spread: a spread READS every own property, which would
  // invoke a throwing accessor here in the harness instead of at the choke
  // point — the exact thing the hostile-accessor case below needs to observe.
  const merged = Object.defineProperties(
    { title: name, description: name, inputSchema: z.object({}) } as Record<string, unknown>,
    Object.getOwnPropertyDescriptors(config),
  );
  let outcome = false;
  await createMcpRuntimeServer({
    name: "test",
    version: "0.0.0",
    toolPolicyMode: "delegated-chat",
    registerCapabilities: (server) => {
      const handle = (
        server.registerTool as unknown as (
          n: string,
          c: unknown,
          h: (...a: unknown[]) => unknown,
        ) => unknown
      )(name, merged, () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      outcome = handle != null;
    },
  });
  return outcome;
}

describe("the declaration choke point: absent declarations change nothing", () => {
  it("registers an admitted primitive that declares nothing", async () => {
    // Every registration in the tree today. Still the behavior-identity proof,
    // but it now proves a different mechanism: since the owner's ruling a
    // MISSING declaration means `none`, so this only stays green because the
    // choke point resolves the class through the interim shim first. If it read
    // the config raw, every primitive on the chat surface would be refused
    // here.
    await expect(registers(ADMITTED, {})).resolves.toBe(true);
  });

  it("still refuses the names the policy always refused, undeclared", async () => {
    await expect(registers(DENIED_FAMILY, {})).resolves.toBe(false);
    await expect(registers(DENIED_VERB, {})).resolves.toBe(false);
    await expect(registers(UNLISTED, {})).resolves.toBe(false);
  });
});

describe("the declaration choke point: a declaration NARROWS", () => {
  it("withdraws an admitted primitive that declares `none`", async () => {
    await expect(registers(ADMITTED, { delegatedChat: "none" })).resolves.toBe(false);
  });

  it("withdraws an admitted primitive whose declaration is MALFORMED", async () => {
    // Fail-closed toward narrowing: a value the host cannot read must not be
    // re-read as "undeclared", which is neutral and would leave it exposed.
    await expect(registers(ADMITTED, { delegatedChat: "superuser" })).resolves.toBe(false);
    await expect(registers(ADMITTED, { delegatedChat: 42 })).resolves.toBe(false);
    await expect(registers(ADMITTED, { delegatedChat: {} })).resolves.toBe(false);
  });

  it("keeps an admitted primitive that declares a chat-eligible class", async () => {
    for (const cls of ["read", "discovery", "dispatch"]) {
      await expect(registers(ADMITTED, { delegatedChat: cls })).resolves.toBe(true);
    }
  });

  it("withdraws an admitted primitive whose declaration THROWS on read", async () => {
    // `config` is connector-supplied, so reading `config.delegatedChat` can
    // execute connector code. Two things are asserted at once here, through the
    // real server: the throw does not escape the registration pass (this test
    // would reject rather than resolve), and the name is REFUSED — an
    // unreadable declaration is the malformed case, so it must not fall through
    // to the interim shim and be handed a chat-eligible class for being
    // hostile.
    const config: Record<string, unknown> = {};
    Object.defineProperty(config, "delegatedChat", {
      enumerable: true,
      get() {
        throw new Error("hostile accessor");
      },
    });
    await expect(registers(ADMITTED, config)).resolves.toBe(false);
  });
});

describe("the declaration choke point: a declaration NEVER widens", () => {
  it("cannot admit a denied family, a denied verb, or an unlisted name", async () => {
    // The ordering inside the choke point is the guarantee: host admission is
    // evaluated first and a declaration is only consulted to REMOVE. If this
    // ever goes green-to-red it means a connector's self-classification became
    // sufficient authorization, which is the exact failure the ruling forbids.
    for (const cls of ["read", "discovery", "dispatch", "none"]) {
      await expect(registers(DENIED_FAMILY, { delegatedChat: cls })).resolves.toBe(false);
      await expect(registers(DENIED_VERB, { delegatedChat: cls })).resolves.toBe(false);
      await expect(registers(UNLISTED, { delegatedChat: cls })).resolves.toBe(false);
    }
  });
});

describe("the declaration choke point: other policy modes are untouched", () => {
  it("an unrestricted server ignores the declaration entirely", async () => {
    // The declaration is a DELEGATED-CHAT channel. An unrestricted build (the
    // operator's own MCP client, agent runs) registers everything as before —
    // a connector must not be able to hide a primitive from the full surface
    // by declaring `none` for chat.
    let registered = false;
    await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      registerCapabilities: (server) => {
        const handle = (
          server.registerTool as unknown as (n: string, c: unknown, h: () => unknown) => unknown
        )(DENIED_VERB, { title: "t", inputSchema: z.object({}), delegatedChat: "none" }, () => ({
          content: [{ type: "text", text: "ok" }],
        }));
        registered = handle != null;
      },
    });
    expect(registered).toBe(true);
  });

  it("the delegated-widget perimeter stays closed and declaration-blind", async () => {
    // The widget policy is its own kind-keyed allowlist. A connector must not
    // be able to influence it in EITHER direction — declaring `read` must not
    // open it, which is what this asserts.
    let registered = false;
    await createMcpRuntimeServer({
      name: "test",
      version: "0.0.0",
      toolPolicyMode: "delegated-widget",
      widgetDelegationKind: "wordpress",
      registerCapabilities: (server) => {
        const handle = (
          server.registerTool as unknown as (n: string, c: unknown, h: () => unknown) => unknown
        )(ADMITTED, { title: "t", inputSchema: z.object({}), delegatedChat: "read" }, () => ({
          content: [{ type: "text", text: "ok" }],
        }));
        registered = handle != null;
      },
    });
    expect(registered).toBe(false);
  });
});
