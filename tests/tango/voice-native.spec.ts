import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as waitForAudioPlayback } from 'node:timers/promises';

test('spoken audio passes through browser capture and native recognition into a task', async ({ playwright, request }, info) => {
  test.skip(process.platform !== 'win32' || info.project.name !== 'desktop', 'Windows native audio integration, shared by both viewport variants');
  test.setTimeout(45000);
  const config = await (await request.get('/api/speech')).json();
  test.skip(!config.available || !config.languages.includes('zh-CN'), 'Chinese Windows recognizer not installed');
  const file = info.outputPath('spoken-event.wav');
  // Wait for capture initialization before speaking, as a person waits for 在听.
  const synthesize = 'Add-Type -AssemblyName System.Speech; $s=[System.Speech.Synthesis.SpeechSynthesizer]::new(); try { $v=$s.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -eq "zh-CN"} | Select-Object -First 1; $s.SelectVoice($v.VoiceInfo.Name); $f=[System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile($env:TANGO_TEST_AUDIO,$f); $s.SpeakSsml(\'<speak xmlns="http://www.w3.org/2001/10/synthesis" version="1.0" xml:lang="zh-CN"><break time="1000ms"/>下午两点到三点开会<break time="2s"/></speak>\') } finally { $s.Dispose() }';
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', synthesize], { windowsHide: true, timeout: 10000, env: { ...process.env, TANGO_TEST_AUDIO: file } });
  const bytes = await readFile(file);
  const browser = await playwright.chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + file + '%noloop'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai', permissions: ['microphone'] });
    const page = await context.newPage();
    await page.route('https://**', route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('leubai.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', wake: 960, entries: [], trials: [], drafts: [], fw: {}, sound: false }));
      localStorage.setItem('leubai.llm.v1', JSON.stringify({ mode: 'off' }));
      localStorage.setItem('leubai.lang', 'zh');
    });
    await page.goto('http://localhost:5207/#today');
    const response = page.waitForResponse(response => response.url().includes('/api/speech/transcribe'), { timeout: 30000 });
    await page.locator('#mic').click();
    await expect(page.locator('#capStatus')).toContainText('在听');
    // Real audio rendering uses wall time, independently of a virtual browser clock.
    await waitForAudioPlayback(bytes.length / 32 + 1800);
    await expect(page.locator('#mic')).toHaveAttribute('aria-pressed', 'false', { timeout: 10000 });
    const result = await response;
    const capture = result.request().postDataBuffer()!;
    await writeFile(info.outputPath('captured-audio.wav'), capture);
    const data = await result.json();
    expect(result.status(), JSON.stringify(data)).toBe(200);
    expect(data.text).toMatch(/开会/);
    await expect(page.locator('.bubble')).toHaveCount(1);
    await expect(page.locator('.bubble')).toContainText('开会');
    await expect(page.locator('.draft')).toHaveCount(0);
    await expect(page.locator('#cap-text')).toHaveValue(/开会/);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('leubai.web.v1')!).entries)).toEqual([
      expect.objectContaining({ title: expect.stringContaining('开会'), start: '14:00', end: '15:00', prio: 3 }),
    ]);
    await page.screenshot({ path: info.outputPath('native-voice-result.png'), fullPage: true });
  } finally { await browser.close(); }
});
