import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity, Timestamp } from 'spacetimedb';
import { BANK, BANK_VERSION } from './bank';

// ===========================================================================
// Digital Quiz — the arcade pub quiz.
//
// One SpacetimeDB module is the whole backend: pubs (rooms), the quiz master's
// question flow, the credit wallets everyone bets from, the attention checker
// that catches people on their phones, and the accounts that persist across
// engine wipes through the profile service. Everything the players see is a
// public table; the only secret is the answer key, which never leaves the
// module until the result phase writes it into the room.
// ===========================================================================

// ---------------------------------------------------------------------------
// Quiz format. Mirrored (display only) in client/src/config.ts — keep in sync.
// ---------------------------------------------------------------------------
const QUESTIONS_MIN = 3;
const QUESTIONS_MAX = 30;
const QUESTIONS_DEFAULT = 10;
const BET_SECS_MIN = 5;
const BET_SECS_MAX = 30;
const BET_SECS_DEFAULT = 10;
const ANSWER_SECS_MIN = 8;
const ANSWER_SECS_MAX = 60;
const ANSWER_SECS_DEFAULT = 20;
const INTRO_SECS = 6; // the quiz master's welcome before question one
const RESULT_SECS = 8; // answer reveal + banter
const ALL_IN_GRACE_SECS = 2; // once everyone has locked in, the clock jumps to here
const FINAL_SECS_BONUS = 5; // the last question gets a longer look

// Credits. Every seat starts with the same wallet; the landlord's tab keeps a
// broke player in the game (they can never bet more than they have, but they
// always have SOMETHING to bet).
const START_CREDITS = 100;
const MIN_STAKE = 5; // the automatic ante on every question
const TAB_FLOOR = 10; // a wallet below this is topped up to it at each reveal
const FASTEST_BONUS = 15; // flat, for the quickest correct answer (2+ seats)
const STREAK_BONUS = 5; // per question of a 3+ correct streak
// Payout multiplier on a correct answer, by difficulty (percent of stake, as
// PROFIT on top of the returned stake). The final question pays double
// whatever its difficulty, and its stake cap is the whole wallet.
const PAYOUT_PCT = [0, 100, 150, 200]; // index = difficulty 1..3
const FINAL_PAYOUT_PCT = 200;
const STAKE_CAP_PCT = 50; // of the wallet, on every question but the last

// Lobby lifecycle
const L_OPEN = 0;
const L_RUNNING = 1;
const L_FINISHED = 2;

// Quiz phases (lobby.phase)
const PH_LOBBY = 0;
const PH_INTRO = 1;
const PH_BETTING = 2; // category + odds up, stakes open, question hidden
const PH_ANSWER = 3; // question + options up, first lock-in counts
const PH_RESULT = 4; // answer key + payouts + banter
const PH_DONE = 5;

const NO_ANSWER = 255;
const TEAM_NONE = 0;
const MAX_TEAMS = 4;
const MAX_SEATS = 12; // stools around the bar, mirrored in the client's pub layout

// ---------------------------------------------------------------------------
// The pub floor. Everyone walks about it — the same free movement the
// spectators have on digital-tennis's grounds, steered by the same
// `set_input` dirX/dirY and advanced by a 20 Hz tick per room. Mirrored in
// client/src/config.ts (PUB_*) and used by the renderer — keep in sync.
// ---------------------------------------------------------------------------
const PUB_HALF_X = 6.6; // clear of the side walls
const PUB_MIN_Y = -2.6; // the bar: nobody gets behind it but the quiz master
const PUB_MAX_Y = 3.2; // the door end — beyond this you would be in the camera
const PUB_SPEED = 3.1; // one pace for everyone — no stats in a pub
const WALK_HZ = 20;
const WALK_DT = 1 / WALK_HZ;
// HIT and LOB off court are a JUMP and a WAVE on the tennis grounds; in here
// the same two buttons do the same two things.
const ACT_TICKS = Math.round(0.8 * WALK_HZ);
const ACT_JUMP = 0;
const ACT_WAVE = 1;

// Attention states (player.attention). The client reports transitions; the
// module keeps the tally so nobody can quietly edit their own phone time.
const ATT_HERE = 0;
const ATT_PHONE = 1; // tab hidden / window unfocused — "browsing their phone"
const ATT_IDLE = 2; // visible but no input for a while

// ---------------------------------------------------------------------------
// Accounts / trust boundaries. Same scheme as every Digital game.
// ---------------------------------------------------------------------------
// Set this to the Firebase project id. The module runs in a wasm sandbox with
// no env access, so it is a source constant. Only used to tell a Firebase
// token apart from any other issuer.
const FIREBASE_PROJECT = 'digital-quiz';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;
// The profile service (profiles/) mints a token signed with the SERVER'S OWN
// key carrying this issuer. Only something that can read /stdb/keys/id_ecdsa
// can produce one, so this is the trust boundary that lets restore_account
// write other people's rows.
const PROFILE_SERVICE_ISSUER = 'digital-quiz-profiles';
// The championship relay (digital-championship/relay) mints its token the
// same way, with this issuer — the same string in the hub and every sibling
// game. It may open a room for a championship leg and nothing else.
const RELAY_ISSUER = 'digital-championship-relay';

const PROV_NONE = 0; // raw SpacetimeDB token (local dev)
const PROV_ANON = 1; // Firebase anonymous
const PROV_LINKED = 2; // Firebase + a real provider
const PROV_OTHER = 3; // some other issuer — accepted, but flagged

// XP per quiz. Mirrored in client/src/config.ts (level curve only).
const XP_PLAY = 50;
const XP_PER_CORRECT = 10;
const XP_WIN = 100;
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
const LEVEL_MAX = 99;
const LOG_KEEP = 20;

// Room teardown: a room whose humans have all gone dark is reaped after this.
const REAP_AFTER = 300_000_000n; // 5 min, micros

// Chat anti-spam, micros. Mirrored in client/src/main.ts for instant feedback.
const CHAT_KEEP = 40;
const CHAT_MIN_GAP = 800_000n;
const EMOTE_MIN_GAP = 400_000n;
const CHAT_WINDOW = 10_000_000n;
const CHAT_WINDOW_MAX = 8;
const CHAT_DUP_GAP = 5_000_000n;
const CALLOUT_MIN_GAP = 6_000_000n; // one call-out per six seconds per heckler
// The module's EMOTES order must agree with the client's emote bar.
const EMOTES = ['👍', '😂', '🔥', '😭', '🍺', '❤️', '😡', '🤝'];

// ---------------------------------------------------------------------------
// Languages. A pub plays in ONE language so packs never get mixed mid-quiz:
// `lobby.lang` filters the draw to topics written in it, and the quiz master
// speaks it. LANG_ANY ('') means "draw from everything". Mirrored by LANGS in
// gen-bank.mjs and client/src/config.ts — adding one means adding it in all
// three (and giving the quiz master something to say, below).
// ---------------------------------------------------------------------------
const LANG_ANY = '';
const LANGS = ['en', 'nb'];
const cleanLang = (v: string) => (LANGS.includes(v) ? v : LANG_ANY);

// ---------------------------------------------------------------------------
// Pubs (venues). Index = lobby.theme; the client dresses the room to match
// (PUB_LOOK there maps a venue to one of the three interiors). Mirrored in
// client/src/config.ts — keep the order.
// ---------------------------------------------------------------------------
const PUBS = [
  'The Dog & Duck',
  'The Neon Lounge',
  'The Harbour Arms',
  'Kroa på Hjørnet',
  'Nordlysbaren',
  'Hytta på Fjellet',
];

