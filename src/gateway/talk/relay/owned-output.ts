import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isIntermediateAssistantTranscriptMessage } from "../../../agents/embedded-agent-runner/message-visibility.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { transcodeAudioBufferToTalkPcm } from "../../../media/audio-transcode.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../../sessions/transcript-events.js";
import { appendOwnedRelayVoiceTranscript } from "../../../talk/client-voice-session.js";
import { synthesizeTalkSpeech } from "../../../tts/tts-synthesis.js";
import {
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
} from "../../chat-display-projection.helpers.js";
import { readRecentSessionMessagesWithStatsAsync } from "../../session-transcript-readers.js";
import {
  broadcastToOwner,
  relaySessions,
  type OwnedTalkFinal,
  type OwnedTalkPlayback,
  type RelaySession,
} from "./state.js";

const OWNED_MARK_PREFIX = "owned-talk:";
export type OwnedTalkPlaybackOutcome = "completed" | "cancelled" | "failed";

function assertCurrentPlayback(session: RelaySession, playback: OwnedTalkPlayback): void {
  playback.controller.signal.throwIfAborted();
  if (
    relaySessions.get(session.id) !== session ||
    session.closing ||
    session.ownedOutput?.playback !== playback ||
    session.toolResultEpoch !== playback.epoch
  ) {
    throw new Error("Owned Talk playback no longer belongs to the current call");
  }
  session.runAuthority?.assertCurrent();
  playback.final.physicalSource.assertCurrent();
  session.sessionTarget.assertCurrent(session.context.getRuntimeConfig());
}

export function cancelOwnedTalkPlayback(session: RelaySession, turnId?: string): void {
  const playback = session.ownedOutput?.playback;
  if (
    !playback ||
    (turnId !== undefined && playback.turnId !== turnId) ||
    playback.phase === "completed" ||
    playback.controller.signal.aborted
  ) {
    return;
  }
  playback.phase = "cancelled";
  playback.controller.abort(new Error("Owned Talk playback cancelled"));
  broadcastToOwner(
    session,
    { type: "clear" },
    {
      type: "turn.cancelled",
      turnId: playback.turnId,
      payload: { reason: "output-cancelled" },
      final: true,
    },
  );
}

