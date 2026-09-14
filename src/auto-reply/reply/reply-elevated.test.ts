// Tests elevated permission resolution from allowlists and message context.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChatSendCallerContext } from "../../gateway/server-methods/gateway-client-identity.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

function buildConfig(allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
        },
      },
    },
  } as OpenClawConfig;
}

function buildContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderId: "+15550001111",
    From: "whatsapp:+15550001111",
    SenderE164: "+15550001111",
    To: "+15559990000",
    ...overrides,
  } as MsgContext;
}

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: buildConfig(params.allowFrom),
    agentId: "main",
    provider: "whatsapp",
    ctx: buildContext(params.ctx),
  });

  expect(result.enabled).toBe(true);
  expect(result.allowed).toBe(params.allowed);
  if (params.allowed) {
    expect(result.failures).toHaveLength(0);
    return;
  }

  expect(result.failures).toEqual([
    {
      gate: "allowFrom",
      key: "tools.elevated.allowFrom.whatsapp",
    },
  ]);
}

describe("resolveElevatedPermissions", () => {
  it("authorizes when sender matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15550001111"],
      allowed: true,
    });
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15559990000"],
      allowed: false,
    });
  });

  it("does not authorize a group conversation id as a sender identity", () => {
    expectAllowFromDecision({
      allowFrom: ["120363411111111111@g.us", "from:120363411111111111@g.us"],
      allowed: false,
      ctx: {
        ChatType: "group",
        From: "120363411111111111@g.us",
        SenderId: "+15550002222",
        SenderE164: "+15550002222",
      },
    });
  });

  it("keeps direct chat From fallback authorization", () => {
    expectAllowFromDecision({
      allowFrom: ["from:whatsapp:+15550001111"],
      allowed: true,
      ctx: {
        ChatType: "direct",
        From: "whatsapp:+15550001111",
        SenderId: undefined,
        SenderE164: undefined,
      },
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    expectAllowFromDecision({
      allowFrom: ["owner-display-name"],
      allowed: false,
      ctx: {
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      },
    });
  });

  it("authorizes mutable sender fields only with explicit prefix", () => {
    expectAllowFromDecision({
      allowFrom: ["username:owner_username"],
      allowed: true,
      ctx: {
        SenderUsername: "owner_username",
      },
    });
  });
});

// Finding: authorization | high | src/auto-reply/reply/reply-elevated.ts:90
describe("Gateway elevated sender authority", () => {
  function client(): GatewayClient {
    return {
      authenticatedUserId: "owner@example.test",
      authenticatedUserProfile: {
        profileId: "gateway-owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.admin"],
      },
    };
  }
  const config: OpenClawConfig = {
    tools: { elevated: { enabled: true, allowFrom: { webchat: ["id:gateway-owner"] } } },
  };
  const resolve = (ctx: MsgContext, cfg = config) =>
    resolveElevatedPermissions({ cfg, agentId: "main", provider: "webchat", ctx });

  it("matches the live verified profile without restoring UI sender attribution", () => {
    const ctx = resolveChatSendCallerContext(client());
    expect(ctx).not.toHaveProperty("SenderId");
    expect(resolve({ ...ctx })).toEqual({ enabled: true, allowed: true, failures: [] });
  });

  it.each(["revoked", "aborted", "synthetic", "unverified", "other-profile"])(
    "rejects %s authority despite spoofed sender fields",
    (state) => {
      const connection = client();
      const lifetime = new AbortController();
      connection.connectionSignal = lifetime.signal;
      if (state === "synthetic") {
        connection.internal = { syntheticClient: true };
      }
      const ctx = resolveChatSendCallerContext(connection);
      if (state === "revoked") {
        connection.invalidated = true;
      }
      if (state === "aborted") {
        lifetime.abort();
      }
      if (state === "unverified") {
        connection.authenticatedUserId = undefined;
      }
      if (state === "other-profile") {
        connection.authenticatedUserProfile!.profileId = "other";
      }
      expect(
        resolve({
          ...ctx,
          SenderId: "gateway-owner",
          From: "gateway-owner",
          SenderE164: "gateway-owner",
        }).allowed,
      ).toBe(false);
    },
  );

  it.each([
    {
      ...config,
      tools: { elevated: { enabled: false, allowFrom: { webchat: ["id:gateway-owner"] } } },
    },
    { ...config, agents: { entries: { main: { tools: { elevated: { enabled: false } } } } } },
    {
      ...config,
      agents: {
        entries: { main: { tools: { elevated: { allowFrom: { webchat: ["id:other"] } } } } },
      },
    },
  ])("retains configured global and agent restrictions (%j)", (cfg) => {
    expect(resolve(resolveChatSendCallerContext(client()), cfg).allowed).toBe(false);
  });
});