// The quiz master's patter, per language. Picked with ctx.random so the
// banter differs room to room; {name} is filled in by the module. A room
// playing LANG_ANY (or any language with no patter) gets the English set.
type McLines = {
  welcome: string[]; betting: string[]; allCorrect: string[]; nobody: string[];
  mixed: string[]; phone: string[]; final: string[]; done: string[];
};
const MC: Record<string, McLines> = {
  en: {
    welcome: [
      'Evening all! Phones away, pints up — the quiz starts now.',
      'Welcome, welcome. House rules: no googling, no sulking, tip your quiz master.',
      'Right then. One winner, and the losers buy the round.',
    ],
    betting: [
      'Next category up — how confident are you feeling? Get your credits down.',
      'Place your bets. Bold or broke, your call.',
      'Stakes open! Big money on this one, or is that just the drink talking?',
      'Here comes the category. Load up or play it safe.',
    ],
    allCorrect: [
      'Everyone got it? Suspiciously well-read table, this.',
      'Full marks all round. I’ll make the next one harder.',
    ],
    nobody: [
      'Nobody? NOBODY? I despair.',
      'Not a single one of you. The landlord thanks you for your donations.',
      'Tumbleweed. That one’s going on the wall of shame.',
    ],
    mixed: [
      'Some of you knew that. The rest of you — drink up and move on.',
      'A split table! Wallets are moving now.',
      'Half of you nailed it. The other half were guessing, and I could tell.',
    ],
    phone: [
      '{name}, put the phone down — this is a pub, not a waiting room.',
      'Oi, {name}! Eyes up here. Your group chat can wait.',
      'I see you, {name}. Whoever you’re texting can’t help you with this.',
    ],
    final: [
      'LAST ORDERS! Final question — stake it all if you dare, double odds on the table.',
      'Last question of the night. All-in is allowed. Regret is mandatory.',
    ],
    done: [
      'That’s the quiz! {name} takes the pot. Everyone else: the drinks are on you.',
      'And we’re done. {name} wins, and let the record show it was never in doubt.',
    ],
  },
  nb: {
    welcome: [
      'God kveld, folkens! Mobilen ned, pilsen opp — nå braker det løs.',
      'Velkommen til quiz. Husregler: ingen googling, ingen sutring, og tips quizmasteren.',
      'Da er vi i gang. Én vinner — resten spanderer.',
    ],
    betting: [
      'Ny kategori — hvor stødig føler du deg? Sett inn poletter.',
      'Innsatsen er åpen. Frekk eller feig, du bestemmer.',
      'Store penger på denne, eller er det bare pilsen som snakker?',
      'Her kommer kategorien. Satse alt, eller spille det trygt?',
    ],
    allCorrect: [
      'Alle sammen? Mistenkelig velinformert bord, dette her.',
      'Full pott rundt hele bordet. Da skjerper jeg meg til neste.',
    ],
    nobody: [
      'Ingen? INGEN? Jeg fortviler.',
      'Ikke én eneste av dere. Vertshuset takker for gaven.',
      'Helt stille. Den der havner på skammens vegg.',
    ],
    mixed: [
      'Noen av dere kunne den. Resten får drikke opp og gå videre.',
      'Delt bord! Nå flytter det seg penger.',
      'Halvparten satt den. Den andre halvparten gjettet, og det så jeg.',
    ],
    phone: [
      '{name}, legg fra deg mobilen — dette er en pub, ikke et venterom.',
      'Hei, {name}! Øynene hit. Gruppechatten kan vente.',
      'Jeg ser deg, {name}. Den du tekster kan ikke hjelpe deg nå.',
    ],
    final: [
      'SISTE RUNDE! Siste spørsmål — sats alt hvis du tør, dobbel odds på bordet.',
      'Siste spørsmål for kvelden. All in er lov. Anger er obligatorisk.',
    ],
    done: [
      'Det var quizen! {name} tar potten. Resten: dere spanderer.',
      'Og der er vi ferdige. {name} vinner, og la det være sagt — det var aldri tvil.',
    ],
  },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const Lobby = table(
  { name: 'lobby', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    hostId: t.identity(),
    status: t.u8(), // L_*
    isPublic: t.bool(),
    theme: t.u8(), // index into PUBS
    questionCount: t.u8(),
    betSecs: t.u8(),
    answerSecs: t.u8(),
    teamMode: t.bool(),
    createdAt: t.timestamp(),
    // --- live quiz state ---
    phase: t.u8(), // PH_*
    questionIdx: t.u8(), // 0-based, valid from PH_BETTING on
    phaseEndsAt: t.timestamp(), // the client counts down to this
    phaseStartedAt: t.timestamp(),
    timerGen: t.u32(), // bumps on every schedule; a stale timer is ignored
    drawn: t.array(t.u64()), // question ids used in this room, in play order
    topics: t.array(t.u64()), // topic ids this pub draws from (empty = every topic)
    // The question on the screen. Category/difficulty/odds go up at
    // PH_BETTING; text and options at PH_ANSWER; the key ONLY at PH_RESULT
    // (correct = NO_ANSWER until then), so no client can peek.
    qTopic: t.string(),
    qIcon: t.string(),
    qDifficulty: t.u8(),
    qPayoutPct: t.u16(),
    qText: t.string(),
    qOptions: t.array(t.string()),
    qCorrect: t.u8(),
    fastestName: t.string(), // last result's quickest correct answer
    mcText: t.string(), // what the quiz master is saying right now
    championName: t.string(),
    // The championship leg this room plays (a hub `leg` id; 0 = an ordinary
    // room). Set only by create_championship_room.
    championshipLeg: t.u64().default(0n),
    // NOTE: appended column — the language this pub plays in (LANG_ANY = draw
    // from every topic whatever it is written in). Filters the draw pool and
    // picks the quiz master's patter.
    lang: t.string().default(LANG_ANY),
  }
);

// The finishing order of a championship room, written exactly once. The
// relay reads it into the hub, which does the scoring.
const LegResult = table(
  {
    name: 'leg_result',
    public: true,
    indexes: [{ accessor: 'byLeg', algorithm: 'btree', columns: ['legId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    legId: t.u64(),
    placings: t.array(t.identity()),
    names: t.array(t.string()),
    finishedAt: t.timestamp(),
  }
);

const Player = table(
  {
    name: 'player',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    avatarId: t.u8(),
    lobbyId: t.u64(), // 0 = on the menu
    seat: t.u8(), // stool index around the bar (unique within a room)
    team: t.u8(), // TEAM_NONE, or 1..MAX_TEAMS when the room is in team mode
    online: t.bool(),
    ready: t.bool(),
    kicked: t.bool(),
    // --- the wallet and the current question ---
    credits: t.i32(),
    stake: t.u16(),
    answer: t.u8(), // NO_ANSWER until locked in
    answeredAt: t.u64(), // micros; 0 = not yet
    lastDelta: t.i32(), // what the last result did to the wallet
    lastCorrect: t.bool(),
    correct: t.u16(), // this quiz
    answered: t.u16(),
    streak: t.u8(),
    tabs: t.u16(), // landlord top-ups this quiz
    // --- attention checker ---
    attention: t.u8(), // ATT_*
    attentionSince: t.u64(), // micros the current state began
    phoneChecks: t.u16(), // times caught on the phone this quiz
    phoneMicros: t.u64(), // total time away this quiz
    calledOut: t.u16(), // times the table called them out this quiz
    awayThisQ: t.bool(), // caught on the phone at any point during this question
    // NOTE: appended columns — where they are standing on the pub floor, and
    // the jump/wave they are in the middle of (walk_tick moves them). These
    // go at the END and carry defaults, or an existing database cannot
    // migrate: `player` is append-only like every other table here.
    x: t.f32().default(0),
    y: t.f32().default(0),
    dirX: t.i8().default(0),
    dirY: t.i8().default(0),
    actTicks: t.u8().default(0), // jump/wave countdown
    actKind: t.u8().default(0), // ACT_*
  }
);

// One row per seat per question, written at the result. Powers the end-of-
// night awards and the per-question history without the client keeping any.
const Entry = table(
  {
    name: 'entry',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    questionIdx: t.u8(),
    identity: t.identity(),
    name: t.string(),
    stake: t.u16(),
    answer: t.u8(),
    correct: t.bool(),
    delta: t.i32(),
    answerMillis: t.u32(), // time to lock in, 0 = never did
    onPhone: t.bool(), // caught away during this question
  }
);

// ---------------------------------------------------------------------------
// The question bank lives in the database. The built-in packs
// (questions/*.json, compiled into src/bank.ts) are synced into these two
// tables the first time the module sees a new BANK_VERSION; questions written
// in the game land here directly. `question` is PRIVATE — it holds the key —
// and only reaches clients through my_questions (an author's own rows).
// `topic` is public so the host can pick what tonight's quiz draws from.
// ---------------------------------------------------------------------------
const Topic = table(
  { name: 'topic', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    icon: t.string(),
    builtin: t.bool(),
    questionCount: t.u32(),
    authorName: t.string(),
    createdAt: t.timestamp(),
    // NOTE: appended column — the language this topic's questions are written
    // in. Comes from the pack's "lang" (or the author's pick in-game).
    lang: t.string().default('en'),
  }
);

const Question = table(
  {
    name: 'question',
    indexes: [
      { accessor: 'byTopic', algorithm: 'btree', columns: ['topicId'] },
      { accessor: 'byAuthor', algorithm: 'btree', columns: ['authorId'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    topicId: t.u64(),
    difficulty: t.u8(), // 1 easy · 2 medium · 3 hard — sets the odds
    text: t.string(),
    correct: t.string(),
    wrong: t.array(t.string()), // exactly three
    authorId: t.identity(),
    authorName: t.string(),
    builtin: t.bool(), // from a pack: re-synced on publish, never deletable in-game
    bankKey: t.string(), // "topic|text" for builtins (stable across publishes), '' otherwise
    createdAt: t.timestamp(),
  }
);

// Locked-in answers, PRIVATE until the reveal. `player.answer` is on a public
// table, so writing a choice there the moment it is made hands it to every
// other client — the whole table could simply copy whoever is winning. The
// pick lives here until settleQuestion reveals it; all the public row says
// meanwhile is `answeredAt` (that they are in, not what they said). A player
// reads their own pick back through the `my_pick` view.
const Pick = table(
  {
    name: 'pick',
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    identity: t.identity().primaryKey(),
    lobbyId: t.u64(),
    questionIdx: t.u8(),
    choice: t.u8(),
  }
);

// Singleton: which compiled bank the tables currently reflect.
const BankMeta = table(
  { name: 'bank_meta' },
  {
    id: t.u8().primaryKey(),
    version: t.string(),
  }
);

const Chat = table(
  {
    name: 'chat',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    senderId: t.identity(),
    senderName: t.string(),
    kind: t.u8(), // 0 chat · 1 emote · 2 call-out · 3 quiz master
    text: t.string(),
    sentAt: t.timestamp(),
  }
);
const CHAT_TEXT = 0;
const CHAT_EMOTE = 1;
const CHAT_CALLOUT = 2;
const CHAT_MC = 3;

// Per-identity chat rate-limit state (private).
const ChatGuard = table(
  { name: 'chat_guard' },
  {
    identity: t.identity().primaryKey(),
    windowStart: t.u64(),
    windowCount: t.u8(),
    lastAt: t.u64(),
    lastText: t.string(),
    lastCallout: t.u64(),
  }
);

// The persistent profile behind an identity. Columns are APPEND-ONLY and
// mirrored by profiles/store.mjs and restore_account — keep all three in sync.
const Account = table(
  {
    name: 'account',
    public: true,
    indexes: [{ accessor: 'byXp', algorithm: 'btree', columns: ['xp'] }],
  },
  {
    identity: t.identity().primaryKey(),
    uid: t.string(),
    provider: t.u8(),
    displayName: t.string(), // source of truth; player.name is the session copy
    avatarId: t.u8(),
    xp: t.u32(),
    level: t.u16(),
    quizzes: t.u16(),
    quizWins: t.u16(),
    questions: t.u32(),
    correct: t.u32(),
    bestCredits: t.i32(),
    phoneChecks: t.u32(), // lifetime — for the hall of shame
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
    // Monotonic revision, bumped on every change worth persisting; the
    // profile service syncs on it in both directions.
    rev: t.u32(),
  }
);

// One row per human per finished quiz; read through my_quiz_log.
const QuizLog = table(
  {
    name: 'quiz_log',
    indexes: [{ accessor: 'byAccount', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    lobbyId: t.u64(),
    pub: t.string(),
    placing: t.u8(),
    seats: t.u8(),
    credits: t.i32(),
    correct: t.u16(),
    questions: t.u16(),
    xpGained: t.u32(),
    levelAfter: t.u16(),
    won: t.bool(),
    playedAt: t.timestamp(),
  }
);

// One row per live websocket: presence is "holds at least one session".
const Session = table(
  {
    name: 'session',
    indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    connectionId: t.connectionId().primaryKey(),
    identity: t.identity(),
    startedAt: t.timestamp(),
  }
);

// Fires when the current phase should end. One row per running room.
const PhaseTimer = table(
  { name: 'phase_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
    gen: t.u32(),
  }
);

// Fires 20x a second per room with anybody in it: the pub floor's movement.
const WalkTimer = table(
  { name: 'walk_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
  }
);

const ReapTimer = table(
  { name: 'reap_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
  }
);

const spacetimedb = schema({
  lobby: Lobby,
  legResult: LegResult,
  player: Player,
  entry: Entry,
  topic: Topic,
  question: Question,
  bankMeta: BankMeta,
  pick: Pick,
  chat: Chat,
  chatGuard: ChatGuard,
  account: Account,
  quizLog: QuizLog,
  session: Session,
  phaseTimer: PhaseTimer,
  walkTimer: WalkTimer,
  reapTimer: ReapTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type LobbyRow = typeof Lobby.rowType.type;
type PlayerRow = typeof Player.rowType.type;
type AccountRow = typeof Account.rowType.type;
type QuestionRow = typeof Question.rowType.type;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameId = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();
const pick = <T>(ctx: Ctx, arr: T[]): T => arr[Math.floor(ctx.random() * arr.length) % arr.length];
const micros = (ctx: Ctx) => ctx.timestamp.microsSinceUnixEpoch;
const secsFromNow = (ctx: Ctx, s: number) =>
  ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.round(s * 1_000_000));
const atMicros = (us: bigint) => new Timestamp(us);

function lobbyPlayers(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return [...ctx.db.player.byLobby.filter(lobbyId)].sort((a, b) => a.seat - b.seat);
}

function getPlayer(ctx: Ctx): PlayerRow {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new SenderError('No player record; reconnect and try again');
  return player;
}

function generateCode(ctx: Ctx): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 32; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(ctx.random() * alphabet.length) % alphabet.length];
    if (!ctx.db.lobby.code.find(code)) return code;
  }
  throw new SenderError('Could not allocate a room code, try again');
}

function hasSession(ctx: Ctx, id: Identity): boolean {
  for (const _ of ctx.db.session.byIdentity.filter(id)) return true;
  return false;
}

function lobbyHasPresence(ctx: Ctx, lobbyId: bigint): boolean {
  for (const p of lobbyPlayers(ctx, lobbyId)) if (hasSession(ctx, p.identity)) return true;
  return false;
}

function accountOf(ctx: Ctx, id: Identity): AccountRow | undefined {
  // find() returns null on a miss; callers test with ?./if, so normalize
  return ctx.db.account.identity.find(id) ?? undefined;
}

const totalXpFor = (level: number) => ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
function levelFor(xp: number): number {
  let lvl = 1;
  while (lvl < LEVEL_MAX && totalXpFor(lvl + 1) <= xp) lvl++;
  return lvl;
}

// A seat nobody in the room holds. Filled centre-out and alternating so a
// small table spreads along the bar instead of bunching at one end (the
// client's seat layout mirrors this order — see render.ts seatPos).
const SEAT_ORDER = [2, 3, 0, 5, 1, 4, 8, 9, 6, 11, 7, 10];

// Where a seat stands when it first walks in — the stool it was given, which
// the client's seatPos mirrors. From there they are free to wander.
function seatSpot(seat: number): { x: number; y: number } {
  const row = seat < 6 ? { r: 3.6, z: -0.6, n: 6, spread: 1.25 } : { r: 6.2, z: 0.9, n: 6, spread: 1.4 };
  const i = seat % 6;
  const a = ((i - (row.n - 1) / 2) / (row.n - 1)) * row.spread;
  return { x: Math.sin(a) * row.r * 1.15, y: -4 + row.z + Math.cos(a) * row.r };
}

// Keep a patron on the floor: the walls box them in and the bar is a wall.
function clampToFloor(x: number, y: number): { x: number; y: number } {
  return {
    x: clamp(x, -PUB_HALF_X, PUB_HALF_X),
    y: clamp(y, PUB_MIN_Y, PUB_MAX_Y),
  };
}
function freeSeat(ctx: Ctx, lobbyId: bigint): number {
  const taken = new Set(lobbyPlayers(ctx, lobbyId).map(p => p.seat));
  for (const s of SEAT_ORDER) if (!taken.has(s)) return s;
  throw new SenderError('The pub is full');
}

/** A seat's per-question slate, wiped between questions. */
function freshQuestionFields(p: PlayerRow): PlayerRow {
  return { ...p, stake: 0, answer: NO_ANSWER, answeredAt: 0n, awayThisQ: p.attention === ATT_PHONE };
}

/** A seat's per-quiz slate, wiped when a quiz (re)starts. */
function freshQuizFields(p: PlayerRow): PlayerRow {
  return {
    ...freshQuestionFields(p),
    credits: START_CREDITS,
    lastDelta: 0,
    lastCorrect: false,
    correct: 0,
    answered: 0,
    streak: 0,
    tabs: 0,
    phoneChecks: 0,
    phoneMicros: 0n,
    calledOut: 0,
    ready: false,
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function guardChat(ctx: Ctx, emote: boolean, text: string) {
  const now = micros(ctx);
  const norm = emote ? '' : text.toLowerCase();
  const g = ctx.db.chatGuard.identity.find(ctx.sender);
  if (!g) {
    ctx.db.chatGuard.insert({ identity: ctx.sender, windowStart: now, windowCount: 1, lastAt: now, lastText: norm, lastCallout: 0n });
    return;
  }
  const gap = now - g.lastAt;
  if (gap < (emote ? EMOTE_MIN_GAP : CHAT_MIN_GAP)) throw new SenderError('Sending too fast — slow down');
  if (!emote && norm === g.lastText && gap < CHAT_DUP_GAP) throw new SenderError('You just said that');
  const inWindow = now - g.windowStart < CHAT_WINDOW;
  if (inWindow && g.windowCount >= CHAT_WINDOW_MAX) {
    const wait = (g.windowStart + CHAT_WINDOW - now + 999_999n) / 1_000_000n;
    throw new SenderError(`Chat rate limit — wait ${wait}s`);
  }
  ctx.db.chatGuard.identity.update({
    ...g,
    windowStart: inWindow ? g.windowStart : now,
    windowCount: inWindow ? g.windowCount + 1 : 1,
    lastAt: now,
    lastText: emote ? g.lastText : norm,
  });
}

function insertChat(ctx: Ctx, lobbyId: bigint, senderId: Identity, senderName: string, kind: number, text: string) {
  ctx.db.chat.insert({ id: 0n, lobbyId, senderId, senderName, kind, text, sentAt: ctx.timestamp });
  const rows = [...ctx.db.chat.byLobby.filter(lobbyId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < rows.length - CHAT_KEEP; i++) ctx.db.chat.id.delete(rows[i].id);
}

/** One of the quiz master's lines, in the room's language. */
function mcLine(ctx: Ctx, lobby: LobbyRow, key: keyof McLines): string {
  return pick(ctx, (MC[lobby.lang] ?? MC.en)[key]);
}

/** The quiz master speaks: on the screen (lobby.mcText) and in the log. */
function mcSay(ctx: Ctx, lobby: LobbyRow, text: string): LobbyRow {
  insertChat(ctx, lobby.id, lobby.hostId, 'QUIZ MASTER', CHAT_MC, text);
  return { ...lobby, mcText: text };
}

// ---------------------------------------------------------------------------
// The quiz engine. One phase timer per running room; every transition goes
// through setPhase, which stamps the clock the clients count down against
// and (re)arms the timer. A timer that fires with a stale `gen` is ignored,
// so an early advance (everyone locked in) can never double-step a room.
// ---------------------------------------------------------------------------
function deletePhaseTimers(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.phaseTimer.iter()) {
    if (r.lobbyId === lobbyId) ctx.db.phaseTimer.scheduledId.delete(r.scheduledId);
  }
}

function setPhase(ctx: Ctx, lobby: LobbyRow, phase: number, secs: number): LobbyRow {
  deletePhaseTimers(ctx, lobby.id);
  const gen = lobby.timerGen + 1;
  const endsAt = secsFromNow(ctx, secs);
  const next = { ...lobby, phase, phaseStartedAt: ctx.timestamp, phaseEndsAt: atMicros(endsAt), timerGen: gen };
  ctx.db.lobby.id.update(next);
  ctx.db.phaseTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(endsAt), lobbyId: lobby.id, gen });
  return next;
}

// ---------------------------------------------------------------------------
// Bank sync. Runs on every connect but costs one PK lookup once the compiled
// bank matches; after a publish that changed questions/*.json it upserts the
// packs (keyed on bankKey, so ids stay stable and a rematch's `drawn` list
// keeps meaning something) and refreshes the topic counts.
// ---------------------------------------------------------------------------
function ensureBank(ctx: Ctx) {
  const meta = ctx.db.bankMeta.id.find(0);
  if (meta && meta.version === BANK_VERSION) return;
  const byKey = new Map<string, QuestionRow>();
  for (const q of ctx.db.question.iter()) if (q.builtin) byKey.set(q.bankKey, q);
  const keep = new Set<string>();
  for (const pack of BANK) {
    let topic = ctx.db.topic.name.find(pack.topic);
    if (!topic) {
      topic = ctx.db.topic.insert({ id: 0n, name: pack.topic, icon: pack.icon, lang: pack.lang, builtin: true, questionCount: 0, authorName: '', createdAt: ctx.timestamp });
    } else if (topic.icon !== pack.icon || topic.lang !== pack.lang || !topic.builtin) {
      topic = ctx.db.topic.id.update({ ...topic, icon: pack.icon, lang: pack.lang, builtin: true });
    }
    for (const q of pack.questions) {
      const key = `${pack.topic}|${q.q}`;
      keep.add(key);
      const row = {
        topicId: topic.id,
        difficulty: q.d,
        text: q.q,
        correct: q.a[0],
        wrong: q.a.slice(1),
        authorId: Identity.zero(), // nobody's — never shows up in my_questions
        authorName: '',
        builtin: true,
        bankKey: key,
      };
      const have = byKey.get(key);
      if (have) ctx.db.question.id.update({ ...have, ...row, id: have.id, createdAt: have.createdAt });
      else ctx.db.question.insert({ id: 0n, ...row, createdAt: ctx.timestamp });
    }
  }
  // A question dropped from its pack goes too — the pack is the source of truth.
  for (const [key, row] of byKey) if (!keep.has(key)) ctx.db.question.id.delete(row.id);
  recountTopics(ctx);
  if (meta) ctx.db.bankMeta.id.update({ id: 0, version: BANK_VERSION });
  else ctx.db.bankMeta.insert({ id: 0, version: BANK_VERSION });
}

function recountTopics(ctx: Ctx) {
  const counts = new Map<bigint, number>();
  for (const q of ctx.db.question.iter()) counts.set(q.topicId, (counts.get(q.topicId) ?? 0) + 1);
  for (const tp of ctx.db.topic.iter()) {
    const n = counts.get(tp.id) ?? 0;
    if (n !== tp.questionCount) ctx.db.topic.id.update({ ...tp, questionCount: n });
  }
}

function bumpTopicCount(ctx: Ctx, topicId: bigint, by: number) {
  const tp = ctx.db.topic.id.find(topicId);
  if (tp) ctx.db.topic.id.update({ ...tp, questionCount: Math.max(0, tp.questionCount + by) });
}

/** The topics a room may draw from: the host's picks, or (when they picked
 *  none) every topic written in the room's language. */
function poolTopics(ctx: Ctx, lobby: LobbyRow): Set<string> {
  const picked = new Set(lobby.topics.map(String));
  const out = new Set<string>();
  for (const tp of ctx.db.topic.iter()) {
    if (picked.size ? !picked.has(String(tp.id)) : lobby.lang !== LANG_ANY && tp.lang !== lobby.lang) continue;
    out.add(String(tp.id));
  }
  return out;
}

/** Draw `count` fresh questions for a room from its topics, avoiding
 *  anything it has already played (a rematch never repeats a question until
 *  the pool runs dry). Topics are spread: consecutive questions differ where
 *  possible. */
function drawQuestions(ctx: Ctx, lobby: LobbyRow, used: bigint[], count: number): bigint[] {
  const usedSet = new Set(used.map(String));
  const allowed = poolTopics(ctx, lobby);
  const all = [...ctx.db.question.iter()].filter(q => allowed.has(String(q.topicId)));
  if (all.length === 0) throw new SenderError('No questions in the chosen topics');
  let pool = all.filter(q => !usedSet.has(String(q.id)));
  if (pool.length < count) pool = all; // exhausted — allow repeats
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1)) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: bigint[] = [];
  let lastTopic = -1n;
  while (out.length < count && pool.length) {
    let k = pool.findIndex(q => q.topicId !== lastTopic);
    if (k < 0) k = 0;
    const q = pool.splice(k, 1)[0];
    out.push(q.id);
    lastTopic = q.topicId;
  }
  return out;
}

const isFinal = (lobby: LobbyRow) => lobby.questionIdx >= lobby.questionCount - 1;

function startQuiz(ctx: Ctx, lobby: LobbyRow) {
  ensureBank(ctx);
  const seats = lobbyPlayers(ctx, lobby.id);
  if (seats.length === 0) throw new SenderError('Nobody is in the pub');
  for (const p of seats) ctx.db.player.identity.update(freshQuizFields(p));
  for (const e of ctx.db.entry.byLobby.filter(lobby.id)) ctx.db.entry.id.delete(e.id);
  // Previous rounds' questions stay in `drawn` so a rematch gets new ones.
  const prior = lobby.status === L_FINISHED ? [...lobby.drawn] : [];
  const drawn = [...prior, ...drawQuestions(ctx, lobby, prior, lobby.questionCount)];
  let next: LobbyRow = {
    ...lobby,
    status: L_RUNNING,
    questionIdx: 0,
    drawn,
    qTopic: '', qIcon: '', qDifficulty: 0, qPayoutPct: 0, qText: '', qOptions: [], qCorrect: NO_ANSWER,
    fastestName: '',
    championName: '',
  };
  next = mcSay(ctx, next, mcLine(ctx, next, 'welcome'));
  setPhase(ctx, next, PH_INTRO, INTRO_SECS);
}

/** The question at play-order index `idx` in this run (the tail of `drawn`
 *  is the current run; earlier entries are previous rematches). A question
 *  its author deleted mid-quiz is replaced by a placeholder rather than
 *  stalling the room. */
function questionAt(ctx: Ctx, lobby: LobbyRow, idx: number): QuestionRow {
  const runStart = lobby.drawn.length - lobby.questionCount;
  const id = lobby.drawn[runStart + idx];
  return (
    ctx.db.question.id.find(id) ?? {
      id,
      topicId: 0n,
      difficulty: 1,
      text: 'This question was withdrawn by its author. Free points: which of these is a pub?',
      correct: 'The one you are sitting in',
      wrong: ['A library', 'A dentist', 'The gym'],
      authorId: lobby.hostId,
      authorName: '',
      builtin: false,
      bankKey: '',
      createdAt: ctx.timestamp,
    }
  );
}

function clearPicks(ctx: Ctx, lobbyId: bigint) {
  for (const row of ctx.db.pick.byLobby.filter(lobbyId)) ctx.db.pick.identity.delete(row.identity);
}

function openBetting(ctx: Ctx, lobby: LobbyRow, idx: number) {
  clearPicks(ctx, lobby.id);
  const q = questionAt(ctx, lobby, idx);
  const topic = ctx.db.topic.id.find(q.topicId);
  const final = idx >= lobby.questionCount - 1;
  // Ante up: every seat is in for MIN_STAKE (or what they have). The
  // landlord's tab keeps anyone broke at the table.
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    let credits = p.credits;
    let tabs = p.tabs;
    if (credits < TAB_FLOOR) { credits = TAB_FLOOR; tabs++; }
    ctx.db.player.identity.update({ ...freshQuestionFields(p), credits, tabs, stake: Math.min(MIN_STAKE, credits) });
  }
  let next: LobbyRow = {
    ...lobby,
    questionIdx: idx,
    qTopic: topic?.name ?? 'Mystery Round',
    qIcon: topic?.icon ?? '❔',
    qDifficulty: q.difficulty,
    qPayoutPct: final ? FINAL_PAYOUT_PCT : PAYOUT_PCT[q.difficulty],
    qText: '',
    qOptions: [],
    qCorrect: NO_ANSWER,
  };
  next = mcSay(ctx, next, mcLine(ctx, next, final ? 'final' : 'betting'));
  setPhase(ctx, next, PH_BETTING, lobby.betSecs);
}

function openAnswers(ctx: Ctx, lobby: LobbyRow) {
  const q = questionAt(ctx, lobby, lobby.questionIdx);
  const answers = [q.correct, ...q.wrong];
  // Shuffle the four options; the key is re-derived at result time from the
  // text (answers are distinct within a question).
  const order = answers.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1)) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const next: LobbyRow = { ...lobby, qText: q.text, qOptions: order.map(i => answers[i]), qCorrect: NO_ANSWER };
  const secs = lobby.answerSecs + (isFinal(lobby) ? FINAL_SECS_BONUS : 0);
  setPhase(ctx, next, PH_ANSWER, secs);
}

function settleQuestion(ctx: Ctx, lobby: LobbyRow) {
  const q = questionAt(ctx, lobby, lobby.questionIdx);
  const correctIdx = lobby.qOptions.indexOf(q.correct);
  const seats = lobbyPlayers(ctx, lobby.id);
  const started = lobby.phaseStartedAt.microsSinceUnixEpoch;
  // The reveal: every pick comes out of the private table at the same moment.
  const picked = new Map<string, number>();
  for (const row of ctx.db.pick.byLobby.filter(lobby.id)) {
    if (row.questionIdx === lobby.questionIdx) picked.set(row.identity.toHexString(), row.choice);
    ctx.db.pick.identity.delete(row.identity);
  }
  const choiceOf = (p: PlayerRow) => picked.get(p.identity.toHexString()) ?? NO_ANSWER;
  // Who was quickest and right?
  let fastest: PlayerRow | null = null;
  for (const p of seats) {
    if (choiceOf(p) === correctIdx && p.answeredAt !== 0n && (!fastest || p.answeredAt < fastest.answeredAt)) fastest = p;
  }
  let right = 0;
  let onPhoneName = '';
  for (const p of seats) {
    const choice = choiceOf(p);
    const correct = choice === correctIdx;
    let delta: number;
    let streak = p.streak;
    if (correct) {
      right++;
      streak++;
      delta = Math.round((p.stake * lobby.qPayoutPct) / 100);
      if (streak >= 3) delta += STREAK_BONUS * streak;
      if (fastest && seats.length > 1 && sameId(fastest.identity, p.identity)) delta += FASTEST_BONUS;
    } else {
      streak = 0;
      delta = -p.stake;
    }
    if (p.awayThisQ && !onPhoneName) onPhoneName = p.name;
    ctx.db.entry.insert({
      id: 0n,
      lobbyId: lobby.id,
      questionIdx: lobby.questionIdx,
      identity: p.identity,
      name: p.name,
      stake: p.stake,
      answer: choice,
      correct,
      delta,
      answerMillis: p.answeredAt === 0n ? 0 : Number((p.answeredAt - started) / 1000n),
      onPhone: p.awayThisQ,
    });
    ctx.db.player.identity.update({
      ...p,
      answer: choice, // revealed now, and only now
      credits: p.credits + delta,
      lastDelta: delta,
      lastCorrect: correct,
      correct: p.correct + (correct ? 1 : 0),
      answered: p.answered + (choice === NO_ANSWER ? 0 : 1),
      streak,
    });
  }
  let line: string;
  if (onPhoneName && ctx.random() < 0.7) line = mcLine(ctx, lobby, 'phone').replace('{name}', onPhoneName);
  else if (right === 0) line = mcLine(ctx, lobby, 'nobody');
  else if (right === seats.length) line = mcLine(ctx, lobby, 'allCorrect');
  else line = mcLine(ctx, lobby, 'mixed');
  let next: LobbyRow = { ...lobby, qCorrect: correctIdx, fastestName: fastest ? fastest.name : '' };
  next = mcSay(ctx, next, line);
  setPhase(ctx, next, PH_RESULT, RESULT_SECS);
}

/** Standings: credits, then correct answers, then quickest total time. */
function standings(ctx: Ctx, lobby: LobbyRow): PlayerRow[] {
  return lobbyPlayers(ctx, lobby.id).sort(
    (a, b) => b.credits - a.credits || b.correct - a.correct || a.seat - b.seat
  );
}

function finishQuiz(ctx: Ctx, lobby: LobbyRow) {
  deletePhaseTimers(ctx, lobby.id);
  const order = standings(ctx, lobby);
  const winner = order[0];
  let next: LobbyRow = {
    ...lobby,
    status: L_FINISHED,
    phase: PH_DONE,
    championName: winner ? winner.name : '',
    qText: '', qOptions: [], qCorrect: NO_ANSWER,
  };
  next = mcSay(ctx, next, mcLine(ctx, next, 'done').replace('{name}', winner?.name || 'Nobody'));
  ctx.db.lobby.id.update(next);
  awardProgression(ctx, next, order);
  recordLegResult(ctx, next, order.map(p => p.identity));
  for (const p of order) ctx.db.player.identity.update({ ...p, ready: false });
}

export const advance_phase = spacetimedb.reducer(
  { onSchedule: PhaseTimer },
  { arg: PhaseTimer.rowType },
  (ctx, { arg }) => {
    const lobby = ctx.db.lobby.id.find(arg.lobbyId);
    if (!lobby || lobby.status !== L_RUNNING || arg.gen !== lobby.timerGen) return;
    stepPhase(ctx, lobby);
  }
);

function stepPhase(ctx: Ctx, lobby: LobbyRow) {
  switch (lobby.phase) {
    case PH_INTRO:
      openBetting(ctx, lobby, 0);
      return;
    case PH_BETTING:
      openAnswers(ctx, lobby);
      return;
    case PH_ANSWER:
      settleQuestion(ctx, lobby);
      return;
    case PH_RESULT:
      if (isFinal(lobby)) finishQuiz(ctx, lobby);
      else openBetting(ctx, lobby, lobby.questionIdx + 1);
      return;
  }
}

// ---------------------------------------------------------------------------
// Accounts and progression
// ---------------------------------------------------------------------------
function providerOf(ctx: Ctx): { provider: number; uid: string; name: string } {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) return { provider: PROV_NONE, uid: '', name: '' };
  if (jwt.issuer !== FIREBASE_ISSUER) return { provider: PROV_OTHER, uid: jwt.subject, name: '' };
  const fb = jwt.fullPayload['firebase'];
  const signIn = fb && typeof fb === 'object' && !Array.isArray(fb) ? fb['sign_in_provider'] : null;
  const claimed = jwt.fullPayload['name'];
  return {
    provider: signIn === 'anonymous' ? PROV_ANON : PROV_LINKED,
    uid: jwt.subject,
    name: typeof claimed === 'string' ? claimed.trim().slice(0, 16) : '',
  };
}

function ensureAccount(ctx: Ctx): AccountRow {
  const { provider, uid, name } = providerOf(ctx);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing) {
    const moved = existing.provider !== provider || (!!uid && existing.uid !== uid);
    return ctx.db.account.identity.update({
      ...existing,
      uid: uid || existing.uid,
      provider,
      lastSeen: ctx.timestamp,
      rev: moved ? existing.rev + 1 : existing.rev,
    });
  }
  return ctx.db.account.insert({
    identity: ctx.sender,
    uid,
    provider,
    displayName: name,
    avatarId: 0,
    xp: 0,
    level: 1,
    quizzes: 0,
    quizWins: 0,
    questions: 0,
    correct: 0,
    bestCredits: 0,
    phoneChecks: 0,
    createdAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
    rev: 0,
  });
}

