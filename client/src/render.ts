// ---------------------------------------------------------------------------
// The pub. A small three.js scene: a bar along the back wall with the quiz
// master behind it, a big screen above the optics, and twelve stools in two
// arcs facing it. Every contender is a low-poly rig dressed from
// avatars.ts; the module's per-player state drives the poses — phone out,
// slumped, paddle raised with the locked-in letter, cheering or sulking at
// the result. main.ts hands drawScene one Scene per frame; nothing here
// touches the network.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CHARACTERS, type Character } from './characters';
import {
  applyCharacter, applyPose, actionPose, emotePose, blendAngle, makePlayerRig,
  readyPose, runPose, standPose, wrapAngle, RUN_STRIDE_RATE, WATCHER_EMOTE_MS,
  WATCHER_JUMP_MS, WATCHER_WAVE_MS, ZERO_POSE,
  type PlayerRig, type Pose,
} from './rig';
import { ATT_IDLE, ATT_PHONE, NO_ANSWER, PUB_LOOK, TEAM_COLORS } from './config';

export interface SceneSeat {
  key: string; // identity hex
  name: string;
  /** Index into CHARACTERS — the module's avatarId. */
  avatarId: number;
  seat: number;
  /** Where they are standing on the pub floor (module coords: x across, y
   *  into the room, +y toward the door). */
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  /** Jump/wave countdown and which of the two it is (module ACT_*). */
  actTicks: number;
  actKind: number;
  credits: number;
  attention: number;
  answer: number; // NO_ANSWER until locked in
  team: number;
  online: boolean;
  /** 0 neutral · 1 just won the question · 2 just lost it */
  mood: number;
  isMe: boolean;
  /** Speech / emote bubble, if any: text and when it was said (ms). */
  bubble: { text: string; at: number } | null;
}

export interface Scene {
  theme: number;
  pubName: string;
  phase: number;
  seats: SceneSeat[];
  /** What the big screen shows. `key` changes only when the content does. */
  screen: { key: string; kicker: string; title: string; lines: string[]; accent: string; footer: string };
  /** 0..1 of the current phase's clock remaining (drives the screen bar). */
  timeFrac: number;
  /** Quiz master: what they are saying and when they started (ms). */
  mc: { text: string; at: number };
  /** Menu mode: slow orbit, no seat labels. */
  menu: boolean;
  /** The room's language — main.ts has already localized `screen`. */
  lang: string;
  hostKey: string;
}

// ---------------------------------------------------------------------------
// Layout (meters). Bar along z = -4; stools face -z.
// ---------------------------------------------------------------------------
// A big room: the camera sits at the door end and everyone has floor to
// walk on without filling the lens.
const ROOM_W = 18;
const ROOM_D = 18;
const ROOM_H = 4.2;
const BAR_Z = -4;
const SEAT_ARCS = [
  { r: 3.6, n: 6, z: -0.6 }, // front row, at the bar
  { r: 6.2, n: 6, z: 0.9 }, // back row, at the tables
];
function seatPos(seat: number): { x: number; z: number } {
  const row = seat < 6 ? SEAT_ARCS[0] : SEAT_ARCS[1];
  const i = seat % 6;
  const spread = seat < 6 ? 1.25 : 1.4;
  const a = ((i - (row.n - 1) / 2) / (row.n - 1)) * spread; // radians, centred
  return { x: Math.sin(a) * row.r * 1.15, z: BAR_Z + row.z + Math.cos(a) * row.r };
}

const THEMES = [
  // The Dog & Duck: oak, brass, warm lamps
  { wall: 0x5a2f1c, floor: 0x3b2314, bar: 0x6b3a1f, barTop: 0x2a1a0f, lamp: 0xffb35c, neon: '#ffd60a', accent: 0xffb35c, fog: 0x1a100a },
  // The Neon Lounge: black lacquer, pink and cyan tubes
  { wall: 0x171a2b, floor: 0x0d0f1c, bar: 0x1c2140, barTop: 0x0a0c18, lamp: 0xff5fd0, neon: '#38d5ff', accent: 0xff5fd0, fog: 0x07081a },
  // The Harbour Arms: whitewash, teak, sea light
  { wall: 0x7d8f96, floor: 0x4c3a2a, bar: 0x5e4630, barTop: 0x27201a, lamp: 0xfff1d6, neon: '#43e97b', accent: 0x9be7ff, fog: 0x2a3a44 },
];

let renderer: THREE.WebGLRenderer;
let scene3: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let hostCanvas: HTMLCanvasElement;
let themeBuilt = -1;
let roomGroup: THREE.Group | null = null;
let screenCtx: CanvasRenderingContext2D;
let screenTex: THREE.CanvasTexture;
let screenKey = '';
let screenTimeFrac = -1;
let signTex: THREE.CanvasTexture | null = null;
let signMesh: THREE.Mesh | null = null;
let mcRig: PubRig;
let lampLights: THREE.PointLight[] = [];
// ---------------------------------------------------------------------------
// The regulars. Every one of them is a digital-tennis character, built by the
// SAME rig code (rig.ts, lifted from that game's renderer) — so the person
// who serves at 200 km/h on Centre Court is the person nursing a pint in the
// corner here. The rig is authored at tennis scale; PUB_SCALE shrinks it into
// a room measured in metres.
// ---------------------------------------------------------------------------
const PUB_SCALE = 0.32; // a ~5.5-unit athlete becomes a ~1.78 m drinker
const TU = 1 / PUB_SCALE; // metres → rig units, for props in the hands

