// @vitest-environment jsdom
import type { Lead } from "@stonehush/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { pathInspectorRecord, type LeadStartContext } from "./inspector.js";
import { LeadQuickCreate } from "./lead-quick-create.js";
import { leadsQueryKey } from "./leads-query.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

const pathResult = {
  source: "ffuf" as const,
  parserVersion: "ffuf-json-v1" as const,
  url: "http://192.0.2.10/admin",
  status: 200,
  length: 128,
  words: 4,
  lines: 8,
  redirectlocation: null,
  fuzz: "admin",
  runId: "run-3",
  artifactId: "artifact-3",
  artifactDigest: `sha256:${"c".repeat(64)}`,
  observedAt: "2026-09-03T01:00:00.000Z",
};

const pathContext = pathInspectorRecord(pathResult, engagementId).lead;

const savedLead: Lead = {
  contractVersion: 1,
  id: "30000000-0000-4000-8000-000000000001",
  engagementId,
  title: "Admin panel",
  target: "192.0.2.10",
  serviceRef: "http://192.0.2.10",
  source: { kind: "ffuf_result", ref: "artifact-3", label: "http://192.0.2.10/admin" },
  nextStep: null,
  disposition: "open",
  parkReason: null,
  testedConditions: null,
  closedNote: null,
  revisitSuggestion: null,
  createdAt: "2026-09-03T02:00:00.000Z",
  updatedAt: "2026-09-03T02:00:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

let queryClient: ReturnType<typeof createAppQueryClient>;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryClient = createAppQueryClient();
  scrollTo = vi.fn();
  Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubLeads(create: () => Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/leads") && init?.method === "POST") return Promise.resolve(create());
    if (url.endsWith("/leads")) return Promise.resolve(response([savedLead]));
    return Promise.resolve(response({ code: "invalid_request" }, 400));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postBodies(fetchMock: ReturnType<typeof stubLeads>): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
}

// Opener stands in for the row button so focus return can be observed.
function Harness({ archived = false, context }: { archived?: boolean; context: LeadStartContext }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Start a lead
      </button>
      {open ? (
        <LeadQuickCreate
          archived={archived}
          context={context}
          engagementId={engagementId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function openDialog(options: { archived?: boolean; context?: LeadStartContext } = {}) {
  render(
    <QueryClientProvider client={queryClient}>
      <Harness archived={options.archived ?? false} context={options.context ?? pathContext} />
    </QueryClientProvider>,
  );
  const opener = screen.getByRole("button", { name: "Start a lead" });
  opener.focus();
  fireEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: "Start a lead" }) };
}

describe("lead quick create", () => {
  it("shows the readable source with no evidence id field", () => {
    stubLeads(() => response(savedLead, 201));
    const { dialog } = openDialog();

    const title = within(dialog).getByLabelText("Title");
    expect(document.activeElement).toBe(title);
    expect(within(dialog).getAllByRole("textbox")).toEqual([title]);
    expect(within(dialog).getByText("Source · Path discovery")).toBeTruthy();
    expect(within(dialog).getByText("http://192.0.2.10/admin")).toBeTruthy();
    expect(within(dialog).getByText("192.0.2.10")).toBeTruthy();
    expect(within(dialog).getByText("http://192.0.2.10")).toBeTruthy();
    expect(within(dialog).queryByText(/artifact-3/)).toBeNull();
  });

  it("saves the exact source, refreshes leads, and returns to the opener", async () => {
    const fetchMock = stubLeads(() => response(savedLead, 201));
    const { dialog, opener } = openDialog();

    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Admin panel  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lead" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postBodies(fetchMock)).toEqual([
      {
        title: "Admin panel",
        target: "192.0.2.10",
        serviceRef: "http://192.0.2.10",
        source: { kind: "ffuf_result", ref: "artifact-3", label: "http://192.0.2.10/admin" },
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/engagements/${engagementId}/leads`);
    expect(queryClient.getQueryData<Lead[]>(leadsQueryKey(engagementId))).toContainEqual(savedLead);
    expect(document.activeElement).toBe(opener);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
  });

  it("skips the return restore when a save lands after the dialog unmounts", async () => {
    let resolvePost: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/leads") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return Promise.resolve(response([savedLead]));
    });
    vi.stubGlobal("fetch", fetchMock);
    // Stands in for the workspace dropping the dialog on an engagement switch.
    function SwitchHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(false)}>
            Switch engagement
          </button>
          {open ? (
            <LeadQuickCreate
              archived={false}
              context={pathContext}
              engagementId={engagementId}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <SwitchHarness />
      </QueryClientProvider>,
    );
    const switchButton = screen.getByRole("button", { name: "Switch engagement" });
    const dialog = screen.getByRole("dialog", { name: "Start a lead" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Admin panel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lead" }));
    await waitFor(() => expect(postBodies(fetchMock)).toHaveLength(1));

    fireEvent.click(switchButton);
    expect(screen.queryByRole("dialog")).toBeNull();
    resolvePost(response(savedLead, 201));

    await waitFor(() =>
      expect(queryClient.getQueryData<Lead[]>(leadsQueryKey(engagementId))).toContainEqual(savedLead),
    );
    // The per-call onSuccess (close) must not run once the observer unmounted.
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the title and shows the reason when saving fails", async () => {
    let failure = response({ code: "storage_busy" }, 503);
    const fetchMock = stubLeads(() => failure);
    const { dialog } = openDialog();
    const title = within(dialog).getByLabelText<HTMLInputElement>("Title");

    fireEvent.change(title, { target: { value: "Admin panel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lead" }));
    expect(await within(dialog).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(title.value).toBe("Admin panel");
    expect(document.activeElement).toBe(title);

    failure = response({ code: "invalid_request" }, 400);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lead" }));
    expect(
      await within(dialog).findByText("The request was not accepted. Check the fields and try again."),
    ).toBeTruthy();
    expect(title.value).toBe("Admin panel");
    expect(screen.getByRole("dialog", { name: "Start a lead" })).toBe(dialog);
    expect(postBodies(fetchMock)).toHaveLength(2);
  });

  it("closes an empty form on Escape or Cancel without a request", () => {
    const fetchMock = stubLeads(() => response(savedLead, 201));
    const { dialog: first, opener } = openDialog();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Start a lead" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty title on save without a request", () => {
    const fetchMock = stubLeads(() => response(savedLead, 201));
    const { dialog } = openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save lead" }));
    expect(within(dialog).getByText("Enter a lead title.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a typed title only through Discard", () => {
    const fetchMock = stubLeads(() => response(savedLead, 201));
    const { dialog, opener } = openDialog();
    const title = within(dialog).getByLabelText<HTMLInputElement>("Title");
    fireEvent.change(title, { target: { value: "Admin panel" } });

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByText("Discard this lead title?")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss lead form" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Start a lead" })).toBe(dialog);

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).queryByText("Discard this lead title?")).toBeNull();
    expect(title.value).toBe("Admin panel");
    expect(document.activeElement).toBe(title);

    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot save in an archived engagement", () => {
    const fetchMock = stubLeads(() => response(savedLead, 201));
    const { dialog } = openDialog({ archived: true });
    expect(within(dialog).getByText(/This engagement is archived/)).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Title").disabled).toBe(true);
    const save = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save lead" });
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a service too long to store and still shows missing context", () => {
    stubLeads(() => response(savedLead, 201));
    const host = `${Array.from({ length: 5 }, () => "h".repeat(60)).join(".")}.test`;
    const { dialog } = openDialog({
      context: { ...pathContext, target: null, serviceRef: `http://${host}` },
    });
    expect(within(dialog).getByText("None")).toBeTruthy();
    expect(within(dialog).getByText("Not saved on the lead: longer than 253 characters.")).toBeTruthy();
  });
});
