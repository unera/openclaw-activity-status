import type { ActivitySnapshot } from "./activity.js";

export type Locale = "ru" | "en";
export type TemplateKey = "working" | "current" | "modelStats" | "toolStats" | "done" | "error";

export const defaultTemplates: Record<Locale, Record<TemplateKey, string>> = {
  ru: {
    working: "**{model}**: {elapsed}",
    current: "Вызовы: {modelCalls}/{modelRetries}, действия: {toolCalls}/{toolRetries}",
    modelStats: "",
    toolStats: "",
    done: "**{model}**: {elapsed}",
    error: "**{model}**: {elapsed}",
  },
  en: {
    working: "**{model}**: {elapsed}",
    current: "Calls: {modelCalls}/{modelRetries}, actions: {toolCalls}/{toolRetries}",
    modelStats: "",
    toolStats: "",
    done: "**{model}**: {elapsed}",
    error: "**{model}**: {elapsed}",
  },
};

export function formatElapsed(startedAt: number, now = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${totalSeconds} секунд`;
}

export function renderTemplate(template: string, values: Record<string, string | number | undefined>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key: string) => String(values[key] ?? "—"));
}

export function renderStatus(
  snapshot: ActivitySnapshot,
  locale: Locale,
  now = Date.now(),
  overrides: Partial<Record<TemplateKey, string>> = {},
): string {
  const templates = { ...defaultTemplates[locale], ...overrides };
  const values = {
    elapsed: formatElapsed(snapshot.startedAt, now),
    kind: snapshot.kind ?? "—",
    name: snapshot.name ?? "—",
    model: snapshot.model ?? "default",
    phase: snapshot.phase ?? "—",
    ...snapshot,
  };
  const heading = snapshot.outcome === "completed"
    ? templates.done
    : snapshot.outcome === "error" || snapshot.outcome === "aborted"
      ? templates.error
      : templates.working;
  return [
    renderTemplate(heading, values),
    renderTemplate(templates.current, values),
  ].filter(Boolean).join("\n");
}
