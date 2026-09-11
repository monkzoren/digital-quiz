// ---------------------------------------------------------------------------
// Digital Quiz client: connection, UI state, input. The pub itself is drawn
// by render.ts from a Scene this file builds every frame; every rule lives in
// the module — this file only renders rows and calls reducers.
// ---------------------------------------------------------------------------
import { Identity, type Infer } from 'spacetimedb';
import { DbConnection } from './module_bindings';
import LobbyRowT from './module_bindings/lobby_table';
import PlayerRowT from './module_bindings/player_table';
import TopicRowT from './module_bindings/topic_table';
import ChatRowT from './module_bindings/chat_table';
import EntryRowT from './module_bindings/entry_table';
import AccountRowT from './module_bindings/account_table';
import { SPACETIMEDB_URI, DATABASE_NAME } from './config';
import * as C from './config';
import { CHARACTERS, STAT_LABELS } from './characters';
import {
  initRenderer, drawScene, headScreenPos, initCharacterPreviews, triggerEmote,
  type Scene, type SceneSeat,
} from './render';
import {
  WATCHER_EMOTE_CHEER, WATCHER_EMOTE_LAUGH, WATCHER_EMOTE_RAGE, WATCHER_EMOTE_SULK,
} from './rig';
import { startAttentionChecker, resyncAttention, attentionState } from './attention';
import {
  accountKind, accountLabel, authDegraded, completeEmailLink, firebaseEnabled, getToken, initAuth,
  isEmailLinkReturn, localToken, onAuthChange, sendEmailLink, sendPasswordReset, signInWithGoogle,
  signInWithPassword, signOut, signUpWithPassword, type SignInResult,
} from './auth';
import './update-check';

type Lobby = Infer<typeof LobbyRowT>;
type Player = Infer<typeof PlayerRowT>;
type Topic = Infer<typeof TopicRowT>;
type ChatRow = Infer<typeof ChatRowT>;
type Entry = Infer<typeof EntryRowT>;
type Account = Infer<typeof AccountRowT>;

const $ = (id: string) => document.getElementById(id)!;
const overlays = {
  connecting: $('overlay-connecting'),
  menu: $('overlay-menu'),
  avatar: $('overlay-avatar'),
  lobby: $('overlay-lobby'),
  results: $('overlay-results'),
  questions: $('overlay-questions'),
};
type OverlayName = keyof typeof overlays;
let currentOverlay: OverlayName | null = 'connecting';
function showOverlay(name: OverlayName | null) {
  if (currentOverlay === name) return;
  currentOverlay = name;
  for (const [k, el] of Object.entries(overlays)) el.classList.toggle('hidden', k !== name);
  // Coming back to the menu always shows the three columns, never a format
  // sheet left over from the pub you just walked out of.
  if (name === 'menu') showCreatePanel(false);
}
const hud = $('hud');
const statusEl = $('status');
const setStatus = (msg: string) => { statusEl.textContent = msg; };

let toastTimer = 0;
function showToast(msg: string, color = '') {
  const t = $('toast');
  t.textContent = msg;
  t.style.color = color || 'var(--ink)';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}
/** Every reducer call goes through here so a SenderError lands as a toast. */
function call(p: Promise<unknown>) {
  p.catch((err: any) => showToast(String(err?.message ?? err).toUpperCase(), 'var(--red)'));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
let conn: DbConnection;
let myIdentity: Identity | null = null;
let subscribed = false;
let reconnecting = false;
let connectGen = 0;
let connectFailures = 0;
let connectedDegraded = false;
let reconnectTimer = 0;
const myHex = () => myIdentity?.toHexString() ?? '';

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 1000 * 2 ** Math.min(connectFailures, 4));
  reconnectTimer = window.setTimeout(() => void connect(), delay);
}
function restartConnection() {
  connectGen++;
  try { conn?.disconnect(); } catch { /* already gone */ }
  void connect();
}

async function connect() {
  const gen = ++connectGen;
  const token = await getToken();
  conn = DbConnection.builder()
    .withUri(SPACETIMEDB_URI)
    .withDatabaseName(DATABASE_NAME)
    .withToken(token)
    .onDisconnect(() => {
      if (gen !== connectGen) return;
      if (!reconnecting) {
        reconnecting = true;
        subscribed = false;
        showOverlay('connecting');
        $('conn-sub').textContent = 'CONNECTION LOST — RECONNECTING…';
      }
      scheduleReconnect();
    })
    .onConnect((_c, identity, tok) => {
      if (gen !== connectGen) return;
      console.log('[dq] connected as', identity.toHexString());
      connectFailures = 0;
      reconnecting = false;
      myIdentity = identity;
      connectedDegraded = firebaseEnabled && authDegraded();
      if (!firebaseEnabled || connectedDegraded) localToken.set(tok);
      try {
        conn.subscriptionBuilder()
          .onApplied(() => {
            subscribed = true;
            onSubscribed();
          })
          .onError(e => {
            console.error('[dq] subscription error', e);
            setStatus('SUBSCRIPTION ERROR — SERVER/CLIENT VERSION MISMATCH?');
          })
          .subscribe([
            'SELECT * FROM lobby',
            'SELECT * FROM player',
            'SELECT * FROM entry',
            'SELECT * FROM topic',
            'SELECT * FROM chat',
            'SELECT * FROM account',
            'SELECT * FROM leg_result',
            'SELECT * FROM my_pick',
            'SELECT * FROM my_quiz_log',
            'SELECT * FROM my_questions',
          ]);
      } catch (err) {
        console.error('[dq] subscribe threw', err);
      }
    })
    .onConnectError((_c, err) => {
      if (gen !== connectGen) return;
      connectFailures++;
      console.error('[dq] connect error', err);
      const rejected = /verify token|unauthorized|401/i.test(String((err as any)?.message ?? err));
      let hint = reconnecting ? 'RECONNECTING…' : 'IS THE SERVER RUNNING?';
      if (!firebaseEnabled && (rejected || connectFailures >= 2) && localToken.get()) {
        localToken.clear();
        hint = 'RESETTING SESSION…';
      }
      showOverlay('connecting');
      $('conn-sub').textContent = `CONNECTION FAILED — ${hint} RETRYING…`;
      scheduleReconnect();
    })
    .build();

  conn.db.chat.onInsert((_ctx, row) => onChatRow(row));
  conn.db.player.onUpdate((_ctx, old, row) => {
    dirty = true;
    if (row.identity.toHexString() === myHex() && row.kicked && !old.kicked) {
      showToast('THE HOST SHOWED YOU THE DOOR', 'var(--red)');
    }
    if (row.lobbyId !== old.lobbyId) chatSeen.clear();
  });
  conn.db.player.onInsert(() => { dirty = true; });
  conn.db.player.onDelete(() => { dirty = true; });
  conn.db.lobby.onInsert(() => { dirty = true; });
  conn.db.lobby.onUpdate((_ctx, old, row) => {
    dirty = true;
    if (row.mcText !== old.mcText || row.phase !== old.phase) mcSaidAt = performance.now();
    if (row.phase !== old.phase) onPhaseChange(row, old);
  });
  conn.db.lobby.onDelete(() => { dirty = true; });
  conn.db.topic.onInsert(() => { dirty = true; });
  conn.db.topic.onUpdate(() => { dirty = true; });
  conn.db.topic.onDelete(() => { dirty = true; });
  conn.db.entry.onInsert(() => { dirty = true; });
  conn.db.account.onUpdate(() => { dirty = true; });
  conn.db.myQuestions.onInsert(() => { dirty = true; });
  conn.db.myQuestions.onDelete(() => { dirty = true; });
  conn.db.myPick.onInsert(() => { dirty = true; });
  conn.db.myPick.onDelete(() => { dirty = true; });
  conn.db.myQuizLog.onInsert(() => { dirty = true; });
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------
function getMyPlayer(): Player | null {
  if (!subscribed || !myIdentity) return null;
  for (const p of conn.db.player.iter()) if (p.identity.toHexString() === myHex()) return p;
  return null;
}
function getMyAccount(): Account | null {
  if (!subscribed || !myIdentity) return null;
  for (const a of conn.db.account.iter()) if (a.identity.toHexString() === myHex()) return a;
  return null;
}
function roomById(id: bigint): Lobby | null {
  for (const l of conn.db.lobby.iter()) if (l.id === id) return l;
  return null;
}
function roomByCode(code: string): Lobby | null {
  for (const l of conn.db.lobby.iter()) if (l.code === code) return l;
  return null;
}
function roomPlayers(lobbyId: bigint): Player[] {
  const out: Player[] = [];
  for (const p of conn.db.player.iter()) if (p.lobbyId === lobbyId) out.push(p);
  return out.sort((a, b) => a.seat - b.seat);
}
function roomEntries(lobbyId: bigint): Entry[] {
  const out: Entry[] = [];
  for (const e of conn.db.entry.iter()) if (e.lobbyId === lobbyId) out.push(e);
  return out;
}
function allTopics(): Topic[] {
  return [...conn.db.topic.iter()].sort((a, b) => (a.builtin === b.builtin ? (a.id < b.id ? -1 : 1) : a.builtin ? -1 : 1));
}
const myRoom = (): Lobby | null => {
  const me = getMyPlayer();
  return me && me.lobbyId !== 0n ? roomById(me.lobbyId) : null;
};
const isHost = (room: Lobby) => room.hostId.toHexString() === myHex();
const standingsOf = (room: Lobby) =>
  roomPlayers(room.id).sort((a, b) => b.credits - a.credits || b.correct - a.correct || a.seat - b.seat);

// ---------------------------------------------------------------------------
// Name gate + sign-in (same shape as every Digital game)
// ---------------------------------------------------------------------------
const nameModal = $('name-modal');
const nameInput = $('name-input') as HTMLInputElement;
let afterName: (() => void) | null = null;
let nameGateWaiting = false;

function storedName(): string {
  return (localStorage.getItem('dq_name') || '').trim().toUpperCase().slice(0, 16);
}
/** account.displayName is the source of truth: pull it down on every
 *  subscribe, push the local one up when the account has none. */
function adoptAccountName() {
  const acc = getMyAccount();
  const me = getMyPlayer();
  if (!acc || !me) return;
  if (acc.displayName) {
    localStorage.setItem('dq_name', acc.displayName.toUpperCase());
    if (me.name !== acc.displayName) call(conn.reducers.setName({ name: acc.displayName }));
  } else if (storedName()) {
    call(conn.reducers.setName({ name: storedName() }));
  }
  if (me.avatarId !== acc.avatarId && acc.avatarId < AVATAR_COUNT) call(conn.reducers.setAvatar({ avatarId: acc.avatarId }));
}
function openNameModal(then: () => void) {
  afterName = then;
  nameInput.value = storedName();
  nameModal.classList.remove('hidden');
  $('name-signin').classList.toggle('hidden', !firebaseEnabled);
  nameInput.focus();
}
function submitName() {
  const name = nameInput.value.trim().toUpperCase().slice(0, 16);
  if (!name) { nameInput.focus(); return; }
  localStorage.setItem('dq_name', name);
  nameModal.classList.add('hidden');
  if (getMyPlayer()) call(conn.reducers.setName({ name }));
  const cb = afterName;
  afterName = null;
  cb?.();
}
$('name-ok').addEventListener('click', submitName);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });
$('name-signin').addEventListener('click', () => {
  nameGateWaiting = true;
  nameModal.classList.add('hidden');
  openSignInModal();
});
/** Run `then` once the player has a name — straight away if they already do. */
function withName(then: () => void) {
  if (storedName() || getMyPlayer()?.name) then();
  else openNameModal(then);
}

