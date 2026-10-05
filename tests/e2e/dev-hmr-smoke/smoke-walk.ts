export type ConnectorDescriptor = { packageId: string; slug: string; setupSubroute: string };
export type SmokePhase = "precompile" | "warm" | "post-recompile";

export const SMOKE_WALK_BUDGET_MS = 540_000;

export function selectConnectorSetupRoutes(descriptors: readonly ConnectorDescriptor[]): string[] {
  // The first two distinct paths in lexical order: stable across catalog order
  // changes, with no connector-specific preference or unbounded environment knob.
  return [...new Set(descriptors
    .map((d) => `/connectors/${d.packageId.replace(/^@/, "").split("/")[0]}/${d.slug}/${d.setupSubroute}`))]
    .sort()
    .slice(0, 2);
}

export type SmokeVisit = {
  phase: SmokePhase;
  route: string;
  state: "start" | "passed" | "failed";
  budgetMs: number;
  elapsedMs?: number;
  failure?: string;
};

export async function walkSmokeSurfaces(options: {
  phase: SmokePhase;
  routes: readonly string[];
  deadline: number;
  visitedRoutes: Set<string>;
  now: () => number;
  check: (route: string, timeoutMs: number) => Promise<string | null>;
  report: (visit: SmokeVisit) => void;
}): Promise<string[]> {
  const failures: string[] = [];
  for (const route of options.routes) {
    const started = options.now();
    const remainingMs = options.deadline - started;
    if (remainingMs <= 0) {
      const failure = "total smoke budget exhausted before navigation";
      options.report({ phase: options.phase, route, state: "failed", budgetMs: 0, elapsedMs: 0, failure });
      failures.push(`[${options.phase}] ${route}: ${failure}`);
      break;
    }
    const coldFirstVisit = options.phase !== "post-recompile" && !options.visitedRoutes.has(route);
    const budgetMs = Math.min(remainingMs, coldFirstVisit ? 180_000 : 90_000);
    options.visitedRoutes.add(route);
    options.report({ phase: options.phase, route, state: "start", budgetMs });
    let problem: string | null;
    try {
      problem = await options.check(route, budgetMs);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const elapsedMs = options.now() - started;
    options.report({ phase: options.phase, route, state: problem ? "failed" : "passed", budgetMs, elapsedMs, ...(problem ? { failure: problem } : {}) });
    if (problem) {
      failures.push(`[${options.phase}] ${route} after ${elapsedMs}ms: ${problem}`);
      break;
    }
  }
  return failures;
}
