// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { FfufGroupView } from "./ffuf-group-view.js";
import { FfufWordlistView } from "./ffuf-wordlist-view.js";
import { NextStepEditor, ResumeChangeList } from "./resume-view.js";
import { RunDiffView } from "./run-diff-view.js";
import { SearchResultGroups } from "./search-view.js";

afterEach(cleanup);

beforeEach(() => {
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
});

function renderWithTheme(element: React.ReactElement) {
  return render(<ThemeProvider>{element}</ThemeProvider>);
}

describe("ResumeChangeList", () => {
  it("labels pre-event records as snapshot and never invents a timeline", () => {
    renderWithTheme(
      <ResumeChangeList
        resume={{
          engagementId: "10000000-0000-4000-8000-000000000001",
          nextStep: "Probe port 8080 next.",
          nextStepUpdatedAt: "2026-09-09T00:00:00.000Z",
          nextStepRevision: 1,
          changes: [
            { kind: "service", id: "10.0.0.1:80", at: "2020-01-01T00:00:00.000Z", summary: "Service observed.", snapshot: true },
            { kind: "run", id: "run-1", at: "2026-09-09T00:00:00.000Z", summary: "Run run-1 succeeded.", snapshot: false },
          ],
          complete: true,
        }}
      />,
    );
    expect(screen.getByText("snapshot")).toBeDefined();
    expect(screen.getByText("Run run-1 succeeded.")).toBeDefined();
  });
});

describe("NextStepEditor", () => {
  it("drops the unsaved draft when the engagement changes", () => {
    const queryClient = createAppQueryClient();
    const view = render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <NextStepEditor
            key="eng-a"
            engagementId="eng-a"
            archived={false}
            nextStep="Probe port 8080 next."
            revision={1}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    fireEvent.change(screen.getByLabelText("Next step, optional"), {
      target: { value: "Unsaved draft for eng-a." },
    });
    expect(screen.getByDisplayValue("Unsaved draft for eng-a.")).toBeDefined();
    // Host switches engagement: the keyed editor remounts instead of
    // carrying the draft into the new engagement.
    view.rerender(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <NextStepEditor
            key="eng-b"
            engagementId="eng-b"
            archived={false}
            nextStep="Enumerate the new scope."
            revision={0}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(screen.getByDisplayValue("Enumerate the new scope.")).toBeDefined();
    queryClient.clear();
  });
});

describe("SearchResultGroups", () => {
  it("opens the exact anchor and labels unindexed kinds", () => {
    const onOpen = vi.fn();
    renderWithTheme(
      <SearchResultGroups
        response={{
          engagementId: "10000000-0000-4000-8000-000000000001",
          query: "admin",
          groups: {
            target: [],
            hostname: [],
            note: [
              { kind: "note", id: "notes", title: "Engagement notes", snippet: "...admin page...", anchor: "note:notes@4", unindexed: false },
            ],
            lead: [],
            finding: [],
            artifact: [],
            excerpt: [],
          },
          unindexedKinds: ["lead", "excerpt"],
        }}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByText("Engagement notes"));
    expect(onOpen).toHaveBeenCalledWith("note:notes@4");
    expect(screen.getByText(/Not indexed in this view/)).toBeDefined();
  });
});

describe("FfufGroupView", () => {
  const rows = [
    { url: "http://x/a", status: 200, length: 10, words: 2, lines: 1, fuzz: "a" },
    { url: "http://x/b", status: 200, length: 10, words: 2, lines: 1, fuzz: "b" },
    { url: "http://x/admin", status: 403, length: 5, words: 1, lines: 1, fuzz: "admin" },
  ];

  it("hides a group with a count and restores it with undo", () => {
    renderWithTheme(<FfufGroupView results={rows} />);
    expect(screen.getByText(/status 200/)).toBeDefined();
    fireEvent.click(screen.getAllByText("Hide")[0]!);
    expect(screen.getByText(/1 hidden/)).toBeDefined();
    fireEvent.click(screen.getByText("Undo all"));
    expect(screen.getByText(/status 200/)).toBeDefined();
  });

  it("shows unusual responses without vulnerability claims", () => {
    renderWithTheme(<FfufGroupView results={rows} />);
    fireEvent.click(screen.getAllByText("Inspect")[1]!);
    expect(screen.getByText(/Observed behavior only/)).toBeDefined();
  });
});

describe("RunDiffView", () => {
  it("reports missing coverage as not observed, never closed", () => {
    renderWithTheme(
      <RunDiffView
        input={{
          before: {
            context: { tool: "nmap", origin: "10.0.0.1", optionsSummary: "default", binding: "b1" },
            services: [{ address: "10.0.0.1", port: 80, protocol: "tcp", serviceName: "http" }],
            responses: [],
            paths: [],
            complete: true,
          },
          after: {
            context: { tool: "nmap", origin: "10.0.0.1", optionsSummary: "default", binding: "b1" },
            services: [],
            responses: [],
            paths: [],
            complete: true,
          },
        }}
      />,
    );
    expect(screen.getByText(/Not observed is not closed/)).toBeDefined();
  });
});

describe("FfufWordlistView", () => {
  it("labels the demo list and shows the rate limitation", () => {
    renderWithTheme(<FfufWordlistView ffufVersion="1.1.0" exists={() => false} onResolve={() => {}} />);
    expect(screen.getByText(/synthetic demo/)).toBeDefined();
    expect(screen.getByText(/does not accept -rate/)).toBeDefined();
  });

  it("resolves a configured wordlist so the option affects its run", () => {
    const onResolve = vi.fn();
    renderWithTheme(
      <FfufWordlistView
        ffufVersion={null}
        exists={() => true}
        onResolve={onResolve}
        configuredPaths={{ common: "/wl/common.txt" }}
      />,
    );
    fireEvent.click(screen.getByText("common"));
    expect(onResolve).toHaveBeenCalledWith("/wl/common.txt", "common");
  });

  it("reports recovery instead of resolving when no file is configured", () => {
    const onResolve = vi.fn();
    renderWithTheme(<FfufWordlistView ffufVersion={null} exists={() => true} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("common"));
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByText(/no configured file yet/)).toBeDefined();
  });
});
