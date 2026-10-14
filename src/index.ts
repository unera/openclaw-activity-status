import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ActivityState } from "./activity.js";
import { renderStatus, type Locale, type TemplateKey } from "./templates.js";
import {
  createTelegramStatus,
  deleteTelegramStatus,
  editTelegramStatus,
  isTelegramContext,
  loadTelegramRuntime,
  targetFromAgentContext,
  targetFromInbound,
  type TelegramTarget,
} from "./telegram.js";

type RunContext = {
  state: ActivityState;
  locale?: Locale;
  target?: TelegramTarget;
  message?: { chatId: string; messageId: string };
  messageCreation?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  hadError?: boolean;
  finishing?: boolean;
  lastRendered?: string;
};
type AgentContextLike = {
  channel?: string;
  channelId?: string;
  messageProvider?: string;
  chatId?: string;
  conversationId?: string;
  accountId?: string;
  sessionKey?: string;
  threadId?: string | number;
  channelContext?: { chat?: { id?: string } };
};
type ActivityConfig = {
  enabled: boolean;
  locale: Locale | "auto";
  intervalSeconds: number;
  showFinal: boolean;
  templates: Partial<Record<TemplateKey, string>>;
};

function modelName(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as { provider?: unknown; model?: unknown };
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model || model === "undefined" || model === "null") return undefined;
  if (model.includes("/")) return model;
  return provider && provider !== "undefined" && provider !== "null" ? `${provider}/${model}` : model;
}
const runs = new Map<string, RunContext>();
const inboundTargets = new Map<string, TelegramTarget>();
const inboundLocales = new Map<string, Locale>();

function configOf(api: { pluginConfig?: Record<string, unknown> }): ActivityConfig {
  const config = api.pluginConfig ?? {};
  return {
    enabled: config.enabled !== false,
    locale: (config.locale === "en" || config.locale === "ru" ? config.locale : "auto") as Locale | "auto",
    intervalSeconds: typeof config.intervalSeconds === "number" ? Math.max(6, Math.min(60, config.intervalSeconds)) : 8,
    showFinal: config.showFinal !== false,
    templates: (config.templates ?? {}) as Partial<Record<TemplateKey, string>>,
  };
}

function render(run: RunContext, locale: Locale | "auto", templates: Partial<Record<TemplateKey, string>>) {
  return renderStatus(run.state.snapshot(), run.locale ?? (locale === "auto" ? "ru" : locale), Date.now(), templates);
}

