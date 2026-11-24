import { describe, expect, it, vi } from "vitest";
import { createGatewayReadyAnnouncer, logGatewayReady } from "./server-startup-readiness.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

function readinessFixture() {
  let ready = false;
  let closing = false;
  const getReadiness = () => ({ ready, coreReady: ready, failing: [], uptimeMs: 1 });
  getReadiness.prepare = async () => ({ publish: getReadiness });
  return {
    log: { info: vi.fn() },
    getReadiness,
    isClosing: () => closing,
    setReady: () => {
      ready = true;
    },
    close: () => {
      closing = true;
    },
  };
}

describe("Gateway readiness console marker", () => {
  it("keeps CD's exact marker on the ordinary ready transition", async () => {
    const params = readinessFixture();
    await logGatewayReady(params);
    expect(params.log.info).not.toHaveBeenCalled();
    params.setReady();
    await logGatewayReady(params);
    expect(params.log.info).toHaveBeenCalledExactlyOnceWith("gateway ready", {
      consoleMessage: "ready",
    });
    params.close();
    await logGatewayReady(params);
    expect(params.log.info).toHaveBeenCalledTimes(1);
  });

  it("keeps the canary diagnostic separate from the live marker", async () => {
    const params = readinessFixture();
    params.setReady();
    await logGatewayReady(params, "candidate gateway ready; autonomous sidecars suppressed");
    expect(params.log.info).toHaveBeenCalledExactlyOnceWith(
      "candidate gateway ready; autonomous sidecars suppressed",
    );
  });

  it("announces once after chat and sidecars are ready", async () => {
    const params = readinessFixture();
    let sidecarsReady = false;
    const mark = vi.fn();
    const announce = createGatewayReadyAnnouncer({
      ...params,
      isChatSendAvailable: () => true,
      areSidecarsReady: () => sidecarsReady,
      startupTrace: { mark } as unknown as GatewayStartupTrace,
    });
    params.setReady();
    await announce();
    expect(params.log.info).not.toHaveBeenCalled();
    sidecarsReady = true;
    await announce();
    await announce();
    expect(params.log.info).toHaveBeenCalledExactlyOnceWith("gateway ready", {
      consoleMessage: "ready",
    });
    expect(mark).toHaveBeenCalledExactlyOnceWith("ready");
  });
});
