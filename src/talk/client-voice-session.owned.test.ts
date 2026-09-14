import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  replaceSessionEntry,
  loadSessionEntryReadOnly,
  readSessionTranscriptMessageEvents,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  appendOwnedRelayVoiceTranscript,
  appendRelayVoiceTranscript,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

type AppendTranscriptMessage =
  (typeof import("../config/sessions/session-accessor.js"))["appendTranscriptMessage"];

const sessionAccessorMocks = vi.hoisted(() => ({
  actualAppendTranscriptMessage: undefined as AppendTranscriptMessage | undefined,
  appendTranscriptMessage: vi.fn<AppendTranscriptMessage>(),
}));
const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return { ...actual, appendTranscriptMessage: sessionAccessorMocks.appendTranscriptMessage };
});
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: sendDurableMessageBatch,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

async function seedSession(sessionKey: string, context: DeliveryContext = {}): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.replaceAll(":", "-")}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context }),
    },
  );
}

describe("owned client voice transcript", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(tempDirs.make("openclaw-owned-voice-session-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sessionAccessorMocks.appendTranscriptMessage.mockReset();
    // Resolve the real append here rather than capturing it inside the mock factory:
    // Vitest runs that factory on first import of the mocked module, so on a warm
    // module graph it can still be unrun when this hook fires.
    const { appendTranscriptMessage } = await vi.importActual<
      typeof import("../config/sessions/session-accessor.js")
    >("../config/sessions/session-accessor.js");
    sessionAccessorMocks.actualAppendTranscriptMessage = appendTranscriptMessage;
    sessionAccessorMocks.appendTranscriptMessage.mockImplementation(appendTranscriptMessage);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it.each([
    "success",
    "retry",
    "queued abort",
    "wrong run",
    "truncation",
    "client forgery",
    "media",
  ] as const)("persists owned playback safely for %s", async (scenario) => {
    const sessionKey = "agent:main:main";
    await seedSession(sessionKey);
    const entry = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    if (!entry?.sessionId) {
      throw new Error("Missing fixture session");
    }
    const scope = { agentId: "main", sessionKey, sessionId: entry.sessionId };
    const original = {
      role: "assistant",
      stopReason: "stop",
      content:
        scenario === "media"
          ? [
              { type: "text", text: "Full answer" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ]
          : [{ type: "text", text: "Full answer" }],
      __openclaw: { runId: "run-owned" },
    };
    await sessionAccessorMocks.actualAppendTranscriptMessage!(scope, {
      eventId: "final-owned",
      message: original,
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: scenario === "client forgery" ? "client" : "relay",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      runId: "run-owned",
    });
    let current = true;
    const owned = {
      consultRunId: scenario === "wrong run" ? "other-run" : "run-owned",
      terminalMessageId: "final-owned",
      playbackId: "playback-owned",
      assertCurrent: () => {
        if (!current) {
          throw new Error("playback retired");
        }
      },
    };
    const params = {
      agentId: "main",
      sessionKey,
      sessionTarget: { sessionKey },
      voiceSessionId,
      text: scenario === "truncation" ? "x".repeat(8001) : "Full answer",
    };
    if (scenario === "client forgery") {
      const forged = {
        ...params,
        entryId: "voice-owned:final-owned",
        role: "assistant" as const,
        __openclaw: { replacesRunId: "run-owned", replacesMessageId: "final-owned" },
        owned,
      };
      await appendClientVoiceTranscript(forged);
    } else if (scenario === "queued abort") {
      const started = createDeferred();
      const resume = createDeferred();
      sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async (...args) => {
        started.resolve();
        await resume.promise;
        return sessionAccessorMocks.actualAppendTranscriptMessage!(...args);
      });
      const pending = appendOwnedRelayVoiceTranscript(params, owned);
      await started.promise;
      current = false;
      resume.resolve();
      await expect(pending).rejects.toThrow("playback retired");
    } else if (scenario === "wrong run" || scenario === "truncation" || scenario === "media") {
      await expect(appendOwnedRelayVoiceTranscript(params, owned)).rejects.toThrow();
    } else {
      if (scenario === "retry") {
        sessionAccessorMocks.appendTranscriptMessage.mockRejectedValueOnce(
          new Error("append failed"),
        );
        await expect(appendOwnedRelayVoiceTranscript(params, owned)).rejects.toThrow(
          "append failed",
        );
        expect(readSessionTranscriptMessageEvents(scope)).toHaveLength(1);
      }
      await appendOwnedRelayVoiceTranscript(params, owned);
      await appendOwnedRelayVoiceTranscript(params, owned);
    }
    const rows = readSessionTranscriptMessageEvents(scope);
    expect(rows[0]?.event.message).toEqual(original);
    if (scenario === "success" || scenario === "retry") {
      expect(rows).toHaveLength(2);
      expect(rows[1]?.event).toMatchObject({
        id: "voice-owned:final-owned",
        message: {
          __openclaw: {
            replacesRunId: "run-owned",
            replacesMessageId: "final-owned",
            voiceSessionId,
            playbackId: "playback-owned",
          },
        },
      });
    } else if (scenario === "client forgery") {
      expect(rows).toHaveLength(2);
      expect(rows[1]?.event.message).not.toHaveProperty("__openclaw.replacesRunId");
    } else {
      expect(rows).toHaveLength(1);
    }
  });

  it.each(["media", "retired"])(
    "keeps speech writable after rejected %s replacements",
    async (reason) => {
      const sessionKey = "agent:main:main";
      await seedSession(sessionKey);
      const sessionId = loadSessionEntryReadOnly({ agentId: "main", sessionKey })!.sessionId;
      const scope = { agentId: "main", sessionKey, sessionId };
      const voiceSessionId = createOrResumeClientVoiceSession({ ...scope, origin: "relay" });
      registerClientVoiceConsultRun({ ...scope, voiceSessionId, runId: "run-owned" });
      const params = { ...scope, sessionTarget: { sessionKey }, voiceSessionId, text: "Answer" };
      for (let index = 0; index < VOICE_TRANSCRIPT_MAX_UNRESOLVED; index += 1) {
        const terminalMessageId = `final-${index}`;
        await sessionAccessorMocks.actualAppendTranscriptMessage!(scope, {
          eventId: terminalMessageId,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
            __openclaw: { runId: "run-owned" },
          },
        });
        await expect(
          appendOwnedRelayVoiceTranscript(params, {
            consultRunId: "run-owned",
            terminalMessageId,
            playbackId: `playback-${index}`,
            assertCurrent: () => {
              if (reason === "retired") {
                throw new Error("playback retired");
              }
            },
          }),
        ).rejects.toThrow(reason === "media" ? "original media" : "playback retired");
      }
      await appendRelayVoiceTranscript({
        ...params,
        role: "user",
        entryId: "next-utterance",
        text: "Next question",
      });
      const rows = readSessionTranscriptMessageEvents(scope);
      expect(rows).toHaveLength(VOICE_TRANSCRIPT_MAX_UNRESOLVED + 1);
      expect(rows.at(-1)?.event.message).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Next question" }],
      });
    },
  );
});
