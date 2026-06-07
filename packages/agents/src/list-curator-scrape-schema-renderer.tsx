"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LinkIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type {
  FieldRendererCondition,
  FieldRendererProps,
} from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export const isListCuratorScrapeSchemaField: FieldRendererCondition = (
  _f,
  schema,
) =>
  (schema as { ["x-renderer"]?: string })["x-renderer"] ===
  "@cinatra-ai/list-curator-agent:scrape-schema-review";

// ---------------------------------------------------------------------------
// Value shape
// ---------------------------------------------------------------------------

type ScrapeSchemaValue = {
  instructions: string;
  outputSchema: Record<string, unknown>;
  seedUrls: string[];
};

function toScrapeSchemaValue(value: unknown): ScrapeSchemaValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const seedUrls = Array.isArray(v.seedUrls)
      ? (v.seedUrls.filter((u) => typeof u === "string") as string[])
      : [];
    return {
      instructions: typeof v.instructions === "string" ? v.instructions : "",
      outputSchema:
        v.outputSchema && typeof v.outputSchema === "object"
          ? (v.outputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
      seedUrls,
    };
  }
  return {
    instructions: "",
    outputSchema: { type: "object", properties: {} },
    seedUrls: [],
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function ListCuratorScrapeSchemaRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const initial = useMemo(() => toScrapeSchemaValue(value), [value]);
  const [instructions, setInstructions] = useState<string>(initial.instructions);
  const [outputSchemaText, setOutputSchemaText] = useState<string>(
    JSON.stringify(initial.outputSchema, null, 2),
  );
  const [seedUrls, setSeedUrls] = useState<string[]>(initial.seedUrls);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Stable onChange ref (mirrors list-picker-renderer pattern).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Re-validate the schema text on every change. The Approve button is
  // disabled while the schema text is invalid OR no seedUrls remain.
  useEffect(() => {
    try {
      JSON.parse(outputSchemaText);
      setSchemaError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid JSON";
      setSchemaError(`Invalid JSON: ${msg}`);
    }
  }, [outputSchemaText]);

  const approveDisabled =
    disabled === true ||
    schemaError !== null ||
    seedUrls.filter((u) => u.trim() !== "").length === 0;

  const handleApprove = () => {
    if (schemaError !== null) return;
    let parsedSchema: Record<string, unknown>;
    try {
      parsedSchema = JSON.parse(outputSchemaText) as Record<string, unknown>;
    } catch {
      return;
    }
    onChangeRef.current({
      approved: true,
      instructions,
      outputSchema: parsedSchema,
      seedUrls: seedUrls.filter((u) => u.trim() !== ""),
    });
  };

  const handleReject = () => {
    onChangeRef.current({ approved: false });
  };

  const handleAddUrl = () => {
    setSeedUrls((prev) => [...prev, ""]);
  };

  const handleRemoveUrl = (idx: number) => {
    setSeedUrls((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleEditUrl = (idx: number, next: string) => {
    setSeedUrls((prev) => prev.map((u, i) => (i === idx ? next : u)));
  };

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Review scrape schema</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="list-curator-instructions">Instructions</Label>
          <Textarea
            id="list-curator-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={4}
            disabled={disabled === true}
            placeholder="Per-row extraction instructions for the scrape child."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="list-curator-schema">Output schema (JSON Schema)</Label>
          <Textarea
            id="list-curator-schema"
            value={outputSchemaText}
            onChange={(e) => setOutputSchemaText(e.target.value)}
            rows={8}
            spellCheck={false}
            disabled={disabled === true}
            className="font-mono text-sm"
          />
          {schemaError !== null && (
            <p className="text-sm text-destructive">{schemaError}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Seed URLs</Label>
          {seedUrls.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No seed URLs. Add at least one to enable Approve.
            </p>
          )}
          {seedUrls.map((url, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Badge variant="outline">#{idx + 1}</Badge>
              <InputGroup className="flex-1">
                <InputGroupAddon>
                  <LinkIcon aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  type="url"
                  value={url}
                  onChange={(e) => handleEditUrl(idx, e.target.value)}
                  placeholder="https://example.com/path"
                  disabled={disabled === true}
                />
              </InputGroup>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRemoveUrl(idx)}
                disabled={disabled === true}
                aria-label={`Remove URL ${idx + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddUrl}
              disabled={disabled === true}
            >
              Add URL
            </Button>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button
          variant="default"
          onClick={handleApprove}
          disabled={approveDisabled}
        >
          Approve
        </Button>
        <Button variant="outline" onClick={handleReject} disabled={disabled === true}>
          Reject
        </Button>
      </CardFooter>
    </Card>
  );
}
