// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const ENGAGEMENT_B_ID = "10000000-0000-4000-8000-000000000002";

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

  it("keeps every row when a derived copy lands beside existing rows", async () => {
    // Union regression: merging a derived child must not drop rows that
    // have no conflict. A recency merge that only copies newer-marked rows
    // narrows the list to the child until the next reload.
    const seeded = { ...savedAttachment(), filename: "alpha-screen" };
    const uploadedRow = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000b1",
      filename: "beta-proof",
      caption: "uploaded",
      createdAt: "2026-08-13T12:00:00.000Z",
    };
    const child = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000b2",
      filename: "gamma-derived",
      parentAttachmentId: seeded.id,
      crop: { x: 0, y: 0, width: 100, height: 60 },
      createdAt: "2026-08-14T12:00:00.000Z",
    };
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
          return Promise.resolve(response(uploadedRow, 201));
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/attachments/${seeded.id}/derived`) {
          return Promise.resolve(response(child, 201));
        }
        if (url.endsWith("/attachments")) return Promise.resolve(response([seeded]));
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByText(/alpha-screen/);

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File([PNG_BYTES], "proof.png", { type: "image/png" })] } });
    await screen.findByLabelText("Proves (names the file)");
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    await screen.findByText(/beta-proof/);

    const deriveButtons = screen.getAllByRole("button", { name: "Create cropped copy" });
    fireEvent.click(deriveButtons[0] as HTMLElement);
    await screen.findByText(/gamma-derived/);

    // All three rows stay rendered: the seed, the upload, and the child.
    expect(screen.getByText(/alpha-screen/)).toBeTruthy();
    expect(screen.getByText(/beta-proof/)).toBeTruthy();
    expect(screen.getByText(/gamma-derived/)).toBeTruthy();
  });

  it("cancels a non-image file drop instead of navigating away", async () => {
    const posts = stubNotes(async (body) => response({ ...savedAttachment(), caption: body["caption"] }, 201));

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;

    // A PDF drop carries Files but no image. Without preventDefault the
    // browser would navigate to the PDF and discard unsaved notes.
    const pdf = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: { types: ["Files"], files: [pdf] } });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(posts.length).toBe(0);
  });

  it("truncates a max-length caption when deriving so the request validates", async () => {
    // A 280-character caption plus the `Crop: ` prefix sends 286
    // characters, which the derived-attachment schema rejects on every
    // retry. The client must fit the composed caption in the bound.
    const derivedPosts: { url: string; body: Record<string, unknown> }[] = [];
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
          return Promise.resolve(response({ ...savedAttachment(), caption: body["caption"] }, 201));
        }
        if (url.endsWith("/derived") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          derivedPosts.push({ url, body });
          return Promise.resolve(response({ ...savedAttachment(), id: `${ATTACHMENT_ID}-crop` }, 201));
        }
        if (url.endsWith("/attachments")) return Promise.resolve(response([]));
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File([PNG_BYTES], "login.png", { type: "image/png" })] } });
    await screen.findByLabelText("Proves (names the file)");
    const longCaption = "c".repeat(280);
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: longCaption } });
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    await screen.findByLabelText("Caption for admin-login-as-sa");

    fireEvent.click(screen.getByRole("button", { name: "Create cropped copy" }));
    await waitFor(() => expect(derivedPosts.length).toBe(1));
    const sent = String(derivedPosts[0]?.body["caption"] ?? "");
    expect(sent.startsWith("Crop: ")).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(280);
  });

  it("keeps a caption saved after upload when a stale initial fetch resolves after it", async () => {
    // Ordering pin for the recency merge: upload, then a caption save,
    // then the stale initial fetch. Both local writes postdate the fetch,
    // so the saved caption must survive. A later fetch that started after
    // the save would take the server copy instead.
    const uploaded = { ...savedAttachment(), caption: "just uploaded" };
    const saved = { ...savedAttachment(), caption: "saved after upload" };
    const stale = { ...savedAttachment(), caption: "old" };
    let resolveInitial: ((value: Response) => void) | undefined;
    const initialGate = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
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
          return Promise.resolve(response(uploaded, 201));
        }
        if (/\/attachments\/[^/]+$/.test(url) && init?.method === "PATCH") {
          return Promise.resolve(response(saved, 200));
        }
        if (url.endsWith("/attachments")) return initialGate;
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File([PNG_BYTES], "login.png", { type: "image/png" })] } });
    await screen.findByLabelText("Proves (names the file)");
    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "just uploaded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    await screen.findByLabelText("Caption for admin-login-as-sa");

    fireEvent.change(screen.getByLabelText("Caption for admin-login-as-sa"), {
      target: { value: "saved after upload" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save caption" }));
    await screen.findByAltText("saved after upload");

    await act(async () => {
      resolveInitial?.(response([stale]));
    });
    expect(screen.getByAltText("saved after upload")).toBeTruthy();
    expect(screen.queryByAltText("old")).toBeNull();
    expect(screen.queryByAltText("just uploaded")).toBeNull();
  });

  it("ignores a stale attachment reload after navigating engagements", async () => {
    // Black-box isolation: the notes section remounts per engagement
    // (keyed in the workspace), so React already discards A's late update;
    // the reload engagement check pins the invariant even if that key ever
    // goes away.
    const engagementB = { ...activeEngagement, id: ENGAGEMENT_B_ID, name: "Second lab" };
    const fileA = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000a1",
      engagementId: ENGAGEMENT_ID,
      filename: "file-a",
    };
    const fileB = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000b1",
      engagementId: ENGAGEMENT_B_ID,
      filename: "file-b",
    };
    let attachmentGetsA = 0;
    let resolveReload: ((value: Response) => void) | undefined;
    const reloadGate = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") {
          return Promise.resolve(response([activeEngagement, engagementB]));
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_B_ID}`) {
          return Promise.resolve(response({ engagement: engagementB, activeScopeRevision: null }));
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: url.includes(ENGAGEMENT_B_ID) ? ENGAGEMENT_B_ID : ENGAGEMENT_ID,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`) {
          attachmentGetsA += 1;
          // First load fails so the Retry button appears; the retry hangs.
          if (attachmentGetsA === 1) return Promise.reject(new Error("offline"));
          return reloadGate;
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_B_ID}/attachments`) {
          return Promise.resolve(response([fileB]));
        }
        return Promise.resolve(response([]));
      }),
    );

    const history = createMemoryHistory({ initialEntries: [`/engagements/${ENGAGEMENT_ID}?tab=notes`] });
    const router = createAppRouter(history);
    await router.load();
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByLabelText("Markdown");
    // Initial load failed; retry hangs until the test releases it. Scope to
    // the attachment panel: other tabs render their own retry actions.
    const loadFailure = await screen.findByText("Attached images could not be loaded.");
    const retryButton = within(loadFailure.closest("div") as HTMLElement).getByRole("button", {
      name: "Retry",
    });
    fireEvent.click(retryButton);
    await waitFor(() => expect(attachmentGetsA).toBe(2));

    // Navigate to B while A's retry is in flight, then let A resolve.
    await act(async () => {
      history.push(`/engagements/${ENGAGEMENT_B_ID}?tab=notes`);
    });
    expect(await screen.findByText(/file-b/)).toBeTruthy();
    await act(async () => {
      resolveReload?.(response([fileA]));
    });

    // B keeps its own rows; A's late rows never merge in.
    expect(screen.queryByText(/file-a/)).toBeNull();
    expect(screen.getByText(/file-b/)).toBeTruthy();
  });

  it("ignores a stale derived copy after navigating engagements", async () => {
    // Same isolation contract as above, for caption saves and derived
    // copies resolving after unmount.
    const engagementB = { ...activeEngagement, id: ENGAGEMENT_B_ID, name: "Second lab" };
    const fileA = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000a1",
      engagementId: ENGAGEMENT_ID,
      filename: "file-a",
    };
    const childA = {
      ...savedAttachment(),
      id: "20000000-0000-4000-8000-0000000000a2",
      engagementId: ENGAGEMENT_ID,
      filename: "child-a",
      parentAttachmentId: fileA.id,
      crop: { x: 0, y: 0, width: 100, height: 60 },
    };
    let resolveDerive: ((value: Response) => void) | undefined;
    const deriveGate = new Promise<Response>((resolve) => {
      resolveDerive = resolve;
    });
    const attachmentGets: string[] = [];
    const derivePosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") {
          return Promise.resolve(response([activeEngagement, engagementB]));
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_B_ID}`) {
          return Promise.resolve(response({ engagement: engagementB, activeScopeRevision: null }));
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: url.includes(ENGAGEMENT_B_ID) ? ENGAGEMENT_B_ID : ENGAGEMENT_ID,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`) {
          return Promise.resolve(response([fileA]));
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_B_ID}/attachments`) {
          attachmentGets.push(url);
          return Promise.resolve(response([]));
        }
        if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/attachments/${fileA.id}/derived`) {
          derivePosts.push(url);
          return deriveGate;
        }
        return Promise.resolve(response([]));
      }),
    );

    const history = createMemoryHistory({ initialEntries: [`/engagements/${ENGAGEMENT_ID}?tab=notes`] });
    const router = createAppRouter(history);
    await router.load();
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByLabelText("Markdown");
    fireEvent.click(await screen.findByRole("button", { name: "Create cropped copy" }));
    // The crop POST must actually be in flight before navigating, or the
    // stale-completion assertions below prove nothing.
    await waitFor(() => expect(derivePosts.length).toBe(1));
    await act(async () => {
      history.push(`/engagements/${ENGAGEMENT_B_ID}?tab=notes`);
    });
    // B's own list loaded empty; A's card is gone.
    await waitFor(() => expect(attachmentGets.length).toBeGreaterThan(0));
    expect(screen.queryByText(/file-a/)).toBeNull();
    await act(async () => {
      resolveDerive?.(response(childA, 201));
    });
    // A's late child never appears under B.
    expect(screen.queryByText(/child-a/)).toBeNull();
    expect(screen.queryByText(/file-a/)).toBeNull();
  });

  it("keeps a just-saved caption when a stale initial fetch resolves after it", async () => {
    // Same engagement, no navigation: the initial list fetch starts first
    // but resolves after an upload already saved a newer caption for the
    // same row. Merging must not clobber the newer caption with the stale
    // copy.
    const fresh = { ...savedAttachment(), caption: "just saved" };
    const stale = { ...savedAttachment(), caption: "old" };
    let resolveInitial: ((value: Response) => void) | undefined;
    const initialGate = new Promise<Response>((resolve) => {
      resolveInitial = resolve;
    });
    let initialCalls = 0;
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
          return Promise.resolve(response(fresh, 201));
        }
        if (url.endsWith("/attachments")) {
          initialCalls += 1;
          return initialGate;
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    await screen.findByLabelText("Markdown");

    const picker = screen.getByLabelText("Attach image file") as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [new File([PNG_BYTES], "login.png", { type: "image/png" })] } });
    await screen.findByLabelText("Proves (names the file)");
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "just saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save image" }));
    // The upload lands while the initial list fetch is still in flight.
    await screen.findByLabelText("Caption for admin-login-as-sa");
    expect(initialCalls).toBe(1);

    await act(async () => {
      resolveInitial?.(response([stale]));
    });
    // The newer caption survives the stale fetch. The card image alt comes
    // straight from list state (unlike the caption input, which keeps local
    // edits), so it observes the merge result directly.
    expect(screen.getByAltText("just saved")).toBeTruthy();
    expect(screen.queryByAltText("old")).toBeNull();
  });
});
