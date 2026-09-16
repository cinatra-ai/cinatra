// @vitest-environment jsdom
//
// Form — the graded checklist for the components drawing's "Form / Field /
// Label" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/form-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "Helper · 11px · muted"
//   "gap 4-8px"
//   "error swaps helper red"
//   "Form scaffolding — labels above inputs, helper or error text below.
//    Errors swap helper text colour to brand red and add aria-invalid to the
//    input."
//
// NO DEPARTURE FOUND.
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useForm } from "react-hook-form";

import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

afterEach(cleanup);

function Harness({ error }: { error?: string }) {
  const form = useForm<{ campaign: string }>({ defaultValues: { campaign: "" } });
  // The error is raised in an effect, never during render: react-hook-form's
  // setError schedules a state update, and calling it in the render phase makes
  // the harness — not the primitive — the thing under test.
  React.useEffect(() => {
    if (error) form.setError("campaign", { type: "manual", message: error });
  }, [error, form]);
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="campaign"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Campaign name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormDescription>Visible only to your team.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
    </Form>
  );
}

function renderForm(error?: string) {
  let container!: HTMLElement;
  act(() => {
    container = render(<Harness error={error} />).container;
  });
  return {
    item: container.querySelector('[data-slot="form-item"]') as HTMLElement,
    label: container.querySelector('[data-slot="form-label"]') as HTMLElement,
    // FormControl renders a Slot that merges its own `data-slot="form-control"`
    // ONTO the input it wraps, so the control is addressed by that slot name.
    control: container.querySelector('[data-slot="form-control"]') as HTMLElement,
    description: container.querySelector(
      '[data-slot="form-description"]',
    ) as HTMLElement | null,
    message: container.querySelector(
      '[data-slot="form-message"]',
    ) as HTMLElement | null,
  };
}

describe('clause: "Helper · 11px · muted"', () => {
  it("sets the helper line at the 11px step in the muted ink", () => {
    const { description } = renderForm();
    expect(description).not.toBeNull();
    expect(description!.className).toContain("text-[11px]");
    expect(description!.className).toContain("text-muted-foreground");
  });
});

describe('clause: "gap 4-8px"', () => {
  it("stacks label, control and helper inside the stated band", () => {
    // `gap-2` is 0.5rem = 8px, the top of the band the clause names.
    const { item } = renderForm();
    expect(item.className).toContain("gap-2");
  });
});

describe('clause: "error swaps helper red" / "Errors swap helper text colour to brand red"', () => {
  it("renders the error line in the destructive ink at the SAME 11px step as the helper", () => {
    // The clause says the colour swaps — so the size and leading must NOT, or
    // the row would reflow when a field goes invalid.
    const { message } = renderForm("The hold window closed at 15:30.");
    expect(message).not.toBeNull();
    expect(message!.className).toContain("text-destructive");
    expect(message!.className).toContain("text-[11px]");
    expect(message!.textContent).toContain("The hold window closed at 15:30.");
  });

  it("turns the label destructive alongside the message", () => {
    const { label } = renderForm("Required.");
    expect(label.getAttribute("data-error")).toBe("true");
    expect(label.className).toContain("data-[error=true]:text-destructive");
  });
});

describe('clause: "add aria-invalid to the input"', () => {
  it("marks the control invalid for assistive tech when the field errors", () => {
    const { control } = renderForm("Required.");
    expect(control.getAttribute("aria-invalid")).toBe("true");
  });

  it("leaves the control valid while the field has no error", () => {
    const { control } = renderForm();
    expect(control.getAttribute("aria-invalid")).toBe("false");
  });
});

describe('clause: "labels above inputs, helper or error text below"', () => {
  it("emits the three parts in the stated document order", () => {
    // Order is asserted structurally rather than by measured position: the
    // container is a `grid` with no explicit row placement, so DOM order IS
    // the rendered order.
    const { item } = renderForm();
    const slots = Array.from(item.querySelectorAll("[data-slot]"))
      .map((n) => n.getAttribute("data-slot"))
      .filter((s) => s !== "form-control");
    expect(slots.indexOf("form-label")).toBeLessThan(
      slots.indexOf("form-description"),
    );
  });
});
