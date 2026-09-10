import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { SecretRepository } from "./secrets.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  secrets: SecretRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture & { engagementId: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "blackglass-stone-secrets-test-"));
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
    name: "Secrets lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
  const secrets = new SecretRepository(database.db, providers);
  const fixture = { directory, database, secrets };
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

describe("secret persistence", () => {
  it("stores references only: no value column exists and responses carry no value", () => {
    const { database, secrets, engagementId } = createFixture();
    const columns = database.sqlite
      .prepare(`select name from pragma_table_info('secrets')`)
      .pluck()
      .all() as string[];
    expect(columns).not.toContain("value");
    expect(columns).not.toContain("password");
    expect(columns).not.toContain("plaintext");
    const created = secrets.createSecret(engagementId, {
      label: "SSH password for app host",
      username: "operator",
      serviceRef: "192.0.2.10:22/ssh",
      secretRef: "vault:stone/lab-app-ssh",
      hint: "12 chars",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect("value" in created.value).toBe(false);
    expect(JSON.stringify(created.value)).not.toContain("synthetic-secret-001");
  });

  it("rejects plaintext value fields at the contract boundary", () => {
    const { secrets, engagementId } = createFixture();
    const rejected = secrets.createSecret(engagementId, {
      label: "SSH password for app host",
      serviceRef: "192.0.2.10:22/ssh",
      secretRef: "vault:stone/lab-app-ssh",
      value: "synthetic-secret-001",
    });
    expect(rejected.ok).toBe(false);
  });

  it("keeps verification history per service without marking other services tested", () => {
    const { secrets, engagementId } = createFixture();
    const ssh = secrets.createSecret(engagementId, {
      label: "SSH password",
      serviceRef: "192.0.2.10:22/ssh",
      secretRef: "vault:stone/lab-app-ssh",
    });
    const web = secrets.createSecret(engagementId, {
      label: "Web password",
      serviceRef: "192.0.2.10:80/http",
      secretRef: "vault:stone/lab-app-web",
    });
    if (!ssh.ok || !web.ok) throw new Error("setup failed");
    const verified = secrets.recordVerification(engagementId, ssh.value.id, {
      result: "verified",
      method: "ssh login",
      note: "Worked against 192.0.2.10:22 only",
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.verifications).toHaveLength(1);
    const other = secrets.getSecret(engagementId, web.value.id);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.value.verifications).toHaveLength(0);
    expect(other.value.serviceRef).not.toBe(verified.value.serviceRef);
  });
});
