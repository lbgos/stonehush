// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

const activeEngagement = {
  contractVersion: 1,
  id: ENGAGEMENT_ID,
  revision: 1,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const ATTACHMENT_ID = "20000000-0000-4000-8000-000000000001";

function savedAttachment() {
  return {
    contractVersion: 1,
    id: ATTACHMENT_ID,
    engagementId: ENGAGEMENT_ID,
    filename: "admin-login-as-sa",
    mime: "image/png",
    sizeBytes: 68,
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    caption: "login form",
    targetLabel: "Target lab",
    parentAttachmentId: null,
    crop: null,
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

const testQueryClients = new Set<QueryClient>();

async function renderWorkspace(initialEntry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900, writable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function stubNotes(
  upload: (body: Record<string, unknown>) => Promise<Response>,
  patch: (attachmentId: string, body: Record<string, unknown>) => Promise<Response> = (attachmentId, body) =>
    Promise.resolve(
      response(
        {
          ...savedAttachment(),
          id: attachmentId,
          caption: typeof body["caption"] === "string" ? body["caption"] : "",
        },
        200,
      ),
    ),
) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
      if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
        return Promise.resolve(
          response({ engagement: activeEngagement, activeScopeRevision: null }),
        );
      }
      if (url.endsWith("/services")) return Promise.resolve(response([]));
      if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(
          response({
            engagementId: ENGAGEMENT_ID,
            markdown: "",
            updatedAt: "2026-08-12T12:00:00.000Z",
            revision: 0,
          }),
        );
      }
      if (url.endsWith("/attachments") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        return upload(body);
      }
      const patchMatch = /\/attachments\/([^/]+)$/.exec(url);
      if (patchMatch?.[1] !== undefined && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return patch(patchMatch[1], body);
      }
      if (url.endsWith("/attachments")) return Promise.resolve(response([]));
      return Promise.resolve(response([]));
    }),
  );
  return posts;
}

describe("notes image capture", () => {
  it("pastes a screenshot, names it by what it proves, and links it inline", async () => {
    const posts = stubNotes(async (body) => response({ ...savedAttachment(), caption: body["caption"] }, 201));

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    const file = new File([PNG_BYTES], "login.png", { type: "image/png" });
    fireEvent.change(picker, { target: { files: [file] } });

    const proves = await screen.findByLabelText("Proves (names the file)");
    expect((proves as HTMLInputElement).value).toBe("login");
    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "login form" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.body).toMatchObject({
      filename: "login",
      mime: "image/png",
      caption: "login form",
    });
    // Target context travels with the capture.
    expect(posts[0]?.body).toMatchObject({ targetLabel: "Target lab" });
    // The saved capture links inline into the draft.
    await waitFor(() => {
      const editor = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
      expect(editor.value).toContain(`(attachment:${ATTACHMENT_ID})`);
    });
    expect(await screen.findByText(/admin-login-as-sa/)).toBeTruthy();
  });

  it("keeps the pasted image with retry when the upload fails", async () => {
    stubNotes(async () => response({ code: "storage_busy" }, 503));

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File([PNG_BYTES], "proof.png", { type: "image/png" })] },
    });
    await screen.findByLabelText("Proves (names the file)");
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));

    // The failed upload keeps the image and offers retry instead of losing it.
    expect(await screen.findByRole("button", { name: "Retry upload" })).toBeTruthy();
    expect(screen.getByLabelText("Proves (names the file)")).toBeTruthy();
  });

  it("rejects a malformed caption response instead of trusting it", async () => {
    stubNotes(
      async (body) => response({ ...savedAttachment(), caption: body["caption"] }, 201),
      async () => response({ bogus: true }, 200),
    );

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File([PNG_BYTES], "login.png", { type: "image/png" })] },
    });
    await screen.findByLabelText("Proves (names the file)");
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    await screen.findByLabelText("Caption for admin-login-as-sa");

    fireEvent.change(screen.getByLabelText("Caption for admin-login-as-sa"), {
      target: { value: "edited caption" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save caption" }));

    // Untrusted payload rejected: local caption kept, truthful error shown.
    expect(await screen.findByText("Caption could not be saved. Retry.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Caption for admin-login-as-sa") as HTMLInputElement).value,
    ).toBe("edited caption");
  });
});
