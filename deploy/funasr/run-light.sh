#!/bin/bash
# Done-Go FunASR 2pass light stack — copied from Salon9 services/funasr/run-light.sh
# (2026-10-25, read-only source) then adapted for Done-Go per
# design/voice-intent/SPEC.md §2.1. Exactly three changes vs the Salon9 original:
#   1) port 10195 (Done-Go's own, Salon9 keeps 10095)
#   2) inference threads capped at 2 (container is cpus:2 / mem 1500m)
#   3) auto-download disabled: every model dir is passed explicitly (all present
#      under the READ-ONLY Salon9 models mount, so nothing can ever download;
#      --download-model-dir points at the ro mount and any attempted fetch fails)
# Original Salon9 header (kept for lineage):
#   Light FunASR 2pass stack for the 4C/7.4G ThinkPad host
#   (docs/ULW-ITERATION-2026-10-19.md): SenseVoiceSmall offline tier +
#   streaming paraformer + VAD + realtime punc, no ngram LM, plain ws
#   (asr-agent passes no TLS context). Kept as a mounted script because
#   compose $-escaping proved fragile across compose versions.
# Note: the Salon9 comment above says "SenseVoiceSmall offline tier", but the
# script's actual --model-dir is paraformer-large-onnx (verified against
# services/funasr/run-light.sh this session); this copy keeps the proven
# paraformer offline tier. SenseVoiceSmallOnnx remains available under
# /workspace/models/iic/ if the tier is ever switched (see VI report).
set -e
SCRIPT=$(find /workspace -name run_server_2pass.sh 2>/dev/null | head -1)
if [ -z "$SCRIPT" ]; then
  echo "[donego-funasr] run_server_2pass.sh not found under /workspace" >&2
  exit 1
fi
cd "$(dirname "$SCRIPT")"
bash run_server_2pass.sh \
  --download-model-dir /workspace/models \
  --model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx \
  --online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx \
  --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx \
  --punc-dir damo/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx \
  --itn-dir thuduj12/fst_itn_zh \
  --lm-dir "" \
  --decoder-thread-num 2 \
  --model-thread-num 1 \
  --io-thread-num 1 \
  --port 10195 \
  --certfile 0
sleep infinity