const signinModal = $('signin-modal');
const siEmail = $('si-email') as HTMLInputElement;
const siPassword = $('si-password') as HTMLInputElement;
let siCreating = false;
const siMsg = (m: string) => { $('si-msg').textContent = m; };
function setSignInMode(creating: boolean) {
  siCreating = creating;
  $('si-title').textContent = creating ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('si-sub').textContent = creating
    ? 'KEEPS YOUR LEVEL AND RECORD — ON ANY DEVICE'
    : 'SIGNING IN SWITCHES ACCOUNTS — THIS DEVICE’S GUEST PROGRESS STAYS BEHIND';
  $('si-submit').textContent = creating ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('si-mode').textContent = creating ? 'ALREADY HAVE AN ACCOUNT? SIGN IN' : 'NEW HERE? CREATE AN ACCOUNT';
  $('si-forgot').classList.toggle('hidden', creating);
  siPassword.autocomplete = creating ? 'new-password' : 'current-password';
}
function openSignInModal() {
  siMsg('');
  siPassword.value = '';
  const linked = accountKind() === 'linked';
  setSignInMode(false);
  $('si-signout').classList.toggle('hidden', !linked);
  for (const id of ['si-email', 'si-password', 'si-submit', 'si-google', 'si-link', 'si-mode', 'si-forgot']) $(id).classList.toggle('hidden', linked);
  if (linked) { $('si-title').textContent = 'YOUR ACCOUNT'; $('si-sub').textContent = accountLabel(); }
  signinModal.classList.remove('hidden');
  if (!linked) siEmail.focus();
}
function closeSignInModal() {
  signinModal.classList.add('hidden');
  siPassword.value = '';
  if (nameGateWaiting) { nameGateWaiting = false; openNameModal(afterName ?? (() => {})); }
}
function afterSignIn(r: SignInResult) {
  if (!r.ok) { siMsg(r.error); return; }
  signinModal.classList.add('hidden');
  nameGateWaiting = false;
  showToast(r.switched ? 'SIGNED IN — SWITCHED TO YOUR ACCOUNT' : 'SIGNED IN', 'var(--green)');
  refreshAccountChip();
  // the identity changed: the player row is keyed to it, so reconnect
  restartConnection();
  afterName = null;
  nameModal.classList.add('hidden');
}
$('si-close').addEventListener('click', closeSignInModal);
$('si-mode').addEventListener('click', () => { siMsg(''); setSignInMode(!siCreating); });
$('si-submit').addEventListener('click', async () => {
  siMsg('…');
  const r = siCreating
    ? await signUpWithPassword(siEmail.value, siPassword.value)
    : await signInWithPassword(siEmail.value, siPassword.value);
  afterSignIn(r);
});
siPassword.addEventListener('keydown', e => { if (e.key === 'Enter') $('si-submit').click(); });
$('si-google').addEventListener('click', async () => { siMsg('…'); afterSignIn(await signInWithGoogle()); });
$('si-link').addEventListener('click', async () => {
  siMsg('SENDING…');
  const r = await sendEmailLink(siEmail.value);
  siMsg(r.ok ? 'CHECK YOUR INBOX — OPEN THE LINK ON THIS DEVICE' : r.error);
});
$('si-forgot').addEventListener('click', async () => {
  const r = await sendPasswordReset(siEmail.value);
  siMsg(r.ok ? 'RESET EMAIL SENT' : r.error);
});
$('si-signout').addEventListener('click', async () => {
  await signOut();
  signinModal.classList.add('hidden');
  localStorage.removeItem('dq_name');
  showToast('SIGNED OUT — YOU ARE A NEW GUEST');
  restartConnection();
});
function refreshAccountChip() {
  const btn = $('account-btn');
  const label = $('account-label');
  if (!firebaseEnabled) { $('account-chip').classList.add('hidden'); return; }
  const kind = accountKind();
  label.textContent = kind === 'linked' ? accountLabel() : kind === 'offline' ? 'ACCOUNT SERVICE UNREACHABLE' : 'GUEST — PROGRESS ON THIS DEVICE';
  btn.textContent = kind === 'linked' ? 'ACCOUNT' : 'SIGN IN';
}
$('account-btn').addEventListener('click', openSignInModal);
$('leg-guest-signin').addEventListener('click', openSignInModal);

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
const AVATAR_COUNT = CHARACTERS.length;
const avatarSwatch = (id: number) => CHARACTERS[id % AVATAR_COUNT].css;
const avatarInitial = (id: number) => CHARACTERS[id % AVATAR_COUNT].name[0];

