"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

import { Button } from "@/components/ui/button";

/**
 * Global error boundary for the root layout.
 * Without this file, any unhandled exception in a root-level Server Component
 * (including layout.tsx) produces a completely blank/white page in Next.js
 * App Router — no error overlay, no feedback to the user.
 *
 * This boundary catches such exceptions and displays the error details so the
 * developer can identify the actual root cause instead of seeing a blank page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Forward root-level exceptions to Sentry. No-op when Sentry was not
  // initialized (SENTRY_DSN unset).
  useEffect(() => {
    try {
      Sentry.captureException(error);
    } catch {
      // Sentry-internal failures must not crash the error boundary itself.
    }
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          padding: "2rem",
          fontFamily: "system-ui, sans-serif",
          background: "#0f0f0f",
          color: "#e5e5e5",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            maxWidth: "600px",
            margin: "0 auto",
            paddingTop: "4rem",
          }}
        >
          <h1 style={{ color: "#ef4444", fontSize: "1.5rem", marginBottom: "1rem" }}>
            Application Error
          </h1>
          <p style={{ color: "#a3a3a3", marginBottom: "1.5rem" }}>
            An unexpected error occurred while rendering the application.
          </p>
          <div
            style={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              padding: "1rem",
              marginBottom: "1.5rem",
              fontFamily: "monospace",
              fontSize: "0.875rem",
            }}
          >
            <div style={{ color: "#ef4444", marginBottom: "0.5rem" }}>
              {error?.name ?? "Error"}: {error?.message ?? "Unknown error"}
            </div>
            {error?.digest && (
              <div style={{ color: "#737373" }}>
                Digest: {error.digest}
              </div>
            )}
            {error?.stack && (
              <pre
                style={{
                  color: "#a3a3a3",
                  marginTop: "0.75rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "0.75rem",
                }}
              >
                {error.stack}
              </pre>
            )}
          </div>
          <Button
            type="button"
            onClick={reset}
            style={{
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              padding: "0.5rem 1rem",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Try again
          </Button>
        </div>
      </body>
    </html>
  );
}
