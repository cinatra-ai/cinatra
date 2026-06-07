import "server-only";
import { startUsageEventSubscriber } from "../event-subscriber";

export function createMetricsCostModule() {
  return {
    createDeterministicClient() {
      return null; // No MCP client needed
    },
    async registerCapabilities(_server: unknown) {
      startUsageEventSubscriber();
    },
  };
}
