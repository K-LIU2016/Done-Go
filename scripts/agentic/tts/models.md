# W11 tts · 离线中文 TTS 模型台账

安装位置：`asr-lab/models/tts/<模型名>/`（模型二进制不入库；本文件是来源与校验和的唯一凭证）。
安装命令：`node scripts/agentic/tts/download-model.mjs`（下载 → SHA256 校验，不过即删 → 解包 → 删 tarball）。

## vits-piper-zh_CN-xiao_ya-medium-int8（当前默认）

- **来源 URL**：<https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2>
- **SHA256**：`eab027e194e70289233cf12308373611fa4e2e96ef2d97354ef433ab663d831f`
- **tar.bz2 大小**：13,364,607 bytes（解包后 `zh_CN-xiao_ya-medium.onnx` 18,652,795 bytes，int8 量化）
- **语言/采样率**：zh_CN 单说话人（小雅），22,050 Hz（见包内 MODEL_CARD）
- **sherpa 配置形态**：vits + lexicon.txt + tokens.txt + ruleFsts(phone.fst,date.fst,number.fst)，由 `engine.mjs#discoverTtsConfig` 从目录文件名自动推断
- **许可注意**：训练数据 DataBaker BZNSYP 为非商业许可（MODEL_CARD 原文 "Non-commercial use"）；本项目用于内部预演示意产物（样张/预演片均叠加「示意」水印），不对外分发音频
- **校验命令**：`shasum -a 256 asr-lab/models/tts/…/zh_CN-xiao_ya-medium.onnx`（tar 包校验由 download-model.mjs 安装时自动执行并记录在上方 SHA256）

### 下载记录

| 日期 | 动作 | 结果 |
|---|---|---|
| 2026-10-26 | 首次下载（curl 直连 GitHub release）取 sha256；随后删除重装 dogfood：走自家 `downloadModel`（校验通过）+ `installTarball`，因本机 node fetch 不读 http_proxy 代理，注入 curl 透传的 fetch，实际取自镜像 `gh-proxy.com/<canonical-url>`，sha256 与上表逐字节一致 | 成功；真实合成冒烟见 evidence/s2d-w11-impl.md |

> 网络注意：本机直连 GitHub 需代理（`HTTPS_PROXY=http://127.0.0.1:7897`），而 Node 22 的 fetch 不读代理环境变量；重新安装时或设 `NODE_USE_ENV_PROXY=1`（实验性，本机实测不稳），或像下载记录那样注入 curl 透传的 fetch。模型装好后 TTS 全离线，不再需要网络。

<!-- 备选（同为 sherpa-onnx 2.0.0 可加载的中文 TTS，未安装）：
     vits-zh-hf-fanchen-C.tar.bz2（119MB，fp32）
     matcha-icefall-zh-en.tar.bz2（79MB，zh+en）
     切换时在 download-model.mjs#DEFAULT_MODELS 同步 url/sha256，并在此追加一行。 -->
