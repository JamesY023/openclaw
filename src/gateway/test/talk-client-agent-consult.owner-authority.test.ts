import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import { consumeFinalClientVoiceToolConfirmation } from "../../agents/agent-tools.before-tool-call.policy.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createTalkClientAgentConsultRunner } from "../talk-client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "../talk-client-gateway-control.js";

const mocks = vi.hoisted(() => ({ runEmbeddedAgent: vi.fn() }));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let stateDir: string;

// Finding: missing initial Talk caller identity | high | talk-client-agent-consult.ts
// Keep the real runner, consult runtime, session store and confirmation policies;
// replace only model execution so this cannot send a message.
describe("initial Talk consult owner authority", () => {
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-talk-owner-ingress-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    mocks.runEmbeddedAgent.mockReset();
    mocks.runEmbeddedAgent.mockResolvedValue({ payloads: [{ text: "Done." }], meta: {} });
  });

  afterEach(() => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it.each([
    { name: "owner", profile: "owner-profile", verified: true, allowed: true },
    { name: "other admin", profile: "other-profile", verified: true, allowed: false },
    { name: "missing user", profile: "owner-profile", verified: false, allowed: false },
    { name: "missing profile", profile: undefined, verified: true, allowed: false },
    { name: "client name spoof", profile: undefined, verified: false, spoof: true, allowed: false },
    {
      name: "revoked non-UI owner",
      profile: "test",
      verified: true,
      spoof: true,
      revoked: true,
      allowed: false,
    },
    {
      name: "synthetic",
      profile: "owner-profile",
      verified: true,
      synthetic: true,
      allowed: false,
    },
    {
      name: "delegated",
      profile: "owner-profile",
      verified: true,
      delegated: true,
      allowed: false,
    },
  ])("applies current caller authority to the first $name run", async (candidate) => {
    // A valid protocol client ID can also be a configured profile ID; its
    // display metadata must never supply verified caller identity.
    const ownerProfileId = candidate.spoof ? "test" : "owner-profile";
    const config = {
      commands: { ownerAllowFrom: [ownerProfileId] },
      agents: { list: [{ id: "jessica", workspace: path.join(stateDir, "workspace") }] },
      plugins: { entries: { "skynet-jessica": { config: { ownerProfileId } } } },
    };
    const sessionKey = `agent:jessica:${candidate.delegated ? "subagent:" : ""}voice-test`;
    const runtime = createPluginRuntime().agent;
    const storePath = runtime.session.resolveStorePath(undefined, { agentId: "jessica" });
    await runtime.session.upsertSessionEntry({
      agentId: "jessica",
      storePath,
      sessionKey,
      entry: {
        sessionId: "fixture-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", to: "123", accountId: "default" },
        }),
      },
    });
    const client = {
      invalidated: false,
      authenticatedUserId: candidate.verified ? "owner@example.test" : undefined,
      authenticatedUserProfile: candidate.profile
        ? { profileId: candidate.profile, displayName: "Fixture", hasAvatar: false, updatedAt: 1 }
        : undefined,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: candidate.spoof ? ("test" as const) : ("openclaw-control-ui" as const),
          mode: candidate.spoof ? ("test" as const) : ("webchat" as const),
          version: "test",
          platform: "test",
        },
        role: "operator" as const,
        scopes: ["operator.admin"],
      },
      ...(candidate.synthetic ? { internal: { syntheticClient: true as const } } : {}),
    };
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "jessica",
      sessionKey,
      origin: "client",
      transcriptCapable: true,
    });
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    client.invalidated = candidate.revoked === true;
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
      sessionTarget: { agentId: "jessica", sessionKey, canonicalKey: sessionKey, storePath },
      authority,
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
      registerRun: ({ runId }) => {
        registerClientVoiceConsultRun({ agentId: "jessica", sessionKey, voiceSessionId, runId });
      },
    });
    await expect(runner.runPrompt({ prompt: "Send the synthetic summary." })).resolves.toEqual({
      text: "Done.",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    const run = mocks.runEmbeddedAgent.mock.calls[0]![0] as RunEmbeddedAgentParams;
    expect.soft(run.messageProvider).toBe("webchat");
    expect(run.messageTo).toBe("123");
    if (candidate.allowed) {
      expect.soft(run.senderId).toBe("owner-profile");
      expect(run.senderIsOwner).toBe(true);
    }
    const action = {
      toolName: "message",
      params: { action: "send", message: "Synthetic", ownerAuthorized: true },
      ctx: {
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        runId: run.runId,
        config,
        requester: {
          channel: run.messageProvider,
          senderId: run.senderId,
          senderIsOwner: run.senderIsOwner,
        },
      },
    };
    expect.soft((await runBeforeToolCallHook(action)).blocked).toBe(!candidate.allowed);
    expect.soft(consumeFinalClientVoiceToolConfirmation(action).allowed).toBe(candidate.allowed);
    for (const source of ["attempt", "reply"] as const) {
      const overlay = runner.getToolAuthorityOverlay(undefined, source);
      const controlAction = {
        ...action,
        ctx: {
          ...action.ctx,
          requester: {
            channel: overlay.messageProvider,
            senderId: overlay.senderId,
            senderIsOwner: overlay.senderIsOwner,
          },
        },
      };
      expect
        .soft((await runBeforeToolCallHook(controlAction)).blocked, source)
        .toBe(!candidate.allowed);
      expect
        .soft(consumeFinalClientVoiceToolConfirmation(controlAction).allowed, source)
        .toBe(candidate.allowed);
    }
  });
});
