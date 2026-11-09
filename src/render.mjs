/**
 * 离线渲染：排程好的音节 → PCM 混音 → WAV（16-bit 单声道 48kHz）。
 * 语音库为自建（tools/build_bank.py）：assets/bank.f32（48k 单声道 f32）+
 * bank.json（索引）+ readings.json（读音表）。纯 JS 重采样：
 * playbackRate 曲线下每输出步进 rate 个源样本，线性插值。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { textEvents, scheduleUnits } from './engine.mjs';

const SR = 48000;
const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');

let bank = null;

function loadBank() {
  if (bank) return bank;
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'bank.json'), 'utf-8'));
  const units = new Map(Object.entries(manifest.units));
  const pcm = readFileSync(join(ASSETS, 'bank.f32'));
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const table = JSON.parse(readFileSync(join(ASSETS, 'readings.json'), 'utf-8'));
  const chars = new Map();
  for (const [k, chs] of Object.entries(table)) {
    const key = k.slice(0, -1);
    const tone = Number(k.slice(-1));
    if (!key || !Number.isFinite(tone)) continue;
    for (const ch of chs) if (!chars.has(ch)) chars.set(ch, [key, tone]);
  }
  bank = { hz: manifest.hz, units, samples, chars };
  return bank;
}

/** 曲线插值：setValueCurveAtTime 的 8 点线性网格 */
function curveAt(curve, p) {
  const x = p * 7;
  const a = Math.floor(x);
  const b = Math.min(7, a + 1);
  return curve[a] + (curve[b] - curve[a]) * (x - a);
}

/**
 * 文本 → 单声道 Float32 样本（48kHz）。pitch = 声线倍率（基准 420Hz），
 * speed = 语速倍率（>1 更快）。
 */
export function renderSamples(text, { pitch = 1, speed = 1 } = {}) {
  const { units, samples, chars, hz } = loadBank();
  const { events } = textEvents(text, chars);
  const sched = scheduleUnits(events, units, { pitch, speed, bankHz: hz });
  let total = 0.5;
  for (const u of sched) total = Math.max(total, u.t + u.durSec + 0.25);
  const buf = new Float32Array(Math.ceil(total * SR));
  for (const u of sched) {
    const startN = Math.round(u.t * SR);
    const n = Math.round(u.durSec * SR);
    const srcLen = samples.length;
    let pos = u.off * SR;
    for (let i = 0; i < n; i++) {
      pos += curveAt(u.curve, i / n);
      const s = Math.floor(pos);
      if (s < 0 || s + 1 >= srcLen) break;
      const frac = pos - s;
      const v = samples[s] + (samples[s + 1] - samples[s]) * frac;
      const idx = startN + i;
      if (idx >= buf.length) break;
      buf[idx] += v * u.gain;
    }
  }
  // 限幅
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    buf[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { buf, sr: SR, unitCount: sched.length };
}

/** 文本 → WAV Buffer */
export function renderWav(text, opts = {}) {
  const { buf, sr, unitCount } = renderSamples(text, opts);
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    data.writeInt16LE(Math.round(buf[i] * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([header, data]), unitCount };
}
