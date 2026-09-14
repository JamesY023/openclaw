import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { isIntermediateAssistantTranscriptMessage } from "../agents/embedded-agent-runner/message-visibility.js";
import {
  loadSessionEntry,
  readRecentSessionTranscriptMessageEvents,
} from "../config/sessions/session-accessor.js";
import type { AssistantMessage } from "../llm/types.js";
import { transcodeAudioBufferToTalkPcm } from "../media/audio-transcode.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { appendOwnedRelayVoiceTranscript } from "../talk/client-voice-session.js";
import type { RealtimeVoiceForcedConsultHandle } from "../talk/forced-consult-coordinator.js";
import { synthesizeTalkSpeech } from "../tts/tts-synthesis.js";
import { extractAssistantTextForSilentCheck } from "./chat-display-projection.helpers.js";
import {
  broadcastToOwner,
  relaySessions,
  type RelaySession,
  type OwnedTalkPlayback,
} from "./talk-realtime-relay-state.js";

/** Cancel local utterances without closing the provider's microphone transport. */
export function cancelOwnedTalkPlayback(session: RelaySession, turnId?: string): void {
  const owned = session.ownedOutput;
  if (!owned) {
    return;
  }
  for (const playback of owned.playbacks.values()) {
    if (turnId && playback.turnId !== turnId) {
      continue;
    }
    if (["completed", "cancelled", "failed"].includes(playback.state)) {
      continue;
    }
    playback.state = "cancelled";
    playback.controller.abort(new Error("Talk playback cancelled"));
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "clear",
      talkEvent: session.harness.talk.emit({
        type: "turn.cancelled",
        turnId: playback.turnId,
        payload: {},
        final: true,
      }),
    });
  }
}

export function deliverOwnedTalkResult(
  session: RelaySession,
  handle: RealtimeVoiceForcedConsultHandle,
  callId: string,
): void {
  const owned = session.ownedOutput;
  if (!owned || owned.playbacks.has(callId)) {
    return;
  }
  const runId = session.activeAgentToolCalls.get(callId);
  const input = handle.context as { generation?: number; turnId?: string } | undefined;
  if (!runId || input?.generation !== owned.generation || !input.turnId) {
    return;
  }
  const target = {
    agentId: session.sessionTarget.agentId,
    sessionKey: session.sessionTarget.canonicalKey,
    storePath: session.sessionTarget.storePath,
  };
  const entry = loadSessionEntry(target);
  if (!entry?.sessionId) {
    return;
  }
  const events = readRecentSessionTranscriptMessageEvents(
    { ...target, sessionId: entry.sessionId },
    { maxBytes: 1024 * 1024, maxLines: 200, maxMessages: 200 },
  ).events;
  const terminal = events.toReversed().find((row) => {
    const message = (row.event as { message?: AssistantMessage }).message;
    return (
      message?.role === "assistant" &&
      message.stopReason === "stop" &&
      readSessionTranscriptRunId(message) === runId &&
      !isIntermediateAssistantTranscriptMessage(message) &&
      !message.content.some((block) => block.type === "toolCall")
    );
  });
  const message = (terminal?.event as { message?: AssistantMessage } | undefined)?.message;
  const text = message
    ? extractAssistantTextForSilentCheck(message as unknown as Record<string, unknown>)
    : undefined;
  const terminalMessageId = terminal?.event.id;
  if (!text?.trim() || text.length > 2000 || typeof terminalMessageId !== "string") {
    session.context.logGateway.warn(
      "Talk speech unavailable for the durable answer; text fallback retained",
    );
    return;
  }
  const playback: OwnedTalkPlayback = {
    markName: `owned-talk:${randomUUID()}`,
    turnId: input.turnId,
    runId,
    terminalMessageId,
    text,
    generation: owned.generation,
    controller: new AbortController(),
    state: "preparing",
  };
  owned.playbacks.set(callId, playback);
  const assertCurrent = () => {
    playback.controller.signal.throwIfAborted();
    if (
      relaySessions.get(session.id) !== session ||
      session.ownedOutput !== owned ||
      owned.generation !== playback.generation
    ) {
      throw new Error("Talk utterance is no longer current");
    }
  };
  void (async () => {
    assertCurrent();
    const synthesized = await synthesizeTalkSpeech({
      text,
      cfg: session.voiceConfig ?? session.context.getRuntimeConfig(),
      disableFallback: true,
      timeoutMs: 60_000,
      agentId: target.agentId,
    });
    assertCurrent();
    if (!synthesized.success || !synthesized.audioBuffer) {
      throw new Error("Talk synthesis failed");
    }
    const pcm = await transcodeAudioBufferToTalkPcm({
      audioBuffer: synthesized.audioBuffer,
      inputExtension: synthesized.fileExtension,
    });
    assertCurrent();
    playback.state = "playing";
    for (let offset = 0; offset < pcm.length; offset += 960) {
      assertCurrent();
      const frame = pcm.subarray(offset, offset + 960);
      broadcastToOwner(session.context, session.connId, {
        relaySessionId: session.id,
        type: "audio",
        audioBase64: frame.toString("base64"),
        talkEvent: session.harness.talk.emit({
          type: "output.audio.delta",
          turnId: playback.turnId,
          payload: { byteLength: frame.length },
        }),
      });
      await wait(20, undefined, { signal: playback.controller.signal });
    }
    assertCurrent();
    playback.state = "awaiting";
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "audioDone",
      talkEvent: session.harness.talk.emit({
        type: "output.audio.done",
        turnId: playback.turnId,
        payload: {},
        final: true,
      }),
    });
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "mark",
      markName: playback.markName,
      talkEvent: session.harness.talk.emit({
        type: "output.audio.done",
        turnId: playback.turnId,
        payload: {},
        final: true,
      }),
    });
  })().catch(() => {
    if (playback.state === "cancelled") {
      return;
    }
    playback.state = "failed";
    if (relaySessions.get(session.id) === session) {
      broadcastToOwner(session.context, session.connId, {
        relaySessionId: session.id,
        type: "clear",
        talkEvent: session.harness.talk.emit({
          type: "turn.cancelled",
          turnId: playback.turnId,
          payload: {},
          final: true,
        }),
      });
      session.context.logGateway.warn(
        "Talk speech failed; the complete text answer remains visible",
      );
    }
  });
}

