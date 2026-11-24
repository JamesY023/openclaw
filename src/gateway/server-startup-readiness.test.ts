import { describe, expect, it, vi } from "vitest";
import { createGatewayReadyAnnouncer, logGatewayReady } from "./server-startup-readiness.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

function readinessFixture() {
  let ready = false;
  let closing = false;
  const getReadiness = () => ({ ready, coreReady: ready, failing: [], uptimeMs: 1 });
  getReadiness.prepare = async () => ({ publish: getReadiness });
  return {
    log: { info: vi.fn(), warn: vi.fn() },
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

  it("announces after readiness becomes true without another startup callback", async () => {
    vi.useFakeTimers();
    try {
      const params = readinessFixture();
      const mark = vi.fn();
      const announce = createGatewayReadyAnnouncer({
        ...params,
        isChatSendAvailable: () => true,
        areSidecarsReady: () => true,
        startupTrace: { mark } as unknown as GatewayStartupTrace,
      });
      await announce();
      expect(params.log.info).not.toHaveBeenCalled();
      await announce();
      params.setReady();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(params.log.info).toHaveBeenCalledExactlyOnceWith("gateway ready", {
        consoleMessage: "ready",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mark).toHaveBeenCalledExactlyOnceWith("ready");
      expect(params.log.info).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["close", "deadline"] as const)(
    "does not announce readiness after %s",
    async (stop) => {
      vi.useFakeTimers();
      try {
        const params = readinessFixture();
        const announce = createGatewayReadyAnnouncer({
          ...params,
          isChatSendAvailable: () => true,
          areSidecarsReady: () => true,
          startupTrace: { mark: vi.fn() } as unknown as GatewayStartupTrace,
        });
        await announce();
        if (stop === "close") {
          params.close();
        } else {
          await vi.advanceTimersByTimeAsync(180_000);
        }
        params.setReady();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(params.log.info).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
