import type { ActivitySnapshot } from "./activity.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type TelegramTarget = {
  chatId: string;
  accountId?: string;
  threadId?: string | number;
  replyToId?: string;
};

type TelegramMessageRef = { chatId: string; messageId: string };

type TelegramRuntime = {
  resolveTelegramToken: (cfg: unknown, opts?: { accountId?: string }) => { token?: string };
  sendMessageTelegram: (to: string, text: string, opts: Record<string, unknown>) => Promise<{ messageId: string; chatId: string }>;
  editMessageTelegram: (chatId: string, messageId: string, text: string, opts: Record<string, unknown>) => Promise<unknown>;
  deleteMessageTelegram: (chatId: string, messageId: string, opts: Record<string, unknown>) => Promise<unknown>;
};

let runtimePromise: Promise<TelegramRuntime> | undefined;

export async function loadTelegramRuntime(): Promise<TelegramRuntime> {
  if (!runtimePromise) {
    // The Telegram runtime is shipped as a channel extension, not as a public
    // package export. Resolve its installed artifact without relying on a
    // package-export bypass; keep this private seam isolated in this adapter.
    const require = createRequire(import.meta.url);
    const openclawEntry = require.resolve("openclaw");
    const packageRoot = dirname(dirname(openclawEntry));
    const runtimePath = join(packageRoot, "dist/extensions/telegram/runtime-api.js");
    runtimePromise = import(pathToFileURL(runtimePath).href) as Promise<TelegramRuntime>;
  }
  return runtimePromise;
}

function threadNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export async function createTelegramStatus(cfg: unknown, target: TelegramTarget, text: string): Promise<TelegramMessageRef> {
  const runtime = await loadTelegramRuntime();
  const token = runtime.resolveTelegramToken(cfg, { accountId: target.accountId }).token;
  if (!token) throw new Error("Telegram token is unavailable");
  const result = await runtime.sendMessageTelegram(target.chatId, text, {
    cfg,
    token,
    accountId: target.accountId,
    textMode: "plain",
    messageThreadId: threadNumber(target.threadId),
    replyToMessageId: target.replyToId ? Number(target.replyToId) : undefined,
  });
  return { chatId: result.chatId, messageId: result.messageId };
}

export async function editTelegramStatus(cfg: unknown, ref: TelegramMessageRef, target: TelegramTarget, text: string): Promise<void> {
  const runtime = await loadTelegramRuntime();
  const token = runtime.resolveTelegramToken(cfg, { accountId: target.accountId }).token;
  if (!token) throw new Error("Telegram token is unavailable");
  await runtime.editMessageTelegram(ref.chatId, ref.messageId, text, {
    cfg,
    token,
    accountId: target.accountId,
    textMode: "plain",
  });
}

export async function deleteTelegramStatus(cfg: unknown, ref: TelegramMessageRef, target: TelegramTarget): Promise<void> {
  const runtime = await loadTelegramRuntime();
  const token = runtime.resolveTelegramToken(cfg, { accountId: target.accountId }).token;
  if (!token) throw new Error("Telegram token is unavailable");
  await runtime.deleteMessageTelegram(ref.chatId, ref.messageId, {
    cfg,
    token,
    accountId: target.accountId,
  });
}

export function isTelegramContext(channel?: string, messageProvider?: string): boolean {
  return channel === "telegram" || channel?.startsWith("telegram:") === true || messageProvider === "telegram";
}

export type StatusTargetLike = {
  chatId?: string;
  conversationId?: string;
  channelContext?: { chat?: { id?: string } };
  accountId?: string;
  threadId?: string | number;
  messageId?: string;
  sessionKey?: string;
};

export function targetFromInbound(event: StatusTargetLike & { from?: string }): TelegramTarget | undefined {
  const chatId = event.chatId ?? event.conversationId ?? event.channelContext?.chat?.id;
  if (!chatId) return undefined;
  return {
    chatId,
    accountId: event.accountId,
    threadId: event.threadId,
    replyToId: event.messageId,
  };
}

export function targetFromAgentContext(ctx: StatusTargetLike): TelegramTarget | undefined {
  const chatId = ctx.chatId ?? ctx.conversationId ?? ctx.channelContext?.chat?.id;
  if (chatId) return { chatId, accountId: ctx.accountId, threadId: ctx.threadId };

  // Agent/model hooks in OpenClaw 2026.9 may omit chatId while preserving the
  // canonical session key, e.g. agent:main:telegram:group:-100...:topic:1.
  const key = ctx.sessionKey;
  const topic = key?.match(/:telegram:group:(-?\d+):topic:(\d+)$/u);
  if (topic) return { chatId: topic[1], accountId: ctx.accountId, threadId: topic[2] };
  const group = key?.match(/:telegram:group:(-?\d+)$/u);
  if (group) return { chatId: group[1], accountId: ctx.accountId };
  const direct = key?.match(/:telegram:(-?\d+)$/u);
  return direct ? { chatId: direct[1], accountId: ctx.accountId } : undefined;
}

export function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
}

export function statusSnapshotForLog(snapshot: ActivitySnapshot): Record<string, unknown> {
  return {
    phase: snapshot.phase,
    kind: snapshot.kind,
    name: snapshot.name ? safeToolName(snapshot.name) : undefined,
    modelCalls: snapshot.modelCalls,
    modelRetries: snapshot.modelRetries,
    toolCalls: snapshot.toolCalls,
    toolRetries: snapshot.toolRetries,
  };
}