function refreshProfile() {
  const acc = getMyAccount();
  const me = getMyPlayer();
  $('profile-name').textContent = me?.name || storedName() || 'GUEST';
  const av = $('profile-avatar');
  const avatarId = me?.avatarId ?? 0;
  av.textContent = avatarInitial(avatarId);
  av.style.background = avatarSwatch(avatarId);
  if (!acc) return;
  const need = C.totalXpFor(acc.level + 1) - C.totalXpFor(acc.level);
  const have = acc.xp - C.totalXpFor(acc.level);
  $('profile-level').textContent = `LEVEL ${acc.level} · ${acc.xp} XP`;
  ($('xp-fill') as HTMLElement).style.width = `${acc.level >= C.LEVEL_MAX ? 100 : Math.min(100, (have / need) * 100)}%`;
  const acc_ = acc.questions ? Math.round((acc.correct / acc.questions) * 100) : 0;
  $('profile-stats').innerHTML =
    `<span>QUIZZES <b>${acc.quizzes}</b></span><span>WINS <b>${acc.quizWins}</b></span>` +
    `<span>ACCURACY <b>${acc_}%</b></span><span>BEST SCORE <b>${acc.bestCredits}${C.PTS}</b></span>` +
    `<span title="Times caught on the phone">📱 <b>${acc.phoneChecks}</b></span>`;
}
$('profile-name').addEventListener('click', () => openNameModal(() => refreshProfile()));
$('profile-avatar').addEventListener('click', () => openAvatarSelect(() => showOverlay('menu')));

function fillThemeSelect(sel: HTMLSelectElement) {
  sel.innerHTML = C.PUBS.map((p, i) => `<option value="${i}">${p}</option>`).join('');
}
function fillLangSelect(sel: HTMLSelectElement, withAny = true) {
  sel.innerHTML = C.LANGS.filter(l => withAny || l.code !== C.LANG_ANY)
    .map(l => `<option value="${l.code}">${l.flag} ${l.label}</option>`)
    .join('');
}
fillThemeSelect($('c-theme') as HTMLSelectElement);
fillThemeSelect($('s-theme') as HTMLSelectElement);
fillLangSelect($('c-lang') as HTMLSelectElement);
fillLangSelect($('s-lang') as HTMLSelectElement);
fillLangSelect($('qw-topic-lang') as HTMLSelectElement, false);
// A Norwegian browser opens on a Norwegian pub without hunting for the setting.
($('c-lang') as HTMLSelectElement).value = C.defaultLang();
($('qw-topic-lang') as HTMLSelectElement).value = C.defaultLang();
// The venue list follows the language: a Norwegian night gets the Norwegian
// pubs up front (the other venues are still there, one scroll away).
function preferVenueFor(lang: string) {
  const sel = $('c-theme') as HTMLSelectElement;
  sel.value = String(lang === 'nb' ? 3 : 0);
}
preferVenueFor(C.defaultLang());
$('c-lang').addEventListener('change', () => preferVenueFor(($('c-lang') as HTMLSelectElement).value));

