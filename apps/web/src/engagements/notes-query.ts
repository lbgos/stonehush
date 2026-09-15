import {
  EngagementNotesResponseSchema,
  UpdateEngagementNotesRequestSchema,
  type EngagementNotes,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  EngagementNotesMutationClientError,
  isNotesRevisionConflict,
  parseEngagementNotesMutationError,
} from "./errors.js";
import { reportQueryKey } from "./report-query.js";

export const ENGAGEMENT_NOTES_QUERY_ERROR_MESSAGE = "The notes request failed.";

export class EngagementNotesQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_NOTES_QUERY_ERROR_MESSAGE);
    this.name = "EngagementNotesQueryError";
  }
}

export function engagementNotesQueryKey(engagementId: string) {
  return ["engagements", engagementId, "notes"] as const;
}

export async function fetchEngagementNotes(
  engagementId: string,
  signal?: AbortSignal,
): Promise<EngagementNotes> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/notes`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new EngagementNotesQueryError();
  }
  if (response.status !== 200) throw new EngagementNotesQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementNotesQueryError();
  }
  const result = EngagementNotesResponseSchema.safeParse(payload);
  if (!result.success) throw new EngagementNotesQueryError();
  return result.data;
}

export async function saveEngagementNotesRequest(
  engagementId: string,
  input: { markdown: string; expectedRevision: number },
  signal?: AbortSignal,
): Promise<EngagementNotes> {
  const body = UpdateEngagementNotesRequestSchema.parse(input);
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${engagementId}/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new EngagementNotesMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementNotesMutationClientError("request_failed");
  }
  if (response.status !== 200) throw parseEngagementNotesMutationError(payload);
  const parsed = EngagementNotesResponseSchema.safeParse(payload);
  if (!parsed.success) throw new EngagementNotesMutationClientError("invalid_persisted_data");
  return parsed.data;
}

export function engagementNotesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementNotesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementNotes(engagementId, signal),
  });
}

export function useEngagementNotesQuery(engagementId: string) {
  return useQuery(engagementNotesQueryOptions(engagementId));
}

export function useSaveEngagementNotesMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { markdown: string; expectedRevision: number }) =>
      saveEngagementNotesRequest(engagementId, input),
    onSuccess: (notes) => {
      queryClient.setQueryData<EngagementNotes>(
        engagementNotesQueryKey(engagementId),
        notes,
      );
      void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    },
  });
}

interface NotesBase {
  markdown: string;
  revision: number;
}

export function useEngagementNotesEditor(engagementId: string) {
  const query = useEngagementNotesQuery(engagementId);
  const save = useSaveEngagementNotesMutation(engagementId);
  const queryClient = useQueryClient();
  const serverNotes = query.data;
  const serverMarkdown = serverNotes?.markdown;
  const [draft, setDraftState] = useState<string | undefined>(undefined);
  const [base, setBase] = useState<NotesBase | undefined>(undefined);
  const [conflictServer, setConflictServer] = useState<EngagementNotes | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const engagementRef = useRef(engagementId);
  engagementRef.current = engagementId;
  const requestSeq = useRef(0);

  useEffect(() => {
    setDraftState(undefined);
    setBase(undefined);
    setConflictServer(null);
    setRecoveryError(false);
    setRecovering(false);
    requestSeq.current += 1;
  }, [engagementId]);

  useEffect(() => {
    if (serverNotes === undefined) return;
    if (base === undefined && draft === undefined) {
      setDraftState(serverNotes.markdown);
      setBase({ markdown: serverNotes.markdown, revision: serverNotes.revision });
      return;
    }
    if (base !== undefined && draft !== undefined) {
      const wasClean = draft === base.markdown;
      const serverAdvanced =
        serverNotes.markdown !== base.markdown || serverNotes.revision !== base.revision;
      if (wasClean && serverAdvanced) {
        setDraftState(serverNotes.markdown);
        setBase({ markdown: serverNotes.markdown, revision: serverNotes.revision });
        return;
      }
      if (!wasClean && draft === serverNotes.markdown && serverNotes.revision !== base.revision) {
        setBase({ markdown: serverNotes.markdown, revision: serverNotes.revision });
      }
    }
  }, [serverNotes, base, draft]);

  const setDraft = (next: string) => {
    setDraftState(next);
    if (save.isError) save.reset();
  };

  const value = draft ?? serverMarkdown ?? "";
  const dirty = draft !== undefined && draft !== (serverMarkdown ?? "");
  const baseRevision = base?.revision ?? serverNotes?.revision ?? 0;

  const fetchRecovery = async (): Promise<EngagementNotes | null> => {
    const seen = engagementId;
    const seq = ++requestSeq.current;
    setRecovering(true);
    setRecoveryError(false);
    try {
      const fresh = await fetchEngagementNotes(seen);
      if (engagementRef.current !== seen || requestSeq.current !== seq) return null;
      setConflictServer(fresh);
      setRecoveryError(false);
      return fresh;
    } catch {
      if (engagementRef.current !== seen || requestSeq.current !== seq) return null;
      setRecoveryError(true);
      return null;
    } finally {
      if (engagementRef.current === seen && requestSeq.current === seq) {
        setRecovering(false);
      }
    }
  };

  const saveWithBase = (markdown: string, expectedRevision: number) => {
    save.mutate(
      { markdown, expectedRevision },
      {
        onSuccess: (notes) => {
          if (engagementRef.current !== engagementId) return;
          setBase({ markdown: notes.markdown, revision: notes.revision });
          setConflictServer(null);
          setRecoveryError(false);
        },
        onError: (error) => {
          if (engagementRef.current !== engagementId) return;
          if (isNotesRevisionConflict(error)) {
            void fetchRecovery();
          }
        },
      },
    );
  };

  const onSave = () => {
    if (draft === undefined) return;
    saveWithBase(draft, baseRevision);
  };

  const loadServerVersion = () => {
    if (conflictServer === null) return;
    if (engagementRef.current !== engagementId) return;
    const server = conflictServer;
    queryClient.setQueryData<EngagementNotes>(engagementNotesQueryKey(engagementId), server);
    setDraftState(server.markdown);
    setBase({ markdown: server.markdown, revision: server.revision });
    setConflictServer(null);
    setRecoveryError(false);
    if (save.isError) save.reset();
  };

  const keepMine = () => {
    if (conflictServer === null || draft === undefined) return;
    saveWithBase(draft, conflictServer.revision);
  };

  const retryRecovery = () => {
    void fetchRecovery();
  };

  return {
    query,
    save,
    value,
    dirty,
    setDraft,
    baseRevision,
    conflictServer,
    recoveryError,
    recovering,
    onSave,
    loadServerVersion,
    keepMine,
    retryRecovery,
  };
}
