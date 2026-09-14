import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  readSessionTranscriptMessageEvents,
} from "../config/sessions/session-accessor.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-readers.js";
import { relaySessions } from "./talk-realtime-relay-state.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./talk-realtime-relay.js";
import { prepareTalkSessionTarget } from "./talk-session-target.js";

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), decode: vi.fn() }));
vi.mock("../tts/tts-synthesis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tts/tts-synthesis.js")>()),
  synthesizeTalkSpeech: mocks.synthesize,
}));
vi.mock("../media/audio-transcode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/audio-transcode.js")>()),
  transcodeAudioBufferToTalkPcm: mocks.decode,
}));
let testState: OpenClawTestState;
const cfg = { agents: { entries: { main: { default: true } } } };
let target: ReturnType<typeof prepareTalkSessionTarget>;
let sessionId: string;
const sessions: string[] = [];

beforeEach(async () => {
  testState = await createOpenClawTestState({ label: "talk-owned-output", scenario: "minimal" });
  target = prepareTalkSessionTarget(cfg, "agent:main:main");
  sessionId = await ensureClientVoiceAgentSessionEntry({
    agentId: "main",
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  });
  mocks.synthesize.mockReset().mockResolvedValue({
    success: true,
    audioBuffer: Buffer.from("synthetic-wave"),
    fileExtension: "wav",
  });
  mocks.decode.mockReset().mockResolvedValue(Buffer.from([1, 0]));
});
afterEach(async () => {
  for (const id of sessions.splice(0)) {
    if (relaySessions.has(id)) {
      const relay = relaySessions.get(id)!;
      stopTalkRealtimeRelaySession({ relaySessionId: id, connId: "owner" });
      await relay.voiceSessionClose;
    }
  }
  await testState.cleanup();
});
function fixture(ownership: "host" | "provider" = "host") {
  let request!: RealtimeVoiceBridgeCreateRequest;
  const providerResult = vi.fn();
  const input = vi.fn(),
    close = vi.fn(),
    providerMark = vi.fn(),
    events: Record<string, any>[] = [];
  const result = createTalkRealtimeRelaySession({
    context: {
      broadcastToConnIds: (_event: string, value: Record<string, any>) => events.push(value),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => cfg,
      logGateway: { warn: vi.fn(), info: vi.fn() },
    } as never,
    connId: "owner",
    cfg,
    sessionTarget: target,
    providerConfig: {},
    instructions: "",
    tools: [],
    controlSource: "delegation",
    hostOwnedOutput: true,
    provider: {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (value) => {
        request = value;
        return {
          connect: async () => {
            request.onOutputOwnership?.(ownership);
            request.onReady?.();
          },
          sendAudio: input,
          setMediaTimestamp() {},
          submitToolResult: providerResult,
          acknowledgeMark: providerMark,
          close,
          isConnected: () => true,
        };
      },
    },
  });
  sessions.push(result.relaySessionId);
  return {
    id: result.relaySessionId,
    request,
    input,
    close,
    providerMark,
    providerResult,
    events,
    relay: () => relaySessions.get(result.relaySessionId)!,
    user: (id: string | undefined, text = "check") =>
      request.onTranscript?.("user", text, true, id ? { providerTurnId: id } : undefined),
    eventsOf: (type: string) => events.filter((event) => event.type === type),
  };
}
async function complete(f: ReturnType<typeof fixture>, runId: string, text = "orange lantern") {
  await vi.waitFor(() => expect(f.eventsOf("toolCall").length).toBeGreaterThan(0));
  const call = f.eventsOf("toolCall").at(-1)!;
  registerTalkRealtimeRelayAgentRun({
    relaySessionId: f.id,
    connId: "owner",
    sessionKey: target.canonicalKey,
    callId: call.callId,
    runId,
  });
  const original = await appendTranscriptMessage(
    { agentId: "main", sessionKey: target.canonicalKey, storePath: target.storePath, sessionId },
    {
      eventId: `final:${runId}`,
      message: attachSessionTranscriptRunId(
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
        runId,
      ),
    },
  );
  await submitTalkRealtimeRelayToolResult({
    relaySessionId: f.id,
    connId: "owner",
    callId: call.callId,
    result: { result: "UNTRUSTED CLIENT TEXT" },
  });
  return original;
}
const messages = () =>
  readSessionTranscriptMessageEvents({
    agentId: "main",
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
    sessionId,
  }).map(sqliteMessageEventWithSeq);

