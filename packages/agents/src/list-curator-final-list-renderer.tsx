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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type {
  FieldRendererProps,
} from "./field-renderer-registry";

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

// Condition: registered from the manifest binding (kind "final-list-review")
// with strict ID matching — see register-default-renderers.ts.

// ---------------------------------------------------------------------------
// Value shape
// ---------------------------------------------------------------------------

type MemberRef = {
  objectType: string;
  objectId: string;
  displayName?: string;
  accountId?: string; // optional grouping hint for the "mixed" case
};

type FailureItem = {
  rowIndex?: number;
  stage?: string;
  error?: string;
  accountId?: string;
};

type FinalListValue = {
  listName: string;
  memberRefs: MemberRef[];
  memberCount: number;
  accountsCreated: number;
  contactsCreated: number;
  failures: FailureItem[];
};

function toFinalListValue(value: unknown): FinalListValue {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const memberRefs = Array.isArray(v.memberRefs)
      ? (v.memberRefs.filter((r) => {
          if (!r || typeof r !== "object") return false;
          const ref = r as Record<string, unknown>;
          return (
            typeof ref.objectType === "string" && typeof ref.objectId === "string"
          );
        }) as MemberRef[])
      : [];
    const failures = Array.isArray(v.failures)
      ? (v.failures.filter(
          (f) => f && typeof f === "object",
        ) as FailureItem[])
      : [];
    return {
      listName: typeof v.listName === "string" ? v.listName : "",
      memberRefs,
      memberCount:
        typeof v.memberCount === "number" ? v.memberCount : memberRefs.length,
      accountsCreated: typeof v.accountsCreated === "number" ? v.accountsCreated : 0,
      contactsCreated: typeof v.contactsCreated === "number" ? v.contactsCreated : 0,
      failures,
    };
  }
  return {
    listName: "",
    memberRefs: [],
    memberCount: 0,
    accountsCreated: 0,
    contactsCreated: 0,
    failures: [],
  };
}

function shortObjectType(objectType: string): string {
  if (objectType.endsWith(":account")) return "account";
  if (objectType.endsWith(":contact")) return "contact";
  return objectType;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function ListCuratorFinalListRenderer({
  value,
  onChange,
  disabled,
}: FieldRendererProps) {
  const v = useMemo(() => toFinalListValue(value), [value]);
  const [listName, setListName] = useState<string>(v.listName);

  // Stable onChange ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const approveDisabled = disabled === true || listName.trim() === "";

  const handleApprove = () => {
    if (listName.trim() === "") return;
    onChangeRef.current({ approved: true, listName });
  };

  const handleCancel = () => {
    onChangeRef.current({ approved: false });
  };

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle>Review final list</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="list-curator-list-name">List name</Label>
          <Input
            id="list-curator-list-name"
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            placeholder="Final list name"
            disabled={disabled === true}
          />
        </div>

        <Card className="border-line bg-surface-muted backdrop-blur-none">
          <CardContent className="flex flex-wrap gap-2 py-3">
            <Badge variant="secondary">{v.memberCount} members</Badge>
            <Badge variant="secondary">{v.accountsCreated} accounts created</Badge>
            <Badge variant="secondary">{v.contactsCreated} contacts created</Badge>
          </CardContent>
        </Card>

        <Card className="border-line bg-surface backdrop-blur-none">
          <CardHeader>
            <CardTitle className="text-base">Members</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {v.memberRefs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members.</p>
            ) : (
              v.memberRefs.map((ref, idx) => (
                <div
                  key={`${ref.objectType}:${ref.objectId}:${idx}`}
                  className="flex items-center gap-2"
                >
                  <Badge variant="outline">{shortObjectType(ref.objectType)}</Badge>
                  <span className="text-sm text-foreground">
                    {ref.displayName ?? ref.objectId}
                  </span>
                  {ref.displayName !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      ({ref.objectId})
                    </span>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {v.failures.length > 0 && (
          <Card className="border-destructive/40 bg-surface backdrop-blur-none">
            <CardHeader>
              <CardTitle className="text-base text-destructive">
                Failures ({v.failures.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {v.failures.map((f, idx) => (
                <p
                  key={idx}
                  className="text-sm text-destructive"
                >
                  {f.rowIndex !== undefined ? `row ${f.rowIndex} ` : ""}
                  {f.stage ?? "unknown"}: {f.error ?? "unknown error"}
                  {f.accountId !== undefined ? ` (accountId=${f.accountId})` : ""}
                </p>
              ))}
            </CardContent>
          </Card>
        )}
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button
          variant="default"
          onClick={handleApprove}
          disabled={approveDisabled}
        >
          Approve list
        </Button>
        <Button variant="outline" onClick={handleCancel} disabled={disabled === true}>
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}
