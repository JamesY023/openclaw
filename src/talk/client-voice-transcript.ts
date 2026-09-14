import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIntermediateAssistantTranscriptMessage } from "../agents/embedded-agent-runner/message-visibility.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { readSessionTranscriptHistoryEventById } from "../config/sessions/session-accessor.sqlite-history-events.js";
import {
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
  extractAssistantTextForSilentCheck,
} from "../gateway/chat-display-projection.helpers.js";
import { sanitizeChatHistoryMessage } from "../gateway/chat-display-projection.sanitize.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../sessions/transcript-events.js";
import {
  readVoiceSessionRecord as readRecord,
  assertVoiceSessionOwnership as assertOwnership,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "./voice-transcript.js";

export function buildPersistedVoiceMessage(
  params: {
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    provider: string;
  },
  owned?: OwnedRelayVoiceTranscript & { voiceSessionId: string },
): Record<string, unknown> {
  const provenance = { kind: "realtime_voice", sourceChannel: "talk" };
  if (params.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: params.text }],
      timestamp: params.timestamp,
      provenance,
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "realtime",
    provider: params.provider,
    model: "realtime-voice",
    stopReason: "stop",
    ...(owned
      ? {
          __openclaw: {
            replacesRunId: owned.consultRunId,
            replacesMessageId: owned.terminalMessageId,
            voiceSessionId: owned.voiceSessionId,
            playbackId: owned.playbackId,
          },
        }
      : {}),
    timestamp: params.timestamp,
    provenance,
  };
}

export type OwnedRelayVoiceTranscript = {
  consultRunId: string;
  terminalMessageId: string;
  playbackId: string;
  assertCurrent: () => void;
};

/** Recheck playback and its exact durable final inside the transcript append transaction. */
export function assertOwnedVoiceTranscriptReplacement(
  params: {
    agentId: string;
    voiceSessionId: string;
    sessionKey: string;
    sessionTarget: { sessionKey: string; storePath?: string };
  },
  owned: OwnedRelayVoiceTranscript,
  sessionId: string,
): void {
  const sessionTarget = { ...params.sessionTarget, agentId: params.agentId };
  const transcriptScope = { ...sessionTarget, sessionId };
  owned.assertCurrent();
  const current = readRecord(params.agentId, params.voiceSessionId);
  const currentSession = loadSessionEntryReadOnly(sessionTarget);
  if (
    !current ||
    current.status !== "open" ||
    current.origin !== "relay" ||
    currentSession?.sessionId !== sessionId ||
    !current.consultRunIds.includes(owned.consultRunId)
  ) {
    throw new Error("owned voice replacement lost its consult session");
  }
  assertOwnership(current, params);
  const original = readSessionTranscriptHistoryEventById(transcriptScope, owned.terminalMessageId)
    ?.event.message;
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
}

export function transcriptFailureKey(entryId: string): string {
  return createHash("sha256").update(entryId, "utf8").digest("hex");
}
