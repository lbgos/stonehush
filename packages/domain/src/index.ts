export { normalizeTarget } from "./normalize-target.js";
export {
  anonymousConditionsMatch,
  buildLeadOutline,
  citeParkReasonForRevisit,
  isServiceTestedBySecret,
  LEAD_CITED_REASON_MAX_CHARS,
  resolveAttemptLeadLink,
  suggestLeadRevisit,
  transitionLeadDisposition,
  type AttemptLeadLink,
  type LeadTransition,
  type LeadTransitionErrorCode,
  type LeadTransitionResult,
  type RevisitSuppressReason,
  type RevisitTriggerInput,
  type SuggestRevisitResult,
} from "./leads.js";
export {
  SECRET_DISPLAY_MASK,
  SECRET_EXCLUDED_SURFACES,
  SECRET_REDACTION_TOKEN,
  SECRET_STORAGE_COPY,
  isSecretExcludedFrom,
  maskSecretValue,
  proofHintForValue,
  redactKnownSecretsFromText,
  type KnownSecretRedaction,
  type SecretExcludedSurface,
} from "./secret-redact.js";
export {
  acceptHeartbeat,
  calculateSelfFenceDeadline,
  evaluateRunEventSequence,
  expireRunLease,
  incrementFencingToken,
  isTerminalRunState,
  selectSseResume,
  transitionRunState,
  validateLeaseAuthority,
} from "./runner-control.js";
export {
  activateAction,
  addScopeAndRun,
  cancelAction,
  continueAction,
  continueLateWarning,
  createResolutionSnapshot,
  planAction,
  recordLateWarning,
  retryActionContext,
  snapshotIsCanonical,
  warningAdditionIsCanonical,
} from "./action-planning.js";
export {
  compareSavedScope,
  estimateConcreteTargetCardinality,
  normalizeScopePortRanges,
  normalizeScopeRules,
  selectExecutionRepresentation,
} from "./saved-scope.js";
export { buildNmapArgv } from "./nmap-argv.js";
export { buildFfufArgv } from "./ffuf-argv.js";
export { isFfufSnapshot, ffufOptionsForSnapshot, hasFfufMarker } from "./ffuf-action.js";
export { parseFfufArtifactJson, type ParseFfufArtifactResult } from "./ffuf-json.js";
export { parseNmapXml, type ParsedNmapService, type ParseNmapXmlResult } from "./nmap-xml.js";
export {
  buildProbeRawBytes,
  isHttpProbeSnapshot,
  parseProbeRawBytes,
  parseProbeTitle,
  probeUrlsForSnapshot,
  selectProbeHeaders,
} from "./http-probe.js";
export {
  ADVISOR_CONTEXT_MAX_BYTES,
  ADVISOR_REDACTION_TOKEN,
  advisorUtf8ByteLength,
  isAdvisorContextWithinBudget,
  quoteAdvisorEvidenceBlock,
  redactAdvisorText,
  stripAdvisorUrlUserinfo,
  truncateUtf8Bytes,
  type AdvisorRedaction,
} from "./advisor-redact.js";
export {
  partitionAdvisorCitations,
  type AdvisorCitationPartition,
} from "./advisor-citations.js";
export {
  ADVISOR_EXPLANATION_PROMPT_VERSION,
  ADVISOR_EXPLANATION_SYSTEM_PROMPT,
  ADVISOR_HISTORY_ENTRY_MAX_BYTES,
  ADVISOR_HISTORY_MAX_TURNS,
  buildAdvisorExplanationPrompt,
  type AdvisorExplanationPrompt,
  type AdvisorExplanationPromptInput,
  type AdvisorHistoryTurn,
  type AdvisorPromptBuildResult,
} from "./advisor-explanation.js";
