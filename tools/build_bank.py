r"""自建动森语音库：TTS 逐音节朗读载体字 → 切发声段 → PSOLA 压平音高 → 打包索引。

与 Animal Crossing 村民对话音同源的思路：每个无声调拼音音节留一条"定高、定长"的人声单元，
播放端只靠 playbackRate 曲线变调（普通话四声轮廓、短语语调都在引擎里做）。

    python tools/build_bank.py                 # 默认音色 zh-CN-XiaoXiaoNeural
    python tools/build_bank.py --voice zh-CN-XiaoyiNeural --bank-hz 360

输出（assets/）：
    bank.f32      48kHz 单声道 float32 PCM，全部单元首尾相接（服务端渲染直接读）
    bank.json     {"hz": BANK_HZ, "units": {音节: [起点秒, 时长秒]}}
    readings.json {"音节+调": 汉字串}（引擎反查 汉字→(音节, 调)）

需要：pip install edge-tts pypinyin numpy praat-parselmouth；ffmpeg 在 PATH。
原始朗读缓存在 tools/.cache/，重跑不重复请求网络。
"""
import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import parselmouth
from parselmouth.praat import call
from pypinyin import pinyin, Style

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'assets'))
CACHE = os.path.join(HERE, '.cache')

SR = 48000
# 定高单元的目标音高与发声段长度：选 360Hz 是因为引擎基准 420Hz 播放时速率 ~1.17，
# 音节听感落在幼但不刺的音区；终端轻微下滑 0.6 半音，压平后不至于完全"死板"
BANK_HZ = 360
TERMINAL_FALL_ST = 0.6
VOICED_S = 0.09          # 压平后的发声段时长
CONS_MAX_S = 0.025       # 发声前最多保留的辅音长度
FADE_IN_S = 0.008
FADE_OUT_S = 0.03
PAD_S = 0.05             # 单元间隔静音
NORM_RMS = 0.11          # 归一化 RMS
MIN_UNITS = 320          # 低于此数视为失败

# 拼音体系里的非标准音节归并（语气字/自成音节）
SYLLABLE_FIX = {'m': 'en', 'n': 'en', 'ng': 'en', 'hm': 'en', 'hng': 'en', 'ê': 'e', 'r': 'er', 'y': 'ai'}


def han_readings():
    """U+4E00–U+9FFF 每个汉字的最常用读音：(ch, 音节, 调)。调 5 = 轻声。"""
    out = []
    for cp in range(0x4E00, 0xA000):
        ch = chr(cp)
        r = pinyin(ch, style=Style.TONE3, neutral_tone_with_five=True, errors='ignore')
        if not r or not r[0] or not r[0][0][-1:].isdigit():
            continue
        s = r[0][0]
        syl = s[:-1].replace('ü', 'v')
        out.append((ch, SYLLABLE_FIX.get(syl, syl), int(s[-1])))
    return out


def is_gb2312(ch):
    try:
        ch.encode('gb2312')
        return True
    except UnicodeEncodeError:
        return False


def pick_carriers(readings):
    """每个音节选一个"读音最稳"的载体字：优先一声（TTS 读出来最平，好切）、
    常用字（GB2312 一级区）、多音字靠后。"""
    best = {}
    for ch, syl, tone in readings:
        heter = len(pinyin(ch, style=Style.NORMAL, heteronym=True)[0])
        rank = (tone != 1, not is_gb2312(ch), heter > 1, tone, ch)
        if syl not in best or rank < best[syl][0]:
            best[syl] = (rank, ch)
    return {s: ch for s, (_, ch) in sorted(best.items())}


async def record(text, voice, sem):
    """edge-tts 朗读一个载体字，返回解码后的 float64 PCM（带缓存）。"""
    os.makedirs(CACHE, exist_ok=True)
    key = os.path.join(CACHE, hashlib.md5(f'{voice}|{text}'.encode()).hexdigest() + '.mp3')
    if not os.path.exists(key):
        import edge_tts
        async with sem:
            buf = bytearray()
            for attempt in range(3):
                try:
                    async for chunk in edge_tts.Communicate(text, voice).stream():
                        if chunk['type'] == 'audio':
                            buf += chunk['data']
                    break
                except Exception as e:
                    if attempt == 2:
                        raise RuntimeError(f'TTS 失败 {text!r}: {e}') from e
                    await asyncio.sleep(1.5 * (attempt + 1))
            if len(buf) < 800:
                raise RuntimeError(f'无音频 {text!r}')
            with open(key, 'wb') as f:
                f.write(buf)
    p = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', key, '-f', 'f32le', '-ac', '1', '-ar', str(SR), 'pipe:1'],
        capture_output=True, check=True,
    )
    return np.frombuffer(p.stdout, np.float32).astype(np.float64)


