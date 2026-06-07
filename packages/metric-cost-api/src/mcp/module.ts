import { registerMetricCostPrimitives } from "./registry";

export function createMetricCostMcpModule() {
  return {
    registerCapabilities: registerMetricCostPrimitives,
  };
}