// The format sheet takes the menu's place rather than stacking under it —
// three panels plus a five-field form does not fit the screen at once.
function showCreatePanel(on: boolean) {
  $('create-panel').classList.toggle('hidden', !on);
  $('menu-layout').classList.toggle('hidden', on);
}
$('btn-create').addEventListener('click', () => withName(() => showCreatePanel(true)));
$('c-cancel').addEventListener('click', () => showCreatePanel(false));
$('c-go').addEventListener('click', () => {
  const num = (id: string, lo: number, hi: number, def: number) => {
    const v = Number(($(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
  };
  call(conn.reducers.createPub({
    isPublic: ($('c-public') as HTMLInputElement).checked,
    theme: Number(($('c-theme') as HTMLSelectElement).value),
    questions: num('c-questions', C.QUESTIONS_MIN, C.QUESTIONS_MAX, C.QUESTIONS_DEFAULT),
    answerSecs: num('c-answer', C.ANSWER_SECS_MIN, C.ANSWER_SECS_MAX, C.ANSWER_SECS_DEFAULT),
    teamMode: ($('c-teams') as HTMLInputElement).checked,
    lang: ($('c-lang') as HTMLSelectElement).value,
  }));
  showCreatePanel(false);
});
function joinByCode(code: string) {
  const clean = code.trim().toUpperCase();
  if (!clean) return;
  const room = roomByCode(clean);
  if (!room) { showToast('NO PUB WITH THAT CODE', 'var(--red)'); return; }
  if (room.status === C.L_FINISHED) { showToast('THAT QUIZ HAS FINISHED', 'var(--red)'); return; }
  withName(() => call(conn.reducers.joinPub({ code: clean })));
}
$('btn-join').addEventListener('click', () => joinByCode(($('join-code') as HTMLInputElement).value));
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(($('join-code') as HTMLInputElement).value); });

function refreshPublicList() {
  const list = $('public-list');
  const rooms = [...conn.db.lobby.iter()].filter(l => l.isPublic && l.status !== C.L_FINISHED);
  if (rooms.length === 0) { list.innerHTML = '<div class="subtitle">NOBODY’S OPEN YET</div>'; return; }
  list.innerHTML = '';
  for (const room of rooms) {
    const players = roomPlayers(room.id);
    const host = players.find(p => p.identity.toHexString() === room.hostId.toHexString());
    const row = document.createElement('div');
    row.className = 'lobby-row';
    row.innerHTML = `<div><b>${escapeHtml(C.PUBS[room.theme] ?? 'THE PUB')}</b><div class="meta">${escapeHtml(host?.name || 'SOMEONE')} · ${players.length}/${C.MAX_SEATS} · ${room.questionCount} Q${room.status === C.L_RUNNING ? ' · LIVE' : ''}</div></div>`;
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = room.status === C.L_RUNNING ? 'WALK IN' : 'JOIN';
    btn.onclick = () => joinByCode(room.code);
    row.appendChild(btn);
    list.appendChild(row);
  }
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------------------------------------------------------------------------
// Avatar select
// ---------------------------------------------------------------------------
let avatarPick = 0;
let afterAvatar: (() => void) | null = null;
let charCardsBuilt = false;

// The card grid is built once; every card carries a live 3D rig of its
// character, drawn by the shared preview canvas (the same screen, the same
// rigs and the same code as digital-tennis's PLAYER SELECT).
function buildCharacterCards() {
  if (charCardsBuilt) return;
  charCardsBuilt = true;
  const grid = $('char-grid');
  // each card carries a live 3D preview of its character: the empty slot
  // reserves layout space, and render.ts scissors a shared WebGL canvas
  // (fixed over the screen) into one animated viewport per slot. Same cards,
  // same rigs, same code as digital-tennis's PLAYER SELECT.
  const previewSlots: { char: typeof CHARACTERS[number]; el: HTMLElement }[] = [];
  for (const c of CHARACTERS) {
    const card = document.createElement('button');
    card.className = 'sel-card';
    card.dataset.id = String(c.id);
    const statHtml = STAT_LABELS.map(([key, label]) => {
      const v = c.stats[key];
      let pips = '';
      for (let i = 1; i <= 5; i++) pips += `<i class="pip${i <= v ? ' on' : ''}"></i>`;
      return `<div class="stat-row"><span class="stat-name">${label}</span><span class="stat-pips">${pips}</span></div>`;
    }).join('');
    card.innerHTML =
      `<span class="preview-slot" style="--glow:${c.css}"></span>` +
      `<div class="cname">${c.name}</div><div class="cmeta">${c.flag} ${c.country} · ${c.style}</div>` +
      `<div class="stat-grid">${statHtml}</div>`;
    card.addEventListener('click', () => {
      avatarPick = c.id;
      refreshCharSelection();
      call(conn.reducers.setAvatar({ avatarId: c.id }));
    });
    grid.appendChild(card);
    previewSlots.push({ char: c, el: card.querySelector('.preview-slot')! });
  }
  staggerChildren(grid);
  initCharacterPreviews($('char-preview') as HTMLCanvasElement, previewSlots, grid);
}

// The staggered entrance the tennis screens use: each child animates in a
// beat after the one before it.
function staggerChildren(container: HTMLElement) {
  let i = 0;
  for (const el of container.children) (el as HTMLElement).style.setProperty('--i', String(i++));
}

function refreshCharSelection() {
  const c = CHARACTERS[avatarPick] ?? CHARACTERS[0];
  for (const card of document.querySelectorAll<HTMLElement>('#char-grid .sel-card')) {
    card.classList.toggle('selected', Number(card.dataset.id) === avatarPick);
  }
  $('char-style').textContent = `${c.flag} ${c.name} — ${c.style}`;
}

function openAvatarSelect(then: () => void) {
  afterAvatar = then;
  avatarPick = getMyPlayer()?.avatarId ?? 0;
  buildCharacterCards();
  refreshCharSelection();
  showOverlay('avatar');
}
$('avatar-done').addEventListener('click', () => {
  call(conn.reducers.setAvatar({ avatarId: avatarPick }));
  localStorage.setItem('dq_avatar_picked', '1');
  // back to wherever the rows say we are (refreshUi stands down while the
  // avatar screen is up, so it has to be told)
  showOverlay('menu');
  dirty = true;
  const cb = afterAvatar;
  afterAvatar = null;
  cb?.();
});

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
let settingsDirty = false; // host is mid-edit — don't clobber the fields
let lastRoomIdShown = 0n;

function refreshLobby(room: Lobby, me: Player) {
  showOverlay('lobby');
  const host = isHost(room);
  const isLeg = room.championshipLeg !== 0n;
  $('lobby-title').textContent = isLeg ? 'CHAMPIONSHIP LEG' : (C.PUBS[room.theme] ?? 'THE PUB').toUpperCase();
  $('lobby-sub').textContent = isLeg
    ? 'THIS QUIZ IS A LEG OF A CHAMPIONSHIP — THE RESULT GOES TO ITS STANDINGS'
    : room.status === C.L_FINISHED ? 'THE QUIZ IS OVER — THE HOST CAN RUN ANOTHER ROUND' : 'SHARE THIS CODE OR LINK WITH YOUR FRIENDS';
  $('leg-guest-warning').classList.toggle('hidden', !(isLeg && accountKind() === 'guest'));
  $('lobby-code').textContent = room.code;
  $('lobby-link').textContent = `${location.origin}${location.pathname}?lobby=${room.code}`;

  const players = roomPlayers(room.id);
  const roster = $('lobby-roster');
  roster.innerHTML = '';
  for (const p of players) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.identity.toHexString() === room.hostId.toHexString() ? ' host' : '');
    const tag = p.attention === C.ATT_PHONE ? '<span class="tag phone">📱 ON PHONE</span>'
      : !p.online ? '<span class="tag">AWAY</span>'
      : p.ready ? '<span class="tag ready">READY</span>' : '<span class="tag">NOT READY</span>';
    const team = room.teamMode && p.team ? `<span class="team-dot" style="background:${C.TEAM_COLORS[p.team]}"></span>` : '';
    chip.innerHTML = `<div class="face" style="background:${avatarSwatch(p.avatarId)}"></div><span class="name">${escapeHtml(p.name || 'GUEST')}</span>${team}${tag}`;
    if (host && p.identity.toHexString() !== myHex()) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '✕';
      kick.title = 'Remove from the pub';
      kick.onclick = () => call(conn.reducers.kickPlayer({ target: p.identity }));
      chip.appendChild(kick);
    }
    roster.appendChild(chip);
  }
  // teams
  const teamPick = $('team-pick');
  teamPick.classList.toggle('hidden', !room.teamMode);
  if (room.teamMode) {
    teamPick.innerHTML = '';
    for (let t = 1; t <= C.MAX_TEAMS; t++) {
      const b = document.createElement('button');
      b.className = 'team-btn small';
      b.style.background = C.TEAM_COLORS[t];
      b.style.opacity = me.team === t ? '1' : '0.55';
      b.textContent = C.TEAM_NAMES[t];
      b.onclick = () => call(conn.reducers.setTeam({ team: t }));
      teamPick.appendChild(b);
    }
  }
  // settings (host edits, everyone sees the summary)
  const settings = $('lobby-settings');
  const fields = ['s-lang', 's-theme', 's-questions', 's-answer', 's-teams'];
  for (const id of fields) ($(id) as HTMLInputElement).disabled = !host;
  if (!settingsDirty || lastRoomIdShown !== room.id) {
    ($('s-theme') as HTMLSelectElement).value = String(room.theme);
    ($('s-questions') as HTMLInputElement).value = String(room.questionCount);
    ($('s-answer') as HTMLInputElement).value = String(room.answerSecs);
    ($('s-teams') as HTMLInputElement).checked = room.teamMode;
    ($('s-lang') as HTMLSelectElement).value = room.lang;
  }
  lastRoomIdShown = room.id;
  // Only topics the room can actually draw from: a Norwegian night never
  // shows (or draws) an English pack.
  const topics = allTopics().filter(t => room.lang === C.LANG_ANY || t.lang === room.lang);
  const chosen = new Set(room.topics.map(String));
  const pills = $('s-topics');
  pills.innerHTML = '';
  for (const t of topics) {
    const on = chosen.size === 0 || chosen.has(String(t.id));
    const pill = document.createElement('div');
    pill.className = 'topic-pill ' + (on ? 'on' : 'off');
    pill.innerHTML = `${escapeHtml(t.icon)} ${escapeHtml(t.name)} <span class="n">${t.questionCount}</span>`;
    if (host) {
      pill.onclick = () => {
        // toggling from "all" starts with everything on
        const next = new Set(chosen.size === 0 ? topics.map(t => String(t.id)) : chosen);
        if (next.has(String(t.id))) next.delete(String(t.id)); else next.add(String(t.id));
        if (next.size === 0) { showToast('KEEP AT LEAST ONE TOPIC', 'var(--red)'); return; }
        const all = next.size === topics.length;
        call(conn.reducers.setPubTopics({ topics: all ? [] : [...next].map(BigInt) }));
      };
    }
    pills.appendChild(pill);
  }
  const pool = topics.filter(t => chosen.size === 0 || chosen.has(String(t.id))).reduce((n, t) => n + t.questionCount, 0);
  const lang = C.langLabel(room.lang);
  $('lobby-summary').textContent =
    `${lang.flag} ${lang.label} · ${room.questionCount} QUESTIONS FROM A POOL OF ${pool} · ` +
    `ANSWERS ${room.answerSecs}S${room.teamMode ? ' · TEAMS' : ''}`;
  settings.classList.toggle('hidden', room.status === C.L_RUNNING);

  const unready = players.filter(p => !p.ready).length;
  const readyBtn = $('btn-ready') as HTMLButtonElement;
  readyBtn.textContent = me.ready ? 'NOT READY' : 'READY UP';
  readyBtn.classList.toggle('ghost', !me.ready);
  const startBtn = $('btn-start') as HTMLButtonElement;
  startBtn.classList.toggle('hidden', !host);
  startBtn.textContent = room.status === C.L_FINISHED ? 'ANOTHER ROUND' : unready ? `START ANYWAY (${unready} NOT READY)` : 'START THE QUIZ';
  startBtn.disabled = players.length === 0;
}
for (const id of ['s-questions', 's-answer']) {
  $(id).addEventListener('focus', () => { settingsDirty = true; });
  $(id).addEventListener('change', pushSettings);
  $(id).addEventListener('blur', () => { settingsDirty = false; });
}
$('s-theme').addEventListener('change', pushSettings);
$('s-lang').addEventListener('change', pushSettings);
$('s-teams').addEventListener('change', pushSettings);
function pushSettings() {
  const room = myRoom();
  if (!room || !isHost(room)) return;
  const num = (id: string, lo: number, hi: number, def: number) => {
    const v = Number(($(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
  };
  call(conn.reducers.setPubSettings({
    questions: num('s-questions', C.QUESTIONS_MIN, C.QUESTIONS_MAX, room.questionCount),
    answerSecs: num('s-answer', C.ANSWER_SECS_MIN, C.ANSWER_SECS_MAX, room.answerSecs),
    teamMode: ($('s-teams') as HTMLInputElement).checked,
    theme: Number(($('s-theme') as HTMLSelectElement).value),
    lang: ($('s-lang') as HTMLSelectElement).value,
  }));
}
$('copy-link').addEventListener('click', () => {
  navigator.clipboard?.writeText($('lobby-link').textContent || '').then(() => showToast('LINK COPIED', 'var(--green)'));
});
$('btn-ready').addEventListener('click', () => { const me = getMyPlayer(); if (me) call(conn.reducers.setReady({ ready: !me.ready })); });
$('btn-start').addEventListener('click', () => call(conn.reducers.startQuiz({})));
$('btn-leave').addEventListener('click', () => call(conn.reducers.leavePub({})));

// ---------------------------------------------------------------------------
// The quiz HUD
// ---------------------------------------------------------------------------
let mcSaidAt = 0;
let lastPhaseKey = '';
const chatSeen = new Set<string>();
const bubbles = new Map<string, { text: string; at: number }>();
let myMood = 0;
let moods = new Map<string, number>();

function onPhaseChange(room: Lobby, old: Lobby) {
  if (myRoom()?.id !== room.id) return;
  if (room.phase === C.PH_RESULT) {
    // moods for the rigs: who just won/lost
    moods = new Map();
    for (const p of roomPlayers(room.id)) moods.set(p.identity.toHexString(), p.lastCorrect ? 1 : 2);
    const me = getMyPlayer();
    myMood = me?.lastCorrect ? 1 : 2;
    playTone(me?.lastCorrect ? 880 : 180, me?.lastCorrect ? 0.12 : 0.25);
  } else if (room.phase === C.PH_ANSWER) {
    moods = new Map();
    playTone(660, 0.08);
  } else if (room.phase === C.PH_DONE) {
    playTone(990, 0.3);
  }
  void old;
}

// tiny synth so phase changes are audible when you're alt-tabbed (yes, that
// is on purpose — the pub is calling you back)
let audioCtx: AudioContext | null = null;
function playTone(freq: number, secs: number) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    g.gain.value = 0.08;
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + secs);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + secs);
  } catch { /* no audio, no problem */ }
}

