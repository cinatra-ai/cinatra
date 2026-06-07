"use client";

import * as Sentry from "@sentry/nextjs";
import { Component, type ErrorInfo, type ReactNode } from "react";

type RenderErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

type RenderErrorBoundaryState = {
  hasError: boolean;
};

export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError() {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("RenderErrorBoundary caught an error", error, errorInfo);
    // Forward client render errors to Sentry. No-op when not
    // initialised; swallows Sentry-internal errors so the boundary itself
    // never crashes.
    try {
      Sentry.captureException(error, {
        contexts: {
          react: {
            componentStack: errorInfo.componentStack ?? undefined,
          },
        },
      });
    } catch {
      // No-op.
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }

    return this.props.children;
  }
}
