import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

const cronScope = vi.hoisted(() => ({
  resolvers: [] as Array<
    (options?: {
      signal?: AbortSignal;
      toolsAllow?: string[];
    }) => Promise<{ tools: readonly (string | { name: string; pluginId?: string })[] }>
  >,
  discoveries: [] as Array<{
    sessionId: string;
    toolsAllow?: string[];
    additionalToolsAllow?: string[];
  }>,
}));

vi.mock("openclaw/plugin-sdk/codex-mcp-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/codex-mcp-projection")>();
  return {
    ...actual,
    runWithCronCreatorAuthorityCapabilityResolver: (
      params: Parameters<typeof actual.runWithCronCreatorAuthorityCapabilityResolver>[0],
    ) => {
      cronScope.resolvers.push(params.resolve);
      return actual.runWithCronCreatorAuthorityCapabilityResolver(params);
    },
    materializeStaticMcpToolsForHarnessRun: async (params: {
      sessionId: string;
      toolsAllow?: string[];
      additionalToolsAllow?: string[];
    }) => {
      cronScope.discoveries.push(params);
      const tools = ["fake__read", "fake__write"]
        .filter(
          (name) => !params.additionalToolsAllow || params.additionalToolsAllow.includes(name),
        )
        .map((name) => ({
          name,
          description: "Configured scoped fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }),
        }));
      return { tools, dispose: async () => undefined };
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    loadCodexBundleMcpThreadConfig: async (
      params: Parameters<typeof actual.loadCodexBundleMcpThreadConfig>[0],
    ) => {
      const servers = params.cfg?.mcp?.servers ?? {};
      const names = Object.keys(servers);
      return {
        configPatch: names.length ? { mcp_servers: servers } : undefined,
        diagnostics: [],
        evaluated: true,
        staticServerNames: names,
        userStaticServerNames: names,
      };
    },
    materializeRequesterScopedMcpToolsForHarnessRun: async () => {
      const tool = {
        name: "fake__show",
        description: "Late requester-scoped tool.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text" as const, text: "fixture" }] }),
      };
      return { tools: [tool], advertisedTools: [tool], dispose: async () => undefined };
    },
  };
});

setupRunAttemptTestHooks();
beforeEach(() => {
  cronScope.resolvers.length = 0;
  cronScope.discoveries.length = 0;
});

describe("runCodexAppServerAttempt tool inheritance", () => {
  it.each([true, false])(
    "captures final executable tools only when parent policy is restrictive (%s)",
    async (restricted) => {
      const sessionFile = path.join(tempDir, "session-tool-inheritance.jsonl");
      const params = createParams(sessionFile, path.join(tempDir, "workspace-tool-inheritance"));
      setCodexTestModelSupportsTools(params, true);
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.toolsAllow = ["read", "sessions_spawn", "fake__show"];
      if (restricted) {
        params.config = { ...params.config, tools: { allow: params.toolsAllow } };
      }
      const host = params.hostCapabilities;
      const snapshots: Array<{ ref?: string[]; initial: string[] }> = [];
      params.hostCapabilities = Object.freeze({
        ...host,
        createToolSurface: (options, bindingOptions) => {
          const tools = host.createToolSurface!(options, bindingOptions);
          snapshots.push({
            ref: options.inheritedToolAllowlistRef,
            initial: [...(options.inheritedToolAllowlistRef ?? [])],
          });
          return tools;
        },
      });
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
          codexDynamicToolsExclude: ["read"],
        },
      });
      await harness.waitForMethod("turn/start");
      // Finish the attempt before assertions so a regression cannot leave a pending run.
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;

      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.ref).toBeUndefined();
      expect(snapshots[0]?.ref).toBeDefined();
      if (restricted) {
        expect(snapshots[0]?.initial).toEqual(expect.arrayContaining(["read", "sessions_spawn"]));
        expect(snapshots[0]?.initial).not.toContain("fake__show");
        expect(snapshots[0]?.ref?.toSorted()).toEqual(["fake__show", "sessions_spawn"]);
      } else {
        expect(snapshots[0]?.initial).toEqual([]);
        expect(snapshots[0]?.ref).toEqual([]);
      }
    },
  );
});

describe("runCodexAppServerAttempt finite cron scope", () => {
  it("isolates explicit discovery scopes while retaining the inherited cache", async () => {
    const params = createParams(
      path.join(tempDir, "cron-scope.jsonl"),
      path.join(tempDir, "cron-scope"),
    );
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.trigger = "user";
    params.toolsAllow = ["*"];
    params.config = {
      ...params.config,
      mcp: { servers: { fake: { command: "unused-fixture-command" } } },
    };
    const controller = new AbortController();
    params.cronCreatorAuthorityCapability = {
      active: true,
      abort: () => controller.abort(),
      callerOrigin: { kind: "local" },
      grantTokens: new Set<string>(),
      runId: params.runId,
      signal: controller.signal,
    };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    let snapshots: Awaited<ReturnType<(typeof cronScope.resolvers)[number]>>[] = [];
    let sameDefaultPromise = false;
    try {
      const resolver = cronScope.resolvers[0]!;
      snapshots = await Promise.all([
        resolver({ toolsAllow: ["fake__read"] }),
        resolver({ toolsAllow: ["fake__write"] }),
        resolver({ toolsAllow: [] }),
      ]);
      const first = resolver();
      sameDefaultPromise = first === resolver();
      await first;
    } finally {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
    const scopedNames = snapshots.map((snapshot) =>
      snapshot.tools
        .map((tool) => (typeof tool === "string" ? tool : tool.name))
        .filter((name) => name === "fake__read" || name === "fake__write"),
    );
    expect(scopedNames).toEqual([["fake__read"], ["fake__write"], []]);
    expect(cronScope.discoveries.map((call) => call.additionalToolsAllow)).toEqual([
      ["fake__read"],
      ["fake__write"],
      [],
      undefined,
    ]);
    expect(new Set(cronScope.discoveries.map((call) => call.sessionId)).size).toBe(4);
    expect(cronScope.discoveries.every((call) => call.toolsAllow === params.toolsAllow)).toBe(true);
    expect(sameDefaultPromise).toBe(true);
  });
});