export default definePluginEntry({
  id: "openclaw-activity-status",
  name: "OpenClaw Activity Status",
  description: "Tracks safe model and tool activity for long-running agent turns.",
  register(api) {
    const config = configOf(api);
    if (!config.enabled) return;

    // Load the Telegram runtime during plugin activation. Without this warm-up,
    // the first dynamic import can finish only after a long model turn, making
    // the Working indicator appear too late.
    void loadTelegramRuntime().catch((error: unknown) => {
      api.logger.warn?.(`activity status Telegram runtime warm-up failed: ${String(error)}`);
    });

    api.on("message_received", (event, ctx) => {
      const hookCtx = ctx as typeof ctx & AgentContextLike;
      if (!isTelegramContext(hookCtx.channel ?? hookCtx.channelId, hookCtx.messageProvider)) return;
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const target = targetFromInbound({
        ...event,
        chatId: ctx.conversationId,
        accountId: ctx.accountId,
        threadId: event.threadId,
        messageId: event.messageId,
      });
      if (target) inboundTargets.set(runId, target);
      if (config.locale === "auto") {
        inboundLocales.set(runId, /[А-Яа-яЁё]/u.test(event.content) ? "ru" : "en");
      }
    });

    const ensureRun = (runId: string, ctx: AgentContextLike, fallback?: AgentContextLike) => {
      const run = runs.get(runId) ?? { state: new ActivityState(), locale: inboundLocales.get(runId) };
      if (!run.target) {
        run.target = inboundTargets.get(runId) ?? targetFromAgentContext(ctx) ??
          (fallback ? targetFromAgentContext(fallback) : undefined);
      }
      runs.set(runId, run);
      return run;
    };

    const ensureMessage = async (runId: string, ctx: AgentContextLike, fallback?: AgentContextLike) => {
      const run = ensureRun(runId, ctx, fallback);
      // Agent/model hook contexts may not carry channelId. The inbound hook
      // already validated Telegram and stored the target for this run.
      if (run.message || run.messageCreation || !run.target || run.finishing) return run;
      const target = run.target;
      const text = render(run, config.locale, config.templates);
      // Several lifecycle hooks can arrive at once. Keep the promise on the
      // run before awaiting Telegram, otherwise each hook sends a new message.
      run.messageCreation = (async () => {
        try {
          run.message = await createTelegramStatus(api.config, target, text);
          run.lastRendered = text;
          if (!run.finishing) {
            run.timer = setInterval(() => {
              void updateMessage(run, api.config, config.locale, config.templates);
            }, config.intervalSeconds * 1000);
          }
        } catch (error) {
          api.logger.warn?.(`activity status could not be created: ${String(error)}`);
        } finally {
          run.messageCreation = undefined;
        }
      })();
      await run.messageCreation;
      if (run.finishing && run.message && run.target) {
        await deleteStatusMessage(run, api.config);
      }
      return run;
    };

    api.on("model_call_started", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const eventCtx = event as typeof event & AgentContextLike;
      const run = ensureRun(runId, ctx, eventCtx);
      api.logger.info?.(`activity status model run=${runId} target=${run.target ? "yes" : "no"} session=${ctx.sessionKey ?? eventCtx.sessionKey ?? "none"}`);
      run.state.modelStarted(event.callId, modelName(event));
      void ensureMessage(runId, ctx, eventCtx);
    });

    api.on("model_call_ended", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = runs.get(runId);
      if (!run) return;
      run.state.modelResult(modelName(event));
      run.state.modelEnded(event.callId, event.outcome);
      if (event.outcome === "error") run.hadError = true;
    });

    api.on("before_tool_call", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = ensureRun(runId, { ...ctx, channel: ctx.requester?.channel, accountId: ctx.requester?.accountId });
      run.state.toolStarted(event.toolCallId ?? event.toolName, event.toolName);
      void ensureMessage(runId, { ...ctx, channel: ctx.requester?.channel, accountId: ctx.requester?.accountId });
    });

    api.on("after_tool_call", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = runs.get(runId);
      if (!run) return;
      run.state.toolEnded(event.toolCallId ?? event.toolName, event.error ? "error" : "completed");
      if (event.error) run.hadError = true;
    });

    api.on("agent_end", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      if (!runId) return;
      const run = runs.get(runId);
      if (!run) return;
      run.finishing = true;
      run.hadError ||= event.success === false || Boolean(event.error);
      run.state.finish(run.hadError ? "error" : "completed");
      if (run.timer) clearInterval(run.timer);
      // If creation is still in flight, ensureMessage will delete the
      // message after Telegram returns it. Otherwise delete it now.
      if (run.messageCreation) {
        void run.messageCreation.then(() => deleteStatusMessage(run, api.config));
      } else if (run.message && run.target) {
        void deleteStatusMessage(run, api.config);
      }
      // Keep the run until the in-flight creation/deletion has had a chance to
      // finish; otherwise a late Telegram response creates an orphan.
      const cleanup = run.messageCreation ?? Promise.resolve();
      void cleanup.finally(() => {
        runs.delete(runId);
        inboundTargets.delete(runId);
        inboundLocales.delete(runId);
      });
    });
  },
});

async function updateMessage(
  run: RunContext,
  cfg: unknown,
  locale: Locale | "auto",
  templates: Partial<Record<TemplateKey, string>>,
) {
  if (!run.message || !run.target) return;
  const text = render(run, locale, templates);
  if (text === run.lastRendered) return;
  try {
    await editTelegramStatus(cfg, run.message, run.target, text);
    run.lastRendered = text;
  } catch {
    // A transient edit failure must not break the agent run.
  }
}

async function deleteStatusMessage(run: RunContext, cfg: unknown) {
  if (!run.message || !run.target) return;
  try {
    await deleteTelegramStatus(cfg, run.message, run.target);
    run.message = undefined;
  } catch {
    // Cleanup is best-effort; the final agent answer is still sent separately.
  }
}
