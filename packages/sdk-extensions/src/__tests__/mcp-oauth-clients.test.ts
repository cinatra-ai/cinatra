import { describe, it, expect, beforeEach } from "vitest";
import {
  listExternalMcpOAuthClients,
  deleteExternalMcpOAuthClient,
  setExtensionMcpOAuthClientStore,
  _resetExtensionMcpOAuthClientStoreForTests,
  type ExternalMcpOAuthClient,
} from "../mcp-oauth-clients";

describe("mcp-oauth-clients — host-binds-once OAuth-client store", () => {
  beforeEach(() => {
    _resetExtensionMcpOAuthClientStoreForTests();
  });

  it("fails CLOSED (rejects) when the host has not wired a store", async () => {
    await expect(listExternalMcpOAuthClients()).rejects.toThrow(
      /wired the MCP OAuth-client store/,
    );
    await expect(deleteExternalMcpOAuthClient("abc")).rejects.toThrow(
      /wired the MCP OAuth-client store/,
    );
  });

  it("delegates list/delete to the wired store with the exact clientId", async () => {
    const client: ExternalMcpOAuthClient = {
      id: "row-1",
      clientId: "client-1",
      name: "Claude Desktop",
      redirectURLs: ["http://localhost:33418/callback"],
      createdAt: new Date("2026-01-02T03:04:05Z"),
      updatedAt: null,
    };
    const deleted: string[] = [];
    setExtensionMcpOAuthClientStore({
      listExternalClients: async () => [client],
      deleteClient: async (clientId) => {
        deleted.push(clientId);
      },
    });

    await expect(listExternalMcpOAuthClients()).resolves.toEqual([client]);
    await deleteExternalMcpOAuthClient("client-1");
    expect(deleted).toEqual(["client-1"]);
  });
});
