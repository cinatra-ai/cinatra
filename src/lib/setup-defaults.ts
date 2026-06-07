import "server-only";

import { hostname, platform } from "node:os";
import { spawnSync } from "node:child_process";

export type SetupNameDefaults = {
  /** Pre-fill for the "Instance display name" input. May be empty string. */
  instanceDisplayName: string;
  /** Pre-fill for the "Instance namespace" input. May be empty string. */
  instanceNamespace: string;
};

const NAMESPACE_MAX_LEN = 39;
const NAMESPACE_MIN_LEN = 2;

/**
 * In dev mode (NODE_ENV !== "production"), compute sensible defaults for
 * /setup/name based on the friendly device name + the current git branch +
 * the current date and time.
 *
 * Display name: `<Device> · <branch> · YYYY-MM-DD HH:MM:SS`
 * Namespace:   `<device>-<branch>-YYMMDD-HHMMSS` (sanitized, hostname
 *              truncated if needed; timestamp and branch are never cut).
 *
 * Returns empty strings in production OR when both probes fail. Never throws.
 */
export function getSetupNameDefaults(): SetupNameDefaults {
  if (process.env.NODE_ENV === "production") {
    return { instanceDisplayName: "", instanceNamespace: "" };
  }

  const device = friendlyDeviceName();
  const branch = safeGitBranch();
  const now = new Date();

  if (!device && !branch) {
    return { instanceDisplayName: "", instanceNamespace: "" };
  }

  return {
    instanceDisplayName: buildDisplayName(device, branch, now),
    instanceNamespace: buildNamespace(device, branch, now),
  };
}

function buildDisplayName(device: string, branch: string, now: Date): string {
  const parts = [device, branch, formatHumanTimestamp(now)].filter(Boolean);
  return parts.join(" · ");
}

function buildNamespace(device: string, branch: string, now: Date): string {
  const compactStamp = formatCompactTimestamp(now); // 13 chars: YYMMDD-HHMMSS
  const branchSlug = sanitizePart(branch);
  const reservedRight = `${branchSlug ? "-" + branchSlug : ""}-${compactStamp}`;
  const remainingForDevice = NAMESPACE_MAX_LEN - reservedRight.length;

  let deviceSlug = sanitizePart(device);
  if (deviceSlug.length > remainingForDevice) {
    deviceSlug = deviceSlug.slice(0, Math.max(0, remainingForDevice)).replace(/-+$/g, "");
  }

  const out = `${deviceSlug}${reservedRight}`.replace(/^-+|-+$/g, "");
  return out.length >= NAMESPACE_MIN_LEN ? out : "";
}

function sanitizePart(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatHumanTimestamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function formatCompactTimestamp(d: Date): string {
  const yy = pad2(d.getFullYear() % 100);
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yy}${mm}${dd}-${hh}${mi}${ss}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Returns the OS-friendly device name. macOS uses `scutil --get ComputerName`
 * (the user-visible "About This Mac" name like "Work Notebook"); other
 * platforms use os.hostname(). "localhost" / empty are treated as no name.
 */
function friendlyDeviceName(): string {
  if (platform() === "darwin") {
    const friendly = runCommand("scutil", ["--get", "ComputerName"]);
    if (friendly) return friendly;
  }
  const host = safeHostname();
  if (!host || /^localhost(\.local)?$/i.test(host)) return "";
  return host;
}

function safeHostname(): string {
  try {
    return (hostname() || "").trim();
  } catch {
    return "";
  }
}

function safeGitBranch(): string {
  return runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function runCommand(cmd: string, args: string[]): string {
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 1000 });
    if (result.status !== 0) return "";
    return (result.stdout ?? "").trim();
  } catch {
    return "";
  }
}
