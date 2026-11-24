import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeOwnedTalkPlayback,
  cancelOwnedTalkPlayback,
  deliverOwnedTalkResult,
} from "./owned-output.js";
import { relaySessions, type OwnedTalkFinal, type RelaySession } from "./state.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  prepare: vi.fn(),
  history: vi.fn(),
  speech: vi.fn(),
  pcm: vi.fn(),
}));
vi.mock("../../../talk/client-voice-session.js", () => ({
  appendOwnedRelayVoiceTranscript: mocks.append,
}));
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: mocks.prepare,
}));
vi.mock("../../session-transcript-readers.js", () => ({
  readRecentSessionMessagesWithStatsAsync: mocks.history,
}));
vi.mock("../../../tts/tts-synthesis.js", () => ({ synthesizeTalkSpeech: mocks.speech }));
vi.mock("../../../media/audio-transcode.js", () => ({ transcodeAudioBufferToTalkPcm: mocks.pcm }));

function fixture() {
  mocks.prepare.mockImplementation(async (_target, assertCurrent, consume) => {
    assertCurrent();
    return consume({ ok: true, value: { sessionId: "session-one" } });
  });
  mocks.history.mockResolvedValue({
    messages: [
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Synthetic accepted result" }],
        __openclaw: { id: "terminal-one", runId: "run-one" },
      },
    ],
  });
  mocks.speech.mockResolvedValue({ success: true, audioBuffer: Buffer.from([1]) });
  mocks.pcm.mockResolvedValue(Buffer.alloc(960, 1));
  mocks.append.mockImplementation(async (_target, owned) => owned.assertCurrent());
  const broadcastToConnIds = vi.fn();
  const key = "agent:jessica:talk-owned";
  const session = {
    id: "voice-one",
    connId: "owner-socket",
    toolResultEpoch: 0,
    ownedOutput: { retiredMarks: new Set() },
    context: { getRuntimeConfig: () => ({}), broadcastToConnIds, logGateway: { warn: vi.fn() } },
    sessionTarget: { agentId: "jessica", canonicalKey: key, sessionKey: key, assertCurrent() {} },
    harness: { talk: { emit: (event: unknown) => event, endTurn: vi.fn() } },
  } as unknown as RelaySession;
  relaySessions.set(session.id, session);
  const final = {
    runId: "run-one",
    sessionId: "session-one",
    physicalSource: { assertCurrent() {}, options: { env: {} } },
  } as OwnedTalkFinal;
  return { session, broadcastToConnIds, final };
}

afterEach(() => {
  relaySessions.clear();
  vi.resetAllMocks();
});

describe("owned Talk output", () => {
  it("reads an exact durable final, plays to the owning connection, and appends once on acknowledgement", async () => {
    const { session, broadcastToConnIds, final } = fixture();
    deliverOwnedTalkResult(session, final, "turn-one");
    await vi.waitFor(() => expect(session.ownedOutput?.playback?.phase).toBe("awaiting"));
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.speech).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Synthetic accepted result" }),
    );
    expect(broadcastToConnIds.mock.calls.map((call) => call[1].type)).toEqual([
      "audio",
      "audioDone",
      "mark",
    ]);
    expect(
      broadcastToConnIds.mock.calls.every(
        (call) => call[2].size === 1 && call[2].has("owner-socket"),
      ),
    ).toBe(true);
    const mark = session.ownedOutput!.playback!.markName;
    await expect(acknowledgeOwnedTalkPlayback(session, mark)).rejects.toThrow(/explicit outcome/);
    await expect(
      acknowledgeOwnedTalkPlayback(session, `${mark}-stale`, "completed"),
    ).rejects.toThrow(/no longer current/);
    await Promise.all([
      acknowledgeOwnedTalkPlayback(session, mark, "completed"),
      acknowledgeOwnedTalkPlayback(session, mark, "completed"),
    ]);
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(mocks.append.mock.calls[0][1]).toMatchObject({
      consultRunId: "run-one",
      terminalMessageId: "terminal-one",
      playbackId: mark,
    });
  });

  it.each(["cancelled", "failed"] as const)(
    "keeps the durable final when playback is %s",
    async (outcome) => {
      const { session, final } = fixture();
      deliverOwnedTalkResult(session, final, "turn-one");
      await vi.waitFor(() => expect(session.ownedOutput?.playback?.phase).toBe("awaiting"));
      const mark = session.ownedOutput!.playback!.markName;
      await acknowledgeOwnedTalkPlayback(session, mark, outcome);
      await expect(acknowledgeOwnedTalkPlayback(session, mark, "completed")).resolves.toBe(true);
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );

  it("cannot commit after the relay retires its exact turn", async () => {
    const { session, final } = fixture();
    deliverOwnedTalkResult(session, final, "turn-one");
    await vi.waitFor(() => expect(session.ownedOutput?.playback?.phase).toBe("awaiting"));
    const mark = session.ownedOutput!.playback!.markName;
    cancelOwnedTalkPlayback(session, "another-turn");
    expect(session.ownedOutput!.playback!.phase).toBe("awaiting");
    session.toolResultEpoch++;
    await expect(acknowledgeOwnedTalkPlayback(session, mark, "completed")).rejects.toThrow(
      /current call/,
    );
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("does not read or speak a same-run final after the prepared session incarnation changes", async () => {
    const { session, broadcastToConnIds, final } = fixture();
    deliverOwnedTalkResult(session, { ...final, sessionId: "previous-session" }, "turn-one");
    await vi.waitFor(() => expect(session.ownedOutput?.playback?.phase).toBe("failed"));
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.speech).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(broadcastToConnIds.mock.calls.map((call) => call[1].type)).toEqual(["clear"]);
  });

  it("accepts a retired mark without disturbing the newer turn or appending", async () => {
    const { session, final } = fixture();
    deliverOwnedTalkResult(session, final, "first");
    await vi.waitFor(() => expect(session.ownedOutput?.playback?.phase).toBe("awaiting"));
    const mark = session.ownedOutput!.playback!.markName;
    cancelOwnedTalkPlayback(session, "first");
    deliverOwnedTalkResult(session, { ...final, runId: "run-two" }, "second");
    await expect(acknowledgeOwnedTalkPlayback(session, mark, "completed")).resolves.toBe(true);
    expect(session.ownedOutput!.playback!.turnId).toBe("second");
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
