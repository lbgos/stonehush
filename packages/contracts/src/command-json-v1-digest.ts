import { z } from "zod";

import { JsonValueSchema, type JsonValue } from "./operator-command.js";

// command-json-v1 digest projection is version-stable schema-output
// field selection and defaults. It is not current full route validation.

export interface CommandJsonV1ObjectDigestSchema {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false };
}

export interface CommandJsonV1DigestProjection {
  projectPath(value: JsonValue): JsonValue;
  projectQuery(value: JsonValue): JsonValue;
  projectBody(value: JsonValue): JsonValue;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function projectCommandJsonV1DigestObject(
  schema: CommandJsonV1ObjectDigestSchema,
  value: JsonValue,
): JsonValue {
  if (!isJsonObject(value)) return value;
  try {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return value;
    const projected = JsonValueSchema.safeParse(parsed.data);
    return projected.success ? projected.data : value;
  } catch (error) {
    if (error instanceof RangeError) return value;
    throw error;
  }
}

function projectDigestArray(
  value: JsonValue,
  projectItem: (item: JsonValue) => JsonValue,
): JsonValue {
  if (!Array.isArray(value)) return value;
  return value.map(projectItem);
}

function withProjectedField(
  value: { [key: string]: JsonValue },
  key: string,
  project: (field: JsonValue) => JsonValue,
): { [key: string]: JsonValue } {
  if (!Object.hasOwn(value, key)) return value;
  const field = value[key];
  if (field === undefined) return value;
  return { ...value, [key]: project(field) };
}

function objectProjection(
  schema: CommandJsonV1ObjectDigestSchema,
): (value: JsonValue) => JsonValue {
  return (value) => projectCommandJsonV1DigestObject(schema, value);
}

const jsonField = JsonValueSchema.optional();
const jsonFieldDefaultNull = JsonValueSchema.optional().default(null);

export const CommandJsonV1EmptyObjectDigestSchema = z.object({});

export const CommandJsonV1EngagementIdPathDigestSchema = z.object({
  engagementId: jsonField,
});

export const CommandJsonV1ActionIdPathDigestSchema = z.object({
  engagementId: jsonField,
  actionId: jsonField,
});

export const CommandJsonV1CreateEngagementBodyDigestSchema = z.object({
  name: jsonField,
  kind: jsonField,
  description: jsonFieldDefaultNull,
  authorizationContext: jsonFieldDefaultNull,
  autoContinueWarnings: jsonField,
  deadlineAt: jsonField,
});

export const CommandJsonV1RevisionBodyDigestSchema = z.object({
  expectedRevision: jsonField,
});

export const CommandJsonV1UpdateAutoContinueWarningsBodyDigestSchema = z.object({
  expectedRevision: jsonField,
  autoContinueWarnings: jsonField,
});

export const CommandJsonV1UpdateDeadlineBodyDigestSchema = z.object({
  expectedRevision: jsonField,
  deadlineAt: jsonField,
});

export const CommandJsonV1AppendScopeRevisionBodyDigestSchema = z.object({
  expectedRevision: jsonField,
  rules: jsonField,
});

export const CommandJsonV1CreateActionBodyDigestSchema = z.object({
  expectedEngagementRevision: jsonField,
  expectedActiveScopeRevisionId: jsonField,
  targets: jsonField,
  declaredPorts: jsonFieldDefaultNull,
});

export const CommandJsonV1ContinueActionBodyDigestSchema = z.object({
  expectedRevision: jsonField,
  snapshotVersion: jsonField,
  snapshotBinding: jsonField,
});

export const CommandJsonV1ContinueLateWarningActionBodyDigestSchema = z.object({
  expectedRevision: jsonField,
  snapshotVersion: jsonField,
  snapshotBinding: jsonField,
  pendingEventId: jsonField,
});

export const CommandJsonV1AddScopeAndRunBodyDigestSchema = z.object({
  expectedEngagementRevision: jsonField,
  expectedActionRevision: jsonField,
  rules: jsonField,
});

export const CommandJsonV1CancelActionBodyDigestSchema = z.object({
  expectedRevision: jsonField,
});

// Advisor turn digest binds the explicit request only: question plus the
// excerpt and finding id arrays in original order (order determines prompt
// order, so canonicalization must preserve it). Model, settings, history,
// and the body engagement id stay out so retries survive drift; the route
// checks body/path engagement equality before projecting.
export const CommandJsonV1CreateAdvisorTurnBodyDigestSchema = z.object({
  question: jsonField,
  excerptArtifactIds: jsonField,
  findingIds: jsonField,
});

export const CommandJsonV1CreateFfufDiscoveryBodyDigestSchema = z.object({
  expectedEngagementRevision: jsonField,
  expectedActiveScopeRevisionId: jsonField,
  origin: jsonField,
  wordlistPath: jsonField,
  rate: jsonField,
  threads: jsonField,
  timeoutSeconds: jsonField,
  maxTimeSeconds: jsonField,
  matchStatusCodes: jsonField,
});

export const CommandJsonV1PortRangeDigestSchema = z.object({
  from: jsonField,
  to: jsonField,
});

export const CommandJsonV1IpTargetDigestSchema = z.object({
  kind: jsonField,
  normalizationProfile: jsonField,
  family: jsonField,
  address: jsonField,
  zone: jsonField,
});

export const CommandJsonV1CidrTargetDigestSchema = z.object({
  kind: jsonField,
  normalizationProfile: jsonField,
  family: jsonField,
  network: jsonField,
  prefixLength: jsonField,
  hostBitsMasked: jsonField,
});

export const CommandJsonV1HostnameTargetDigestSchema = z.object({
  kind: jsonField,
  normalizationProfile: jsonField,
  hostname: jsonField,
});

export const CommandJsonV1UrlHostnameHostDigestSchema = z.object({
  hostname: jsonField,
});

export const CommandJsonV1UrlAddressHostDigestSchema = z.object({
  address: jsonField,
  zone: jsonField,
});

export const CommandJsonV1UrlHostUnionDigestSchema = z.object({
  hostname: jsonField,
  address: jsonField,
  zone: jsonField,
});

export const CommandJsonV1UrlOriginDigestSchema = z.object({
  scheme: jsonField,
  host: jsonField,
  effectivePort: jsonField,
});

export const CommandJsonV1IpScopeRuleDigestSchema = z.object({
  id: jsonField,
  kind: jsonField,
  target: jsonField,
  portRanges: jsonField,
});

export const CommandJsonV1CidrScopeRuleDigestSchema = z.object({
  id: jsonField,
  kind: jsonField,
  target: jsonField,
  portRanges: jsonField,
});

export const CommandJsonV1DomainScopeRuleDigestSchema = z.object({
  id: jsonField,
  kind: jsonField,
  target: jsonField,
  includeSubdomains: jsonField,
  portRanges: jsonField,
});

export const CommandJsonV1UrlOriginScopeRuleDigestSchema = z.object({
  id: jsonField,
  kind: jsonField,
  origin: jsonField,
  portRanges: jsonField,
});

export const CommandJsonV1ScopeRuleCommonDigestSchema = z.object({
  id: jsonField,
  kind: jsonField,
  portRanges: jsonField,
});

export function projectCommandJsonV1UrlHost(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  const hasHostname = Object.hasOwn(value, "hostname");
  const hasAddress = Object.hasOwn(value, "address");
  const hasZone = Object.hasOwn(value, "zone");
  if (hasHostname && !hasAddress && !hasZone) {
    return projectCommandJsonV1DigestObject(
      CommandJsonV1UrlHostnameHostDigestSchema,
      value,
    );
  }
  if ((hasAddress || hasZone) && !hasHostname) {
    return projectCommandJsonV1DigestObject(
      CommandJsonV1UrlAddressHostDigestSchema,
      value,
    );
  }
  return projectCommandJsonV1DigestObject(
    CommandJsonV1UrlHostUnionDigestSchema,
    value,
  );
}

function projectCommandJsonV1UrlOrigin(value: JsonValue): JsonValue {
  const projected = projectCommandJsonV1DigestObject(
    CommandJsonV1UrlOriginDigestSchema,
    value,
  );
  if (!isJsonObject(projected)) return projected;
  return withProjectedField(projected, "host", projectCommandJsonV1UrlHost);
}

function projectCommandJsonV1PortRanges(value: JsonValue): JsonValue {
  return projectDigestArray(value, (item) =>
    projectCommandJsonV1DigestObject(CommandJsonV1PortRangeDigestSchema, item),
  );
}

function projectScopeRule(
  value: { [key: string]: JsonValue },
  schema: CommandJsonV1ObjectDigestSchema,
  nestedKey: "target" | "origin" | undefined,
  projectNested: ((field: JsonValue) => JsonValue) | undefined,
): JsonValue {
  const projected = projectCommandJsonV1DigestObject(schema, value);
  if (!isJsonObject(projected)) return projected;
  const withNested =
    nestedKey === undefined || projectNested === undefined
      ? projected
      : withProjectedField(projected, nestedKey, projectNested);
  return withProjectedField(withNested, "portRanges", projectCommandJsonV1PortRanges);
}

export function projectCommandJsonV1SavedScopeRule(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) return value;
  switch (value.kind) {
    case "ip":
      return projectScopeRule(
        value,
        CommandJsonV1IpScopeRuleDigestSchema,
        "target",
        (target) =>
          projectCommandJsonV1DigestObject(CommandJsonV1IpTargetDigestSchema, target),
      );
    case "cidr":
      return projectScopeRule(
        value,
        CommandJsonV1CidrScopeRuleDigestSchema,
        "target",
        (target) =>
          projectCommandJsonV1DigestObject(
            CommandJsonV1CidrTargetDigestSchema,
            target,
          ),
      );
    case "domain":
      return projectScopeRule(
        value,
        CommandJsonV1DomainScopeRuleDigestSchema,
        "target",
        (target) =>
          projectCommandJsonV1DigestObject(
            CommandJsonV1HostnameTargetDigestSchema,
            target,
          ),
      );
    case "url-origin":
      return projectScopeRule(
        value,
        CommandJsonV1UrlOriginScopeRuleDigestSchema,
        "origin",
        projectCommandJsonV1UrlOrigin,
      );
    default:
      return projectScopeRule(
        value,
        CommandJsonV1ScopeRuleCommonDigestSchema,
        undefined,
        undefined,
      );
  }
}

