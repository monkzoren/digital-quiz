// End-to-end smoke test against a LOCAL SpacetimeDB: two anonymous clients
// open a pub, start a 3-question quiz, answer it, and the script checks the
// module drove every phase, scored it, awarded XP and cleaned up.
//
//   spacetime start                       # in another terminal
//   spacetime publish -y                  # from the repo root
//   cd client && npm run smoke
import { DbConnection } from '../src/module_bindings';

const URI = process.env.SPACETIMEDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.VITE_DATABASE_NAME ?? 'digital-quiz';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fail = (msg: string): never => { console.error('FAIL:', msg); process.exit(1); };
const ok = (msg: string) => console.log('  ok', msg);

async function client(name: string): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .onConnect((c, id) => {
        c.subscriptionBuilder()
          .onApplied(() => { console.log(`${name} connected as ${id.toHexString().slice(0, 10)}`); resolve(c); })
          .onError(e => reject(e))
          .subscribe(['SELECT * FROM lobby', 'SELECT * FROM player', 'SELECT * FROM entry', 'SELECT * FROM topic', 'SELECT * FROM chat', 'SELECT * FROM account', 'SELECT * FROM my_quiz_log', 'SELECT * FROM my_questions', 'SELECT * FROM my_pick']);
      })
      .onConnectError((_c, e) => reject(e))
      .build();
  });
}

const me = (c: DbConnection) => [...c.db.player.iter()].find(p => p.identity.toHexString() === c.identity!.toHexString())!;
const asSeenBy = (viewer: DbConnection, who: DbConnection) => [...viewer.db.player.iter()].find(p => p.identity.toHexString() === who.identity!.toHexString())!;
const room = (c: DbConnection) => [...c.db.lobby.iter()].find(l => l.id === me(c).lobbyId);
async function until(desc: string, f: () => boolean, ms = 30000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) fail(`timed out waiting for ${desc}`);
    await sleep(100);
  }
  ok(desc);
}

const a = await client('A');
const b = await client('B');
await a.reducers.setName({ name: 'ALICE' });
await b.reducers.setName({ name: 'BOB' });
await a.reducers.setAvatar({ avatarId: 3 });
await until('bank synced into topic table', () => [...a.db.topic.iter()].length >= 9);
const langs = new Set([...a.db.topic.iter()].map(t => t.lang));
if (!langs.has('nb') || !langs.has('en')) fail(`bank is missing a language: ${[...langs].join()}`);
for (const l of ['en', 'nb']) {
  const n = [...a.db.topic.iter()].filter(t => t.lang === l).reduce((s, t) => s + t.questionCount, 0);
  ok(`${l}: ${[...a.db.topic.iter()].filter(t => t.lang === l).length} topics, ${n} questions`);
}

// authoring
const TOPIC = `Smoke ${Date.now().toString(36).slice(-5)}`; // topics persist, so keep re-runs unique
await a.reducers.addTopic({ name: TOPIC, icon: '🧪', lang: 'en' });
await until('topic added', () => !![...a.db.topic.iter()].find(t => t.name === TOPIC));
const smokeTopic = [...a.db.topic.iter()].find(t => t.name === TOPIC)!;
await a.reducers.addQuestion({ topicId: smokeTopic.id, difficulty: 2, text: 'Is this a smoke test?', correct: 'Yes', wrong: ['No', 'Maybe', 'Ask again'] });
await until('question in my_questions', () => [...a.db.myQuestions.iter()].length === 1);
await until('topic count bumped', () => [...a.db.topic.iter()].find(t => t.name === TOPIC)!.questionCount === 1);
let threw = false;
try { await a.reducers.addQuestion({ topicId: smokeTopic.id, difficulty: 2, text: 'Dup answers?', correct: 'x', wrong: ['x', 'y', 'z'] }); } catch { threw = true; }
if (!threw) fail('duplicate answers were accepted');
ok('duplicate answers rejected');

