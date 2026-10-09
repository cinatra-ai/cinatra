"use client";

/**
 * The components drawing's component surfaces on the conformance harness (the
 * shared-primitives wave). One mount per manifest surface, in manifest order,
 * each holding the SHIPPED primitive from `@/components/ui/**` with static,
 * dataless content: no copy of a primitive, no restyle, no network, no store,
 * no timer. Overlays (dialog, select, combobox, tooltip) are mounted closed by
 * their own trigger, so nothing covers the page at load; the driver opens each
 * one through that trigger. Each mount's driver reads the primitive's own
 * data-slot marker (tests/e2e/design/conformance/component-surface-drivers.ts).
 */
import { useForm } from "react-hook-form";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { Toolbar, ToolbarButton, ToolbarChild, ToolbarGroup } from "@/components/ui/toolbar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const COMBOBOX_OPTIONS = [
  { value: "research", label: "Research" },
  { value: "operations", label: "Operations" },
  { value: "support", label: "Support" },
];

const SCROLL_ROWS = ["First run", "Second run", "Third run", "Fourth run", "Fifth run", "Sixth run", "Seventh run", "Eighth run"];

/** The form primitive's item, label and control under its own form context. */
function FormSurface() {
  const form = useForm<{ workspace: string }>({ defaultValues: { workspace: "" } });
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="workspace"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Workspace name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
          </FormItem>
        )}
      />
    </Form>
  );
}

export function ComponentSurfaceConformanceFixtures() {
  return (
    <div className="flex flex-col gap-6">
      <div data-surface-id="button">
        <Button type="button">Save draft</Button>
      </div>

      <div data-surface-id="card">
        <Card>
          <CardHeader>
            <CardTitle>Weekly digest</CardTitle>
            <CardDescription>Three runs finished this week.</CardDescription>
          </CardHeader>
          <CardContent>The card body holds static text.</CardContent>
        </Card>
      </div>

      <div data-surface-id="input">
        <Input aria-label="Workspace title" placeholder="Workspace title" />
      </div>

      <div data-surface-id="select">
        <Select>
          <SelectTrigger aria-label="Sort order">
            <SelectValue placeholder="Most recent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Most recent</SelectItem>
            <SelectItem value="name">Name</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div data-surface-id="dialog">
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline">
              Open dialog
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename workspace</DialogTitle>
              <DialogDescription>The dialog body holds static text.</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </div>

      <div data-surface-id="badge">
        <Badge>Beta</Badge>
      </div>

      <div data-surface-id="tabs">
        <Tabs defaultValue="overview">
          <TabsList aria-label="Workspace sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">The overview panel holds static text.</TabsContent>
          <TabsContent value="activity">The activity panel holds static text.</TabsContent>
        </Tabs>
      </div>

      <div data-surface-id="toolbar">
        <Toolbar aria-label="Run filters">
          <ToolbarGroup>
            <ToolbarButton type="button" active>
              All
            </ToolbarButton>
            <ToolbarButton type="button">Failed</ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
      </div>

      <div data-surface-id="toolbar-nested">
        <Toolbar aria-label="Views">
          <ToolbarGroup>
            <ToolbarButton type="button" active>
              Board
            </ToolbarButton>
            <ToolbarButton type="button">List</ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
        <ToolbarChild level={2} aria-label="Board options">
          <ToolbarGroup>
            <ToolbarButton type="button" active>
              Grouped
            </ToolbarButton>
            <ToolbarButton type="button">Flat</ToolbarButton>
          </ToolbarGroup>
        </ToolbarChild>
      </div>

      <div data-surface-id="sidebar">
        <SidebarProvider className="min-h-0">
          <Sidebar collapsible="none">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Workspace</SidebarGroupLabel>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>Chat</SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Agents</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      </div>

      <div data-surface-id="sidebar-group-label">
        <SidebarProvider className="min-h-0">
          <SidebarGroup>
            <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          </SidebarGroup>
        </SidebarProvider>
      </div>

      <div data-surface-id="tooltip">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline">
                Show hint
              </Button>
            </TooltipTrigger>
            <TooltipContent>The hint holds static text.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div data-surface-id="avatar">
        <Avatar>
          <AvatarFallback>FX</AvatarFallback>
        </Avatar>
      </div>

      <div data-surface-id="form">
        <FormSurface />
      </div>

      <div data-surface-id="checkbox">
        <Checkbox aria-label="Notify me when a run finishes" />
      </div>

      <div data-surface-id="alert">
        <Alert>
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>The alert body holds static text.</AlertDescription>
        </Alert>
      </div>

      <div data-surface-id="table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Outreach</TableCell>
              <TableCell>Finished</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Enricher</TableCell>
              <TableCell>Queued</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div data-surface-id="command">
        <Command label="Command menu">
          <CommandInput aria-label="Type a command" placeholder="Type a command" />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem>New run</CommandItem>
              <CommandItem>Open settings</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>

      <div data-surface-id="breadcrumb">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#crumb-workspace">Workspace</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Agents</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div data-surface-id="pagination">
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#page-one" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page-one">1</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#page-two" isActive>
                2
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#page-three" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>

      <div data-surface-id="skeleton">
        <Skeleton className="h-4 w-48" />
      </div>

      <div data-surface-id="empty">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>Runs you start appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>

      <div data-surface-id="accordion">
        <Accordion type="single" collapsible>
          <AccordionItem value="run">
            <AccordionTrigger>What is a run?</AccordionTrigger>
            <AccordionContent>One execution of an agent.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* The components drawing's Separator section draws the row divider as a one-pixel hairline; the primitive states
          that height with a variant Radix's orientation attribute never matches (src/components/ui/separator.tsx:25), so
          the mount states it itself until the primitive does, and the pixel suite and the driver read a real box. */}
      <div data-surface-id="separator">
        <Separator className="h-px" />
      </div>

      <div data-surface-id="toggle">
        <Toggle aria-label="Pin to sidebar">Pin</Toggle>
      </div>

      <div data-surface-id="calendar">
        <Calendar value="2026-03-12" today="2026-03-09" />
      </div>

      <div data-surface-id="combobox">
        <Combobox aria-label="Team" options={COMBOBOX_OPTIONS} placeholder="Choose a team" />
      </div>

      <div data-surface-id="scroll-area">
        <ScrollArea className="h-24 w-64">
          {SCROLL_ROWS.map((row) => (
            <div key={row}>{row}</div>
          ))}
        </ScrollArea>
      </div>

      <div data-surface-id="input-otp">
        <InputOTP maxLength={6} aria-label="One-time code">
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </div>
    </div>
  );
}