describe("host-owned Talk relay", () => {
  it("admits each identified user turn once and preserves identical later turns", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    expect(f.eventsOf("ready")[0].outputOwnership).toBe("host");
    f.user("A");
    f.user("A");
    f.user("B");
    await vi.waitFor(() => expect(f.eventsOf("toolCall")).toHaveLength(2));
    expect(new Set(f.eventsOf("toolCall").map((event) => event.callId)).size).toBe(2);
    expect(new Set(f.eventsOf("toolCall").map((event) => event.talkEvent.turnId)).size).toBe(2);
    expect(f.relay().ownedOutput?.inputTurns.size).toBe(2);
  });
  it("reports missing input identity without starting an agent request", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user(undefined);
    expect(f.eventsOf("toolCall")).toHaveLength(0);
    expect(f.eventsOf("error")[0].message).toContain("no valid provider identity");
    expect(f.eventsOf("transcript")).toHaveLength(1);
  });
  it("retains provider ownership and ordinary marks when authentication chooses provider", async () => {
    const f = fixture("provider");
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    expect(f.relay().ownedOutput).toBeUndefined();
    await acknowledgeTalkRealtimeRelayMark({
      relaySessionId: f.id,
      connId: "owner",
      markName: "ordinary",
    });
    expect(f.providerMark).toHaveBeenCalledExactlyOnceWith("ordinary");
  });
  it("plays only trusted durable text and requires completed outcome before replacement", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user("A");
    await complete(f, "run-A");
    await vi.waitFor(() => expect(f.eventsOf("mark")).toHaveLength(1));
    expect(mocks.synthesize.mock.calls[0][0].text).toBe("orange lantern");
    const mark = f.eventsOf("mark")[0];
    expect(f.eventsOf("audioDone")[0].talkEvent.turnId).toBe(mark.talkEvent.turnId);
    expect(f.eventsOf("audio")[0].talkEvent.turnId).toBe(mark.talkEvent.turnId);
    const before = messages();
    expect(() =>
      acknowledgeTalkRealtimeRelayMark({
        relaySessionId: f.id,
        connId: "owner",
        markName: mark.markName,
      }),
    ).toThrow("explicit outcome");
    expect(messages()).toEqual(before);
    await acknowledgeTalkRealtimeRelayMark({
      relaySessionId: f.id,
      connId: "owner",
      markName: mark.markName,
      outcome: "completed",
    });
    await acknowledgeTalkRealtimeRelayMark({
      relaySessionId: f.id,
      connId: "owner",
      markName: mark.markName,
      outcome: "completed",
    });
    expect(messages().length).toBe(before.length + 1);
    expect(
      projectChatDisplayMessages(messages()).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });
  it.each(["synthesis", "decoder", "long"])(
    "keeps complete fallback on %s failure",
    async (kind) => {
      const f = fixture();
      await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
      f.user("A");
      if (kind === "synthesis") {
        mocks.synthesize.mockRejectedValueOnce(new Error("unavailable"));
      }
      if (kind === "decoder") {
        mocks.decode.mockRejectedValueOnce(new Error("unavailable"));
      }
      const text = kind === "long" ? "full answer ".repeat(300) : "orange lantern";
      await complete(f, "run-A", text);
      if (kind !== "long") {
        await vi.waitFor(() =>
          expect([...f.relay().ownedOutput!.playbacks.values()][0]?.state).toBe("failed"),
        );
      }
      expect(f.eventsOf("audio")).toHaveLength(0);
      expect(f.eventsOf("mark")).toHaveLength(0);
      const visible = projectChatDisplayMessages(messages()).filter(
        (message) => message.role === "assistant",
      );
      expect(visible).toHaveLength(1);
      expect(JSON.stringify(visible)).toContain(text);
    },
  );
  it("keeps completed calls retired after the forced-consult handle expires", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user("A");
    await complete(f, "run-A");
    const callId = f.eventsOf("toolCall")[0].callId;
    await vi.waitFor(() => expect(f.relay().harness.forcedConsults.handles()).toHaveLength(0), {
      timeout: 3000,
    });
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: f.id,
      connId: "owner",
      callId,
      result: { result: "late client retry" },
    });
    expect(f.providerResult).not.toHaveBeenCalled();
    expect(f.relay().activeAgentToolCalls.has(callId)).toBe(false);
  });
  it("rejects a run that registers after its owned turn was cancelled", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user("A");
    await vi.waitFor(() => expect(f.eventsOf("toolCall")).toHaveLength(1));
    const call = f.eventsOf("toolCall")[0];
    await cancelTalkRealtimeRelayTurn({
      relaySessionId: f.id,
      connId: "owner",
      turnId: call.talkEvent.turnId,
    });
    expect(() =>
      registerTalkRealtimeRelayAgentRun({
        relaySessionId: f.id,
        connId: "owner",
        sessionKey: target.canonicalKey,
        callId: call.callId,
        runId: "late-run",
      }),
    ).toThrow();
    expect(f.relay().activeAgentRuns.has("late-run")).toBe(false);
  });
  it("invalidates an utterance when provider continuity resets", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user("A");
    await complete(f, "run-A");
    await vi.waitFor(() => expect(f.eventsOf("mark")).toHaveLength(1));
    const mark = f.eventsOf("mark")[0];
    f.request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    expect(() =>
      acknowledgeTalkRealtimeRelayMark({
        relaySessionId: f.id,
        connId: "owner",
        markName: mark.markName,
        outcome: "completed",
      }),
    ).toThrow();
    expect(
      projectChatDisplayMessages(messages()).filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
    expect(
      messages().some((message) => JSON.stringify(message).includes("replacesMessageId")),
    ).toBe(false);
  });
  it("cancels the utterance without closing or blocking microphone input", async () => {
    const f = fixture();
    await vi.waitFor(() => expect(f.eventsOf("ready")).toHaveLength(1));
    f.user("A");
    await complete(f, "run-A");
    await vi.waitFor(() => expect(f.eventsOf("mark")).toHaveLength(1));
    const mark = f.eventsOf("mark")[0];
    await cancelTalkRealtimeRelayTurn({
      relaySessionId: f.id,
      connId: "owner",
      turnId: mark.talkEvent.turnId,
    });
    sendTalkRealtimeRelayAudio({
      relaySessionId: f.id,
      connId: "owner",
      audioBase64: Buffer.from([1, 0]).toString("base64"),
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.input).toHaveBeenCalledTimes(1);
    expect(() =>
      acknowledgeTalkRealtimeRelayMark({
        relaySessionId: f.id,
        connId: "owner",
        markName: mark.markName,
        outcome: "completed",
      }),
    ).toThrow();
  });
});
