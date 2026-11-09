/**
 * OpenAI TTS 兼容层：POST /v1/audio/speech 与 GET /v1/models。
 * 请求 { model, input, voice, response_format, speed }（扩展：多传 pitch 可直接指定声线倍率）：
 *   - model 仅占位忽略；Authorization 由服务端忽略（本地服务无需鉴权）
 *   - voice 映射到声线音高预设（动物语不区分音色）：alloy/echo/fable/onyx/nova/shimmer
 *   - wav / pcm（24kHz s16le mono，OpenAI 约定）原生输出；mp3/opus/aac/flac 调 ffmpeg 转码，
 *     ffmpeg 不在 PATH 或失败时回退 wav，响应头 x-animalese-format 标明实际格式
 */
import { spawn } from 'node:child_process';
import { renderWav } from './render.mjs';

const VOICE_PITCH = { alloy: 1, echo: 0.9, fable: 0.8, onyx: 0.7, nova: 1.15, shimmer: 1.3 };
const FFMPEG_ARGS = { mp3: ['-f', 'mp3'], opus: ['-f', 'opus'], aac: ['-f', 'adts'], flac: ['-f', 'flac'] };
const MIME = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** OpenAI 风格错误体 */
function err(status, message) {
  return {
    status,
    contentType: 'application/json',
    format: 'json',
    unitCount: 0,
    body: Buffer.from(JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } })),
  };
}

/** ffmpeg 转码（stdin 进 WAV、stdout 出目标格式）；出错/超时抛给上层回退 */
function transcode(wav, fmt) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', ...FFMPEG_ARGS[fmt], 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('ffmpeg 超时'));
    }, 15000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg 退出 ${code}: ${stderr.slice(0, 200)}`));
    });
    p.stdin.end(wav);
  });
}

/** 48kHz WAV → 24kHz s16le mono 裸流（OpenAI pcm 约定），相邻两样本均值抽取 */
function pcm24k(wav) {
  const n = (wav.length - 44) >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round((wav.readInt16LE(44 + i * 4) + wav.readInt16LE(44 + i * 4 + 2)) / 2), i * 2);
  }
  return out;
}

/** OpenAI /v1/audio/speech 主体 → { status, contentType, format, unitCount, body } */
export async function speech(body) {
  const input = String(body?.input ?? '').slice(0, 500).trim();
  if (!input) return err(400, 'input 不能为空');
  const pitchRaw = Number(body?.pitch);
  const pitch = Number.isFinite(pitchRaw) ? clamp(pitchRaw, 0.6, 1.6) : clamp(VOICE_PITCH[body?.voice] ?? 1, 0.6, 1.6);
  const speedRaw = Number(body?.speed);
  const speed = Number.isFinite(speedRaw) ? clamp(speedRaw, 0.5, 2) : 1;
  const fmt = String(body?.response_format || 'mp3').toLowerCase();
  const { wav, unitCount } = renderWav(input, { pitch, speed });
  if (fmt === 'wav') return { status: 200, contentType: 'audio/wav', format: 'wav', unitCount, body: wav };
  if (fmt === 'pcm') return { status: 200, contentType: 'audio/pcm; rate=24000', format: 'pcm', unitCount, body: pcm24k(wav) };
  if (FFMPEG_ARGS[fmt]) {
    try {
      return { status: 200, contentType: MIME[fmt], format: fmt, unitCount, body: await transcode(wav, fmt) };
    } catch {
      return { status: 200, contentType: 'audio/wav', format: 'wav', unitCount, body: wav };
    }
  }
  return err(400, `不支持的 response_format: ${fmt}`);
}

/** OpenAI /v1/models 兼容列表 */
export function models() {
  return {
    object: 'list',
    data: [{ id: 'animalese-tts', object: 'model', created: 1700000000, owned_by: 'animalese-tts' }],
  };
}
