/**
 * 动森语音（Animalese）核心逻辑：文本 → 音节单元 → 排程（含普通话调形曲线）。
 * 纯函数无音频依赖，服务端离线渲染（render.mjs）使用。
 *
 * 实现思路与 Animal Crossing 村民对话同源：定高定长的人声音节单元，
 * 播放只靠 playbackRate 曲线变调；调形/语调/节奏参数为本项目自定。
 */

/** 停顿符后的静音（秒）；连续停顿叠加 */
export const PAUSE_GAP = {
  ',': 0.16, '，': 0.16, '、': 0.16, ';': 0.22, '；': 0.22, ':': 0.22, '：': 0.22,
  '.': 0.42, '。': 0.42, '!': 0.48, '！': 0.48, '?': 0.48, '？': 0.48, '…': 0.28, '~': 0.1, '～': 0.1,
};
/** 每个声调的半音轮廓（按时长插值，占 TONE_AMOUNT）；5 = 轻声。数值为本项目自定 */
export const TONES = { 1: [0.7, 0.7], 2: [-0.5, 1.5], 3: [-0.9, -1.6, -0.5], 4: [1.5, -1.1], 5: [-0.7, -0.7] };
export const TONE_AMOUNT = 0.4;
export const GAIN = 0.5;
/** 每秒最多起多少个音节 */
export const UPS = 12;
/** 落后超过 2×MAX_LAG 秒的非句尾音节直接丢，保住句尾同步 */
export const MAX_LAG = 0.9;
/** 拉丁字母/数字 → 最近的汉语音节（按字母名近似，gibberish 本就是目的） */
export const LATIN = {
  a: 'a', b: 'bi', c: 'xi', d: 'di', e: 'e', f: 'fu', g: 'ji', h: 'he', i: 'ai', j: 'jie', k: 'ke',
  l: 'le', m: 'mo', n: 'en', o: 'ou', p: 'pi', q: 'qiu', r: 'ri', s: 'si', t: 'te', u: 'wu',
  v: 'wei', w: 'wa', x: 'xi', y: 'wai', z: 'zei',
  0: 'ling', 1: 'yi', 2: 'er', 3: 'san', 4: 'si', 5: 'wu', 6: 'liu', 7: 'qi', 8: 'ba', 9: 'jiu',
};

/* ---------- 打字/发声共用节拍（本项目自定步进） ---------- */

export const CHAR_MS = 55;
export const GAP_MS = 220;
export const STRONG_MS = 420;
const ELLIPSIS_MS = 180;
const TILDE_MS = 130;
const LATIN_MS = 22;
export const MIN_MS = 560;
export const CAP_MS = 2800;
const LATIN_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\d\s'’-]/u;
const GAP_TABLE = {
  '。': STRONG_MS, '．': STRONG_MS, '!': STRONG_MS, '！': STRONG_MS,
  '?': STRONG_MS, '？': STRONG_MS, '…': ELLIPSIS_MS, '~': TILDE_MS, '～': TILDE_MS,
  ',': GAP_MS, '，': GAP_MS, '、': GAP_MS, ';': GAP_MS, '；': GAP_MS, ':': GAP_MS, '：': GAP_MS,
};

function charStepMs(ch) {
  const gap = GAP_TABLE[ch];
  if (gap !== undefined) return gap;
  return LATIN_RE.test(ch) ? LATIN_MS : CHAR_MS;
}

/**
 * 逐字时间表：短句把"发音字"的可见跨度放慢到 MIN（停顿符不算可见内容），
 * 超长句整体提速到 CAP 内。返回 cps / starts(ms)。
 */
export function timeline(text) {
  const cps = Array.from(text);
  const starts = [];
  let t = 0;
  let lastVoiced = -1;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    starts.push(t);
    if (!(ch in GAP_TABLE)) lastVoiced = i;
    t += charStepMs(ch);
  }
  if (cps.length > 1) {
    const span = lastVoiced >= 0 ? starts[lastVoiced] + CHAR_MS : t;
    const k = span < MIN_MS ? MIN_MS / span : t > CAP_MS ? CAP_MS / t : 1;
    if (k !== 1) for (let i = 0; i < starts.length; i++) starts[i] = Math.round(starts[i] * k);
  }
  return { cps, starts };
}

/**
 * 文本 → 按字符顺序的事件流：汉字出读音表的音节、拉丁/数字按字母名近似、
 * 其余字符静默跳过；停顿符结束当前短语（短语内音节共享该停顿符作为语调判定 end）。
 */
