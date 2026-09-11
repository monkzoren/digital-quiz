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
import { AVATARS } from './avatars';
import { ATT_IDLE, ATT_PHONE, NO_ANSWER, TEAM_COLORS } from './config';

export interface SceneSeat {
  key: string; // identity hex
  name: string;
  avatarId: number;
  seat: number;
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
  hostKey: string;
}

// ---------------------------------------------------------------------------
// Layout (meters). Bar along z = -4; stools face -z.
// ---------------------------------------------------------------------------
const ROOM_W = 16;
const ROOM_D = 13;
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
let mcRig: Rig;
let lampLights: THREE.PointLight[] = [];

// ---------------------------------------------------------------------------
// Rigs
// ---------------------------------------------------------------------------
interface Rig {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
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
  hatMeshes: THREE.Object3D[];
  avatarId: number;
  seed: number;
  mood: number;
  moodAt: number;
}

const rigs = new Map<string, Rig>();
const rigPool: Rig[] = [];
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

function makeRig(): Rig {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.5, 4, 10), mat(0x888888));
  body.position.y = 0.95;
  root.add(body);
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 10), mat(0x2b2b33));
  legs.position.y = 0.42;
  root.add(legs);

  const head = new THREE.Group();
  head.position.y = 1.62;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), mat(0xdddddd));
  skull.name = 'skull';
  head.add(skull);
  // eyes
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), mat(0x111111, { roughness: 0.3 }));
    eye.position.set(0.09 * s, 0.03, -0.21);
    head.add(eye);
  }
  root.add(head);

  const makeArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(0.34 * side, 1.28, 0);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 3, 8), mat(0x888888));
    upper.name = 'sleeve';
    upper.position.y = -0.24;
    g.add(upper);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 6), mat(0xdddddd));
    hand.name = 'hand';
    hand.position.y = -0.52;
    g.add(hand);
    return g;
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  root.add(armL, armR);

  // the phone, in the right hand — hidden unless they are on it
  const phone = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.2, 0.015),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x7fb8ff, emissiveIntensity: 1.6, roughness: 0.4 })
  );
  phone.position.set(0, -0.55, -0.1);
  phone.rotation.x = -0.9;
  phone.visible = false;
  armR.add(phone);
  const phoneLight = new THREE.PointLight(0x7fb8ff, 0, 1.4);
  phoneLight.position.set(0, -0.45, -0.25);
  armR.add(phoneLight);

  // the answer paddle, in the left hand
  const paddle = new THREE.Group();
  paddle.position.set(0, -0.55, 0);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 6), mat(0xd9c39a));
  stick.position.y = 0.15;
  paddle.add(stick);
  const paddleFace = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }));
  paddleFace.position.y = 0.48;
  paddle.add(paddleFace);
  paddle.visible = false;
  armL.add(paddle);

  const z = textSprite(128, 64);
  z.ctx.font = 'bold 44px "Chakra Petch", Arial';
  z.ctx.fillStyle = '#cfe0ff';
  z.ctx.textAlign = 'center';
  z.ctx.fillText('z z z', 64, 46);
  z.tex.needsUpdate = true;
  z.sprite.scale.set(0.6, 0.3, 1);
  z.sprite.position.set(0.35, 2.2, 0);
  z.sprite.visible = false;
  root.add(z.sprite);

  const label = textSprite(512, 128);
  label.sprite.scale.set(1.35, 0.3375, 1);
  label.sprite.position.y = 2.12;
  root.add(label.sprite);

  const bubble = textSprite(512, 192);
  bubble.sprite.scale.set(2.0, 0.75, 1);
  bubble.sprite.position.set(0.15, 2.75, 0);
  bubble.sprite.visible = false;
  root.add(bubble.sprite);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 32), new THREE.MeshBasicMaterial({ color: 0xffd60a, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  root.add(ring);

  scene3.add(root);
  return {
    root, body, head, armL, armR, phone, phoneLight, paddle, paddleFace, paddleLetter: -1,
    zzz: z.sprite, label: label.sprite, labelKey: '', bubble: bubble.sprite, bubbleKey: '', ring,
    hatMeshes: [], avatarId: -1, seed: Math.random() * 10, mood: 0, moodAt: 0,
  };
}

function dressRig(rig: Rig, avatarId: number, mc = false) {
  if (rig.avatarId === avatarId && !mc) return;
  rig.avatarId = avatarId;
  const a = AVATARS[avatarId % AVATARS.length];
  const skin = mc ? 0xe3b58f : a.skin;
  const shirt = mc ? 0x1d1d22 : a.shirt;
  (rig.body.material as THREE.MeshStandardMaterial).color.setHex(shirt);
  rig.head.traverse(o => {
    if ((o as THREE.Mesh).isMesh && o.name === 'skull') ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.setHex(skin);
  });
  for (const arm of [rig.armL, rig.armR]) {
    arm.traverse(o => {
      if (!(o as THREE.Mesh).isMesh) return;
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (o.name === 'sleeve') m.color.setHex(shirt);
      if (o.name === 'hand') m.color.setHex(skin);
    });
  }
  for (const h of rig.hatMeshes) rig.head.remove(h);
  rig.hatMeshes = [];
  const add = (o: THREE.Object3D) => { rig.head.add(o); rig.hatMeshes.push(o); };
  const hairMat = mat(mc ? 0x2a2a2a : a.hair);
  const style = mc ? 0 : a.hairStyle;
  if (style === 0) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.255, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
    cap.position.y = 0.03;
    add(cap);
  } else if (style === 1) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    cap.position.y = 0.03;
    add(cap);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.45, 12, 1, false, 0, Math.PI), hairMat);
    back.rotation.y = -Math.PI / 2;
    back.position.set(0, -0.15, 0.12);
    add(back);
  } else if (style === 3) {
    const hawk = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.4), hairMat);
    hawk.position.y = 0.27;
    add(hawk);
  } else if (style === 4) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.255, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
    cap.position.y = 0.03;
    add(cap);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), hairMat);
    bun.position.set(0, 0.2, 0.18);
    add(bun);
  }
  const hat = mc ? 0 : a.hat;
  if (hat === 1) {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.04, 16), mat(0x3a3a3a));
    brim.position.set(0, 0.12, -0.06);
    add(brim);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.4), mat(0x3a3a3a));
    crown.position.y = 0.08;
    add(crown);
  } else if (hat === 2) {
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), mat(0xc23b4b));
    beanie.position.y = 0.05;
    add(beanie);
    const bobble = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat(0xf5f5f5));
    bobble.position.y = 0.33;
    add(bobble);
  } else if (hat === 3) {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.18, 8, 1, true), mat(0xffd60a, { metalness: 0.7, roughness: 0.3, side: THREE.DoubleSide }));
    crown.position.y = 0.28;
    add(crown);
  } else if (hat === 4) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.245, 0.03, 8, 20), mat(0xff4b33));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.1;
    add(band);
  } else if (hat === 5) {
    const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 0.2, 16, 1, true), mat(0x7a8f5a, { side: THREE.DoubleSide }));
    bucket.position.y = 0.16;
    add(bucket);
    const top = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), mat(0x7a8f5a));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.26;
    add(top);
  }
  const extra = mc ? 0 : a.extra;
  if (extra === 1) {
    for (const s of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.012, 6, 16), mat(0x222222));
      lens.position.set(0.09 * s, 0.03, -0.22);
      add(lens);
    }
  } else if (extra === 2 || extra === 3) {
    const tash = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.05), hairMat);
    tash.position.set(0, -0.06, -0.22);
    add(tash);
    if (extra === 3) {
      const beard = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.4), hairMat);
      beard.position.set(0, -0.02, -0.03);
      add(beard);
    }
  } else if (extra === 4) {
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 8, 16), mat(0xff8c00));
    scarf.rotation.x = Math.PI / 2;
    scarf.position.y = -0.28;
    add(scarf);
  }
  if (mc) {
    // bow tie + a microphone in the right hand
    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.04), mat(0xc2183a));
    bow.position.set(0, -0.3, -0.24);
    add(bow);
    const mic = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.22, 8), mat(0x222222, { metalness: 0.6, roughness: 0.4 }));
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat(0x888888, { metalness: 0.8, roughness: 0.3 }));
    ball.position.y = 0.14;
    mic.add(stem, ball);
    mic.position.set(0, -0.55, -0.05);
    mic.rotation.x = -0.6;
    rig.armR.add(mic);
  }
}

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

