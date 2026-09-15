import {
  EngagementFfufResultsResponseSchema,
  EngagementHttpProbesResponseSchema,
  EngagementIdParamsSchema,
  EngagementSearchErrorSchema,
  EngagementSearchResponseSchema,
  EngagementServicesResponseSchema,
  parseEngagementSearchQuery,
  type EngagementSearchResultKind,
  type SavedScopeRule,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  FfufRepository,
  HttpProbeRepository,
  NmapServiceRepository,
  RunOutputRepository,
} from "@stonehush/db";
import { searchCorpus, findMatchOffset, type SearchCorpusEntry } from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface EngagementSearchRouteDeps {
  readonly engagements: Pick<EngagementRepository, "getEngagement" | "getEngagementNotes" | "listScopeRevisions"> &
    Partial<Pick<EngagementRepository, "listFindings">>;
  readonly services?: Pick<NmapServiceRepository, "listForEngagement">;
  readonly ffuf?: Pick<FfufRepository, "listForEngagement">;
  readonly probes?: Pick<HttpProbeRepository, "listForEngagement">;
  readonly artifacts?: Pick<RunOutputRepository, "listArtifactsForEngagement">;
}

function sendSearchError(reply: FastifyReply, status: number, code: string) {
  const body = EngagementSearchErrorSchema.parse({ code });
  return reply.code(status).type("application/json").send(body);
}

function scopeRuleLabel(rule: SavedScopeRule): string {
  switch (rule.kind) {
    case "ip":
      return rule.target.zone === null ? rule.target.address : `${rule.target.address}%${rule.target.zone}`;
    case "cidr":
      return `${rule.target.network}/${String(rule.target.prefixLength)}`;
    case "domain":
      return rule.target.hostname;
    case "url-origin": {
      const host =
        "hostname" in rule.origin.host
          ? rule.origin.host.hostname
          : rule.origin.host.address.includes(":")
            ? `[${rule.origin.host.address}]`
            : rule.origin.host.address;
      return `${rule.origin.scheme}://${host}:${String(rule.origin.effectivePort)}`;
    }
  }
}

const SEARCH_KINDS: readonly EngagementSearchResultKind[] = [
  "target",
  "hostname",
  "note",
  "lead",
  "finding",
  "artifact",
  "excerpt",
];

/**
 * Bounded search-result id. Raw values such as ffuf and probe URLs run up
 * to 2048 chars while the result contract caps ids at 255; an overlong id
 * would fail response validation and turn a valid search into a 500.
 * Truncation keeps a length suffix so distinct long values stay distinct.
 */
export function boundedSearchId(prefix: string, raw: string): string {
  const candidate = `${prefix}:${raw}`;
  if (candidate.length <= 255) return candidate;
  return `${candidate.slice(0, 220)}...${candidate.length}`;
}

/** Character offset of the match inside the notes text for `note:notes@<offset>`. */
export function noteMatchAnchor(title: string, text: string, query: string): string {
  const match = findMatchOffset(`${title}\n${text}`, query);
  if (match === null) return "note:notes@0";
  const titlePoints = Array.from(title).length;
  const offset = match.index <= titlePoints ? 0 : match.index - titlePoints - 1;
  return `note:notes@${offset}`;
}

/**
 * Exact ffuf row anchor. The fuzz keyword names the row within its run,
 * capped so the anchor always fits the 500-char contract bound. Rows
 * sharing a 200-char fuzz prefix are disambiguated by total length, so
 * distinct rows never collapse to one anchor.
 */
export function ffufRowAnchor(runId: string, fuzz: string): string {
  if (fuzz.length <= 200) return `run:${runId}:fuzz:${fuzz}`;
  return `run:${runId}:fuzz:${fuzz.slice(0, 200)}...${fuzz.length}`;
}

/**
 * STONE-6 engagement search. Assembles a read-only corpus from existing
 * stores. Leads have no store in this slice (STONE-4 owns leads/secrets
 * tables) and excerpts have no bounded index here, so both report as
 * unindexed kinds rather than pretending to be covered. Secrets are
 * excluded by the domain search: secret-shaped values never match.
 */
