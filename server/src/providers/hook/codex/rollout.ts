/**
 * Codex rollout-record normalization — the single Codex-specific boundary.
 *
 * Codex writes one JSON record per line to
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`. Every record is
 * `{ timestamp, type, payload }`; `event_msg` and `response_item` discriminate
 * further on `payload.type`.
 *
 * Everything downstream sees only `AgentEvent`. Both `parseTranscriptLine` (file
 * fallback) and `normalizeHookEvent` (pushed events) delegate here, so a future
 * push-based Codex source needs no second mapping.
 *
 * Codex exposes no approval/permission events in its rollout log, so no
 * `permissionRequest` is ever produced from a transcript. A stuck Codex agent can
 * only be surfaced by whatever launched it.
 */

import type { AgentEvent } from '../../../../../core/src/provider.js';

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Codex `agent_path` is a slash-delimited thread path ("/root/review_scroll_fix").
 *  The last segment is the human-meaningful name. */
function subagentName(agentPath: string | undefined): string {
  if (!agentPath) return 'subagent';
  const segments = agentPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'subagent';
}

/** `function_call.arguments` is a JSON-encoded string. Malformed JSON is kept as
 *  the raw string rather than dropped — a mis-encoded argument should still show
 *  the tool as running. */
function parseArguments(raw: unknown): unknown {
  const text = asString(raw);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toolEnd(payload: UnknownRecord): AgentEvent | null {
  const callId = asString(payload.call_id);
  return callId ? { kind: 'toolEnd', toolId: callId } : null;
}

function normalizeEventMsg(payload: UnknownRecord): AgentEvent | null {
  switch (payload.type) {
    // A turn that was interrupted still ended; the office must stop animating.
    case 'task_complete':
    case 'turn_aborted':
      return { kind: 'turnEnd' };

    // Emitted alongside custom_tool_call_output for apply_patch. Ending twice is
    // idempotent downstream; a missed end would strand the typing animation.
    case 'patch_apply_end':
      return toolEnd(payload);

    case 'sub_agent_activity': {
      const eventId = asString(payload.event_id);
      if (!eventId) return null;
      if (payload.kind === 'started') {
        return {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: eventId,
          toolName: subagentName(asString(payload.agent_path)),
        };
      }
      if (payload.kind === 'completed' || payload.kind === 'failed') {
        return { kind: 'subagentEnd', parentToolId: 'current', toolId: eventId };
      }
      return null;
    }

    default:
      return null;
  }
}

function normalizeResponseItem(payload: UnknownRecord): AgentEvent | null {
  switch (payload.type) {
    // Codex's two tool mechanisms. `custom_tool_call` carries a raw `input`
    // string (shell script, patch blob); `function_call` carries JSON `arguments`.
    case 'custom_tool_call': {
      const callId = asString(payload.call_id);
      if (!callId) return null;
      return {
        kind: 'toolStart',
        toolId: callId,
        toolName: asString(payload.name) ?? '',
        input: payload.input,
      };
    }

    case 'function_call': {
      const callId = asString(payload.call_id);
      if (!callId) return null;
      return {
        kind: 'toolStart',
        toolId: callId,
        toolName: asString(payload.name) ?? '',
        input: parseArguments(payload.arguments),
      };
    }

    case 'custom_tool_call_output':
    case 'function_call_output':
      return toolEnd(payload);

    default:
      return null;
  }
}

/**
 * Normalize one parsed rollout record into an `AgentEvent`.
 * Returns null for records with no office-visible meaning, and for anything
 * malformed — a partially-written line must never throw the watcher.
 */
export function normalizeRolloutRecord(raw: unknown): AgentEvent | null {
  const record = asRecord(raw);
  if (!record) return null;

  const payload = asRecord(record.payload);

  switch (record.type) {
    case 'session_meta': {
      if (!payload) return null;
      return {
        kind: 'sessionStart',
        source: asString(payload.source),
        cwd: asString(payload.cwd),
      };
    }

    case 'event_msg':
      return payload ? normalizeEventMsg(payload) : null;

    case 'response_item':
      return payload ? normalizeResponseItem(payload) : null;

    default:
      return null;
  }
}

/**
 * Session id for a record, or null if it carries none.
 *
 * Only `session_meta` — the first line of a rollout file — identifies the
 * session; every later record is anonymous and is attributed by the file it
 * came from.
 */
export function sessionIdFromRecord(raw: unknown): string | null {
  const record = asRecord(raw);
  if (!record || record.type !== 'session_meta') return null;

  const payload = asRecord(record.payload);
  if (!payload) return null;

  return asString(payload.session_id) ?? asString(payload.id) ?? null;
}
