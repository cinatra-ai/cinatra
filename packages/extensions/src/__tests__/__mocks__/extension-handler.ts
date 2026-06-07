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

export const makeActor = (): Actor => ({ actorType: "system", userId: "user-1", source: "worker" });