export function registerEngagementSearchRoutes(
  app: FastifyInstance,
  deps: EngagementSearchRouteDeps,
): void {
  app.get("/api/v1/engagements/:engagementId/search", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendSearchError(reply, 400, "invalid_request");
    const parsedQuery = parseEngagementSearchQuery(request.query);
    if (!parsedQuery.ok) return sendSearchError(reply, 400, "invalid_request");
    const { engagementId } = params.data;

    const corpus: SearchCorpusEntry[] = [];
    try {
      const engagement = deps.engagements.getEngagement(engagementId);
      if (!engagement.ok) {
        if (engagement.error.code === "engagement_not_found") {
          return sendSearchError(reply, 404, "engagement_not_found");
        }
        if (engagement.error.code === "storage_busy") {
          return sendSearchError(reply, 503, "storage_busy");
        }
        return sendSearchError(reply, 500, "invalid_persisted_data");
      }
      const scopes = deps.engagements.listScopeRevisions(engagementId);
      if (!scopes.ok) {
        if (scopes.error.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
        return sendSearchError(reply, 500, "invalid_persisted_data");
      }
      for (const revision of scopes.value) {
        for (const rule of revision.rules) {
          const label = scopeRuleLabel(rule);
          const ruleId = boundedSearchId("scope", `${revision.id}:${rule.id}`);
          corpus.push({
            kind: "target",
            id: ruleId,
            title: label,
            text: label,
            anchor: `scope:${revision.id}:${rule.id}`,
          });
        }
      }
      if (deps.services !== undefined) {
        const services = deps.services.listForEngagement(engagementId);
        if (!services.ok) {
          if (services.code === "engagement_not_found") return sendSearchError(reply, 404, "engagement_not_found");
          if (services.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
          return sendSearchError(reply, 500, "invalid_persisted_data");
        }
        const validatedServices = EngagementServicesResponseSchema.safeParse(services.value);
        if (!validatedServices.success) return sendSearchError(reply, 500, "invalid_persisted_data");
        for (const service of validatedServices.data.slice(0, 200)) {
          corpus.push({
            kind: "target",
            id: `service:${service.address}:${service.port}`,
            title: `${service.address}:${service.port}`,
            text: `${service.address} ${service.serviceName ?? ""}`,
            anchor: `service:${service.address}:${service.port}`,
          });
          if (service.hostname !== null && service.hostname.length > 0) {
            corpus.push({
              kind: "hostname",
              id: boundedSearchId("hostname", service.hostname),
              title: service.hostname,
              text: service.hostname,
              anchor: `service:${service.address}:${service.port}`,
            });
          }
        }
      }
      const notes = deps.engagements.getEngagementNotes(engagementId);
      if (!notes.ok) {
        if (notes.error.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
        return sendSearchError(reply, 500, "invalid_persisted_data");
      }
      if (notes.value.markdown.length > 0) {
        corpus.push({
          kind: "note",
          id: "notes",
          title: "Engagement notes",
          text: notes.value.markdown,
          anchor: noteMatchAnchor("Engagement notes", notes.value.markdown, parsedQuery.value.q),
        });
      }
      if (deps.engagements.listFindings !== undefined) {
        const findings = deps.engagements.listFindings(engagementId);
        if (!findings.ok) {
          if (findings.error.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
          return sendSearchError(reply, 500, "invalid_persisted_data");
        }
        for (const finding of findings.value.slice(0, 200)) {
          corpus.push({
            kind: "finding",
            id: finding.id,
            title: finding.title,
            text: finding.body,
            anchor: `finding:${finding.id}`,
          });
        }
      }
      if (deps.ffuf !== undefined) {
        const ffuf = deps.ffuf.listForEngagement(engagementId);
        if (!ffuf.ok) {
          if (ffuf.code === "engagement_not_found") return sendSearchError(reply, 404, "engagement_not_found");
          if (ffuf.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
          return sendSearchError(reply, 500, "invalid_persisted_data");
        }
        const validatedFfuf = EngagementFfufResultsResponseSchema.safeParse(ffuf.value);
        if (!validatedFfuf.success) return sendSearchError(reply, 500, "invalid_persisted_data");
        for (const row of validatedFfuf.data.slice(0, 200)) {
          corpus.push({
            kind: "artifact",
            id: boundedSearchId("ffuf", `${row.runId}:${row.fuzz}:${row.url}`),
            title: row.url,
            text: `${row.fuzz} ${row.status}`,
            anchor: ffufRowAnchor(row.runId, row.fuzz),
          });
        }
      }
      if (deps.probes !== undefined) {
        const probes = deps.probes.listForEngagement(engagementId);
        if (!probes.ok) {
          if (probes.code === "engagement_not_found") return sendSearchError(reply, 404, "engagement_not_found");
          if (probes.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
          return sendSearchError(reply, 500, "invalid_persisted_data");
        }
        const validatedProbes = EngagementHttpProbesResponseSchema.safeParse(probes.value);
        if (!validatedProbes.success) return sendSearchError(reply, 500, "invalid_persisted_data");
        for (const probe of validatedProbes.data.slice(0, 200)) {
          corpus.push({
            kind: "hostname",
            id: boundedSearchId("probe", `${probe.runId}:${probe.url}`),
            title: probe.url,
            text: `${probe.url} ${probe.title ?? ""}`,
            anchor: `probe:${probe.runId}:${probe.artifactId}`,
          });
        }
      }
      if (deps.artifacts !== undefined) {
        const artifacts = deps.artifacts.listArtifactsForEngagement(engagementId);
        if (!artifacts.ok) {
          if (artifacts.code === "engagement_not_found") return sendSearchError(reply, 404, "engagement_not_found");
          if (artifacts.code === "storage_busy") return sendSearchError(reply, 503, "storage_busy");
          return sendSearchError(reply, 500, "invalid_persisted_data");
        }
        for (const artifact of artifacts.artifacts.slice(0, 200)) {
          corpus.push({
            kind: "artifact",
            id: artifact.artifactId,
            title: artifact.artifactId,
            text: `${artifact.artifactId} ${artifact.artifactSlot}`,
            anchor: `artifact:${artifact.artifactId}`,
          });
        }
      }
    } catch {
      return sendSearchError(reply, 500, "invalid_persisted_data");
    }

    const { results, unindexedKinds } = searchCorpus(corpus, parsedQuery.value.q);
    const reportedUnindexed = new Set<EngagementSearchResultKind>(unindexedKinds);
    // Leads and excerpts have no index in this slice: always labeled.
    reportedUnindexed.add("lead");
    reportedUnindexed.add("excerpt");
    const groups = Object.fromEntries(
      SEARCH_KINDS.map((kind) => [kind, results.filter((result) => result.kind === kind)]),
    );
    const validated = EngagementSearchResponseSchema.safeParse({
      engagementId,
      query: parsedQuery.value.q,
      groups,
      unindexedKinds: [...reportedUnindexed],
    });
    if (!validated.success) return sendSearchError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