interface PubRig {
  holder: THREE.Group; // scaled; carries the character rig
  anno: THREE.Group; // unscaled; carries the sprites that must not shrink
  rig: PlayerRig;
  phone: THREE.Mesh;
  phoneLight: THREE.PointLight;
  paddle: THREE.Group;
  paddleFace: THREE.Mesh;
  paddleLetter: number;
  zzz: THREE.Sprite;
  label: THREE.Sprite;
  labelKey: string;
  bubble: THREE.Sprite;
  bubbleKey: string;
  ring: THREE.Mesh;
  characterId: number;
  seed: number;
  mood: number;
  moodAt: number;
  yaw: number;
  prevX: number;
  prevZ: number;
  // jump/wave, clocked locally off the server's tick countdown
  actKind: number;
  actAt: number;
  prevActTicks: number;
  // emote routine, triggered by the emoji someone posts
  emoteKind: number;
  emoteAt: number;
}

const rigs = new Map<string, PubRig>();
const rigPool: PubRig[] = [];
const letterTex: THREE.CanvasTexture[] = [];

const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...extra });

function textSprite(w: number, h: number): { sprite: THREE.Sprite; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.renderOrder = 10;
  return { sprite, ctx, tex };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeRig(): PubRig {
  const holder = new THREE.Group();
  holder.scale.setScalar(PUB_SCALE);
  scene3.add(holder);
  const rig = makePlayerRig(0, holder);
  rig.racket.visible = false; // nobody drinks with a racket in their hand

  // the phone, in the racket hand — hidden unless they are on it
  const phone = new THREE.Mesh(
    new THREE.BoxGeometry(0.11 * TU, 0.19 * TU, 0.015 * TU),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x7fb8ff, emissiveIntensity: 1.6, roughness: 0.4 })
  );
  phone.position.set(0, -1.05, 0.32);
  phone.rotation.x = 0.9;
  phone.visible = false;
  rig.elbowR.add(phone);
  const phoneLight = new THREE.PointLight(0x7fb8ff, 0, 1.4 * TU);
  phoneLight.position.set(0, -0.95, 0.75);
  rig.elbowR.add(phoneLight);

  // the answer paddle, in the other hand
  const paddle = new THREE.Group();
  paddle.position.set(0, -0.95, 0);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * TU, 0.02 * TU, 0.35 * TU, 6), mat(0xd9c39a));
  stick.position.y = -0.45;
  paddle.add(stick);
  const paddleFace = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34 * TU, 0.34 * TU),
    new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide })
  );
  paddleFace.position.y = -1.15;
  paddle.add(paddleFace);
  paddle.visible = false;
  rig.elbowL.add(paddle);

  // sprites live outside the scaled holder so text keeps its size
  const anno = new THREE.Group();
  scene3.add(anno);

  const z = textSprite(128, 64);
  z.ctx.font = 'bold 44px "Chakra Petch", Arial';
  z.ctx.fillStyle = '#cfe0ff';
  z.ctx.textAlign = 'center';
  z.ctx.fillText('z z z', 64, 46);
  z.tex.needsUpdate = true;
  z.sprite.scale.set(0.6, 0.3, 1);
  z.sprite.position.set(0.35, 2.2, 0);
  z.sprite.visible = false;
  anno.add(z.sprite);

  const label = textSprite(512, 128);
  label.sprite.scale.set(1.35, 0.3375, 1);
  label.sprite.position.y = 2.12;
  anno.add(label.sprite);

  const bubble = textSprite(512, 192);
  bubble.sprite.scale.set(2.0, 0.75, 1);
  bubble.sprite.position.set(0.15, 2.75, 0);
  bubble.sprite.visible = false;
  anno.add(bubble.sprite);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  anno.add(ring);

  return {
    holder, anno, rig, phone, phoneLight, paddle, paddleFace, paddleLetter: -1,
    zzz: z.sprite, label: label.sprite, labelKey: '', bubble: bubble.sprite, bubbleKey: '', ring,
    characterId: -1, seed: Math.random() * 10, mood: 0, moodAt: 0,
    yaw: Math.PI, prevX: 0, prevZ: 0,
    actKind: -1, actAt: 0, prevActTicks: 0, emoteKind: 0, emoteAt: 0,
  };
}

/** Dress a rig as one of the roster. `characterId` is the module's avatarId. */
function dressRig(r: PubRig, characterId: number) {
  const char = CHARACTERS[characterId % CHARACTERS.length] ?? CHARACTERS[0];
  r.characterId = characterId;
  applyCharacter(r.rig, char);
}

/** The quiz master: a roster character in a bow tie, permanently behind the
 *  bar. MC_CHARACTER is who holds the mic. */
const MC_CHARACTER = 13; // GRANNY — she has run this quiz for thirty years
function letterTexture(i: number): THREE.CanvasTexture {
  if (letterTex[i]) return letterTex[i];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = ['#ff4b33', '#3c8dff', '#43e97b', '#ffd60a'][i] ?? '#fff';
  roundRect(ctx, 6, 6, 116, 116, 22);
  ctx.fill();
  ctx.fillStyle = i === 3 ? '#1a1200' : '#fff';
  ctx.font = 'bold 84px "Chakra Petch", Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ABCD'[i] ?? '?', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  letterTex[i] = tex;
  return tex;
}

