import { describe, it, expect, beforeEach } from "vitest";
import {
  getExtensionConnectorConfig,
  setExtensionConnectorConfig,
  deleteExtensionConnectorConfig,
  setExtensionConnectorConfigStore,
  _resetExtensionConnectorConfigStoreForTests,
} from "../connector-config";

describe("connector-config — generic, host-binds-once accessor", () => {
  beforeEach(() => {
    _resetExtensionConnectorConfigStoreForTests();
  });

  it("fails CLOSED (throws) when the host has not wired a store", () => {
    expect(() => getExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "k", null)).toThrow(
      /wired the connector-config store/,
    );
    expect(() => setExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "k", 1)).toThrow(
      /wired the connector-config store/,
    );
    expect(() => deleteExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "k")).toThrow(
      /wired the connector-config store/,
    );
  });

  it("delegates get/set/delete to the wired store with the exact packageId + key", () => {
    const store = new Map<string, unknown>();
    const calls: Array<{ op: string; packageId: string; key: string }> = [];
    setExtensionConnectorConfigStore({
      get<T>(packageId: string, key: string, fallback: T): T {
        calls.push({ op: "get", packageId, key });
        return (store.has(key) ? (store.get(key) as T) : fallback);
      },
      set(packageId: string, key: string, value: unknown): void {
        calls.push({ op: "set", packageId, key });
        store.set(key, value);
      },
      delete(packageId: string, key: string): void {
        calls.push({ op: "delete", packageId, key });
        store.delete(key);
      },
    });

    expect(
      getExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "linkedin_connection", { x: 0 }),
    ).toEqual({ x: 0 });
    setExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "linkedin_connection", { x: 1 });
    expect(
      getExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "linkedin_connection", { x: 0 }),
    ).toEqual({ x: 1 });
    deleteExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "linkedin_connection");
    expect(
      getExtensionConnectorConfig("@cinatra-ai/linkedin-connector", "linkedin_connection", { x: -1 }),
    ).toEqual({ x: -1 });

    expect(calls.map((c) => `${c.op}:${c.packageId}:${c.key}`)).toEqual([
      "get:@cinatra-ai/linkedin-connector:linkedin_connection",
      "set:@cinatra-ai/linkedin-connector:linkedin_connection",
      "get:@cinatra-ai/linkedin-connector:linkedin_connection",
      "delete:@cinatra-ai/linkedin-connector:linkedin_connection",
      "get:@cinatra-ai/linkedin-connector:linkedin_connection",
    ]);
  });
});
