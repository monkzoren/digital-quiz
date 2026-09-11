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

// Venues. Index = lobby.theme — mirrors PUBS in spacetimedb/src/index.ts,
// so the order matters. PUB_LOOK maps a venue to one of render.ts's three
// interiors, which is why adding a pub costs nothing but a name.
export const PUBS = [
  'The Dog & Duck',
  'The Neon Lounge',
  'The Harbour Arms',
  'Kroa på Hjørnet',
  'Nordlysbaren',
  'Hytta på Fjellet',
];
export const PUB_LOOK = [0, 1, 2, 0, 1, 2];

// Languages a pub can play in. LANG_ANY draws from every topic whatever it
// is written in; anything else filters the pool and sets the quiz master's
// patter. Mirrors LANGS in the module and in spacetimedb/gen-bank.mjs.
export const LANG_ANY = '';
export const LANGS: { code: string; label: string; flag: string }[] = [
  { code: 'nb', label: 'NORSK', flag: '🇳🇴' },
  { code: 'en', label: 'ENGLISH', flag: '🇬🇧' },
  { code: LANG_ANY, label: 'ALLE SPRÅK / BOTH', flag: '🌍' },
];
export const langLabel = (code: string) => LANGS.find(l => l.code === code) ?? LANGS[2];
/** What to open the create screen on: a Norwegian browser gets a Norwegian
 *  pub without hunting for the setting. */
export const defaultLang = () => (navigator.language || '').toLowerCase().startsWith('n') ? 'nb' : 'en';
export const TEAM_NAMES = ['', 'RED', 'BLUE', 'GREEN', 'GOLD'];
export const TEAM_COLORS = ['#9daee9', '#ff4b33', '#3c8dff', '#43e97b', '#ffd60a'];
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

