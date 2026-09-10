import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { TechniqueRepository } from "./technique.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  techniques: TechniqueRepository;
  engagements: EngagementRepository;
  engagementId: string;
  revision: number;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createFixture(nowIso = "2026-08-12T12:00:00.000Z"): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "blackglass-technique-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  const engagements = new EngagementRepository(database.db);
  const created = engagements.createEngagement({
    name: "Lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("engagement fixture failed");
  const techniques = new TechniqueRepository(database.db, {
    now: () => new Date(nowIso),
    createId: () => "10000000-0000-4000-8000-000000000099",
  });
  const fixture = { directory, database, techniques, engagements, engagementId: created.value.id, revision: created.value.revision };
  fixtures.push(fixture);
  return fixture;
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Check default credentials",
    whenUseful: "A login form appears.",
    prerequisites: ["Login form observed"],
    question: "Does the login accept default credentials?",
    procedure: [{ instruction: "Try one documented default pair.", command: "curl -s {{url}}" }],
    meaning: "Success proves weak credentials.",
    ...overrides,
  };
}

describe("technique repository", () => {
  it("saves and lists techniques in creation order", () => {
    const fixture = createFixture();
    const created = fixture.techniques.createTechnique(
      fixture.engagementId,
      validInput(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.name).toBe("Check default credentials");
    const listed = fixture.techniques.listTechniques(fixture.engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((technique) => technique.id)).toEqual([created.value.id]);
  });

  it("rejects creates on unknown and archived engagements", () => {
    const fixture = createFixture();
    expect(
      fixture.techniques.createTechnique("missing-engagement", validInput()).ok,
    ).toBe(false);
    expect(
      fixture.engagements.archive(fixture.engagementId, fixture.revision).ok,
    ).toBe(true);
    const result = fixture.techniques.createTechnique(
      fixture.engagementId,
      validInput(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("engagement_archived");
  });

  it("rejects invalid input without touching storage", () => {
    const fixture = createFixture();
    const result = fixture.techniques.createTechnique(
      fixture.engagementId,
      validInput({ procedure: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_repository_input");
    const listed = fixture.techniques.listTechniques(fixture.engagementId);
    expect(listed.ok && listed.value.length).toBe(0);
  });

  it("hides foreign rows as technique_not_found in the same database", () => {
    const fixture = createFixture();
    const secondEngagement = fixture.engagements.createEngagement({
      name: "Second lab",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
    });
    if (!secondEngagement.ok) throw new Error("second engagement fixture failed");
    const created = fixture.techniques.createTechnique(
      fixture.engagementId,
      validInput(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Same database, row owned by another engagement: no existence oracle.
    const foreign = fixture.techniques.getTechniqueForEngagement(
      secondEngagement.value.id,
      created.value.id,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("technique_not_found");
    // The other engagement sees an empty list, not the foreign row.
    const listed = fixture.techniques.listTechniques(secondEngagement.value.id);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toEqual([]);
    // Unknown technique ids in the right engagement read the same way.
    const missing = fixture.techniques.getTechniqueForEngagement(
      fixture.engagementId,
      "10000000-0000-4000-8000-000000000098",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("technique_not_found");
  });

  it("reads stay available on archived engagements", () => {
    const fixture = createFixture();
    const created = fixture.techniques.createTechnique(
      fixture.engagementId,
      validInput(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(
      fixture.engagements.archive(fixture.engagementId, fixture.revision).ok,
    ).toBe(true);
    const reread = fixture.techniques.getTechniqueForEngagement(
      fixture.engagementId,
      created.value.id,
    );
    expect(reread.ok).toBe(true);
  });
});