function paintLabel(rig: PubRig, s: SceneSeat, showStats: boolean) {
  const key = `${s.name}|${s.credits}|${s.attention}|${s.team}|${s.online}|${s.isMe}|${showStats}`;
  if (rig.labelKey === key) return;
  rig.labelKey = key;
  const c = (rig.label.material as THREE.SpriteMaterial).map as THREE.CanvasTexture;
  const ctx = (c.image as HTMLCanvasElement).getContext('2d')!;
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = 'bold 44px "Chakra Petch", Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const name = (s.name || 'GUEST').toUpperCase();
  const flag = s.attention === ATT_PHONE ? ' 📱' : s.attention === ATT_IDLE ? ' 💤' : '';
  const line = showStats ? `${name}${flag}  ·  ${s.credits}¢` : `${name}${flag}`;
  const w = Math.min(500, ctx.measureText(line).width + 40);
  ctx.fillStyle = s.attention === ATT_PHONE ? 'rgba(90, 30, 30, 0.85)' : 'rgba(10, 10, 20, 0.7)';
  roundRect(ctx, 256 - w / 2, 22, w, 84, 20);
  ctx.fill();
  if (s.isMe) {
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 5;
    ctx.stroke();
  } else if (s.team) {
    ctx.strokeStyle = TEAM_COLORS[s.team];
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.fillStyle = s.online ? (s.attention === ATT_PHONE ? '#ffb3a8' : '#ffffff') : '#8a8a99';
  ctx.fillText(line, 256, 66);
  c.needsUpdate = true;
}

function paintBubble(rig: PubRig, text: string) {
  if (rig.bubbleKey === text) return;
  rig.bubbleKey = text;
  const c = (rig.bubble.material as THREE.SpriteMaterial).map as THREE.CanvasTexture;
  const ctx = (c.image as HTMLCanvasElement).getContext('2d')!;
  ctx.clearRect(0, 0, 512, 192);
  const emoji = [...text].length <= 2;
  ctx.font = emoji ? '110px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", Arial' : 'bold 34px "Chakra Petch", Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (emoji) {
    ctx.fillText(text, 256, 92);
  } else {
    // wrap to two lines
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const trial = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(trial).width > 440 && cur) { lines.push(cur); cur = w; } else cur = trial;
      if (lines.length === 2) break;
    }
    if (lines.length < 2 && cur) lines.push(cur);
    const h = 40 + lines.length * 40;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    roundRect(ctx, 26, 96 - h / 2, 460, h, 24);
    ctx.fill();
    // tail
    ctx.beginPath();
    ctx.moveTo(120, 96 + h / 2 - 2);
    ctx.lineTo(90, 96 + h / 2 + 30);
    ctx.lineTo(160, 96 + h / 2 - 2);
    ctx.fill();
    ctx.fillStyle = '#14162a';
    lines.forEach((l, i) => ctx.fillText(l, 256, 96 - ((lines.length - 1) * 40) / 2 + i * 40));
  }
  c.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------
