import { NextResponse } from "next/server";
import { clearAllProviderLogEntries } from "@/lib/logging";

export async function DELETE() {
  try {
    await clearAllProviderLogEntries();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to purge API logs.",
      },
      { status: 500 },
    );
  }
}
