import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  StoneTargetRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerStoneCaptureRoutes } from "./capture-routes.js";
import { registerStoneImportRoutes } from "./import-routes.js";
import { registerStoneTargetRoutes } from "./target-routes.js";

const directories: string[] = [];
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "blackglass-stone5-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  let second = 0;
  const shared = {
    createId: () => `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, 0, second++)),
  };
  const engagements = new EngagementRepository(database.db, { ...shared });
  const targets = new StoneTargetRepository(database.db, { ...shared });
  const created = engagements.createEngagement({
    name: "Stone lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("Fixture engagement create failed");
  const app = Fastify();
  registerStoneTargetRoutes(app, { targets });
  registerStoneCaptureRoutes(app, { captures: targets });
  registerStoneImportRoutes(app, { imports: targets });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, engagementId: created.value.id };
}

describe("stone target routes", () => {
  it("creates a target, changes its address, and keeps historical bindings", async () => {
    const { app, engagementId } = await fixture();
    const base = `/api/v1/engagements/${engagementId}/stone-targets`;

    const created = await app.inject({
      method: "POST",
      url: base,
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    expect(created.statusCode).toBe(201);
    const target = created.json() as { id: string };

    const changed = await app.inject({
      method: "POST",
      url: `${base}/${target.id}/address-change`,
      payload: { targetId: target.id, newAddress: "10.0.0.9" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ targetId: target.id, addressText: "10.0.0.9" });

    const bindings = await app.inject({
      method: "GET",
      url: `${base}/${target.id}/bindings`,
    });
    expect(bindings.statusCode).toBe(200);
    const body = bindings.json() as { current: unknown[]; historical: unknown[] };
    expect(body.current).toHaveLength(1);
    expect(body.historical).toHaveLength(1);
  });

  it("proposes and decides a redirect hostname association with runner-only wording", async () => {
    const { app, engagementId } = await fixture();
    const base = `/api/v1/engagements/${engagementId}/stone-targets`;
    const created = await app.inject({
      method: "POST",
      url: base,
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    const target = created.json() as { id: string };

    const proposed = await app.inject({
      method: "POST",
      url: `${base}/${target.id}/hostname-associations`,
      payload: { connectionAddress: "10.0.0.5", requestedHostname: "app.internal" },
    });
    expect(proposed.statusCode).toBe(201);
    const association = proposed.json() as {
      id: string;
      connectionAddress: string;
      requestedHostname: string;
      hostsFileEdited: boolean;
    };
    expect(association.connectionAddress).toBe("10.0.0.5");
    expect(association.requestedHostname).toBe("app.internal");
    expect(association.hostsFileEdited).toBe(false);

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-hostname-associations/${association.id}/decision`,
      payload: { decision: "associated" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "associated" });
  });

  it("rejects invalid addresses with 400 and foreign engagements with 404", async () => {
    const { app, engagementId } = await fixture();
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-targets`,
      payload: { label: "web01", initialAddress: "not a target!!!" },
    });
    expect(invalid.statusCode).toBe(400);
    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/stone-targets",
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("rejects bindings reads for foreign targets with 404", async () => {
    const { app, engagementId } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-targets`,
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    const target = created.json() as { id: string };
    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/10000000-0000-4000-8000-000000000099/stone-targets/${target.id}/bindings`,
    });
    expect(foreign.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/stone-targets/10000000-0000-4000-8000-000000000099/bindings`,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("stone capture and import routes", () => {
  it("captures pasted terminal output labeled pasted with user details", async () => {
    const { app, engagementId } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-targets`,
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    const target = created.json() as { id: string };
    const pasted = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
      payload: {
        engagementId,
        targetId: target.id,
        leadId: null,
        kind: "pasted_terminal",
        title: "nmap on web01",
        command: "nmap -sV 10.0.0.5",
        observation: "port 80 open",
        contentText: "Nmap scan report",
      },
    });
    expect(pasted.statusCode).toBe(201);
    const body = pasted.json() as {
      deduplicated: boolean;
      capture: { originLabel: string; command: string; observation: string };
    };
    expect(body.deduplicated).toBe(false);
    expect(body.capture.originLabel).toBe("pasted");
    expect(body.capture.command).toBe("nmap -sV 10.0.0.5");
    expect(body.capture.observation).toBe("port 80 open");
  });

  it("rejects invented execution facts on paste capture", async () => {
    const { app, engagementId } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
      payload: {
        engagementId,
        targetId: null,
        leadId: null,
        kind: "pasted_terminal",
        title: "pasted output",
        contentText: "output",
        startedAt: "2026-08-12T12:00:00.000Z",
        exitCode: 0,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_request" });
  });

  it("rejects malformed nmap and ffuf uploads instead of storing them as typed evidence", async () => {
    const { app, engagementId } = await fixture();
    const nmap = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-imports/nmap-xml`,
      payload: { targetId: null, leadId: null, title: "Nmap import", contentText: "not xml" },
    });
    expect(nmap.statusCode).toBe(400);
    const ffuf = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-imports/ffuf-json`,
      payload: { targetId: null, leadId: null, title: "Ffuf import", contentText: "not json" },
    });
    expect(ffuf.statusCode).toBe(400);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[])).toHaveLength(0);
  });

  it("points a second identical nmap import at the existing capture", async () => {
    const { app, engagementId } = await fixture();
    const url = `/api/v1/engagements/${engagementId}/stone-imports/nmap-xml`;
    const payload = {
      targetId: null,
      leadId: null,
      title: "Nmap import",
      contentText: "<nmaprun></nmaprun>",
    };
    const first = await app.inject({ method: "POST", url, payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url, payload });
    expect(second.statusCode).toBe(200);
    const firstBody = first.json() as { capture: { id: string } };
    const secondBody = second.json() as {
      deduplicated: boolean;
      capture: { id: string; provenanceExistingId: string | null };
    };
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.capture.id).toBe(firstBody.capture.id);
    expect(secondBody.capture.provenanceExistingId).toBe(firstBody.capture.id);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[])).toHaveLength(1);
  });

  it("rejects typed parser kinds on the ordinary capture route", async () => {
    const { app, engagementId } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
      payload: {
        engagementId,
        targetId: null,
        leadId: null,
        kind: "nmap_xml",
        title: "Nmap import",
        contentText: "<nmaprun></nmaprun>",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects digest-only imports without presented content", async () => {
    const { app, engagementId } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-imports/nmap-xml`,
      payload: {
        targetId: null,
        leadId: null,
        title: "Nmap import",
        contentDigest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns stored content on captures", async () => {
    const { app, engagementId } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
      payload: {
        engagementId,
        targetId: null,
        leadId: null,
        kind: "pasted_terminal",
        title: "pasted output",
        contentText: "terminal bytes",
        fileName: "session.txt",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      capture: { contentText: string | null; fileName: string | null };
    };
    expect(body.capture.contentText).toBe("terminal bytes");
    expect(body.capture.fileName).toBe("session.txt");
  });
});

function harEntry(url = "https://morrow.test/login", status = 200) {
  return {
    startedDateTime: "2026-09-10T12:00:00.000Z",
    time: 42,
    request: {
      method: "GET",
      url,
      headers: [{ name: "user-agent", value: "stonehush-fixture" }],
    },
    response: {
      status,
      statusText: "OK",
      headers: [{ name: "content-type", value: "text/html" }],
      content: { size: 19, mimeType: "text/html", text: "<form>login</form>" },
    },
    cache: {},
    timings: { send: 1, wait: 40, receive: 1 },
  };
}

const SINGLE_ENTRY_HAR = JSON.stringify({
  log: { version: "1.2", creator: { name: "Caido" }, entries: [harEntry()] },
});

describe("stone proxy HAR import routes", () => {
  it("imports one proxied pair into the current target and lead with full fidelity", async () => {
    const { app, engagementId } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-targets`,
      payload: { label: "web01", initialAddress: "10.0.0.5" },
    });
    const target = created.json() as { id: string };
    const imported = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-imports/har`,
      payload: {
        targetId: target.id,
        leadId: "lead-1",
        contentText: SINGLE_ENTRY_HAR,
        fileName: "morrow.har",
      },
    });
    expect(imported.statusCode).toBe(201);
    const body = imported.json() as {
      deduplicated: boolean;
      capture: Record<string, unknown>;
    };
    expect(body.deduplicated).toBe(false);
    expect(body.capture["kind"]).toBe("har");
    expect(body.capture["originLabel"]).toBe("imported");
    expect(body.capture["targetId"]).toBe(target.id);
    expect(body.capture["leadId"]).toBe("lead-1");
    expect(body.capture["contentText"]).toBe(SINGLE_ENTRY_HAR);
    expect(body.capture["fileName"]).toBe("morrow.har");
    expect(String(body.capture["title"])).toContain("GET");
    expect(String(body.capture["title"])).toContain("https://morrow.test/login");
    for (const invented of [
      "startedAt",
      "finishedAt",
      "exitCode",
      "exitStatus",
      "executedCommand",
      "runnerTarget",
    ]) {
      expect(body.capture).not.toHaveProperty(invented);
    }
  });

  it("points a second identical HAR import at the existing capture", async () => {
    const { app, engagementId } = await fixture();
    const url = `/api/v1/engagements/${engagementId}/stone-imports/har`;
    const payload = { targetId: null, leadId: null, contentText: SINGLE_ENTRY_HAR };
    const first = await app.inject({ method: "POST", url, payload });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url, payload });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      deduplicated: boolean;
      capture: { id: string; provenanceExistingId: string | null };
    };
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.capture.provenanceExistingId).toBe(
      (first.json() as { capture: { id: string } }).capture.id,
    );
  });

  it("refuses oversized HAR selections with a naming error", async () => {
    const { app, engagementId } = await fixture();
    const url = `/api/v1/engagements/${engagementId}/stone-imports/har`;
    const many = await app.inject({
      method: "POST",
      url,
      payload: {
        targetId: null,
        leadId: null,
        contentText: JSON.stringify({
          log: {
            version: "1.2",
            entries: Array.from({ length: 9 }, () => harEntry()),
          },
        }),
      },
    });
    expect(many.statusCode).toBe(400);
    expect(many.json()).toEqual({ code: "har_too_many_entries" });

    const big = await app.inject({
      method: "POST",
      url,
      payload: { targetId: null, leadId: null, contentText: `{"log":${"9".repeat(1_048_576)}}` },
    });
    expect(big.statusCode).toBe(400);
    expect(big.json()).toEqual({ code: "har_too_large" });

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
    });
    expect((listed.json() as unknown[])).toHaveLength(0);
  });

  it("rejects malformed HAR uploads with a naming error", async () => {
    const { app, engagementId } = await fixture();
    const url = `/api/v1/engagements/${engagementId}/stone-imports/har`;
    const cases: { contentText: string; code: string }[] = [
      { contentText: "not json", code: "har_not_json" },
      { contentText: JSON.stringify({ version: "1.2" }), code: "har_not_har" },
      { contentText: JSON.stringify({ log: { version: "1.2", entries: [] } }), code: "har_no_entries" },
      {
        contentText: JSON.stringify({ log: { version: "1.2", entries: [harEntry("notaurl", 200)] } }),
        code: "har_bad_entry",
      },
    ];
    for (const candidate of cases) {
      const response = await app.inject({
        method: "POST",
        url,
        payload: { targetId: null, leadId: null, contentText: candidate.contentText },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: candidate.code });
    }

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/stone-captures`,
    });
    expect((listed.json() as unknown[])).toHaveLength(0);
  });

  it("rejects invented execution facts on HAR import", async () => {
    const { app, engagementId } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/stone-imports/har`,
      payload: {
        targetId: null,
        leadId: null,
        contentText: SINGLE_ENTRY_HAR,
        exitCode: 0,
        executedCommand: "curl https://morrow.test/login",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "invalid_request" });
  });
});
