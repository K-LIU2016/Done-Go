// W11 tts · 字幕时间戳纯函数：中文句切分 + 逐句时长累计 → [{text,startSec,endSec}]。
// 契约：composeReel 镜头切分与 web/agentic/reel 播放器字幕共用（BUILD-PLAN §3 W11.2/3）。
// 纯函数、无 IO；切句符 = 。！？； 与换行，保留句末标点，无句末标点的尾句独立成句。
const SENTENCE_RE = /[^。！？；\r\n]+[。！？；]?/g;

/** 按句切分：空串/纯空白 → []；句末标点跟随该句；尾句无标点也保留。 */
export function splitSentences(text) {
  if (!text) return [];
  return (String(text).match(SENTENCE_RE) ?? []).map(s => s.trim()).filter(Boolean);
}

/** 逐句时长累计成连续 cue：首句 startSec=0，下一句 start = 上一句 end；空输入 → []。 */
export function buildSubtitles(sentences) {
  let at = 0;
  return (sentences ?? []).map(({ text, durationSec }) => {
    const cue = { text, startSec: at, endSec: at + durationSec };
    at = cue.endSec;
    return cue;
  });
}