function buildRoom(theme: number, pubName: string) {
  // theme is the VENUE; several venues share an interior (see PUB_LOOK)
  if (roomGroup) {
    scene3.remove(roomGroup);
    roomGroup.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); }
    });
  }
  const T = THEMES[PUB_LOOK[theme] ?? 0] ?? THEMES[0];
  const g = new THREE.Group();
  roomGroup = g;
  scene3.add(g);
  scene3.fog = new THREE.Fog(T.fog, 18, 36);
  scene3.background = new THREE.Color(T.fog);

  // floor: boards
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(T.floor, { roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  for (let i = -8; i <= 8; i++) {
    const seam = new THREE.Mesh(new THREE.PlaneGeometry(0.02, ROOM_D), mat(0x000000, { transparent: true, opacity: 0.35 }));
    seam.rotation.x = -Math.PI / 2;
    seam.position.set(i * 1.05, 0.002, 0);
    g.add(seam);
  }
  // walls + ceiling
  const wallMat = mat(T.wall);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), wallMat);
  back.position.set(0, ROOM_H / 2, -ROOM_D / 2);
  g.add(back);
  for (const s of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_D, ROOM_H), wallMat);
    side.position.set((s * ROOM_W) / 2, ROOM_H / 2, 0);
    side.rotation.y = -s * Math.PI / 2;
    g.add(side);
  }
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(0x241812));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_H;
  g.add(ceiling);
  // dado rail + skirting
  const rail = new THREE.Mesh(new THREE.BoxGeometry(ROOM_W, 0.08, 0.06), mat(T.bar));
  rail.position.set(0, 1.1, -ROOM_D / 2 + 0.03);
  g.add(rail);

  // the bar
  const barW = 9;
  const counter = new THREE.Mesh(new THREE.BoxGeometry(barW, 1.1, 0.9), mat(T.bar));
  counter.position.set(0, 0.55, BAR_Z);
  g.add(counter);
  const top = new THREE.Mesh(new THREE.BoxGeometry(barW + 0.2, 0.08, 1.05), mat(T.barTop, { roughness: 0.3, metalness: 0.2 }));
  top.position.set(0, 1.14, BAR_Z);
  g.add(top);
  const footrail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, barW, 8), mat(0xc9a24a, { metalness: 0.9, roughness: 0.25 }));
  footrail.rotation.z = Math.PI / 2;
  footrail.position.set(0, 0.22, BAR_Z + 0.62);
  g.add(footrail);
  // beer taps
  for (let i = -2; i <= 2; i++) {
    const tap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.35, 8), mat(0xc9a24a, { metalness: 0.9, roughness: 0.25 }));
    tap.position.set(i * 0.45 + 2.2, 1.35, BAR_Z - 0.1);
    g.add(tap);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.05), mat([0x222222, 0xc2183a, 0x1f9e6b, 0xffd60a, 0x3c8dff][i + 2]));
    handle.position.set(i * 0.45 + 2.2, 1.6, BAR_Z - 0.1);
    g.add(handle);
  }
  // pint glasses on the counter
  for (let i = 0; i < 6; i++) {
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.055, 0.22, 10),
      new THREE.MeshStandardMaterial({ color: 0xf0b030, transparent: true, opacity: 0.8, roughness: 0.2 })
    );
    glass.position.set(-3.6 + i * 1.3 + (i % 2) * 0.2, 1.29, BAR_Z + 0.25);
    g.add(glass);
  }
  // back bar: shelves and bottles
  const shelfZ = -ROOM_D / 2 + 0.35;
  for (let s = 0; s < 3; s++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.05, 0.4), mat(T.bar));
    shelf.position.set(0, 1.35 + s * 0.55, shelfZ);
    g.add(shelf);
    for (let i = 0; i < 16; i++) {
      const hue = (i * 47 + s * 90) % 360;
      const col = new THREE.Color().setHSL(hue / 360, 0.6, 0.45);
      const bottle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.06, 0.32 + ((i * 7 + s) % 3) * 0.06, 8),
        new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.85, roughness: 0.15 })
      );
      bottle.position.set(-3.5 + i * 0.47, 1.55 + s * 0.55, shelfZ);
      g.add(bottle);
    }
  }
  // the screen above the optics
  const screenW = 5.2;
  const screenH = screenW * (9 / 16);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(screenW + 0.16, screenH + 0.16, 0.12), mat(0x111111, { roughness: 0.4 }));
  frame.position.set(0, 3.05, -ROOM_D / 2 + 0.08);
  g.add(frame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(screenW, screenH),
    new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false })
  );
  screen.position.set(0, 3.05, -ROOM_D / 2 + 0.15);
  g.add(screen);
  const glow = new THREE.PointLight(0x9fc4ff, 1.4, 6);
  glow.position.set(0, 3, -ROOM_D / 2 + 1.2);
  g.add(glow);

  // neon pub sign on the left wall
  const sc = document.createElement('canvas');
  sc.width = 1024;
  sc.height = 256;
  const sctx = sc.getContext('2d')!;
  sctx.fillStyle = 'rgba(0,0,0,0)';
  sctx.font = 'italic bold 110px "Chakra Petch", Arial';
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.shadowColor = T.neon;
  sctx.shadowBlur = 40;
  sctx.fillStyle = T.neon;
  sctx.fillText(pubName.toUpperCase(), 512, 128);
  sctx.shadowBlur = 0;
  sctx.fillStyle = '#ffffff';
  sctx.font = 'italic bold 104px "Chakra Petch", Arial';
  sctx.globalAlpha = 0.55;
  sctx.fillText(pubName.toUpperCase(), 512, 128);
  signTex?.dispose();
  signTex = new THREE.CanvasTexture(sc);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signMesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.25), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false }));
  signMesh.position.set(-ROOM_W / 2 + 0.05, 2.9, -1);
  signMesh.rotation.y = Math.PI / 2;
  g.add(signMesh);
  const neonLight = new THREE.PointLight(new THREE.Color(T.neon), 2.5, 7);
  neonLight.position.set(-ROOM_W / 2 + 1, 2.9, -1);
  g.add(neonLight);

  // dartboard on the right wall
  const board = new THREE.Group();
  const rings = [
    [0.45, 0x1a1a1a], [0.42, 0xc2183a], [0.36, 0x1f9e6b], [0.3, 0xf5f0d8], [0.2, 0x1a1a1a], [0.1, 0xc2183a], [0.04, 0x1f9e6b],
  ] as const;
  for (const [r, c] of rings) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 32), mat(c));
    disc.position.z = (0.45 - r) * 0.01;
    board.add(disc);
  }
  board.position.set(ROOM_W / 2 - 0.06, 1.9, -1.5);
  board.rotation.y = -Math.PI / 2;
  g.add(board);

  // stools and tables
  for (let i = 0; i < 12; i++) {
    const p = seatPos(i);
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.07, 14), mat(0x4a2e1c));
    stool.position.set(p.x, 0.62, p.z);
    g.add(stool);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.6, 8), mat(0x3a3a3a, { metalness: 0.7, roughness: 0.3 }));
    leg.position.set(p.x, 0.3, p.z);
    g.add(leg);
  }
  for (const tx of [-4.6, 0, 4.6]) {
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 20), mat(T.bar));
    table.position.set(tx, 0.98, BAR_Z + 6.4);
    g.add(table);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.25, 0.95, 10), mat(0x3a3a3a, { metalness: 0.6, roughness: 0.4 }));
    stem.position.set(tx, 0.48, BAR_Z + 6.4);
    g.add(stem);
  }

  // pendant lamps
  for (const l of lampLights) scene3.remove(l);
  lampLights = [];
  for (const lx of [-4, 0, 4]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.1, 4), mat(0x111111));
    cord.position.set(lx, ROOM_H - 0.55, BAR_Z + 1.2);
    g.add(cord);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.35, 16, 1, true), mat(T.accent, { side: THREE.DoubleSide, emissive: T.lamp, emissiveIntensity: 0.4 }));
    shade.position.set(lx, ROOM_H - 1.15, BAR_Z + 1.2);
    g.add(shade);
    const light = new THREE.PointLight(T.lamp, 6, 9, 1.6);
    light.position.set(lx, ROOM_H - 1.35, BAR_Z + 1.2);
    g.add(light);
    lampLights.push(light);
  }
  // window with street light, left of the sign
  const win = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.6), new THREE.MeshBasicMaterial({ color: 0x223a5c, toneMapped: false }));
  win.position.set(ROOM_W / 2 - 0.05, 2.3, 2.5);
  win.rotation.y = -Math.PI / 2;
  g.add(win);
  const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.7, 0.04), mat(0xf0e6d2));
  mullion.position.set(ROOM_W / 2 - 0.08, 2.3, 2.5);
  g.add(mullion);
}