const secsLeft = (room: Lobby) => Math.max(0, Number(room.phaseEndsAt.microsSinceUnixEpoch - BigInt(Date.now()) * 1000n) / 1_000_000);
const phaseLen = (room: Lobby) => Math.max(0.001, Number(room.phaseEndsAt.microsSinceUnixEpoch - room.phaseStartedAt.microsSinceUnixEpoch) / 1_000_000);

function refreshHud(room: Lobby, me: Player) {
  showOverlay(null);
  hud.classList.remove('hidden');
  const T = C.tr(room.lang);
  const final = room.questionIdx >= room.questionCount - 1;
  $('hud-pub').textContent = (C.PUBS[room.theme] ?? 'THE PUB').toUpperCase();
  $('hud-q').textContent = room.phase === C.PH_INTRO
    ? T.warmingUp
    : `${T.question} ${room.questionIdx + 1}/${room.questionCount}${final ? ` · ${T.lastOrders}` : ''}`;
  $('hud-mc').textContent = room.mcText ? `“${room.mcText}”` : '';
  $('hud-score').innerHTML = `${T.score} <b id="score-val">${me.credits}</b>${C.PTS}`;
  ($('btn-esc') as HTMLButtonElement).textContent = T.menu;
  (chatInput as HTMLInputElement).placeholder = T.chatPlaceholder;
  const mine = myAnswer(room, me);
  const phaseKey = `${room.id}|${room.questionIdx}|${room.phase}|${room.qOptions.join('|')}|${room.qCorrect}|${mine}|${me.credits}`;
  const changed = phaseKey !== lastPhaseKey;
  lastPhaseKey = phaseKey;

  const kicker = $('q-kicker');
  const title = $('q-title');
  const options = $('q-options');
  const result = $('result-panel');
  if (changed) {
    options.classList.add('hidden');
    result.classList.add('hidden');
    $('answer-note').textContent = '';
    if (room.phase === C.PH_INTRO) {
      kicker.textContent = T.welcome;
      title.textContent = T.intro(room.questionCount, C.POINTS_PER_CORRECT);
    } else if (room.phase === C.PH_ANSWER || room.phase === C.PH_RESULT) {
      kicker.textContent = `${room.qIcon} ${room.qTopic} · ${T.difficulty[room.qDifficulty]}`;
      title.textContent = room.qText;
      options.classList.remove('hidden');
      options.innerHTML = '';
      room.qOptions.forEach((opt, i) => {
        const b = document.createElement('button');
        b.className = 'opt';
        if (mine === i) b.classList.add('mine');
        if (room.phase === C.PH_RESULT) {
          if (i === room.qCorrect) b.classList.add('right');
          else if (mine === i) b.classList.add('wrong');
          b.disabled = true;
        } else b.disabled = mine === i; // the rest stay live: tap another to change
        b.innerHTML = `<span class="letter" style="background:${['#ff4b33', '#3c8dff', '#43e97b', '#ffd60a'][i]};color:${i === 3 ? '#1a1200' : '#fff'}">${'ABCD'[i]}</span><span>${escapeHtml(opt)}</span>`;
        b.onclick = () => call(conn.reducers.answer({ choice: i }));
        options.appendChild(b);
      });
      // Nothing is final until the clock runs out, so say so once they are in.
      $('answer-note').textContent = room.phase === C.PH_ANSWER && mine !== C.NO_ANSWER ? T.changeHint : '';
      if (room.phase === C.PH_RESULT) {
        result.classList.remove('hidden');
        const d = me.lastDelta;
        const speed = room.fastestName ? ` · ${T.fastest}: ${escapeHtml(room.fastestName)}` : '';
        result.innerHTML = mine === C.NO_ANSWER
          ? `<span class="delta down">${T.noAnswer}</span>${speed}`
          : `<span class="delta ${d > 0 ? 'up' : 'down'}">${me.lastCorrect ? T.correct : T.wrong} +${d}${C.PTS}</span>${speed}`;
      }
    }
  }
  // clock
  const left = secsLeft(room);
  const clock = $('hud-clock');
  clock.textContent = room.phase === C.PH_RESULT ? '·' : String(Math.ceil(left));
  clock.classList.toggle('hot', left < 5 && room.phase === C.PH_ANSWER);

  // standings
  const st = $('standings');
  const order = standingsOf(room);
  let html = '';
  if (room.teamMode) {
    const totals = new Map<number, number>();
    for (const p of order) totals.set(p.team, (totals.get(p.team) ?? 0) + p.credits);
    const teams = [...totals.entries()].filter(([t]) => t !== C.TEAM_NONE).sort((a, b) => b[1] - a[1]);
    for (const [t, cr] of teams) html += `<div class="st-row team" style="border-color:${C.TEAM_COLORS[t]}"><span class="name" style="color:${C.TEAM_COLORS[t]}">TEAM ${C.TEAM_NAMES[t]}</span><span class="cr">${cr}${C.PTS}</span></div>`;
  }
  order.forEach((p, i) => {
    const me_ = p.identity.toHexString() === myHex();
    const delta = room.phase === C.PH_RESULT ? `<span class="d ${p.lastDelta > 0 ? 'up' : 'down'}">+${p.lastDelta}</span>` : '';
    const flag = p.attention === C.ATT_PHONE ? ' 📱' : p.attention === C.ATT_IDLE ? ' 💤' : p.answeredAt !== 0n && room.phase === C.PH_ANSWER ? ' ✔' : '';
    html += `<div class="st-row${me_ ? ' me' : ''}"><span class="pos">${i + 1}</span><span class="name" style="${room.teamMode && p.team ? `color:${C.TEAM_COLORS[p.team]}` : ''}">${escapeHtml(p.name || 'GUEST')}${flag}</span>${delta}<span class="cr">${p.credits}${C.PTS}</span></div>`;
  });
  st.innerHTML = html;

  // self phone banner (you can't see it while away, but it greets you back)
  $('phone-self').innerHTML = `${T.onPhone}<small>${T.onPhoneSub}</small>`;
  $('phone-self').classList.toggle('hidden', me.attention !== C.ATT_PHONE);
  refreshCallouts(room, me);
}

// ---------------------------------------------------------------------------
// Walking about. The same controls as digital-tennis's grounds: WASD or the
// arrows walk, SPACE jumps, E waves, and a gamepad stick does the same. The
// answer keys are 1-4 (A-D would fight with the walk keys).
// ---------------------------------------------------------------------------
// Fullscreen: the menu button, the ESC-menu button and F all come here. The
// stage keeps its 16:10 shape and grows to fill the screen (see the
// #app:fullscreen rules) — the renderer re-reads the canvas size every frame,
// so nothing else has to be told.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('app').requestFullscreen().catch(() => showToast('FULLSCREEN BLOCKED BY THE BROWSER', 'var(--red)'));
}
$('menu-fullscreen-btn').addEventListener('click', toggleFullscreen);

