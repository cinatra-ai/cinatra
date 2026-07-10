import { vi } from "vitest";
import type { ExtensionTypeHandler, PackageRef, Actor } from "../../index";

export const makeHandler = (typeId: string): ExtensionTypeHandler => ({
  typeId,
  install:   vi.fn().mockResolvedValue(undefined),
  update:    vi.fn().mockResolvedValue(undefined),
  uninstall: vi.fn().mockResolvedValue(undefined),
  archive:   vi.fn().mockResolvedValue(undefined),
  restore:   vi.fn().mockResolvedValue(undefined),
});

export const makeRef = (name = "@cinatra/my-pkg"): PackageRef => ({
  registryUrl: "https://registry.example.com",
  packageName: name,
  version: "1.0.0",
});

// Default dispatch-contract actor is a PLATFORM ADMIN (P5, cinatra#1130): the
// row-scoped resolver requires standing over the resolved row, and a platform
// admin retains today's full reach — so the pre-existing predicate/branch
// contract tests still exercise the handler calls. Org-admin parity + refusal
// paths are covered by the dedicated P5 suite with explicitly-stamped actors.
export const makeActor = (): Actor => ({
  actorType: "system",
  userId: "user-1",
  source: "worker",
  platformRole: "platform_admin",
});
