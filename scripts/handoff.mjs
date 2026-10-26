#!/usr/bin/env node
// Jev handoff: prunes a Claude Code session transcript with Jev and opens a
// new session that receives the kept messages verbatim as an appended system
// prompt. It uses no hooks, so it works where session.compact hooks are skipped.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compact, JevClient, reductionRatio } from '../dist/index.js';

const KEY_ENVS = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'OPENCODE_API_KEY'];
const BASE_URLS = {
  OPENROUTER_API_KEY: 'https://openrouter.ai/api/v1/systemone',
  TYPESAFE_API_KEY: 'https://api.typesafe.ai/v1/systemone',
  OPENCODE_API_KEY: 'https://opencode.ai/zen/v1/systemone',
};

function parseArgs(argv) {
  const args = {
    session: process.env.CLAUDE_CODE_SESSION_ID,
    configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    cwd: process.cwd(),
    keyEnv: KEY_ENVS.find((name) => process.env[name]),
    baseUrl: undefined,
    model: undefined,
    preserve: 6,
    threshold: 0.5,
    launch: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === '--session') args.session = value();
    else if (flag === '--config-dir') args.configDir = value();
    else if (flag === '--cwd') args.cwd = value();
    else if (flag === '--key-env') args.keyEnv = value();
    else if (flag === '--base-url') args.baseUrl = value();
    else if (flag === '--model') args.model = value();
    else if (flag === '--preserve') args.preserve = Number(value());
    else if (flag === '--threshold') args.threshold = Number(value());
    else if (flag === '--no-launch') args.launch = false;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!args.session) throw new Error('no session id: pass --session or run inside Claude Code');
  if (!args.keyEnv || !process.env[args.keyEnv]) {
    throw new Error(`no API key: set one of ${KEY_ENVS.join(', ')}`);
  }
  args.baseUrl ??= BASE_URLS[args.keyEnv];
  return args;
}

function findTranscript(configDir, session) {
  const projects = join(configDir, 'projects');
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${session}.jsonl`);
    if (existsSync(file)) return file;
  }
  throw new Error(`transcript ${session}.jsonl not found under ${projects}`);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

/** Main-chain user and assistant entries as library messages, after the last compaction. */
export function readMessages(file) {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const boundary = rows.findLastIndex((row) => row.type === 'system' && row.subtype === 'compact_boundary');
  const messages = [];
  const byId = new Map();
  for (const row of rows.slice(boundary + 1)) {
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isSidechain) continue;
    const content = row.message?.content;
    if (row.type === 'assistant') {
      const id = row.message?.id ?? row.uuid;
      let message = byId.get(id);
      if (!message) {
        message = { role: 'assistant', text: '', toolUses: [] };
        byId.set(id, message);
        messages.push(message);
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'text') message.text += (message.text ? '\n' : '') + block.text;
        else if (block.type === 'tool_use') {
          message.toolUses.push({ tool_use_id: block.id, tool: block.name, input: block.input ?? {} });
        }
      }
      continue;
    }
    const message = { role: 'user', text: '', toolUses: [] };
    if (typeof content === 'string') message.text = content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'text') message.text += (message.text ? '\n' : '') + block.text;
      else if (block.type === 'tool_result') {
        (message.toolResults ??= []).push({
          tool_use_id: block.tool_use_id,
          text: resultText(block.content),
          isError: block.is_error === true,
        });
      }
    }
    if (message.text || message.toolResults) messages.push(message);
  }
  // A tool call without its result (an interrupted turn) cannot be judged; drop it.
  const answered = new Set(messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id)));
  for (const message of messages) {
    message.toolUses = message.toolUses.filter((tool) => answered.has(tool.tool_use_id));
  }
  return messages.filter((m) => m.text || m.toolUses.length > 0 || m.toolResults);
}

function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

/** The kept messages as Markdown, every text and kept result verbatim. */
export function render(messages, source) {
  const results = new Map();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) results.set(result.tool_use_id, result);
  }
  const parts = [
    '# Contexto da sessão anterior',
    '',
    `Esta sessão continua a sessão ${source}. O texto abaixo é o histórico dela, sem resumo.`,
    'O Jev removeu as chamadas de ferramenta e os resultados que não eram mais necessários.',
    'Continue o trabalho a partir da última mensagem. Não repita trabalho que o histórico mostra como feito.',
    '',
  ];
  for (const message of messages) {
    const lines = [];
    if (message.text) lines.push(message.text);
    for (const tool of message.toolUses) {
      lines.push(`**${tool.tool}** ${fence(JSON.stringify(tool.input, null, 1))}`);
      const result = results.get(tool.tool_use_id);
      if (result) lines.push(`Resultado${result.isError ? ' (erro)' : ''}:\n${fence(result.text)}`);
    }
    if (lines.length === 0) continue;
    parts.push(`## ${message.role === 'user' ? 'Usuário' : 'Assistente'}`, '', lines.join('\n\n'), '');
  }
  return parts.join('\n');
}

function launch(args, file) {
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  // Set CLAUDE_CONFIG_DIR only for a non-default profile: with it set, Claude
  // Code reads .claude.json from inside that folder instead of the home folder.
  const command = [
    process.env.CLAUDE_CONFIG_DIR ? `$env:CLAUDE_CONFIG_DIR = ${quote(args.configDir)}` : '',
    `Set-Location -LiteralPath ${quote(args.cwd)}`,
    `claude --append-system-prompt-file ${quote(file)}`,
  ]
    .filter(Boolean)
    .join('; ');
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'pwsh', '-NoExit', '-Command', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return command;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const transcript = findTranscript(args.configDir, args.session);
  const messages = readMessages(transcript);
  const client = new JevClient({ apiKey: process.env[args.keyEnv], baseUrl: args.baseUrl, model: args.model });
  const result = await compact(messages, client, {
    preserveRecentMessages: args.preserve,
    keepThreshold: args.threshold,
  });
  const markdown = render(result.messages, args.session);
  const dir = join(args.configDir, 'jev-handoffs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${args.session}-${Date.now()}.md`);
  writeFileSync(file, markdown, 'utf8');
  const { stats } = result;
  console.log(
    `jev-handoff: ${stats.messagesBefore} → ${stats.messagesAfter} messages, ` +
      `${stats.charsBefore} → ${stats.charsAfter} chars (${Math.round(reductionRatio(result) * 100)}% reduction); ` +
      `${stats.kept} kept, ${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped, ` +
      `${stats.pinned} pinned; ${stats.requests} Jev request(s), state ${stats.stateStage}`,
  );
  const judged = result.decisions.filter((d) => d.reason !== 'pinned');
  const top = [...judged].sort((a, b) => b.keepCall - a.keepCall).slice(0, 5);
  console.log(
    `top keepCall: ${top.map((d) => `${d.id}:${d.tool}=${d.keepCall.toFixed(2)}/${d.keepResult.toFixed(2)}`).join(' ') || '(none)'}`,
  );
  console.log(`file: ${file}`);
  if (args.launch) console.log(`opened: ${launch(args, file)}`);
  else console.log(`run: claude --append-system-prompt-file "${file}"`);
}

main().catch((error) => {
  console.error(`jev-handoff failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
