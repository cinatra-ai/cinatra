"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDownAZ, ArrowUpAZ, Check, Columns3Cog, LayoutGrid, SlidersHorizontal, Table2, X } from "lucide-react";
import type { DragEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { AppDialog } from "@/components/app-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  getListConfigCookieName,
  getListViewCookieName,
  parseListConfigCookie,
  serializeListConfigCookie,
  type StoredListConfig,
  type StoredListViewConfig,
} from "@/lib/list-view";

type FilterOption = {
  value: string;
  label: string;
};

type FilterConfig = {
  name: string;
  label: string;
  value: string;
  options: FilterOption[];
};

type ColumnConfig = {
  key: string;
  label: string;
};

type ColumnSection = {
  key: string;
  label: string;
  columns: ColumnConfig[];
};

type ListControlsProps = {
  basePath: string;
  searchPlaceholder: string;
  query: string;
  view: "cards" | "table";
  filters?: FilterConfig[];
  sortValue: string;
  sortOptions: FilterOption[];
  direction: "asc" | "desc";
  selectedColumns: string[];
  availableColumns: ColumnSection[];
};

function buildParams(
  query: string,
  view: "cards" | "table",
  sortValue: string,
  direction: "asc" | "desc",
  selectedColumns: string[],
  filters: FilterConfig[],
) {
  const params = new URLSearchParams();

  if (query.trim()) {
    params.set("q", query.trim());
  }

  params.set("view", view);
  params.set("sort", sortValue);
  params.set("dir", direction);

  selectedColumns.forEach((column) => params.append("columns", column));

  filters.forEach((filter) => {
    if (filter.value && filter.value !== "all") {
      params.set(filter.name, filter.value);
    }
  });

  return params;
}

