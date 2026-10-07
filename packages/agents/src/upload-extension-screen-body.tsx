// ---------------------------------------------------------------------------
// The Upload Extension screen's own JSX body (design spec Extensions §VIII,
// cinatra#3204; extracted for the design-conformance harness, cinatra#3546).
//
// WHY IT IS ITS OWN COMPONENT. `AgentBuilderImportScreen` (./screens) is an
// async SERVER function: it awaits the admin session and resolves the store's
// install-picker context before it draws anything, so the screen itself cannot
// be mounted on the conformance harness, which boots with no session and no
// database. Everything AFTER that resolve is this file — the eyebrow, the
// title, the Back-to-Marketplace action, the two-tab strip and the two tabs'
// forms — taken verbatim and props-only. The shipped route renders it with the
// scope it resolved; the harness mount renders the SAME component with a
// planted one. There is exactly ONE drawing of this screen in the tree.
//
// The two conformance anchors on it are attributes on elements that already
// exist (testid-contract.json records them): the screen root carries the
// manifest surface id, and the header's single outline control carries the
// name of the action the drawing gives it.
// ---------------------------------------------------------------------------

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";

import { ImportAgentForm } from "./import-form";
import {
  ImportPackageFromGitHubForm,
  type UploadGitHubFormHarness,
} from "./upload-repository-link-form";
import type { UploadInstallScopeContext } from "./upload-install-scope-panel";

export type UploadExtensionScreenBodyProps = {
  /** Resolved once on the server by the route, planted by the harness mount. */
  installScope: UploadInstallScopeContext;
  /**
   * Conformance-harness seam, forwarded untouched to the GitHub tab — see
   * `UploadGitHubFormHarness` in ./upload-repository-link-form. Absent on
   * every shipped road.
   */
  githubHarness?: UploadGitHubFormHarness;
  /**
   * Which outer element the body draws around its unchanged subtree.
   *
   *  - "page" (DEFAULT) — the page shell the shipped route draws: the
   *    viewport-claiming `Main`. Every shipped road takes this and is
   *    unchanged by the option existing.
   *  - "bare" — a plain container element claiming no viewport, for a mounting
   *    that is ALREADY inside a page (the conformance harness mounts this body
   *    inside its own page's card, and a second page shell nested there
   *    re-flows the page every other mount on it is measured in).
   *
   * The header, the content wrapper, the tab strip, both tabs' forms and the
   * surface id on the outer node are identical either way.
   */
  outerElement?: "page" | "bare";
};

export function UploadExtensionScreenBody({
  installScope,
  githubHarness,
  outerElement = "page",
}: UploadExtensionScreenBodyProps) {
  const body = (
    <>
      <PageHeader
        label="Extensions"
        title="Upload Extension"
        actions={
          <Button asChild variant="outline">
            <Link href="/configuration/marketplace" data-conformance-id="back-to-marketplace">
              Back to Marketplace
            </Link>
          </Button>
        }
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Tabs defaultValue="file" className="max-w-2xl">
          <TabsListRow>
            <TabsTrigger value="file">File</TabsTrigger>
            <TabsTrigger value="github">GitHub</TabsTrigger>
          </TabsListRow>
          <TabsContent value="file">
            <div className="soft-panel rounded-card px-6 py-5 max-w-xl">
              <ImportAgentForm installScope={installScope} />
            </div>
          </TabsContent>
          <TabsContent value="github">
            <div className="soft-panel rounded-card px-6 py-5">
              <ImportPackageFromGitHubForm
                installScope={installScope}
                harness={githubHarness}
              />
            </div>
          </TabsContent>
        </Tabs>
      </PageContent>
    </>
  );

  if (outerElement === "bare") {
    return <div data-conformance-id="upload-extension-screen">{body}</div>;
  }
  return (
    <Main className="min-h-screen" data-conformance-id="upload-extension-screen">
      {body}
    </Main>
  );
}
