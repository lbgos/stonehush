import {
  ActionMutationErrorSchema,
  EngagementMutationErrorSchema,
  FindingMutationErrorSchema,
  UpdateEngagementNotesErrorSchema,
  type ActionMutationError,
  type EngagementMutationError,
  type FindingMutationError,
  type UpdateEngagementNotesError,
} from "@stonehush/contracts";

export const ENGAGEMENTS_QUERY_ERROR_MESSAGE = "The engagement list request failed.";
export const ENGAGEMENT_DETAIL_QUERY_ERROR_MESSAGE = "The engagement request failed.";
export const ENGAGEMENT_SERVICES_QUERY_ERROR_MESSAGE = "The services request failed.";
export const ENGAGEMENT_HTTP_PROBES_QUERY_ERROR_MESSAGE = "The probe results request failed.";
export const ENGAGEMENT_FFUF_RESULTS_QUERY_ERROR_MESSAGE = "The ffuf results request failed.";
export const FINDINGS_QUERY_ERROR_MESSAGE = "The findings request failed.";
export const REPORT_QUERY_ERROR_MESSAGE = "The report request failed.";
export const ENGAGEMENT_MUTATION_ERROR_MESSAGE = "The engagement request failed.";
export const FINDING_MUTATION_ERROR_MESSAGE = "The findings request failed.";

export const ENGAGEMENT_MUTATION_ERROR_COPY = {
  invalid_request: "The request was not accepted. Check the fields and try again.",
  engagement_not_found: "That engagement is no longer available.",
  engagement_archived: "This engagement is archived.",
  invalid_engagement_transition: "That lifecycle action is not valid now.",
  idempotency_conflict: "This request did not match a previous attempt. Try again.",
  revision_conflict: "This engagement changed. Showing the latest revision.",
  invalid_persisted_data: "The server returned data this client cannot use.",
  storage_busy: "Storage is busy. Try again.",
  request_failed: ENGAGEMENT_MUTATION_ERROR_MESSAGE,
} as const;

export const FINDING_MUTATION_ERROR_COPY = {
  invalid_request: "The request was not accepted. Check the fields and try again.",
  engagement_not_found: "That engagement is no longer available.",
  finding_not_found: "That finding is no longer available.",
  engagement_archived: "This engagement is archived.",
  invalid_finding_transition: "That finding action is not valid now.",
  revision_conflict: "This finding changed elsewhere. Your edits are kept.",
  invalid_persisted_data: "The server returned data this client cannot use.",
  storage_busy: "Storage is busy. Try again.",
  request_failed: FINDING_MUTATION_ERROR_MESSAGE,
} as const;

export type FindingMutationErrorCode = keyof typeof FINDING_MUTATION_ERROR_COPY;

export const ENGAGEMENT_NOTES_MUTATION_ERROR_COPY = {
  invalid_request: "The request was not accepted. Check the fields and try again.",
  engagement_not_found: "That engagement is no longer available.",
  engagement_archived: "This engagement is archived.",
  revision_conflict:
    "Notes changed elsewhere. Your edits are kept. Load the server version or keep yours.",
  invalid_persisted_data: "The server returned data this client cannot use.",
  storage_busy: "Storage is busy. Try again.",
  request_failed: ENGAGEMENT_MUTATION_ERROR_MESSAGE,
} as const;

export type EngagementNotesMutationErrorCode =
  keyof typeof ENGAGEMENT_NOTES_MUTATION_ERROR_COPY;

export const ACTION_MUTATION_ERROR_COPY = {
  action_not_found: "That action is no longer available.",
  invalid_action_transition: "That action is not valid now.",
  invalid_ffuf_action_contract: "The ffuf options were not accepted. Check the origin, wordlist, and limits.",
  action_already_queued: "That action is already queued.",
  capability_error_not_overridable: "This action cannot run. Continue is not available.",
  snapshot_binding_mismatch: "The action snapshot changed. Showing the latest revision.",
  invalid_run_transition: "That run action is not valid now.",
  run_not_retryable: "That run cannot be retried.",
} as const;

const OPERATOR_MUTATION_ERROR_COPY = {
  ...ENGAGEMENT_MUTATION_ERROR_COPY,
  ...ACTION_MUTATION_ERROR_COPY,
} as const;

export type OperatorMutationErrorCode = keyof typeof OPERATOR_MUTATION_ERROR_COPY;

export class EngagementsQueryError extends Error {
  constructor() {
    super(ENGAGEMENTS_QUERY_ERROR_MESSAGE);
    this.name = "EngagementsQueryError";
  }
}

export class EngagementDetailQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_DETAIL_QUERY_ERROR_MESSAGE);
    this.name = "EngagementDetailQueryError";
  }
}

export class EngagementServicesQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_SERVICES_QUERY_ERROR_MESSAGE);
    this.name = "EngagementServicesQueryError";
  }
}

export class EngagementHttpProbesQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_HTTP_PROBES_QUERY_ERROR_MESSAGE);
    this.name = "EngagementHttpProbesQueryError";
  }
}

export class EngagementFfufResultsQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_FFUF_RESULTS_QUERY_ERROR_MESSAGE);
    this.name = "EngagementFfufResultsQueryError";
  }
}

export class EngagementMutationClientError extends Error {
  readonly code: OperatorMutationErrorCode;
  readonly currentRevision?: number;
  readonly resourceId?: string;
  readonly resourceType?: "action" | "engagement";

  constructor(
    code: OperatorMutationErrorCode,
    details?: { currentRevision: number; resourceId: string; resourceType?: "action" | "engagement" },
  ) {
    super(OPERATOR_MUTATION_ERROR_COPY[code]);
    this.name = "EngagementMutationClientError";
    this.code = code;
    if (details) {
      this.currentRevision = details.currentRevision;
      this.resourceId = details.resourceId;
      if (details.resourceType !== undefined) this.resourceType = details.resourceType;
    }
  }
}