/** Pay out XP and the record for a finished quiz. `order` is the standings,
 *  captured BEFORE anything resets the seats. */
function awardProgression(ctx: Ctx, lobby: LobbyRow, order: PlayerRow[]) {
  order.forEach((p, i) => {
    const acc = accountOf(ctx, p.identity);
    if (!acc) return;
    const won = i === 0 && order.length > 1;
    const gained = XP_PLAY + XP_PER_CORRECT * p.correct + (won ? XP_WIN : 0);
    const xp = acc.xp + gained;
    const level = levelFor(xp);
    ctx.db.account.identity.update({
      ...acc,
      xp,
      level,
      quizzes: acc.quizzes + 1,
      quizWins: acc.quizWins + (won ? 1 : 0),
      questions: acc.questions + lobby.questionCount,
      correct: acc.correct + p.correct,
      bestCredits: Math.max(acc.bestCredits, p.credits),
      phoneChecks: acc.phoneChecks + p.phoneChecks,
      rev: acc.rev + 1,
    });
    ctx.db.quizLog.insert({
      id: 0n,
      identity: p.identity,
      lobbyId: lobby.id,
      pub: PUBS[lobby.theme] ?? PUBS[0],
      placing: i + 1,
      seats: order.length,
      credits: p.credits,
      correct: p.correct,
      questions: lobby.questionCount,
      xpGained: gained,
      levelAfter: level,
      won,
      playedAt: ctx.timestamp,
    });
    const rows = [...ctx.db.quizLog.byAccount.filter(p.identity)].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let k = 0; k < rows.length - LOG_KEEP; k++) ctx.db.quizLog.id.delete(rows[k].id);
  });
}

