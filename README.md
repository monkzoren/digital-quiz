# Digital Quiz

An arcade pub quiz for the browser, and the quiz leg of the Digital
championship suite (tennis · golf · racing · quiz). You pick one of the
**Digital Tennis roster** — the same eighteen characters, the same select
screen, the same UI — and walk into a 3D pub; the quiz master behind the bar
runs the questions; every seat has a wallet of credits to **bet on each
question**; and the pub can see who has sneaked off to look at their phone.

**It is the same game, presented the same way.** The stylesheet, the menus,
the modals, the character select with its live 3D cards, and the character
rig itself are digital-tennis's, carried over verbatim — BLAZE serving on
Centre Court and BLAZE nursing a pint in the corner are the same person, the
same model and the same walk.

**Norsk pubquiz.** The bank ships **812 Norwegian questions across
27 topics** — Norge rundt, norsk historie, kongehuset, MGP &
Eurovision, norsk fotball, vintersport & OL, håndball, sportsøyeblikk &
sitater, mat & drikke, russetid og høytider, dialekter, norrøn mytologi,
Flåklypa og Olsenbanden, norske oppfinnelser & rekorder, and general topics
written in Norwegian — plus 124 English ones. Sport is the deepest seam:
football, winter sport, handball, world sport and famous Norwegian sporting
moments come to over 200 questions on their own. A pub picks its **language** when it opens: a
Norwegian night draws only Norwegian packs, the quiz master heckles in
Norwegian, and the screen, the wallet and the results read in Norwegian too.
A Norwegian browser opens on `NORSK` and a Norwegian venue by default.

SpacetimeDB is the entire backend — pubs, the question flow, wallets and
payouts, the answer key, the attention tally and the accounts all live in one
module. The client is a Vite + TypeScript app with a three.js pub.

## How a night goes

1. **Open a pub** (or join one by code / link / the public list). Pick the
   **language**, the venue, how many questions, how long stakes stay open and
   how long the table has to answer, and whether it's teams. The host also
   picks the **topics** the quiz draws from — only topics in the pub's
   language are offered, so a Norwegian night can never pull an English pack
   mid-quiz.
2. Everyone **walks about** the pub — WASD or the arrows walk, SPACE jumps,
   E waves, and a gamepad stick does the same. Movement is server-authoritative
   (a 20 Hz tick per room), exactly like the spectators on the tennis grounds.
   Everyone **readies up** at the bar (a signal, not a gate — the host can
   start anyway, and the room starts itself when everyone is ready).
3. Each question runs in three beats, all timed by the module:
   - **Stakes open** — the screen shows the **topic, difficulty and odds**,
     not the question. Everyone is in for the 5¢ ante; slide up to half your
     wallet if you fancy the topic. Easy pays 1×, medium 1.5×, hard 2×.
   - **Answer** — the question and four options go up. First lock-in counts
     (click an option, or 1–4 on the keyboard — A–D belong to the walk keys). When everyone is in, the clock jumps.
   - **Result** — the key is revealed, wallets move, the quiz master has a
     word. The fastest correct answer earns a bonus; three or more in a row
     earns a streak bonus.
4. **Last orders**: the final question pays double and you can stake the
   lot. A wallet that runs dry gets topped up by the landlord (it goes on
   your tab, and on the scoreboard).
5. Final standings, awards (fastest finger, biggest win, sharpest, phone
   addict, on the tab), XP, and **ANOTHER ROUND** — a rematch never repeats
   a question until the pool runs out.

**Teams:** with teams on, every seat picks RED/BLUE/GREEN/GOLD in the lobby;
everyone still answers and bets individually and the team standings are the
sum of the wallets.

**The activity checker.** If your tab goes to the background, your window
loses focus, or you stop touching anything for a while, the pub is told. Your
avatar gets its phone out (head down, blue glow), a 📱 goes on your name
plate and the scoreboard, and everyone else gets a **CALL OUT** button over
your head that heckles you in the chat. The quiz master will name you at the
result. Time on the phone and the number of times you were caught are kept
by the module (never by the client), shown at the end and added to your
account's lifetime tally for the hall of shame. Nothing pauses for you: miss
the answer window and your stake is gone.

Chat, emotes (speech bubbles over the avatars), a stale-page banner, and the
same accounts as every Digital game (Firebase anonymous sign-in with an
optional upgrade to Google / email, so level, XP and the quiz record follow
you across devices and survive engine wipes).

## Languages

A pub plays in one language (`lobby.lang`): `nb`, `en`, or "both", which
draws from everything. The language decides three things — which topics the
draw may use, which patter the quiz master speaks, and the wording of the
quiz itself (the big screen, the question card, the wallet, the results and
the awards). Menu, lobby and the question writer stay in English; they are
the tooling around the quiz rather than the quiz.