export function isRevisionConflict(
  error: unknown,
): error is EngagementMutationClientError & {
  code: "revision_conflict";
  currentRevision: number;
} {
  return (
    error instanceof EngagementMutationClientError &&
    error.code === "revision_conflict" &&
    typeof error.currentRevision === "number"
  );
}

export function parseEngagementMutationError(payload: unknown): EngagementMutationClientError {
  const engagement = EngagementMutationErrorSchema.safeParse(payload);
  if (engagement.success) return mutationErrorFromContract(engagement.data);
  const action = ActionMutationErrorSchema.safeParse(payload);
  if (action.success) return mutationErrorFromActionContract(action.data);
  return new EngagementMutationClientError("request_failed");
}

export function mutationErrorFromContract(
  error: EngagementMutationError,
): EngagementMutationClientError {
  if (error.code === "revision_conflict") {
    return new EngagementMutationClientError("revision_conflict", {
      currentRevision: error.currentRevision,
      resourceId: error.resourceId,
      resourceType: "engagement",
    });
  }
  return new EngagementMutationClientError(error.code);
}

export function mutationErrorFromActionContract(
  error: ActionMutationError,
): EngagementMutationClientError {
  if (error.code === "revision_conflict") {
    return new EngagementMutationClientError("revision_conflict", {
      currentRevision: error.currentRevision,
      resourceId: error.resourceId,
      resourceType: error.resourceType,
    });
  }
  return new EngagementMutationClientError(error.code);
}

export function engagementMutationMessage(error: unknown): string {
  if (error instanceof EngagementMutationClientError) return error.message;
  return ENGAGEMENT_MUTATION_ERROR_MESSAGE;
}

export class EngagementNotesMutationClientError extends Error {
  readonly code: EngagementNotesMutationErrorCode;
  readonly currentRevision?: number;
  readonly resourceId?: string;

  constructor(
    code: EngagementNotesMutationErrorCode,
    details?: { currentRevision: number; resourceId: string },
  ) {
    super(ENGAGEMENT_NOTES_MUTATION_ERROR_COPY[code]);
    this.name = "EngagementNotesMutationClientError";
    this.code = code;
    if (details) {
      this.currentRevision = details.currentRevision;
      this.resourceId = details.resourceId;
    }
  }
}

export function isNotesRevisionConflict(
  error: unknown,
): error is EngagementNotesMutationClientError & {
  code: "revision_conflict";
  currentRevision: number;
} {
  return (
    error instanceof EngagementNotesMutationClientError &&
    error.code === "revision_conflict" &&
    typeof error.currentRevision === "number"
  );
}

function notesErrorFromContract(
  error: UpdateEngagementNotesError,
): EngagementNotesMutationClientError {
  if (error.code === "revision_conflict") {
    return new EngagementNotesMutationClientError("revision_conflict", {
      currentRevision: error.currentRevision,
      resourceId: error.resourceId,
    });
  }
  return new EngagementNotesMutationClientError(error.code);
}

export function parseEngagementNotesMutationError(
  payload: unknown,
): EngagementNotesMutationClientError {
  const parsed = UpdateEngagementNotesErrorSchema.safeParse(payload);
  if (parsed.success) return notesErrorFromContract(parsed.data);
  return new EngagementNotesMutationClientError("request_failed");
}

export function engagementNotesMutationMessage(error: unknown): string {
  if (error instanceof EngagementNotesMutationClientError) return error.message;
  return ENGAGEMENT_MUTATION_ERROR_MESSAGE;
}

export class FindingMutationClientError extends Error {
  readonly code: FindingMutationErrorCode;
  readonly currentRevision?: number;
  readonly resourceId?: string;

  constructor(
    code: FindingMutationErrorCode,
    details?: { currentRevision: number; resourceId: string },
  ) {
    super(FINDING_MUTATION_ERROR_COPY[code]);
    this.name = "FindingMutationClientError";
    this.code = code;
    if (details) {
      this.currentRevision = details.currentRevision;
      this.resourceId = details.resourceId;
    }
  }
}

export function isFindingRevisionConflict(
  error: unknown,
): error is FindingMutationClientError & {
  code: "revision_conflict";
  currentRevision: number;
} {
  return (
    error instanceof FindingMutationClientError &&
    error.code === "revision_conflict" &&
    typeof error.currentRevision === "number"
  );
}

export function parseFindingMutationError(payload: unknown): FindingMutationClientError {
  const parsed = FindingMutationErrorSchema.safeParse(payload);
  if (parsed.success) return findingErrorFromContract(parsed.data);
  return new FindingMutationClientError("request_failed");
}

export function findingErrorFromContract(
  error: FindingMutationError,
): FindingMutationClientError {
  if (error.code === "revision_conflict") {
    return new FindingMutationClientError("revision_conflict", {
      currentRevision: error.currentRevision,
      resourceId: error.resourceId,
    });
  }
  return new FindingMutationClientError(error.code);
}

export function findingMutationMessage(error: unknown): string {
  if (error instanceof FindingMutationClientError) return error.message;
  return FINDING_MUTATION_ERROR_MESSAGE;
}

export class FindingsQueryError extends Error {
  constructor() {
    super(FINDINGS_QUERY_ERROR_MESSAGE);
    this.name = "FindingsQueryError";
  }
}

export class ReportQueryError extends Error {
  constructor() {
    super(REPORT_QUERY_ERROR_MESSAGE);
    this.name = "ReportQueryError";
  }
}