function requireProfileService(ctx: Ctx) {
  if (ctx.senderAuth.jwt?.issuer !== PROFILE_SERVICE_ISSUER) throw new SenderError('Not authorized');
}

// Mirrored by profiles/store.mjs COLUMNS — keep in sync.
export const restore_account = spacetimedb.reducer(
  {
    identity: t.identity(),
    uid: t.string(),
    provider: t.u8(),
    displayName: t.string(),
    avatarId: t.u8(),
    xp: t.u32(),
    level: t.u16(),
    quizzes: t.u16(),
    quizWins: t.u16(),
    questions: t.u32(),
    correct: t.u32(),
    bestCredits: t.i32(),
    phoneChecks: t.u32(),
    rev: t.u32(),
  },
  (ctx, a) => {
    requireProfileService(ctx);
    const existing = ctx.db.account.identity.find(a.identity);
    // A live database that has moved past the stored copy is never rolled back.
    if (existing && existing.rev >= a.rev) return;
    const row = {
      identity: a.identity,
      uid: a.uid,
      provider: a.provider,
      displayName: a.displayName,
      avatarId: a.avatarId,
      xp: a.xp,
      level: a.level,
      quizzes: a.quizzes,
      quizWins: a.quizWins,
      questions: a.questions,
      correct: a.correct,
      bestCredits: a.bestCredits,
      phoneChecks: a.phoneChecks,
      createdAt: existing?.createdAt ?? ctx.timestamp,
      lastSeen: existing?.lastSeen ?? ctx.timestamp,
      rev: a.rev,
    };
    if (existing) ctx.db.account.identity.update(row);
    else ctx.db.account.insert(row);
    const p = ctx.db.player.identity.find(a.identity);
    if (p && !p.name && a.displayName) {
      ctx.db.player.identity.update({ ...p, name: a.displayName, avatarId: a.avatarId });
    }
  }
);

