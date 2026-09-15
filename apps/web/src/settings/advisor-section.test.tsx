// @vitest-environment jsdom
import { ADVISOR_SETTINGS_DEFAULTS } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { SettingsPage } from "./page.js";
import { SettingsViewProvider, useSettingsView } from "./settings-view.js";
import { AdvisorSettingsQueryError, fetchAdvisorSettings } from "./advisor-settings.js";

const stored = {
  endpointBaseUrl: "http://127.0.0.1:11434/v1",
  modelId: "qwen3:8b",
  apiKeyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
  requestBudget: 25,
  rawResponseVisibility: false,
  publicEndpointOptIn: true,
};

const okStatus = {
  configured: true,
  endpointReachable: true,
  modelId: "qwen3:8b",
  endpointHost: "127.0.0.1",
  publicEndpoint: false,
  optIn: true,
  keyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
  keyPresent: true,
  latencyMs: 12,
  reason: "ok",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

function deferred<Response>() {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

let queryClient: ReturnType<typeof createAppQueryClient>;
let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(putImpl?: (body: Record<string, unknown>) => Response) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
    if (String(url).includes("/api/v1/settings/advisor")) {
      if (init?.method === "PUT") {
        if (putImpl) return Promise.resolve(putImpl(JSON.parse(String(init.body))));
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(response({ ...stored, ...body }));
      }
      return Promise.resolve(response(stored));
    }
    return Promise.reject(new Error(`unexpected fetch ${String(url)}`));
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderAdvisorSection() {
  const Switcher = () => {
    const { setSection } = useSettingsView();
    useEffect(() => {
      setSection("advisor");
    }, [setSection]);
    return <SettingsPage />;
  };
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SettingsViewProvider active>
          <Switcher />
        </SettingsViewProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

async function openDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
  expect(await screen.findByLabelText("Model endpoint")).toBeTruthy();
}

function putCalls(): RequestInit[] {
  return fetchMock.mock.calls
    .map((call) => call[1] as RequestInit | undefined)
    .filter((init): init is RequestInit => init?.method === "PUT");
}

function statusCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/v1/advisor/status"))
    .length;
}

beforeEach(() => {
  queryClient = createAppQueryClient();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdvisorSection", () => {
  it("disables editing until the first successful load, then hydrates stored values", async () => {
    const pending = deferred<Response>();
    fetchMock = vi.fn((url: string) => {
      if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
      return pending.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAdvisorSection();
    await openDetails();
    const endpoint = screen.getByLabelText("Model endpoint") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save advisor settings" }) as HTMLButtonElement;
    // A delayed GET must not permit edits or a save over unloaded state.
    expect(endpoint.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    expect(await screen.findByText(/Editing unlocks after they load/)).toBeTruthy();
    pending.resolve(response(stored));
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    expect(endpoint.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    expect((screen.getByLabelText("Model id") as HTMLInputElement).value).toBe("qwen3:8b");
    expect((screen.getByLabelText("API key variable") as HTMLInputElement).value).toBe(
      "STONEHUSH_ADVISOR_API_KEY",
    );
    expect(
      screen.getByRole("switch", { name: "Public endpoint opt-in" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps editing disabled on load failure and hydrates through Retry without losing state", async () => {
    fetchMock = vi.fn((url: string) => {
      if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
      return Promise.reject(new Error("control plane is down"));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAdvisorSection();
    expect(await screen.findByText("Advisor settings unavailable")).toBeTruthy();
    await openDetails();
    expect((screen.getByLabelText("Model endpoint") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save advisor settings" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(putCalls()).toHaveLength(0);
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
      return Promise.resolve(response(stored));
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    expect((screen.getByLabelText("Model endpoint") as HTMLInputElement).disabled).toBe(false);
  });

  it("locks editing during save and keeps edited values when the save fails", async () => {
    const pending = deferred<Response>();
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
      if (String(url).includes("/api/v1/settings/advisor")) {
        if (init?.method === "PUT") return pending.promise;
        return Promise.resolve(response(stored));
      }
      return Promise.reject(new Error(`unexpected fetch ${String(url)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    const model = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "qwen3:8b-edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save advisor settings" }));
    // While the save is in flight nothing is editable, so its outcome can
    // never bless newer typing as saved.
    expect(await screen.findByRole("button", { name: "Saving" })).toBeTruthy();
    expect((screen.getByLabelText("Model id") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Model endpoint") as HTMLInputElement).disabled).toBe(true);
    pending.resolve(response({ code: "invalid_request" }, 400));
    expect(
      await screen.findByText("The advisor settings update failed. Values kept. Check the values and try again."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Model id") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText("Model id") as HTMLInputElement).value).toBe("qwen3:8b-edited");
  });

  it("saves only effective fields so unavailable stored values are never reset", async () => {
    stubFetch();
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    const model = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "qwen3:8b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save advisor settings" }));
    expect(await screen.findByText("Advisor settings saved.")).toBeTruthy();
    expect(putCalls()).toHaveLength(1);
    const body = JSON.parse(String(putCalls()[0]?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      endpointBaseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
      apiKeyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
      publicEndpointOptIn: true,
    });
    await waitFor(() => expect(statusCalls()).toBeGreaterThanOrEqual(2));
  });

  it("marks budget, raw response, and mode as not available instead of editable controls", async () => {
    stubFetch();
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    expect(screen.getAllByText("Not available in this version")).toHaveLength(3);
    expect(screen.queryByLabelText("Request budget")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Raw response visibility" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Advisor default mode" })).toBeNull();
  });

  it("shows shipped contract defaults when nothing is configured", async () => {
    fetchMock = vi.fn((url: string) => {
      if (String(url).includes("/api/v1/advisor/status")) {
        return Promise.resolve(
          response({
            configured: false,
            endpointReachable: null,
            modelId: "",
            endpointHost: "",
            publicEndpoint: false,
            optIn: false,
            keyEnvVar: "",
            keyPresent: false,
            latencyMs: null,
            reason: "unconfigured",
          }),
        );
      }
      return Promise.resolve(response({ ...ADVISOR_SETTINGS_DEFAULTS }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAdvisorSection();
    await openDetails();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save advisor settings" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect((screen.getByLabelText("Model endpoint") as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("switch", { name: "Public endpoint opt-in" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("shows a validation message without sending an update", async () => {
    stubFetch();
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    const endpoint = screen.getByLabelText("Model endpoint") as HTMLInputElement;
    fireEvent.change(endpoint, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save advisor settings" }));
    expect(
      await screen.findByText("Endpoint must be an http(s) URL or empty (unconfigured)."),
    ).toBeTruthy();
    expect(putCalls()).toHaveLength(0);
  });

  it("rejects key material in reference fields without sending", async () => {
    stubFetch();
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    const model = screen.getByLabelText("Model id") as HTMLInputElement;
    fireEvent.change(model, { target: { value: "sk-abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save advisor settings" }));
    expect(
      await screen.findByText("Key names must not contain key material. Enter the variable name only."),
    ).toBeTruthy();
    expect(putCalls()).toHaveLength(0);
  });

  it("tests the connection explicitly and reports the endpoint reachable, never the model verified", async () => {
    stubFetch();
    renderAdvisorSection();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save advisor settings" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    // No status copy before the operator asks: the test is explicit.
    expect(screen.queryByText(/Endpoint reachable/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const detail = await screen.findByText(/Endpoint reachable at 127\.0\.0\.1 in 12 ms/);
    expect(detail.textContent).toContain("Headers-only probe");
    expect(detail.textContent).toContain("model output not verified");
    expect(detail.textContent).not.toContain("http://");
  });

  it("asks to save before testing when dirty and clears stale connection results", async () => {
    stubFetch();
    renderAdvisorSection();
    await openDetails();
    expect(await screen.findByDisplayValue("http://127.0.0.1:11434/v1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Endpoint reachable at 127\.0\.0\.1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Model endpoint") as HTMLInputElement, {
      target: { value: "http://127.0.0.1:11434/v2" },
    });
    // The old endpoint result is gone and the test waits for a save.
    expect(screen.queryByText(/Endpoint reachable/)).toBeNull();
    expect(await screen.findByText("Unsaved changes. Save first, then test the connection.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save advisor settings" }));
    expect(await screen.findByText("Advisor settings saved.")).toBeTruthy();
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("opens the Advisor section for /settings?section=advisor and keeps the Appearance default otherwise", async () => {
    const routerFetch = (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/v1/system/status")) {
        return Promise.resolve(response({ version: 1, overall: "ready", developmentStorage: "ready" }));
      }
      if (String(url).includes("/api/v1/engagements")) return Promise.resolve(response([]));
      if (String(url).includes("/api/v1/advisor/status")) return Promise.resolve(response(okStatus));
      if (String(url).includes("/api/v1/settings/advisor")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Promise.resolve(response({ ...stored, ...body }));
        }
        return Promise.resolve(response(stored));
      }
      return Promise.reject(new Error(`unexpected fetch ${String(url)}`));
    };
    vi.stubGlobal("fetch", vi.fn(routerFetch));
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ["/settings?section=advisor"] }),
    );
    await router.load();
    const first = render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Advisor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save advisor settings" })).toBeTruthy();
    first.unmount();
    router.history.destroy();

    const plain = createAppRouter(createMemoryHistory({ initialEntries: ["/settings"] }));
    await plain.load();
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={plain} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    plain.history.destroy();
  });
});

describe("fetchAdvisorSettings", () => {
  it("passes aborts through instead of wrapping them as network failures", async () => {
    const abortError = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abortError)),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAdvisorSettings(controller.signal)).rejects.toBe(abortError);
  });

  it("wraps other failures in one safe error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("control plane is down"))),
    );
    await expect(fetchAdvisorSettings()).rejects.toBeInstanceOf(AdvisorSettingsQueryError);
  });
});
