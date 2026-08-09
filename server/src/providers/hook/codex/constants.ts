/** Codex provider constants. */

/** Directory under the home dir holding Codex state. */
export const CODEX_HOME_DIR = '.codex';

/** Rollout logs live at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. */
export const CODEX_SESSIONS_DIR = 'sessions';

/** Terminal name prefix used when the office launches Codex. */
export const CODEX_TERMINAL_NAME_PREFIX = 'Codex';

/** Executable invoked by `buildLaunchCommand`. */
export const CODEX_COMMAND = 'codex';

/** Longest exec command rendered in the activity label before ellipsis. */
export const CODEX_EXEC_DISPLAY_MAX_LENGTH = 60;

/** Matches the file header inside an `apply_patch` blob. */
export const CODEX_PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m;

/** Chunk size used while reading a rollout file's first line. */
export const SESSION_META_CHUNK_BYTES = 65_536;

/**
 * Cap on the first line of a rollout file.
 *
 * `session_meta` embeds the agent's full base instructions, so real headers run
 * to tens of kilobytes -- an 8 KB read truncated them mid-JSON and every Codex
 * agent fell back to being labelled with a day number. This is generous enough
 * to cover that and still bounded, so a corrupt file without newlines cannot
 * pull an arbitrary amount into memory.
 */
export const SESSION_META_MAX_BYTES = 1_048_576;
