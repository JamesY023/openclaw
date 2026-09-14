import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

describe("owned Talk playback replacement", () => {
  const final = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Full answer" }],
    __openclaw: { id: "final-a", seq: 2, runId: "run-a" },
  };
  const spoken = {
    role: "assistant",
    stopReason: "stop",
    api: "realtime",
    model: "realtime-voice",
    content: [{ type: "text", text: "Spoken answer" }],
    provenance: { kind: "realtime_voice", sourceChannel: "talk" },
    __openclaw: {
      id: "voice-owned:final-a",
      seq: 4,
      replacesRunId: "run-a",
      replacesMessageId: "final-a",
      voiceSessionId: "voice-a",
      playbackId: "playback-a",
    },
  };

  it("hides only the causally replaced final while preserving raw history", () => {
    const other = { ...final, __openclaw: { id: "final-b", seq: 3, runId: "run-b" } };
    const raw = [final, other, spoken];
    const original = structuredClone(raw);
    expect(projectChatDisplayMessages([final, other])).toHaveLength(2);
    expect(projectChatDisplayMessages(raw).map(readChatHistoryMessageId)).toEqual([
      "final-b",
      "voice-owned:final-a",
    ]);
    expect(raw).toEqual(original);
  });

  it.each([
    {
      name: "client entry ID",
      patch: { __openclaw: { ...spoken["__openclaw"], id: "voice:client:voice-owned:final-a" } },
    },
    {
      name: "wrong run",
      patch: { __openclaw: { ...spoken["__openclaw"], replacesRunId: "run-other" } },
    },
    { name: "missing native provenance", patch: { provenance: undefined } },
    { name: "user metadata", patch: { role: "user" } },
  ])("retains the fallback for $name", ({ patch }) => {
    expect(
      projectChatDisplayMessages([final, { ...spoken, ...patch }]).some(
        (row) => readChatHistoryMessageId(row) === "final-a",
      ),
    ).toBe(true);
  });
});
