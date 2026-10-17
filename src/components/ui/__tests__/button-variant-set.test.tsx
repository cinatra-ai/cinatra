// @vitest-environment jsdom
// Host Button roster and the drawing's distinct primary/default treatments.
// The other visual clauses and the independent SDK copies remain separate
// work. Real computed values are authored in primitive-wave-leg2.spec.ts;
// these native controls state recipes, props and interaction semantics only.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Button, buttonVariants, Spinner } from "@/components/ui/button";

afterEach(cleanup);
const ROSTER = ["primary", "default", "outline", "secondary", "destructive", "ghost", "link"] as const;
function recipe(variant: (typeof ROSTER)[number]): string {
  // Before this repair primary is missing; the same input must still reach
  // cva so the RED is a real assertion, rather than a type/load failure.
  return buttonVariants({ variant: variant as NonNullable<Parameters<typeof buttonVariants>[0]>["variant"], size: "default" });
}

describe('clause: "Primary, default, outline, secondary, destructive, ghost, link."', () => {
  it("draws all seven names as distinct recipes", () => {
    expect(ROSTER).toHaveLength(7);
    expect(new Set(ROSTER.slice(1).map(recipe)).size).toBe(6);
    expect(new Set(ROSTER.map(recipe)).size).toBe(7);
  });
  it("assigns the indigo fill to primary", () => {
    expect(recipe("primary")).toContain("bg-primary");
  });
  it("answers the first drawn name with indigo rather than the base recipe alone", () => {
    // This is the maintained it.fails witness, now an ordinary regression.
    expect(recipe("primary")).toContain("bg-primary");
    expect(recipe("primary")).toContain("text-primary-foreground");
  });
  it("gives default its distinct ink-border treatment instead of the indigo fill", () => {
    expect(recipe("default")).toContain("border-line-strong");
    expect(recipe("default")).toContain("bg-surface-strong");
    expect(recipe("default")).toContain("text-foreground");
    expect(recipe("default")).not.toMatch(/(^|\s)bg-primary(\s|$)/);
    expect(recipe("default")).not.toContain("text-primary-foreground");
    expect(recipe("primary")).toContain("border-primary");
  });
});

describe("Button controls", () => {
  it("renders the full named roster with unchanged size and native button semantics", () => {
    const { container } = render(<>{ROSTER.map(variant => <Button key={variant} variant={variant} type="button">{variant}</Button>)}</>);
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(7);
    buttons.forEach((button, i) => {
      expect(button.getAttribute("data-variant")).toBe(ROSTER[i]);
      expect(button.getAttribute("data-size")).toBe("default");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.className).toContain("h-8");
    });
  });
  it("keeps every established size recipe", () => {
    const sizes = { default: "h-8", xs: "h-6", sm: "h-7", lg: "h-9", icon: "size-8", "icon-xs": "size-6", "icon-sm": "size-7", "icon-lg": "size-9" } as const;
    for (const [size, box] of Object.entries(sizes)) {
      expect(buttonVariants({ variant: "primary" as never, size: size as keyof typeof sizes })).toContain(box);
    }
  });
  it("retains focus, invalid and disabled guards for every variant", () => {
    for (const variant of ROSTER) {
      const value = recipe(variant);
      expect(value).toContain("focus-visible:ring-3");
      expect(value).toContain("disabled:pointer-events-none");
      expect(value).toContain("disabled:opacity-50");
      expect(value).toContain("aria-invalid:border-destructive");
    }
  });
  it("preserves disabled click refusal and caller overrides", () => {
    let calls = 0;
    const { getByRole } = render(<Button variant="primary" disabled onClick={() => calls++} className="bg-surface-muted" aria-label="Primary action">Save</Button>);
    const button = getByRole("button", { name: "Primary action" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(calls).toBe(0);
    expect(button.disabled).toBe(true);
    expect(button.className).toContain("bg-surface-muted");
    expect(button.className).not.toMatch(/(^|\s)bg-primary(\s|$)/);
  });
  it("preserves asChild links, forwarded attributes and the shared Spinner", () => {
    const { container } = render(<><Button variant="primary" asChild><a href="#agents" aria-label="Open agents">Agents</a></Button><Spinner aria-label="Waiting" /></>);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("#agents");
    expect(link.getAttribute("data-slot")).toBe("button");
    expect(link.getAttribute("data-variant")).toBe("primary");
    expect(container.querySelector("button")).toBeNull();
    const spinner = container.querySelector('[role="status"]')!;
    expect(spinner.getAttribute("aria-label")).toBe("Waiting");
    expect(spinner.getAttribute("class")).toContain("animate-spin");
    expect(spinner.getAttribute("class")).toContain("text-primary");
  });
});
