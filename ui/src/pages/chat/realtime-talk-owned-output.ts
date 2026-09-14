import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";
type PlaybackOutcome = "completed" | "cancelled" | "failed";
type OwnedOutput = {
  audioDone: boolean;
  receivedAudio: boolean;
  outcome?: PlaybackOutcome;
  marks: Set<string>;
};

/** Tracks finite host utterances; the existing PCM queue remains the playback owner. */
export class RealtimeTalkOwnedOutput {
  private readonly outputs = new Map<string, OwnedOutput>();
  turnId: string | null = null;

  constructor(
    private readonly callbacks: {
      client: RealtimeTalkTransportContext["client"];
      sessionId: string;
      drain: () => Promise<"completed" | "cancelled">;
      stop: () => void;
      reportError: (error: unknown) => void;
      stopSession: () => void;
    },
  ) {}

  begin(turnId: string): boolean {
    const output = this.get(turnId);
    if (!output || output.outcome || output.audioDone) {
      return false;
    }
    const current = this.turnId;
    if (current && current !== turnId) {
      this.finish(current, "cancelled");
    }
    this.turnId = turnId;
    output.receivedAudio = true;
    return true;
  }

  play(turnId: string, enqueue: () => "queued" | "ignored" | "overflow"): void {
    try {
      if (enqueue() !== "queued") {
        this.finish(turnId, "failed");
      }
    } catch (error) {
      this.finish(turnId, "failed");
      this.callbacks.reportError(error);
    }
  }

  done(turnId: string | undefined): void {
    if (!turnId) {
      return;
    }
    const output = this.get(turnId);
    if (!output || output.outcome || output.audioDone) {
      return;
    }
    output.audioDone = true;
    if (!output.receivedAudio) {
      this.finish(turnId, "failed");
      return;
    }
    void this.callbacks.drain().then((outcome) => this.finish(turnId, outcome));
  }

  mark(event: { talkEvent?: { turnId?: string }; markName?: string }): void {
    const turnId = event.talkEvent?.turnId;
    const markName = event.markName;
    if (!turnId || !markName) {
      return;
    }
    const output = this.get(turnId);
    if (!output || output.marks.has(markName)) {
      return;
    }
    output.marks.add(markName);
    if (output.outcome) {
      this.acknowledge(markName, output.outcome);
    }
  }

  finish(turnId: string, outcome: PlaybackOutcome): void {
    const output = this.outputs.get(turnId);
    if (!output || output.outcome) {
      return;
    }
    // Publish cancellation before stopping sources can synchronously fire ended.
    output.outcome = outcome;
    if (this.turnId === turnId) {
      this.turnId = null;
      if (outcome !== "completed") {
        this.callbacks.stop();
      }
    }
    for (const mark of output.marks) {
      this.acknowledge(mark, outcome);
    }
  }

  clear(turnId: string | undefined): boolean {
    const target = turnId ?? this.turnId;
    if (!target || !this.get(target)) {
      return false;
    }
    const wasCurrent = target === this.turnId;
    this.finish(target, "cancelled");
    return wasCurrent;
  }

  close(): void {
    for (const turnId of this.outputs.keys()) {
      this.finish(turnId, "cancelled");
    }
  }

  private acknowledge(markName: string, outcome: PlaybackOutcome): void {
    void this.callbacks.client
      .request("talk.session.acknowledgeMark", {
        sessionId: this.callbacks.sessionId,
        markName,
        outcome,
      })
      .catch((error: unknown) => this.callbacks.reportError(error));
  }

  private get(turnId: string): OwnedOutput | undefined {
    const existing = this.outputs.get(turnId);
    if (existing) {
      return existing;
    }
    // Never evict terminal identities: a delayed frame must not replay retired speech.
    if (this.outputs.size >= 1024) {
      this.callbacks.reportError("Realtime Talk output identity limit exceeded");
      this.callbacks.stopSession();
      return undefined;
    }
    const output: OwnedOutput = { audioDone: false, receivedAudio: false, marks: new Set() };
    this.outputs.set(turnId, output);
    return output;
  }
}
