# opencode-local-plugins

Small, opinionated [OpenCode](https://github.com/anomalyco/opencode) plugins that patch
harness behaviour I hit every day. They are loaded from the OpenCode plugins directory, so
there is nothing to publish and no entry in `plugins[]`.

| Plugin | What it does |
| --- | --- |
| [`auto-approve.ts`](plugins/auto-approve.ts) | Turns every permission evaluation that would resolve to `ask` into `allow`, so background sessions do not hang waiting for a TUI that never has focus. An explicit `deny` never reaches the hook, so it stays as the kill switch. |
| [`local-model-variants.ts`](plugins/local-model-variants.ts) | Completes models that arrive through local provider discovery (`vllm`, `ollama`): copies reasoning-effort variants, `tools` and a larger `limit.output` from the same base model published by any other provider in the registry. |

## Install

```bash
git clone https://github.com/fede-ciliberti/opencode-local-plugins.git
cd opencode-local-plugins
./install.sh
```

`install.sh` symlinks every `plugins/*.ts` into
`${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins/`, which OpenCode scans on startup.
An existing regular file with the same name is backed up to `<name>.bak-<timestamp>` before
the link is created. Restart OpenCode afterwards.

## Why these exist

### `auto-approve.ts`

Plugin-defined agents declare permission lists without a trailing wildcard, so anything they
do not enumerate (`external_directory`, `websearch`, `skill`, `subagent`, MCP tools,
`execute`, ...) falls into the default `ask`. In the TUI an `ask` is only answered when the
tab has focus, which means a session running in the background can hang forever. The hook
runs in the server, not the client, so it does not depend on focus.

### `local-model-variants.ts`

Local provider discovery only reports `id`, `owned_by` and `max_model_len`. OpenCode builds
the model from that alone: no capabilities, no reasoning variants, default limits. The plugin
looks the discovered id up in the rest of the registry (the models.dev catalog plus your own
configured providers) and copies:

- reasoning efforts, re-spelled for the local provider package as `settings.reasoningEffort`
  (which reaches the wire as `reasoning_effort`),
- `tools: true` when the base model supports tools,
- `limit.output` when the base model declares a larger one.

The context limit is left alone: the gateway's `max_model_len` is authoritative. Name
matching tries, in order: exact id, id with an operational suffix removed (`-pool`, `-alias`,
`-vm`, `-lb`, `-group`, `-balance`, `-router`), then the longest prefix closed by a
separator. Declaring a new virtual model on the gateway is therefore enough: no per-model
block in `opencode.json`.

## Requirements

- OpenCode v2 plugin API (`ctx.permission.hook`, `ctx.model.transform`).
- A provider whose models are discovered from a local endpoint, for
  `local-model-variants.ts` to have anything to do.

## License

MIT.
