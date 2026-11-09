/**
 * 动森语音 TTS 服务：零依赖 Node HTTP 服务。
 *   GET  /                     预览页
 *   GET  /api/tts?text=…       合成 → audio/wav（?pitch=&speed=&download=1）
 *   POST /api/tts {text,pitch,speed}
 *   POST /v1/audio/speech      OpenAI TTS 兼容（src/openai.mjs）
 *   GET  /v1/models            OpenAI 兼容模型列表
 *   GET  /api/health           存活检查
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { renderWav } from './render.mjs';
import { speech, models } from './openai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANIMALESE_PORT || 7430);
const PUBLIC = join(HERE, '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ogg': 'audio/ogg', '.json': 'application/json' };

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 查询参数取数：缺参/空串 → 默认值，非法数字 → 默认值 */
function optNum(params, key, lo, hi, fallback) {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function tts(req, res, params) {
  const text = String(params.get('text') ?? '').slice(0, 500).trim();
  if (!text) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'text 不能为空' }));
    return;
  }
  const pitch = optNum(params, 'pitch', 0.6, 1.6, 1);
  const speed = optNum(params, 'speed', 0.5, 2, 1);
  let result;
  try {
    result = renderWav(text, { pitch, speed });
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e) }));
    return;
  }
  const headers = {
    'content-type': 'audio/wav',
    'content-length': result.wav.length,
    'cache-control': 'no-store',
    'x-animalese-units': String(result.unitCount),
  };
  if (params.get('download')) headers['content-disposition'] = 'attachment; filename="animalese.wav"';
  res.writeHead(200, headers);
  res.end(result.wav);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}

/** 读取 JSON 请求体（64KB 上限，超限/解析失败已响应并返回 null） */
async function readJson(req, res) {
  const chunks = [];
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体过大' }));
        req.destroy();
        return null;
      }
      chunks.push(c);
    }
  } catch {
    return null; // 客户端中断或 destroy 后的迭代错误
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'JSON 解析失败' }));
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-expose-headers', 'x-animalese-units');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' });
    res.end();
    return;
  }
  if (url.pathname === '/api/tts') {
    if (req.method === 'POST') {
      const j = await readJson(req, res);
      if (!j) return;
      const params = new URLSearchParams({
        text: String(j.text ?? ''),
        pitch: String(j.pitch ?? 1),
        speed: String(j.speed ?? 1),
      });
      if (j.download) params.set('download', '1');
      tts(req, res, params);
      return;
    }
    tts(req, res, url.searchParams);
    return;
  }
  if (url.pathname === '/v1/audio/speech' && req.method === 'POST') {
    const j = await readJson(req, res);
    if (!j) return;
    const out = await speech(j);
    res.writeHead(out.status, {
      'content-type': out.contentType,
      'content-length': out.body.length,
      'cache-control': 'no-store',
      'x-animalese-format': out.format,
      'x-animalese-units': String(out.unitCount),
    });
    res.end(out.body);
    return;
  }
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(models()));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'GET') {
    serveStatic(res, url.pathname);
    return;
  }
  res.writeHead(405);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`動森語音 TTS：http://127.0.0.1:${PORT}  （API: /api/tts?text=你好呀）`);
});