// ---------------------------------------------------------------------------
// The big screen
// ---------------------------------------------------------------------------
function paintScreen(s: Scene) {
  const frac = Math.max(0, Math.min(1, s.timeFrac));
  const fracKey = Math.round(frac * 60);
  if (s.screen.key === screenKey && fracKey === screenTimeFrac) return;
  screenKey = s.screen.key;
  screenTimeFrac = fracKey;
  const ctx = screenCtx;
  const W = 1024;
  const H = 576;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0b1230');
  grad.addColorStop(1, '#05071a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = s.screen.accent;
  ctx.font = 'bold 34px "Chakra Petch", Arial';
  ctx.fillText(s.screen.kicker.toUpperCase(), W / 2, 58);
  ctx.fillStyle = '#ffffff';
  // title, wrapped
  let size = 62;
  if (s.screen.title.length > 60) size = 46;
  if (s.screen.title.length > 110) size = 38;
  ctx.font = `bold ${size}px "Chakra Petch", Arial`;
  const words = s.screen.title.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(trial).width > W - 120 && cur) { lines.push(cur); cur = w; } else cur = trial;
  }
  if (cur) lines.push(cur);
  const titleTop = s.screen.lines.length ? 120 : 200;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, titleTop + i * (size + 8)));
  // option lines
  const optTop = titleTop + lines.length * (size + 8) + 30;
  const optH = s.screen.lines.length ? Math.min(78, (H - 90 - optTop) / s.screen.lines.length) : 0;
  ctx.font = `bold ${Math.min(36, optH * 0.48)}px "Chakra Petch", Arial`;
  s.screen.lines.forEach((l, i) => {
    const y = optTop + i * optH;
    const hot = l.startsWith('!');
    const text = hot ? l.slice(1) : l;
    ctx.fillStyle = hot ? 'rgba(67, 233, 123, 0.28)' : 'rgba(255,255,255,0.07)';
    roundRect(ctx, 80, y, W - 160, optH - 10, 14);
    ctx.fill();
    ctx.fillStyle = hot ? '#43e97b' : '#e9edff';
    ctx.textAlign = 'left';
    ctx.fillText(text, 104, y + (optH - 10) / 2 + 2);
    ctx.textAlign = 'center';
  });
  // footer + clock bar
  ctx.fillStyle = '#9daee9';
  ctx.font = 'bold 26px "Chakra Petch", Arial';
  ctx.fillText(s.screen.footer.toUpperCase(), W / 2, H - 52);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(60, H - 22, W - 120, 10);
  ctx.fillStyle = frac < 0.25 ? '#ff4b33' : s.screen.accent;
  ctx.fillRect(60, H - 22, (W - 120) * frac, 10);
  screenTex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initRenderer(canvas: HTMLCanvasElement) {
  hostCanvas = canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  scene3 = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(46, 16 / 10, 0.1, 70);
  // the regulars are lambert-shaded (rig.ts is tennis's code, and tennis is
  // an outdoor game) — a pub is dark, so the fill is generous enough to read
  // a face across the room
  scene3.add(new THREE.HemisphereLight(0xffe2c0, 0x2a1a10, 0.9));
  scene3.add(new THREE.AmbientLight(0xfff0dd, 0.42));
  const key = new THREE.DirectionalLight(0xfff2df, 0.75);
  key.position.set(-3, 7, 6);
  scene3.add(key);

  const sc = document.createElement('canvas');
  sc.width = 1024;
  sc.height = 576;
  screenCtx = sc.getContext('2d')!;
  screenTex = new THREE.CanvasTexture(sc);
  screenTex.colorSpace = THREE.SRGBColorSpace;

  mcRig = makeRig();
  dressRig(mcRig, MC_CHARACTER);
  // on the duckboard behind the bar, so the room can see her over the pumps
  mcRig.holder.position.set(0, 0.35, BAR_Z - 0.85);
  mcRig.anno.position.set(0, 0.35, BAR_Z - 0.85);
  mcRig.label.visible = false;
  mcRig.ring.visible = false;
  // the mic, permanently in the hand that would hold a racket
  const micGrp = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * TU, 0.025 * TU, 0.22 * TU, 8), mat(0x222222, { metalness: 0.6, roughness: 0.4 }));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05 * TU, 10, 8), mat(0x888888, { metalness: 0.8, roughness: 0.3 }));
  ball.position.y = -0.44;
  micGrp.add(stem, ball);
  micGrp.position.set(0, -1.05, 0.1);
  micGrp.rotation.x = 0.6;
  mcRig.rig.elbowR.add(micGrp);
  // and a bow tie
  const bow = new THREE.Mesh(new THREE.BoxGeometry(0.14 * TU, 0.06 * TU, 0.04 * TU), mat(0xc2183a));
  bow.position.set(0, 1.75, 0.62);
  mcRig.rig.torsoGroup.add(bow);
}

