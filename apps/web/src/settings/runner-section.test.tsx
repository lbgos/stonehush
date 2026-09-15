// @vitest-environment jsdom
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { SettingsPage } from "./page.js";
import type { SettingsSectionId } from "./model.js";
import { SettingsViewProvider, useSettingsView } from "./settings-view.js";

const stored = {
  ffufBinaryPath: "/usr/bin/ffuf",
  ffufWordlistPath: "/lists/default.txt",
  ffufRate: 50,
  ffufThreads: 10,
  ffufTimeoutSeconds: 5,
  ffufMaxTimeSeconds: 60,
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

let queryClient: ReturnType<typeof createAppQueryClient>;
let fetchMock: ReturnType<typeof vi.fn>;

function renderSettingsSection(section: SettingsSectionId = "runner") {
  const Switcher = () => {
    const { setSection } = useSettingsView();
    useEffect(() => {
      setSection(section);
    }, [setSection, section]);
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

function renderRunnerSection() {
  return renderSettingsSection("runner");
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

describe("RunnerSection", () => {
  it("prefills stored ffuf defaults", async () => {
    fetchMock = vi.fn(() => Promise.resolve(response(stored)));
    vi.stubGlobal("fetch", fetchMock);
    renderRunnerSection();
    expect(await screen.findByLabelText("Default wordlist")).toBeTruthy();
    expect((screen.getByLabelText("Default wordlist") as HTMLInputElement).value).toBe(
      "/lists/default.txt",
    );
    expect((screen.getByLabelText("Default rate") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Default threads") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Default timeout") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Default duration") as HTMLInputElement).value).toBe("60");
  });

  it("saves edited values and confirms", async () => {
    fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(response({ ...stored, ...body }));
      }
      return Promise.resolve(response(stored));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRunnerSection();
    const rate = (await screen.findByLabelText("Default rate")) as HTMLInputElement;
    fireEvent.change(rate, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save runner defaults" }));
    expect(await screen.findByText("Runner defaults saved.")).toBeTruthy();
    const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit)?.method === "PUT");
    expect(put).toBeTruthy();
    expect(JSON.parse(String((put?.[1] as RequestInit)?.body))).toMatchObject({ ffufRate: 200 });
  });

  it("shows a validation message without sending an update", async () => {
    fetchMock = vi.fn(() => Promise.resolve(response(stored)));
    vi.stubGlobal("fetch", fetchMock);
    renderRunnerSection();
    const rate = (await screen.findByLabelText("Default rate")) as HTMLInputElement;
    fireEvent.change(rate, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save runner defaults" }));
    expect(await screen.findByText("Default rate must be an integer in 1-10000.")).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit)?.method === "PUT")).toBe(
      false,
    );
  });

  it("shows a recoverable error when loading fails", async () => {
    fetchMock = vi.fn(() => Promise.resolve(response({ code: "invalid_persisted_data" }, 500)));
    vi.stubGlobal("fetch", fetchMock);
    renderRunnerSection();
    expect(await screen.findByText("Runner settings unavailable")).toBeTruthy();
    fetchMock.mockReturnValue(Promise.resolve(response(stored)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Default wordlist")).toBeTruthy();
  });

  it("shows the fixed runner executable and never sends the stored binary path", async () => {
    fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(response({ ...stored, ...body }));
      }
      return Promise.resolve(response(stored));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRunnerSection();
    // The stored path loads but renders as a fixed fact, not an editable field.
    expect(await screen.findByText(/Fixed runner executable/)).toBeTruthy();
    expect(screen.queryByLabelText("ffuf binary")).toBeNull();
    const rate = screen.getByLabelText("Default rate") as HTMLInputElement;
    fireEvent.change(rate, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save runner defaults" }));
    expect(await screen.findByText("Runner defaults saved.")).toBeTruthy();
    const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit)?.method === "PUT");
    expect(put).toBeTruthy();
    const body = JSON.parse(String((put?.[1] as RequestInit)?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ ffufWordlistPath: "/lists/default.txt", ffufRate: 200 });
    expect("ffufBinaryPath" in body).toBe(false);
  });

  it("marks unimplemented archiving rows unavailable without editable controls", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(stored))));
    renderSettingsSection("general");
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeTruthy();
    expect(screen.getAllByText("Not available in this version")).toHaveLength(2);
    expect(screen.queryByRole("switch", { name: "Auto-archive reviewed work" })).toBeNull();
    expect(screen.queryByLabelText("Days before archive")).toBeNull();
  });

  it("marks update checks unavailable without an editable control", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(stored))));
    renderSettingsSection("plugins");
    expect(await screen.findByRole("heading", { level: 1, name: "Plugins" })).toBeTruthy();
    expect(screen.getByText("Not available in this version")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Update checks" })).toBeNull();
  });

  it("marks retention unavailable while keeping the enforced immutability indicator", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(stored))));
    renderSettingsSection("evidence");
    expect(await screen.findByRole("heading", { level: 1, name: "Evidence" })).toBeTruthy();
    expect(screen.getByText("Not available in this version")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Retention" })).toBeNull();
    // Raw-evidence immutability is enforced behavior, so its indicator stays.
    expect(screen.getByRole("switch", { name: "Immutable raw evidence" })).toBeTruthy();
  });
});