const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
const ACT_JUMP = 0;
const ACT_WAVE = 1;
const pressed = new Set<string>();
let lastSentDir = { dirX: 0, dirY: 0 };

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA';
};

function keyboardDir(): [number, number] {
  let dx = 0;
  let dy = 0;
  for (const key of pressed) {
    const v = MOVE_KEYS[key];
    if (v) { dx += v[0]; dy += v[1]; }
  }
  return [dx, dy];
}

function padDir(): [number, number] | null {
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp || !gp.connected) continue;
    for (const [btn, kind] of [[0, ACT_JUMP], [1, ACT_WAVE]] as const) {
      const down = gp.buttons[btn]?.pressed ?? false;
      if (down && !padPrev[btn]) call(conn.reducers.act({ kind }));
      padPrev[btn] = down;
    }
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    if (Math.hypot(ax, ay) < 0.35) return [0, 0];
    return [Math.abs(ax) > 0.35 ? Math.sign(ax) : 0, Math.abs(ay) > 0.35 ? Math.sign(ay) : 0];
  }
  return null;
}
const padPrev = [false, false];

function sendDir(dx: number, dy: number) {
  const dirX = Math.sign(dx);
  const dirY = Math.sign(dy);
  if (dirX === lastSentDir.dirX && dirY === lastSentDir.dirY) return;
  lastSentDir = { dirX, dirY };
  if (!conn || !subscribed) return;
  call(conn.reducers.setInput({ dirX, dirY }));
}

function pumpInput() {
  const me = getMyPlayer();
  if (!me || me.lobbyId === 0n) {
    if (lastSentDir.dirX || lastSentDir.dirY) sendDir(0, 0);
    return;
  }
  const pad = padDir();
  const [kx, ky] = keyboardDir();
  const [dx, dy] = pad && (pad[0] || pad[1]) ? pad : [kx, ky];
  sendDir(dx, dy);
}

