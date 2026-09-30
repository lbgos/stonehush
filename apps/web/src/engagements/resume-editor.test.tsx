// @vitest-environment jsdom
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../query-client.js";
import { NextStepEditor } from "./resume-view.js";
import { EngagementNextStepMutationError, saveNextStepRequest, fetchEngagementResume, engagementResumeQueryKey, useEngagementResumeQuery } from "./resume-query.js";

const id = "10000000-0000-4000-8000-000000000001";
const saved = (revision = 2, nextStep: string | null = "Their step") => ({
  engagementId: id, nextStep, nextStepRevision: revision,
  nextStepUpdatedAt: "2026-09-09T00:00:00.000Z", changes: [], complete: true,
});
const record = (revision = 2, nextStep: string | null = "Mine") => ({
  engagementId: id, nextStep, revision, updatedAt: "2026-09-09T00:00:00.000Z",
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const conflict = (currentRevision = 2) => reply({ code: "revision_conflict", resourceType: "engagement_next_step", resourceId: id, currentRevision }, 409);
const fetchMock = vi.fn<typeof fetch>();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});
function setup() {
  const client = createAppQueryClient();
  const element = (revision: number, nextStep = "Original", engagementId = id, archived = false) =>
    <ThemeProvider><QueryClientProvider client={client}><NextStepEditor engagementId={engagementId} archived={archived} nextStep={nextStep} revision={revision} /></QueryClientProvider></ThemeProvider>;
  const view = render(element(1));
  return { rerender: (revision: number, nextStep?: string, engagementId?: string, archived?: boolean) => view.rerender(element(revision, nextStep, engagementId, archived)) };
}
function type(value = "Mine") { fireEvent.change(screen.getByRole("textbox"), { target: { value } }); }
function click(name: string) { fireEvent.click(screen.getByRole("button", { name })); }
function sent(index = 0) { return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as { nextStep: string | null; expectedRevision: number }; }

