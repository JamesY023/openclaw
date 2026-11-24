import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { createAgentDatabaseInspectionRefusal } from "../state/agent-database-admission.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
} from "./server-channels.test-support.js";
import { handleGatewayProbeRequest } from "./server-http-probes.js";
import { createGatewayReadyAnnouncer } from "./server-startup-readiness.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";
import { createReadinessChecker } from "./server/readiness.js";

it("announces after a transient readiness inspection failure", async () => {
  let pendingDatabase = true;
  const channel = createTestPlugin({ account: { enabled: false } });
  const inspectAccount = vi
    .fn(() => ({ enabled: false, configured: true }))
    .mockImplementationOnce(() => {
      throw new Error("synthetic channel inspection failure");
    });
  channel.config.inspectAccount = inspectAccount;
  const registry = createTestChannelRegistry(channel);
  const pending = createAgentDatabaseInspectionRefusal({
    agentId: "synthetic",
    paths: [],
    reason: "synthetic database admission",
    pending: true,
  });
  const getReadiness = createReadinessChecker({
    startedAt: Date.now(),
    channelManager: createTestChannelManager({ getPluginRegistry: () => registry }),
    getAgentDatabaseAdmissionRefusals: () => (pendingDatabase ? [pending] : []),
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const announce = createGatewayReadyAnnouncer({
    getReadiness,
    isChatSendAvailable: () => true,
    areSidecarsReady: () => true,
    startupTrace: { mark() {} } as unknown as GatewayStartupTrace,
    log,
  });
  await announce();
  expect(log.info).not.toHaveBeenCalled();
  expect(inspectAccount).not.toHaveBeenCalled();
  pendingDatabase = false;
  await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1), { timeout: 3_000 });

  const request = {
    method: "GET",
    headers: { host: "test.invalid" },
    socket: { remoteAddress: "192.0.2.1" },
  } as IncomingMessage;
  const response = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
  const handled = await handleGatewayProbeRequest(
    request,
    response as unknown as ServerResponse,
    "/readyz",
    { mode: "none" },
    [],
    false,
    undefined,
    getReadiness,
  );
  expect(handled).toBe(true);
  expect(response.statusCode).toBe(200);
  expect(response.end).toHaveBeenCalledWith('{"ready":true}');
  await vi.waitFor(
    () =>
      expect(log.info).toHaveBeenCalledExactlyOnceWith("gateway ready", {
        consoleMessage: "ready",
      }),
    { timeout: 3_000 },
  );
  expect(log.warn).toHaveBeenCalledTimes(1);
});
