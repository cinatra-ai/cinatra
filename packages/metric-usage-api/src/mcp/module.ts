import { registerMetricUsagePrimitives } from "./registry";

export function createMetricUsageMcpModule() {
  return {
    registerCapabilities: registerMetricUsagePrimitives,
  };
}
