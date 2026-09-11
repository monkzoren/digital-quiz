// The twelve regulars. Index = player.avatarId (the module only checks the
// range); everything visual about an avatar lives here and in render.ts.
export interface Avatar {
  name: string;
  blurb: string;
  skin: number;
  shirt: number;
  hair: number;
  /** 0 none · 1 flat cap · 2 beanie · 3 crown · 4 headband · 5 bucket hat */
  hat: number;
  /** 0 short · 1 long · 2 bald · 3 mohawk · 4 bun */
  hairStyle: number;
  /** 0 none · 1 glasses · 2 moustache · 3 beard · 4 scarf */
  extra: number;
}

export const AVATARS: Avatar[] = [
  { name: 'DEL', blurb: 'Knows a bloke who knows a bloke', skin: 0xe8b894, shirt: 0x2a5bd7, hair: 0x3b2417, hat: 1, hairStyle: 0, extra: 0 },
  { name: 'PRIYA', blurb: 'Reads the news. All of it.', skin: 0xc08658, shirt: 0xff4b33, hair: 0x1a0f0a, hat: 0, hairStyle: 1, extra: 1 },
  { name: 'BJÖRN', blurb: 'Once met a Viking, probably', skin: 0xf1c9a5, shirt: 0x1f9e6b, hair: 0xd9b45a, hat: 0, hairStyle: 0, extra: 3 },
  { name: 'NANA', blurb: 'Retired, undefeated at bingo', skin: 0xd9a37f, shirt: 0x8a3fd1, hair: 0xe8e8e8, hat: 0, hairStyle: 4, extra: 1 },
  { name: 'TYRONE', blurb: 'Sport. Only sport.', skin: 0x7a4a2c, shirt: 0xffd60a, hair: 0x120c08, hat: 0, hairStyle: 2, extra: 0 },
  { name: 'MEI', blurb: 'Music round is hers', skin: 0xf3d3b0, shirt: 0xff7ab8, hair: 0x241a3a, hat: 2, hairStyle: 1, extra: 0 },
  { name: 'STAN', blurb: 'Brought his own pen', skin: 0xe0b28e, shirt: 0x8b5a2b, hair: 0x8f8f8f, hat: 5, hairStyle: 0, extra: 2 },
  { name: 'ZOË', blurb: 'Chaos, but well-read chaos', skin: 0xf2c6ad, shirt: 0x111111, hair: 0x38d5c8, hat: 0, hairStyle: 3, extra: 0 },
  { name: 'KWAME', blurb: 'Calm until the geography round', skin: 0x5c3a21, shirt: 0xf5f5f5, hair: 0x0e0a06, hat: 0, hairStyle: 0, extra: 4 },
  { name: 'ROSA', blurb: 'Film buff, spoiler risk', skin: 0xcf9a72, shirt: 0xe63946, hair: 0x2b1b12, hat: 4, hairStyle: 1, extra: 0 },
  { name: 'THE KING', blurb: 'Wears the crown. Earns it rarely.', skin: 0xeeb99a, shirt: 0x5d2ea8, hair: 0x6b4a2b, hat: 3, hairStyle: 0, extra: 2 },
  { name: 'PIXEL', blurb: 'Tech round on lock', skin: 0xb98a63, shirt: 0x00c2ff, hair: 0xff8c00, hat: 2, hairStyle: 0, extra: 1 },
];
export const AVATAR_COUNT = AVATARS.length; // must equal the module's AVATAR_COUNT