// Your own locked-in answer, so the client can keep it highlighted while the
// rest of the table still cannot see it.
export const my_pick = spacetimedb.view(
  { name: 'my_pick', public: true },
  t.array(Pick.rowType),
  ctx => {
    const row = ctx.db.pick.identity.find(ctx.sender);
    return row ? [row] : [];
  }
);

export const my_quiz_log = spacetimedb.view(
  { name: 'my_quiz_log', public: true },
  t.array(QuizLog.rowType),
  ctx => [...ctx.db.quizLog.byAccount.filter(ctx.sender)]
);

// ---------------------------------------------------------------------------
// Championship legs. The hub asks the relay to open a room here; the room is
// ordinary in every way except that its result is written to `leg_result`.
// ---------------------------------------------------------------------------
function requireRelay(ctx: Ctx) {
  if (ctx.senderAuth.jwt?.issuer !== RELAY_ISSUER) throw new SenderError('Not authorized');
}

function recordLegResult(ctx: Ctx, lobby: LobbyRow, placings: Identity[]) {
  if (lobby.championshipLeg === 0n) return;
  for (const r of ctx.db.legResult.byLeg.filter(lobby.championshipLeg)) if (r) return; // a rematch never rescores
  ctx.db.legResult.insert({
    id: 0n,
    legId: lobby.championshipLeg,
    placings,
    names: placings.map(id => ctx.db.player.identity.find(id)?.name ?? ''),
    finishedAt: ctx.timestamp,
  });
}

