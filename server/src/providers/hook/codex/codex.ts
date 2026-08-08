/**
 * Codex provider.
 *
 * Codex exposes no hooks API, so this provider runs entirely on the optional
 * file-fallback path: it tails the rollout logs Codex already writes. The hook
 * install/uninstall methods are no-ops and `areHooksInstalled()` is always false.
 *
 * `normalizeHookEvent` is still implemented so an external orchestrator can push
 * rollout-shaped records to `POST /api/hooks/codex`. Both paths delegate to the
 * same normalizer in `rollout.ts`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import {
  CODEX_COMMAND,
  CODEX_EXEC_DISPLAY_MAX_LENGTH,
  CODEX_HOME_DIR,
  CODEX_PATCH_FILE_HEADER,
  CODEX_SESSIONS_DIR,
  CODEX_TERMINAL_NAME_PREFIX,
} from './constants.js';
import { normalizeRolloutRecord, sessionIdFromRecord } from './rollout.js';

// ── Activity labels ──

export function formatToolStatus(toolName: string, input?: unknown): string {
  switch (toolName) {
    case 'exec': {
      // Codex sends the whole script as one string; only the first line is useful
      // in a one-line label.
      const script = typeof input === 'string' ? input : '';
      const firstLine = script.split('\n')[0]?.trim() ?? '';
      if (!firstLine) return 'Running command';
      return `Running: ${
        firstLine.length > CODEX_EXEC_DISPLAY_MAX_LENGTH
          ? firstLine.slice(0, CODEX_EXEC_DISPLAY_MAX_LENGTH) + '…'
          : firstLine
      }`;
    }

    case 'apply_patch': {
      const patch = typeof input === 'string' ? input : '';
      const filePath = CODEX_PATCH_FILE_HEADER.exec(patch)?.[1]?.trim();
      return filePath ? `Editing ${path.basename(filePath)}` : 'Applying patch';
    }

    default:
      return `Using ${toolName}`;
  }
}

// ── Session discovery ──

function sessionsRoot(): string {
  return path.join(os.homedir(), CODEX_HOME_DIR, CODEX_SESSIONS_DIR);
}

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Month directories (`~/.codex/sessions/<YYYY>/<MM>`).
 *
 * The runtime's global scanner treats each returned root as a directory whose
 * immediate children are session directories — exactly two levels. Codex nests
 * four (`sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`), so returning the month
 * directories makes the day directories the session dirs and lets the existing
 * scanner work unchanged.
 *
 * Recomputed per call, so a new month or year needs no restart.
 */
function getAllSessionRoots(): string[] {
  return subdirectories(sessionsRoot()).flatMap(subdirectories);
}

/**
 * Codex does not partition sessions by workspace — the working directory is
 * recorded inside each rollout file rather than in its path. Per-workspace
 * scanning therefore has nothing to return; discovery goes through
 * `getAllSessionRoots`.
 */
function getSessionDirs(_workspacePath: string): string[] {
  return [];
}

function buildLaunchCommand(
  _sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  // Codex mints its own conversation id; there is no --session-id equivalent to
  // pass through, so the office adopts the session from its rollout file instead.
  const args: string[] = [];
  if (opts?.bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
  return { command: CODEX_COMMAND, args, env: { PWD: cwd } };
}

// ── Event entry points ──

function parseTranscriptLine(line: string): AgentEvent | null {
  if (!line.trim()) return null;
  try {
    return normalizeRolloutRecord(JSON.parse(line));
  } catch {
    // Partial line from a mid-write read. Skipping is correct; the watcher
    // re-reads the completed line on the next tick.
    return null;
  }
}

/**
 * Normalize a pushed rollout record. The session id may ride alongside the
 * record (`session_id`) or, for a `session_meta` record, come from inside it.
 */
function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId =
    (typeof raw.session_id === 'string' ? raw.session_id : undefined) ??
    sessionIdFromRecord(raw) ??
    undefined;
  if (!sessionId) return null;

  const event = normalizeRolloutRecord(raw);
  return event ? { sessionId, event } : null;
}

// ── Hook lifecycle: unavailable on Codex ──

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(false);
}

// ── The provider ──

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  // Codex logs carry no approval events, so no permission timer can be exempted
  // or triggered from a transcript.
  permissionExemptTools: new Set<string>(),
  // Sub-agents arrive as `sub_agent_activity` events, not as named spawn tools.
  subagentToolNames: new Set<string>(),
  // `exec` covers both reading and running; it animates as typing, matching how
  // the Claude provider treats Bash.
  readingTools: new Set<string>(),
  terminalNamePrefix: CODEX_TERMINAL_NAME_PREFIX,

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  parseTranscriptLine,
  buildLaunchCommand,
};