window.addEventListener('keydown', e => {
  if (typing(e.target)) return;
  if (e.key === 'Escape') {
    if (myRoom()) toggleEscMenu();
    return;
  }
  if (MOVE_KEYS[e.code]) {
    pressed.add(e.code);
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') { call(conn.reducers.act({ kind: ACT_JUMP })); e.preventDefault(); return; }
  if (e.code === 'KeyE') { call(conn.reducers.act({ kind: ACT_WAVE })); return; }
  if (e.code === 'KeyF') { toggleFullscreen(); return; }
  const room = myRoom();
  if (!room || room.status !== C.L_RUNNING || room.phase !== C.PH_ANSWER) return;
  const idx = '1234'.indexOf(e.key);
  if (idx >= 0 && idx < room.qOptions.length) call(conn.reducers.answer({ choice: idx }));
});
window.addEventListener('keyup', e => { pressed.delete(e.code); });
window.addEventListener('blur', () => { pressed.clear(); sendDir(0, 0); });

// Call-outs: a button floats over anyone on their phone
function refreshCallouts(room: Lobby, me: Player) {
  const layer = $('callouts');
  const wanted = roomPlayers(room.id).filter(p => p.attention !== C.ATT_HERE && p.identity.toHexString() !== myHex());
  const have = new Map<string, HTMLElement>();
  layer.querySelectorAll<HTMLElement>('.callout-btn').forEach(el => have.set(el.dataset.key!, el));
  for (const p of wanted) {
    const key = p.identity.toHexString();
    let el = have.get(key);
    if (!el) {
      el = document.createElement('button');
      el.className = 'callout-btn';
      el.dataset.key = key;
      el.onclick = () => call(conn.reducers.callOut({ target: p.identity }));
      layer.appendChild(el);
    }
    const T = C.tr(room.lang);
    el.textContent = p.attention === C.ATT_PHONE ? T.callOut(p.name) : T.wake(p.name);
    have.delete(key);
  }
  for (const el of have.values()) el.remove();
  void me;
}
function positionCallouts() {
  $('callouts').querySelectorAll<HTMLElement>('.callout-btn').forEach(el => {
    const pos = headScreenPos(el.dataset.key!);
    if (!pos) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y - 8}px`;
  });
}

// Chat + emotes
const chatInput = $('chat-input') as HTMLInputElement;
let lastChatAt = 0;
let lastEmoteAt = 0;
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { chatInput.blur(); return; }
  if (e.key !== 'Enter') return;
  const text = chatInput.value.trim();
  if (!text) { chatInput.blur(); return; }
  if (performance.now() - lastChatAt < C.CHAT_MIN_GAP_MS) { showToast('SLOW DOWN'); return; }
  lastChatAt = performance.now();
  call(conn.reducers.sendChat({ text }));
  chatInput.value = '';
});
C.EMOTES.forEach((em, i) => {
  const b = document.createElement('button');
  b.textContent = em;
  b.onclick = () => {
    if (performance.now() - lastEmoteAt < C.EMOTE_MIN_GAP_MS) return;
    lastEmoteAt = performance.now();
    call(conn.reducers.sendEmote({ index: i }));
    b.blur();
  };
  $('emote-bar').appendChild(b);
});
function onChatRow(row: ChatRow) {
  const me = getMyPlayer();
  if (!me || row.lobbyId !== me.lobbyId) return;
  const key = String(row.id);
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  const log = $('chat-log');
  const line = document.createElement('div');
  line.className = 'chat-line' + (row.kind === C.CHAT_MC ? ' mc' : row.kind === C.CHAT_CALLOUT ? ' callout' : '');
  line.innerHTML = row.kind === C.CHAT_CALLOUT
    ? `<b>🗣 ${escapeHtml(row.senderName)}:</b> ${escapeHtml(row.text)}`
    : `<b>${escapeHtml(row.senderName)}:</b> ${escapeHtml(row.text)}`;
  log.appendChild(line);
  while (log.children.length > 40) log.removeChild(log.firstChild!);
  log.scrollTop = log.scrollHeight;
  // fresh rows (not the backlog on subscribe) get a bubble over the head
  const ageMs = Date.now() - Number(row.sentAt.microsSinceUnixEpoch / 1000n);
  if (ageMs < 3000 && row.kind !== C.CHAT_MC) {
    const senderKey = row.senderId.toHexString();
    bubbles.set(senderKey, { text: row.kind === C.CHAT_CALLOUT ? `🗣 ${row.text}` : row.text, at: performance.now() });
    // an emote is body language too — the same routines the tennis grounds run
    if (row.kind === C.CHAT_EMOTE) triggerEmote(senderKey, emoteKind(row.text));
  }
}

// The module's EMOTES order and this must agree (same table as
// digital-tennis's watcherEmoteKind).
function emoteKind(text: string): number {
  switch (text) {
    case '😂': return WATCHER_EMOTE_LAUGH;
    case '😭': return WATCHER_EMOTE_SULK;
    case '😡': return WATCHER_EMOTE_RAGE;
    default: return WATCHER_EMOTE_CHEER;
  }
}

// ESC menu
const escMenu = $('esc-menu');
function toggleEscMenu() { escMenu.classList.toggle('hidden'); if (!escMenu.classList.contains('hidden')) renderEscMenu(); }
function renderEscMenu() {
  const room = myRoom();
  const list = $('mm-players');
  list.innerHTML = '';
  if (!room) return;
  const host = isHost(room);
  for (const p of roomPlayers(room.id)) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.identity.toHexString() === room.hostId.toHexString() ? ' host' : '');
    chip.innerHTML = `<div class="face" style="background:${avatarSwatch(p.avatarId)}"></div><span class="name">${escapeHtml(p.name || 'GUEST')}</span><span class="tag">${p.credits}${C.PTS}${p.attention === C.ATT_PHONE ? ' · 📱' : ''}</span>`;
    if (host && p.identity.toHexString() !== myHex()) {
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = '✕';
      kick.onclick = () => { call(conn.reducers.kickPlayer({ target: p.identity })); renderEscMenu(); };
      chip.appendChild(kick);
    }
    list.appendChild(chip);
  }
}
$('btn-esc').addEventListener('click', toggleEscMenu);
$('mm-resume').addEventListener('click', () => escMenu.classList.add('hidden'));
$('mm-leave').addEventListener('click', () => { escMenu.classList.add('hidden'); call(conn.reducers.leavePub({})); });
$('mm-fullscreen').addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let resultsShownFor = '';
function refreshResults(room: Lobby, me: Player) {
  showOverlay('results');
  hud.classList.add('hidden');
  const key = `${room.id}|${room.drawn.length}|${roomPlayers(room.id).length}`;
  const order = standingsOf(room);
  const T = C.tr(room.lang);
  $('results-title').textContent = room.championName ? T.takesThePot(room.championName.toUpperCase()) : T.thatsTheQuiz;
  $('results-sub').textContent = room.championshipLeg !== 0n ? 'CHAMPIONSHIP LEG — THE RESULT HAS GONE TO THE HUB' : (C.PUBS[room.theme] ?? '').toUpperCase();
  const list = $('results-list');
  list.innerHTML = '';
  order.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'res-row';
    const phone = p.phoneChecks ? ` · 📱 ×${p.phoneChecks} (${Math.round(Number(p.phoneMicros / 1_000_000n))}s)` : '';
    row.innerHTML = `<span class="pos">${i + 1}</span><div class="face" style="width:28px;height:28px;border-radius:50%;background:${avatarSwatch(p.avatarId)}"></div><span class="name">${escapeHtml(p.name || 'GUEST')}${p.identity.toHexString() === myHex() ? ' ★' : ''}<div class="meta">${T.correctOf(p.correct, room.questionCount)}${phone}</div></span><span class="cr">${p.credits}${C.PTS}</span>`;
    list.appendChild(row);
  });
  if (key !== resultsShownFor) {
    resultsShownFor = key;
    renderAwards(room, order);
  }
  const host = isHost(room);
  $('btn-again').textContent = T.again;
  $('btn-results-leave').textContent = T.leave;
  $('btn-again').classList.toggle('hidden', !host);
  // XP reveal: my newest quiz_log row for this room
  let mine: any = null;
  for (const l of conn.db.myQuizLog.iter()) if (l.lobbyId === room.id && (!mine || l.id > mine.id)) mine = l;
  $('xp-reveal').innerHTML = mine ? `+<b>${mine.xpGained} XP</b> · LEVEL <b>${mine.levelAfter}</b>${mine.won ? ' · <b>WIN</b>' : ''}` : '';
  void me;
}
function renderAwards(room: Lobby, order: Player[]) {
  const T = C.tr(room.lang);
  const entries = roomEntries(room.id);
  const awards: { t: string; w: string; s: string }[] = [];
  const byName = (id: string) => order.find(p => p.identity.toHexString() === id)?.name ?? '?';
  // fastest finger: most "fastest correct" — approximate with lowest average answer time among correct
  const speed = new Map<string, { n: number; ms: number }>();
  for (const e of entries) {
    const id = e.identity.toHexString();
    if (e.correct && e.answerMillis) {
      const s = speed.get(id) ?? { n: 0, ms: 0 };
      s.n++; s.ms += e.answerMillis;
      speed.set(id, s);
    }
  }
  const fastest = [...speed.entries()].filter(([, s]) => s.n >= 2).sort((a, b) => a[1].ms / a[1].n - b[1].ms / b[1].n)[0];
  if (fastest) awards.push({ t: T.awardFastest, w: byName(fastest[0]), s: T.avgSecs(C.decimal(room.lang, fastest[1].ms / fastest[1].n / 1000)) });
  const sharp = [...order].sort((a, b) => b.correct - a.correct)[0];
  if (sharp && sharp.correct > 0) awards.push({ t: T.awardSharpest, w: sharp.name, s: T.rightOf(sharp.correct, room.questionCount) });
  const phone = [...order].sort((a, b) => Number(b.phoneMicros - a.phoneMicros))[0];
  if (phone && phone.phoneMicros > 0n) awards.push({ t: T.awardPhone, w: phone.name, s: T.secsOnPhone(Math.round(Number(phone.phoneMicros / 1_000_000n)), phone.calledOut) });
  $('awards').innerHTML = awards.map(a => `<div class="award"><div class="t">${a.t}</div><div class="w">${escapeHtml(a.w)}</div><div class="s">${escapeHtml(a.s)}</div></div>`).join('');
}
$('btn-again').addEventListener('click', () => call(conn.reducers.startQuiz({})));
$('btn-results-leave').addEventListener('click', () => call(conn.reducers.leavePub({})));

// ---------------------------------------------------------------------------
// Question writer
// ---------------------------------------------------------------------------
let qwTopic: bigint | null = null;
$('btn-questions').addEventListener('click', () => withName(() => { showOverlay('questions'); refreshWriter(); }));
$('qw-back').addEventListener('click', () => showOverlay('menu'));
function refreshWriter() {
  const topics = allTopics();
  if (qwTopic === null && topics.length) qwTopic = topics[0].id;
  const list = $('qw-topics');
  list.innerHTML = '';
  for (const t of topics) {
    const row = document.createElement('div');
    row.className = 'qw-topic' + (t.id === qwTopic ? ' on' : '');
    row.innerHTML =
      `<span>${escapeHtml(t.icon)} ${escapeHtml(t.name)}</span>` +
      `<span class="n">${C.langLabel(t.lang).flag} ${t.questionCount}${t.builtin ? '' : ' · ' + escapeHtml(t.authorName || 'PLAYER')}</span>`;
    row.onclick = () => { qwTopic = t.id; refreshWriter(); };
    list.appendChild(row);
  }
  const mine = [...conn.db.myQuestions.iter()].sort((a, b) => (a.id > b.id ? -1 : 1));
  const mineEl = $('qw-mine');
  mineEl.innerHTML = mine.length ? '' : '<div class="subtitle">NONE YET</div>';
  const topicById = new Map(topics.map(t => [String(t.id), t]));
  for (const q of mine) {
    const row = document.createElement('div');
    row.className = 'qw-mine-row';
    // the difficulty label follows the TOPIC's language, so a Norwegian pack
    // reads MIDDELS rather than MEDIUM
    const topic = topicById.get(String(q.topicId));
    row.innerHTML = `<span>${escapeHtml(q.text)}<div class="t">${escapeHtml(topic?.name ?? '?')} · ${C.tr(topic?.lang ?? 'en').difficulty[q.difficulty]} · ✔ ${escapeHtml(q.correct)}</div></span>`;
    const del = document.createElement('button');
    del.className = 'kick';
    del.textContent = '✕';
    del.title = 'Withdraw';
    del.onclick = () => call(conn.reducers.deleteQuestion({ id: q.id }));
    row.appendChild(del);
    mineEl.appendChild(row);
  }
}
$('qw-topic-add').addEventListener('click', () => {
  const name = ($('qw-topic-name') as HTMLInputElement).value;
  const icon = ($('qw-topic-icon') as HTMLInputElement).value;
  const lang = ($('qw-topic-lang') as HTMLSelectElement).value;
  call(conn.reducers.addTopic({ name, icon, lang }).then(() => {
    ($('qw-topic-name') as HTMLInputElement).value = '';
    showToast('TOPIC ADDED', 'var(--green)');
  }));
});
$('qw-add').addEventListener('click', () => {
  if (qwTopic === null) { showToast('PICK A TOPIC', 'var(--red)'); return; }
  const v = (id: string) => ($(id) as HTMLInputElement).value;
  call(conn.reducers.addQuestion({
    topicId: qwTopic,
    difficulty: Number(($('qw-diff') as HTMLSelectElement).value),
    text: v('qw-text'),
    correct: v('qw-correct'),
    wrong: [v('qw-wrong1'), v('qw-wrong2'), v('qw-wrong3')],
  }).then(() => {
    for (const id of ['qw-text', 'qw-correct', 'qw-wrong1', 'qw-wrong2', 'qw-wrong3']) ($(id) as HTMLInputElement).value = '';
    showToast('IN THE BANK', 'var(--green)');
    $('qw-text').focus();
  }));
});

// ---------------------------------------------------------------------------
// Attention checker → module
// ---------------------------------------------------------------------------
startAttentionChecker(state => {
  if (subscribed && getMyPlayer()) call(conn.reducers.setAttention({ state }));
});

// ---------------------------------------------------------------------------
// Boot / subscribe / frame
// ---------------------------------------------------------------------------
let dirty = true;
let pendingJoin = new URLSearchParams(location.search).get('lobby')?.toUpperCase() ?? '';
if (pendingJoin) history.replaceState({}, '', location.pathname);

function onSubscribed() {
  adoptAccountName();
  refreshAccountChip();
  refreshProfile();
  // the module reset us to HERE on connect — tell it where we really are
  if (attentionState() !== C.ATT_HERE) resyncAttention();
  const firstVisit = !localStorage.getItem('dq_avatar_picked') && !getMyAccount()?.quizzes;
  const go = () => {
    if (pendingJoin) { const code = pendingJoin; pendingJoin = ''; joinByCode(code); }
  };
  if (!storedName() && !getMyPlayer()?.name) openNameModal(() => (firstVisit ? openAvatarSelect(go) : go()));
  else if (firstVisit && !myRoom()) openAvatarSelect(go);
  else go();
  dirty = true;
}

/** What I locked in this question. `player.answer` stays NO_ANSWER for
 *  everyone until the reveal, so my own choice comes from the my_pick view. */
function myAnswer(room: Lobby, me: Player): number {
  if (room.phase === C.PH_RESULT || room.status === C.L_FINISHED) return me.answer;
  for (const row of conn.db.myPick.iter()) {
    if (row.lobbyId === room.id && row.questionIdx === room.questionIdx) return row.choice;
  }
  return C.NO_ANSWER;
}

let lastUiRoomId = 0n;
function refreshUi() {
  if (!subscribed) return;
  const me = getMyPlayer();
  const room = myRoom();
  if (currentOverlay === 'avatar' || currentOverlay === 'questions') {
    if (currentOverlay === 'questions') refreshWriter();
    return;
  }
  if (!me || !room) {
    hud.classList.add('hidden');
    if (currentOverlay !== 'menu') { showOverlay('menu'); resultsShownFor = ''; }
    refreshProfile();
    refreshPublicList();
    return;
  }
  if (room.id !== lastUiRoomId) { lastUiRoomId = room.id; chatSeen.clear(); $('chat-log').innerHTML = ''; for (const c of conn.db.chat.iter()) onChatRow(c); }
  if (room.status === C.L_RUNNING) refreshHud(room, me);
  else if (room.status === C.L_FINISHED) refreshResults(room, me);
  else { hud.classList.add('hidden'); refreshLobby(room, me); }
}

function buildScene(): Scene {
  const room = myRoom();
  const me = getMyPlayer();
  const now = performance.now();
  if (!room || !me) {
    return {
      theme: 0, pubName: C.PUBS[0], phase: C.PH_LOBBY, seats: demoSeats(now), menu: true, hostKey: '', lang: C.defaultLang(),
      screen: { key: 'menu', kicker: C.tr(C.defaultLang()).scrTonight, title: C.tr(C.defaultLang()).scrPubQuiz, lines: [], accent: '#ffd60a', footer: C.tr(C.defaultLang()).scrOpenOrJoin },
      timeFrac: 1, mc: { text: '', at: 0 },
    };
  }
  const seats: SceneSeat[] = roomPlayers(room.id).map(p => {
    const key = p.identity.toHexString();
    return {
      key, name: p.name, avatarId: p.avatarId, seat: p.seat, credits: p.credits, attention: p.attention,
      x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, actTicks: p.actTicks, actKind: p.actKind,
      // the letter on the paddle is public ONLY at the reveal; until then a
      // paddle is up but face down (and my own is my own business)
      answer: room.phase === C.PH_RESULT ? p.answer : C.NO_ANSWER,
      locked: room.phase === C.PH_ANSWER && p.answeredAt !== 0n,
      team: room.teamMode ? p.team : 0, online: p.online, mood: moods.get(key) ?? 0, isMe: key === myHex(),
      bubble: bubbles.get(key) ?? null,
    };
  });
  let screen: Scene['screen'];
  const T = C.tr(room.lang);
  const final = room.questionIdx >= room.questionCount - 1;
  if (room.status === C.L_FINISHED) {
    const order = standingsOf(room);
    screen = { key: `done|${room.drawn.length}`, kicker: T.scrFinal, title: room.championName ? T.scrWins(room.championName) : T.scrDone, lines: order.slice(0, 4).map((p, i) => `${i + 1}. ${p.name}  ${p.credits}${C.PTS}`), accent: '#ffd60a', footer: C.PUBS[room.theme] };
  } else if (room.phase === C.PH_INTRO) {
    screen = { key: 'intro', kicker: T.welcome, title: T.scrQuestionsTonight(room.questionCount), lines: [], accent: '#ffd60a', footer: T.scrPhonesAway };
  } else if (room.phase === C.PH_ANSWER || room.phase === C.PH_RESULT) {
    const lines = room.qOptions.map((o, i) => `${room.phase === C.PH_RESULT && i === room.qCorrect ? '!' : ''}${'ABCD'[i]}.  ${o}`);
    screen = { key: `q|${room.questionIdx}|${room.phase}|${room.qCorrect}`, kicker: `${room.qIcon} ${room.qTopic} · ${T.question}${room.questionIdx + 1}${final ? T.scrLastOrders : ''}`, title: room.qText, lines, accent: room.phase === C.PH_RESULT ? '#43e97b' : '#ffd60a', footer: room.phase === C.PH_RESULT ? (room.fastestName ? T.scrFastest(room.fastestName) : T.scrRevealed) : T.scrLockIn };
  } else {
    screen = { key: `lobby|${roomPlayers(room.id).length}`, kicker: C.PUBS[room.theme], title: T.scrRoomCode(room.code), lines: [], accent: '#ffd60a', footer: T.scrAtTheBar(roomPlayers(room.id).length) };
  }
  const total = phaseLen(room);
  return {
    theme: room.theme, pubName: C.PUBS[room.theme] ?? C.PUBS[0], phase: room.phase, seats, menu: false, hostKey: room.hostId.toHexString(), lang: room.lang,
    screen, timeFrac: room.status === C.L_RUNNING ? secsLeft(room) / total : 1, mc: { text: room.mcText, at: mcSaidAt },
  };
}
// a few regulars prop up the bar behind the menu
function demoSeats(now: number): SceneSeat[] {
  const t = now / 1000;
  // they mill about the floor on a slow lap, so the menu pub looks alive
  return [1, 4, 7, 10].map((seat, i) => {
    const a = t * 0.22 + i * 1.7;
    const x = Math.sin(a) * (2.4 + i * 0.7);
    const y = 1.2 + Math.cos(a) * (1.6 + i * 0.4);
    const speed = 0.22 * (2.4 + i * 0.7);
    return {
      key: `demo${i}`, name: CHARACTERS[(i * 5) % AVATAR_COUNT].name, avatarId: (i * 5) % AVATAR_COUNT,
      seat, credits: 100, team: 0, online: true, isMe: false, bubble: null,
      x, y, dirX: Math.cos(a) * speed, dirY: -Math.sin(a) * speed, actTicks: 0, actKind: 0, locked: false,
      attention: Math.floor(t / 9 + i) % 4 === 0 ? C.ATT_PHONE : C.ATT_HERE, answer: C.NO_ANSWER, mood: 0,
    };
  });
}

initRenderer($('game-canvas') as HTMLCanvasElement);
let lastUiAt = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  pumpInput();
  if (dirty || now - lastUiAt > 250) { dirty = false; lastUiAt = now; refreshUi(); }
  drawScene(buildScene());
  positionCallouts();
}
requestAnimationFrame(frame);
// rAF stops in hidden tabs; keep the UI fresh regardless
setInterval(() => { if (document.hidden) refreshUi(); }, 500);

onAuthChange(() => {
  refreshAccountChip();
  if (connectedDegraded && !authDegraded()) {
    connectedDegraded = false;
    setStatus('ACCOUNT SERVICE RECONNECTED — SYNCING YOUR PROFILE');
    restartConnection();
  }
});

initAuth()
  .then(async () => {
    if (isEmailLinkReturn()) {
      const r = await completeEmailLink(async () => prompt('Confirm the email address the link was sent to') );
      if (r && !r.ok) showToast(r.error, 'var(--red)');
      else if (r?.ok) showToast('SIGNED IN', 'var(--green)');
    }
  })
  .then(() => {
    refreshAccountChip();
    void connect();
  });
