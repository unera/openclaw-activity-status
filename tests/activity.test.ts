import { describe, expect, it } from "vitest";
import { ActivityState } from "../src/activity.js";
import { renderStatus } from "../src/templates.js";

describe("ActivityState", () => {
  it("counts model and tool calls independently", () => {
    const state = new ActivityState(0);
    state.modelStarted("m1", "openai/gpt");
    state.modelEnded("m1", "completed");
    state.toolStarted("t1", "exec");
    state.toolEnded("t1", "completed");
    expect(state.snapshot()).toMatchObject({ modelCalls: 1, modelRetries: 0, toolCalls: 1, toolRetries: 0 });
  });

  it("counts retries after failed calls", () => {
    const state = new ActivityState(0);
    state.modelStarted("m1", "model");
    state.modelEnded("m1", "error");
    state.modelStarted("m1", "model");
    state.toolStarted("t1", "web_fetch");
    state.toolEnded("t1", "error");
    state.toolStarted("t1", "web_fetch");
    expect(state.snapshot()).toMatchObject({ modelCalls: 2, modelRetries: 1, toolCalls: 2, toolRetries: 1 });
  });

  it("initializes turn state and keeps a fallback when the startup model is absent", () => {
    const state = new ActivityState(123);
    state.modelStarted("m1");
    expect(state.snapshot()).toMatchObject({
      startedAt: expect.any(Number),
      model: "default",
      modelCalls: 1,
      modelRetries: 0,
      toolCalls: 0,
      toolRetries: 0,
    });
  });

  it("can refine the fallback with the model reported by the first result", () => {
    const state = new ActivityState(0);
    state.modelStarted("m1");
    state.modelResult("deepseek/deepseek-flash");
    expect(state.snapshot().model).toBe("deepseek/deepseek-flash");
  });
});

describe("templates", () => {
  it("renders localized status without tool arguments", () => {
    const state = new ActivityState(0);
    state.toolStarted("t1", "exec");
    const text = renderStatus(state.snapshot(), "ru", 8_000);
    expect(text).toContain("**default**: 8 секунд");
    expect(text).toContain("Вызовы: 0/0, действия: 1/0");
    expect(text).not.toContain("t1");
  });

  it("uses the final template after completion", () => {
    const state = new ActivityState(0);
    state.finish("completed");
    expect(renderStatus(state.snapshot(), "en", 1_000)).toContain("**default**: 1 секунд");
  });
});