function resizeToDisplay() {
  const w = hostCanvas.clientWidth;
  const h = hostCanvas.clientHeight;
  if (!w || !h) return;
  if (hostCanvas.width !== Math.floor(w * renderer.getPixelRatio()) || hostCanvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

function acquireRig(key: string): PubRig {
  let r = rigs.get(key);
  if (r) return r;
  r = rigPool.pop() ?? makeRig();
  r.holder.visible = true;
  r.anno.visible = true;
  r.labelKey = '';
  r.bubbleKey = '';
  r.emoteKind = 0;
  r.actKind = -1;
  r.prevActTicks = 0;
  rigs.set(key, r);
  return r;
}

/** Someone posted an emoji: run the matching body routine, exactly as the
 *  tennis grounds do. */
export function triggerEmote(key: string, kind: number) {
  const r = rigs.get(key);
  if (!r) return;
  r.emoteKind = kind;
  r.emoteAt = performance.now();
}

// A pose for someone who is head-down in their phone: the whole body says it.
function phonePose(now: number, seed: number): Pose {
  const twitch = Math.sin(now / 260 + seed) * 0.04;
  return {
    ...ZERO_POSE,
    leanF: 0.3,
    crouch: 0.1,
    thighL: -0.12, calfL: 0.2, thighR: -0.12, calfR: 0.2,
    shLx: -0.9, shLz: 0.4, elL: -1.5,
    shRx: -1.15 + twitch, shRz: -0.3, elR: -1.7, // phone held up in front
  };
}

// Nodded off at the table.
function dozePose(now: number, seed: number): Pose {
  const breathe = Math.sin(now / 1600 + seed) * 0.03;
  return {
    ...ZERO_POSE,
    leanF: 0.45 + breathe,
    leanS: 0.18,
    crouch: 0.2,
    thighL: -0.1, calfL: 0.18, thighR: -0.1, calfR: 0.18,
    shLx: 0.25, shLz: 0.06, elL: -0.15,
    shRx: 0.25, shRz: -0.06, elR: -0.15,
  };
}

// Paddle up: the answer hand straight overhead, the other on the hip.
function paddlePose(now: number, seed: number): Pose {
  const sway = Math.sin(now / 620 + seed) * 0.06;
  return {
    ...ZERO_POSE,
    leanF: 0.05,
    shLx: -3.0, shLz: 0.2 + sway, elL: -0.2,
    shRx: 0.3, shRz: -0.5, elR: -1.5,
  };
}

function poseRig(r: PubRig, s: SceneSeat, nowMs: number, dt: number, menu: boolean) {
  // module coords → three coords: x across, y into the room becomes z
  const px = s.x;
  const pz = s.y;
  r.holder.position.set(px, 0, pz);
  r.anno.position.set(px, 0, pz);

  const stepDist = Math.hypot(px - r.prevX, pz - r.prevZ);
  r.prevX = px;
  r.prevZ = pz;
  const rig = r.rig;
  if (stepDist < 3) rig.runPhase += (stepDist / PUB_SCALE) * RUN_STRIDE_RATE;

  const moving = s.dirX !== 0 || s.dirY !== 0;
  // facing: the way you're walking, else the big screen — the whole point of
  // being here is the quiz
  const yawTarget = moving
    ? Math.atan2(s.dirX, s.dirY)
    : Math.atan2(0 - px, BAR_Z - 0.5 - pz);
  r.yaw = blendAngle(r.yaw, yawTarget, moving ? 12 : 4, dt);

  // a fresh jump/wave from the server starts its timeline here
  if (s.actTicks > 0 && r.prevActTicks === 0) {
    r.actKind = s.actKind;
    r.actAt = nowMs;
  }
  r.prevActTicks = s.actTicks;
  const actMs = r.actKind === 1 ? WATCHER_WAVE_MS : WATCHER_JUMP_MS;
  const actT = r.actKind >= 0 ? (nowMs - r.actAt) / actMs : 2;
  if (actT > 1) r.actKind = -1;

  if (s.mood !== r.mood) { r.mood = s.mood; r.moodAt = nowMs; }
  const moodAge = (nowMs - r.moodAt) / 1000;
  const emoteT = r.emoteKind ? (nowMs - r.emoteAt) / WATCHER_EMOTE_MS[r.emoteKind] : 2;
  if (emoteT > 1) r.emoteKind = 0;

  const onPhone = s.attention === ATT_PHONE;
  const dozing = s.attention === ATT_IDLE;
  const paddleUp = s.answer !== NO_ANSWER && !onPhone;

  let target: Pose;
  let rate = 12;
  let hop = 0;
  if (r.actKind >= 0) {
    const a = actionPose(r.actKind, actT, nowMs);
    target = a.pose;
    hop = a.hop;
    rate = r.actKind === 1 ? 18 : 30; // the leap snaps, the wave flows
  } else if (r.emoteKind) {
    const e = emotePose(r.emoteKind, emoteT, nowMs);
    target = e.pose;
    hop = e.hop;
    rate = 18;
  } else if (onPhone) {
    target = phonePose(nowMs, r.seed);
    rate = 8;
  } else if (moving) {
    target = runPose(rig.runPhase, s.dirX);
    rate = 16;
  } else if (dozing) {
    target = dozePose(nowMs, r.seed);
    rate = 5;
  } else if (paddleUp) {
    target = paddlePose(nowMs, r.seed);
    rate = 14;
  } else if (s.mood === 1 && moodAge < 3) {
    const e = emotePose(1, Math.min(0.99, moodAge / 3), nowMs); // cheer
    target = e.pose;
    hop = e.hop;
    rate = 18;
  } else if (s.mood === 2 && moodAge < 3) {
    target = emotePose(3, Math.min(0.99, moodAge / 3), nowMs).pose; // sulk
    rate = 14;
  } else {
    target = s.isMe && !menu ? readyPose(nowMs, r.seed) : standPose(nowMs, r.seed);
  }
  // legs keep walking under anything the arms are doing
  if (moving && (r.actKind >= 0 || r.emoteKind || onPhone || paddleUp)) {
    const legs = runPose(rig.runPhase, s.dirX);
    target = { ...target, thighL: legs.thighL, calfL: legs.calfL, thighR: legs.thighR, calfR: legs.calfR };
    hop = 0;
  }
  applyPose(rig, target, rate, dt, r.yaw, nowMs);
  rig.root.position.y += hop;

  // head: down at the phone, else level
  const ha = 1 - Math.exp(-8 * dt);
  const headX = onPhone ? -0.5 : dozing ? 0.35 : 0;
  rig.head.rotation.x += (headX - rig.head.rotation.x) * ha;
  rig.head.rotation.y -= rig.head.rotation.y * ha;

  // props
  r.phone.visible = onPhone;
  r.phoneLight.intensity = onPhone ? 2.2 + Math.sin(nowMs / 110 + r.seed) * 0.3 : 0;
  r.zzz.visible = dozing;
  if (dozing) r.zzz.position.y = 2.2 + ((nowMs / 2500 + r.seed) % 1) * 0.3;
  r.paddle.visible = paddleUp;
  if (paddleUp && r.paddleLetter !== s.answer) {
    r.paddleLetter = s.answer;
    (r.paddleFace.material as THREE.MeshBasicMaterial).map = letterTexture(s.answer);
    (r.paddleFace.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }
  r.ring.visible = s.isMe && !menu;

  // offline regulars fade out rather than vanish
  const dim = !s.online;
  r.holder.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mm = m.material as THREE.Material & { opacity: number; transparent: boolean };
    if (mm.transparent !== dim || mm.opacity !== (dim ? 0.35 : 1)) {
      mm.transparent = dim;
      mm.opacity = dim ? 0.35 : 1;
    }
  });

  // bubbles fade after four and a half seconds
  if (s.bubble && nowMs - s.bubble.at < 4500) {
    paintBubble(r, s.bubble.text);
    r.bubble.visible = true;
    const age = (nowMs - s.bubble.at) / 1000;
    (r.bubble.material as THREE.SpriteMaterial).opacity = age > 3.5 ? 1 - (age - 3.5) : 1;
  } else {
    r.bubble.visible = false;
  }
  r.label.visible = !menu;
  if (!menu) paintLabel(r, s, true);
}

let lastFrameAt = 0;
let prevFrameMs = 0;
export function drawScene(s: Scene) {
  resizeToDisplay();
  const nowMs = performance.now();
  const t = nowMs / 1000;
  const dt = prevFrameMs ? Math.min(0.1, (nowMs - prevFrameMs) / 1000) : 1 / 60;
  prevFrameMs = nowMs;
  lastFrameAt = t;
  if (themeBuilt !== s.theme || (signMesh && (signMesh.userData.name !== s.pubName))) {
    buildRoom(s.theme, s.pubName);
    if (signMesh) signMesh.userData.name = s.pubName;
    themeBuilt = s.theme;
  }
  paintScreen(s);

  // the regulars, wherever they have wandered to
  const seen = new Set<string>();
  let me: SceneSeat | null = null;
  for (const seat of s.seats) {
    seen.add(seat.key);
    const r = acquireRig(seat.key);
    if (r.characterId !== seat.avatarId) dressRig(r, seat.avatarId);
    poseRig(r, seat, nowMs, dt, s.menu);
    if (seat.isMe) me = seat;
  }
  for (const [key, r] of rigs) {
    if (seen.has(key)) continue;
    rigs.delete(key);
    r.holder.visible = false;
    r.anno.visible = false;
    r.characterId = -1;
    rigPool.push(r);
  }

  // the quiz master: talks (head bob + mic hand) for a few seconds after a line
  const talking = nowMs - s.mc.at < 4000 && !!s.mc.text;
  const mc = mcRig.rig;
  mc.head.rotation.x = talking ? Math.sin(t * 14) * 0.06 : 0;
  mc.head.rotation.y = Math.sin(t * 0.8) * 0.25;
  applyPose(
    mc,
    {
      ...ZERO_POSE,
      leanF: 0.03 + Math.sin(t * 2.3) * 0.01,
      shRx: talking ? -2.1 : -0.6, shRz: -0.25, elR: talking ? -1.5 : -0.7,
      shLx: -0.25, shLz: 0.25 + (talking ? Math.sin(t * 5) * 0.15 : 0), elL: -0.5,
    },
    10,
    dt,
    0, // faces the room (+z)
    nowMs
  );
  if (s.mc.text && nowMs - s.mc.at < 6000) {
    paintBubble(mcRig, s.mc.text);
    mcRig.bubble.visible = true;
    (mcRig.bubble.material as THREE.SpriteMaterial).opacity = 1;
    mcRig.bubble.scale.set(2.4, 0.9, 1);
    mcRig.bubble.position.set(1.9, 2.05, 0); // beside the screen, not over it
  } else mcRig.bubble.visible = false;

  // camera: a fixed broadcast shot of the room from the door end. It tracks
  // you as you walk so you are never off the edge of your own pub.
  if (s.menu) {
    const a = t * 0.12;
    camera.position.set(Math.sin(a) * 5.5, 2.6 + Math.sin(t * 0.3) * 0.2, 5.5 + Math.cos(a) * 2.5);
    camera.lookAt(0, 1.6, BAR_Z - 1);
  } else {
    // the shot tracks you around the floor: it slides with you (clamped so
    // the bar and the screen never leave the frame) and backs off as you
    // wander toward the door
    const sway = Math.sin(t * 0.25) * 0.18;
    const followX = me ? Math.max(-3.4, Math.min(3.4, me.x * 0.7)) : 0;
    camTargetX += (followX + sway - camTargetX) * (1 - Math.exp(-2.5 * dt));
    camera.position.set(camTargetX, 2.7, 9.0);
    camera.lookAt(camTargetX * 0.85, 1.35, BAR_Z + 0.2);
  }
  // lamp flicker
  lampLights.forEach((l, i) => { l.intensity = 6 + Math.sin(t * 7 + i * 2.1) * 0.15; });
  renderer.render(scene3, camera);
}
let camTargetX = 0;

/** Screen-space (CSS px, relative to the canvas) position of a regular's
 *  head, for DOM overlays like the call-out button. Null when not visible. */
export function headScreenPos(key: string): { x: number; y: number } | null {
  const r = rigs.get(key);
  if (!r || !r.holder.visible) return null;
  const v = new THREE.Vector3(r.holder.position.x, 1.95, r.holder.position.z);
  v.project(camera);
  if (v.z > 1) return null;
  return { x: ((v.x + 1) / 2) * hostCanvas.clientWidth, y: ((1 - v.y) / 2) * hostCanvas.clientHeight };
}

export const lastFrame = () => lastFrameAt;


// ---------------------------------------------------------------------------
// Character-select live previews: every card shows its character as a real
// animated 3D rig. One shared WebGL canvas is laid over the select screen
// and scissored into a viewport per card (18 separate canvases would blow
// through the browser's WebGL context limit); rects are re-read every frame
// so scrolling and hover transforms stay aligned, and every draw is
// scissored to the scroll panel so characters vanish at its edges. The loop
// self-throttles: while the select screen is hidden every slot rect is
// zero and the frame exits before touching the GPU.
// ---------------------------------------------------------------------------
interface PreviewSlot {
  scene: THREE.Scene;
  rig: PlayerRig;
  el: HTMLElement;
  seed: number;
  clip?: HTMLElement; // per-slot clip container (default: the select grid)
}
let previewRenderer: THREE.WebGLRenderer | null = null;
let previewCam: THREE.PerspectiveCamera | null = null;
let previewSlots: PreviewSlot[] = [];
// scroll container the characters are clipped to — without it they would
// keep drawing above/below the panel once their card scrolls out of it
let previewClip: HTMLElement | null = null;

export function initCharacterPreviews(
  canvas: HTMLCanvasElement,
  slots: { char: Character; el: HTMLElement }[],
  clipEl: HTMLElement
) {
  previewClip = clipEl;
  previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  previewCam = new THREE.PerspectiveCamera(40, 1, 0.5, 60);
  previewSlots = slots.map(({ char, el }, i) => {
    const scene = new THREE.Scene();
    const rig = makePlayerRig(0, scene);
    rig.racket.visible = false; // they came for the quiz, not a match
    applyCharacter(rig, char);
    const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
    sun.position.set(-3, 6, 5);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x39406b, 1.15));
    return { scene, rig, el, seed: i * 1.73 };
  });
  requestAnimationFrame(previewFrame);
}

