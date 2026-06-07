import { registerSkillsPrimitives } from "./registry";

export function createSkillsModule() {
  return {
    registerCapabilities: registerSkillsPrimitives,
  };
}
