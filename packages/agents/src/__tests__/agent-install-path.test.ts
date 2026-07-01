// TDD test suite for agent-install-path helper.
// Test file lives under src/__tests__/ to match the package's vitest include
// glob ("src/**/__tests__/**/*.test.ts" — see packages/agent-builder/vitest.config.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: vi.fn(),
  writeMetadataValueToDatabase: vi.fn(),
}));

import {
  readAgentInstallPath,
  writeAgentInstallPath,
  resolveAgentInstallDir,
} from "../agent-install-path";
import * as db from "@/lib/database";

describe("readAgentInstallPath", () => {
  const ENV_KEY = "CINATRA_AGENT_INSTALL_DIR";
  let savedEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('returns "extensions" default when metadata is null', () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue(null);
    expect(readAgentInstallPath()).toBe("extensions");
  });

  it("returns trimmed stored value when set", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("  custom-agents  ");
    expect(readAgentInstallPath()).toBe("custom-agents");
  });

  it("falls back to default when stored value is whitespace", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("   ");
    expect(readAgentInstallPath()).toBe("extensions");
  });

  it("env CINATRA_AGENT_INSTALL_DIR WINS over the DB metadata (deploy determinism, ops#436)", () => {
    process.env[ENV_KEY] = "/srv/agents";
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("db-agents");
    expect(readAgentInstallPath()).toBe("/srv/agents");
    // The env override short-circuits — the DB is not even read.
    expect(db.readMetadataValueFromDatabase).not.toHaveBeenCalled();
  });

  it("trims the env value and falls through to metadata when env is blank", () => {
    process.env[ENV_KEY] = "   ";
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("db-agents");
    expect(readAgentInstallPath()).toBe("db-agents");
  });
});

describe("writeAgentInstallPath", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes to metadata key 'agent_install_path'", () => {
    writeAgentInstallPath("custom-agents");
    expect(db.writeMetadataValueToDatabase).toHaveBeenCalledWith(
      "agent_install_path",
      "custom-agents",
    );
  });
});

describe("resolveAgentInstallDir", () => {
  const ENV_KEY = "CINATRA_AGENT_INSTALL_DIR";
  let savedEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("joins process.cwd() with relative path", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue(null);
    expect(resolveAgentInstallDir()).toBe(path.join(process.cwd(), "extensions"));
  });

  it("returns absolute path verbatim", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("/var/agents");
    expect(resolveAgentInstallDir()).toBe("/var/agents");
  });

  it("resolves an ABSOLUTE env override verbatim (deploy dir, ops#436)", () => {
    process.env[ENV_KEY] = "/srv/agents";
    expect(resolveAgentInstallDir()).toBe("/srv/agents");
  });

  it("joins a RELATIVE env override against process.cwd()", () => {
    process.env[ENV_KEY] = "deploy-agents";
    expect(resolveAgentInstallDir()).toBe(path.join(process.cwd(), "deploy-agents"));
  });
});
