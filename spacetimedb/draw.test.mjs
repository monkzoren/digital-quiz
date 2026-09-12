// Unit tests for the question draw's freshness banding (src/draw.ts).
// Run with `npm test` in this directory. No server or database needed — the
// function under test is pure, which is the reason it lives in its own file.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'draw-test-'));
execFileSync(
  process.execPath,
  [
    join(here, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(here, 'src', 'draw.ts'),
    '--outDir', out,
    '--target', 'es2022',
    '--module', 'es2022',
    '--moduleResolution', 'bundler',
    '--strict',
  ],
  { stdio: 'inherit' }
);
const { pickSpread } = await import(join(out, 'draw.js'));

const cand = (id, topicId) => ({ id: BigInt(id), topicId: BigInt(topicId) });
const seen = pairs => new Map(pairs.map(([id, n]) => [String(id), n]));
const topicOf = pool => new Map(pool.map(q => [String(q.id), q.topicId]));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// Ten questions across two topics, nobody has seen anything.
const fresh = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => cand(i, i % 2));

test('draws the asked-for number of questions', () => {
  assert.equal(pickSpread(fresh, seen([]), 5).length, 5);
});

test('never repeats a question inside one sheet', () => {
  const out = pickSpread(fresh, seen([]), 10);
  assert.equal(new Set(out.map(String)).size, 10);
});

test('still fills the sheet when the pool is smaller than it', () => {
  // A short sheet leaves the room stuck in the intro with nothing to show,
  // so a pool of 10 asked for 14 repeats rather than coming back short.
  const out = pickSpread(fresh, seen([]), 14);
  assert.equal(out.length, 14);
  assert.equal(new Set(out.map(String)).size, 10, 'every question is used before any repeats');
});

test('fills a sheet from a single question rather than stalling', () => {
  assert.deepEqual(pickSpread([cand(7, 1)], seen([]), 3).map(Number), [7, 7, 7]);
});

test('uses each question once before repeating any of them', () => {
  const out = pickSpread(fresh, seen([]), 12).map(String);
  assert.equal(new Set(out.slice(0, 10)).size, 10);
});

test('spreads topics so consecutive questions differ', () => {
  const out = pickSpread(fresh, seen([]), 10);
  const tp = topicOf(fresh);
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(tp.get(String(out[i])), tp.get(String(out[i - 1])), `questions ${i - 1} and ${i} share a topic`);
  }
});

test('leaves out everything a seat has already been asked', () => {
  // Seats have seen 1..5; a five-question sheet should be 6..10 only.
  const out = pickSpread(fresh, seen([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]), 5);
  assert.deepEqual(out.map(Number).sort((a, b) => a - b), [6, 7, 8, 9, 10]);
});

test('reaches for a repeat only once nothing fresh is left', () => {
  // Only 2 unseen; a 4-question sheet has to dip into the seen ones.
  const history = seen([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]]);
  const out = pickSpread(fresh, history, 4).map(Number);
  assert.deepEqual(out.slice(0, 2).sort((a, b) => a - b), [9, 10], 'the two unseen go up first');
  assert.equal(new Set(out).size, 4);
});

test('when it must repeat, it picks what fewest of the room remembers', () => {
  // Nothing is unseen. 9 and 10 are remembered by one seat, the rest by three.
  const history = seen([[1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 1], [10, 1]]);
  const out = pickSpread(fresh, history, 2).map(Number).sort((a, b) => a - b);
  assert.deepEqual(out, [9, 10]);
});

test('works up through the bands in order', () => {
  const history = seen([[1, 2], [2, 2], [3, 1], [4, 1], [5, 0], [6, 0], [7, 3], [8, 3], [9, 3], [10, 3]]);
  const out = pickSpread(fresh, history, 6).map(Number);
  assert.deepEqual(out.slice(0, 2).sort((a, b) => a - b), [5, 6], 'the unseen band first');
  assert.deepEqual(out.slice(2, 4).sort((a, b) => a - b), [3, 4], 'then the one-seat band');
  assert.deepEqual(out.slice(4, 6).sort((a, b) => a - b), [1, 2], 'then the two-seat band');
});

test('freshness outranks the topic spread', () => {
  // The only two unseen questions share a topic. They still go up first,
  // back to back, rather than a stale question of another topic breaking them up.
  const history = seen([[1, 1], [3, 1], [5, 1], [7, 1], [9, 1]]);
  const out = pickSpread(fresh, history, 5).map(Number);
  assert.deepEqual(out.slice(0, 5).sort((a, b) => a - b), [2, 4, 6, 8, 10]);
});

test('keeps the caller-supplied order inside a band', () => {
  const ordered = [5, 3, 1, 4, 2].map(i => cand(i, i)); // every topic distinct
  assert.deepEqual(pickSpread(ordered, seen([]), 5).map(Number), [5, 3, 1, 4, 2]);
});

test('an empty pool draws nothing rather than throwing', () => {
  assert.deepEqual(pickSpread([], seen([]), 5), []);
});

console.log(`\n${passed} passing`);
