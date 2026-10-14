# OpenClaw Activity Status

OpenClaw plugin for showing elapsed time and safe model/tool activity while a
long-running agent turn is active.

The first milestone contains channel-neutral activity state, counters, and
localized editable templates. Telegram message delivery is deliberately kept
as a separate adapter so the project can later support channels that can edit
messages in threads. The current runtime adapter supports Telegram chats and
forum topics.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The current OpenClaw `plugins validate` and `plugins pack` commands are
authoring commands for tool/feature plugins and reject hook-only plugins such
as this one. They are not used as a runtime proof here; use the build, unit
tests, and smoke test below until the host exposes a general hook-plugin
validator.

Runtime smoke test (after `npm run build`):

```bash
node --input-type=module <<'NODE'
import entry from "./dist/index.js";
const hooks = new Map();
entry.register({ pluginConfig: {}, config: {}, logger: { warn() {} }, on(name, fn) { hooks.set(name, fn); } });
console.log([...hooks.keys()]);
NODE
```

## Supported template variables

`{elapsed}`, `{kind}`, `{name}`, `{phase}`, `{modelCalls}`, `{modelRetries}`,
`{toolCalls}`, `{toolRetries}`.

Tool arguments are never passed to the renderer.

`locale` accepts `ru`, `en`, or `auto`; in `auto`, Cyrillic inbound text selects
Russian and other text selects English. User templates override only the keys
they provide. Telegram message edits use plain text so model/tool names cannot
inject Markdown formatting.
