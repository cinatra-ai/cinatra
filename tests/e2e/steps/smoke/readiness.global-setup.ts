/**
 * Probe, once and before any worker starts, whether the steps smoke can run
 * here: a browser that launches, and a development server whose health route
 * answers 200. Each answer goes into the environment the workers inherit (see
 * `readiness.ts`), and every test of the smoke skips by name on a missing one.
 *
 * It always probes and never inherits: a reading left in the environment by an
 * earlier run says nothing about this one.
 */
import { chromium, type FullConfig } from "@playwright/test";

import { READY, STEPS_BROWSER_ENV, STEPS_SERVER_ENV } from "./readiness";

/** How long the health route is given to answer. */
const SERVER_PROBE_MS = 5_000;

function classOf(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

async function browserReading(): Promise<string> {
  try {
    const browser = await chromium.launch();
    await browser.close();
    return READY;
  } catch (error) {
    return `none could be launched here (${classOf(error)})`;
  }
}

async function serverReading(baseURL: string | undefined): Promise<string> {
  if (!baseURL) return "the config names no base address";
  try {
    const response = await fetch(new URL("/api/health", baseURL), { signal: AbortSignal.timeout(SERVER_PROBE_MS) });
    return response.status === 200 ? READY : `its health route answered ${response.status}, so it is not ready`;
  } catch (error) {
    return `nothing answered its health route (${classOf(error)})`;
  }
}

export default async function probeStepsReadiness(config: FullConfig): Promise<void> {
  const baseURL = config.projects.find((project) => project.use.baseURL)?.use.baseURL;
  process.env[STEPS_BROWSER_ENV] = await browserReading();
  process.env[STEPS_SERVER_ENV] = await serverReading(baseURL);
  console.log(`[steps smoke] browser: ${process.env[STEPS_BROWSER_ENV]}; development server: ${process.env[STEPS_SERVER_ENV]}`);
}