// ---------------------------------------------------------------------------
// In-quiz wording, per language. A pub playing in Norwegian should not have
// its quiz master speak Norwegian while the screen asks in English, so every
// string the table reads WHILE PLAYING lives here and follows lobby.lang.
// The menu, lobby and question writer stay in English — they are the tooling
// around the quiz, not the quiz itself.
// ---------------------------------------------------------------------------
const EN = {
  warmingUp: 'WARMING UP',
  welcome: 'WELCOME',
  getReady: 'GET READY',
  question: 'Q',
  lastOrders: 'LAST ORDERS',
  wallet: 'WALLET',
  pays: 'PAYS',
  stake: 'STAKE',
  min: 'MIN',
  half: 'HALF',
  max: 'MAX',
  menu: '☰ MENU',
  chatPlaceholder: 'SAY SOMETHING… (ENTER)',
  correct: 'CORRECT',
  wrong: 'WRONG',
  noAnswer: 'NO ANSWER',
  fastest: 'FASTEST',
  onPhone: '📱 YOU LOOK LIKE YOU ARE ON YOUR PHONE',
  onPhoneSub: 'THE WHOLE PUB CAN SEE IT — CLICK BACK IN',
  callOut: (name: string) => `📱 CALL OUT ${name}`,
  wake: (name: string) => `💤 WAKE ${name}`,
  intro: (n: number, credits: number) =>
    `${n} questions. ${credits}¢ each. Stake on the topic, then answer. The final question pays double.`,
  betPrompt: 'How well do you know this topic? Stake your credits.',
  betPromptFinal: 'Last orders — stake anything up to the lot.',
  betNote: (win: number, lose: number, wallet: number) => `WIN +${win}¢ · LOSE −${lose}¢ · WALLET ${wallet}¢`,
  // results
  takesThePot: (name: string) => `${name} TAKES THE POT`,
  thatsTheQuiz: 'LAST ORDERS',
  correctOf: (n: number, of: number) => `${n}/${of} CORRECT`,
  tabs: (n: number) => `${n} TAB${n > 1 ? 'S' : ''}`,
  again: 'ANOTHER ROUND',
  leave: 'LEAVE THE PUB',
  awardFastest: 'FASTEST FINGER',
  awardBiggest: 'BIGGEST WIN',
  awardSharpest: 'SHARPEST',
  awardPhone: '📱 PHONE ADDICT',
  awardTab: 'ON THE TAB',
  avgSecs: (s: string) => `${s}s average`,
  onOneQuestion: (n: number) => `+${n}¢ on one question`,
  rightOf: (n: number, of: number) => `${n}/${of} right`,
  secsOnPhone: (s: number, called: number) => `${s}s on the phone · called out ×${called}`,
  topUps: (n: number) => `${n} landlord top-up${n > 1 ? 's' : ''}`,
  // the big screen
  scrQuestionOf: (n: number, of: number) => `Question ${n} of ${of}`,
  scrLastOrders: ' — LAST ORDERS',
  scrStakesOpen: (d: string, mul: string) => `${d} · pays ${mul}× · stakes open`,
  scrLockIn: 'lock in A · B · C · D',
  scrRevealed: 'answer revealed',
  scrFastest: (name: string) => `fastest: ${name}`,
  scrPhonesAway: 'phones away',
  scrQuestionsTonight: (n: number) => `${n} questions tonight`,
  scrAtTheBar: (n: number) => `${n} at the bar`,
  scrRoomCode: (code: string) => `Room code ${code}`,
  scrFinal: 'FINAL STANDINGS',
  scrWins: (name: string) => `${name} wins!`,
  scrDone: 'That’s the quiz',
  scrTonight: 'TONIGHT',
  scrPubQuiz: 'PUB QUIZ',
  scrOpenOrJoin: 'open a pub or join one',
  difficulty: ['', 'EASY', 'MEDIUM', 'HARD'],
};
type Strings = typeof EN;
const NB: Strings = {
  warmingUp: 'OPPVARMING',
  welcome: 'VELKOMMEN',
  getReady: 'GJØR DEG KLAR',
  question: 'SPM',
  lastOrders: 'SISTE RUNDE',
  wallet: 'LOMMEBOK',
  pays: 'GIR',
  stake: 'INNSATS',
  min: 'MIN',
  half: 'HALV',
  max: 'ALT',
  menu: '☰ MENY',
  chatPlaceholder: 'SI NOE… (ENTER)',
  correct: 'RIKTIG',
  wrong: 'FEIL',
  noAnswer: 'INGEN SVAR',
  fastest: 'RASKEST',
  onPhone: '📱 DU SER UT TIL Å VÆRE PÅ MOBILEN',
  onPhoneSub: 'HELE PUBEN SER DET — KLIKK DEG INN IGJEN',
  callOut: (name: string) => `📱 TA ${name} PÅ FERSKEN`,
  wake: (name: string) => `💤 VEKK ${name}`,
  intro: (n: number, credits: number) =>
    `${n} spørsmål. ${credits}¢ hver. Sats på temaet, så svarer du. Siste spørsmål gir dobbelt.`,
  betPrompt: 'Hvor godt kan du dette temaet? Sett inn poletter.',
  betPromptFinal: 'Siste runde — du kan satse hele lommeboka.',
  betNote: (win: number, lose: number, wallet: number) => `VINN +${win}¢ · TAP −${lose}¢ · LOMMEBOK ${wallet}¢`,
  takesThePot: (name: string) => `${name} TAR POTTEN`,
  thatsTheQuiz: 'TAKK FOR I KVELD',
  correctOf: (n: number, of: number) => `${n}/${of} RIKTIGE`,
  tabs: (n: number) => `${n} PÅ TABEN`,
  again: 'EN RUNDE TIL',
  leave: 'FORLAT PUBEN',
  awardFastest: 'RASKEST PÅ AVTREKKEREN',
  awardBiggest: 'KVELDENS STØRSTE GEVINST',
  awardSharpest: 'SKARPEST',
  awardPhone: '📱 MOBILAVHENGIG',
  awardTab: 'PÅ KREDITT',
  avgSecs: (s: string) => `${s} sek i snitt`,
  onOneQuestion: (n: number) => `+${n}¢ på ett spørsmål`,
  rightOf: (n: number, of: number) => `${n}/${of} riktige`,
  secsOnPhone: (s: number, called: number) => `${s} sek på mobilen · tatt ×${called}`,
  topUps: (n: number) => `${n} runde${n > 1 ? 'r' : ''} på krita`,
  scrQuestionOf: (n: number, of: number) => `Spørsmål ${n} av ${of}`,
  scrLastOrders: ' — SISTE RUNDE',
  scrStakesOpen: (d: string, mul: string) => `${d} · gir ${mul}× · innsatsen er åpen`,
  scrLockIn: 'lås inn A · B · C · D',
  scrRevealed: 'fasit',
  scrFastest: (name: string) => `raskest: ${name}`,
  scrPhonesAway: 'mobilen ned',
  scrQuestionsTonight: (n: number) => `${n} spørsmål i kveld`,
  scrAtTheBar: (n: number) => `${n} ved baren`,
  scrRoomCode: (code: string) => `Romkode ${code}`,
  scrFinal: 'SLUTTSTILLING',
  scrWins: (name: string) => `${name} vinner!`,
  scrDone: 'Takk for i kveld',
  scrTonight: 'I KVELD',
  scrPubQuiz: 'PUBQUIZ',
  scrOpenOrJoin: 'åpne en pub eller bli med i en',
  difficulty: ['', 'LETT', 'MIDDELS', 'VANSKELIG'],
};
const STRINGS: Record<string, Strings> = { en: EN, nb: NB };
/** The wording for a room's language; anything unknown falls back to English. */
export const tr = (lang: string): Strings => STRINGS[lang] ?? EN;
