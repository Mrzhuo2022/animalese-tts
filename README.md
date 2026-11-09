# 动森语音 TTS（animalese-tts）

动物之森式"动物语"语音合成：自建真人声音节库 + 普通话调形曲线变调。输入中文文本，
输出动森村民感十足的"叽叽咕咕"语音（WAV）。

## 运行

```bash
node src/server.mjs          # http://127.0.0.1:7430（ANIMALESE_PORT 可改端口）
```

打开首页即是在线预览：输入文本、调声线/语速、合成播放、下载 WAV。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tts?text=你好呀&pitch=1&speed=1` | 返回 `audio/wav`；`download=1` 带下载头 |
| POST | `/api/tts` | JSON `{ text, pitch, speed }` |
| GET | `/api/health` | 存活检查 |

- `pitch`：声线倍率 0.6–1.6（基准 420Hz，越高越"幼"）
- `speed`：语速倍率 0.5–2
- CORS 全开，网页里可直接 `fetch` 后 `URL.createObjectURL(blob)` 播放

```bash
curl -o out.wav "http://127.0.0.1:7430/api/tts?text=任务完成了！"
```

## 原理

**语音库（自建）** — `tools/build_bank.py` 生成：

1. `pypinyin` 穷举 U+4E00–U+9FFF 每个汉字的最常用读音，按音节挑"一声 + 常用字区"
   的载体字（一声读出来最平，好切）；
2. `edge-tts`（免费、无账号）逐个朗读载体字；
3. Praat（parselmouth）检测发声段，切掉多余辅音，PSOLA 把音高压平到 360Hz
   （尾部微降 0.6 半音），发声段统一 90ms；
4. RMS 归一化、首尾淡入淡出，全部单元首尾相接打包。

产出 `assets/`：`bank.f32`（48kHz 单声道 PCM，服务端直接读）、`bank.json`
（每音节的切片索引 `{"hz", "units": {音节: [起点秒, 时长秒]}}`）、`readings.json`
（`音节+调 → 汉字串` 读音表）。

**引擎**（`src/engine.mjs`）：文本 → 音节事件流（汉字查读音表、拉丁字母按字母名
近似）→ 声音时钟排程（限速 12 音节/s、标点留静音、落后丢非句尾字保同步）→
**调形曲线**：普通话四声轮廓 + 句首抬高 + 逐字缓降 + 疑问句尾音上扬 + 感叹句更响，
全部做成 playbackRate 八点曲线。

**渲染**（`src/render.mjs`）：纯 JS 离线混音 —— 每音节从库 PCM 切片、按曲线重采样、
叠加限幅，输出 WAV。服务端零依赖。

**重建语音库**：

```bash
pip install edge-tts pypinyin numpy praat-parselmouth   # ffmpeg 需在 PATH
python tools/build_bank.py                              # ~5 分钟，缓存后秒级重跑
```

换音色：`--voice zh-CN-XiaoyiNeural`（任意 edge-tts 中文音色）；换基准音高：
`--bank-hz 340`。

## 灵感来源

- **《动物之森》Animal Crossing** —— 村民对话的"动物语"：定高定长的音节单元、
  播放时靠变调说话的呈现方式，本项目的目标听感。
- **[Coopanion](https://github.com/Pal-AI-Lab/Coopanion)**（Pal-AI-Lab）—— 本项目的语音库与引擎均在其思路启发下实现
  （自建语料、自写代码）。
- **工具链**：[edge-tts](https://github.com/rany2/edge-tts)（朗读）、
  [pypinyin](https://github.com/mozillazg/python-pinyin)（读音表）、
  [Praat / parselmouth](https://github.com/YannickJadoul/parselmouth)（PSOLA 压平）、
  ffmpeg（转码）。感谢开源生态。

## 许可

代码 MIT。语音库由微软 Edge 朗读服务生成的合成语音加工而来，使用时请留意
TTS 服务条款。