Adding a language means four places: `LANGS` in `spacetimedb/src/index.ts`
(plus a set of quiz-master lines in `MC`), `LANGS` in
`spacetimedb/gen-bank.mjs`, `LANGS` in `client/src/config.ts`, and a string
table next to `EN`/`NB` there.

## Adding questions and topics

Two ways, and they end up in the same place — the `topic` and `question`
tables the module draws from.

**1. In the game.** `✍️ WRITE QUESTIONS` on the menu. Pick or create a topic
(name + an emoji), write the question, the right answer and three wrong ones,
set the difficulty, done — it is in the shared bank straight away for any pub
that plays that topic. You can withdraw your own questions; nobody sees your
questions' answers except through play. The answer key never leaves the
module until the result phase.

**2. In the repo.** The built-in bank is `spacetimedb/questions/*.json`, one
file per topic:

```json
{
  "topic": "Norsk historie",
  "icon": "🏛️",
  "lang": "nb",
  "questions": [
    { "q": "I hvilket år ble unionen med Sverige oppløst?",
      "a": ["1905", "1814", "1884", "1920"], "d": 1 }
  ]
}
```

The **first answer is the correct one** (the module shuffles at play time);
`d` is the difficulty, 1 easy · 2 medium · 3 hard, which sets the odds; and
`lang` is the language the questions are written in (`nb` or `en`, default
`en`). Add a question, or a whole new file for a new topic, and redeploy: `gen-bank.mjs`
compiles the packs into `src/bank.ts` on every build/publish (validating the
shape and refusing duplicates), and the module syncs the packs into the
tables the first time it sees the new version — keyed on topic + text, so
existing questions keep their ids, edited ones update, removed ones go. To
check a pack locally: `cd spacetimedb && npm run bank`.

## Run locally

```bash
spacetime start                                   # SpacetimeDB 2.8+
spacetime publish -y                              # from the repo root (spacetime.json)
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y
cd client && npm install && npm run dev           # http://localhost:5173
```

Two players on one machine need two identities (two tabs share a Firebase /
localStorage session): use two browser profiles, or `?seat=2` on the second
tab when running without Firebase.

`cd client && npm run smoke` runs an end-to-end test against the local
server: two clients open a pub, write a question, run a three-question quiz
with stakes, answers, a phone check and a call-out, and check payouts, XP,
the rematch draw and cleanup.

## Self-hosting

```bash
cp .env.example .env      # optional: Firebase for accounts
docker compose up -d --build
```

Four services: `spacetimedb`, `module-publisher` (builds + publishes the
module, compiling the question packs first), `profiles` (mirrors `account`
into SQLite so player progression survives a database wipe — see
`profiles/README.md`), and `client` (nginx serving the build and proxying
`/v1` to SpacetimeDB same-origin, so one domain serves everything).

Accounts are optional but load-bearing for persistence: set the `FIREBASE_*`
values in `.env` (build-time — rebuild the client image) and `FIREBASE_PROJECT`
in `spacetimedb/src/index.ts`. Without them players get device-local
identities; progress works but only on that browser, and nothing survives a
wipe. `spacetimedb/publish.sh` refuses `--clear-database` unless
`ALLOW_CLEAR=1`.

## Championship hook

The championship hub opens a quiz leg through its relay: `create_championship_room`
(gated on the relay's server-key-minted token, issuer
`digital-championship-relay` — the same string in every sibling game) with
the hub's six-letter code, the championship host as room host, `venue`
`pub:N` and the director's JSON settings
`{ questions, betSecs, answerSecs, lang }`.
One entrant plays alone against the clock; any number more play the normal
quiz. When it finishes the module writes the finishing order **once** to the
public `leg_result` table (a rematch never rescores) and the relay carries it
to the hub. If the designated host never turns up, whoever joins first takes
the host seat.

## Layout

```
spacetimedb/src/index.ts   the module: schema, quiz engine, wallets, attention, accounts, championship
spacetimedb/src/bank.ts    GENERATED from questions/*.json by gen-bank.mjs
spacetimedb/questions/     the built-in question packs — edit these
                           (20-43 are the Norwegian ones)
client/src/main.ts         connection, UI, input
client/src/render.ts       the three.js pub
client/src/attention.ts    the activity checker
client/src/characters.ts   the roster — a VERBATIM copy of digital-tennis's
client/src/rig.ts          the character rig — lifted from digital-tennis's render.ts
client/src/config.ts       mirrors of the module's constants + the UI wording per language
client/src/auth.ts         Firebase (same as every Digital game)
client/scripts/smoke.ts    end-to-end test
profiles/                  the SQLite mirror of `account`
```