function paintLabel(rig: Rig, s: SceneSeat, showStats: boolean) {
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

function paintBubble(rig: Rig, text: string) {
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
  if (roomGroup) {
    scene3.remove(roomGroup);
    roomGroup.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); }
    });
  }
  const T = THEMES[theme] ?? THEMES[0];
  const g = new THREE.Group();
  roomGroup = g;
  scene3.add(g);
  scene3.fog = new THREE.Fog(T.fog, 14, 30);
  scene3.background = new THREE.Color(T.fog);

  // floor: boards
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), mat(T.floor, { roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);
  for (let i = -7; i <= 7; i++) {
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
  camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 60);
  scene3.add(new THREE.HemisphereLight(0xffe2c0, 0x2a1a10, 0.55));
  const amb = new THREE.AmbientLight(0xffffff, 0.18);
  scene3.add(amb);

  const sc = document.createElement('canvas');
  sc.width = 1024;
  sc.height = 576;
  screenCtx = sc.getContext('2d')!;
  screenTex = new THREE.CanvasTexture(sc);
  screenTex.colorSpace = THREE.SRGBColorSpace;

  mcRig = makeRig();
  dressRig(mcRig, 0, true);
  mcRig.root.position.set(0, 0, BAR_Z - 0.9);
  mcRig.root.rotation.y = Math.PI; // faces the room (+z)
  mcRig.label.visible = false;
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

function acquireRig(key: string): Rig {
  let rig = rigs.get(key);
  if (rig) return rig;
  rig = rigPool.pop() ?? makeRig();
  rig.root.visible = true;
  rig.labelKey = '';
  rig.bubbleKey = '';
  rigs.set(key, rig);
  return rig;
}

function poseRig(rig: Rig, s: SceneSeat, t: number, menu: boolean) {
  const p = seatPos(s.seat);
  rig.root.position.set(p.x, 0.32, p.z); // perched on the stool
  // face the bar (a little toward the screen)
  rig.root.rotation.y = Math.atan2(0 - p.x, BAR_Z - p.z) + Math.PI;
  const bob = Math.sin(t * 1.7 + rig.seed) * 0.012;
  rig.body.position.y = 0.95 + bob;
  rig.head.position.y = 1.62 + bob;
  rig.head.rotation.set(0, 0, 0);
  rig.armL.rotation.set(0.15, 0, 0.12);
  rig.armR.rotation.set(0.15, 0, -0.12);
  rig.phone.visible = false;
  rig.phoneLight.intensity = 0;
  rig.zzz.visible = false;
  rig.paddle.visible = false;
  rig.ring.visible = s.isMe && !menu;
  rig.root.visible = true;
  const dim = !s.online;
  rig.root.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const mm = m.material as THREE.MeshStandardMaterial;
      mm.transparent = dim;
      mm.opacity = dim ? 0.35 : 1;
    }
  });

  if (s.mood !== rig.mood) { rig.mood = s.mood; rig.moodAt = t; }
  const moodAge = t - rig.moodAt;
  if (s.attention === ATT_PHONE) {
    // head down, phone up, blue glow on the face
    rig.head.rotation.x = 0.55;
    rig.armR.rotation.set(-1.9, 0.35, -0.35);
    rig.phone.visible = true;
    rig.phoneLight.intensity = 2.2 + Math.sin(t * 9 + rig.seed) * 0.3;
  } else if (s.attention === ATT_IDLE) {
    rig.head.rotation.z = 0.35;
    rig.head.rotation.x = 0.25;
    rig.armL.rotation.set(0.05, 0, 0.05);
    rig.armR.rotation.set(0.05, 0, -0.05);
    rig.zzz.visible = true;
    rig.zzz.position.y = 2.2 + ((t * 0.4 + rig.seed) % 1) * 0.3;
  } else if (s.mood === 1 && moodAge < 3) {
    // cheer: arms up, hop
    const hop = Math.abs(Math.sin(t * 8)) * 0.12;
    rig.root.position.y += hop;
    rig.armL.rotation.set(-2.6 + Math.sin(t * 10) * 0.2, 0, 0.4);
    rig.armR.rotation.set(-2.6 - Math.sin(t * 10) * 0.2, 0, -0.4);
  } else if (s.mood === 2 && moodAge < 3) {
    // sulk: head down, arms hang
    rig.head.rotation.x = 0.7;
    rig.armL.rotation.set(0.35, 0, 0.05);
    rig.armR.rotation.set(0.35, 0, -0.05);
  }
  if (s.answer !== NO_ANSWER && s.attention !== ATT_PHONE) {
    rig.paddle.visible = true;
    rig.armL.rotation.set(-2.3, 0, 0.3);
    if (rig.paddleLetter !== s.answer) {
      rig.paddleLetter = s.answer;
      (rig.paddleFace.material as THREE.MeshBasicMaterial).map = letterTexture(s.answer);
      (rig.paddleFace.material as THREE.MeshBasicMaterial).needsUpdate = true;
    }
  }
  // bubbles fade after four seconds
  if (s.bubble && t * 1000 - s.bubble.at < 4500) {
    paintBubble(rig, s.bubble.text);
    rig.bubble.visible = true;
    const age = (t * 1000 - s.bubble.at) / 1000;
    (rig.bubble.material as THREE.SpriteMaterial).opacity = age > 3.5 ? 1 - (age - 3.5) : 1;
  } else {
    rig.bubble.visible = false;
  }
  rig.label.visible = !menu;
  if (!menu) paintLabel(rig, s, true);
}

