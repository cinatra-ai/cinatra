/**
 * THE ASSISTANT MUST BE ABLE TO REACH `appointment_schedule_add`
 * (cinatra-ai/cinatra#2368 acceptance item 3, the assistant add flow).
 *
 * OWNERSHIP IS NOT REACHABILITY. `appointment-schedule-primitive-ownership`
 * pins that the core registers exactly one handler under this name. That
 * settles WHOSE implementation runs — it says nothing about whether the chat
 * assistant is ever offered the tool.
 *
 * Reachability is a separate decision, taken by the delegated-chat admission
 * evaluator: a primitive the host does not DECLARE a chat class for is refused
 * with reason "undeclared", so it never enters the assistant\x27s tool surface at
 * all. A registered-but-undeclared primitive is therefore invisible to the
 * model while looking perfectly wired from the handler map — and the model,
 * asked to use it, answers from guesswork instead of from its tool list.
 *
 * That is precisely the fault the live acceptance round recorded: three
 * consecutive assistant turns gave three mutually inconsistent accounts of
 * whether this tool exists, one of them stating it "isn\x27t available in the
 * current tool surface". It was the accurate one.
 *
 * These assertions pin the DECLARATION half so it cannot drift: declared by the
 * core, and admitted by the real evaluator over the real core admission
 * records.
 *
 * AND THAT IS ONLY HALF OF REACHABILITY — read this before trusting a green run
 * here. Everything below runs against `core-delegated-chat-surface`, which its
 * own header calls a PROJECTION that "production never calls": it answers
 * "WOULD a core primitive by this name be admitted?", over the declaration
 * table. It cannot see whether any registration pass ever produces such a
 * primitive. The live catalog is `plan.servable` from ONE delegated-chat
 * registration pass, so a primitive that is declared but never REGISTERED on
 * that pass is admitted in this projection and absent from the assistant's
 * tool surface — which is exactly the shape of the fault this file was written
 * for, one layer down.
 *
 * The registration half is pinned by its sibling,
 * `appointment-schedule-chat-registration.test.ts`, against artifacts derived
 * from the real `registerTool` sites. Neither file is sufficient alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  coreDelegatedChatAdmissionSnapshot,
  coreDelegatedChatAdmittedNames,
  isCoreDelegatedChatAdmitted,
  plannedCorePrimitive,
} from "@cinatra-ai/mcp-server/core-delegated-chat-surface";
import { evaluateDelegatedChatAdmission } from "@cinatra-ai/mcp-server/delegated-chat-admission";
import {
  carriesDeniedDelegatedChatVerbToken,
  isHardDeniedDelegatedChatFamily,
} from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import { hostDeclaredDelegatedChatClass } from "@cinatra-ai/mcp-server/capability-plan";

const ADD = "appointment_schedule_add";

describe("appointment_schedule_add — delegated-chat reachability", () => {
  it("is admitted to delegated chat by the real evaluator", () => {
    const decision = evaluateDelegatedChatAdmission(
      plannedCorePrimitive(ADD),
      coreDelegatedChatAdmissionSnapshot(),
    );
    expect(decision).toEqual({ allowed: true, admittedClass: "dispatch" });
    expect(isCoreDelegatedChatAdmitted(ADD)).toBe(true);
  });

  it("appears in this build\x27s admitted core names", () => {
    expect(coreDelegatedChatAdmittedNames()).toContain(ADD);
  });

  it("carries the host declaration the admission record is bound to", () => {
    // `dispatch` is the honest class: the add flow hands work to a path that
    // runs under the invoking person\x27s OWN Google credential (it resolves a
    // fresh account-scoped calendar list) and persists per-user state, rather
    // than returning data (`read`) or enumerating a catalog (`discovery`).
    expect(hostDeclaredDelegatedChatClass(ADD)).toBe("dispatch");
  });

  it("is admitted by DECLARATION, never by a bypass", () => {
    // The fix must be the missing declaration and nothing else. If this name
    // ever needed the proposal override to get past the verb backstop, or sat
    // in a hard-denied family, the reachability above would be papering over a
    // policy decision instead of completing one.
    expect(isHardDeniedDelegatedChatFamily(ADD)).toBe(false);
    expect(carriesDeniedDelegatedChatVerbToken(ADD)).toBe(false);
  });

  it("is the SAME name the core registry actually registers", () => {
    // Guards the declaration against a typo: a declared-but-unregistered name
    // is admitted to a tool that does not exist, which fails at call time.
    const source = readFileSync(
      resolve(__dirname, "..", "..", "..", "src/lib/primitive-handlers.ts"),
      "utf8",
    );
    expect(source).toContain(JSON.stringify(ADD) + ":");
  });
});