export function buildEvents(cps, starts, chars) {
  const events = [];
  let phrase = [];
  let endPause = '';
  const flush = () => {
    const of = phrase.length;
    phrase.forEach((u, i) => events.push({ kind: 'unit', key: u.key, tone: u.tone, t0: u.t0, pos: i, of, end: endPause }));
    phrase = [];
    endPause = '';
  };
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    const t0 = (starts[i] ?? 0) / 1000;
    if (ch in PAUSE_GAP) {
      endPause = ch;
      flush();
      events.push({ kind: 'pause', ch, t0 });
      continue;
    }
    const han = chars.get(ch);
    if (han) phrase.push({ key: han[0], tone: han[1], t0 });
    else if (/[a-zA-Z0-9]/.test(ch)) phrase.push({ key: LATIN[ch.toLowerCase()] ?? 'a', tone: 1, t0 });
  }
  flush();
  return events;
}

/**
 * 语调曲线（本项目自定参数）：句首抬 0.7 半音、逐音节缓降 0.05、随机 ±0.2；
 * 疑问句倒数第二字 +1.2、末字 +1.8 且尾音上扬弯 2.5 半音；感叹句 +0.9 且更响。
 * curve = playbackRate 八点曲线（线性插值网格）。
 */
export function unitCurve(ev, rate0, random) {
  const q = /[?？]/.test(ev.end);
  const ex = /[!！]/.test(ev.end);
  const isLast = ev.pos === ev.of - 1;
  let st = (ev.pos === 0 ? 0.7 : 0) - 0.05 * ev.pos + (random() - 0.5) * 0.4 + (ex ? 0.9 : 0);
  let bend = 0;
  if (q && ev.pos === ev.of - 2) st += 1.2;
  if (q && isLast) {
    st += 1.8;
    bend = 2.5;
  }
  if (/…/.test(ev.end) && isLast) st -= 0.6;
  const tone = ev.tone ? (TONES[ev.tone] ?? [0, 0]) : [0, 0];
  const curve = new Float32Array(8);
  for (let k = 0; k < 8; k++) {
    const p = k / 7;
    const x = p * (tone.length - 1);
    const a = Math.floor(x);
    const b = Math.min(tone.length - 1, a + 1);
    const ts = (tone[a] + (tone[b] - tone[a]) * (x - a)) * TONE_AMOUNT;
    curve[k] = rate0 * 2 ** ((st + ts + bend * p) / 12);
  }
  return curve;
}

/**
 * 声音时钟排程：音节限速 UPS、停顿静音叠加、落后 > 2×MAX_LAG 的非句尾音节丢弃。
 * 返回 [{ t, curve, off, lenRaw, durSec, gain }]。
 */
export function scheduleUnits(events, units, { pitch = 1, speed = 1, bankHz = 360 } = {}) {
  const rate0 = (420 * pitch) / bankHz;
  const random = () => Math.random();
  const now0 = 0.02;
  // 限速与停顿都随语速倍率缩放：否则 UPS 硬下限会把 speed>1 完全盖掉
  const rate = UPS * speed;
  let last = -Infinity;
  let end = 0;
  let gap = 0;
  let free = 0;
  const out = [];
  for (const ev of events) {
    if (ev.kind === 'pause') {
      gap += (PAUSE_GAP[ev.ch] ?? 0) / speed;
      free = end + gap;
      continue;
    }
    const raw = units.get(ev.key);
    if (!raw) continue;
    const [off, lenRaw] = raw;
    const len = lenRaw / rate0;
    const now = now0 + ev.t0 / speed;
    const t = Math.max(now, last + 1 / rate, free);
    const lag = t - now;
    const isFinal = ev.pos >= ev.of - 2;
    if (!isFinal && lag > 2 * MAX_LAG) continue;
    last = t;
    end = Math.max(end, t + len);
    gap = 0;
    free = end;
    out.push({
      t,
      curve: unitCurve(ev, rate0, random),
      off,
      lenRaw,
      durSec: len,
      gain: GAIN * (/[!！]/.test(ev.end) ? 1.25 : 1),
    });
  }
  return out;
}

/** 文本 → 事件流（timeline + buildEvents 一步到位） */
export function textEvents(text, chars) {
  const { cps, starts } = timeline(text);
  return { cps, starts, events: buildEvents(cps, starts, chars) };
}