function legOptions(settings: string): Record<string, unknown> {
  try {
    const v = JSON.parse(settings || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function legNum(o: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

/**
 * Open a room for a championship leg. Relay only. `venue` is "pub:N";
 * `settings` is the director's JSON: { questions, betSecs, answerSecs, lang }.
 * The championship host becomes the room host (same identity here as on the
 * hub — one Firebase project across every game); if they never turn up,
 * whoever joins first takes the seat (claimChampionshipHost).
 */
export const create_championship_room = spacetimedb.reducer(
  { legId: t.u64(), code: t.string(), venue: t.string(), hostId: t.identity(), players: t.u8(), settings: t.string() },
  (ctx, { legId, code, venue, hostId, settings }) => {
    requireRelay(ctx);
    if (legId === 0n) throw new SenderError('Bad leg id');
    for (const l of ctx.db.lobby.iter()) if (l.championshipLeg === legId) return; // an earlier ack was lost
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(clean)) throw new SenderError('Bad room code');
    if (ctx.db.lobby.code.find(clean)) throw new SenderError('Room code already in use');
    const m = /^pub:(\d)$/.exec(venue.trim());
    const theme = m ? Number(m[1]) : 0;
    if (theme >= PUBS.length) throw new SenderError(`No such pub: ${venue}`);
    const o = legOptions(settings);
    const lobby = insertLobby(ctx, {
      isPublic: false,
      theme,
      questionCount: Math.round(legNum(o, 'questions', QUESTIONS_DEFAULT, QUESTIONS_MIN, QUESTIONS_MAX)),
      betSecs: Math.round(legNum(o, 'betSecs', BET_SECS_DEFAULT, BET_SECS_MIN, BET_SECS_MAX)),
      answerSecs: Math.round(legNum(o, 'answerSecs', ANSWER_SECS_DEFAULT, ANSWER_SECS_MIN, ANSWER_SECS_MAX)),
      teamMode: false,
      lang: cleanLang(typeof o['lang'] === 'string' ? (o['lang'] as string) : LANG_ANY),
    });
    ctx.db.lobby.id.update({ ...lobby, code: clean, hostId, championshipLeg: legId });
  }
);

function claimChampionshipHost(ctx: Ctx, lobby: LobbyRow): LobbyRow {
  if (lobby.championshipLeg === 0n || lobby.status !== L_OPEN) return lobby;
  if (sameId(lobby.hostId, ctx.sender)) return lobby;
  for (const m of lobbyPlayers(ctx, lobby.id)) if (sameId(m.identity, lobby.hostId)) return lobby;
  const claimed = { ...lobby, hostId: ctx.sender };
  ctx.db.lobby.id.update(claimed);
  return claimed;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
type LobbyOpts = { isPublic: boolean; theme: number; questionCount: number; betSecs: number; answerSecs: number; teamMode: boolean; lang: string };

function insertLobby(ctx: Ctx, o: LobbyOpts): LobbyRow {
  return ctx.db.lobby.insert({
    id: 0n,
    code: generateCode(ctx),
    hostId: ctx.sender,
    status: L_OPEN,
    isPublic: o.isPublic,
    theme: clamp(o.theme, 0, PUBS.length - 1),
    questionCount: clamp(o.questionCount, QUESTIONS_MIN, QUESTIONS_MAX),
    betSecs: clamp(o.betSecs, BET_SECS_MIN, BET_SECS_MAX),
    answerSecs: clamp(o.answerSecs, ANSWER_SECS_MIN, ANSWER_SECS_MAX),
    teamMode: o.teamMode,
    createdAt: ctx.timestamp,
    lang: cleanLang(o.lang),
    phase: PH_LOBBY,
    questionIdx: 0,
    phaseEndsAt: ctx.timestamp,
    phaseStartedAt: ctx.timestamp,
    timerGen: 0,
    drawn: [],
    topics: [],
    qTopic: '',
    qIcon: '',
    qDifficulty: 0,
    qPayoutPct: 0,
    qText: '',
    qOptions: [],
    qCorrect: NO_ANSWER,
    fastestName: '',
    mcText: '',
    championName: '',
    championshipLeg: 0n,
  });
}

function destroyLobby(ctx: Ctx, lobby: LobbyRow) {
  deletePhaseTimers(ctx, lobby.id);
  disarmWalk(ctx, lobby.id);
  clearPicks(ctx, lobby.id);
  disarmReaper(ctx, lobby.id);
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    ctx.db.player.identity.update({
      ...freshQuizFields(p), lobbyId: 0n, seat: 0, team: TEAM_NONE, dirX: 0, dirY: 0, actTicks: 0,
    });
  }
  for (const e of ctx.db.entry.byLobby.filter(lobby.id)) ctx.db.entry.id.delete(e.id);
  for (const c of ctx.db.chat.byLobby.filter(lobby.id)) ctx.db.chat.id.delete(c.id);
  ctx.db.lobby.id.delete(lobby.id);
}

/** Take a seat in a room. Mid-quiz joiners sit down with the starting wallet
 *  and simply miss what has been asked — nothing waits for them. */
function seatPlayer(ctx: Ctx, lobby: LobbyRow, player: PlayerRow) {
  const seat = freeSeat(ctx, lobby.id);
  const base = freshQuizFields(player);
  const spot = seatSpot(seat);
  ctx.db.player.identity.update({
    ...base,
    lobbyId: lobby.id,
    seat,
    x: spot.x,
    y: spot.y,
    dirX: 0,
    dirY: 0,
    actTicks: 0,
    actKind: 0,
    team: TEAM_NONE,
    kicked: false,
    // a late seat during betting/answers is still in for the ante
    stake: lobby.status === L_RUNNING && (lobby.phase === PH_BETTING || lobby.phase === PH_ANSWER) ? MIN_STAKE : 0,
  });
  disarmReaper(ctx, lobby.id);
  armWalk(ctx, lobby.id);
}

function leaveCurrentLobby(ctx: Ctx, player: PlayerRow) {
  if (player.lobbyId === 0n) return;
  ctx.db.pick.identity.delete(player.identity);
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  ctx.db.player.identity.update({
    ...freshQuizFields(player),
    kicked: player.kicked, // set by kick_player on the row it hands in
    lobbyId: 0n,
    seat: 0,
    team: TEAM_NONE,
    dirX: 0,
    dirY: 0,
    actTicks: 0,
  });
  if (!lobby) return;
  const remaining = lobbyPlayers(ctx, lobby.id).filter(p => !sameId(p.identity, player.identity));
  if (remaining.length === 0) {
    destroyLobby(ctx, lobby);
    return;
  }
  const cur = ctx.db.lobby.id.find(lobby.id);
  if (cur && sameId(cur.hostId, player.identity)) {
    ctx.db.lobby.id.update({ ...cur, hostId: remaining[0].identity });
  }
}

function disarmReaper(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.reapTimer.iter()) {
    if (r.lobbyId === lobbyId) ctx.db.reapTimer.scheduledId.delete(r.scheduledId);
  }
}

function armReaper(ctx: Ctx, lobbyId: bigint) {
  if (lobbyId === 0n || !ctx.db.lobby.id.find(lobbyId)) return;
  if (lobbyHasPresence(ctx, lobbyId)) return;
  disarmReaper(ctx, lobbyId);
  ctx.db.reapTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(micros(ctx) + REAP_AFTER), lobbyId });
}

export const reap_lobby = spacetimedb.reducer(
  { onSchedule: ReapTimer },
  { arg: ReapTimer.rowType },
  (ctx, { arg }) => {
    const lobby = ctx.db.lobby.id.find(arg.lobbyId);
    if (!lobby || lobbyHasPresence(ctx, arg.lobbyId)) return;
    destroyLobby(ctx, lobby);
  }
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export const onConnect = spacetimedb.clientConnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) ctx.db.session.insert({ connectionId: connId, identity: ctx.sender, startedAt: ctx.timestamp });
  ensureBank(ctx);
  const account = ensureAccount(ctx);
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (!existing) {
    ctx.db.player.insert({
      identity: ctx.sender,
      name: account.displayName,
      avatarId: account.avatarId,
      lobbyId: 0n,
      seat: 0,
      team: TEAM_NONE,
      online: true,
      ready: false,
      kicked: false,
      x: 0,
      y: 0,
      dirX: 0,
      dirY: 0,
      actTicks: 0,
      actKind: 0,
      credits: START_CREDITS,
      stake: 0,
      answer: NO_ANSWER,
      answeredAt: 0n,
      lastDelta: 0,
      lastCorrect: false,
      correct: 0,
      answered: 0,
      streak: 0,
      tabs: 0,
      attention: ATT_HERE,
      attentionSince: micros(ctx),
      phoneChecks: 0,
      phoneMicros: 0n,
      calledOut: 0,
      awayThisQ: false,
    });
    return;
  }
  ctx.db.player.identity.update({
    ...existing,
    online: true,
    name: existing.name || account.displayName,
    attention: ATT_HERE,
    attentionSince: micros(ctx),
  });
  if (existing.lobbyId !== 0n) disarmReaper(ctx, existing.lobbyId);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) ctx.db.session.connectionId.delete(connId);
  if (hasSession(ctx, ctx.sender)) return; // another tab still holds this identity
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;
  ctx.db.player.identity.update({ ...player, online: false, ready: false });
  if (player.lobbyId === 0n) return;
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  // A seat in a running quiz is held (they may be back for the next
  // question); a seat in a lobby or a finished room is freed.
  if (lobby && lobby.status === L_RUNNING) {
    armReaper(ctx, player.lobbyId);
    return;
  }
  const lobbyId = player.lobbyId;
  leaveCurrentLobby(ctx, { ...player, online: false });
  armReaper(ctx, lobbyId);
});

