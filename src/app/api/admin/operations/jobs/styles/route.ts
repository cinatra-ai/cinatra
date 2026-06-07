import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cssPath = path.join(process.cwd(), "node_modules", "@queuedash", "ui", "dist", "styles.css");
  const css = await readFile(cssPath, "utf8");

  return new NextResponse(css, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
