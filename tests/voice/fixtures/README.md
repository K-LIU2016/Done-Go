# tests/voice/fixtures — 合成中文测试音频（无真人隐私）

- **全部为合成语音**：macOS `say` 本地 TTS，中文（中国大陆）声音 Eddy / Flo 生成，
  ffmpeg 转码为 **16kHz / 16bit / mono PCM WAV**（对齐 `web/voice/contracts.js`
  的 `VOICE_SAMPLE_RATE` 与 SPEC §2 采样要求）。
- **无真人隐私**：不含任何真人录音、不含任何用户语音（红线：不落盘真实音频，
  评测/测试只用合成或公开音频）。生成日期 2026-10-25（V6FunASR 线）。
- **用途**：FunASR 2pass 容器实测（窗口后节点）与语音链路测试；句子取自
  SPEC §2.3 意图难例域与原型转写文本。

| 文件 | 文本 | 覆盖点（SPEC §2.3） |
|---|---|---|
| `asr-multi-event.wav` | 明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告。 | 一句多事项 / 显式「必须」/ 截止 |
| `asr-vague-run.wav` | 晚上有空的话去跑个步。 | 模糊时间 vague |
| `asr-time-correction.wav` | 周四三点，不对，四点开产品评审会。 | 中途改口，以最后为准 |
| `asr-weekly-call.wav` | 每周一上午十点和客户打电话，记得提前准备报价单。 | recurrence + 客户 |
| `asr-month-deadline.wav` | 这个月底之前一定要把论文初稿发给老板。 | 月底 / 跨月相对日期 |
| `asr-nonevent-weather.wav` | 今天天气怎么样？ | 非日程（nonEvent） |

## 重新生成（macOS）

```bash
say -v "Eddy (中文（中国大陆）)" -o 01-multi.aiff "明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告。"
ffmpeg -y -i 01-multi.aiff -ar 16000 -ac 1 -c:a pcm_s16le asr-multi-event.wav
```

注意：必须用带语言后缀的完整声音名（`-v Eddy` 会命中歧义声音，产出 16ms 空音频）。