export function acknowledgeOwnedTalkPlayback(
  session: RelaySession,
  playback: OwnedTalkPlayback,
  outcome?: "completed" | "cancelled" | "failed",
): Promise<void> | void {
  const owned = session.ownedOutput;
  if (!owned) {
    throw new Error("Talk output is no longer host owned");
  }
  if (!outcome) {
    throw new Error("Owned Talk playback requires an explicit outcome");
  }
  if (playback.state === "completed") {
    return;
  }
  if (outcome !== "completed") {
    cancelOwnedTalkPlayback(session, playback.turnId);
    playback.state = outcome === "failed" ? "failed" : "cancelled";
    return;
  }
  const assertCurrent = () => {
    playback.controller.signal.throwIfAborted();
    if (
      relaySessions.get(session.id) !== session ||
      session.ownedOutput !== owned ||
      owned.generation !== playback.generation ||
      playback.state !== "awaiting"
    ) {
      throw new Error("Owned Talk playback is not a current completed delivery");
    }
  };
  assertCurrent();
  if (playback.commit) {
    return playback.commit;
  }
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  playback.commit = appendOwnedRelayVoiceTranscript(
    {
      agentId,
      sessionKey,
      sessionTarget: { sessionKey: canonicalKey, storePath },
      voiceSessionId: session.id,
      text: playback.text,
      ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
    },
    {
      consultRunId: playback.runId,
      terminalMessageId: playback.terminalMessageId,
      playbackId: playback.markName,
      assertCurrent,
    },
  )
    .then(() => {
      playback.state = "completed";
      session.harness.talk.endTurn({ turnId: playback.turnId, payload: { reason: "completed" } });
    })
    .catch((error) => {
      playback.commit = undefined;
      throw error;
    });
  return playback.commit;
}
