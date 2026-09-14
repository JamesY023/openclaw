import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Acknowledges playback through a named realtime provider mark. */
export const TalkSessionAcknowledgeMarkParamsSchema = closedObject({
  sessionId: NonEmptyString,
  markName: NonEmptyString,
  outcome: Type.Optional(
    Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("failed")]),
  ),
});

export type TalkSessionAcknowledgeMarkParams = Static<
  typeof TalkSessionAcknowledgeMarkParamsSchema
>;
