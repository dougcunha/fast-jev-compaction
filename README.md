# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

> This is a fork of
> [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
> It adds two plugin options, `baseUrl` and `apiKeyEnv`, so the plugin can call
> Jev through [OpenRouter](#other-system-one-providers) or OpenCode Zen, and a
> [handoff script](#handoff-to-a-new-session) that continues a session in a new
> one when `session.compact` hooks cannot run.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add dougcunha/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-local
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

### Other System One providers

OpenRouter and OpenCode Zen serve Jev through the same System One protocol
(`POST …/systemone` with `model`, `state` and `questions`). Two plugin options
select the provider:

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | Environment variable that holds the key: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` or `OPENCODE_API_KEY` |

| Provider | `baseUrl` | `apiKeyEnv` | Models |
| --- | --- | --- | --- |
| TypeSafe | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` |
| OpenRouter | `https://openrouter.ai/api/v1/systemone` | `OPENROUTER_API_KEY` | `jev-latest` (mapped to `~typesafe/jev-latest`) |
| OpenCode Zen | `https://opencode.ai/zen/v1/systemone` | `OPENCODE_API_KEY` | `jev-1.13`, `jev-1.13-free` (set `model`) |

Set them at install time:

```sh
claude plugin install fast-jev-compaction@fast-jev-local   --config baseUrl=https://openrouter.ai/api/v1/systemone   --config apiKeyEnv=OPENROUTER_API_KEY
```

or later with `/plugin configure fast-jev-compaction@fast-jev-local`. The
sensitive `apiKey` option, when set, wins over the environment variable.
`$.env.get` accepts literal names only, so `apiKeyEnv` is limited to the three
names above.

### Handoff to a new session

Some setups skip user-tier `session.compact` hooks (for example, a managed
plugin in the `prepend` tier that sends the event past them), so the plugin
never runs and `/compact` falls back to the built-in summary. The handoff
script does not use hooks: it reads the session transcript, prunes it with the
same library, writes the kept messages verbatim to a Markdown file and opens a
new Claude Code session that receives the file with
`--append-system-prompt-file`.

```sh
npm ci && npm run build   # once: the script imports dist/
node scripts/handoff.mjs [--threshold 0.3] [--preserve 6] [--no-launch]
```

Run it from a Bash tool call inside the session to hand off (it reads
`CLAUDE_CODE_SESSION_ID`), or pass `--session <id>`. Other options:
`--config-dir` (defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`), `--cwd`,
`--key-env`, `--base-url` and `--model`. The key comes from the first of
`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` and `OPENCODE_API_KEY` that is set,
and `--base-url` defaults to that provider's endpoint. The file goes to
`<config dir>/jev-handoffs/`. The new window is opened with PowerShell
(`pwsh`), so the launch is Windows-only; with `--no-launch` the script prints
the `claude` command instead.

A user-level skill makes it a slash command, e.g.
`~/.claude/skills/jev-handoff/SKILL.md` with `disable-model-invocation: true`
that tells Claude to run the script with `$ARGUMENTS`.

Limitations: the new session gets the history as one block of system prompt
text, not as structured turns; the file rides on every request (the prompt
cache makes the later ones cheaper); todos, panes and plugin state do not carry
over. The default `keepThreshold` of 0.5 can drop every tool call of a long
session, because only user and assistant text is always kept; lower it with
`--threshold` to keep more results.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
