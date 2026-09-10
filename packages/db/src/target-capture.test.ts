import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { StoneTargetRepository } from "./target-capture.js";
import { stoneAddressBindings } from "./schema.js";
import { eq } from "drizzle-orm";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  engagements: EngagementRepository;
  targets: StoneTargetRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "blackglass-stone5-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let next = 1;
  let second = 0;
  const shared = {
    createId: () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, 0, second++)),
  };
  const engagements = new EngagementRepository(database.db, { ...shared });
  const targets = new StoneTargetRepository(database.db, { ...shared });
  const fixture = { directory, database, engagements, targets };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createEngagement(fixture: Fixture): string {
  const result = fixture.engagements.createEngagement({
    name: "Stone lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value.id;
}

describe("stone target capture repository", () => {
  it("preserves reset IP history and marks old bindings historical", () => {
    const fixture = createFixture();
    const engagementId = createEngagement(fixture);
    const created = fixture.targets.createTarget({
      engagementId,
      label: "web01",
      initialAddress: "10.0.0.5",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const changed = fixture.targets.changeAddress({
      engagementId,
      targetId: created.value.id,
      newAddress: "10.0.0.9",
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.addressText).toBe("10.0.0.9");
    expect(changed.value.retiredBindingId).not.toBeNull();
    const rows = fixture.database.db
      .select()
      .from(stoneAddressBindings)
      .where(eq(stoneAddressBindings.targetId, created.value.id))
      .all();
    expect(rows).toHaveLength(2);
    const historical = rows.filter((row) => row.status === "historical");
    const current = rows.filter((row) => row.status === "current");
    expect(historical).toHaveLength(1);
    expect(current).toHaveLength(1);
    expect(historical[0]?.addressText).toBe("10.0.0.5");
    expect(historical[0]?.supersededAt).not.toBeNull();
    expect(current[0]?.addressText).toBe("10.0.0.9");
  });

  it("keeps two targets distinct when an IP is reused", () => {
    const fixture = createFixture();
    const engagementId = createEngagement(fixture);
    const first = fixture.targets.createTarget({
      engagementId,
      label: "web01",
      initialAddress: "10.0.0.5",
    });
    const second = fixture.targets.createTarget({
      engagementId,
      label: "web02",
      initialAddress: "10.0.0.5",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.id).not.toBe(second.value.id);
  });

  it("points a second identical import at the existing capture", () => {
    const fixture = createFixture();
    const engagementId = createEngagement(fixture);
    const target = fixture.targets.createTarget({
      engagementId,
      label: "web01",
      initialAddress: "10.0.0.5",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const input = {
      engagementId,
      targetId: target.value.id,
      leadId: null,
      kind: "nmap_xml" as const,
      title: "Nmap import for web01",
      contentText: "<nmaprun></nmaprun>",
    };
    const first = fixture.targets.createCapture(input);
    const second = fixture.targets.createCapture(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.deduplicated).toBe(false);
    expect(second.value.deduplicated).toBe(true);
    expect(second.value.capture.id).toBe(first.value.capture.id);
    const listed = fixture.targets.listCaptures(engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
  });

  it("rejects invented execution facts on capture creation", () => {
    const fixture = createFixture();
    const engagementId = createEngagement(fixture);
    const result = fixture.targets.createCapture({
      engagementId,
      targetId: null,
      leadId: null,
      kind: "pasted_terminal",
      title: "pasted output",
      contentText: "output",
      rawBody: {
        startedAt: "2026-08-12T12:00:00.000Z",
        exitCode: 0,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_request");
  });

  it("stores no execution-fact columns on captures", () => {
    const fixture = createFixture();
    const columns = fixture.database.sqlite
      .prepare(`pragma table_info('stone_captures')`)
      .all() as { name: string }[];
    const names = columns.map((column) => column.name);
    for (const forbidden of ["started_at", "finished_at", "exit_code", "runner_target"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
