import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIntermediateAssistantTranscriptMessage } from "../agents/embedded-agent-runner/message-visibility.js";
import type { ResolvedTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptMessageByEventId } from "../config/sessions/session-accessor.sqlite-transcript-identity.js";
import {
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
} from "../gateway/chat-display-projection.helpers.js";
import { sanitizeChatHistoryMessage } from "../gateway/chat-display-projection.sanitize.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../sessions/transcript-events.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  assertVoiceSessionOwnership,
  type ClientVoiceRunBinding,
  readVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "./voice-transcript.js";

export type OwnedRelayPlayback = {
  consultRunId: string;
  terminalMessageId: string;
  playbackId: string;
  sessionId: string;
  lifecycleRevision?: string;
};

/** Validate the actual relay, consult, terminal and replacement under the transcript write lock. */
export function validateOwnedVoiceTranscriptCommit(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  voice: ClientVoiceRunBinding & { owned: OwnedRelayPlayback },
  appended: { messageId: string; message: unknown },
) {
  const { owned } = voice;
  if (scope.sessionId !== owned.sessionId) {
    throw new Error("owned voice replacement targets a different consult incarnation");
  }
  const relay = readVoiceSessionRecordInTransaction(database, voice.voiceSessionId);
  if (
    !relay ||
    relay.origin !== "relay" ||
    relay.status !== "open" ||
    !relay.consultRunIds.includes(owned.consultRunId)
  ) {
    throw new Error("owned voice replacement lost its consult session");
  }
  assertVoiceSessionOwnership(relay, voice);
  const original = readTranscriptMessageByEventId(
    database,
    scope,
    owned.terminalMessageId,
  )?.message;
  if (
    !isRecord(original) ||
    original.stopReason !== "stop" ||
    isIntermediateAssistantTranscriptMessage(original) ||
    resolveTerminalAssistantTranscriptRunId(original, readSessionTranscriptRunId(original)) !==
      owned.consultRunId
  ) {
    throw new Error("owned voice replacement requires its exact terminal consult message");
  }
  const visible = sanitizeChatHistoryMessage(original, Number.MAX_SAFE_INTEGER).message;
  if (
    hasAssistantDisplayableNonTextContent(original) ||
    hasAssistantDisplayableNonTextContent(visible) ||
    hasTranscriptMediaFacts(original)
  ) {
    throw new Error("owned voice replacement cannot represent the original media");
  }
  if (
    (extractAssistantTextForSilentCheck(original)?.trim().length ?? 0) >
    VOICE_TRANSCRIPT_QUEUE_POLICY.maxEntryChars
  ) {
    throw new Error("owned voice replacement would truncate the original answer");
  }
  const marker = isRecord(appended.message) ? appended.message.__openclaw : undefined;
  if (
    appended.messageId !== `voice-owned:${owned.terminalMessageId}` ||
    !isRecord(marker) ||
    marker.replacesRunId !== owned.consultRunId ||
    marker.replacesMessageId !== owned.terminalMessageId ||
    marker.voiceSessionId !== voice.voiceSessionId ||
    marker.playbackId !== owned.playbackId
  ) {
    throw new Error("owned voice replacement does not match the committed playback");
  }
  return relay;
}
