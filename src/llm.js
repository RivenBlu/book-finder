// Claude via the Agent SDK, authenticated with the local Claude Code login (Max subscription).
// No API key is used. Credentials that would override the subscription login are stripped from the child env.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getSetting } from './db.js';

const STRIP = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

function childEnv() {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  for (const k of STRIP) delete env[k];
  return env;
}

export const MODELS = {
  fast: 'claude-haiku-5-5',
  smart: 'claude-sonnet-5-5',
  best: 'claude-opus-5-5',
  max: 'claude-fable-5-1',
};

// Simple concurrency gate: each query() spawns a CLI subprocess; keep a few in flight.
let active = 0;
const waiters = [];
const LIMIT = 3;
async function gate() {
  if (active < LIMIT) { active++; return; }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() { active--; const w = waiters.shift(); if (w) w(); }

/**
 * ask(): one-shot structured or text completion.
 * @param {object} p
 * @param {string} p.system  system prompt
 * @param {string} p.prompt  user prompt
 * @param {object} [p.schema] JSON schema; when given, returns parsed structured_output
 * @param {'fast'|'smart'|'best'|'max'} [p.tier]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [p.effort]
 * @param {boolean} [p.web] allow WebSearch/WebFetch
 * @param {number} [p.maxTurns]
 * @param {(ev:object)=>void} [p.onEvent] progress callback (tool uses, text deltas)
 */
export async function ask({ system, prompt, schema, tier = 'smart', effort = 'medium', web = false, maxTurns, onEvent }) {
  const model = resolveModel(tier);
  await gate();
  const t0 = Date.now();
  try {
    const options = {
      systemPrompt: system,
      model,
      effort,
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: web ? ['WebSearch', 'WebFetch'] : [],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Agent', 'TaskStop', 'NotebookEdit',
        'CronCreate', 'CronDelete', 'CronList', 'Skill', 'Workflow', 'SendMessage', 'ListAgents', 'Monitor', 'RemoteTrigger',
        'PushNotification', 'ScheduleWakeup', 'EnterWorktree', 'ExitWorktree', 'DesignSync', 'ReportFindings', 'ToolSearch']
        .concat(web ? [] : ['WebSearch', 'WebFetch']),
      permissionMode: 'dontAsk',
      maxTurns: maxTurns ?? (web ? 12 : 3),
      env: childEnv(),
      includePartialMessages: !!onEvent,
    };
    if (schema) options.outputFormat = { type: 'json_schema', schema };
    let text = '';
    let result = null;
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content || []) {
          if (b.type === 'tool_use' && onEvent) onEvent({ type: 'tool', name: b.name, input: b.input });
          if (b.type === 'text') text += b.text;
        }
      } else if (msg.type === 'stream_event' && onEvent) {
        const ev = msg.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onEvent({ type: 'delta', text: ev.delta.text });
      } else if (msg.type === 'result') {
        result = msg;
      }
    }
    if (!result) throw new Error('LLM: stream ended without result');
    if (result.subtype !== 'success') {
      throw new Error(`LLM run failed (${result.subtype}): ${result.errors?.join('; ') || result.result || ''}`);
    }
    const meta = { model, ms: Date.now() - t0, turns: result.num_turns, costEstimateUsd: result.total_cost_usd, sessionId: result.session_id };
    if (schema) {
      if (result.structured_output == null) throw new Error('LLM: no structured output returned');
      return { data: result.structured_output, meta };
    }
    return { data: result.result ?? text, meta };
  } finally {
    release();
  }
}

export function resolveModel(tier) {
  const override = getSetting('model_' + tier);
  return override || MODELS[tier] || MODELS.smart;
}
