import { describe, expect, it } from 'vitest';

import {
  normalizeRolloutRecord,
  sessionIdFromRecord,
} from '../src/providers/hook/codex/rollout.js';

/**
 * Record shapes below mirror real `~/.codex/sessions/**\/rollout-*.jsonl` output
 * (Codex CLI, 2026-08). Every record is `{ timestamp, type, payload }`; `event_msg`
 * and `response_item` discriminate further on `payload.type`.
 */

const meta = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-08-05T18:04:28.000Z',
  type: 'session_meta',
  payload: {
    session_id: '019fd42b-d006-7cc3-9b3d-5276a2000342',
    id: '019fd42b-d006-7cc3-9b3d-5276a2000342',
    cwd: '/Users/owner/project',
    originator: 'codex_cli_rs',
    cli_version: '0.1.0',
    source: 'cli',
    ...over,
  },
});

const evt = (type: string, payload: Record<string, unknown> = {}) => ({
  timestamp: '2026-08-05T18:04:30.000Z',
  type: 'event_msg',
  payload: { type, ...payload },
});

const item = (type: string, payload: Record<string, unknown> = {}) => ({
  timestamp: '2026-08-05T18:04:30.000Z',
  type: 'response_item',
  payload: { type, ...payload },
});

describe('normalizeRolloutRecord', () => {
  describe('session lifecycle', () => {
    it('maps session_meta to sessionStart carrying cwd', () => {
      expect(normalizeRolloutRecord(meta())).toEqual({
        kind: 'sessionStart',
        source: 'cli',
        cwd: '/Users/owner/project',
      });
    });

    it('omits cwd when session_meta has none rather than emitting undefined-as-present', () => {
      const record = meta();
      delete (record.payload as Record<string, unknown>).cwd;
      const event = normalizeRolloutRecord(record);
      expect(event).toMatchObject({ kind: 'sessionStart' });
      expect((event as { cwd?: string }).cwd).toBeUndefined();
    });

    it('maps task_complete to turnEnd', () => {
      expect(normalizeRolloutRecord(evt('task_complete', { turn_id: '3' }))).toEqual({
        kind: 'turnEnd',
      });
    });

    it('maps turn_aborted to turnEnd — an interrupted turn still ends', () => {
      expect(
        normalizeRolloutRecord(evt('turn_aborted', { turn_id: '2', reason: 'interrupted' })),
      ).toEqual({ kind: 'turnEnd' });
    });
  });

  describe('custom_tool_call (exec / apply_patch)', () => {
    it('maps custom_tool_call to toolStart keyed by call_id', () => {
      expect(
        normalizeRolloutRecord(
          item('custom_tool_call', {
            call_id: 'call_abc',
            name: 'exec',
            input: 'ls -la',
            status: 'in_progress',
          }),
        ),
      ).toEqual({
        kind: 'toolStart',
        toolId: 'call_abc',
        toolName: 'exec',
        input: 'ls -la',
      });
    });

    it('maps custom_tool_call_output to toolEnd for the same call_id', () => {
      expect(
        normalizeRolloutRecord(
          item('custom_tool_call_output', { call_id: 'call_abc', output: [{ type: 'text' }] }),
        ),
      ).toEqual({ kind: 'toolEnd', toolId: 'call_abc' });
    });

    it('ignores a custom_tool_call with no call_id — it can never be ended', () => {
      expect(normalizeRolloutRecord(item('custom_tool_call', { name: 'exec' }))).toBeNull();
    });
  });

  describe('function_call — the second tool mechanism', () => {
    it('maps function_call to toolStart with parsed arguments', () => {
      expect(
        normalizeRolloutRecord(
          item('function_call', {
            call_id: 'call_xyz',
            name: 'wait',
            arguments: '{"cell_id":"1","yield_time_ms":30000}',
          }),
        ),
      ).toEqual({
        kind: 'toolStart',
        toolId: 'call_xyz',
        toolName: 'wait',
        input: { cell_id: '1', yield_time_ms: 30000 },
      });
    });

    it('falls back to the raw string when arguments are not valid JSON', () => {
      expect(
        normalizeRolloutRecord(
          item('function_call', { call_id: 'c1', name: 'wait', arguments: 'not json' }),
        ),
      ).toEqual({ kind: 'toolStart', toolId: 'c1', toolName: 'wait', input: 'not json' });
    });

    it('maps function_call_output to toolEnd', () => {
      expect(
        normalizeRolloutRecord(item('function_call_output', { call_id: 'call_xyz', output: [] })),
      ).toEqual({ kind: 'toolEnd', toolId: 'call_xyz' });
    });
  });

  describe('patch_apply_end', () => {
    it('maps to toolEnd so the typing animation stops even if no output record follows', () => {
      expect(
        normalizeRolloutRecord(
          evt('patch_apply_end', { call_id: 'call_patch', success: true, changes: {} }),
        ),
      ).toEqual({ kind: 'toolEnd', toolId: 'call_patch' });
    });
  });

  describe('sub-agents', () => {
    it('maps sub_agent_activity kind=started to subagentStart', () => {
      expect(
        normalizeRolloutRecord(
          evt('sub_agent_activity', {
            event_id: 'call_sub',
            agent_thread_id: '019f8c54-964f-7620',
            agent_path: '/root/review_scroll_fix',
            kind: 'started',
          }),
        ),
      ).toEqual({
        kind: 'subagentStart',
        parentToolId: 'current',
        toolId: 'call_sub',
        toolName: 'review_scroll_fix',
      });
    });

    it('maps sub_agent_activity kind=failed to subagentEnd — a failed sub-agent still leaves', () => {
      expect(
        normalizeRolloutRecord(evt('sub_agent_activity', { event_id: 'call_sub', kind: 'failed' })),
      ).toEqual({ kind: 'subagentEnd', parentToolId: 'current', toolId: 'call_sub' });
    });

    it('ignores sub_agent_activity with an unrecognized kind', () => {
      expect(
        normalizeRolloutRecord(evt('sub_agent_activity', { event_id: 'c', kind: 'pondering' })),
      ).toBeNull();
    });

    it('ignores sub_agent_activity with no event_id — it could never be ended', () => {
      expect(normalizeRolloutRecord(evt('sub_agent_activity', { kind: 'started' }))).toBeNull();
    });

    it('maps sub_agent_activity kind=completed to subagentEnd', () => {
      expect(
        normalizeRolloutRecord(
          evt('sub_agent_activity', { event_id: 'call_sub', kind: 'completed' }),
        ),
      ).toEqual({ kind: 'subagentEnd', parentToolId: 'current', toolId: 'call_sub' });
    });
  });

  describe('records that carry no office-visible meaning', () => {
    it.each([
      ['agent_message', evt('agent_message', { message: 'hi' })],
      ['user_message', evt('user_message', { message: 'go' })],
      ['token_count', evt('token_count', { info: {} })],
      ['reasoning', item('reasoning', { id: 'r1' })],
      ['message', item('message', { role: 'assistant' })],
      ['turn_context', { timestamp: 't', type: 'turn_context', payload: { turn_id: '1' } }],
      ['world_state', { timestamp: 't', type: 'world_state', payload: { full: true } }],
    ])('returns null for %s', (_label, record) => {
      expect(normalizeRolloutRecord(record)).toBeNull();
    });
  });

  describe('malformed input', () => {
    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['an array', []],
      ['an object with no type', { payload: {} }],
      ['an unknown top-level type', { type: 'brand_new_thing', payload: {} }],
      ['event_msg with no payload', { type: 'event_msg' }],
    ])('returns null for %s rather than throwing', (_label, record) => {
      expect(() => normalizeRolloutRecord(record)).not.toThrow();
      expect(normalizeRolloutRecord(record)).toBeNull();
    });
  });
});

describe('sessionIdFromRecord', () => {
  it('reads session_id from session_meta', () => {
    expect(sessionIdFromRecord(meta())).toBe('019fd42b-d006-7cc3-9b3d-5276a2000342');
  });

  it('falls back to payload.id when session_id is absent', () => {
    const record = meta();
    delete (record.payload as Record<string, unknown>).session_id;
    expect(sessionIdFromRecord(record)).toBe('019fd42b-d006-7cc3-9b3d-5276a2000342');
  });

  it('returns null for records other than session_meta — only the header carries identity', () => {
    expect(sessionIdFromRecord(evt('task_complete'))).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(sessionIdFromRecord(null)).toBeNull();
  });
});
