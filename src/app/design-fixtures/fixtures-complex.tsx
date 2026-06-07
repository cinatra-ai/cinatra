"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";

import { PrimitiveRow } from "./primitive-row";

export function ComplexPrimitives() {
  return (
    <div className="flex flex-col">
      <PrimitiveRow name="Table" spec="@/components/ui/table" conformance="Mono-uppercase header; navy underline; seersucker zebra (--stripe-light / --stripe-mid); IDs/times mono 11px slate.">
        <Table className="w-full">
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Run</TableHead>
              <TableHead className="text-right">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Outreach</TableCell>
              <TableCell className="font-mono">#2,318</TableCell>
              <TableCell className="text-right font-mono">14:21</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Research</TableCell>
              <TableCell className="font-mono">#0,931</TableCell>
              <TableCell className="text-right font-mono">11:08</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </PrimitiveRow>

      <PrimitiveRow name="Tooltip" spec="@/components/ui/tooltip" conformance="Navy ground · cream text · 200ms delay · 12px text.">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm">Hover me</Button>
            </TooltipTrigger>
            <TooltipContent>Tooltip — navy bg, cream text</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </PrimitiveRow>

      <PrimitiveRow name="Popover" spec="@/components/ui/popover" conformance="--surface-strong bg, hairline border, navy text, 13–14px.">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">Open popover</Button>
          </PopoverTrigger>
          <PopoverContent className="text-sm">Popover body content.</PopoverContent>
        </Popover>
      </PrimitiveRow>

      <PrimitiveRow name="Breadcrumb" spec="@/components/ui/breadcrumb" conformance="Slate links, ink current, chevron separator 12px 50% opacity.">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Intelligence</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Agents</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Run #2,318</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </PrimitiveRow>

      <PrimitiveRow name="Pagination" spec="@/components/ui/pagination" conformance="Mono 13px; active ink fill; prev/next chevrons.">
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#" isActive>1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">2</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#">3</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </PrimitiveRow>

      <PrimitiveRow name="Avatar" spec="@/components/ui/avatar" conformance="36–40px; random accent ground; italic 800 initial utility.">
        <Avatar>
          <AvatarFallback>O</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>E</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>R</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>M</AvatarFallback>
        </Avatar>
      </PrimitiveRow>

      <PrimitiveRow name="Skeleton + Spinner" spec="@/components/ui/skeleton · spinner" conformance="Skeleton --surface-muted bars; Spinner indigo arc 1s linear.">
        <Skeleton className="h-6 w-32" />
        <Spinner />
      </PrimitiveRow>

      <PrimitiveRow name="Alert" spec="@/components/ui/alert" conformance="Tinted bg + border at status colour; 12–14px text; 4 variants (default/info/success/warning/destructive).">
        <Alert className="w-full max-w-2xl">
          <AlertTitle>Approval expired</AlertTitle>
          <AlertDescription>The hold window closed at 15:30.</AlertDescription>
        </Alert>
      </PrimitiveRow>

      <PrimitiveRow name="Checkbox / Radio / Switch" spec="@/components/ui" conformance="Control 16–18px; indigo when on; surface-muted when off.">
        <div className="flex items-center gap-2">
          <Checkbox id="cb" />
          <label htmlFor="cb" className="text-sm text-foreground">Email me</label>
        </div>
        <RadioGroup defaultValue="daily" className="flex gap-3">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="r1" value="daily" />
            <label htmlFor="r1" className="text-sm text-foreground">Daily</label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="r2" value="live" />
            <label htmlFor="r2" className="text-sm text-foreground">Live</label>
          </div>
        </RadioGroup>
        <div className="flex items-center gap-2">
          <Switch id="sw" aria-label="Enable notifications (design fixture)" />
          <label htmlFor="sw" className="text-sm text-foreground">Enable</label>
        </div>
      </PrimitiveRow>

      <PrimitiveRow name="Empty" spec="@/components/ui/empty" conformance="Centred; dashed circle icon; 14px headline; 12px helper; single primary action.">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>Roll a campaign to see runs here.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm">New campaign</Button>
          </EmptyContent>
        </Empty>
      </PrimitiveRow>
    </div>
  );
}