/** Speak only a persisted terminal answer from the consult the current call accepted. */
export function deliverOwnedTalkResult(
  session: RelaySession,
  final: OwnedTalkFinal,
  turnId: string,
): void {
  const output = session.ownedOutput;
  const { runId, sessionId, lifecycleRevision } = final;
  if (!output || output.playback?.final.runId === runId) {
    return;
  }
  cancelOwnedTalkPlayback(session);
  if (output.playback) {
    output.retiredMarks.add(output.playback.markName);
  }
  const playback: OwnedTalkPlayback = {
    turnId,
    final,
    epoch: session.toolResultEpoch,
    phase: "preparing",
    markName: `${OWNED_MARK_PREFIX}${randomUUID()}`,
    controller: new AbortController(),
  };
  output.playback = playback;
  const assertCurrent = () => assertCurrentPlayback(session, playback);
  const { agentId, canonicalKey: sessionKey, storePath } = session.sessionTarget;
  const target = { agentId, sessionKey, storePath, env: final.physicalSource.options.env };
  const assertIncarnation = () =>
    withSessionEntryReadOnlyInWorker(target, assertCurrent, async (read) => {
      if (!read.ok) throw read.error;
      if (
        read.value?.sessionId !== sessionId ||
        read.value.lifecycleRevision !== lifecycleRevision
      ) {
        throw new Error("Owned Talk answer belongs to a replaced session");
      }
    });
  void (async () => {
    await assertIncarnation();
    const page = await readRecentSessionMessagesWithStatsAsync(
      { ...target, sessionId },
      {
        maxBytes: 1024 * 1024,
        maxLines: 200,
        maxMessages: 200,
      },
    );
    assertCurrent();
    const terminal = page.messages.findLast((message) => {
      const row = asOptionalRecord(message);
      return (
        row?.stopReason === "stop" &&
        !isIntermediateAssistantTranscriptMessage(message) &&
        resolveTerminalAssistantTranscriptRunId(message, readSessionTranscriptRunId(message)) ===
          runId
      );
    });
    const message = asOptionalRecord(terminal);
    const messageId = asOptionalRecord(message?.__openclaw)?.id;
    const text = message && extractAssistantTextForSilentCheck(message)?.trim();
    if (
      !message ||
      !text ||
      text.length > 2000 ||
      typeof messageId !== "string" ||
      hasAssistantDisplayableNonTextContent(message) ||
      hasTranscriptMediaFacts(message)
    ) {
      throw new Error("Owned Talk cannot represent the durable answer as speech");
    }
    playback.terminal = { messageId, text };
    const speech = await synthesizeTalkSpeech({
      text,
      cfg: session.voiceConfig ?? session.context.getRuntimeConfig(),
      agentId,
      disableFallback: true,
      timeoutMs: 60_000,
    });
    assertCurrent();
    if (!speech.success || !speech.audioBuffer) throw new Error("Owned Talk synthesis failed");
    const pcm = await transcodeAudioBufferToTalkPcm({
      audioBuffer: speech.audioBuffer,
      inputExtension: speech.fileExtension,
    });
    await assertIncarnation();
    assertCurrent();
    playback.phase = "playing";
    for (let offset = 0; offset < pcm.length; offset += 960) {
      assertCurrent();
      const frame = pcm.subarray(offset, offset + 960);
      broadcastToOwner(
        session,
        { type: "audio", audioBase64: frame.toString("base64"), outputOwnership: "host" },
        {
          type: "output.audio.delta",
          turnId,
          payload: { byteLength: frame.length },
        },
      );
      await wait(20, undefined, { signal: playback.controller.signal });
    }
    assertCurrent();
    playback.phase = "awaiting";
    broadcastToOwner(
      session,
      { type: "audioDone", outputOwnership: "host" },
      { type: "output.audio.done", turnId, payload: {}, final: true },
    );
    broadcastToOwner(
      session,
      { type: "mark", markName: playback.markName },
      { type: "output.audio.done", turnId, payload: {}, final: true },
    );
  })().catch(() => {
    if (
      playback.controller.signal.aborted ||
      output.playback !== playback ||
      relaySessions.get(session.id) !== session
    )
      return;
    cancelOwnedTalkPlayback(session, turnId);
    playback.phase = "failed";
    session.context.logGateway.warn(
      "Owned Talk speech unavailable; the durable answer remains visible",
    );
  });
}

/** Consume only the owning relay's exact completed playback; all other outcomes preserve the text. */
export async function acknowledgeOwnedTalkPlayback(
  session: RelaySession,
  markName: string,
  outcome?: OwnedTalkPlaybackOutcome,
): Promise<boolean> {
  if (!markName.startsWith(OWNED_MARK_PREFIX)) return false;
  const output = session.ownedOutput;
  const playback = output?.playback;
  if (output?.retiredMarks.has(markName)) return true;
  if (!playback || playback.markName !== markName)
    throw new Error("Owned Talk playback mark is no longer current");
  if (!outcome) throw new Error("Owned Talk playback requires an explicit outcome");
  if (playback.phase === "completed") return true;
  if (playback.controller.signal.aborted) return true;
  if (outcome !== "completed") {
    cancelOwnedTalkPlayback(session, playback.turnId);
    playback.phase = outcome;
    return true;
  }
  assertCurrentPlayback(session, playback);
  if (playback.phase !== "awaiting" || !playback.terminal)
    throw new Error("Owned Talk playback has not completed");
  const { agentId, canonicalKey, sessionKey, storePath } = session.sessionTarget;
  const { messageId, text } = playback.terminal;
  playback.commit ??= appendOwnedRelayVoiceTranscript(
    {
      agentId,
      sessionKey,
      sessionTarget: { sessionKey: canonicalKey, storePath },
      voiceSessionId: session.id,
      text,
      config: session.voiceConfig,
      physicalSource: playback.final.physicalSource,
    },
    {
      consultRunId: playback.final.runId,
      terminalMessageId: messageId,
      playbackId: playback.markName,
      sessionId: playback.final.sessionId,
      lifecycleRevision: playback.final.lifecycleRevision,
      assertCurrent: () => assertCurrentPlayback(session, playback),
    },
  )
    .then(() => {
      playback.phase = "completed";
      session.harness.talk.endTurn({ turnId: playback.turnId, payload: { reason: "completed" } });
    })
    .catch((error: unknown) => {
      playback.commit = undefined;
      throw error;
    });
  await playback.commit;
  return true;
}
