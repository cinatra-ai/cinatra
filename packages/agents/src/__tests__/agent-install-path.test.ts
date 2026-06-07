// TDD test suite for agent-install-path helper.
// Test file lives under src/__tests__/ to match the package's vitest include
// glob ("src/**/__tests__/**/*.test.ts" — see packages/agent-builder/vitest.config.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
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
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

  it("joins process.cwd() with relative path", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue(null);
    expect(resolveAgentInstallDir()).toBe(path.join(process.cwd(), "extensions"));
  });

  it("returns absolute path verbatim", () => {
    vi.mocked(db.readMetadataValueFromDatabase).mockReturnValue("/var/agents");
    expect(resolveAgentInstallDir()).toBe("/var/agents");
  });
});
