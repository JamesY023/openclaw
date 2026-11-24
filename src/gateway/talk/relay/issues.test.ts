import { expect, it } from "vitest";
import { createIdleRelayProvider } from "./index.test-support.js";
import { resolveTalkRealtimeRelayPresentation } from "./issues.js";

it("reports adjustable provider voices only when the provider owns speech", () => {
  const params = {
    provider: createIdleRelayProvider(),
    providerConfig: { voice: "ember" },
    clientCapabilities: ["voice-selection" as const],
    voiceSelectionVoices: ["cove", "ember"],
  };
  expect(resolveTalkRealtimeRelayPresentation({ ...params, hostOwnedOutput: true })).toMatchObject({
    voice: undefined,
    selection: { voice: undefined, voices: [], canChange: false },
  });
  expect(resolveTalkRealtimeRelayPresentation(params)).toMatchObject({
    voice: "ember",
    selection: { voice: "ember", voices: ["cove", "ember"], canChange: true },
  });
});
