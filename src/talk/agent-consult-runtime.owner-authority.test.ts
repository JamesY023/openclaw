import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let testTempDir: string;

describe("Talk consult owner authority", () => {
  beforeEach(() => {
    testTempDir = tempDirs.make("openclaw-talk-consult-owner-");
    setTestEnvValue("OPENCLAW_STATE_DIR", testTempDir);
  });

  afterEach(() => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it.each(["reply", "attempt"] as const)(
    "preserves verified Talk owner exemption through %s control authority",
    async (source) => {
      const { prepareTalkClientControlAuthority } =
        await import("../gateway/talk-client-agent-consult.js");
      const { resolveTalkAgentConsultAuthority } =
        await import("../gateway/talk-client-gateway-control.js");
      const { runBeforeToolCallHook } = await import("../agents/agent-tools.before-tool-call.js");
      const { consumeFinalClientVoiceToolConfirmation } =
        await import("../agents/agent-tools.before-tool-call.policy.js");
      const config = {
        commands: { ownerAllowFrom: ["owner-profile"] },
        plugins: { entries: { "skynet-jessica": { config: { ownerProfileId: "owner-profile" } } } },
      };
      const cases = [
        { name: "owner", profile: "owner-profile", verified: true, allowed: true },
        { name: "other", profile: "other-profile", verified: true, allowed: false },
        { name: "fallback", profile: "owner-profile", verified: false, allowed: false },
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
      ];
      for (const candidate of cases) {
        const sessionKey = `agent:jessica:${candidate.delegated ? "subagent:" : ""}${source}-${candidate.name}`;
        const sessionEntry = {
          sessionId: candidate.name,
          delivery: { context: { channel: "telegram", to: "123", accountId: "default" } },
        };
        const client = {
          authenticatedUserId: candidate.verified ? "owner@example.test" : undefined,
          authenticatedUserProfile: {
            profileId: candidate.profile,
            displayName: "Fixture",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui" as const,
              mode: "webchat" as const,
              version: "test",
              platform: "test",
            },
            role: "operator" as const,
            scopes: ["operator.admin"],
          },
          ...(candidate.synthetic ? { internal: { syntheticClient: true as const } } : {}),
        };
        const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
        const overlay = prepareTalkClientControlAuthority({
          config,
          agentRuntime: {
            resolveAgentDir: () => path.join(testTempDir, "agent"),
            resolveAgentWorkspaceDir: () => path.join(testTempDir, "workspace"),
            session: { getSessionEntry: () => sessionEntry },
          } as never,
          source,
          authority,
          sessionTarget: {
            agentId: "jessica",
            sessionKey,
            canonicalKey: sessionKey,
            storePath: path.join(testTempDir, "sessions.json"),
          },
        });
        if (candidate.allowed) {
          expect(overlay.messageProvider).toBe("webchat");
          expect(overlay.senderId).toBe("owner-profile");
          expect(overlay.senderIsOwner).toBe(true);
        }
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId: "jessica",
          sessionKey,
          origin: "client",
          transcriptCapable: true,
        });
        const runId = `${source}-${candidate.name}`;
        registerClientVoiceConsultRun({ agentId: "jessica", sessionKey, voiceSessionId, runId });
        const ctx = {
          agentId: "jessica",
          sessionKey,
          runId,
          config,
          requester: {
            channel: overlay.messageProvider,
            senderId: overlay.senderId,
            senderIsOwner: overlay.senderIsOwner,
          },
        };
        const action = {
          toolName: "message",
          params: { action: "send", message: "Synthetic", ownerAuthorized: true },
          ctx,
        };
        const before = await runBeforeToolCallHook(action);
        expect(before.blocked, candidate.name).toBe(!candidate.allowed);
        expect(consumeFinalClientVoiceToolConfirmation(action).allowed, candidate.name).toBe(
          candidate.allowed,
        );
      }
    },
  );
});
