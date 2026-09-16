import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccessRepository } from "./access.js";
import { openEngagementDatabase } from "./database.js";
import { LeadRepository } from "./leads.js";
import { EngagementRepository } from "./repository.js";
import { SecretRepository } from "./secrets.js";
import { StoneTargetRepository } from "./target-capture.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  access: AccessRepository;
  engagementId: string;
  targetId: string;
  leadId: string;
  secretId: string;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-access-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let next = 1;
  let minute = 0;
  const providers = {
    createId: () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 10, 12, minute++)),
  };
  const engagements = new EngagementRepository(database.db, providers);
  const created = engagements.createEngagement({
    name: "Access lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
  const engagementId = created.value.id;
  const targets = new StoneTargetRepository(database.db, providers);
  const target = targets.createTarget({ engagementId, label: "morrow", initialAddress: "10.0.0.5" });
  if (!target.ok) throw new Error("Fixture target failed");
  const leads = new LeadRepository(database.db, providers);
  const lead = leads.createLead(engagementId, {
    title: "Odd login form",
    source: { kind: "http_probe", ref: "probe-1" },
  });
  if (!lead.ok) throw new Error("Fixture lead failed");
  const secrets = new SecretRepository(database.db, providers);
  const secret = secrets.createSecret(engagementId, {
    label: "deploy key",
    username: "deploy",
    serviceRef: "ssh:10.0.0.5:22",
    secretRef: "vault/morrow/deploy",
    hint: "opaque reference",
  });
  if (!secret.ok) throw new Error("Fixture secret failed");
  const access = new AccessRepository(database.db, providers);
  const fixture = {
    directory,
    database,
    access,
    engagementId,
    targetId: target.value.id,
    leadId: lead.value.id,
    secretId: secret.value.id,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("access persistence", () => {
  it("records SSH access with account, source lead, and last confirmed", () => {
    const { access, engagementId, targetId, leadId, secretId } = createFixture();
    const created = access.createAccess(engagementId, {
      targetId,
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: leadId,
      secretId,
      context: "SSH from the runner network",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.account).toBe("deploy");
    expect(created.value.accessType).toBe("ssh");
    expect(created.value.sourceLeadId).toBe(leadId);
    expect(created.value.secretId).toBe(secretId);
    expect(created.value.lastConfirmedAt).toBe(created.value.createdAt);
    const listed = access.listAccess(engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((record) => record.id)).toEqual([created.value.id]);
  });

  it("rejects cross-engagement references and unknown ids", () => {
    const { access, engagementId, targetId, leadId } = createFixture();
    const missingTarget = access.createAccess(engagementId, {
      targetId: "10000000-0000-4000-8000-00000000ffff",
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: leadId,
    });
    expect(missingTarget.ok).toBe(false);
    if (missingTarget.ok) return;
    expect(missingTarget.error.code).toBe("target_not_found");
    const missingLead = access.createAccess(engagementId, {
      targetId,
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: "10000000-0000-4000-8000-00000000ffff",
    });
    expect(missingLead.ok).toBe(false);
    if (missingLead.ok) return;
    expect(missingLead.error.code).toBe("lead_not_found");
    const missingSecret = access.createAccess(engagementId, {
      targetId,
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: leadId,
      secretId: "10000000-0000-4000-8000-00000000ffff",
    });
    expect(missingSecret.ok).toBe(false);
    if (missingSecret.ok) return;
    expect(missingSecret.error.code).toBe("secret_not_found");
  });

  it("refreshes last confirmed forward and refuses archived engagements", () => {
    const fixture = createFixture();
    const { access, engagementId, targetId, leadId } = fixture;
    const created = access.createAccess(engagementId, {
      targetId,
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: leadId,
    });
    if (!created.ok) throw new Error("setup failed");
    const refreshed = access.refreshAccess(engagementId, created.value.id);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.lastConfirmedAt > created.value.lastConfirmedAt).toBe(true);
    expect(refreshed.value.createdAt).toBe(created.value.createdAt);
    const engagements = new EngagementRepository(fixture.database.db);
    const archived = engagements.archive(engagementId, 1);
    expect(archived.ok).toBe(true);
    const afterArchive = access.refreshAccess(engagementId, created.value.id);
    expect(afterArchive.ok).toBe(false);
    if (afterArchive.ok) return;
    expect(afterArchive.error.code).toBe("engagement_archived");
  });

  it("stores secrets by id only: no value column exists on the row", () => {
    const fixture = createFixture();
    const { access, engagementId, targetId, leadId, secretId } = fixture;
    const created = access.createAccess(engagementId, {
      targetId,
      account: "deploy",
      accessType: "ssh",
      sourceLeadId: leadId,
      secretId,
    });
    if (!created.ok) throw new Error("setup failed");
    const keys = Object.keys(created.value).sort();
    expect(keys).toEqual(
      [
        "accessType",
        "account",
        "context",
        "contractVersion",
        "createdAt",
        "engagementId",
        "id",
        "lastConfirmedAt",
        "secretId",
        "sourceLeadId",
        "targetId",
        "updatedAt",
      ].sort(),
    );
    const columns = fixture.database.sqlite
      .prepare("select name from pragma_table_info('access_records')")
      .all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).not.toContain("secret_value");
    expect(names).not.toContain("password");
    expect(names).toContain("secret_id");
  });
});
