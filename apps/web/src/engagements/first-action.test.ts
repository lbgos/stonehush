import type { Engagement } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import {
  browserStorage,
  buildChallengeNotes,
  FULLER_PORTS_PRESET,
  mergeStartDescription,
  parseDeadlineDraft,
  readFirstActionDefaults,
  readLastEngagementId,
  selectResumeEngagement,
  splitStartTargets,
  storeFirstActionDefaults,
  storeLastEngagementId,
  suggestEngagementName,
} from "./first-action.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function engagement(
  overrides: Partial<Engagement> & { id: string },
): Engagement {
  return {
    contractVersion: 1,
    revision: 1,
    name: "Lab",
    kind: "lab",
    status: "active",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
    activeScopeRevisionId: null,
    deadlineAt: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("splitStartTargets", () => {
  it("splits pasted lists on newlines and commas and drops empties", () => {
    expect(splitStartTargets("192.0.2.10\n198.51.100.10, host.test\n")).toEqual([
      "192.0.2.10",
      "198.51.100.10",
      "host.test",
    ]);
    expect(splitStartTargets("  \n , ")).toEqual([]);
  });
});

describe("suggestEngagementName", () => {
  it("derives a name from an IP, URL, hostname, or CIDR", () => {
    expect(suggestEngagementName(["192.0.2.10"])).toBe("Lab 192-0-2-10");
    expect(suggestEngagementName(["https://host.test/box"])).toBe("Lab host-test");
    expect(suggestEngagementName(["target-host.test"])).toBe("Lab target-host-test");
    expect(suggestEngagementName(["192.0.2.0/24"])).toBe("Lab 192-0-2-0");
  });

  it("falls back without ever returning an empty name", () => {
    expect(suggestEngagementName([])).toBe("Untitled lab");
    expect(suggestEngagementName(["   "])).toBe("Untitled lab");
    expect(suggestEngagementName(["///"])).toBe("Lab target");
  });
});

describe("mergeStartDescription", () => {
  it("keeps the platform URL as context with the description", () => {
    expect(
      mergeStartDescription({
        description: "Evening lab.",
        platformUrl: "https://host.test/challenge",
      }),
    ).toBe("Platform: https://host.test/challenge\n\nEvening lab.");
  });

  it("returns null when everything is empty and truncates long input", () => {
    expect(
      mergeStartDescription({ description: "  ", platformUrl: "  " }),
    ).toBeNull();
    const merged = mergeStartDescription({
      challengeNote: "Challenge file: notes.txt",
      description: "x".repeat(5000),
      platformUrl: "https://host.test/",
    });
    expect(merged).not.toBeNull();
    expect(Array.from(merged ?? "").length).toBeLessThanOrEqual(4096);
    expect(merged).toContain("Platform: https://host.test/");
  });
});

describe("buildChallengeNotes", () => {
  it("wraps the file text under its name and marks truncation", () => {
    const notes = buildChallengeNotes("brief.txt", "find the flag", false);
    expect(notes).toContain("# brief.txt");
    expect(notes).toContain("find the flag");
    expect(notes).not.toContain("truncated");
    expect(buildChallengeNotes("brief.txt", "find the flag", true)).toContain("truncated");
  });
});

describe("parseDeadlineDraft", () => {
  it("treats empty as absent and malformed as an error", () => {
    expect(parseDeadlineDraft("   ")).toEqual({ kind: "absent" });
    expect(parseDeadlineDraft("not a date").kind).toBe("error");
    const parsed = parseDeadlineDraft("2026-09-01T12:00");
    expect(parsed.kind).toBe("iso");
  });
});

describe("first action defaults storage", () => {
  it("remembers only the profile and ports text, with strict fallbacks", () => {
    const storage = memoryStorage();
    expect(readFirstActionDefaults(storage)).toEqual({ profile: "quick", declaredPorts: "" });
    storeFirstActionDefaults(storage, { profile: "fuller", declaredPorts: FULLER_PORTS_PRESET });
    expect(readFirstActionDefaults(storage)).toEqual({
      profile: "fuller",
      declaredPorts: FULLER_PORTS_PRESET,
    });
    expect(
      readFirstActionDefaults(memoryStorage({ "stonehush.firstActionDefaults": "oops" })),
    ).toEqual({ profile: "quick", declaredPorts: "" });
    expect(
      readFirstActionDefaults(
        memoryStorage({
          "stonehush.firstActionDefaults": JSON.stringify({
            profile: "root-shell",
            declaredPorts: "22; rm -rf /",
            targets: ["192.0.2.10"],
          }),
        }),
      ),
    ).toEqual({ profile: "quick", declaredPorts: "" });
  });

  it("tolerates unavailable storage", () => {
    const failing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readFirstActionDefaults(failing)).toEqual({ profile: "quick", declaredPorts: "" });
    expect(() => storeFirstActionDefaults(failing, { profile: "web", declaredPorts: "" })).not.toThrow();
  });
});

describe("last engagement storage", () => {
  it("round-trips an id and rejects junk", () => {
    const storage = memoryStorage();
    expect(readLastEngagementId(storage)).toBeNull();
    storeLastEngagementId(storage, "10000000-0000-4000-8000-000000000001");
    expect(readLastEngagementId(storage)).toBe("10000000-0000-4000-8000-000000000001");
    expect(readLastEngagementId(memoryStorage({ "stonehush.lastEngagementId": "not an id!!" }))).toBeNull();
  });
});

describe("browserStorage", () => {
  it("falls back to inert storage when browser storage is unreachable", () => {
    // This file runs outside jsdom, so window itself is unreachable here,
    // which exercises the same guard as a denied storage object.
    const storage = browserStorage();
    expect(storage.getItem("stonehush.lastEngagementId")).toBeNull();
    expect(() => storage.setItem("stonehush.lastEngagementId", "x")).not.toThrow();
    expect(readLastEngagementId(storage)).toBeNull();
    expect(readFirstActionDefaults(storage)).toEqual({ profile: "quick", declaredPorts: "" });
  });
});

describe("selectResumeEngagement", () => {
  const first = engagement({
    id: "10000000-0000-4000-8000-000000000001",
    name: "First",
    updatedAt: "2026-08-12T12:00:00.000Z",
  });
  const second = engagement({
    id: "10000000-0000-4000-8000-000000000002",
    name: "Second",
    updatedAt: "2026-08-12T13:00:00.000Z",
  });
  const archived = engagement({
    id: "10000000-0000-4000-8000-000000000003",
    name: "Old",
    status: "archived",
    updatedAt: "2026-08-12T14:00:00.000Z",
  });

  it("prefers the stored id, then the newest active engagement", () => {
    expect(selectResumeEngagement([first, second], second.id)).toBe(second);
    expect(selectResumeEngagement([first, second], "missing")).toBe(second);
    expect(selectResumeEngagement([first, second], null)).toBe(second);
    expect(selectResumeEngagement([archived], null)).toBe(archived);
    expect(selectResumeEngagement([], null)).toBeUndefined();
  });
});
