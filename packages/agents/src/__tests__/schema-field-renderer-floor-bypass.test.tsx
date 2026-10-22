// @vitest-environment jsdom
/**
 * Floor-recursion guard — the true registry-bypass floor (cinatra#1625, codex
 * convergence 2026-07-20; gmail-screen relocation).
 *
 * THE BUG: the SchemaFieldRenderer floor is REGISTRY-FIRST. The gmail-sender
 * condition is a HEURISTIC — it matches on the FIELD NAME (`senderEmail`, `from`,
 * `replyTo`, …) whenever Gmail is connected, so it survives x-renderer stripping.
 * A floor that re-entered the registry would therefore re-resolve the very
 * gmail-sender binding whose degrade (map-HIT ExtensionFieldRenderer wrapper) or
 * host KIND floor (map-MISS) produced it, recursing until crash — the opposite of
 * the AC4 never-blank/never-crash floor. Stripping x-renderer only defeats
 * STRICT-ID conditions; it does nothing for the heuristic.
 *
 * THE FIX: `SchemaOnlyFloorRenderer` renders the schema-driven fallback WITHOUT
 * consulting the registry. This suite proves it for BOTH reach paths — the
 * map-HIT wrapper-degrade floor (driven through the REAL makeExtensionFieldRenderer
 * with a degrading component) and the map-MISS host KIND floor — using the REAL
 * gmail-sender heuristic condition. The generated component build map is stubbed
 * (empty) + overridden per-test, so the suite runs in a partial worktree and CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import {
  fieldRendererRegistry,
  type FieldRendererProps,
} from "../field-renderer-registry";
import {
  SchemaFieldRenderer,
  SchemaOnlyFloorRenderer,
} from "../schema-field-renderer";
import { makeGmailSenderCondition } from "../gmail-sender-condition";
import { makeExtensionFieldRenderer } from "../extension-field-renderer";
import {
  __setFieldRendererComponentMapForTests,
  __resetFieldRendererComponentMapForTests,
} from "../field-renderer-components";

// The build component map is a generated file (absent in a partial worktree).
// Stub it empty; tests inject entries via __setFieldRendererComponentMapForTests,
// exactly like field-renderer-component-cutover.test.tsx.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

const GMAIL_BINDING_ID = "@cinatra-ai/email-outreach-agent:gmail-sender";

// A Gmail context that makes the sender-name heuristic ACTIVE for a sender field.
const gmailContext = {
  connectedApps: ["gmail"],
  gmailAliases: [{ sendAsEmail: "me@example.com", displayName: "Me" }],
} as unknown as FieldRendererProps["context"];

/**
 * Register the relocated gmail-sender binding as its post-relocation host KIND
 * FLOOR: the bypass floor + the heuristic makeCondition. Before the fix this
 * entry's renderer was the registry-first SchemaFieldRenderer, which recurses on
 * a `senderEmail` field.
 */
function registerGmailFloor(
  renderer: ComponentType<FieldRendererProps> = SchemaOnlyFloorRenderer,
) {
  fieldRendererRegistry.register({
    id: GMAIL_BINDING_ID,
    priority: 100,
    condition: makeGmailSenderCondition([GMAIL_BINDING_ID, "gmail-sender"]),
    renderer,
  });
}

function senderProps(): FieldRendererProps {
  return {
    fieldName: "senderEmail",
    schema: { type: "string" },
    value: "",
    onChange: () => {},
    context: gmailContext,
  } as FieldRendererProps;
}

beforeEach(() => {
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
});

afterEach(() => {
  cleanup();
  __resetFieldRendererComponentMapForTests();
  vi.restoreAllMocks();
});

