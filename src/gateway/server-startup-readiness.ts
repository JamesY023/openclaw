import type { GatewayStartupTrace } from "./server-startup-trace.js";
import type { PreparedReadinessChecker } from "./server/readiness.types.js";

type GatewayReadinessLog = {
  log: { info: (message: string, metadata?: { consoleMessage: string }) => void };
  getReadiness: PreparedReadinessChecker;
  isClosing?: () => boolean;
};

function writeReadyLog(log: GatewayReadinessLog["log"]): void {
  // Skynet2's idle restart verifies the deployed gateway's exact console marker.
  log.info("gateway ready", { consoleMessage: "ready" });
}

export async function logGatewayReady(
  params: GatewayReadinessLog,
  message?: string,
): Promise<void> {
  const prepared = await params.getReadiness.prepare();
  if (!params.isClosing?.() && prepared.publish().ready) {
    if (message === undefined) {
      writeReadyLog(params.log);
    } else {
      params.log.info(message);
    }
  }
}

export async function logGatewaySidecarsReady(
  params: GatewayReadinessLog & {
    startupTrace?: GatewayStartupTrace;
    loadedPluginCount: number;
    postReadySidecarCount: number;
  },
): Promise<void> {
  params.startupTrace?.detail("sidecars.ready", [
    ["loadedPluginCount", params.loadedPluginCount],
    ["postReadySidecarCount", params.postReadySidecarCount],
  ]);
  params.startupTrace?.mark("sidecars.ready");
  await logGatewayReady(params);
}

export function createGatewayReadyAnnouncer(
  params: GatewayReadinessLog & {
    log: GatewayReadinessLog["log"] & { warn: (message: string) => void };
    isChatSendAvailable: () => boolean;
    areSidecarsReady: () => boolean;
    startupTrace: GatewayStartupTrace;
  },
): () => Promise<void> {
  const canAnnounce = () =>
    !params.isClosing?.() && params.isChatSendAvailable() && params.areSidecarsReady();
  let started = false;
  return async () => {
    if (started || !canAnnounce()) {
      return;
    }
    started = true;
    const retryDelayMs = 1_000;
    const deadline = performance.now() + 180_000;
    const observe = async (): Promise<void> => {
      if (!canAnnounce() || performance.now() >= deadline) {
        return;
      }
      const prepared = await params.getReadiness.prepare();
      if (!canAnnounce() || performance.now() >= deadline) {
        return;
      }
      if (prepared.publish().ready) {
        params.startupTrace.mark("ready");
        writeReadyLog(params.log);
        return;
      }
      // Admission can finish after chat unlocks. Observe that transition without
      // delaying startup observers or keeping a closing gateway alive.
      if (performance.now() + retryDelayMs < deadline) {
        setTimeout(() => {
          void observe().catch(() => params.log.warn("Gateway startup readiness recheck failed"));
        }, retryDelayMs).unref();
      }
    };
    await observe();
  };
}
