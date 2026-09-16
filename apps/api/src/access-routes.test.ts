import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AccessRepository,
  EngagementRepository,
  FfufRepository,
  HttpProbeRepository,
  LeadRepository,
  NmapServiceRepository,
  RunOutputRepository,
  SecretRepository,
  StoneTargetRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-access-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  let second = 0;
  const shared = {
    createId: () => `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 10, 12, 0, second++)),
  };
  const engagements = new EngagementRepository(database.db, { ...shared });
  const created = engagements.createEngagement({
    name: "Access lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("Fixture engagement create failed");
  const engagementId = created.value.id;
  const targets = new StoneTargetRepository(database.db, { ...shared });
  const target = targets.createTarget({
    engagementId,
    label: "morrow",
    initialAddress: "10.0.0.5",
  });
  if (!target.ok) throw new Error("Fixture target failed");
  const leads = new LeadRepository(database.db, { ...shared });
  const secrets = new SecretRepository(database.db, { ...shared });
  const app = buildApp({
    engagementRepository: engagements,
    getDevelopmentStorageReadiness: () => "ready" as const,
    nmapServiceRepository: new NmapServiceRepository(database.db),
    httpProbeRepository: new HttpProbeRepository(database.db),
    ffufRepository: new FfufRepository(database.db),
    runOutputRepository: new RunOutputRepository(database.db),
    leadRepository: leads,
    secretRepository: secrets,
    accessRepository: new AccessRepository(database.db, { ...shared }),
    stoneTargetRepository: targets,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, engagementId, targetId: target.value.id, leads, secrets };
}

function sourceLead(leads: LeadRepository, engagementId: string, title = "Odd login form") {
  const lead = leads.createLead(engagementId, {
    title,
    source: { kind: "http_probe", ref: "probe-1" },
  });
  if (!lead.ok) throw new Error("Fixture lead failed");
  return lead.value.id;
}

describe("access routes", () => {
  it("records SSH access on a target and shows it in the access list", async () => {
    const { app, engagementId, targetId, leads } = await fixture();
    const leadId = sourceLead(leads, engagementId);
    const base = `/api/v1/engagements/${engagementId}/access`;

    const created = await app.inject({
      method: "POST",
      url: base,
      payload: {
        targetId,
        account: "deploy",
        accessType: "ssh",
        sourceLeadId: leadId,
        context: "SSH from the runner network",
      },
    });
    expect(created.statusCode).toBe(201);
    const record = created.json() as {
      id: string;
      account: string;
      accessType: string;
      sourceLeadId: string;
      lastConfirmedAt: string;
    };
    expect(record.account).toBe("deploy");
    expect(record.accessType).toBe("ssh");
    expect(record.sourceLeadId).toBe(leadId);
    expect(typeof record.lastConfirmedAt).toBe("string");

    const listed = await app.inject({ method: "GET", url: base });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { id: string }[]).map((entry) => entry.id)).toEqual([record.id]);

    const fetched = await app.inject({ method: "GET", url: `${base}/${record.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: record.id, account: "deploy" });
  });

  it("fires one quiet suggestion on a parked-for-lack-of-access lead and never reopens", async () => {
    const { app, engagementId, targetId, leads } = await fixture();
    const parkedId = sourceLead(leads, engagementId, "Anonymous admin check");
    const parked = leads.parkLead(engagementId, parkedId, {
      reason: "No working credentials yet",
      testedConditions: "Only checked without authentication",
    });
    if (!parked.ok) throw new Error("Fixture park failed");
    const unrelatedId = sourceLead(leads, engagementId, "Slow scan follow-up");
    const unrelated = leads.parkLead(engagementId, unrelatedId, {
      reason: "Waiting on a slower scan to finish",
    });
    if (!unrelated.ok) throw new Error("Fixture park failed");

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/access`,
      payload: { targetId, account: "deploy", accessType: "ssh", sourceLeadId: parkedId },
    });
    expect(created.statusCode).toBe(201);

    const suggested = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/leads/${parkedId}`,
    });
    expect(suggested.statusCode).toBe(200);
    const lead = suggested.json() as {
      disposition: string;
      revisitSuggestion: { trigger: string; reason: string } | null;
    };
    expect(lead.disposition).toBe("parked");
    expect(lead.revisitSuggestion?.trigger).toBe("new_access");
    expect(lead.revisitSuggestion?.reason).toContain("Recorded SSH access");
    expect(lead.revisitSuggestion?.reason).toContain("No working credentials yet");

    const untouched = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/leads/${unrelatedId}`,
    });
    expect(untouched.statusCode).toBe(200);
    expect((untouched.json() as { revisitSuggestion: unknown }).revisitSuggestion).toBe(null);
  });

  it("refreshes last confirmed without rewriting the record", async () => {
    const { app, engagementId, targetId, leads } = await fixture();
    const leadId = sourceLead(leads, engagementId);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/access`,
      payload: { targetId, account: "deploy", accessType: "ssh", sourceLeadId: leadId },
    });
    expect(created.statusCode).toBe(201);
    const before = created.json() as { id: string; lastConfirmedAt: string; createdAt: string };

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/access/${before.id}/refresh`,
    });
    expect(refreshed.statusCode).toBe(200);
    const after = refreshed.json() as { lastConfirmedAt: string; createdAt: string };
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.lastConfirmedAt > before.lastConfirmedAt).toBe(true);
  });

  it("rejects unknown references and archived engagements", async () => {
    const { app, engagementId, targetId, leads } = await fixture();
    const leadId = sourceLead(leads, engagementId);
    const base = `/api/v1/engagements/${engagementId}/access`;
    const missing = "10000000-0000-4000-8000-00000000ffff";

    const badTarget = await app.inject({
      method: "POST",
      url: base,
      payload: { targetId: missing, account: "deploy", accessType: "ssh", sourceLeadId: leadId },
    });
    expect(badTarget.statusCode).toBe(404);
    expect(badTarget.json()).toMatchObject({ code: "target_not_found" });

    const badLead = await app.inject({
      method: "POST",
      url: base,
      payload: { targetId, account: "deploy", accessType: "ssh", sourceLeadId: missing },
    });
    expect(badLead.statusCode).toBe(404);
    expect(badLead.json()).toMatchObject({ code: "lead_not_found" });

    const badSecret = await app.inject({
      method: "POST",
      url: base,
      payload: {
        targetId,
        account: "deploy",
        accessType: "ssh",
        sourceLeadId: leadId,
        secretId: missing,
      },
    });
    expect(badSecret.statusCode).toBe(404);
    expect(badSecret.json()).toMatchObject({ code: "secret_not_found" });
  });

  it("keeps secret references out of access views, suggestions, search, and reports", async () => {
    const { app, engagementId, targetId, leads, secrets } = await fixture();
    const marker = "marker-9zqt-vault-ref";
    const secret = secrets.createSecret(engagementId, {
      label: `deploy key ${marker}`,
      username: "deploy",
      serviceRef: "ssh:10.0.0.5:22",
      secretRef: `vault/morrow/${marker}`,
      hint: "opaque reference",
    });
    if (!secret.ok) throw new Error("Fixture secret failed");
    const parkedId = sourceLead(leads, engagementId, "Anonymous admin check");
    const parked = leads.parkLead(engagementId, parkedId, {
      reason: "No working credentials yet",
    });
    if (!parked.ok) throw new Error("Fixture park failed");

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/access`,
      payload: {
        targetId,
        account: "deploy",
        accessType: "ssh",
        sourceLeadId: parkedId,
        secretId: secret.value.id,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(marker);
    expect(created.body).toContain(secret.value.id);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/access`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(marker);

    const record = created.json() as { id: string };
    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/access/${record.id}/refresh`,
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body).not.toContain(marker);

    const suggested = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/leads/${parkedId}`,
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.body).not.toContain(marker);

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/search?q=deploy`,
    });
    expect(search.statusCode).toBe(200);
    expect(search.body).not.toContain(marker);

    const report = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/report`,
    });
    expect(report.statusCode).toBe(200);
    expect(report.body).not.toContain(marker);
  });
});
