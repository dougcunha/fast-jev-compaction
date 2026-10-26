import type {
  Hook,
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  apiKeyEnv: 'TYPESAFE_API_KEY',
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  /** Environment variable that holds the key: one of `API_KEY_ENVS`. */
  apiKeyEnv: string;
  /** System One endpoint, e.g. `https://openrouter.ai/api/v1/systemone`. */
  baseUrl?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    apiKeyEnv: optionString(options, 'apiKeyEnv') ?? HOOK_DEFAULTS.apiKeyEnv,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error(`${config.apiKeyEnv} is not configured`);
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/** The variables the key can come from; `$.env.get` takes literal names only. */
export const API_KEY_ENVS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY'] as const;

function envKey(
  $: { env: { get: (name: string) => Promise<string | undefined> } },
  name: string,
): Promise<string | undefined> {
  switch (name) {
    case 'OPENROUTER_API_KEY':
      return $.env.get('OPENROUTER_API_KEY');
    case 'OPENCODE_API_KEY':
      return $.env.get('OPENCODE_API_KEY');
    case 'TYPESAFE_API_KEY':
      return $.env.get('TYPESAFE_API_KEY');
    default:
      throw new Error(`apiKeyEnv must be one of ${API_KEY_ENVS.join(', ')}, got ${name}`);
  }
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await envKey($, config.apiKeyEnv);
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)[config.apiKeyEnv];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

const HANDOFF_COMMAND = 'jev-handoff';
const HANDOFF_DELAY_MS = 100;
const SWITCH_POLL_MS = 100;
const SWITCH_LIMIT_MS = 3_000;
const INLINE_SEED_MAX_CHARS = 100_000;

type Api = Parameters<Hook<'command.run'>>[0];

/** The keep threshold given as `/jev-handoff 0.3`; anything else keeps the configured one. */
export function handoffThreshold(args: string): number | undefined {
  const text = args.trim();
  const value = Number(text);
  return text !== '' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

/** The kept messages as Markdown: every text and kept tool result verbatim. */
export function renderHandoff(messages: readonly Message[], source: string): string {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result);
  }
  const parts = [
    '# Previous session',
    '',
    `This session continues session ${source}. Below is its history, not summarized:`,
    'Jev removed the tool calls and tool results that were no longer needed.',
    'Continue from the last message. Do not redo work that the history shows as done.',
    '',
  ];
  for (const message of messages) {
    const lines: string[] = [];
    if (message.text) lines.push(message.text);
    for (const tool of message.toolUses) {
      lines.push(`**${tool.tool}** ${fence(JSON.stringify(tool.input, null, 1))}`);
      const result = results.get(tool.tool_use_id);
      const text = result?.text ?? tool.text;
      if (text !== undefined) {
        const error = (result?.isError ?? tool.isError) === true;
        lines.push(`Result${error ? ' (error)' : ''}:\n${fence(text)}`);
      }
    }
    if (lines.length === 0) continue;
    parts.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '', lines.join('\n\n'), '');
  }
  return parts.join('\n');
}

/** The first prompt of the new session: the history inline, or a pointer to its file when too long. */
export function handoffSeed(markdown: string, file: string, count: number): string {
  const reply = `Reply with one line, "Context loaded: ${count} messages.", and wait for the next instruction.`;
  if (markdown.length <= INLINE_SEED_MAX_CHARS) return `${markdown}\n\n---\n\n${reply}`;
  return `The history of the previous session is in ${file}. Read the whole file first. ${reply}`;
}

async function handoffFile($: Api, sessionId: string): Promise<string> {
  const dir = (await $.env.get('TEMP')) ?? (await $.session.cwd());
  return `${dir}/jev-handoff-${sessionId}-${await $.clock.now()}.md`;
}

async function waitForSessionSwitch($: Api, endedId: string): Promise<void> {
  for (let waited = 0; waited < SWITCH_LIMIT_MS; waited += SWITCH_POLL_MS) {
    await $.clock.sleep(SWITCH_POLL_MS);
    if ((await $.session.id()) !== endedId) return;
  }
}

/**
 * Prunes the session with Jev, writes the kept history to a file, clears the
 * session and submits the history as the new session's first prompt. Nothing
 * is cleared before the file exists, so a failure loses nothing.
 */
async function runHandoff($: Api, configured: HookConfig, threshold: number | undefined): Promise<void> {
  const sessionId = await $.session.id();
  const messages = await $.session.messages();
  const config = {
    ...configured,
    ...(threshold === undefined ? {} : { keepThreshold: threshold }),
    apiKey: await getApiKey($, configured),
  };
  const { result } = await compactSession(messages, config, async (url, init) => {
    const response = await $.http.fetch(url, init);
    return { status: response.status, ok: response.ok, text: response.text };
  });
  for (const line of decisionLogLines(result)) $.ui.log(line);
  const markdown = renderHandoff(result.messages, sessionId);
  const file = await handoffFile($, sessionId);
  await $.fs.write(file, markdown);
  notify($, `handoff: kept ${result.messages.length}/${messages.length} messages (${summarize(result)}); ${file}`);
  await $.command.run({ command: 'clear', args: '' });
  await waitForSessionSwitch($, sessionId);
  try {
    await $.prompt.submit({ text: handoffSeed(markdown, file, result.messages.length) });
  } catch (error) {
    notify(
      $,
      `handoff: the history is in ${file}; the first prompt failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('session.start', async ($, event, next) => {
    try {
      await $.command.register({
        name: HANDOFF_COMMAND,
        description: 'Prune the session with Jev and continue it in a new session, without a summary',
        argumentHint: '[keep threshold 0-1]',
      });
    } catch (error) {
      $.ui.log(`/${HANDOFF_COMMAND} unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
    return next(event);
  });

  on('command.run', { command: HANDOFF_COMMAND }, async ($, event) => {
    const threshold = handoffThreshold(event.args);
    // $.command.run rejects inside a hook the turn waits on, so the work runs after it.
    $.clock.after(HANDOFF_DELAY_MS, () => {
      runHandoff($, configured, threshold).catch((error: unknown) => {
        notify($, `handoff failed (${error instanceof Error ? error.message : String(error)})`);
      });
    });
    return { text: 'fast-jev-compaction: pruning the session with Jev for a new session…' };
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