function projectRulesField(value: JsonValue): JsonValue {
  return projectDigestArray(value, projectCommandJsonV1SavedScopeRule);
}

function projectRulesBody(
  schema: CommandJsonV1ObjectDigestSchema,
  value: JsonValue,
): JsonValue {
  const projected = projectCommandJsonV1DigestObject(schema, value);
  if (!isJsonObject(projected)) return projected;
  return withProjectedField(projected, "rules", projectRulesField);
}

export function projectCommandJsonV1DigestInput(
  projection: CommandJsonV1DigestProjection,
  input: { path: JsonValue; query: JsonValue; body: JsonValue },
): { path: JsonValue; query: JsonValue; body: JsonValue } {
  return {
    path: projection.projectPath(input.path),
    query: projection.projectQuery(input.query),
    body: projection.projectBody(input.body),
  };
}

function digestProjection(options: {
  path: CommandJsonV1ObjectDigestSchema;
  query: CommandJsonV1ObjectDigestSchema;
  body: (value: JsonValue) => JsonValue;
}): CommandJsonV1DigestProjection {
  return {
    projectPath: objectProjection(options.path),
    projectQuery: objectProjection(options.query),
    projectBody: options.body,
  };
}

export const commandJsonV1CreateEngagementDigest = digestProjection({
  path: CommandJsonV1EmptyObjectDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1CreateEngagementBodyDigestSchema),
});

