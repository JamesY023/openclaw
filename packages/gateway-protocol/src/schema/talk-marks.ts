import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

/** Acknowledges playback through a named realtime provider mark. */
export const TalkSessionAcknowledgeMarkParamsSchema = closedObject({
  sessionId: NonEmptyString,
  markName: NonEmptyString,
  outcome: Type.Optional(stringLiteralUnion(["completed", "cancelled", "failed"])),
});

export type TalkSessionAcknowledgeMarkParams = Static<
  typeof TalkSessionAcknowledgeMarkParamsSchema
>;
