import { normalizeJsonSchemaForTypeBox } from "openclaw/plugin-sdk/json-schema-runtime";
import externalAgentMessageModeration from "./protocol-agent-message-moderation.json" with { type: "json" };
import rawDynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import sharedDefinitionsSchema from "./protocol-generated/json/v2/CodexAppServerProtocolDefinitions.json" with { type: "json" };
import rawErrorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import rawModelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import rawThreadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import rawThreadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import rawTurnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import rawTurnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };

/** The same normalized resources own build-time checks and runtime error diagnostics. */
export function createCodexValidationSchemas() {
  const schemaBaseUrl = "https://openclaw.invalid/codex/";
  const sharedDefinitionsId = new URL("v2/CodexAppServerProtocolDefinitions.json", schemaBaseUrl)
    .href;
  const normalize = (schema: Record<string, unknown>, name: string) =>
    normalizeJsonSchemaForTypeBox({ ...schema, $id: new URL(name, schemaBaseUrl).href });

  const codexErrorInfoSchema = sharedDefinitionsSchema.definitions.CodexErrorInfo;
  // Preserve known variant constraints when the upstream open enum accepts future errors.
  const knownErrorVariantConstraints = codexErrorInfoSchema.anyOf.flatMap((variant) =>
    "required" in variant
      ? [{ anyOf: [{ not: { type: "object", required: variant.required } }, variant] }]
      : [],
  );

  return {
    context: {
      [sharedDefinitionsId]: normalizeJsonSchemaForTypeBox({
        ...sharedDefinitionsSchema,
        $id: sharedDefinitionsId,
        definitions: {
          ...sharedDefinitionsSchema.definitions,
          // The pinned 0.161 runtime omits this optional field. Retain the
          // upstream 0.170 validation for newer external and desktop runtimes.
          ...externalAgentMessageModeration.definitions,
          MessagePhase: {
            ...sharedDefinitionsSchema.definitions.MessagePhase,
            oneOf: [
              ...sharedDefinitionsSchema.definitions.MessagePhase.oneOf,
              { type: "string", enum: ["partial_answer"] },
            ],
          },
          UserInput: {
            ...sharedDefinitionsSchema.definitions.UserInput,
            oneOf: sharedDefinitionsSchema.definitions.UserInput.oneOf.map((item) =>
              item.title === "AudioUserInput"
                ? {
                    ...item,
                    required: ["type"],
                    anyOf: [
                      { required: ["url"], properties: { url: { type: "string" } } },
                      { required: ["fileId"], properties: { fileId: { type: "string" } } },
                    ],
                  }
                : item,
            ),
          },
          ThreadItem: {
            ...sharedDefinitionsSchema.definitions.ThreadItem,
            oneOf: sharedDefinitionsSchema.definitions.ThreadItem.oneOf.map((item) =>
              item.title === "AgentMessageThreadItem"
                ? {
                    ...item,
                    properties: {
                      ...item.properties,
                      moderation: externalAgentMessageModeration.moderation,
                    },
                  }
                : item.title === "ImageGenerationThreadItem"
                  ? {
                      ...item,
                      required: item.required.filter((key) => key !== "result"),
                      anyOf: [
                        { required: ["fileId"], properties: { fileId: { type: "string" } } },
                        { required: ["result"], properties: { result: { type: "string" } } },
                      ],
                    }
                  : item,
            ),
          },
          AgentMessageDisplay: {
            anyOf: [
              externalAgentMessageModeration.definitions.AgentMessageDisplay,
              {
                type: "object",
                required: ["action"],
                properties: {
                  action: { type: "string" },
                  blockType: { type: ["string", "null"] },
                  checkTrustedContacts: { type: ["boolean", "null"] },
                  cyberTrustedAccess: { type: ["boolean", "null"] },
                },
              },
            ],
          },
          CodexErrorInfo: {
            ...codexErrorInfoSchema,
            allOf: knownErrorVariantConstraints,
          },
        },
      }),
    },
    schemas: {
      CodexDynamicToolCallParams: normalize(
        rawDynamicToolCallParamsSchema,
        "DynamicToolCallParams.json",
      ),
      CodexErrorNotification: normalize(rawErrorNotificationSchema, "v2/ErrorNotification.json"),
      CodexModelListResponse: normalize(rawModelListResponseSchema, "v2/ModelListResponse.json"),
      CodexThreadResumeResponse: normalize(
        rawThreadResumeResponseSchema,
        "v2/ThreadResumeResponse.json",
      ),
      CodexThreadStartResponse: normalize(
        rawThreadStartResponseSchema,
        "v2/ThreadStartResponse.json",
      ),
      CodexTurnCompletedNotification: normalize(
        rawTurnCompletedNotificationSchema,
        "v2/TurnCompletedNotification.json",
      ),
      CodexTurnStartResponse: normalize(rawTurnStartResponseSchema, "v2/TurnStartResponse.json"),
    },
  };
}
