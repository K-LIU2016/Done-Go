(function (root) {
  'use strict';
  function encodeWave(chunks, rate) {
    var length = chunks.reduce(function (n, part) { return n + part.length; }, 0);
    var pcm = new Float32Array(length), cursor = 0;
    chunks.forEach(function (part) { pcm.set(part, cursor); cursor += part.length; });
    var size = Math.min(480000, Math.floor(length * 16000 / rate)), bytes = new Uint8Array(44 + size * 2), view = new DataView(bytes.buffer);
    function label(offset, text) { for (var i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); }
    label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    label(36, 'data'); view.setUint32(40, size * 2, true);
    for (var i = 0; i < size; i++) {
      var from = Math.floor(i * rate / 16000), to = Math.max(from + 1, Math.floor((i + 1) * rate / 16000)), sum = 0;
      for (var j = from; j < Math.min(to, length); j++) sum += pcm[j];
      var value = Math.max(-1, Math.min(1, sum / (Math.min(to, length) - from)));
      view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }
  function normalizeTranscript(text) {
    return String(text).replace(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi, function (_, hour, minute, period) {
      return (period.toUpperCase() === 'PM' ? '下午' : '上午') + (Number(hour) === 12 && period.toUpperCase() === 'AM' ? 0 : Number(hour)) + ':' + (minute || '00');
    });
  }
  function createRecorder(onFinish, onReady) {
    var stream, context, source, processor, mute, chunks = [], timer, quiet, stopped = false, heard = false;
    function cleanup() {
      clearTimeout(timer); clearTimeout(quiet);
      if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
      if (source) source.disconnect(); if (mute) mute.disconnect();
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      if (context && context.state !== 'closed') context.close().catch(function () {});
    }
    function stop(cancel) {
      if (stopped) return;
      stopped = true;
      var audio = cancel ? null : encodeWave(chunks, context ? context.sampleRate : 16000);
      cleanup(); if (!cancel) onFinish(audio);
    }
    return {
      start: async function () {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
          if (stopped) { cleanup(); return; }
          var Audio = root.AudioContext || root.webkitAudioContext;
          context = new Audio({ sampleRate: 16000 }); await context.resume();
          if (stopped) { cleanup(); return; }
          source = context.createMediaStreamSource(stream); processor = context.createScriptProcessor(4096, 1, 1); mute = context.createGain(); mute.gain.value = 0;
          processor.onaudioprocess = function (event) {
            if (stopped) return;
            var part = new Float32Array(event.inputBuffer.getChannelData(0));
            if (!chunks.length && onReady) onReady();
            chunks.push(part);
            var energy = 0; for (var i = 0; i < part.length; i++) energy += part[i] * part[i];
            if (Math.sqrt(energy / part.length) > .015) { heard = true; clearTimeout(quiet); quiet = setTimeout(function () { stop(false); }, 1600); }
          };
          source.connect(processor); processor.connect(mute); mute.connect(context.destination);
          timer = setTimeout(function () { stop(false); }, 30000);
          quiet = setTimeout(function () { if (!heard) stop(false); }, 8000);
        } catch (error) { stopped = true; cleanup(); throw error; }
      },
      stop: function () { stop(false); },
      cancel: function () { stop(true); }
    };
  }
  root.TangoSpeech = { encodeWave: encodeWave, normalizeTranscript: normalizeTranscript, createRecorder: createRecorder };
})(typeof window !== 'undefined' ? window : globalThis);