// the pub
await a.reducers.createPub({ isPublic: true, theme: 1, questions: 3, answerSecs: 8, teamMode: false, lang: 'en' });
await until('A seated in a pub', () => me(a).lobbyId !== 0n);
const code = room(a)!.code;
await b.reducers.joinPub({ code });
await until('B seated', () => me(b).lobbyId === me(a).lobbyId);
await b.reducers.setReady({ ready: true });
await until('B ready', () => asSeenBy(a, b).ready);
await b.reducers.setAttention({ state: 1 });
await until('B on the phone', () => asSeenBy(a, b).attention === 1);
await a.reducers.callOut({ target: me(b).identity });
await until('call-out in chat', () => [...a.db.chat.iter()].some(c => c.kind === 2));
await b.reducers.setAttention({ state: 0 });
// pairing up: B walks over to A (set_input steers, walk_tick moves), then a
// high five starts the same routine on both rows, facing each other by seat
const dist = () => Math.hypot(asSeenBy(a, b).x - me(a).x, asSeenBy(a, b).y - me(a).y);
threw = false;
try { await b.reducers.interact({ target: me(a).identity, kind: 2 }); await sleep(200); } catch { threw = true; }
if (!threw && me(a).actTicks !== 0 && dist() > 1.7) fail('a high five landed from across the room');
{
  const t0 = Date.now();
  while (dist() > 1.0) {
    if (Date.now() - t0 > 15000) fail(`B never reached A (${dist().toFixed(2)} m apart)`);
    const dx = me(a).x - asSeenBy(a, b).x;
    const dy = me(a).y - asSeenBy(a, b).y;
    await b.reducers.setInput({ dirX: Math.abs(dx) > 0.15 ? Math.sign(dx) : 0, dirY: Math.abs(dy) > 0.15 ? Math.sign(dy) : 0 });
    await sleep(100);
  }
  await b.reducers.setInput({ dirX: 0, dirY: 0 });
}
ok(`B walked over to A (${dist().toFixed(2)} m apart)`);
await b.reducers.interact({ target: me(a).identity, kind: 2 });
await until('both in the high five', () => me(a).actKind === 2 && me(a).actTicks > 0 && asSeenBy(a, b).actKind === 2 && asSeenBy(a, b).actTicks > 0);
if (me(a).actSeat !== asSeenBy(a, b).seat || asSeenBy(a, b).actSeat !== me(a).seat) fail('the pair do not point at each other');
await until('high five in chat', () => [...a.db.chat.iter()].some(c => c.kind === 1 && c.text.startsWith('🙌')));
await until('high five over', () => me(a).actTicks === 0 && me(a).actSeat === 0);
await a.reducers.startQuiz({});
await until('quiz running', () => room(a)?.status === 1);
await until('intro phase', () => room(a)?.phase === 1);

let correctA = 0;
for (let q = 0; q < 3; q++) {
  await until(`answering Q${q + 1}`, () => room(a)?.phase === 3 && room(a)?.questionIdx === q, 20000);
  const ra = room(a)!;
  if (ra.qOptions.length !== 4 || !ra.qText || !ra.qTopic) fail('answer phase shape wrong');
  if (ra.qCorrect !== 255) fail('the answer key was up with the question');
  // A guesses 0; B guesses 1
  await a.reducers.answer({ choice: 0 });
  // the PUBLIC row only says they are in; the choice itself is private
  await until('A locked in', () => me(a).answeredAt !== 0n);
  if (me(a).answer !== 255) fail('own answer leaked into the public player row before the reveal');
  const mine = [...a.db.myPick.iter()].find(r => r.questionIdx === q);
  if (!mine || mine.choice !== 0) fail('my_pick did not give A their own answer back');
  // a pick is not final: A switches to 2, then back to 0 before the buzzer
  const stamp = me(a).answeredAt;
  await a.reducers.answer({ choice: 2 });
  await until('A changed their answer', () => [...a.db.myPick.iter()].some(r => r.questionIdx === q && r.choice === 2));
  if (me(a).answeredAt <= stamp) fail('answeredAt was not re-stamped on a change');
  await a.reducers.answer({ choice: 0 });
  await until('A changed back', () => [...a.db.myPick.iter()].some(r => r.questionIdx === q && r.choice === 0));
  ok('answers can be changed while the clock runs');
  if (q === 0) {
    // B checks their phone mid-question: counted, flagged on the entry
    await b.reducers.setAttention({ state: 1 });
    await until('B on the phone mid-question', () => asSeenBy(a, b).attention === 1);
    await b.reducers.setAttention({ state: 0 });
  }
  await b.reducers.answer({ choice: 1 });
  await until('B locked in', () => asSeenBy(a, b).answeredAt !== 0n);
  // THE point of the private pick: A can see that B is in, never what B said
  if (room(a)?.phase === 3 && asSeenBy(a, b).answer !== 255) fail("B's answer was visible to A before the reveal");
  if ([...a.db.myPick.iter()].some(r => r.identity.toHexString() === b.identity!.toHexString())) fail("A can read B's pick through my_pick");
  ok('answers stay hidden until the reveal');
  await until(`result Q${q + 1}`, () => room(a)?.phase === 4, 20000);
  const rr = room(a)!;
  if (rr.qCorrect > 3) fail('result did not reveal the key');
  const ma = me(a);
  if (ma.answer !== 0 || asSeenBy(a, b).answer !== 1) fail('answers were not revealed at the result');
  const expected = rr.qCorrect === 0;
  if (ma.lastCorrect !== expected) fail('lastCorrect mismatch');
  // flat scoring: 10 for a right answer, nothing for a wrong one, never less
  if (ma.lastDelta !== (expected ? 10 : 0)) fail(`scored ${ma.lastDelta} for a ${expected ? 'right' : 'wrong'} answer`);
  if (expected) correctA++;
  if (ma.credits !== correctA * 10) fail(`score ${ma.credits} != ${correctA} correct × 10`);
  const entries = [...a.db.entry.iter()].filter(e => e.lobbyId === rr.id && e.questionIdx === q);
  if (entries.length !== 2) fail(`expected 2 entries, got ${entries.length}`);
  if (q === 0 && !entries.find(e => e.identity.toHexString() === b.identity!.toHexString())!.onPhone) fail('B not flagged onPhone for Q1');
  ok(`Q${q + 1}: key=${'ABCD'[rr.qCorrect]} A ${ma.lastCorrect ? 'right' : 'wrong'} (+${ma.lastDelta}) score=${ma.credits}`);
}
await until('quiz finished', () => room(a)?.status === 2 && room(a)?.phase === 5, 20000);
const done = room(a)!;
if (!done.championName) fail('no champion');
ok(`champion: ${done.championName}`);
await until('quiz_log row', () => [...a.db.myQuizLog.iter()].length === 1);
const log = [...a.db.myQuizLog.iter()][0];
if (log.correct !== correctA) fail(`log correct ${log.correct} != ${correctA}`);
const acc = [...a.db.account.iter()].find(x => x.identity.toHexString() === a.identity!.toHexString())!;
if (acc.quizzes !== 1 || acc.xp !== log.xpGained || acc.rev < 1) fail(`account not awarded: ${JSON.stringify({ q: acc.quizzes, xp: acc.xp, rev: acc.rev })}`);
ok(`account: xp=${acc.xp} level=${acc.level} rev=${acc.rev} phoneChecks(B)=${[...a.db.account.iter()].find(x => x.identity.toHexString() === b.identity!.toHexString())!.phoneChecks}`);
const bob = asSeenBy(a, b);
if (bob.phoneChecks !== 1 || bob.phoneMicros <= 0n) fail(`B phone check not counted: ${bob.phoneChecks} ${bob.phoneMicros}`);
if ([...a.db.account.iter()].find(x => x.identity.toHexString() === b.identity!.toHexString())!.phoneChecks !== 1) fail('B lifetime phone checks not on the account');
ok('phone check counted for B (and on the account)');

