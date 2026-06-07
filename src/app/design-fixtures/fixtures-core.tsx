"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

import { PrimitiveRow } from "./primitive-row";

export function CorePrimitives() {
  return (
    <div className="flex flex-col">
      <PrimitiveRow name="Button" spec="@/components/ui/button" conformance="7 variants; indigo primary; destructive red-on-tint (not solid).">
        <Button>Primary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="destructive">Decline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Learn more</Button>
      </PrimitiveRow>

      <PrimitiveRow name="Card" spec="@/components/ui/card" conformance="--surface non-interactive; --surface-strong on click/hover (rule #8).">
        <Card className="w-72 border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle>Run #2,318</CardTitle>
          </CardHeader>
          <CardContent>Outreach started 14:21 today.</CardContent>
        </Card>
        <Card className="w-72 border-line bg-surface-strong">
          <CardHeader>
            <CardTitle>Clickable card</CardTitle>
          </CardHeader>
          <CardContent>Hover lifts 1px.</CardContent>
        </Card>
      </PrimitiveRow>

      <PrimitiveRow name="Input / Textarea" spec="@/components/ui/input · textarea" conformance="--surface-strong bg; --line-strong navy border.">
        <Input placeholder="Campaign name" className="w-72" />
        <Textarea placeholder="Notes" className="w-72" />
      </PrimitiveRow>

      <PrimitiveRow name="Select" spec="@/components/ui/select" conformance="Trigger mirrors Input chrome; popover on --surface-strong.">
        <Select>
          {/* aria-label so axe-core can resolve the accessible name in the
              fixture context (no associated <label> outside the trigger). */}
          <SelectTrigger className="w-72" aria-label="Time-range filter (design fixture)">
            <SelectValue placeholder="Most-used today" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Most-used today</SelectItem>
            <SelectItem value="b">Last 24 hours</SelectItem>
          </SelectContent>
        </Select>
      </PrimitiveRow>

      <PrimitiveRow name="Dialog" spec="@/components/ui/dialog" conformance="Top: 4rem; dim overlay; etched paired-line header rule utility.">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve drafts</DialogTitle>
            </DialogHeader>
            Twelve drafts pending your read.
          </DialogContent>
        </Dialog>
      </PrimitiveRow>

      <PrimitiveRow name="Sheet" spec="@/components/ui/sheet" conformance="Full-height; right-side default; dim overlay.">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open sheet</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Run inspector</SheetTitle>
            </SheetHeader>
            Side-loaded inspection panel.
          </SheetContent>
        </Sheet>
      </PrimitiveRow>

      <PrimitiveRow name="Form / Field / Label" spec="@/components/ui/form" conformance="Label 12px 600; helper 11px muted; error swaps helper to destructive.">
        <Field>
          <Label htmlFor="cn">Campaign name</Label>
          <Input id="cn" className="w-72" placeholder="Q3 outreach" />
          <p className="text-xs text-muted-foreground">Visible only to your team.</p>
        </Field>
      </PrimitiveRow>

      <PrimitiveRow name="Badge" spec="@/components/ui/badge" conformance="Dumb chip — status semantics use StatusPill; badge for raw labels.">
        <Badge>New</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </PrimitiveRow>

      <PrimitiveRow name="Tabs" spec="@/components/ui/tabs" conformance="Underline only; 2px indigo active; slate inactive.">
        <Tabs defaultValue="overview" className="w-96">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-2 text-sm text-muted-foreground">Overview content.</TabsContent>
        </Tabs>
      </PrimitiveRow>

      <PrimitiveRow name="Separator" spec="@/components/ui/separator" conformance="Hairline default; data-major attribute switches to etched paired-line.">
        <div className="w-72 space-y-2">
          <p className="text-sm text-foreground">Above</p>
          <Separator />
          <p className="text-sm text-foreground">Below</p>
          <Separator className="divider-etched" />
          <p className="text-sm text-muted-foreground">After etched utility</p>
        </div>
      </PrimitiveRow>
    </div>
  );
}
