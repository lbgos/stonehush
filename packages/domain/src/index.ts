export {
  checkWorkspaceBundleBounds,
  planIdRemap,
  remapStoredRefs,
  summarizeWorkspaceBundle,
  type BundleBoundsErrorCode,
} from "./workspace-bundle.js";
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
  accessRevisitReason,
  parkedForLackOfAccess,
  type AccessRevisitSource,
} from "./access.js";
export {
  SECRET_DISPLAY_MASK,
  SECRET_STORAGE_COPY,
  proofHintForValue,
} from "./secret-redact.js";
export {
  currentBindingForActions,
  describeComparability,
  planAddressChange,
  type BindingComparability,
  type PlanAddressChangeErrorCode,
  type PlanAddressChangeResult,
  type StoneBindingRecord,
} from "./normalize-target-bindings.js";
export {
  REDIRECT_HOSTS_FILE_EDIT_POLICY,
  REDIRECT_MAPPING_NEXT_STEP,
  REDIRECT_RUNNER_ONLY_NOTE,
  decideRedirectHostnameAssociation,
  proposeRedirectHostnameAssociation,
  type DecideRedirectHostnameResult,
  type ProposeRedirectHostnameErrorCode,
  type ProposeRedirectHostnameResult,
  type RedirectHostnameOffer,
} from "./redirect-hostname.js";
export {
  countNmapXmlServices,
  type CountNmapXmlServicesResult,
} from "./nmap-xml-import.js";
export {
  countFfufJsonResults,
  type CountFfufJsonResultsResult,
} from "./ffuf-json-import.js";
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
export { groupFfufResults, hideFfufGroups, undoHideFfufGroups, restoreAllFfufGroups, visibleFfufGroups, ffufGroupBasis, labelUnusualFfufResponse } from "./ffuf-group.js";
export type { FfufGroupableResult, FfufResultGroup, FfufHideState } from "./ffuf-group.js";
export { resolveWordlistByName, missingWordlistRecovery, loadLastWordlistChoice, saveLastWordlistChoice, listWordlistOptions } from "./ffuf-wordlist.js";
export type { WordlistChoiceStore, ResolveWordlistResult } from "./ffuf-wordlist.js";
export { diffRuns, checkRunDiffComparable, contextDifferences } from "./run-diff.js";
export type { RunDiff, RunDiffContext, RunDiffInput, RunDiffService, RunDiffResponse, RunDiffPath } from "./run-diff.js";
export { buildResumeChanges, changesSinceLastVisit, applyStarredFocus, toggleStarred, describePriorAttempt } from "./engagement-resume.js";
export type { ResumeChangeInput, StarredFocusInput, PriorAttemptInput } from "./engagement-resume.js";
export { searchCorpus, redactSecretsForSnippet, buildSnippet, findMatchOffset, SEARCH_SECRET_REDACTION } from "./engagement-search.js";
export type { SearchCorpusEntry, SearchCorpusOptions } from "./engagement-search.js";
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
  containsPrivateKeyBeginMarker,
  containsPrivateKeyEndMarker,
  findAdvisorSecretSpans,
  findUnterminatedPrivateKeyStarts,
  isAdvisorContextWithinBudget,
  quoteAdvisorEvidenceBlock,
  redactAdvisorText,
  stripAdvisorUrlUserinfo,
  truncateUtf8Bytes,
  type AdvisorRedaction,
  type AdvisorSecretSpan,
} from "./advisor-redact.js";
export {
  partitionAdvisorCitations,
  type AdvisorCitationPartition,
} from "./advisor-citations.js";
export {
  buildFindingPrefillBody,
  byteOffsetOfCharOffset,
  deriveAttachmentName,
  findTextMatches,
  formatExcerptSourceLabel,
  isCropRectValid,
  isSecretContinuationChar,
  maskExcerptText,
  projectMaskedSelection,
  selectionBytesFromText,
  selectionHasDanglingKeyEnd,
  selectionLooksLikeHiddenAssignmentValue,
  selectionMayHideUrlValue,
  selectionStartsMidToken,
  utf8ByteLength as excerptUtf8ByteLength,
  validateExcerptRange,
  windowSnippetFromChars,
  EXCERPT_RANGE_MAX_BYTES,
  EXCERPT_EXTENDED_CONTEXT_BYTES,
  EXCERPT_REDACTION_CONTEXT_BYTES,
  EXCERPT_REDACTION_CONTEXT_CHARS,
  EXCERPT_SNIPPET_RADIUS_CHARS,
  type CropRect,
  type MaskedExcerptText,
  type SelectionMaskProjection,
  type TextMatch,
  type TextSnippet,
} from "./excerpts.js";
export {
  extractTechniquePlaceholders,
  fillTechniquePlaceholders,
  isSupportedCheck,
  matchTechniquePrereqs,
  type FilledTemplate,
  type TechniquePrereqMatch,
} from "./technique.js";
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
