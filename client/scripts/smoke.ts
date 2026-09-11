// End-to-end smoke test against a LOCAL SpacetimeDB: two anonymous clients
// open a pub, start a 3-question quiz, stake, answer, and the script checks
// the module drove every phase, paid out, awarded XP and cleaned up.
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
          .subscribe(['SELECT * FROM lobby', 'SELECT * FROM player', 'SELECT * FROM entry', 'SELECT * FROM topic', 'SELECT * FROM chat', 'SELECT * FROM account', 'SELECT * FROM my_quiz_log', 'SELECT * FROM my_questions']);
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

// authoring
const TOPIC = `Smoke ${Date.now().toString(36).slice(-5)}`; // topics persist, so keep re-runs unique
await a.reducers.addTopic({ name: TOPIC, icon: '🧪' });
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
await a.reducers.createPub({ isPublic: true, theme: 1, questions: 3, betSecs: 5, answerSecs: 8, teamMode: false });
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
await a.reducers.startQuiz({});
await until('quiz running', () => room(a)?.status === 1);
await until('intro phase', () => room(a)?.phase === 1);

let correctA = 0;
for (let q = 0; q < 3; q++) {
  await until(`betting Q${q + 1}`, () => room(a)?.phase === 2 && room(a)?.questionIdx === q, 20000);
  const r = room(a)!;
  if (!r.qTopic || r.qText !== '' || r.qOptions.length !== 0 || r.qCorrect !== 255) fail('betting phase leaked the question');
  if (me(a).stake !== 5) fail(`ante not applied: stake ${me(a).stake}`);
  await a.reducers.placeStake({ stake: q === 2 ? me(a).credits : 30 });
  await until('stake set', () => me(a).stake === (q === 2 ? me(a).credits : 30));
  await until(`answering Q${q + 1}`, () => room(a)?.phase === 3, 20000);
  const ra = room(a)!;
  if (ra.qOptions.length !== 4 || !ra.qText || ra.qCorrect !== 255) fail('answer phase shape wrong');
  // A guesses 0; B guesses 1
  await a.reducers.answer({ choice: 0 });
  await until('A locked in', () => me(a).answer === 0);
  threw = false;
  try { await a.reducers.answer({ choice: 1 }); } catch { threw = true; }
  if (!threw) fail('second answer accepted');
  if (q === 0) {
    // B checks their phone mid-question: counted, flagged on the entry
    await b.reducers.setAttention({ state: 1 });
    await until('B on the phone mid-question', () => asSeenBy(a, b).attention === 1);
    await b.reducers.setAttention({ state: 0 });
  }
  await b.reducers.answer({ choice: 1 });
  await until(`result Q${q + 1}`, () => room(a)?.phase === 4, 20000);
  const rr = room(a)!;
  if (rr.qCorrect > 3) fail('result did not reveal the key');
  const ma = me(a);
  const expected = rr.qCorrect === 0;
  if (ma.lastCorrect !== expected) fail('lastCorrect mismatch');
  if (expected) correctA++;
  const entries = [...a.db.entry.iter()].filter(e => e.lobbyId === rr.id && e.questionIdx === q);
  if (entries.length !== 2) fail(`expected 2 entries, got ${entries.length}`);
  if (q === 0 && !entries.find(e => e.identity.toHexString() === b.identity!.toHexString())!.onPhone) fail('B not flagged onPhone for Q1');
  ok(`Q${q + 1}: key=${'ABCD'[rr.qCorrect]} A ${ma.lastCorrect ? 'right' : 'wrong'} (${ma.lastDelta >= 0 ? '+' : ''}${ma.lastDelta}) credits=${ma.credits}`);
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
await b.reducers.leavePub({});
await until('B left', () => me(b).lobbyId === 0n);
await a.reducers.leavePub({});
await until('room destroyed', () => [...a.db.lobby.iter()].length === 0);
await a.reducers.deleteQuestion({ id: [...a.db.myQuestions.iter()][0].id });
await until('question withdrawn', () => [...a.db.myQuestions.iter()].length === 0);
console.log('SMOKE TEST PASSED');
process.exit(0);
