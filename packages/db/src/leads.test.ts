import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { LeadRepository } from "./leads.js";
import { EngagementRepository } from "./repository.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  leads: LeadRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture & { engagementId: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "blackglass-stone-leads-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let next = 1;
  let minute = 0;
  const providers = {
    createId: () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  };
  const engagements = new EngagementRepository(database.db, providers);
  const created = engagements.createEngagement({
    name: "Leads lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
  const leads = new LeadRepository(database.db, providers);
  const fixture = { directory, database, leads };
  fixtures.push(fixture);
  return { ...fixture, engagementId: created.value.id };
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

const SOURCE = { kind: "http_probe", ref: "probe-artifact-1" } as const;

describe("lead persistence", () => {
  it("creates a bookmark-effort lead and lists it scoped to the engagement", () => {
    const { leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, {
      title: "Odd login form on port 8080",
      target: "192.0.2.10",
      source: SOURCE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.disposition).toBe("open");
    const listed = leads.listLeads(engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((lead) => lead.id)).toEqual([created.value.id]);
  });

  it("parks with a reason and preserves tested conditions", () => {
    const { leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, {
      title: "Anonymous path",
      source: SOURCE,
    });
    if (!created.ok) throw new Error("setup failed");
    const parked = leads.parkLead(engagementId, created.value.id, {
      reason: "No working credentials yet",
      testedConditions: "Only checked without authentication",
    });
    expect(parked.ok).toBe(true);
    if (!parked.ok) return;
    expect(parked.value.disposition).toBe("parked");
    expect(parked.value.parkReason).toBe("No working credentials yet");
    expect(parked.value.testedConditions).toBe("Only checked without authentication");
  });

  it("suppresses an identical anonymous re-suggestion and never auto-reopens", () => {
    const { leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, {
      title: "Anonymous path",
      source: SOURCE,
    });
    if (!created.ok) throw new Error("setup failed");
    const parked = leads.parkLead(engagementId, created.value.id, {
      reason: "No working credentials yet",
      testedConditions: "Only checked without authentication",
    });
    if (!parked.ok) throw new Error("setup failed");
    const suppressed = leads.suggestRevisit(engagementId, created.value.id, {
      trigger: "service_change",
      reason: "Retried anonymously.",
      anonymous: true,
      conditions: "Only checked without authentication",
    });
    expect(suppressed.ok).toBe(false);
    if (suppressed.ok) return;
    expect(suppressed.error.code).toBe("revisit_suppressed");
    const still = leads.getLead(engagementId, created.value.id);
    expect(still.ok).toBe(true);
    if (!still.ok) return;
    expect(still.value.disposition).toBe("parked");
    expect(still.value.revisitSuggestion).toBe(null);
  });

  it("records access with a source lead and cites the parked reason in one quiet suggestion", () => {
    const { leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, {
      title: "Anonymous path",
      source: SOURCE,
    });
    if (!created.ok) throw new Error("setup failed");
    const parked = leads.parkLead(engagementId, created.value.id, {
      reason: "No working credentials yet",
      testedConditions: "Only checked without authentication",
    });
    if (!parked.ok) throw new Error("setup failed");
    const suggested = leads.suggestRevisit(engagementId, created.value.id, {
      trigger: "new_access",
      reason: "SSH access gained for 192.0.2.10.",
      anonymous: false,
    });
    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    expect(suggested.value.disposition).toBe("parked");
    expect(suggested.value.revisitSuggestion?.reason).toContain(
      'Previously parked: "No working credentials yet"',
    );
    expect(suggested.value.revisitSuggestion?.reason).toContain("SSH access gained");
    const second = leads.suggestRevisit(engagementId, created.value.id, {
      trigger: "hostname_change",
      reason: "Another change.",
      anonymous: false,
    });
    expect(second.ok).toBe(false);
  });

  it("orders attempts and renders the successful chain as an outline", () => {
    const { leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, {
      title: "Odd login form",
      target: "192.0.2.10",
      source: SOURCE,
    });
    if (!created.ok) throw new Error("setup failed");
    const first = leads.recordAttempt(engagementId, created.value.id, {
      summary: "Checked default credentials",
      outcome: "ruled_out",
      conditions: "Only checked without authentication",
      evidenceArtifactIds: ["shared-capture-1"],
    });
    const second = leads.recordAttempt(engagementId, created.value.id, {
      summary: "Logged in with found password",
      outcome: "observed",
      evidenceArtifactIds: ["shared-capture-1"],
      linkedFindingId: "20000000-0000-4000-8000-000000000001",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.sequence).toBe(1);
    expect(second.value.sequence).toBe(2);
    const outline = leads.leadOutline(engagementId, created.value.id);
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.value.outline).toContain("Lead: Odd login form");
    expect(outline.value.outline).toContain("ruled out under conditions");
    expect(outline.value.outline).toContain(
      "Establishes finding 20000000-0000-4000-8000-000000000001",
    );
  });

  it("supports one capture across two leads and attach-afterward", () => {
    const { leads, engagementId } = createFixture();
    const first = leads.createLead(engagementId, { title: "First lead", source: SOURCE });
    const second = leads.createLead(engagementId, { title: "Second lead", source: SOURCE });
    if (!first.ok || !second.ok) throw new Error("setup failed");
    const attempt = leads.recordAttempt(engagementId, first.value.id, {
      summary: "Shared capture attempt",
      outcome: "inconclusive",
      evidenceArtifactIds: ["shared-capture-1"],
    });
    if (!attempt.ok) throw new Error("setup failed");
    const attached = leads.attachAttempt(engagementId, attempt.value.id, {
      leadId: second.value.id,
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value.leadId).toBe(second.value.id);
    const retry = leads.recordAttempt(engagementId, second.value.id, {
      summary: "Second look at the same capture",
      outcome: "observed",
      evidenceArtifactIds: ["shared-capture-1"],
    });
    expect(retry.ok).toBe(true);
  });

  it("rejects mutations on archived engagements but keeps reads", () => {
    const { database, leads, engagementId } = createFixture();
    const created = leads.createLead(engagementId, { title: "Lead", source: SOURCE });
    if (!created.ok) throw new Error("setup failed");
    database.sqlite
      .prepare(`update engagements set status = 'archived' where id = ?`)
      .run(engagementId);
    expect(
      leads.createLead(engagementId, { title: "Another", source: SOURCE }).ok,
    ).toBe(false);
    expect(leads.listLeads(engagementId).ok).toBe(true);
  });
});
