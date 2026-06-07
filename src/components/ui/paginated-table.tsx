"use client"

import * as React from "react"

import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { Table } from "@/components/ui/table"
import { cn } from "@/lib/utils"

const DEFAULT_TABLE_PAGE_SIZE = 25

type PaginatedTableProps = React.ComponentProps<typeof Table> & {
  pageSize?: number
  pagination?: boolean
}

function getTableBodyRows(frame: HTMLDivElement | null): HTMLTableRowElement[] {
  const table = frame?.querySelector("table")

  if (!table) {
    return []
  }

  return Array.from(table.tBodies).flatMap((body) => Array.from(body.rows))
}

function PaginatedTable({
  className,
  children,
  id,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  pagination = true,
  ...props
}: PaginatedTableProps) {
  const generatedTableId = React.useId()
  const tableId = id ?? generatedTableId
  const frameRef = React.useRef<HTMLDivElement>(null)
  const [rowCount, setRowCount] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0
    ? pageSize
    : DEFAULT_TABLE_PAGE_SIZE
  const shouldPaginate = pagination && rowCount > safePageSize
  const pageCount = shouldPaginate ? Math.ceil(rowCount / safePageSize) : 1
  const safePageIndex = shouldPaginate
    ? Math.min(pageIndex, Math.max(0, pageCount - 1))
    : 0
  const firstRow = shouldPaginate ? safePageIndex * safePageSize + 1 : 1
  const lastRow = shouldPaginate
    ? Math.min(rowCount, (safePageIndex + 1) * safePageSize)
    : rowCount
  const isFirstPage = safePageIndex === 0
  const isLastPage = safePageIndex >= pageCount - 1

  const refreshRowCount = React.useCallback(() => {
    setRowCount(getTableBodyRows(frameRef.current).length)
  }, [])

  React.useEffect(() => {
    refreshRowCount()

    const frame = frameRef.current
    if (!frame || typeof MutationObserver === "undefined") {
      return
    }

    const observer = new MutationObserver(refreshRowCount)
    observer.observe(frame, { childList: true, subtree: true })

    return () => observer.disconnect()
  }, [children, refreshRowCount])

  React.useEffect(() => {
    setPageIndex((current) => Math.min(current, Math.max(0, pageCount - 1)))
  }, [pageCount])

  React.useEffect(() => {
    const frame = frameRef.current
    const rows = getTableBodyRows(frame)
    const firstVisibleRow = safePageIndex * safePageSize
    const lastVisibleRow = firstVisibleRow + safePageSize

    rows.forEach((row, index) => {
      row.hidden = shouldPaginate && (index < firstVisibleRow || index >= lastVisibleRow)
    })

    return () => {
      getTableBodyRows(frame).forEach((row) => {
        row.hidden = false
      })
    }
  }, [children, rowCount, safePageIndex, safePageSize, shouldPaginate])

  const handlePrevious = React.useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()

    if (!isFirstPage) {
      setPageIndex((current) => Math.max(0, current - 1))
    }
  }, [isFirstPage])

  const handleNext = React.useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()

    if (!isLastPage) {
      setPageIndex((current) => Math.min(pageCount - 1, current + 1))
    }
  }, [isLastPage, pageCount])

  return (
    <div
      ref={frameRef}
      data-slot="table-frame"
      className="w-full overflow-hidden rounded-md border bg-background"
    >
      <Table
        id={tableId}
        className={className}
        {...props}
      >
        {children}
      </Table>
      {shouldPaginate ? (
        <div
          data-slot="table-pagination"
          className="flex flex-col gap-2 border-t border-line px-3 py-2 font-mono text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
        >
          <span aria-live="polite">
            {firstRow}–{lastRow} of {rowCount}
          </span>
          <div className="flex items-center gap-3">
            <span>
              Page {safePageIndex + 1} of {pageCount}
            </span>
            <Pagination className="mx-0 w-auto justify-end">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href={`#${tableId}`}
                    aria-disabled={isFirstPage}
                    tabIndex={isFirstPage ? -1 : undefined}
                    className={cn(isFirstPage && "pointer-events-none opacity-50")}
                    onClick={handlePrevious}
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    href={`#${tableId}`}
                    aria-disabled={isLastPage}
                    tabIndex={isLastPage ? -1 : undefined}
                    className={cn(isLastPage && "pointer-events-none opacity-50")}
                    onClick={handleNext}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export { PaginatedTable }
