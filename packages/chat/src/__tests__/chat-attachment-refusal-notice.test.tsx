// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ChatAttachmentRefusalNotice } from "../chat-attachment-refusal-notice";
import type { ChatAttachmentRefusal } from "../ag-ui-chat-client";

// next/link is fine in jsdom (renders an <a>); no router provider needed for a
// bare href.

afterEach(cleanup);

const zipRefusal: ChatAttachmentRefusal = {
  filename: "bundle.zip",
  status: 415,
  mime: "application/zip",
  message: '"bundle.zip" can\'t be attached — no installed type accepts this file format.',
  marketplaceHref: "/configuration/marketplace?accepts=application%2Fzip",
};

describe("ChatAttachmentRefusalNotice", () => {
  it("renders nothing when there are no refusals", () => {
    const { container } = render(
      <ChatAttachmentRefusalNotice refusals={[]} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("surfaces the refusal message + the marketplace recourse link", () => {
    render(
      <ChatAttachmentRefusalNotice refusals={[zipRefusal]} onDismiss={() => {}} />,
    );
    expect(screen.getByText(/no installed type accepts/i)).toBeTruthy();
    expect(screen.getByText(/bundle\.zip/)).toBeTruthy();
    const link = screen.getByRole("link", {
      name: /install a type that accepts this/i,
    });
    expect(link.getAttribute("href")).toBe(
      "/configuration/marketplace?accepts=application%2Fzip",
    );
  });

  it("omits the recourse link when the refusal carries no marketplaceHref", () => {
    const noLink: ChatAttachmentRefusal = {
      filename: "big.bin",
      status: 413,
      message: '"big.bin" is too large to attach.',
    };
    render(<ChatAttachmentRefusalNotice refusals={[noLink]} onDismiss={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/too large to attach/i)).toBeTruthy();
  });

  it("pluralizes the header and lists each refusal", () => {
    render(
      <ChatAttachmentRefusalNotice
        refusals={[zipRefusal, { filename: "big.bin", status: 413, message: '"big.bin" is too large to attach.' }]}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/2 files weren't attached/i)).toBeTruthy();
  });

  it("invokes onDismiss when the dismiss control is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <ChatAttachmentRefusalNotice refusals={[zipRefusal]} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
