"use client";
import { useState, type ComponentProps } from "react";
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import { ComposedDashboard } from "./composed-dashboard";

const EMPTY_CONFIG: DashboardConfigV1_1 = {
  portlets: [],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

export function DeskDashboardGrid() {
  const [config, setConfig] = useState<DashboardConfigV1_1>(EMPTY_CONFIG);

  return (
    <ComposedDashboard
      config={config as unknown as ComponentProps<typeof ComposedDashboard>["config"]}
      editable
      onConfigChange={
        ((next: unknown) => {
          setConfig(next as DashboardConfigV1_1);
        }) as ComponentProps<typeof ComposedDashboard>["onConfigChange"]
      }
      onSave={async (next) => {
        setConfig(next as unknown as DashboardConfigV1_1);
      }}
    />
  );
}
