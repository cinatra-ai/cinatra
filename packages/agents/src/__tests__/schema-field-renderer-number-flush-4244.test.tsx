// @vitest-environment jsdom
/**
 * cinatra#4244 - a number field's flush never leaves an earlier value behind.
 *
 * A number field inside a structured object hands its value over only on a
 * flush. When the box holds something that is not a finite number (`1e309`),
 * the flush must clear the value it handed over before, not leave it
 * standing: otherwise a nested number flushed on an earlier press is sent
 * again while the field shows "Enter a valid number.".
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-number-flush-4244.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  LinkIcon: () => null,
  MailIcon: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Check: () => null,
  X: () => null,
  Loader2: () => null,
}));

import { SchemaFieldRenderer } from "../schema-field-renderer";

const CONTEXT = { connectedApps: [] as string[] };

afterEach(() => cleanup());

describe("SchemaFieldRenderer number flush (cinatra#4244)", () => {
  // Only text a number box keeps: jsdom clears plain non-numeric text itself.
  for (const bad of ["1e309", "-1e309"]) {
    it(`clears the earlier value when the box holds ${bad}`, async () => {
      let flush: (() => Promise<void>) | null = null;
      const onChange = vi.fn();
      render(
        <SchemaFieldRenderer
          fieldName="n"
          schema={{ type: "number" }}
          value={undefined}
          onChange={onChange}
          context={CONTEXT}
          hideSubmit
          bypassRegistry
          registerFlush={(fn) => {
            flush = fn;
          }}
        />,
      );
      const box = document.getElementById("field-n") as HTMLInputElement;
      fireEvent.change(box, { target: { value: "5" } });
      await act(async () => {
        await flush!();
      });
      expect(onChange).toHaveBeenLastCalledWith(5);

      fireEvent.change(box, { target: { value: bad } });
      await act(async () => {
        await flush!();
      });
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith(undefined);
    });
  }
});
