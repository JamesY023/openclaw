import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import { seedSession } from "./client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  appendOwnedRelayVoiceTranscript,
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const { useClientVoiceSessionHarness } = await vi.hoisted(
  () => import("./client-voice-session.harness.test-support.js"),
);

describe("completed relay playback", () => {
  const { sessionTurnMocks } = useClientVoiceSessionHarness();
  const target = { agentId: "main", sessionKey: "agent:main:main" };
  const scope = { ...target, sessionId: "session-agent-main-main" };
  const ids = {
    consultRunId: "spoken-consult",
    terminalMessageId: "final-event",
    playbackId: "playback",
    sessionId: scope.sessionId,
  };
  const owned = { ...ids, assertCurrent() {} };

  function readEvents() {
    return readSessionTranscriptMessageEvents(scope).map(({ event }) => {
      if (!isRecord(event)) throw new Error("Missing transcript message event");
      return event;
    });
  }

  async function fixture(
    options: {
      origin?: "relay" | "client";
      runId?: string;
      media?: boolean;
      oversized?: boolean;
      stopReason?: string;
    } = {},
  ) {
    await seedSession(target.sessionKey);
    const original = {
      role: "assistant",
      stopReason: options.stopReason ?? "stop",
      content: [
        { type: "text", text: options.oversized ? "x".repeat(8001) : "Full answer" },
        ...(options.media ? [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] : []),
      ],
      __openclaw: { runId: options.runId ?? ids.consultRunId },
    };
    await appendTranscriptMessage(scope, { eventId: ids.terminalMessageId, message: original });
    const voiceSessionId = await createOrResumeClientVoiceSession({
      ...target,
      origin: options.origin ?? "relay",
    });
    await registerClientVoiceConsultRun({ ...target, voiceSessionId, runId: ids.consultRunId });
    return {
      original,
      params: {
        ...target,
        sessionTarget: { sessionKey: target.sessionKey },
        voiceSessionId,
        text: "Full answer",
      },
    };
  }

  it("keeps the original and commits one causal replacement across playback retries", async () => {
    const { original, params } = await fixture();
    for (let retry = 0; retry < 2; retry++) {
      await appendOwnedRelayVoiceTranscript(params, owned);
    }
    const rows = readEvents();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.message).toEqual(original);
    expect(rows[1]).toMatchObject({
      id: "voice-owned:final-event",
      message: {
        __openclaw: {
          replacesRunId: ids.consultRunId,
          replacesMessageId: ids.terminalMessageId,
          playbackId: ids.playbackId,
          voiceSessionId: params.voiceSessionId,
        },
      },
    });
  });

  it("refuses an acknowledged final transplanted into the successor transcript", async () => {
    const { original, params } = await fixture();
    const successor = { ...scope, sessionId: "successor-session" };
    await replaceSessionEntry(target, { sessionId: successor.sessionId, updatedAt: Date.now() });
    await appendTranscriptMessage(successor, { eventId: ids.terminalMessageId, message: original });
    await expect(appendOwnedRelayVoiceTranscript(params, owned)).rejects.toThrow(
      /consult incarnation/,
    );
    expect(readSessionTranscriptMessageEvents(successor).map(({ event }) => event)).toHaveLength(1);
    expect(readEvents().map((event) => event.message)).toEqual([original]);
  });

  it.each([
    ["wrong terminal run", { runId: "other" }, owned, "exact terminal"],
    ["no accepted consult", {}, { ...owned, consultRunId: "other" }, "consult session"],
    ["wrong terminal event", {}, { ...owned, terminalMessageId: "other" }, "exact terminal"],
    ["failed answer", { stopReason: "error" }, owned, "exact terminal"],
    ["cancelled answer", { stopReason: "aborted" }, owned, "exact terminal"],
    ["assistant media", { media: true }, owned, "original media"],
    ["oversized original", { oversized: true }, owned, "truncate"],
    ["client-owned call", { origin: "client" }, owned, "consult session"],
  ] as const)(
    "retains the original for %s without poisoning ordinary writes",
    async (_label, options, playback, reason) => {
      const { original, params } = await fixture(options);
      await expect(appendOwnedRelayVoiceTranscript(params, playback)).rejects.toThrow(reason);
      expect(readEvents().map((event) => event.message)).toEqual([original]);
      expect(
        clientVoiceSessionTesting.readRecord(params.agentId, params.voiceSessionId)
          ?.transcriptFailureKeys,
      ).toEqual([]);
    },
  );

  it("rechecks the playback owner after enqueue and refuses closed calls", async () => {
    const { original, params } = await fixture();
    let current = true;
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce((...args) => {
      current = false;
      return sessionTurnMocks.actualAppendSessionTranscriptTurn!(...args);
    });
    await expect(
      appendOwnedRelayVoiceTranscript(params, {
        ...owned,
        assertCurrent() {
          if (!current) throw new Error("playback retired");
        },
      }),
    ).rejects.toThrow("playback retired");
    await closeRelayVoiceSessionRecord({ ...params, config: {} });
    await expect(appendOwnedRelayVoiceTranscript(params, owned)).rejects.toThrow("consult session");
    expect(readEvents().map((event) => event.message)).toEqual([original]);
  });

  it("cannot mint a causal replacement through a client or provider transcript", async () => {
    const { params } = await fixture({ origin: "client" });
    const forged = {
      ...params,
      role: "assistant" as const,
      entryId: "voice-owned:final-event",
      owned,
      __openclaw: { replacesMessageId: ids.terminalMessageId },
    };
    await appendClientVoiceTranscript(forged);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "relay" });
    await appendRelayVoiceTranscript({ ...forged, voiceSessionId, providerOwned: true });
    const rows = readEvents();
    expect(rows).toHaveLength(3);
    expect(rows[1]?.message).not.toHaveProperty("__openclaw.replacesMessageId");
    expect(rows[2]?.message).toMatchObject({
      __openclaw: { voiceTranscript: "provider-owned" },
    });
    expect(rows[2]?.message).not.toHaveProperty("__openclaw.replacesMessageId");
  });

  it("retains the raw answer when the append cannot use its commit worker", async () => {
    const { original, params } = await fixture();
    sessionTurnMocks.appendExpectedSessionTranscriptTurn.mockImplementationOnce((scope, options) =>
      sessionTurnMocks.actualAppendSessionTranscriptTurn!(scope, {
        ...options,
        ownerSource: { nativeSource: true, assertCurrent() {}, checks: [] },
      }),
    );
    await expect(appendOwnedRelayVoiceTranscript(params, owned)).rejects.toThrow(
      "durable voice commit worker",
    );
    expect(readEvents().map((event) => event.message)).toEqual([original]);
  });

  it("refuses a mismatched transcript target and a truncated playback before writing", async () => {
    const { original, params } = await fixture();
    await expect(
      appendOwnedRelayVoiceTranscript(
        { ...params, sessionTarget: { sessionKey: "agent:main:other" } },
        owned,
      ),
    ).rejects.toThrow("another agent session");
    await expect(
      appendOwnedRelayVoiceTranscript({ ...params, text: "x".repeat(8001) }, owned),
    ).rejects.toThrow("full bounded answer");
    expect(readEvents().map((event) => event.message)).toEqual([original]);
  });
});
