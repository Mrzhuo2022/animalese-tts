import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeline, buildEvents, scheduleUnits } from '../src/engine.mjs';
import { renderWav } from '../src/render.mjs';
import { speech, models } from '../src/openai.mjs';

const chars = new Map([
  ['你', ['ni', 3]],
  ['好', ['hao', 3]],
  ['世', ['shi', 4]],
  ['界', ['jie', 4]],
]);

test('timeline: 节拍（汉字 55ms、弱停顿 220ms、强停顿 420ms）', () => {
  const { cps, starts } = timeline('好，好！好');
  assert.deepEqual(cps, ['好', '，', '好', '！', '好']);
  assert.equal(starts[1], 55);
  assert.equal(starts[2], 55 + 220);
  assert.equal(starts[3], 55 + 220 + 55);
  assert.equal(starts[4], 55 + 220 + 55 + 420);
});

test('buildEvents: 短语切分与读音表', () => {
  const { cps, starts } = timeline('你好，世界？');
  const ev = buildEvents(cps, starts, chars);
  const units = ev.filter((e) => e.kind === 'unit');
  assert.deepEqual(
    units.map((u) => [u.key, u.tone, u.pos, u.of, u.end]),
    [
      ['ni', 3, 0, 2, '，'],
      ['hao', 3, 1, 2, '，'],
      ['shi', 4, 0, 2, '？'],
      ['jie', 4, 1, 2, '？'],
    ],
  );
});

test('renderWav: 输出合法 WAV 且非静音', () => {
  const { wav, unitCount } = renderWav('你好呀！', { pitch: 1, speed: 1 });
  assert.equal(wav.readUInt32LE(0), 0x46464952); // 'RIFF'
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.ok(wav.length > 44 * 100, `wav 太小: ${wav.length}`);
  assert.ok(unitCount >= 2, `音节数异常: ${unitCount}`);
  // 峰值非静音
  let peak = 0;
  for (let i = 44; i < Math.min(wav.length, 44 * 40000); i += 2) {
    const v = Math.abs(wav.readInt16LE(i));
    if (v > peak) peak = v;
  }
  assert.ok(peak > 1000, `峰值过低: ${peak}`);
});

test('openai 兼容: /v1/models 列表与 speech() wav/pcm/错误', async () => {
  const m = models();
  assert.equal(m.object, 'list');
  assert.ok(m.data.length >= 1);

  const wav = await speech({ model: 'tts-1', input: '你好', voice: 'shimmer', response_format: 'wav' });
  assert.equal(wav.status, 200);
  assert.equal(wav.contentType, 'audio/wav');
  assert.equal(wav.body.toString('ascii', 8, 12), 'WAVE');
  assert.ok(wav.unitCount >= 1);

  // 默认 mp3：ffmpeg 可用则转码成功，不可用则回退 wav（x-animalese-format 标明）
  const mp3 = await speech({ input: '你好' });
  assert.equal(mp3.status, 200);
  assert.ok(['mp3', 'wav'].includes(mp3.format), `格式异常: ${mp3.format}`);
  assert.equal(mp3.contentType, mp3.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');

  const pcm = await speech({ input: '你好', response_format: 'pcm', speed: 1.5 });
  assert.equal(pcm.contentType, 'audio/pcm; rate=24000');
  assert.equal(pcm.body.length % 2, 0);
  assert.ok(pcm.body.length > 1000, `pcm 太小: ${pcm.body.length}`);

  const bad = await speech({ input: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.contentType, 'application/json');
  assert.ok(JSON.parse(bad.body.toString('utf8')).error.message);

  const badFormat = await speech({ input: '你好', response_format: 'wma' });
  assert.equal(badFormat.status, 400);
});
