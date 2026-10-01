import { describe, expect, it, vi } from "vitest";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { completeFollowupRunLifecycle, markFollowupRunEnqueued } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { createMockFollowupRun } from "./test-helpers.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";

describe("buildStrandedReplyRetryFollowupRun lifecycle ownership", () => {
  it("does not share the client turn's turnAdoptionLifecycle with the system retry", () => {
    const receipts: ReplyOperationRunState[] = [{ agentTurn: "ok" }];
    const onComplete = vi.fn();
    const onEnqueued = vi.fn(() => true);
    const parent = createMockFollowupRun({
      prompt: "user question",
      transcriptPrompt: "user question",
      turnAdoptionLifecycle: {
        onAdopted: async () => {},
        onSettled: onComplete,
        onDeferred: onEnqueued,
      },
      admissionSessionId: "sess-rotated",
      replyOperationRunStates: receipts,
    });

    const recovery = resolveStrandedReplyRecovery({
      base: parent,
      payloads: [],
      finalText:
        "A substantive stranded final must be re-delivered via message(action=send). It includes enough user-facing detail to require the one-shot recovery path.",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });
    expect(recovery.kind).toBe("retry");
    if (recovery.kind !== "retry") {
      throw new Error("expected retry recovery");
    }
    const retry = recovery.run;

    expect(retry.turnAdoptionLifecycle).toBeUndefined();
    expect(retry.replyOperationRunStates).toBeUndefined();
    expect(parent.replyOperationRunStates).toBe(receipts);
    expect(retry.strandedReplyRetry).toBe(true);
    expect(retry.summaryLine).toBe(STRANDED_REPLY_RETRY_MARKER);
    // Session routing stays; only the client-turn lifecycle identity is detached.
    expect(retry.admissionSessionId).toBe("sess-rotated");
    expect(retry.run.sessionKey).toBe(parent.run.sessionKey);

    // mark/complete no-op when lifecycle is absent (drop-policy onDrop path too).
    expect(markFollowupRunEnqueued(retry)).toBe(true);
    expect(onEnqueued).not.toHaveBeenCalled();
    completeFollowupRunLifecycle(retry);
    expect(onComplete).not.toHaveBeenCalled();

    // Parent still owns the one-shot lifecycle; retry completion must not steal it.
    expect(markFollowupRunEnqueued(parent)).toBe(true);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("resolveStrandedReplyRecovery", () => {
  const substantiveFinal =
    "This reply is substantive enough to look user-facing. It contains a second sentence so the private-final policy treats it as stranded output.";

  it.each([
    { payload: { text: "The recovered answer is ready." }, expected: "none" },
    {
      payload: { text: "The fallback model is active.", isFallbackNotice: true },
      expected: "retry",
    },
  ])(
    "distinguishes a pending terminal answer from a notice: $expected",
    ({ payload, expected }) => {
      const recovery = resolveStrandedReplyRecovery({
        base: createMockFollowupRun({ prompt: "question" }),
        payloads: [markReplyPayloadForSourceSuppressionDelivery(payload)],
        finalText: substantiveFinal,
        sourceReplyDeliveryMode: "message_tool_only",
        sendPolicyDenied: false,
        successfulSourceReplyDelivery: false,
        isHeartbeat: false,
        isRoomEvent: false,
      });

      expect(recovery.kind).toBe(expected);
    },
  );

  it("creates one priority retry for a substantive private final", () => {
    const base = createMockFollowupRun({ prompt: "question" });

    const recovery = resolveStrandedReplyRecovery({
      base,
      payloads: [],
      finalText: substantiveFinal,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery.kind).toBe("retry");
    if (recovery.kind === "retry") {
      expect(recovery.run.strandedReplyRetry).toBe(true);
      expect(recovery.run.disableCollectBatching).toBe(true);
      expect(recovery.run.prompt).toBe(
        `[System] Your previous reply was not delivered to the conversation because ` +
          `you did not call message(action=send). Your reply text was:\n\n` +
          `"${substantiveFinal}"\n\n` +
          `Please deliver this reply now by calling message(action=send). ` +
          `Do not add any extra commentary; just deliver the original reply.`,
      );
    }
  });

  it("creates the same retry for a substantive CJK private final", () => {
    // Full-width terminators carry no trailing whitespace, so a CJK reply of the
    // same shape used to score zero sentence terminators and skip recovery entirely.
    const base = createMockFollowupRun({ prompt: "question" });
    const substantiveCjkFinal =
      "近 7 日營收較前期增加 5.09%，已連續兩週回升。最大風險是集中：前五大站台占正營收 86.5%，已超過 85% 觀察門檻。" +
      "近 30 日最大單一產品占 44.2%，亦超過 40% 門檻。建議先維持成長節奏並優先降低集中風險，不建議只看總額就全面加碼。" +
      "成長主因仍待業務確認，我尚未取得該線的回覆。";

    const recovery = resolveStrandedReplyRecovery({
      base,
      payloads: [],
      finalText: substantiveCjkFinal,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery.kind).toBe("retry");
    if (recovery.kind === "retry") {
      expect(recovery.run.strandedReplyRetry).toBe(true);
      expect(recovery.run.disableCollectBatching).toBe(true);
      expect(recovery.run.prompt).toContain(substantiveCjkFinal);
      expect(recovery.run.prompt).toContain("message(action=send)");
    }
  });

  it("creates one retry for a short private final", () => {
    const shortFinal = "Cancelled the reminder.";
    const recovery = resolveStrandedReplyRecovery({
      base: createMockFollowupRun({ prompt: "question" }),
      payloads: [],
      finalText: shortFinal,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery.kind).toBe("retry");
    if (recovery.kind === "retry") {
      expect(recovery.run.strandedReplyRetry).toBe(true);
      expect(recovery.run.prompt).toContain(shortFinal);
    }
  });

  it("returns a diagnostic rather than a second retry", () => {
    const base = createMockFollowupRun({ prompt: "question", strandedReplyRetry: true });

    const recovery = resolveStrandedReplyRecovery({
      base,
      payloads: [],
      finalText: "Fulfilment IF98765 created.",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery).toMatchObject({ kind: "diagnostic", warn: false });
  });

  it("limits the retry turn to the message tool", () => {
    // Row "short after NS write" from the #6107 refute probe: the retry must only deliver.
    const recovery = resolveStrandedReplyRecovery({
      base: createMockFollowupRun({ prompt: "fulfil SO 4567" }),
      payloads: [],
      finalText: "Fulfilment IF98765 created for SO 4567.",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery.kind).toBe("retry");
    if (recovery.kind === "retry") {
      expect(recovery.run.toolsAllow).toEqual(["message"]);
    }
  });

  it.each([
    {
      label: "internal system",
      inputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
    },
    {
      label: "inter-session",
      inputProvenance: { kind: "inter_session" as const, sourceTool: "subagent_announce" },
    },
  ])("does not re-prompt a short final from a $label turn", ({ inputProvenance }) => {
    const recovery = resolveStrandedReplyRecovery({
      base: createMockFollowupRun({ prompt: "restart notice", run: { inputProvenance } }),
      payloads: [],
      finalText: "Resumed.",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery).toEqual({ kind: "none" });
  });

  it.each([
    "Acknowledgement could not be delivered due to a Telegram network error.",
    "I’ll mark the emails I reviewed as read.",
  ])("still re-prompts a short final from a person's message: %s", (finalText) => {
    // Real Jessica mute finals, 2026-09-09 (runs 30968208, 8ee22647).
    const recovery = resolveStrandedReplyRecovery({
      base: createMockFollowupRun({
        prompt: "question",
        run: { inputProvenance: { kind: "external_user" } },
      }),
      payloads: [],
      finalText,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery.kind).toBe("retry");
  });

  it("sends no notice when the retry turn chose silence with NO_REPLY", () => {
    const recovery = resolveStrandedReplyRecovery({
      base: createMockFollowupRun({ prompt: "question", strandedReplyRetry: true }),
      payloads: [],
      finalText: "NO_REPLY",
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
    });

    expect(recovery).toEqual({ kind: "none" });
  });

  it.each([
    { label: "room events", isRoomEvent: true },
    { label: "heartbeats", isHeartbeat: true },
    { label: "send-policy denial", sendPolicyDenied: true },
    { label: "completed delivery", successfulSourceReplyDelivery: true },
  ])("does not recover $label", (override) => {
    const base = createMockFollowupRun({ prompt: "question" });

    const recovery = resolveStrandedReplyRecovery({
      base,
      payloads: [],
      finalText: substantiveFinal,
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      successfulSourceReplyDelivery: false,
      isHeartbeat: false,
      isRoomEvent: false,
      ...override,
    });

    expect(recovery).toEqual({ kind: "none" });
  });
});