// ---------------------------------------------------------------------------
// Room reducers
// ---------------------------------------------------------------------------
export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const trimmed = name.trim().slice(0, 16);
  if (!trimmed) throw new SenderError('Name cannot be empty');
  const player = getPlayer(ctx);
  ctx.db.player.identity.update({ ...player, name: trimmed });
  const acc = accountOf(ctx, ctx.sender);
  if (acc && acc.displayName !== trimmed) {
    ctx.db.account.identity.update({ ...acc, displayName: trimmed, rev: acc.rev + 1 });
  }
});

// The roster is digital-tennis's, character for character — the same people
// play tennis and drink here. Mirrored in client/src/characters.ts.
const AVATAR_COUNT = 18;
export const set_avatar = spacetimedb.reducer({ avatarId: t.u8() }, (ctx, { avatarId }) => {
  if (avatarId >= AVATAR_COUNT) throw new SenderError('No such avatar');
  const player = getPlayer(ctx);
  ctx.db.player.identity.update({ ...player, avatarId });
  const acc = accountOf(ctx, ctx.sender);
  if (acc && acc.avatarId !== avatarId) {
    ctx.db.account.identity.update({ ...acc, avatarId, rev: acc.rev + 1 });
  }
});

// ---------------------------------------------------------------------------
// Walking about. Exactly digital-tennis's grounds controls: a direction from
// the keyboard/stick, and two buttons that jump and wave.
// ---------------------------------------------------------------------------
export const set_input = spacetimedb.reducer(
  { dirX: t.i8(), dirY: t.i8() },
  (ctx, { dirX, dirY }) => {
    const player = getPlayer(ctx);
    if (player.lobbyId === 0n) return; // on the menu there is nothing to steer
    const dx = clamp(dirX, -1, 1);
    const dy = clamp(dirY, -1, 1);
    if (dx === player.dirX && dy === player.dirY) return;
    ctx.db.player.identity.update({ ...player, dirX: dx, dirY: dy });
  }
);

export const act = spacetimedb.reducer({ kind: t.u8() }, (ctx, { kind }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n || player.actTicks > 0) return; // one action at a time
  ctx.db.player.identity.update({
    ...player,
    actTicks: ACT_TICKS,
    actKind: kind === ACT_WAVE ? ACT_WAVE : ACT_JUMP,
  });
});

// Everyone in the room walks, steered by their own dirX/dirY. A patron who
// is standing still with no action running is skipped entirely, so a quiet
// pub costs no row writes and no broadcast.
export const walk_tick = spacetimedb.reducer(
  { onSchedule: WalkTimer },
  { arg: WalkTimer.rowType },
  (ctx, { arg }) => {
    const lobby = ctx.db.lobby.id.find(arg.lobbyId);
    if (!lobby) {
      ctx.db.walkTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    for (const p of ctx.db.player.byLobby.filter(arg.lobbyId)) {
      const moving = p.dirX !== 0 || p.dirY !== 0;
      if (!moving && p.actTicks === 0) continue;
      const actTicks = p.actTicks > 0 ? p.actTicks - 1 : 0;
      if (!moving) {
        ctx.db.player.identity.update({ ...p, actTicks });
        continue;
      }
      const len = Math.hypot(p.dirX, p.dirY) || 1;
      const { x, y } = clampToFloor(
        p.x + (p.dirX / len) * PUB_SPEED * WALK_DT,
        p.y + (p.dirY / len) * PUB_SPEED * WALK_DT
      );
      // pinned against a wall with nothing else changing: no write
      if (x === p.x && y === p.y && actTicks === p.actTicks) continue;
      ctx.db.player.identity.update({ ...p, x, y, actTicks });
    }
  }
);

function disarmWalk(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.walkTimer.iter()) {
    if (r.lobbyId === lobbyId) ctx.db.walkTimer.scheduledId.delete(r.scheduledId);
  }
}

function armWalk(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.walkTimer.iter()) if (r.lobbyId === lobbyId) return;
  ctx.db.walkTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(Math.round(WALK_DT * 1_000_000))),
    lobbyId,
  });
}

export const set_team = spacetimedb.reducer({ team: t.u8() }, (ctx, { team }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || !lobby.teamMode) throw new SenderError('This pub is not playing in teams');
  if (team > MAX_TEAMS) throw new SenderError('No such team');
  ctx.db.player.identity.update({ ...player, team });
});

export const create_pub = spacetimedb.reducer(
  { isPublic: t.bool(), theme: t.u8(), questions: t.u8(), betSecs: t.u8(), answerSecs: t.u8(), teamMode: t.bool(), lang: t.string() },
  (ctx, o) => {
    const player = getPlayer(ctx);
    if (!player.name) throw new SenderError('Pick a name first');
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, {
      isPublic: o.isPublic,
      theme: o.theme,
      questionCount: o.questions,
      betSecs: o.betSecs,
      answerSecs: o.answerSecs,
      teamMode: o.teamMode,
      lang: o.lang,
    });
    seatPlayer(ctx, lobby, ctx.db.player.identity.find(ctx.sender)!);
  }
);

export const set_pub_settings = spacetimedb.reducer(
  { questions: t.u8(), betSecs: t.u8(), answerSecs: t.u8(), teamMode: t.bool(), theme: t.u8(), lang: t.string() },
  (ctx, o) => {
    const player = getPlayer(ctx);
    if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
    const lobby = ctx.db.lobby.id.find(player.lobbyId);
    if (!lobby) throw new SenderError('Not in a pub');
    if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can change the format');
    if (lobby.status === L_RUNNING) throw new SenderError('The quiz is running');
    ctx.db.lobby.id.update({
      ...lobby,
      questionCount: clamp(o.questions, QUESTIONS_MIN, QUESTIONS_MAX),
      betSecs: clamp(o.betSecs, BET_SECS_MIN, BET_SECS_MAX),
      answerSecs: clamp(o.answerSecs, ANSWER_SECS_MIN, ANSWER_SECS_MAX),
      teamMode: o.teamMode,
      theme: clamp(o.theme, 0, PUBS.length - 1),
      // changing language invalidates topics picked in the old one
      lang: cleanLang(o.lang),
      topics: cleanLang(o.lang) === lobby.lang ? lobby.topics : [],
    });
    if (!o.teamMode) {
      for (const p of lobbyPlayers(ctx, lobby.id)) if (p.team !== TEAM_NONE) ctx.db.player.identity.update({ ...p, team: TEAM_NONE });
    }
  }
);

export const join_pub = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const player = getPlayer(ctx);
  if (!player.name) throw new SenderError('Pick a name first');
  const found = ctx.db.lobby.code.find(code.trim().toUpperCase());
  if (!found) throw new SenderError('No pub with that code');
  if (found.id === player.lobbyId) return;
  if (found.status === L_FINISHED) throw new SenderError('That quiz has finished');
  if (lobbyPlayers(ctx, found.id).length >= MAX_SEATS) throw new SenderError('The pub is full');
  leaveCurrentLobby(ctx, player);
  const lobby = claimChampionshipHost(ctx, found);
  seatPlayer(ctx, lobby, ctx.db.player.identity.find(ctx.sender)!);
});

export const leave_pub = spacetimedb.reducer(ctx => {
  leaveCurrentLobby(ctx, getPlayer(ctx));
});

/** Ready is a signal, not a gate: the host can start regardless, and a room
 *  where everyone is ready starts itself. */
export const set_ready = spacetimedb.reducer({ ready: t.bool() }, (ctx, { ready }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.status === L_RUNNING) return;
  ctx.db.player.identity.update({ ...player, ready });
  if (!ready) return;
  const seats = lobbyPlayers(ctx, lobby.id);
  if (seats.length >= 2 && seats.every(p => p.ready)) startQuiz(ctx, lobby);
});

export const start_quiz = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby) throw new SenderError('Not in a pub');
  if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can start');
  if (lobby.status === L_RUNNING) throw new SenderError('Already running');
  if (lobby.teamMode && lobbyPlayers(ctx, lobby.id).some(p => p.team === TEAM_NONE)) {
    throw new SenderError('Everyone needs a team first');
  }
  startQuiz(ctx, lobby);
});

export const kick_player = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby) throw new SenderError('Not in a pub');
  if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can remove players');
  if (sameId(target, ctx.sender)) throw new SenderError('You cannot remove yourself — leave the pub instead');
  const victim = ctx.db.player.identity.find(target);
  if (!victim || victim.lobbyId !== lobby.id) throw new SenderError('They are not in this pub');
  leaveCurrentLobby(ctx, { ...victim, kicked: true });
});

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------
export const place_stake = spacetimedb.reducer({ stake: t.u16() }, (ctx, { stake }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.status !== L_RUNNING || lobby.phase !== PH_BETTING) throw new SenderError('Stakes are closed');
  // The final question is all-in territory; before that a stake tops out at
  // half the wallet, so one shove can never end the night on question two.
  // Mirrored in client/src/config.ts (STAKE_CAP_PCT).
  const floor = Math.min(MIN_STAKE, player.credits);
  const cap = isFinal(lobby) ? player.credits : Math.max(floor, Math.floor((player.credits * STAKE_CAP_PCT) / 100));
  const clean = clamp(stake, floor, Math.max(0, cap));
  ctx.db.player.identity.update({ ...player, stake: clean });
});

