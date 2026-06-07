import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { error: "Use /api/transcript-generators/{generatorId}/transcripts instead." },
    { status: 410 },
  );
}

export async function POST() {
  return NextResponse.json(
    { error: "Use /api/transcript-generators/{generatorId}/transcripts instead." },
    { status: 410 },
  );
}