// Add a preview slot after init — the career-pro card and the creator both
// show a look that changes at runtime. Returns an updater that re-dresses
// the slot's rig (applyCharacter no-ops when the look key is unchanged).
export function registerPreviewSlot(
  char: Character,
  el: HTMLElement,
  clip?: HTMLElement
): (next: Character) => void {
  const scene = new THREE.Scene();
  const rig = makePlayerRig(0, scene);
  rig.racket.visible = false;
  applyCharacter(rig, char);
  const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
  sun.position.set(-3, 6, 5);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x39406b, 1.15));
  previewSlots.push({ scene, rig, el, clip, seed: previewSlots.length * 1.73 });
  return next => applyCharacter(rig, next);
}

let previewDrew = false; // last frame put pixels on the canvas
let previewHadVisible = false;
let previewShownAt = 0; // when slots (re)appeared — drives the entrance fade

function previewFrame() {
  requestAnimationFrame(previewFrame);
  const now = performance.now();
  const r = previewRenderer!;
  const canvas = r.domElement;
  const canvasRect = canvas.getBoundingClientRect();
  const defaultClip = previewClip!.getBoundingClientRect();
  const clipOf = (s: PreviewSlot) =>
    s.clip ? s.clip.getBoundingClientRect() : defaultClip;

  // slots collapse to zero rects while their screen is display:none —
  // one final clear wipes the canvas, then frames become no-ops
  const visible = previewSlots.filter(s => {
    const rect = s.el.getBoundingClientRect();
    const clip = clipOf(s);
    return (
      rect.width > 0 &&
      rect.right > clip.left && rect.left < clip.right &&
      rect.bottom > clip.top && rect.top < clip.bottom
    );
  });
  if (visible.length === 0 && !previewDrew) {
    previewHadVisible = false;
    return;
  }

  // the cards stagger in over ~0.7s when the screen (re)opens; fade the
  // canvas alongside them so the characters don't pop in over empty cards
  if (visible.length > 0 && !previewHadVisible) previewShownAt = now;
  previewHadVisible = visible.length > 0;
  canvas.style.opacity = Math.min(1, Math.max(0, (now - previewShownAt - 100) / 450)).toFixed(3);

  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  if (cw === 0 || chh === 0) return;
  if (canvas.width !== Math.floor(cw * r.getPixelRatio()) || canvas.height !== Math.floor(chh * r.getPixelRatio())) {
    r.setSize(cw, chh, false);
  }

  // clear the whole canvas (transparent), then scissor per card
  r.setScissorTest(false);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.setScissorTest(true);
  previewDrew = visible.length > 0;

  for (const s of visible) {
    const rect = s.el.getBoundingClientRect();
    const clip = clipOf(s);

    // idle life: slow showcase sway (mostly front-facing), breathing, and a
    // relaxed arm hang with a tiny sway — the game's pose system is not
    // running here, so the joints are posed directly
    const t = now / 1000 + s.seed;
    const rig = s.rig;
    rig.root.rotation.y = Math.sin(t * 0.55) * 0.65;
    rig.root.position.y = Math.sin(t * 2.0) * 0.035;
    rig.upper.rotation.x = 0.04 + Math.sin(t * 2.0) * 0.02;
    rig.shoulderL.rotation.set(-0.22 + Math.sin(t * 1.7) * 0.05, 0, 0.14);
    rig.elbowL.rotation.x = -0.5;
    rig.shoulderR.rotation.set(-0.3 + Math.sin(t * 1.7 + 1.2) * 0.05, 0, -0.16);
    rig.elbowR.rotation.x = -0.55;

    // viewport spans the full slot (so a half-scrolled character clips
    // rather than squashes); scissor is the slot ∩ scroll panel ∩ canvas
    const sx0 = Math.max(rect.left, clip.left, canvasRect.left);
    const sx1 = Math.min(rect.right, clip.right, canvasRect.right);
    const sy0 = Math.max(rect.top, clip.top, canvasRect.top);
    const sy1 = Math.min(rect.bottom, clip.bottom, canvasRect.bottom);
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    const left = rect.left - canvasRect.left;
    const bottom = canvasRect.bottom - rect.bottom;
    r.setViewport(left, bottom, rect.width, rect.height);
    r.setScissor(sx0 - canvasRect.left, canvasRect.bottom - sy1, sx1 - sx0, sy1 - sy0);
    previewCam!.aspect = rect.width / rect.height;
    previewCam!.updateProjectionMatrix();
    // frames the full height range: GRANNY's shoes up to MYSTO's hat tip
    previewCam!.position.set(0, 3.3, 9.4);
    previewCam!.lookAt(0, 2.85, 0);
    r.render(s.scene, previewCam!);
  }
}
