import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function metadata(owner: string) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

describe("prepared auth metadata ownership", () => {
  it.each([true, false])(
    "uses selected environment evidence (available: %s)",
    async (available) => {
      const snapshot = (envVar: string) =>
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "fixture-owner",
              providers: ["fixture-provider"],
              setup: {
                requiresRuntime: false,
                providers: [{ id: "fixture-provider", envVars: [envVar] }],
              },
            },
          ],
        });
      const config = {};
      const prepared = await withPluginMetadataSnapshotScope(
        snapshot("AMBIENT_PROVIDER_KEY"),
        async () =>
          await prepareAgentRuntimeAuth({
            provider: "fixture-provider",
            modelId: "model",
            config,
            env: available
              ? { SELECTED_PROVIDER_KEY: "synthetic" }
              : { AMBIENT_PROVIDER_KEY: "synthetic" },
            metadataSnapshot: snapshot("SELECTED_PROVIDER_KEY"),
            authProfileStore: { version: 1, profiles: {} },
          }),
        { config, trustConfigIdentity: true },
      );

      expect(prepared.attempts[0]?.kind).toBe(available ? "direct" : "implicit");
      expect(prepared.plan.credentialSource).toEqual(
        available
          ? { kind: "direct", evidence: "environment", authorization: "ambient" }
          : { kind: "none" },
      );
    },
  );

  it.each(["user", "user-link", "auto", "binding"] as const)(
    "selects the prepared owner for %s profiles despite ambient aliases",
    async (selection) => {
      const selected = metadata("selected-auth");
      const ambient = metadata("ambient-auth");
      const config: OpenClawConfig =
        selection === "binding"
          ? {
              models: {
                providers: {
                  "fixture-alias": { baseUrl: "", models: [], apiKey: "fixture:selected" },
                },
              },
            }
          : {};
      const prepare = async () =>
        await prepareAgentRuntimeAuth({
          provider: "fixture-alias",
          modelId: "model",
          config,
          env: {},
          metadataSnapshot: selected,
          authProfileStore: {
            version: 1,
            profiles: {
              "fixture:ambient": {
                type: "api_key",
                provider: "ambient-auth",
                key: "synthetic-ambient",
              },
              "fixture:selected": {
                type: "api_key",
                provider: "selected-auth",
                key: "synthetic-selected",
              },
            },
          },
          ...(selection === "user" || selection === "user-link"
            ? { sessionAuthProfileId: "fixture:selected", sessionAuthProfileSource: selection }
            : {}),
        });
      const prepared = await withPluginMetadataSnapshotScope(ambient, prepare, {
        config,
        trustConfigIdentity: true,
      });

      expect(prepared.plan).toMatchObject({
        providerForAuth: "selected-auth",
        forwardedAuthProfileId: "fixture:selected",
        forwardedAuthProfileCandidateIds: ["fixture:selected"],
      });
      expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:selected"]);
    },
  );

  it("treats an empty prepared selection as authoritative", async () => {
    const config = {};
    const prepared = await withPluginMetadataSnapshotScope(
      metadata("ambient-auth"),
      async () =>
        await prepareAgentRuntimeAuth({
          provider: "fixture-alias",
          modelId: "model",
          config,
          env: {},
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          authProfileStore: {
            version: 1,
            profiles: {
              "fixture:exact": {
                type: "api_key",
                provider: "fixture-alias",
                key: "synthetic-exact",
              },
              "fixture:ambient": {
                type: "api_key",
                provider: "ambient-auth",
                key: "synthetic-ambient",
              },
            },
          },
        }),
      { config, trustConfigIdentity: true },
    );

    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:exact"]);
    expect(prepared.plan.forwardedAuthProfileCandidateIds).toEqual(["fixture:exact"]);
  });
});
