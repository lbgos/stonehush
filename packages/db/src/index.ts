export {
  OperatorCommandRepository,
  type CommandHttpResponse,
  type OperatorCommandErrorCode,
  type OperatorCommandResult,
  type PreparedOperatorCommand,
} from "./operator-command.js";
export {
  DATABASE_FILENAME,
  DATABASE_SCHEMA_VERSION,
  openEngagementDatabase,
  openReadOnlyEngagementDatabase,
  openReadOnlySqliteFile,
  type EngagementDatabase,
  type OpenDatabaseOptions,
} from "./database.js";
export {
  EngagementRepository,
  type DatabaseWriteClient,
  type EngagementWriteTransaction,
  type ActionRepositoryError,
  type RepositoryError,
  type RepositoryProviders,
  type RepositoryResult,
} from "./repository.js";
export { bindActionSnapshot } from "./action-snapshot.js";
export {
  EvidenceGrantRepository,
  hasInProgressGrantAtSequence,
  type CreateEvidenceGrantInput,
  type EngagementArtifactRecord,
  type EvidenceGrantQueryClient,
  type EvidenceGrantRecord,
  type EvidencePublicationWriteResult,
  type EvidenceGrantRepositoryError,
  type EvidenceGrantRepositoryProviders,
  type EvidenceGrantResult,
  type EvidenceGrantWriteClient,
} from "./evidence-grant.js";
export {
  RunRepository,
  allocateQueuedRun,
  fenceCurrentLeasesForRunner,
  selectOldestQueuedRun,
  type AcquiredRunLease,
  type RunPersistenceContext,
  type RunRepositoryError,
  type RunRepositoryProviders,
  type RunResult,
  type RunQueryClient,
  type RunWriteClient,
  type StoredRunEventResult,
} from "./run.js";
export {
  RunnerRepository,
  decodeRunnerSecret,
  encodeRunnerSecret,
  hashRunnerSecret,
  runnerCredentialFingerprint,
  secretsMatch,
  type AuthenticatedRunner,
  type ConfirmedRunnerEnrollment,
  type RevokedRunner,
  type RunnerRepositoryError,
  type RunnerRepositoryProviders,
  type RunnerResult,
} from "./runner.js";
export { NmapServiceRepository } from "./nmap-service.js";
export {
  LeadRepository,
  type LeadRepositoryError,
  type LeadRepositoryProviders,
  type LeadResult,
} from "./leads.js";
export {
  ObjectiveRepository,
  digestProofValue,
  type ObjectiveRepositoryError,
  type ObjectiveRepositoryProviders,
  type ObjectiveResult,
} from "./objectives.js";
export {
  SecretRepository,
  type SecretRepositoryError,
  type SecretRepositoryProviders,
  type SecretResult,
} from "./secrets.js";
export {
  AccessRepository,
  type AccessRepositoryError,
  type AccessRepositoryProviders,
  type AccessResult,
} from "./access.js";
export {
  StoneTargetRepository,
  digestStoneCaptureContent,
  type CreateStoneCaptureInput,
  type CreateStoneTargetInput,
  type StoneTargetCaptureErrorCode,
  type StoneTargetCaptureProviders,
  type StoneTargetCaptureResult,
} from "./target-capture.js";
export { SettingsRepository } from "./settings.js";
export type {
  SettingsRepositoryError,
  SettingsRepositoryErrorCode,
  SettingsRepositoryProviders,
  SettingsResult,
} from "./settings.js";
export { HttpProbeRepository } from "./http-probe.js";
export { FfufRepository } from "./ffuf.js";
export { VhostRepository } from "./vhost.js";
export { EngagementResumeRepository } from "./engagement-resume.js";
export type {
  EngagementResumeRepositoryError,
  EngagementResumeResult,
} from "./engagement-resume.js";
export { RunOutputRepository } from "./run-output.js";
export {
  ExcerptRepository,
  type CreateAttachmentInput,
  type CreateExcerptInput,
  type ExcerptRepositoryError,
  type ExcerptRepositoryProviders,
  type ExcerptResult,
} from "./excerpts.js";
export {
  ADVISOR_TURN_EXPIRY_CLEANUP_LIMIT,
  ADVISOR_TURN_EXPIRY_MS,
  ADVISOR_TURN_LIST_MAX,
  AdvisorTurnsRepository,
  type AdvisorTurnCursor,
  type AdvisorTurnFailureCode,
  type AdvisorTurnRecord,
  type AdvisorTurnStatus,
  type AdvisorTurnsError,
  type AdvisorTurnsErrorCode,
  type AdvisorTurnsRepositoryProviders,
  type AdvisorTurnsResult,
  type CompleteAdvisorTurnCompletion,
  type CompleteAdvisorTurnInput,
  type ReserveAdvisorTurnInput,
} from "./advisor-turns.js";
export {
  actionCoveredDestinations,
  accessRecords,
  actionSnapshots,
  actionWarningAcknowledgments,
  actions,
  advisorTurns,
  engagementActiveScopes,
  engagementNotes,
  engagements,
  evidenceArtifacts,
  evidenceAttachments,
  evidenceExcerpts,
  evidenceGrants,
  ffufResults,
  vhostResults,
  findings,
  httpProbeResults,
  leadAttempts,
  leads,
  nmapServices,
  objectives,
  operatorCommandIdempotency,
  runEvents,
  runLeases,
  runnerEnrollmentChallenges,
  runnerIdentities,
  runnerSessions,
  runs,
  scopeRevisions,
  secretVerifications,
  secrets,
  settings,
  stoneAddressBindings,
  stoneCaptures,
  stoneHostnameAssociations,
  stoneTargets,
  techniques,
} from "./schema.js";
export {
  TechniqueRepository,
  type TechniqueRepositoryError,
  type TechniqueRepositoryErrorCode,
  type TechniqueRepositoryProviders,
  type TechniqueResult,
} from "./technique.js";
