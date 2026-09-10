import { describe, expect, it } from "vitest";

import type { AdvisorTurn } from "@blackglass/contracts";

import { filterRuledOutSuggestions } from "./ruled-out.js";
import {
  clearTriedCheck,
  extractSuggestedChecks,
  loadAccessContext,
  loadTriedChecks,
  recordTriedCheck,
  saveAccessContext,
  saveTriedChecks,
  withLiveConditions,
} from "./tried-checks.js";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

function succeededTurn(answer: string): AdvisorTurn {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    engagementId: "10000000-0000-4000-8000-000000000002",
    question: "What shows?",
    modelId: "test-model",
    redactions: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "succeeded",
    answer,
    uncertainty: "",
    citations: [],
    abstained: false,
    errorCode: null,
  };
}

describe("tried checks", () => {
  it("round-trips attempts and access context per engagement", () => {
    const storage = memoryStorage();
    expect(loadTriedChecks(storage, "eng-1")).toEqual([]);
    expect(loadAccessContext(storage, "eng-1")).toBe("");
    const attempts = recordTriedCheck([], "nmap -sV 10.0.0.5", "unauth net", "ruled-out");
    saveTriedChecks(storage, "eng-1", attempts);
    saveAccessContext(storage, "eng-1", "unauth net");
    expect(loadTriedChecks(storage, "eng-1")).toEqual(attempts);
    expect(loadAccessContext(storage, "eng-1")).toBe("unauth net");
    expect(loadTriedChecks(storage, "eng-2")).toEqual([]);
  });

  it("returns empty on corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem("blackglass.advisor.tried-checks.eng-1", "not json{");
    expect(loadTriedChecks(storage, "eng-1")).toEqual([]);
    storage.setItem(
      "blackglass.advisor.tried-checks.eng-1",
      JSON.stringify([{ summary: "", conditions: "x", outcome: "ruled-out" }]),
    );
    expect(loadTriedChecks(storage, "eng-1")).toEqual([]);
  });

  it("re-recording supersedes the earlier verdict", () => {
    const first = recordTriedCheck([], "nmap 10.0.0.5", "ctx", "ruled-out");
    const second = recordTriedCheck(first, " NMAP  10.0.0.5 ", "ctx", "supported");
    expect(second).toHaveLength(1);
    expect(second[0]?.outcome).toBe("supported");
    expect(clearTriedCheck(second, "nmap 10.0.0.5", "ctx")).toEqual([]);
  });

  it("extracts supported checks from answers, never prose", () => {
    const checks = extractSuggestedChecks([
      succeededTurn("The banner shows nginx.\n\nRun this check:\n$ nmap -sV 10.0.0.5\n\nFirst scan the box, then try harder."),
      succeededTurn("Also try:\nnmap -sV 10.0.0.5"),
    ]);
    expect(checks.map((check) => check.summary)).toEqual(["nmap -sV 10.0.0.5"]);
  });

  it("drives the ruled-out filter end to end", () => {
    const checks = withLiveConditions(
      extractSuggestedChecks([succeededTurn("$ curl -s http://127.0.0.1/")]),
      "unauth net",
    );
    const attempts = recordTriedCheck([], "curl -s http://127.0.0.1/", "unauth net", "ruled-out");
    const verdicts = filterRuledOutSuggestions(checks, attempts);
    expect(verdicts[0]?.verdict).toBe("drop");
    const retried = filterRuledOutSuggestions(
      checks.map((check) => ({ ...check, newReason: "new firmware" })),
      attempts,
    );
    expect(retried[0]?.verdict).toBe("annotate");
  });
});
