// @vitest-environment jsdom
/**
 * The chat markdown table renderer draws no header strip, no icon-only
 * control, and right-aligns numerics and timestamps (cinatra#3230).
 *
 *   cd packages/chat && pnpm vitest run src/__tests__/chat-table-frame-3230.test.ts
 *
 * The ratified drawing's Table component: "Table is the dumb DOM primitive.
 * Headers always uppercase mono with the navy underline; never centre body
 * cells; right-align numerics and timestamps." Its chat-thread section gives
 * the assistant's turn no chrome of its own — the thread's parts "borrow rather
 * than invent" — and no sentence gives a table a header bar, a copy control or
 * a download control. Each item below feeds a fixed markdown table string to
 * the renderer and reads the produced markup; no live turn is needed.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../markdown-render";
import { cellPlainText, isNumericCellText, isTimestampCellText } from "../markdown-render";

const noWidgets = () => [];
function frameOf(md: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(md, "github-light", noWidgets);
  const frame = host.querySelector<HTMLElement>("[data-chat-table-frame]");
  if (!frame) throw new Error("the renderer produced no table frame");
  return frame;
}

const THREE_BY_TWO = [
  "| Schedule | Calendar | Last synced |",
  "| --- | --- | --- |",
  "| Intro call | Work | Sep 3, 2026 |",
  "| Office hours | Personal | Aug 28, 2026 |",
].join("\n");

const THIRTY_ROWS = [
  "| Name | Count |",
  "| --- | --- |",
  ...Array.from({ length: 30 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`),
].join("\n");

const MIXED_COLUMNS = [
  "| Item | Last synced | Quantity |",
  "| --- | --- | --- |",
  "| Intro call | Sep 3, 2026 | 12 |",
  "| Office hours | Aug 28, 2026 | 1,204 |",
  "| Review | Dec 31, 2025 | -3 |",
].join("\n");

const RIGHT = "text-right";
const CENTRE = "text-center";

function bodyCells(frame: HTMLElement, column: number): HTMLElement[] {
  return Array.from(frame.querySelectorAll<HTMLElement>("tbody tr")).map(
    (tr) => tr.querySelectorAll<HTMLElement>("td")[column],
  );
}

describe("chat table renderer — the frame carries only what the drawing gives (cinatra#3230)", () => {
  it("1. no header strip: the frame's first element child is the table's own scroll container", () => {
    const frame = frameOf(THREE_BY_TWO);
    const first = frame.firstElementChild as HTMLElement;
    expect(first).toBeTruthy();
    expect(first.classList.contains("overflow-x-auto")).toBe(true);
    expect(first.firstElementChild?.tagName).toBe("TABLE");
    // Nothing sits between the frame and the table.
    const table = frame.querySelector("table")!;
    expect(table.parentElement).toBe(first);
    expect(first.parentElement).toBe(frame);
  });

  it("2. no copy control, no download control, no chat-table-action element", () => {
    const frame = frameOf(THREE_BY_TWO);
    expect(frame.querySelectorAll('[data-action="copy"]').length).toBe(0);
    expect(frame.querySelectorAll('[data-action="download"]').length).toBe(0);
    expect(frame.querySelectorAll(".chat-table-action").length).toBe(0);
  });

  it("3. no icon-only control anywhere in the frame — every button carries visible text (30 rows, pagination drawn)", () => {
    const frame = frameOf(THIRTY_ROWS);
    expect(frame.querySelector("[data-chat-table-pagination]"), "30 rows exceed the page size, so the pagination row is drawn").toBeTruthy();
    const buttons = Array.from(frame.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect((button.textContent ?? "").trim().length, `an icon-only button: ${button.outerHTML}`).toBeGreaterThan(0);
    }
    // The pagination row's own controls are untouched: Previous and Next, by name.
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Previous", "Next"]);
  });

  it("4. right-aligned numerics and timestamps: a text column stays left, a date column and an integer column go right", () => {
    const frame = frameOf(MIXED_COLUMNS);
    for (const td of bodyCells(frame, 0)) expect(td.classList.contains(RIGHT)).toBe(false);
    for (const td of bodyCells(frame, 1)) expect(td.classList.contains(RIGHT)).toBe(true);
    for (const td of bodyCells(frame, 2)) expect(td.classList.contains(RIGHT)).toBe(true);
  });

  it("4a. a delimiter row that declares a column right-aligned is honoured first", () => {
    const frame = frameOf(["| Name | Code |", "| --- | ---: |", "| a | x1 |", "| b | y2 |"].join("\n"));
    for (const td of bodyCells(frame, 0)) expect(td.classList.contains(RIGHT)).toBe(false);
    for (const td of bodyCells(frame, 1)) expect(td.classList.contains(RIGHT)).toBe(true);
  });

  it("4b. the grammar helpers are deterministic: numbers and dates in, prose out", () => {
    for (const ok of ["12", "-3", "+12%", "1,204", "1,204.50", "$1,540", "€980", "3.5%", "−7"]) {
      expect(isNumericCellText(ok), ok).toBe(true);
    }
    for (const no of ["EMEA", "12 apples", "a1", "", "1.2.3", "Sep"]) {
      expect(isNumericCellText(no), no).toBe(false);
    }
    for (const ok of ["Sep 3, 2026", "September 3, 2026", "2026-09-03", "2026-09-03T14:05:00Z", "2026-09-03 14:05", "3 Sep 2026", "14:05", "2:05 PM", "Sep 3, 2026 14:05"]) {
      expect(isTimestampCellText(ok), ok).toBe(true);
    }
    for (const no of ["Sep", "yesterday", "2026", "Intro call", "3, 2026"]) {
      expect(isTimestampCellText(no), no).toBe(false);
    }
  });

  it("4d. inline markup classifies by the displayed text: bold, code and linked cells go right", () => {
    const frame = frameOf([
      "| Item | When | Count |",
      "| --- | --- | --- |",
      "| a | [Sep 3, 2026](https://example.test/a) | **12** |",
      "| b | `2026-09-03` | `1,204` |",
      "| c | *Dec 31, 2025* | 3 |",
    ].join("\n"));
    for (const td of bodyCells(frame, 0)) expect(td.classList.contains(RIGHT)).toBe(false);
    for (const td of bodyCells(frame, 1)) expect(td.classList.contains(RIGHT)).toBe(true);
    for (const td of bodyCells(frame, 2)) expect(td.classList.contains(RIGHT)).toBe(true);
    expect(cellPlainText([{ type: "strong", raw: "**12**", text: "12", tokens: [{ type: "text", raw: "12", text: "12" }] } as never])).toBe("12");
    expect(cellPlainText([{ type: "codespan", raw: "`12`", text: "12" } as never])).toBe("12");
    expect(cellPlainText([{ type: "html", raw: "<b>", text: "<b>" } as never, { type: "text", raw: "x", text: "x" } as never])).toBe("x");
  });

  it("4e. the header row keeps the renderer's fixed left alignment — the sentence governs body cells only", () => {
    const frame = frameOf(MIXED_COLUMNS);
    const ths = Array.from(frame.querySelectorAll<HTMLElement>("thead th"));
    expect(ths.length).toBe(3);
    for (const th of ths) {
      expect(th.classList.contains("text-left")).toBe(true);
      expect(th.classList.contains(RIGHT)).toBe(false);
    }
  });

  it("4c. a column with one non-numeric, non-date cell stays left — every non-empty cell must parse", () => {
    const frame = frameOf(["| Ref | Count |", "| --- | --- |", "| a | 12 |", "| b | n/a |", "| c |  |"].join("\n"));
    for (const td of bodyCells(frame, 1)) expect(td.classList.contains(RIGHT)).toBe(false);
  });

  it("5. no body cell carries a centre-alignment class — not even for a centred delimiter", () => {
    for (const md of [THREE_BY_TWO, THIRTY_ROWS, MIXED_COLUMNS, ["| Left | Center | Right |", "| :--- | :---: | ---: |", "| a | b | c |"].join("\n")]) {
      const frame = frameOf(md);
      for (const td of Array.from(frame.querySelectorAll("tbody td"))) {
        expect(td.classList.contains(CENTRE)).toBe(false);
      }
    }
  });
});
