// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { PaginatedTable } from "./paginated-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

async function renderTable(rowCount: number, props?: React.ComponentProps<typeof PaginatedTable>) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <PaginatedTable {...props}>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rowCount }, (_, index) => (
            <TableRow key={index} data-row="body">
              <TableCell>Row {index + 1}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </PaginatedTable>,
    );
  });

  return container;
}

function getBodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row="body"]'));
}

function getVisibleBodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return getBodyRows(container).filter((row) => !row.hidden);
}

function getPaginationLink(container: HTMLElement, label: string): HTMLAnchorElement {
  const link = container.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`);

  if (!link) {
    throw new Error(`Pagination link not found: ${label}`);
  }

  return link;
}

describe("PaginatedTable", () => {
  it("does not show pagination at the 25-row threshold", async () => {
    const container = await renderTable(25);

    expect(container.querySelector('[data-slot="table-pagination"]')).toBeNull();
    expect(getVisibleBodyRows(container)).toHaveLength(25);
  });

  it("shows pagination and renders the first page for more than 25 rows", async () => {
    const container = await renderTable(26);

    expect(container.querySelector('[data-slot="table-pagination"]')).not.toBeNull();
    expect(container.textContent).toContain("1–25 of 26");
    expect(container.textContent).toContain("Page 1 of 2");
    expect(getBodyRows(container)).toHaveLength(26);
    expect(getVisibleBodyRows(container)).toHaveLength(25);
    expect(getBodyRows(container)[25]?.hidden).toBe(true);

    await act(async () => {
      getPaginationLink(container, "Go to next page").click();
    });

    expect(container.textContent).toContain("26–26 of 26");
    expect(container.textContent).toContain("Page 2 of 2");
    expect(getVisibleBodyRows(container)).toHaveLength(1);
    expect(getBodyRows(container)[25]?.hidden).toBe(false);
  });

  it("allows pagination to be disabled for non-data tables", async () => {
    const container = await renderTable(26, { pagination: false });

    expect(container.querySelector('[data-slot="table-pagination"]')).toBeNull();
    expect(getVisibleBodyRows(container)).toHaveLength(26);
  });
});