export const commandJsonV1EngagementRevisionDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1RevisionBodyDigestSchema),
});

export const commandJsonV1ArchiveEngagementDigest =
  commandJsonV1EngagementRevisionDigest;

export const commandJsonV1ReopenEngagementDigest =
  commandJsonV1EngagementRevisionDigest;

export const commandJsonV1UpdateAutoContinueWarningsDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1UpdateAutoContinueWarningsBodyDigestSchema),
});

export const commandJsonV1UpdateDeadlineDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1UpdateDeadlineBodyDigestSchema),
});

export const commandJsonV1AppendScopeRevisionDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: (value) =>
    projectRulesBody(CommandJsonV1AppendScopeRevisionBodyDigestSchema, value),
});

export const commandJsonV1CreateActionDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1CreateActionBodyDigestSchema),
});

export const commandJsonV1ContinueActionDigest = digestProjection({
  path: CommandJsonV1ActionIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1ContinueActionBodyDigestSchema),
});

export const commandJsonV1ContinueLateWarningActionDigest = digestProjection({
  path: CommandJsonV1ActionIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1ContinueLateWarningActionBodyDigestSchema),
});

export const commandJsonV1AddScopeAndRunActionDigest = digestProjection({
  path: CommandJsonV1ActionIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: (value) =>
    projectRulesBody(CommandJsonV1AddScopeAndRunBodyDigestSchema, value),
});

