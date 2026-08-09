import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os.homedir() for cross-platform temp-home isolation, matching the pattern
// in migrateVsCodeState.test.ts. Overriding process.env.HOME is not portable:
// os.homedir() reads USERPROFILE on Windows. vi.spyOn cannot be used here — the
// ESM namespace object's properties are non-configurable.
let homeOverride: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => homeOverride };
});

import { codexProvider } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(codexProvider.kind).toBe('hook');
    });
    it('has id "codex"', () => {
      expect(codexProvider.id).toBe('codex');
    });
    it('has a displayName', () => {
      expect(codexProvider.displayName).toBe('Codex');
    });
    it('declares protocolVersion 1 to match the runtime', () => {
      expect(codexProvider.protocolVersion).toBe(1);
    });
    it('matches Codex rollout files', () => {
      expect(codexProvider.sessionFilePattern).toBe('*.jsonl');
    });
  });

  describe('hooks are not available on Codex', () => {
    it('reports hooks as never installed', async () => {
      await expect(codexProvider.areHooksInstalled()).resolves.toBe(false);
    });
    it('installHooks is a no-op that resolves rather than throwing', async () => {
      await expect(
        codexProvider.installHooks('http://127.0.0.1:1', 'tok'),
      ).resolves.toBeUndefined();
    });
    it('uninstallHooks is a no-op that resolves', async () => {
      await expect(codexProvider.uninstallHooks()).resolves.toBeUndefined();
    });
    it('never claims a permission request — Codex logs carry no approval events', () => {
      const normalized = codexProvider.normalizeHookEvent({
        session_id: 's1',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      });
      expect(normalized?.event.kind).not.toBe('permissionRequest');
    });
  });

  describe('normalizeHookEvent', () => {
    it('normalizes a pushed rollout record when a session_id accompanies it', () => {
      expect(
        codexProvider.normalizeHookEvent({
          session_id: 'sess-1',
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' },
        }),
      ).toEqual({
        sessionId: 'sess-1',
        event: { kind: 'toolStart', toolId: 'c1', toolName: 'exec', input: 'ls' },
      });
    });

    it('falls back to the session id inside a session_meta payload', () => {
      const normalized = codexProvider.normalizeHookEvent({
        type: 'session_meta',
        payload: { session_id: 'sess-2', cwd: '/w', source: 'cli' },
      });
      expect(normalized?.sessionId).toBe('sess-2');
      expect(normalized?.event.kind).toBe('sessionStart');
    });

    it('returns null when no session id can be determined', () => {
      expect(
        codexProvider.normalizeHookEvent({
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ).toBeNull();
    });

    it('returns null for a record with no office-visible meaning', () => {
      expect(
        codexProvider.normalizeHookEvent({
          session_id: 'sess-1',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'hi' },
        }),
      ).toBeNull();
    });
  });

  describe('parseTranscriptLine', () => {
    it('parses a rollout line into an AgentEvent', () => {
      expect(
        codexProvider.parseTranscriptLine?.(
          JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
        ),
      ).toEqual({ kind: 'turnEnd' });
    });

    it('returns null for a malformed line instead of throwing — tailing hits partial writes', () => {
      expect(() => codexProvider.parseTranscriptLine?.('{"type":"event_')).not.toThrow();
      expect(codexProvider.parseTranscriptLine?.('{"type":"event_')).toBeNull();
    });

    it('returns null for a blank line', () => {
      expect(codexProvider.parseTranscriptLine?.('   ')).toBeNull();
    });
  });

  describe('formatToolStatus', () => {
    it('describes exec by its command', () => {
      expect(codexProvider.formatToolStatus('exec', 'ls -la')).toBe('Running: ls -la');
    });

    it('uses only the first line of a multi-line exec script', () => {
      expect(codexProvider.formatToolStatus('exec', 'npm test\nnpm run lint')).toBe(
        'Running: npm test',
      );
    });

    it('truncates a long exec command', () => {
      const status = codexProvider.formatToolStatus('exec', 'x'.repeat(400));
      expect(status.length).toBeLessThan(120);
      expect(status.endsWith('…')).toBe(true);
    });

    it('names the edited file for apply_patch', () => {
      expect(
        codexProvider.formatToolStatus(
          'apply_patch',
          '*** Begin Patch\n*** Update File: /a/b/POICluster.swift\n@@\n-x\n+y\n',
        ),
      ).toBe('Editing POICluster.swift');
    });

    it('handles Add File and Delete File patch headers', () => {
      expect(
        codexProvider.formatToolStatus('apply_patch', '*** Begin Patch\n*** Add File: /a/New.ts\n'),
      ).toBe('Editing New.ts');
      expect(
        codexProvider.formatToolStatus(
          'apply_patch',
          '*** Begin Patch\n*** Delete File: /a/Old.ts',
        ),
      ).toBe('Editing Old.ts');
    });

    it('falls back gracefully when a patch has no recognizable file header', () => {
      expect(codexProvider.formatToolStatus('apply_patch', 'garbage')).toBe('Applying patch');
    });

    it('describes an unknown tool by name', () => {
      expect(codexProvider.formatToolStatus('wait', { cell_id: '1' })).toBe('Using wait');
    });

    it('does not throw on a non-string input for a string-input tool', () => {
      expect(() => codexProvider.formatToolStatus('exec', { not: 'a string' })).not.toThrow();
    });

    it('labels exec generically when the command is blank', () => {
      expect(codexProvider.formatToolStatus('exec', '   \n  ')).toBe('Running command');
    });

    it('labels apply_patch generically when the input is not a string', () => {
      expect(codexProvider.formatToolStatus('apply_patch', { changes: {} })).toBe('Applying patch');
    });
  });

  describe('tool classification', () => {
    it('treats no Codex tool as read-like — exec animates as typing, matching Claude Bash', () => {
      expect(codexProvider.readingTools.size).toBe(0);
    });
    it('exempts no tools from permission timers', () => {
      expect(codexProvider.permissionExemptTools.size).toBe(0);
    });
    it('declares no subagent-spawning tool names — sub-agents arrive as events', () => {
      expect(codexProvider.subagentToolNames.size).toBe(0);
    });
  });

  describe('contextWindowForModel', () => {
    it('returns undefined — Codex states its window per turn rather than per model', () => {
      expect(codexProvider.contextWindowForModel?.('gpt-5-codex')).toBeUndefined();
    });
  });

  describe('session roots', () => {
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-'));
      homeOverride = tmpHome;
    });

    afterEach(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    const mkSession = (rel: string) => {
      const dir = path.join(tmpHome, '.codex', 'sessions', rel);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    it('returns month directories, so the scanner sees day dirs as its session dirs', () => {
      mkSession('2026/08/05');
      mkSession('2026/07/30');

      const roots = codexProvider.getAllSessionRoots?.() ?? [];

      expect(roots).toHaveLength(2);
      expect(roots).toContain(path.join(tmpHome, '.codex', 'sessions', '2026', '08'));
      expect(roots).toContain(path.join(tmpHome, '.codex', 'sessions', '2026', '07'));
    });

    it('spans multiple years', () => {
      mkSession('2025/12/31');
      mkSession('2026/01/01');

      const roots = codexProvider.getAllSessionRoots?.() ?? [];

      expect(roots).toContain(path.join(tmpHome, '.codex', 'sessions', '2025', '12'));
      expect(roots).toContain(path.join(tmpHome, '.codex', 'sessions', '2026', '01'));
    });

    it('returns an empty list when Codex has never run, without throwing', () => {
      expect(() => codexProvider.getAllSessionRoots?.()).not.toThrow();
      expect(codexProvider.getAllSessionRoots?.()).toEqual([]);
    });

    it('ignores stray files among the year and month directories', () => {
      mkSession('2026/08/05');
      fs.writeFileSync(path.join(tmpHome, '.codex', 'sessions', 'notes.txt'), 'x');
      fs.writeFileSync(path.join(tmpHome, '.codex', 'sessions', '2026', 'stray.log'), 'x');

      expect(codexProvider.getAllSessionRoots?.()).toEqual([
        path.join(tmpHome, '.codex', 'sessions', '2026', '08'),
      ]);
    });

    it('does not scope sessions by workspace — Codex records cwd inside the file', () => {
      mkSession('2026/08/05');
      expect(codexProvider.getSessionDirs?.('/some/workspace')).toEqual([]);
    });
  });

  describe('sessionCwdFromTranscript', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const writeRollout = (lines: unknown[]): string => {
      const file = path.join(tmpDir, 'rollout-test.jsonl');
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return file;
    };

    const metaRecord = (cwd?: string) => ({
      timestamp: '2026-08-08T14:00:00Z',
      type: 'session_meta',
      payload: { session_id: 's1', cwd, source: 'cli' },
    });

    it('reads the working directory out of the session_meta header', () => {
      const file = writeRollout([
        metaRecord('/Users/owner/project'),
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ]);

      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBe('/Users/owner/project');
    });

    it('returns undefined when session_meta records no cwd', () => {
      const file = writeRollout([metaRecord(undefined)]);

      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBeUndefined();
    });

    it('returns undefined when the file has no session_meta at all', () => {
      const file = writeRollout([{ type: 'event_msg', payload: { type: 'task_complete' } }]);

      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBeUndefined();
    });

    it('returns undefined for a missing file instead of throwing', () => {
      expect(() =>
        codexProvider.sessionCwdFromTranscript?.(path.join(tmpDir, 'nope.jsonl')),
      ).not.toThrow();
      expect(
        codexProvider.sessionCwdFromTranscript?.(path.join(tmpDir, 'nope.jsonl')),
      ).toBeUndefined();
    });

    it('survives a truncated trailing line from the fixed-size head read', () => {
      const file = path.join(tmpDir, 'rollout-truncated.jsonl');
      fs.writeFileSync(file, JSON.stringify(metaRecord('/w')) + '\n{"type":"event_ms');

      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBe('/w');
    });

    it('reads a session_meta header larger than one read chunk', () => {
      // Real headers embed the agent's base instructions and run to tens of KB.
      // A fixed-block read truncated them mid-JSON, and every Codex agent fell
      // back to being labelled with the day-number directory it sat in.
      const file = writeRollout([
        {
          timestamp: '2026-08-09T09:51:32Z',
          type: 'session_meta',
          payload: {
            session_id: 's1',
            cwd: '/Users/owner/Documents/bp-daily-feed',
            base_instructions: { text: 'x'.repeat(120_000) },
          },
        },
        { type: 'event_msg', payload: { type: 'task_complete' } },
      ]);

      expect(fs.statSync(file).size).toBeGreaterThan(100_000);
      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBe(
        '/Users/owner/Documents/bp-daily-feed',
      );
    });

    it('returns undefined for a file whose first line never terminates', () => {
      const file = path.join(tmpDir, 'rollout-endless.jsonl');
      // No newline anywhere: a partial line must not be treated as complete.
      fs.writeFileSync(file, '{"type":"session_meta","payload":{"cwd":"/w"' + ' '.repeat(5000));

      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBeUndefined();
    });

    it('does not read the whole file — only the head, where session_meta lives', () => {
      const huge = {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'x'.repeat(500) },
      };
      const file = writeRollout([metaRecord('/Users/owner/big'), ...Array(500).fill(huge)]);

      expect(fs.statSync(file).size).toBeGreaterThan(8192);
      expect(codexProvider.sessionCwdFromTranscript?.(file)).toBe('/Users/owner/big');
    });
  });

  describe('buildLaunchCommand', () => {
    it('launches the codex CLI in the requested directory', () => {
      const launch = codexProvider.buildLaunchCommand?.('ignored-session-id', '/work');
      expect(launch?.command).toBe('codex');
      expect(launch?.env).toMatchObject({ PWD: '/work' });
      expect(launch?.args).toEqual([]);
    });

    it('passes the bypass flag only when explicitly requested', () => {
      const launch = codexProvider.buildLaunchCommand?.('s', '/work', {
        bypassPermissions: true,
      });
      expect(launch?.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });
});