// rematch draws different questions
const firstDrawn = done.drawn.map(String);
await a.reducers.startQuiz({});
await until('rematch running', () => room(a)?.status === 1);
const again = room(a)!;
if (again.drawn.length !== 6 || again.drawn.slice(3).some(id => firstDrawn.includes(String(id)))) fail('rematch repeated a question');
ok('rematch drew fresh questions');

// A player's history outlasts the room. A brand-new pub, whose own `drawn`
// starts empty, must still not ask them anything they have already been
// asked — that guarantee lives in the private `seen` table, not the lobby.
await a.reducers.leavePub({});
await until('A out of the old pub', () => me(a).lobbyId === 0n);
await b.reducers.leavePub({});
await a.reducers.createPub({ isPublic: false, theme: 1, questions: 3, answerSecs: 8, teamMode: false, lang: 'en' });
await until('a second pub open', () => room(a)?.status === 0);
await a.reducers.startQuiz({});
await until('second pub quiz running', () => room(a)?.status === 1 && room(a)!.drawn.length === 3);
const secondDrawn = room(a)!.drawn.map(String);
if (secondDrawn.some(id => firstDrawn.includes(id))) fail('a fresh pub re-asked a question this player had already had');
ok('per-player history kept repeats out of a brand-new pub');
await a.reducers.leavePub({});
await until('A out of the second pub', () => me(a).lobbyId === 0n);

// A Norwegian pub must never draw an English pack — the whole point of
// tagging the bank by language.
await a.reducers.createPub({ isPublic: false, theme: 3, questions: 8, answerSecs: 8, teamMode: false, lang: 'nb' });
await until('norsk pub open', () => room(a)?.lang === 'nb');
const nbTopics = new Set([...a.db.topic.iter()].filter(t => t.lang === 'nb').map(t => String(t.id)));
await a.reducers.startQuiz({});
await until('norsk quiz running', () => room(a)?.status === 1 && room(a)!.drawn.length === 8);
// the questions themselves are private; the topic on screen is not, so walk
// the room through its questions and check each topic is a Norwegian one
const seenTopics = new Set<string>();
for (let q = 0; q < 3; q++) {
  await until(`norsk answering Q${q + 1}`, () => room(a)?.phase === 3 && room(a)?.questionIdx === q, 25000);
  seenTopics.add(room(a)!.qTopic);
  await a.reducers.answer({ choice: 0 });
}
const nbNames = new Set([...a.db.topic.iter()].filter(t => nbTopics.has(String(t.id))).map(t => t.name));
for (const t of seenTopics) if (!nbNames.has(t)) fail(`norsk pub drew a non-Norwegian topic: ${t}`);
ok(`norsk pub drew only Norwegian topics (${[...seenTopics].join(', ')})`);
if (!/[æøåÆØÅ]|^[A-ZÆØÅ]/.test(room(a)!.mcText)) fail('quiz master said nothing');
ok(`quiz master in Norwegian: "${room(a)!.mcText.slice(0, 60)}"`);
await a.reducers.leavePub({});
await until('B left', () => me(b).lobbyId === 0n);
await a.reducers.leavePub({});
await until('room destroyed', () => [...a.db.lobby.iter()].length === 0);
await a.reducers.deleteQuestion({ id: [...a.db.myQuestions.iter()][0].id });
await until('question withdrawn', () => [...a.db.myQuestions.iter()].length === 0);
console.log('SMOKE TEST PASSED');
process.exit(0);
