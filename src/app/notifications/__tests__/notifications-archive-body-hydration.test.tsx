/** @vitest-environment jsdom */

import React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";

import { NotificationsArchiveBody } from "../notifications-archive-body";

function notification(): AppNotification {
  return {
    id: "n-1",
    title: "Finished",
    body: "Background task completed.",
    kind: "success",
    createdAt: "2026-05-15T05:12:13.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationsArchiveBody hydration", () => {
  it("server-renders archive timestamps with a locale-independent label", () => {
    const notifications: AppNotification[] = [notification()];

    const html = renderToString(
      React.createElement(NotificationsArchiveBody, { notifications }),
    );

    expect(html).toContain("2026-05-15 05:12:13 UTC");
    expect(html).not.toContain("5/15/2026");
    expect(html).not.toContain("15/05/2026");
  });

  it("hydrates without a recoverable error when the browser locale label differs", async () => {
    const notifications: AppNotification[] = [notification()];
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue(
      "15/05/2026, 07:12:13",
    );
    const html = renderToString(
      React.createElement(NotificationsArchiveBody, { notifications }),
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      hydrateRoot(
        container,
        React.createElement(NotificationsArchiveBody, { notifications }),
        {
          onRecoverableError(error) {
            recoverableErrors.push(error);
          },
        },
      );
      await Promise.resolve();
    });

    expect(recoverableErrors).toHaveLength(0);
  });
});