def cut_voiced(x):
    """只保留发声段：响度起点的辅音（≤CONS_MAX_S）+ 发声（≤VOICED_S+CONS_MAX_S）。"""
    snd = parselmouth.Sound(x, SR)
    p = snd.to_pitch_ac(time_step=0.005, pitch_floor=100, pitch_ceiling=650)
    f0, ts = p.selected_array['frequency'], p.xs()
    voiced = np.nonzero(f0 > 0)[0]
    loud = np.nonzero(np.abs(x) > np.abs(x).max() * 0.03)[0]
    if len(loud) == 0:
        raise RuntimeError('静音段')
    onset = loud[0] / SR
    v0, v1 = (ts[voiced[0]], ts[voiced[-1]]) if len(voiced) else (onset, loud[-1] / SR)
    s = max(onset, v0 - CONS_MAX_S)
    e = min(v1, v0 + CONS_MAX_S + VOICED_S)
    if e - s < 0.03:
        e = min(onset + CONS_MAX_S + VOICED_S, len(x) / SR)
    return x[int(s * SR):int(e * SR)]


def flatten(seg):
    """PSOLA：音高压到 BANK_HZ（尾部微降 0.6 半音），发声段时长压到 VOICED_S。"""
    snd = parselmouth.Sound(seg, SR)
    d = snd.duration
    manip = call(snd, 'To Manipulation', 0.005, 90, 700)
    ptier = call('Create PitchTier', 'p', 0, d)
    end_hz = BANK_HZ * 2 ** (-TERMINAL_FALL_ST / 12)
    call(ptier, 'Add point', 0, BANK_HZ)
    call(ptier, 'Add point', d * 0.78, BANK_HZ)
    call(ptier, 'Add point', d, end_hz)
    call([ptier, manip], 'Replace pitch tier')
    # 时长：辅音头保留原速，发声部分按比例缩到 VOICED_S
    k = min(1.0, VOICED_S / max(d - CONS_MAX_S, 0.02))
    dtier = call('Create DurationTier', 'd', 0, d)
    for t, f in ((0, 1.0), (CONS_MAX_S, 1.0), (CONS_MAX_S + 0.005, k), (d, k)):
        call(dtier, 'Add point', t, f)
    call([dtier, manip], 'Replace duration tier')
    y = call(manip, 'Get resynthesis (overlap-add)').values[0]
    return np.asarray(y, dtype=np.float64)


def polish(y):
    """淡入淡出 + RMS 归一化。"""
    fi, fo = int(FADE_IN_S * SR), int(FADE_OUT_S * SR)
    y = y.copy()
    y[:fi] *= np.linspace(0, 1, fi) ** 2
    y[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))
    nc = int(CONS_MAX_S * SR)
    body = y[min(nc, len(y) - 1):]
    rms = np.sqrt(np.mean(body ** 2)) + 1e-9
    return y / rms * NORM_RMS


async def main():
    global BANK_HZ
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default='zh-CN-XiaoXiaoNeural')
    ap.add_argument('--bank-hz', type=int, default=BANK_HZ)
    args = ap.parse_args()
    BANK_HZ = args.bank_hz

    readings = han_readings()
    carriers = pick_carriers(readings)
    print(f'{len(readings)} 汉字读音，{len(carriers)} 个音节', file=sys.stderr)

    sem = asyncio.Semaphore(4)
    pad = np.zeros(int(PAD_S * SR))
    parts, units, t = [pad], {}, PAD_S
    failed = []

    # 先并发把所有朗读拉下来（缓存命中则直接读）
    async def fetch_one(syl, ch):
        try:
            return syl, cut_voiced(await record(ch, args.voice, sem))
        except Exception as e:
            failed.append((syl, ch, str(e)))
            return syl, None

    results = await asyncio.gather(*(fetch_one(s, c) for s, c in carriers.items()))

    for syl, seg in results:
        if seg is None:
            continue
        y = polish(flatten(seg))
        units[syl] = [round(t, 4), round(len(y) / SR, 4)]
        parts += [y, pad]
        t += len(y) / SR + PAD_S

    print(f'完成 {len(units)} 单元，失败 {len(failed)}：{failed[:5]}', file=sys.stderr)
    if len(units) < MIN_UNITS:
        print('单元过少，中止（不覆盖现有库）', file=sys.stderr)
        sys.exit(1)

    audio = np.concatenate(parts)
    audio = (audio / np.abs(audio).max() * 0.9).astype(np.float32)
    os.makedirs(OUT, exist_ok=True)
    audio.tofile(os.path.join(OUT, 'bank.f32'))
    json.dump({'hz': BANK_HZ, 'units': units}, open(os.path.join(OUT, 'bank.json'), 'w', encoding='utf-8'), separators=(',', ':'))
    table = {}
    for ch, syl, tone in readings:
        table[f'{syl}{tone}'] = table.get(f'{syl}{tone}', '') + ch
    json.dump(dict(sorted(table.items())), open(os.path.join(OUT, 'readings.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'库生成完毕：{len(units)} 单元，音频 {t:.1f}s → assets/bank.f32', file=sys.stderr)


asyncio.run(main())
