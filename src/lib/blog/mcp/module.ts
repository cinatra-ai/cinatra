import { registerBlogContentPrimitives } from "./registry";

export function createContentBlogModule() {
  return {
    registerCapabilities: registerBlogContentPrimitives,
  };
}
