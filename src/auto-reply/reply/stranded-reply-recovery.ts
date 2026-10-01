import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import {
  getReplyPayloadMetadata,
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import { isSilentReplyText } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  classifyPrivateMessageToolFinal,
  shouldClassifyPrivateMessageToolFinal,
} from "./private-message-tool-final.js";
import type { FollowupRun } from "./queue/types.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";
const STRANDED_REPLY_DELIVERY_FAILURE_TEXT =
  "I generated a reply but could not deliver it to this chat. Please try again.";

export function buildStrandedReplyDeliveryFailurePayload(): ReplyPayload {
  return markReplyPayloadForSourceSuppressionDelivery({
    text: STRANDED_REPLY_DELIVERY_FAILURE_TEXT,
    isError: true,
    isStatusNotice: true,
  });
}

type StrandedReplyRecovery =
  | { kind: "none" }
  | { kind: "retry"; run: FollowupRun }
  | { kind: "diagnostic"; payload: ReplyPayload; warn: boolean };

/** Resolve the one allowed recovery action for a final that missed source delivery. */
export function resolveStrandedReplyRecovery(params: {
  base: FollowupRun;
  payloads: readonly ReplyPayload[];
  finalText: string;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
}): StrandedReplyRecovery {
  // Host-owned payloads can still be awaiting transport when completion bookkeeping runs.
  if (
    !shouldClassifyPrivateMessageToolFinal(params) ||
    params.payloads.some(
      (payload) =>
        isReplyPayloadTerminalContent(payload) &&
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    )
  ) {
    return { kind: "none" };
  }
  const classification = classifyPrivateMessageToolFinal(params);
  if (params.base.strandedReplyRetry === true) {
    // NO_REPLY on the retry is the model choosing silence; an empty final still gets the notice.
    if (isSilentReplyText(params.finalText.trim())) {
      return { kind: "none" };
    }
    return {
      kind: "diagnostic",
      payload: buildStrandedReplyDeliveryFailurePayload(),
      warn: classification === "substantive",
    };
  }
  if (classification === "none") {
    return { kind: "none" };
  }
  // A short final is still the only reply a person would get, so it is re-prompted too.
  // Internal and agent-to-agent turns (restart notices, handoffs) may end short and private on purpose.
  const provenanceKind = params.base.run.inputProvenance?.kind;
  if (
    classification === "short" &&
    (provenanceKind === "internal_system" || provenanceKind === "inter_session")
  ) {
    return { kind: "none" };
  }
  return {
    kind: "retry",
    run: buildStrandedReplyRetryFollowupRun(params.base, {
      finalText: params.finalText,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    }),
  };
}

function buildStrandedReplyRetryPrompt(finalText: string): string {
  return formatSystemTurnPrompt(
    `Your previous reply was not delivered to the conversation because ` +
      `you did not call message(action=send). Your reply text was:\n\n` +
      `"${finalText}"\n\n` +
      `Please deliver this reply now by calling message(action=send). ` +
      `Do not add any extra commentary; just deliver the original reply.`,
  );
}

/** Build the one-shot recovery followup that re-prompts message(action=send). */
function buildStrandedReplyRetryFollowupRun(
  base: FollowupRun,
  params: {
    finalText: string;
    sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  },
): FollowupRun {
  return {
    ...base,
    prompt: buildStrandedReplyRetryPrompt(params.finalText),
    summaryLine: STRANDED_REPLY_RETRY_MARKER,
    strandedReplyRetry: true,
    // The retry only delivers the earlier text; it must not repeat any other action.
    toolsAllow: ["message"],
    disableCollectBatching: true,
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    // Internally generated system turn: the client turn's lifecycle (gateway cancel
    // identity) completes with the parent run. turnAdoptionLifecycle is one-shot
    // WeakSet-tracked, so a shared object would be double-owned and free cancel
    // while the retry still runs.
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    run: {
      ...base.run,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      suppressNextUserMessagePersistence: true,
    },
  };
}