export const commandJsonV1CancelActionDigest = digestProjection({
  path: CommandJsonV1ActionIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1CancelActionBodyDigestSchema),
});

export const commandJsonV1CreateAdvisorTurnDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1CreateAdvisorTurnBodyDigestSchema),
});

export const commandJsonV1CreateFfufDiscoveryDigest = digestProjection({
  path: CommandJsonV1EngagementIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1CreateFfufDiscoveryBodyDigestSchema),
});

export const CommandJsonV1StartEnrollmentChallengeBodyDigestSchema = z.object({
  name: jsonField,
  installationFingerprint: jsonField,
});

export const CommandJsonV1EnrollmentChallengeIdPathDigestSchema = z.object({
  challengeId: jsonField,
});

export const CommandJsonV1ConfirmEnrollmentBodyDigestSchema = z.object({
  ownerConfirmed: jsonField,
});

export const CommandJsonV1RunnerIdPathDigestSchema = z.object({
  runnerId: jsonField,
});

export const CommandJsonV1RevokeRunnerBodyDigestSchema = z.object({
  expectedRevision: jsonField,
});

export const CommandJsonV1RunnerLeaseIdPathDigestSchema = z.object({
  leaseId: jsonField,
});

export const CommandJsonV1RunnerAppendStartedBodyDigestSchema = z.object({
  runId: jsonField,
  sessionId: jsonField,
  fence: jsonField,
  sequence: jsonField,
  payload: jsonField,
});

export const CommandJsonV1RunnerCompleteBodyDigestSchema = z.object({
  runId: jsonField,
  sessionId: jsonField,
  fence: jsonField,
  sequence: jsonField,
  terminalKind: jsonField,
  reason: jsonField,
});

export const CommandJsonV1RunnerArtifactGrantBodyDigestSchema = z.object({
  runId: jsonField,
  leaseId: jsonField,
  sessionId: jsonField,
  fence: jsonField,
  eventSequence: jsonField,
  artifactSlot: jsonField,
  kind: jsonField,
  declaredSizeBytes: jsonField,
  declaredDigest: jsonField,
  originalFileName: jsonField,
  declaredContentType: jsonField,
});

export const commandJsonV1StartEnrollmentChallengeDigest = digestProjection({
  path: CommandJsonV1EmptyObjectDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1StartEnrollmentChallengeBodyDigestSchema),
});

export const commandJsonV1ConfirmEnrollmentDigest = digestProjection({
  path: CommandJsonV1EnrollmentChallengeIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1ConfirmEnrollmentBodyDigestSchema),
});

export const commandJsonV1RevokeRunnerDigest = digestProjection({
  path: CommandJsonV1RunnerIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1RevokeRunnerBodyDigestSchema),
});

export const commandJsonV1RunnerAppendStartedDigest = digestProjection({
  path: CommandJsonV1RunnerLeaseIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1RunnerAppendStartedBodyDigestSchema),
});

export const commandJsonV1RunnerCompleteDigest = digestProjection({
  path: CommandJsonV1RunnerLeaseIdPathDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1RunnerCompleteBodyDigestSchema),
});

export const commandJsonV1RunnerArtifactGrantDigest = digestProjection({
  path: CommandJsonV1EmptyObjectDigestSchema,
  query: CommandJsonV1EmptyObjectDigestSchema,
  body: objectProjection(CommandJsonV1RunnerArtifactGrantBodyDigestSchema),
});
