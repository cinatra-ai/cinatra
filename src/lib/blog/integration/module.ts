import "server-only";

import { createDeterministicBlogContentClient } from "../mcp/client/deterministic-client";
import { registerBlogContentPrimitives } from "../mcp/registry";
import { registerBlogObjectTypes } from "./register-object-types";

export function createBlogContentModule() {
  registerBlogObjectTypes();
  return {
    createDeterministicClient() {
      const actor = {
        actorType: "human" as const,
        source: "ui" as const,
      };
      return createDeterministicBlogContentClient({ actor });
    },
    registerCapabilities: registerBlogContentPrimitives,
  };
}
