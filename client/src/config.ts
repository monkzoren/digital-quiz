// Default SpacetimeDB address:
// - Vite dev server (any port): SpacetimeDB runs separately on :3000.
// - Anything else (the nginx container, any deployment): SAME ORIGIN —
//   nginx proxies /v1 to SpacetimeDB, so one domain/port serves everything
//   and wss works automatically behind any TLS proxy.
const defaultUri = (import.meta as any).env?.DEV
  ? `ws://${location.hostname}:3000`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const envUri: string | undefined = (import.meta as any).env?.VITE_SPACETIMEDB_URI;
const pageIsLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const envPointsLocal = !!envUri && /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(envUri);
const usableEnvUri = envUri && !(envPointsLocal && !pageIsLocal) ? envUri : undefined;
if (envUri && !usableEnvUri) {
  console.warn(`[dq] Ignoring VITE_SPACETIMEDB_URI="${envUri}" (localhost is unreachable for remote players); using same-origin instead.`);
}
export const SPACETIMEDB_URI = usableEnvUri ?? defaultUri;
export const DATABASE_NAME = (import.meta as any).env?.VITE_DATABASE_NAME ?? 'digital-quiz';

// ---------------------------------------------------------------------------
// Mirrors of spacetimedb/src/index.ts — display only, the module decides.
// ---------------------------------------------------------------------------
export const L_OPEN = 0;
export const L_RUNNING = 1;
export const L_FINISHED = 2;

export const PH_LOBBY = 0;
export const PH_INTRO = 1;
export const PH_BETTING = 2;
export const PH_ANSWER = 3;
export const PH_RESULT = 4;
export const PH_DONE = 5;

export const NO_ANSWER = 255;
export const TEAM_NONE = 0;
export const MAX_TEAMS = 4;
export const MAX_SEATS = 12;

export const ATT_HERE = 0;
export const ATT_PHONE = 1;
export const ATT_IDLE = 2;

export const CHAT_TEXT = 0;
export const CHAT_EMOTE = 1;
export const CHAT_CALLOUT = 2;
export const CHAT_MC = 3;

export const QUESTIONS_MIN = 3;
export const QUESTIONS_MAX = 30;
export const QUESTIONS_DEFAULT = 10;
export const BET_SECS_MIN = 5;
export const BET_SECS_MAX = 30;
export const BET_SECS_DEFAULT = 10;
export const ANSWER_SECS_MIN = 8;
export const ANSWER_SECS_MAX = 60;
export const ANSWER_SECS_DEFAULT = 20;

export const START_CREDITS = 100;
export const MIN_STAKE = 5;
export const STAKE_CAP_PCT = 50;
export const FASTEST_BONUS = 15;
export const STREAK_BONUS = 5;

export const PUBS = ['The Dog & Duck', 'The Neon Lounge', 'The Harbour Arms'];
export const TEAM_NAMES = ['', 'RED', 'BLUE', 'GREEN', 'GOLD'];
export const TEAM_COLORS = ['#9daee9', '#ff4b33', '#3c8dff', '#43e97b', '#ffd60a'];
export const DIFFICULTY = ['', 'EASY', 'MEDIUM', 'HARD'];
// Same order as the module's EMOTES — index is what goes over the wire.
export const EMOTES = ['👍', '😂', '🔥', '😭', '🍺', '❤️', '😡', '🤝'];

// Writing questions — mirrors the module's limits.
export const TOPIC_NAME_MAX = 32;
export const QUESTION_TEXT_MAX = 200;
export const ANSWER_MAX = 60;

// Chat anti-spam (micros there, millis here).
export const CHAT_MIN_GAP_MS = 800;
export const EMOTE_MIN_GAP_MS = 400;

// Level curve.
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
export const LEVEL_MAX = 99;
export const totalXpFor = (level: number) => ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;

// The attention checker: how long without any input before a visible tab
// counts as idle. Client-only — the module just records the transitions.
export const IDLE_AFTER_MS = 45_000;
