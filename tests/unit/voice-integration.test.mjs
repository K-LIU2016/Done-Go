import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const homeSource = readFileSync(new URL('../../web/relay/home.js', import.meta.url), 'utf8');
const voiceSheetSource = readFileSync(new URL('../../web/voice/voice-sheet.js', import.meta.url), 'utf8');
const voiceHomeSource = readFileSync(new URL('../../web/voice/voice-home.js', import.meta.url), 'utf8');
const bootSource = readFileSync(new URL('../../web/relay/boot.js', import.meta.url), 'utf8');

test('home mic branch opens the voice-lab capture/stream sheet in a browser document', () => {
  assert.match(homeSource, /createVoiceHomeSession/);
  assert.match(homeSource, /onComplete/);
  assert.match(homeSource, /onDismiss/);
});

test('voice sheet component and home orchestration own focus, audio and completion cleanup', () => {
  assert.match(voiceSheetSource, /createVoiceSheet/);
  assert.match(voiceSheetSource, /onDismiss/);
  assert.match(voiceSheetSource, /FOCUSABLE_SELECTOR/);
  assert.match(voiceSheetSource, /pointerdown/);
  assert.match(voiceHomeSource, /createVoiceCapture/);
  assert.match(voiceHomeSource, /createVoiceStream/);
  assert.match(voiceHomeSource, /onComplete/);
  assert.match(voiceHomeSource, /cleanup/);
});

test('home consumes the relay-home-next slot through next-up module', () => {
  assert.match(homeSource, /mountNextUp/);
  assert.match(homeSource, /relay-home-next/);
});