describe("next-step concurrency", () => {
  it("fetches a fresh saved step on return even when the cache is still fresh", async () => {
    fetchMock.mockResolvedValueOnce(reply(saved(1, "Original"))).mockResolvedValueOnce(reply(saved(2, "External")));
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useEngagementResumeQuery(id), { wrapper });
    await waitFor(() => expect(first.result.current.data?.nextStep).toBe("Original"));
    first.unmount();
    const second = renderHook(() => useEngagementResumeQuery(id), { wrapper });
    await waitFor(() => expect(second.result.current.data?.nextStep).toBe("External"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.unmount(); client.clear();
  });
  it("unlocks after a confirmed reopen without losing the draft revision", async () => {
    fetchMock.mockResolvedValueOnce(reply({ code: "engagement_archived" }, 409)).mockResolvedValueOnce(reply({ code: "storage_busy" }, 503));
    const view = setup(); type(); click("Save");
    await screen.findByText("This engagement is archived. The next step was not saved.");
    view.rerender(2, "External", id, false);
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
    view.rerender(2, "External", id, true);
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    view.rerender(3, "External", id, false);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByDisplayValue("Mine")).toBeDefined(); click("Save");
    await screen.findByText("Storage is busy. Try again.");
    expect(sent(1)).toEqual({ nextStep: "Mine", expectedRevision: 1 });
  });

  it("retains a draft through a real query refetch and releases it after the save refetch", async () => {
    let serverRevision = 1;
    let serverText = "Original";
    const requests: { nextStep: string | null; expectedRevision: number }[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "PUT") {
        const input = JSON.parse(String(init.body)) as { nextStep: string; expectedRevision: number };
        requests.push(input);
        if (input.expectedRevision !== serverRevision) return conflict(serverRevision);
        serverRevision += 1; serverText = input.nextStep;
        return reply(record(serverRevision, serverText));
      }
      return reply(saved(serverRevision, serverText));
    });
    const client = createAppQueryClient();
    function Host() {
      const query = useEngagementResumeQuery(id);
      return query.data ? <NextStepEditor engagementId={id} archived={false} nextStep={query.data.nextStep} revision={query.data.nextStepRevision} /> : null;
    }
    render(<ThemeProvider><QueryClientProvider client={client}><Host /></QueryClientProvider></ThemeProvider>);
    await screen.findByDisplayValue("Original"); type();
    serverRevision = 2; serverText = "Their step";
    await client.refetchQueries({ queryKey: engagementResumeQueryKey(id) });
    expect(screen.getByDisplayValue("Mine")).toBeDefined(); click("Save");
    await screen.findByText("Their step");
    expect(requests[0]?.expectedRevision).toBe(1); click("Keep yours");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false));
    expect(requests[1]?.expectedRevision).toBe(2);
    serverRevision = 4; serverText = "External";
    await client.refetchQueries({ queryKey: engagementResumeQueryKey(id) });
    await screen.findByDisplayValue("External"); client.clear();
  });

  it("pins first-edit revision through query updates and storage failures", async () => {
    fetchMock.mockResolvedValue(reply({ code: "storage_busy" }, 503));
    const view = setup(); type(); view.rerender(2, "Their step");
    expect(screen.getByDisplayValue("Mine")).toBeDefined(); click("Save");
    await screen.findByText("Storage is busy. Try again.");
    expect(sent()).toEqual({ nextStep: "Mine", expectedRevision: 1 });
    view.rerender(3, "Third step"); expect(screen.getByDisplayValue("Mine")).toBeDefined();
    click("Save"); await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sent(1).expectedRevision).toBe(1);
  });
  it("shows both versions, uses only the visible fresh revision, and requires another fetch on a second race", async () => {
    let finish: (response: Response) => void = () => {};
    fetchMock.mockResolvedValueOnce(conflict()).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(conflict(3)).mockResolvedValueOnce(reply(saved(3, "Third step")));
    setup(); type(); click("Save");
    await screen.findByText("Loading saved next step.");
    expect(screen.queryByRole("button", { name: "Keep yours" })).toBeNull();
    finish(reply(saved())); await screen.findByText("Their step");
    expect(screen.getByText("Mine")).toBeDefined(); click("Keep yours");
    await screen.findByText("Third step");
    expect(sent(2)).toEqual({ nextStep: "Mine", expectedRevision: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("Use saved adopts the fresh response without saving", async () => {
    fetchMock.mockResolvedValueOnce(conflict()).mockResolvedValueOnce(reply(saved()));
    const view = setup(); type(); click("Save"); await screen.findByText("Their step");
    click("Use saved"); expect(screen.getByDisplayValue("Their step")).toBeDefined();
    view.rerender(2, "Their step"); view.rerender(3, "Later step");
    await screen.findByDisplayValue("Later step"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("retains typed text when fetching the conflicting record fails", async () => {
    fetchMock.mockResolvedValueOnce(conflict()).mockRejectedValueOnce(new Error("offline"));
    setup(); type(); click("Save"); await screen.findByRole("button", { name: "Retry saved next step" });
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Keep yours" })).toBeNull();
  });
  it("releases the saved draft after query confirmation and blocks edits until then", async () => {
    fetchMock.mockResolvedValue(reply(record()));
    const view = setup(); type(); click("Save");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true));
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
    view.rerender(2, "Mine"); await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false));
    view.rerender(3, "External"); expect(screen.getByDisplayValue("External")).toBeDefined();
  });
  it("distinguishes archived 409 and retains the draft read-only", async () => {
    fetchMock.mockResolvedValue(reply({ code: "engagement_archived" }, 409));
    setup(); type(); click("Save"); await screen.findByText("This engagement is archived. The next step was not saved.");
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("isolates engagement state even without a host key", () => {
    const view = setup(); type(); view.rerender(0, "Other", "20000000-0000-4000-8000-000000000002");
    expect(screen.getByDisplayValue("Other")).toBeDefined();
  });
  it("validates one line and 280 Unicode code points, and pins Clear to the draft revision", async () => {
    fetchMock.mockResolvedValue(reply(record(2, null)));
    await expect(saveNextStepRequest(id, { nextStep: "x\ny", expectedRevision: 1 })).rejects.toBeInstanceOf(EngagementNextStepMutationError);
    expect(fetchMock).not.toHaveBeenCalled();
    const view = setup();
    type("\u{10400}".repeat(281)); expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    type("\u{10400}".repeat(280)); expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    view.rerender(2, "Their step"); click("Clear");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({ nextStep: null, expectedRevision: 1 });
  });
  it("preserves raw typed whitespace on a failed save", async () => {
    fetchMock.mockResolvedValue(reply({ code: "storage_busy" }, 503));
    setup(); type("  Mine  "); click("Save");
    await screen.findByText("Storage is busy. Try again.");
    expect(sent().nextStep).toBe("Mine");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("  Mine  ");
  });
  it("blocks input and actions during an in-flight request", async () => {
    let finish: (response: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const view = setup(); type(); click("Save");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(2, "Their step");
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
    finish(reply({ code: "storage_busy" }, 503));
    await screen.findByText("Storage is busy. Try again.");
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByDisplayValue("Mine")).toBeDefined();
  });
  it("rejects a saved response from a different engagement", async () => {
    fetchMock.mockResolvedValue(reply({ ...saved(), engagementId: "20000000-0000-4000-8000-000000000002" }));
    await expect(fetchEngagementResume(id)).rejects.toThrow("The resume request failed.");
  });
  it("parses typed conflict detail including currentRevision", async () => {
    fetchMock.mockResolvedValue(conflict(9));
    const failure = await saveNextStepRequest(id, { nextStep: "Mine", expectedRevision: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngagementNextStepMutationError);
    expect((failure as EngagementNextStepMutationError).detail).toMatchObject({ code: "revision_conflict", currentRevision: 9 });
  });
});