export const answer = spacetimedb.reducer({ choice: t.u8() }, (ctx, { choice }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.status !== L_RUNNING || lobby.phase !== PH_ANSWER) throw new SenderError('Not taking answers');
  if (choice >= lobby.qOptions.length) throw new SenderError('No such option');
  // A pick can be changed for as long as the clock runs — the last one on the
  // paddle at the buzzer is the answer. `answeredAt` is re-stamped on every
  // change, so the fastest-finger bonus belongs to the answer they actually
  // stood behind; leaving the first stamp would let anyone slap A down the
  // instant the question lands and then switch at the death, still 'fastest'.
  const prev = ctx.db.pick.identity.find(ctx.sender);
  const first = player.answeredAt === 0n;
  if (!first && prev && prev.lobbyId === lobby.id && prev.questionIdx === lobby.questionIdx && prev.choice === choice) return;
  // the choice goes in the private table; the public row only records THAT
  // they answered, and when (the fastest-finger bonus needs the clock)
  ctx.db.pick.identity.delete(ctx.sender);
  ctx.db.pick.insert({ identity: ctx.sender, lobbyId: lobby.id, questionIdx: lobby.questionIdx, choice });
  ctx.db.player.identity.update({ ...player, answeredAt: micros(ctx) });
  // Everyone in? Don't make the table sit through the rest of the clock. Only
  // on the FIRST lock-in: a change must not push the grace window back out,
  // or one player could hold the room by flip-flopping.
  if (!first) return;
  const seats = lobbyPlayers(ctx, lobby.id);
  const waiting = seats.filter(p => !sameId(p.identity, ctx.sender) && p.answeredAt === 0n && p.online);
  if (waiting.length === 0) {
    const remaining = lobby.phaseEndsAt.microsSinceUnixEpoch - micros(ctx);
    if (remaining > BigInt(ALL_IN_GRACE_SECS * 1_000_000)) setPhase(ctx, lobby, PH_ANSWER, ALL_IN_GRACE_SECS);
  }
});

/** The client reports where its attention is: ATT_HERE, ATT_PHONE (the tab
 *  is hidden or the window lost focus) or ATT_IDLE (visible, no input). The
 *  module keeps the tally, so the number on the scoreboard is the module's. */
export const set_attention = spacetimedb.reducer({ state: t.u8() }, (ctx, { state }) => {
  if (state > ATT_IDLE) throw new SenderError('Bad attention state');
  const player = getPlayer(ctx);
  if (player.attention === state) return;
  const now = micros(ctx);
  const lobby = player.lobbyId === 0n ? undefined : ctx.db.lobby.id.find(player.lobbyId);
  const live = !!lobby && lobby.status === L_RUNNING;
  const inQuestion = live && (lobby!.phase === PH_BETTING || lobby!.phase === PH_ANSWER);
  let { phoneChecks, phoneMicros, awayThisQ } = player;
  if (state === ATT_PHONE && live) {
    phoneChecks++;
    if (inQuestion) awayThisQ = true;
  }
  if (player.attention === ATT_PHONE && live) phoneMicros += now - player.attentionSince;
  ctx.db.player.identity.update({ ...player, attention: state, attentionSince: now, phoneChecks, phoneMicros, awayThisQ });
});

/** Heckle someone who is on their phone. Lands in the chat for the whole
 *  pub and on the target's record. Rate-limited per heckler. */
export const call_out = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  if (sameId(target, ctx.sender)) throw new SenderError('Calling yourself out? Bold.');
  const victim = ctx.db.player.identity.find(target);
  if (!victim || victim.lobbyId !== player.lobbyId) throw new SenderError('They are not in this pub');
  if (victim.attention === ATT_HERE) throw new SenderError(`${victim.name} is paying attention (for now)`);
  const now = micros(ctx);
  const g = ctx.db.chatGuard.identity.find(ctx.sender);
  if (g && now - g.lastCallout < CALLOUT_MIN_GAP) throw new SenderError('Give them a second to look up');
  if (g) ctx.db.chatGuard.identity.update({ ...g, lastCallout: now });
  else ctx.db.chatGuard.insert({ identity: ctx.sender, windowStart: now, windowCount: 0, lastAt: 0n, lastText: '', lastCallout: now });
  ctx.db.player.identity.update({ ...victim, calledOut: victim.calledOut + 1 });
  const what = victim.attention === ATT_PHONE ? 'get off your phone!' : 'wake up!';
  insertChat(ctx, player.lobbyId, ctx.sender, player.name || 'SOMEONE', CHAT_CALLOUT, `${victim.name || 'you'} — ${what}`);
});

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
export const send_chat = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) return;
  const trimmed = text.trim().slice(0, 120);
  if (!trimmed) return;
  guardChat(ctx, false, trimmed);
  insertChat(ctx, player.lobbyId, ctx.sender, player.name || 'PLAYER', CHAT_TEXT, trimmed);
});

export const send_emote = spacetimedb.reducer({ index: t.u8() }, (ctx, { index }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n || index >= EMOTES.length) return;
  guardChat(ctx, true, '');
  insertChat(ctx, player.lobbyId, ctx.sender, player.name || 'PLAYER', CHAT_EMOTE, EMOTES[index]);
});

// ---------------------------------------------------------------------------
// Writing questions. Anyone with a name can add a topic or a question from
// the menu; they land in the shared bank for every pub that draws from that
// topic. Authors can withdraw their own; built-ins come from the packs and
// change only on publish. Mirrored limits live in client/src/config.ts.
// ---------------------------------------------------------------------------
const TOPIC_NAME_MAX = 32;
const QUESTION_TEXT_MIN = 5;
const QUESTION_TEXT_MAX = 200;
const ANSWER_MAX = 60;
const QUESTIONS_PER_AUTHOR = 500;

function requireAuthor(ctx: Ctx): PlayerRow {
  const player = getPlayer(ctx);
  if (!player.name) throw new SenderError('Pick a name first');
  return player;
}

export const add_topic = spacetimedb.reducer({ name: t.string(), icon: t.string(), lang: t.string() }, (ctx, { name, icon, lang }) => {
  const player = requireAuthor(ctx);
  ensureBank(ctx);
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, TOPIC_NAME_MAX);
  if (clean.length < 2) throw new SenderError('Topic name is too short');
  for (const tp of ctx.db.topic.iter()) {
    if (tp.name.toLowerCase() === clean.toLowerCase()) throw new SenderError(`"${tp.name}" already exists`);
  }
  const cleanIcon = [...icon.trim()].slice(0, 2).join('') || '❔';
  // a topic always has a real language — LANG_ANY is a room setting, not a
  // property a question can have
  ctx.db.topic.insert({ id: 0n, name: clean, icon: cleanIcon, lang: cleanLang(lang) || 'en', builtin: false, questionCount: 0, authorName: player.name, createdAt: ctx.timestamp });
});

export const add_question = spacetimedb.reducer(
  { topicId: t.u64(), difficulty: t.u8(), text: t.string(), correct: t.string(), wrong: t.array(t.string()) },
  (ctx, { topicId, difficulty, text, correct, wrong }) => {
    const player = requireAuthor(ctx);
    ensureBank(ctx);
    if (!ctx.db.topic.id.find(topicId)) throw new SenderError('No such topic');
    if (difficulty < 1 || difficulty > 3) throw new SenderError('Difficulty is 1, 2 or 3');
    const q = text.trim().replace(/\s+/g, ' ').slice(0, QUESTION_TEXT_MAX);
    if (q.length < QUESTION_TEXT_MIN) throw new SenderError('Write the question first');
    const answers = [correct, ...wrong].map(a => a.trim().replace(/\s+/g, ' ').slice(0, ANSWER_MAX));
    if (answers.length !== 4) throw new SenderError('One correct answer and three wrong ones, please');
    if (answers.some(a => !a)) throw new SenderError('Every answer needs some text');
    if (new Set(answers.map(a => a.toLowerCase())).size !== 4) throw new SenderError('Answers must be different from each other');
    let mine = 0;
    for (const _ of ctx.db.question.byAuthor.filter(ctx.sender)) mine++;
    if (mine >= QUESTIONS_PER_AUTHOR) throw new SenderError('You have written enough questions for one lifetime');
    ctx.db.question.insert({
      id: 0n,
      topicId,
      difficulty,
      text: q,
      correct: answers[0],
      wrong: answers.slice(1),
      authorId: ctx.sender,
      authorName: player.name,
      builtin: false,
      bankKey: '',
      createdAt: ctx.timestamp,
    });
    bumpTopicCount(ctx, topicId, 1);
  }
);

export const delete_question = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const q = ctx.db.question.id.find(id);
  if (!q) return;
  if (q.builtin) throw new SenderError('Built-in questions change in questions/*.json, not here');
  if (!sameId(q.authorId, ctx.sender)) throw new SenderError('Only the author can withdraw a question');
  ctx.db.question.id.delete(id);
  bumpTopicCount(ctx, q.topicId, -1);
});

/** The host picks which topics tonight's quiz draws from (empty = all). */
export const set_pub_topics = spacetimedb.reducer({ topics: t.array(t.u64()) }, (ctx, { topics }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n) throw new SenderError('Not in a pub');
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby) throw new SenderError('Not in a pub');
  if (!sameId(lobby.hostId, ctx.sender)) throw new SenderError('Only the host can pick the topics');
  if (lobby.status === L_RUNNING) throw new SenderError('The quiz is running');
  const clean = [...new Set(
    topics
      .filter(id => {
        const tp = ctx.db.topic.id.find(id);
        return !!tp && (lobby.lang === LANG_ANY || tp.lang === lobby.lang);
      })
      .map(String)
  )].map(BigInt);
  ctx.db.lobby.id.update({ ...lobby, topics: clean });
});

// An author's own questions — the one way question rows reach a client.
// Built-ins carry the zero identity, so no caller ever matches them.
export const my_questions = spacetimedb.view(
  { name: 'my_questions', public: true },
  t.array(Question.rowType),
  ctx => [...ctx.db.question.byAuthor.filter(ctx.sender)].filter(q => !q.builtin)
);
