import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
// Codex usage tests cover the harness-owned provider-usage contribution.
import type { ProviderFetchUsageSnapshotContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { readCodexProfileRateLimits } from "../../api.js";
import { fetchCodexAppServerUsageSnapshot } from "./usage.js";

function usageContext(
  overrides: Partial<ProviderFetchUsageSnapshotContext> = {},
): ProviderFetchUsageSnapshotContext {
  return {
    config: {},
    env: {},
    provider: "openai",
    token: CODEX_APP_SERVER_AUTH_MARKER,
    timeoutMs: 3_500,
    fetchFn: fetch,
    ...overrides,
  };
}

describe("Codex app-server provider usage", () => {
  it("contributes OpenAI usage windows for the synthetic app-server credential", async () => {
    const readUsage = vi.fn(async () => ({
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 9,
              windowDurationMins: 300,
              resetsAt: 1_700_003_600,
            },
          },
        },
      },
      accountEmail: "codex-account@example.com",
    }));

    await expect(fetchCodexAppServerUsageSnapshot(usageContext(), { readUsage })).resolves.toEqual({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9, resetAt: 1_700_003_600_000 }],
      plan: undefined,
      accountEmail: "codex-account@example.com",
    });
    expect(readUsage).toHaveBeenCalledWith({
      timeoutMs: 3_500,
      agentDir: undefined,
      config: {},
      startOptions: expect.objectContaining({
        command: "codex",
        commandSource: "managed",
      }),
    });
  });

  it("ignores ordinary OpenAI credentials", async () => {
    const readUsage = vi.fn();

    await expect(
      fetchCodexAppServerUsageSnapshot(usageContext({ token: "test-token-placeholder" }), {
        readUsage,
      }),
    ).resolves.toBeNull();
    expect(readUsage).not.toHaveBeenCalled();
  });
});

describe("exact-profile quota API", () => {
  it("binds the isolated native request to the selected agent profile and five-second deadline", async () => {
    const limits = { rateLimitsByLimitId: { codex: {} } };
    const read = vi.fn(
      async (
        _options: Parameters<NonNullable<Parameters<typeof readCodexProfileRateLimits>[1]>>[0],
      ) => ({ rateLimits: limits }),
    );
    expect(
      await readCodexProfileRateLimits(
        { agentDir: "/fixture/agent", profileId: "openai:fixture", config: {} },
        read,
      ),
    ).toEqual(limits);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/fixture/agent",
        authProfileId: "openai:fixture",
        timeoutMs: 5000,
        startOptions: expect.objectContaining({ homeScope: "agent", transport: "stdio" }),
      }),
    );
  });
  it.each([{ homeScope: "user" }, { transport: "websocket", url: "ws://127.0.0.1:39175" }])(
    "refuses ambient account quota (%j)",
    async (appServer) => {
      const read = vi.fn();
      await expect(
        readCodexProfileRateLimits(
          {
            agentDir: "/fixture/agent",
            profileId: "openai:fixture",
            config: { plugins: { entries: { codex: { config: { appServer } } } } },
          },
          read,
        ),
      ).rejects.toThrow("Exact-profile quota requires an isolated agent app-server home.");
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("does not forward unsupported raw app-server env into an exact-profile request", async () => {
    const limits = { rateLimitsByLimitId: { codex: {} } };
    const read = vi.fn(
      async (
        _options: Parameters<NonNullable<Parameters<typeof readCodexProfileRateLimits>[1]>>[0],
      ) => ({ rateLimits: limits }),
    );
    await expect(
      readCodexProfileRateLimits(
        {
          agentDir: "/fixture/agent",
          profileId: "openai:fixture",
          config: {
            plugins: {
              entries: {
                codex: { config: { appServer: { env: { CODEX_HOME: "/ambient/fixture" } } } },
              },
            },
          },
        },
        read,
      ),
    ).resolves.toEqual(limits);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/fixture/agent",
        authProfileId: "openai:fixture",
        startOptions: expect.objectContaining({ homeScope: "agent", transport: "stdio" }),
      }),
    );
    expect(read.mock.calls[0]?.[0].startOptions).not.toHaveProperty("env");
  });
});