describe("SchemaOnlyFloorRenderer — true registry-bypass floor (no heuristic re-entry)", () => {
  it("control: the gmail-sender heuristic DOES match a plain `senderEmail` field (the hazard the bypass neutralizes)", () => {
    registerGmailFloor();
    const matched = fieldRendererRegistry.resolve(
      "senderEmail",
      { type: "string" },
      gmailContext,
    );
    expect(matched?.id).toBe(GMAIL_BINDING_ID);
  });

  it("map-MISS heuristic: the relocated gmail-sender KIND floor renders the schema fallback without recursing", () => {
    // The dispatcher resolves senderEmail -> gmail-sender -> SchemaOnlyFloorRenderer,
    // which bypasses the registry (one hop, no re-resolution). A raw
    // SchemaFieldRenderer here would re-match the heuristic and stack-overflow.
    registerGmailFloor();
    const { container } = render(<SchemaFieldRenderer {...senderProps()} />);
    // Never blank: the schema-driven string input rendered.
    expect(container.querySelector("#field-senderEmail")).toBeTruthy();
  });

  it("map-HIT heuristic: a degraded gmail-sender extension wrapper floors WITHOUT re-resolving into itself", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Build-map HIT whose module DEGRADES on load — the wrapper must render the
    // floor (never blank), and the floor must not re-resolve the still-registered
    // gmail-sender heuristic entry (which points back at this very wrapper).
    __setFieldRendererComponentMapForTests({
      [GMAIL_BINDING_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-ai/email-artifacts",
        propsApiVersion: 1,
        load: async () => {
          throw new Error("chunk unavailable");
        },
      },
    });
    const Wrapper = makeExtensionFieldRenderer(GMAIL_BINDING_ID);
    // Register the wrapper under the heuristic condition — the map-HIT registration
    // register-default-renderers performs when hasFieldRendererComponent is true.
    registerGmailFloor(Wrapper);
    const resolveSpy = vi.spyOn(fieldRendererRegistry, "resolve");

    const { container } = render(<Wrapper {...senderProps()} />);
    // The load rejects -> degrade -> floor. Wait for the degrade diagnostic.
    await waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('reason "load-failed"'),
      ),
    );
    // Floor rendered (never blank), and NOT the gmail Select ("Select a sender address").
    expect(container.querySelector("#field-senderEmail")).toBeTruthy();
    // The bypass floor never consulted the registry, so it could not re-resolve
    // the gmail-sender heuristic and recurse into the wrapper.
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe("ExtensionFieldRenderer — a crashed component's validity report goes with it (cinatra#3562)", () => {
  const BINDING_ID = "@cinatra-test/pack-agent:ticking";

  /** Reports nothing ticked, and throws while rendering once "Break" is pressed. */
  function ReportsThenThrows({ onValidityChange }: FieldRendererProps) {
    const [broken, setBroken] = useState(false);
    useEffect(() => {
      onValidityChange?.(false);
    }, [onValidityChange]);
    if (broken) throw new Error("render crash");
    return (
      <Button type="button" onClick={() => setBroken(true)}>
        Break
      </Button>
    );
  }

  it("reports true when the floor replaces the crashed component, which reported false", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent",
        propsApiVersion: 1,
        load: async () => ({ default: ReportsThenThrows }),
      },
    });
    const Wrapper = makeExtensionFieldRenderer(BINDING_ID);
    const onValidityChange = vi.fn();
    const view = render(
      <Wrapper
        {...senderProps()}
        fieldName="accountScope"
        context={{ connectedApps: [] } as unknown as FieldRendererProps["context"]}
        onValidityChange={onValidityChange}
      />,
    );

    await view.findByRole("button", { name: "Break" });
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false));
    fireEvent.click(view.getByRole("button", { name: "Break" }));

    await waitFor(() => expect(view.container.querySelector("#field-accountScope")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Break" })).toBeNull();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  /** Draws what the wrapper lets escape, so a throw past the wrapper is read here. */
  class EscapeCatcher extends Component<{ children?: ReactNode }, { escaped: boolean }> {
    state = { escaped: false };

    static getDerivedStateFromError(): { escaped: boolean } {
      return { escaped: true };
    }

    render(): ReactNode {
      return this.state.escaped ? <p>escaped the wrapper</p> : this.props.children;
    }
  }

  it("still draws the floor when the caller passes no onValidityChange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    __setFieldRendererComponentMapForTests({
      [BINDING_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent",
        propsApiVersion: 1,
        load: async () => ({ default: ReportsThenThrows }),
      },
    });
    const Wrapper = makeExtensionFieldRenderer(BINDING_ID);
    const view = render(
      <EscapeCatcher>
        <Wrapper
          {...senderProps()}
          fieldName="accountScope"
          context={{ connectedApps: [] } as unknown as FieldRendererProps["context"]}
        />
      </EscapeCatcher>,
    );

    await view.findByRole("button", { name: "Break" });
    fireEvent.click(view.getByRole("button", { name: "Break" }));

    await waitFor(() => expect(view.container.querySelector("#field-accountScope")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Break" })).toBeNull();
    expect(view.queryByText("escaped the wrapper")).toBeNull();
  });
});
