import { describe, expect, it } from "vitest";
import { runWithPreparedMcpClients } from "./helpers/prepared-mcp-clients";
import type { ConnectorInstanceMcpClientFactory } from "@/lib/connector-instance-mcp-transport";

const peer = { endpoint: "http://fixture.invalid/mcp", authHeader: "fixture-only" };

describe("prepared live-fixture MCP clients", () => {
  it("serializes session writes while all nine tool calls overlap, then closes in order", async () => {
    const events: string[] = [];
    let serial = 0;
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const create: ConnectorInstanceMcpClientFactory = () => {
      const id = serial++;
      return {
        connect: async () => { events.push(`connect:${id}`); },
        callTool: async () => {
          events.push(`call:${id}`);
          active += 1; peak = Math.max(peak, active);
          if (active === 9) release();
          await barrier;
          active -= 1;
          events.push(`done:${id}`);
          return id;
        },
        close: async () => { expect(active).toBe(0); events.push(`close:${id}`); },
      };
    };
    const result = await runWithPreparedMcpClients(peer, 9, async (factory) => {
      const client = factory(peer);
      await client.connect();
      const value = await client.callTool({ name: "read", arguments: {} });
      await client.close();
      return value;
    }, create);
    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(9);
    expect(events.slice(0, 9)).toEqual(result.map((id) => `connect:${id}`));
    expect(events.slice(-9)).toEqual(result.map((id) => `close:${id}`));
  });

  it("waits for surviving calls before cleanup and preserves a failed invocation", async () => {
    const failure = new Error("real provider error");
    const events: string[] = [];
    let serial = 0;
    const create: ConnectorInstanceMcpClientFactory = () => {
      const id = serial++;
      return { connect: async () => {}, callTool: async () => {}, close: async () => { events.push(`close:${id}`); } };
    };
    await expect(runWithPreparedMcpClients(peer, 2, async (_factory, index) => {
      if (index === 0) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push("survivor:done");
    }, create)).rejects.toBe(failure);
    expect(events).toEqual(["survivor:done", "close:0", "close:1"]);
  });

  it("cleans up partial preparation and never invokes after a handshake failure", async () => {
    const failure = new Error("handshake refused");
    const closed: number[] = [];
    let serial = 0;
    let invoked = false;
    const create: ConnectorInstanceMcpClientFactory = () => {
      const id = serial++;
      return {
        connect: async () => { if (id === 1) throw failure; },
        callTool: async () => {},
        close: async () => { closed.push(id); },
      };
    };
    await expect(runWithPreparedMcpClients(peer, 9, async () => { invoked = true; }, create)).rejects.toBe(failure);
    expect(invoked).toBe(false);
    expect(closed).toEqual([0, 1]);
  });

  it("refuses a different peer without exposing credentials", async () => {
    const create: ConnectorInstanceMcpClientFactory = () => ({ connect: async () => {}, callTool: async () => {}, close: async () => {} });
    await expect(runWithPreparedMcpClients(peer, 1, async (factory) => {
      factory({ ...peer, authHeader: "other-private-value" });
    }, create)).rejects.toThrow("different peer");
  });
  it("returns a fresh client for the transport's second attempt instead of reusing the prepared session", async () => {
    const connected: number[] = [];
    const closed: number[] = [];
    let serial = 0;
    const create: ConnectorInstanceMcpClientFactory = () => {
      const id = serial++;
      return {
        connect: async () => { connected.push(id); },
        callTool: async () => id,
        close: async () => { closed.push(id); },
      };
    };
    const result = await runWithPreparedMcpClients(peer, 1, async (factory) => {
      const prepared = factory(peer);
      await prepared.connect();
      await prepared.close();
      const fresh = factory(peer);
      expect(fresh).not.toBe(prepared);
      await fresh.connect();
      const value = await fresh.callTool({ name: "read", arguments: {} });
      await fresh.close();
      return value;
    }, create);
    expect(result).toEqual([1]);
    expect(connected).toEqual([0, 1]);
    expect(closed).toEqual([1, 0]);
  });

  it("surfaces failed cleanup after successful invocations and still closes every client", async () => {
    const failure = new Error("close failed");
    const closed: number[] = [];
    let serial = 0;
    const create: ConnectorInstanceMcpClientFactory = () => {
      const id = serial++;
      return {
        connect: async () => {},
        callTool: async () => id,
        close: async () => { closed.push(id); if (id === 0) throw failure; },
      };
    };
    const outcome = runWithPreparedMcpClients(peer, 2, async () => "ok", create);
    await expect(outcome).rejects.toMatchObject({ message: "Fixture session cleanup failed", errors: [failure] });
    expect(closed).toEqual([0, 1]);
  });

});
