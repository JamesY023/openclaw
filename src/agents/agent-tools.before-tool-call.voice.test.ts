import { expect, it, vi } from "vitest";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";

vi.mock("../talk/client-voice-session.js", () => ({
  resolveClientVoiceRunBinding: (runId?: string) =>
    runId === "active-talk"
      ? { agentId: "jessica", voiceSessionId: "voice-session", sessionKey: "agent:jessica:voice" }
      : undefined,
}));

it("refuses non-owner high-impact Jessica Talk actions even with a model confirmation", async () => {
  const config = {
    plugins: { entries: { "skynet-jessica": { config: { ownerProfileId: "owner-profile" } } } },
  };
  const call = {
    toolName: "sms_send",
    params: { text: "Synthetic confirmation fixture", confirmationId: "model-supplied" },
    ctx: {
      agentId: "jessica",
      sessionKey: "agent:jessica:voice",
      sessionId: "session",
      runId: "active-talk",
      config,
      requester: { channel: "webchat", senderId: "other-profile", senderIsOwner: true },
    },
  };
  await expect(runBeforeToolCallHook(call)).resolves.toMatchObject({
    blocked: true,
    reason: expect.stringContaining("authenticated owner"),
  });
});
