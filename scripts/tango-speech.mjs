import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./tango-speech.ps1', import.meta.url));
export const MAX_AUDIO_BYTES = 16000 * 2 * 30 + 4096;
let capabilities;
let active = false;

async function speechCommand(args, signal) {
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], {
    windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 16384, signal,
  });
  return JSON.parse(stdout.trim());
}

export function speechCapabilities() {
  if (!capabilities) capabilities = process.platform === 'win32'
    ? speechCommand(['-Mode', 'capabilities']).catch(() => ({ available: false, languages: [] }))
    : Promise.resolve({ available: false, languages: [] });
  return capabilities;
}

export function validSpeechWave(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > MAX_AUDIO_BYTES || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) !== audio.length - 8) return false;
  let format = false, data = false;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const kind = audio.toString('ascii', offset, offset + 4), size = audio.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > audio.length) return false;
    if (kind === 'fmt ') {
      if (size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 || audio.readUInt32LE(start + 4) !== 16000 || audio.readUInt32LE(start + 8) !== 32000 || audio.readUInt16LE(start + 12) !== 2 || audio.readUInt16LE(start + 14) !== 16) return false;
      format = true;
    }
    if (kind === 'data') { if (size < 2 || size % 2 || size > 16000 * 2 * 30) return false; data = true; }
    offset = start + size + (size % 2);
  }
  return format && data;
}

export async function transcribeSpeech(audio, language, signal) {
  if (!validSpeechWave(audio)) throw Object.assign(new Error('invalid-audio'), { status: 400 });
  const config = await speechCapabilities();
  if (!config.available || !config.languages.includes(language)) throw Object.assign(new Error('language-unavailable'), { status: 503 });
  if (active) throw Object.assign(new Error('speech-busy'), { status: 429 });
  active = true;
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'tango-speech-'));
    const file = join(directory, 'capture.wav');
    await writeFile(file, audio);
    const result = await speechCommand(['-Mode', 'transcribe', '-AudioPath', file, '-Language', language], signal);
    if (typeof result.text !== 'string') throw new Error('recognition-failed');
    return { text: result.text.slice(0, 600) };
  } finally {
    if (directory) {
      await unlink(join(directory, 'capture.wav')).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
    active = false;
  }
}