let lastFrameAt = 0;
export function drawScene(s: Scene) {
  resizeToDisplay();
  const t = performance.now() / 1000;
  lastFrameAt = t;
  if (themeBuilt !== s.theme || (signMesh && (signMesh.userData.name !== s.pubName))) {
    buildRoom(s.theme, s.pubName);
    if (signMesh) signMesh.userData.name = s.pubName;
    themeBuilt = s.theme;
  }
  paintScreen(s);

  // seats
  const seen = new Set<string>();
  for (const seat of s.seats) {
    seen.add(seat.key);
    const rig = acquireRig(seat.key);
    dressRig(rig, seat.avatarId);
    poseRig(rig, seat, t, s.menu);
  }
  for (const [key, rig] of rigs) {
    if (seen.has(key)) continue;
    rigs.delete(key);
    rig.root.visible = false;
    rig.avatarId = -1;
    rigPool.push(rig);
  }

  // the quiz master: talks (head bob + mic hand) for a few seconds after a line
  const talking = t * 1000 - s.mc.at < 4000 && !!s.mc.text;
  mcRig.head.rotation.x = talking ? Math.sin(t * 14) * 0.06 : 0;
  mcRig.head.rotation.y = Math.sin(t * 0.8) * 0.25;
  mcRig.armR.rotation.set(talking ? -2.0 : -0.6, 0, -0.2);
  mcRig.armL.rotation.set(0.2, 0, 0.25 + (talking ? Math.sin(t * 5) * 0.15 : 0));
  mcRig.body.position.y = 0.95 + Math.sin(t * 2.3) * 0.01;
  if (s.mc.text && t * 1000 - s.mc.at < 6000) {
    paintBubble(mcRig, s.mc.text);
    mcRig.bubble.visible = true;
    (mcRig.bubble.material as THREE.SpriteMaterial).opacity = 1;
    mcRig.bubble.scale.set(2.4, 0.9, 1);
    mcRig.bubble.position.set(1.9, 2.05, 0); // beside the screen, not over it
  } else mcRig.bubble.visible = false;

  // camera
  if (s.menu) {
    const a = t * 0.12;
    camera.position.set(Math.sin(a) * 5.5, 2.6 + Math.sin(t * 0.3) * 0.2, 4.5 + Math.cos(a) * 2.5);
    camera.lookAt(0, 1.6, BAR_Z - 1);
  } else {
    // behind the back row, just above head height, looking at the bar
    const sway = Math.sin(t * 0.25) * 0.25;
    camera.position.set(sway, 2.35, 6.4);
    camera.lookAt(0, 1.55, BAR_Z - 0.5);
  }
  // lamp flicker
  lampLights.forEach((l, i) => { l.intensity = 6 + Math.sin(t * 7 + i * 2.1) * 0.15; });
  renderer.render(scene3, camera);
}

/** Screen-space (CSS px, relative to the canvas) position of a seat's head,
 *  for DOM overlays like the call-out button. Null when not visible. */
export function headScreenPos(key: string): { x: number; y: number } | null {
  const rig = rigs.get(key);
  if (!rig || !rig.root.visible) return null;
  const v = new THREE.Vector3(0, 1.95, 0);
  rig.root.localToWorld(v);
  v.project(camera);
  if (v.z > 1) return null;
  return { x: ((v.x + 1) / 2) * hostCanvas.clientWidth, y: ((1 - v.y) / 2) * hostCanvas.clientHeight };
}

export const lastFrame = () => lastFrameAt;