export function ListControls({
  basePath,
  searchPlaceholder,
  query,
  view,
  filters = [],
  sortValue,
  sortOptions,
  direction,
  selectedColumns,
  availableColumns,
}: ListControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const cookieName = getListViewCookieName(basePath);
  const configCookieName = getListConfigCookieName(basePath);
  const [searchValue, setSearchValue] = useState(query);
  const [columnsModalOpen, setColumnsModalOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [draftSelectedColumns, setDraftSelectedColumns] = useState(selectedColumns);
  const [draggedColumnKey, setDraggedColumnKey] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [storedConfig, setStoredConfig] = useState<StoredListConfig>({});
  useEffect(() => {
    setSearchValue(query);
  }, [query]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setDraftSelectedColumns(selectedColumns);
  }, [selectedColumns]);

  const currentFilterValues = useMemo(
    () =>
      filters.reduce<Record<string, string>>((accumulator, filter) => {
        accumulator[filter.name] = filter.value;
        return accumulator;
      }, {}),
    [filters],
  );

  const allColumns = useMemo(
    () => availableColumns.flatMap((section) => section.columns),
    [availableColumns],
  );

  const availableColumnsBySection = useMemo(
    () =>
      availableColumns
        .map((section) => ({
          ...section,
          columns: section.columns.filter((column) => !draftSelectedColumns.includes(column.key)),
        }))
        .filter((section) => section.columns.length > 0),
    [availableColumns, draftSelectedColumns],
  );

  const selectedColumnItems = useMemo(
    () =>
      draftSelectedColumns
        .map((key) => allColumns.find((column) => column.key === key))
        .filter((column): column is ColumnConfig => Boolean(column)),
    [allColumns, draftSelectedColumns],
  );

  function rememberView(nextView: "cards" | "table") {
    document.cookie = `${cookieName}=${nextView}; path=/; max-age=31536000; samesite=lax`;
  }

  const readStoredConfig = useCallback((): StoredListConfig => {
    const cookieEntry = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith(`${configCookieName}=`));

    return parseListConfigCookie(cookieEntry?.split("=").slice(1).join("="));
  }, [configCookieName]);

  const rememberConfig = useCallback((nextView: "cards" | "table", nextConfig: StoredListViewConfig) => {
    const currentConfig = readStoredConfig();
    const mergedConfig: StoredListConfig = {
      ...currentConfig,
      [nextView]: nextConfig,
    };

    document.cookie = `${configCookieName}=${serializeListConfigCookie(mergedConfig)}; path=/; max-age=31536000; samesite=lax`;
    setStoredConfig(mergedConfig);
  }, [configCookieName, readStoredConfig]);

  useEffect(() => {
    setStoredConfig(readStoredConfig());
  }, [readStoredConfig]);

  const replaceUrl = useCallback((next: {
    query?: string;
    view?: "cards" | "table";
    sortValue?: string;
    direction?: "asc" | "desc";
    selectedColumns?: string[];
    filters?: Record<string, string>;
  }) => {
    const params = buildParams(
      next.query ?? searchValue,
      next.view ?? view,
      next.sortValue ?? sortValue,
      next.direction ?? direction,
      next.selectedColumns ?? selectedColumns,
      filters.map((filter) => ({
        ...filter,
        value: next.filters?.[filter.name] ?? currentFilterValues[filter.name] ?? "all",
      })),
    );

    const nextUrl = params.toString() ? `${basePath}?${params.toString()}` : basePath;
    rememberConfig(next.view ?? view, {
      query: next.query ?? searchValue,
      sort: next.sortValue ?? sortValue,
      dir: next.direction ?? direction,
      filters: filters.reduce<Record<string, string>>((accumulator, filter) => {
        const value = next.filters?.[filter.name] ?? currentFilterValues[filter.name] ?? "all";
        if (value !== "all") {
          accumulator[filter.name] = value;
        }
        return accumulator;
      }, {}),
      columns: next.selectedColumns ?? selectedColumns,
    });
    router.replace(nextUrl, { scroll: false });
  }, [basePath, currentFilterValues, direction, filters, rememberConfig, router, searchValue, selectedColumns, sortValue, view]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (searchValue === query) {
        return;
      }

      replaceUrl({ query: searchValue });
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [query, replaceUrl, searchValue]);

  const cardsHref = (() => {
    const cardsViewConfig = mounted ? storedConfig.cards ?? {} : {};
    const params = buildParams(
      cardsViewConfig.query ?? searchValue,
      "cards",
      cardsViewConfig.sort ?? sortValue,
      cardsViewConfig.dir ?? direction,
      cardsViewConfig.columns ?? selectedColumns,
      filters.map((filter) => ({
        ...filter,
        value: cardsViewConfig.filters?.[filter.name] ?? currentFilterValues[filter.name] ?? "all",
      })),
    );
    return params.toString() ? `${pathname}?${params.toString()}` : pathname;
  })();

  const tableHref = (() => {
    const tableViewConfig = mounted ? storedConfig.table ?? {} : {};
    const params = buildParams(
      tableViewConfig.query ?? searchValue,
      "table",
      tableViewConfig.sort ?? sortValue,
      tableViewConfig.dir ?? direction,
      tableViewConfig.columns ?? selectedColumns,
      filters.map((filter) => ({
        ...filter,
        value: tableViewConfig.filters?.[filter.name] ?? currentFilterValues[filter.name] ?? "all",
      })),
    );
    return params.toString() ? `${pathname}?${params.toString()}` : pathname;
  })();

  function addColumn(columnKey: string) {
    setDraftSelectedColumns((current) => (current.includes(columnKey) ? current : [...current, columnKey]));
  }

  function removeColumn(columnKey: string) {
    setDraftSelectedColumns((current) => current.filter((entry) => entry !== columnKey));
  }

  function saveColumns() {
    replaceUrl({
      selectedColumns: draftSelectedColumns,
    });
    setColumnsModalOpen(false);
  }

  function moveColumnToSelected(columnKey: string, targetIndex?: number) {
    setDraftSelectedColumns((current) => {
      const withoutColumn = current.filter((entry) => entry !== columnKey);

      if (targetIndex === undefined || targetIndex < 0 || targetIndex > withoutColumn.length) {
        return [...withoutColumn, columnKey];
      }

      return [
        ...withoutColumn.slice(0, targetIndex),
        columnKey,
        ...withoutColumn.slice(targetIndex),
      ];
    });
  }

  function reorderSelectedColumn(columnKey: string, targetIndex: number) {
    setDraftSelectedColumns((current) => {
      const currentIndex = current.indexOf(columnKey);

      if (currentIndex === -1) {
        return current;
      }

      const withoutColumn = current.filter((entry) => entry !== columnKey);
      const normalizedTargetIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;

      return [
        ...withoutColumn.slice(0, normalizedTargetIndex),
        columnKey,
        ...withoutColumn.slice(normalizedTargetIndex),
      ];
    });
  }

  function handleSelectedDrop(targetIndex: number) {
    if (!draggedColumnKey) {
      return;
    }

    if (draftSelectedColumns.includes(draggedColumnKey)) {
      reorderSelectedColumn(draggedColumnKey, targetIndex);
    } else {
      moveColumnToSelected(draggedColumnKey, targetIndex);
    }

    setDraggedColumnKey(null);
  }

  function handleSelectedItemDrop(event: DragEvent<HTMLDivElement>, itemIndex: number) {
    event.preventDefault();

    const bounds = event.currentTarget.getBoundingClientRect();
    const dropIndex = event.clientY < bounds.top + bounds.height / 2 ? itemIndex : itemIndex + 1;
    handleSelectedDrop(dropIndex);
  }

  function handleDragStart(columnKey: string) {
    setDraggedColumnKey(columnKey);
  }

  function handleDragEnd() {
    setDraggedColumnKey(null);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <Input
            type="search"
            name="q"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 w-[150px] lg:w-[250px] flex-none"
          />
          {filters.map((filter) => (
            <Select
              key={filter.name}
              value={currentFilterValues[filter.name] ?? "all"}
              onValueChange={(value) =>
                replaceUrl({ filters: { ...currentFilterValues, [filter.name]: value } })
              }
            >
              <SelectTrigger size="sm" className="w-auto">
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <Select value={sortValue} onValueChange={(value) => replaceUrl({ sortValue: value })}>
            <SelectTrigger size="sm" className="w-auto">
              <SlidersHorizontal className="size-3.5 shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="text-muted-foreground">
              <SlidersHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onClick={() => replaceUrl({ direction: "asc" })}>
              <ArrowUpAZ />
              <span className="flex-1">Ascending</span>
              {direction === "asc" && <Check />}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => replaceUrl({ direction: "desc" })}>
              <ArrowDownAZ />
              <span className="flex-1">Descending</span>
              {direction === "desc" && <Check />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={cardsHref} onClick={() => rememberView("cards")}>
                <LayoutGrid />
                <span className="flex-1">Cards</span>
                {view === "cards" && <Check />}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={tableHref} onClick={() => rememberView("table")}>
                <Table2 />
                <span className="flex-1">Table</span>
                {view === "table" && <Check />}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setDropdownOpen(false);
                setDraftSelectedColumns(selectedColumns);
                setColumnsModalOpen(true);
              }}
            >
              <Columns3Cog />
              <span className="flex-1">Columns</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AppDialog
        open={columnsModalOpen}
        onOpenChange={setColumnsModalOpen}
        maxWidth="max-w-5xl"
        showCloseButton={false}
        className="flex max-h-[min(88vh,860px)] flex-col"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Configure view</p>
                      <p className="mt-1 text-sm text-muted-foreground">Move columns between available and selected.</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setColumnsModalOpen(false)} aria-label="Close">
                      <X className="size-4" />
                    </Button>
                  </div>

                  <div className="mt-5 grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                    <div className="flex min-h-0 flex-col rounded-panel border border-line bg-surface-strong/76 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Available columns</p>
                      <div
                        className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();

                          if (draggedColumnKey) {
                            removeColumn(draggedColumnKey);
                            setDraggedColumnKey(null);
                          }
                        }}
                      >
                        {availableColumnsBySection.length > 0 ? (
                          availableColumnsBySection.map((section) => (
                            <div key={section.key}>
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                                {section.label}
                              </p>
                              <div className="grid gap-2">
                                {section.columns.map((column) => (
                                  <div
                                    key={column.key}
                                    onClick={() => addColumn(column.key)}
                                    draggable
                                    onDragStart={() => handleDragStart(column.key)}
                                    onDragEnd={handleDragEnd}
                                    className="flex cursor-grab items-center rounded-chip border border-line bg-surface-strong px-3 py-2.5 text-left text-sm text-foreground transition hover:border-line hover:bg-surface-muted active:cursor-grabbing"
                                  >
                                    <span>{column.label}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="text-sm text-muted-foreground">All available columns are already selected.</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-center">
                      <div className="rounded-control border border-line bg-surface-strong/72 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        View
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-col rounded-panel border border-line bg-surface-strong/76 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected columns</p>
                      <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
                        <div className="grid gap-2">
                        {selectedColumnItems.length > 0 ? (
                          <>
                            {selectedColumnItems.map((column, index) => (
                              <div key={column.key} className="grid gap-2">
                                <div
                                  className={cn("h-3 rounded-full border border-dashed transition", draggedColumnKey ? "border-line bg-surface-muted/80" : "border-transparent bg-transparent")}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    handleSelectedDrop(index);
                                  }}
                                />
                                <div
                                  draggable
                                  onClick={() => removeColumn(column.key)}
                                  onDragStart={() => handleDragStart(column.key)}
                                  onDragEnd={handleDragEnd}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={(event) => handleSelectedItemDrop(event, index)}
                                  className="flex cursor-grab items-center rounded-chip border border-line bg-surface-strong px-3 py-2.5 text-left text-sm text-foreground transition hover:border-line hover:bg-surface-muted active:cursor-grabbing"
                                >
                                  <span>{column.label}</span>
                                </div>
                              </div>
                            ))}
                            <div
                              className={cn("h-3 rounded-full border border-dashed transition", draggedColumnKey ? "border-line bg-surface-muted/80" : "border-transparent bg-transparent")}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={(event) => {
                                event.preventDefault();
                                handleSelectedDrop(selectedColumnItems.length);
                              }}
                            />
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Select at least one column to show extra fields in the view.</p>
                        )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex items-center justify-end gap-3">
                    <Button variant="outline" onClick={() => setColumnsModalOpen(false)}>Cancel</Button>
                    <Button onClick={saveColumns}>Save columns</Button>
                  </div>
      </AppDialog>
    </>
  );
}
