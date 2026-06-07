import { describe, expect, it } from "vitest";
import { domainIcons } from "@/components/domain-icons";

describe("domainIcons", () => {
  it("keeps Agents and Assistants visually distinct", () => {
    expect(domainIcons.assistants).not.toBe(domainIcons.agents);
  });
});
