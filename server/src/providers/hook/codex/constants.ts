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
