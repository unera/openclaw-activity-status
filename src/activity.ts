export type ActivityPhase =
  | "model-send"
  | "model-wait"
  | "model-receive"
  | "tool-start"
  | "tool-wait"
  | "tool-done"
  | "tool-error"
  | "done"
  | "error";

export type ActivitySnapshot = {
  startedAt: number;
  model?: string;
  phase?: ActivityPhase;
  kind?: "model" | "tool";
  name?: string;
  modelCalls: number;
  modelRetries: number;
  toolCalls: number;
  toolRetries: number;
  outcome?: "completed" | "error" | "aborted";
};

export class ActivityState {
  private readonly state: ActivitySnapshot;
  private modelRetryPending = false;
  private failedToolNames = new Set<string>();

  constructor(startedAt = Date.now()) {
    this.state = {
      startedAt,
      modelCalls: 0,
      modelRetries: 0,
      toolCalls: 0,
      toolRetries: 0,
    };
  }

  /** Start a fresh agent turn before the first model call. */
  start(startedAt = Date.now(), model = "default") {
    this.state.startedAt = startedAt;
    this.state.model = model || "default";
    this.state.phase = undefined;
    this.state.kind = undefined;
    this.state.name = undefined;
    this.state.outcome = undefined;
    this.state.modelCalls = 0;
    this.state.modelRetries = 0;
    this.state.toolCalls = 0;
    this.state.toolRetries = 0;
    this.modelRetryPending = false;
    this.failedToolNames.clear();
  }

  modelStarted(callId: string, model?: string) {
    if (this.state.modelCalls === 0) this.start(Date.now(), model || "default");
    if (model) this.state.model = model;
    this.state.kind = "model";
    this.state.name = model;
    this.state.phase = "model-send";
    this.state.modelCalls += 1;
    if (this.modelRetryPending) {
      this.state.modelRetries += 1;
      this.modelRetryPending = false;
    }
  }

  modelWaiting() {
    this.state.phase = "model-wait";
  }

  modelReceiving() {
    this.state.phase = "model-receive";
  }

  modelEnded(callId: string, outcome: "completed" | "error") {
    if (outcome === "error") this.modelRetryPending = true;
    this.state.phase = outcome === "error" ? "error" : "model-receive";
  }

  /** Prefer the provider/model reported by the first completed model call. */
  modelResult(model?: string) {
    if (model) this.state.model = model;
  }

  toolStarted(toolCallId: string, toolName: string) {
    this.state.kind = "tool";
    this.state.name = toolName;
    this.state.phase = "tool-start";
    this.state.toolCalls += 1;
    if (this.failedToolNames.has(toolName)) {
      this.state.toolRetries += 1;
      this.failedToolNames.delete(toolName);
    }
  }

  toolWaiting() {
    this.state.phase = "tool-wait";
  }

  toolEnded(toolCallId: string, outcome: "completed" | "error") {
    if (outcome === "error" && this.state.name) this.failedToolNames.add(this.state.name);
    this.state.phase = outcome === "error" ? "tool-error" : "tool-done";
  }

  finish(outcome: "completed" | "error" | "aborted") {
    this.state.outcome = outcome;
    this.state.phase = outcome === "completed" ? "done" : "error";
  }

  snapshot(): ActivitySnapshot {
    return { ...this.state };
  }
}
