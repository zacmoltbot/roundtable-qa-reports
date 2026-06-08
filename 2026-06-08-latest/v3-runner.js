#!/usr/bin/env node
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SHOTS = path.join(ROOT, 'screenshots');
const AUDIO = path.join(ROOT, 'audio');
const EVIDENCE = path.join(ROOT, 'evidence');
const TMP = path.join(ROOT, 'tmp');
const WAV = path.resolve(ROOT, '../roundtable-qa-fixtures/mandarin-stt-sleep-test.wav');
const TARGET = 'https://doppel-health.zeabur.app/group';
const topic = '我最近晚上睡不好，半夜常常醒來，想請專家提供改善睡眠的建議。';
const RUN_NAME = process.env.RUN_NAME || 'full';
const PHASE = process.env.PHASE || 'all';

for (const dir of [SHOTS, AUDIO, EVIDENCE, TMP]) fs.mkdirSync(dir, { recursive: true });

const out = {
  started: new Date().toISOString(),
  environment: {},
  checkpoints: [],
  timings: [],
  observations: {},
  sttResponses: [],
  audioResponses: [],
  engineeringEvents: { console: [], pageErrors: [], failedRequests: [], responses: [] },
  errors: []
};

function checkpoint(name, detail = {}) {
  out.checkpoints.push({ at: new Date().toISOString(), name, ...detail });
  fs.writeFileSync(path.join(EVIDENCE, `browser-run-${RUN_NAME}-partial.json`), JSON.stringify(out, null, 2));
}

function elapsed(start) {
  return Math.round((performance.now() - start) * 10) / 10;
}

async function snap(page, name, fullPage = true) {
  const p = path.join(SHOTS, name);
  await page.screenshot({ path: p, fullPage });
  checkpoint(`screenshot:${name}`);
}

async function bodyState(page) {
  return page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText,
    buttons: [...document.querySelectorAll('button')].map((b, i) => ({
      i, text: b.innerText.trim(), aria: b.getAttribute('aria-label'), disabled: b.disabled, className: b.className
    })),
    inputs: [...document.querySelectorAll('input,textarea')].map((e, i) => ({
      i, tag: e.tagName, value: e.value, placeholder: e.placeholder, aria: e.getAttribute('aria-label')
    }))
  }));
}

async function clickButtonText(page, text) {
  const b = page.getByRole('button', { name: new RegExp(text) }).first();
  await b.click();
}

async function waitBodyIncludes(page, text, timeout = 60000) {
  await page.waitForFunction(t => document.body.innerText.includes(t), text, { timeout });
}

async function waitBodyChange(page, previous, timeout = 60000) {
  await page.waitForFunction(p => document.body.innerText !== p, previous, { timeout });
}

async function acceptConsent(page) {
  const accept = page.getByRole('button', { name: /我已閱讀並同意/ });
  if (await accept.count()) await accept.click();
}

async function setTextArea(page, value) {
  const textarea = page.locator('textarea').first();
  await textarea.fill(value);
}

async function homepageTextMode(page) {
  await page.getByRole('button', { name: '文字輸入' }).click();
  await page.locator('textarea').waitFor({ state: 'visible' });
}

async function clickActiveMic(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find(b =>
      b.textContent.includes('點擊停止') ||
      String(b.className).includes('rt-mic') ||
      b.getAttribute('aria-label') === '語音輸入' ||
      b.getAttribute('aria-label') === '停止錄音'
    ) || buttons.find(b => !b.getAttribute('aria-label') && !b.textContent.trim());
    if (!button) return false;
    button.click();
    return true;
  });
}

async function submitCustomTopic(page) {
  await homepageTextMode(page);
  await setTextArea(page, topic);
  const start = performance.now();
  await page.getByRole('button', { name: '尋找專家' }).click();
  await waitBodyIncludes(page, '開始討論', 90000);
  return elapsed(start);
}

async function firstVisit(page, run) {
  await page.context().clearCookies();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.evaluate(() => localStorage.clear());
  const navStart = performance.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitBodyIncludes(page, '熱門話題', 60000);
  const meaningful = elapsed(navStart);
  const consentStart = performance.now();
  await waitBodyIncludes(page, '我已閱讀並同意本服務不具診斷功能', 60000);
  const consent = elapsed(consentStart);
  const accept = page.getByRole('button', { name: /我已閱讀並同意/ });
  const usable = await accept.isEnabled();
  out.timings.push({ area: 'Initial page', run, definition: 'Begin navigation -> first meaningful content visible', ms: meaningful, verified: true });
  out.timings.push({ area: 'Consent', run, definition: 'Begin navigation -> consent modal visible/readable/action usable', ms: meaningful + consent, verified: usable });
  if (run === 1) {
    out.observations.firstVisit = await bodyState(page);
    await snap(page, '01-first-visit-consent.png');
  }
  const homeStart = performance.now();
  await accept.click();
  await page.getByRole('button', { name: '文字輸入' }).waitFor({ state: 'visible', timeout: 30000 });
  out.timings.push({ area: 'Home readiness', run, definition: 'Consent accept -> topic cards and voice/text controls visible and usable', ms: elapsed(homeStart), verified: true });
  if (run === 1) await snap(page, '02-home-ready.png');
}

async function testHomepageStt(page) {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await acceptConsent(page);
  const mic = page.getByRole('button', { name: '語音輸入' }).first();
  const start = performance.now();
  await mic.click();
  await waitBodyIncludes(page, '點擊停止', 15000);
  out.timings.push({ area: 'Homepage mic', run: 1, definition: 'Mic click -> recording state visibly active', ms: elapsed(start), verified: true });
  await snap(page, '03-home-mic-recording.png');
  await page.waitForTimeout(11500);
  const beforeStop = await bodyState(page);
  const stopStart = performance.now();
  const stopped = await clickActiveMic(page);
  out.observations.homepageMicStopControl = {
    manualStopClicked: stopped,
    note: stopped ? 'Active mic control clicked.' : 'Recording control had already disappeared before the manual stop attempt; continued waiting for the STT outcome.'
  };
  let outcome = 'NO_TRANSCRIPT_OR_ROUTE';
  try {
    await Promise.race([
      page.waitForURL(/\/group\/select/, { timeout: 90000 }),
      page.waitForFunction(t => document.body.innerText.includes(t), '改善睡眠', { timeout: 90000 })
    ]);
    outcome = page.url().includes('/select') ? 'ROUTED_TO_EXPERT_SELECTION' : 'TRANSCRIPT_VISIBLE';
  } catch (e) {
    out.errors.push({ phase: 'homepage-stt-wait', message: e.message });
  }
  const afterStop = await bodyState(page);
  let submittedToRecommendations = false;
  if (outcome === 'TRANSCRIPT_VISIBLE') {
    const findExperts = page.getByRole('button', { name: '尋找專家' });
    if (await findExperts.count()) {
      await findExperts.click();
      try {
        await waitBodyIncludes(page, '開始討論', 90000);
        submittedToRecommendations = true;
      } catch (e) {
        out.errors.push({ phase: 'homepage-stt-submit', message: e.message });
      }
    }
  }
  out.timings.push({
    area: 'Homepage STT',
    run: 1,
    definition: 'Mic stop click -> transcript visible or expert-selection flow reached',
    ms: elapsed(stopStart),
    verified: outcome !== 'NO_TRANSCRIPT_OR_ROUTE',
    outcome
  });
  out.observations.homepageStt = { beforeStop, afterStop, outcome, submittedToRecommendations, submittedState: submittedToRecommendations ? await bodyState(page) : null };
  await snap(page, '04-home-stt-outcome.png');
  checkpoint('homepage-stt-complete', { outcome });
}

async function testCustomFlow(page) {
  const customRuns = [];
  for (let run = 1; run <= 3; run++) {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await acceptConsent(page);
    const ms = await submitCustomTopic(page);
    customRuns.push(ms);
    out.timings.push({ area: 'Custom topic', run, definition: 'Find experts click -> recommendations, scores, and reasons visible', ms, verified: true });
    if (run === 1) {
      out.observations.expertSelection = await bodyState(page);
      await snap(page, '05-expert-recommendations.png');
      const selectedBefore = await page.locator('button[aria-label^="返回 "]').count();
      const remove = page.locator('button[aria-label^="返回 "]').first();
      await remove.click();
      await page.waitForTimeout(500);
      const selectedAfterRemove = await page.locator('button[aria-label^="返回 "]').count();
      const card = page.getByText('宋艾倫', { exact: true }).last();
      if (await card.count()) await card.click({ force: true });
      await page.waitForTimeout(800);
      const selectedAfterAdd = await page.locator('button[aria-label^="返回 "]').count();
      out.observations.manualSelection = { selectedBefore, selectedAfterRemove, selectedAfterAdd, state: await bodyState(page) };
      await snap(page, '06-manual-expert-selection.png');
      const chatStart = performance.now();
      await clickButtonText(page, '開始討論');
      await page.waitForURL(/\/group\/chat/, { timeout: 90000 });
      await page.getByRole('button', { name: '文字輸入' }).waitFor({ state: 'visible', timeout: 60000 });
      out.timings.push({ area: 'Start discussion', run: 1, definition: 'Start discussion click -> chat topic and controls visible/usable', ms: elapsed(chatStart), verified: true });
      out.observations.chatInitial = await bodyState(page);
      await snap(page, '07-custom-topic-chat.png');
      await testChat(page);
    }
  }
  checkpoint('custom-flow-complete', { runs: customRuns });
}

async function testChat(page) {
  await page.waitForTimeout(5000);
  const stateBefore = await bodyState(page);

  const summaryStart = performance.now();
  await page.getByRole('button', { name: '對話總結' }).click();
  await page.waitForTimeout(1000);
  const summaryState = await bodyState(page);
  out.timings.push({ area: 'Early summary', run: 1, definition: 'Summary click -> usable summary state visible', ms: elapsed(summaryStart), verified: summaryState.text !== stateBefore.text });
  out.observations.earlySummary = summaryState;
  await snap(page, '08-early-summary.png');
  const closeSummary = page.getByRole('button', { name: /關閉|返回/ }).last();
  if (await closeSummary.count()) await closeSummary.click();
  await page.waitForTimeout(500);

  const summaryResume = page.getByRole('button', { name: '繼續' });
  if (await summaryResume.count()) {
    await summaryResume.click();
    await page.getByRole('button', { name: '暫停' }).waitFor({ state: 'visible', timeout: 15000 });
  }

  const pause = page.getByRole('button', { name: '暫停' });
  if (await pause.count()) {
    const pauseStart = performance.now();
    await pause.click();
    await page.getByRole('button', { name: '繼續' }).waitFor({ state: 'visible', timeout: 15000 });
    out.timings.push({ area: 'Pause UI', run: 1, definition: 'Pause click -> paused UI visible', ms: elapsed(pauseStart), verified: true, audibleStopVerified: false });
    await snap(page, '09-paused-ui.png');
    const resumeStart = performance.now();
    await page.getByRole('button', { name: '繼續' }).click();
    await page.getByRole('button', { name: '暫停' }).waitFor({ state: 'visible', timeout: 15000 });
    out.timings.push({ area: 'Resume UI', run: 1, definition: 'Resume click -> resumed UI visible', ms: elapsed(resumeStart), verified: true, audibleResumeVerified: false });
    await snap(page, '10-resumed-ui.png');
  }

  const textInputButton = page.getByRole('button', { name: '文字輸入' });
  await textInputButton.click();
  const textarea = page.locator('textarea, input[placeholder="輸入訊息"]').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  const question = '我半夜常常醒來，白天也很累，請給我三個今晚可以開始做的改善睡眠建議。';
  await textarea.fill(question);
  const priorText = (await bodyState(page)).text;
  const sendStart = performance.now();
  const audioBeforeSend = out.audioResponses.length;
  const send = page.getByRole('button', { name: /傳送|送出/ }).last();
  if (await send.count()) await send.click();
  else await textarea.press('Enter');
  let textReplyVisible = false;
  try {
    await waitBodyChange(page, priorText, 90000);
    for (let i = 0; i < 45 && out.audioResponses.length <= audioBeforeSend; i++) await page.waitForTimeout(1000);
    textReplyVisible = out.audioResponses.length > audioBeforeSend;
  } catch (e) {
    out.errors.push({ phase: 'text-reply', message: e.message });
  }
  const afterText = await bodyState(page);
  out.timings.push({ area: 'Text interjection', run: 1, definition: 'Send click -> relevant expert reply text visible', ms: elapsed(sendStart), verified: textReplyVisible });
  out.observations.textInterjection = { question, before: priorText, after: afterText };
  await snap(page, '11-text-interjection-outcome.png');

  const chatMic = page.locator('button.rt-mic').first();
  if (await chatMic.count()) {
    const micStart = performance.now();
    await chatMic.click();
    await page.waitForTimeout(1000);
    const recording = await bodyState(page);
    const recordingVisible = recording.buttons.some(b => String(b.className).includes('recording'));
    out.timings.push({ area: 'Chat mic', run: 1, definition: 'Chat mic click -> recording state visible', ms: elapsed(micStart), verified: recordingVisible });
    await snap(page, '12-chat-mic-recording.png');
    await page.waitForTimeout(4000);
    const stopStart = performance.now();
    const stopped = await clickActiveMic(page);
    if (!stopped) throw new Error('Chat active mic control not found when stopping');
    let chatSttOutcome = false;
    try {
      await waitBodyChange(page, recording.text, 90000);
      await page.waitForTimeout(7000);
      chatSttOutcome = true;
    } catch (e) {
      out.errors.push({ phase: 'chat-stt-wait', message: e.message });
    }
    const chatSttState = await bodyState(page);
    out.timings.push({ area: 'Chat mic reply', run: 1, definition: 'Mic stop click -> relevant reply text visible', ms: elapsed(stopStart), verified: chatSttOutcome });
    out.observations.chatStt = { recording, recordingVisible, outcome: chatSttState, changed: chatSttOutcome };
    await snap(page, '13-chat-stt-outcome.png');

    await page.waitForTimeout(1500);
    const repeatStart = performance.now();
    await page.locator('button.rt-mic').first().click();
    await page.waitForTimeout(1000);
    const repeatRecording = await bodyState(page);
    await page.waitForTimeout(4000);
    const repeatAudioBefore = out.audioResponses.length;
    const repeatSttBefore = out.sttResponses.length;
    const repeatStopped = await clickActiveMic(page);
    for (let i = 0; i < 45 && out.audioResponses.length <= repeatAudioBefore && out.sttResponses.length <= repeatSttBefore; i++) await page.waitForTimeout(1000);
    out.observations.chatSttRepeat = {
      recordingVisible: repeatRecording.buttons.some(b => String(b.className).includes('recording')),
      repeatStopped,
      elapsedMs: elapsed(repeatStart),
      sttResponseAdded: out.sttResponses.length > repeatSttBefore,
      audioResponseAdded: out.audioResponses.length > repeatAudioBefore,
      state: await bodyState(page)
    };
    await snap(page, '13b-chat-stt-repeat-outcome.png');
  }

  await page.waitForTimeout(30000);
  await page.getByRole('button', { name: '對話總結' }).click();
  await page.waitForTimeout(2000);
  out.observations.fullSummaryAttempt = await bodyState(page);
  await snap(page, '14-full-summary-attempt.png');
  const close = page.getByRole('button', { name: /關閉|返回/ }).last();
  if (await close.count()) await close.click();
  await page.waitForTimeout(500);

  const back = page.getByRole('button', { name: '返回' }).first();
  await back.click();
  await page.waitForTimeout(800);
  out.observations.backConfirm = await bodyState(page);
  await snap(page, '15-back-confirm.png');
  const cancel = page.getByRole('button', { name: /取消|繼續討論/ }).first();
  if (await cancel.count()) await cancel.click();
  await page.waitForTimeout(600);
  out.observations.afterBackCancel = await bodyState(page);
  checkpoint('chat-flow-complete');
}

async function testHotTopic(page) {
  for (let run = 1; run <= 3; run++) {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await acceptConsent(page);
    const before = await bodyState(page);
    const start = performance.now();
    await page.getByText('睡眠品質，可能比睡眠時間更重要？', { exact: true }).click();
    await page.waitForURL(/\/group\/chat/, { timeout: 90000 });
    await page.getByRole('button', { name: '文字輸入' }).waitFor({ state: 'visible', timeout: 60000 });
    out.timings.push({ area: 'Hot topic', run, definition: 'Hot-topic click -> chat topic and controls visible/usable', ms: elapsed(start), verified: true });
    if (run === 1) {
      out.observations.hotTopic = { before, after: await bodyState(page) };
      await snap(page, '16-hot-topic-chat.png');
    }
  }
  checkpoint('hot-topic-complete');
}

async function testMobile(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await acceptConsent(page);
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > innerWidth,
    text: document.body.innerText,
    controls: [...document.querySelectorAll('button')].map(b => ({ aria: b.getAttribute('aria-label'), text: b.innerText.trim(), rect: b.getBoundingClientRect().toJSON() }))
  }));
  out.observations.mobile = mobile;
  await snap(page, '17-mobile-home.png', true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  checkpoint('mobile-complete', { overflow: mobile.overflow });
}

(async () => {
  const context = await chromium.launchPersistentContext(path.join(TMP, `profile-${RUN_NAME}`), {
    executablePath: '/usr/bin/chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    permissions: ['microphone'],
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}`,
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  out.environment = {
    chromium: await context.browser().version(),
    fixture: WAV,
    fixtureExists: fs.existsSync(WAV),
    viewport: '1440x1000 and 390x844'
  };
  const page = context.pages()[0] || await context.newPage();
  page.on('console', m => out.engineeringEvents.console.push({ at: new Date().toISOString(), type: m.type(), text: m.text() }));
  page.on('pageerror', e => out.engineeringEvents.pageErrors.push({ at: new Date().toISOString(), message: e.message }));
  page.on('requestfailed', r => out.engineeringEvents.failedRequests.push({ at: new Date().toISOString(), url: r.url(), reason: r.failure()?.errorText }));
  page.on('response', async r => {
    const type = (r.headers()['content-type'] || '').toLowerCase();
    const url = r.url();
    if (out.engineeringEvents.responses.length < 500) out.engineeringEvents.responses.push({ status: r.status(), type, url });
    if (/\/api\/stt(?:\?|$)/i.test(url)) {
      try {
        out.sttResponses.push({ at: new Date().toISOString(), url, status: r.status(), body: await r.text() });
        checkpoint('stt-response', { status: r.status() });
      } catch (e) {
        out.errors.push({ phase: 'stt-response-save', url, message: e.message });
      }
    }
    if (type.startsWith('audio/') || /\/api\/tts(?:\?|$)/i.test(url)) {
      try {
        const body = await r.body();
        const ext = type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : type.includes('ogg') ? 'ogg' : 'bin';
        const name = `${String(out.audioResponses.length + 1).padStart(2, '0')}-${r.status()}.${ext}`;
        fs.writeFileSync(path.join(AUDIO, name), body);
        out.audioResponses.push({ at: new Date().toISOString(), url, status: r.status(), contentType: type, bytes: body.length, file: `audio/${name}` });
        checkpoint(`audio-response:${name}`, { bytes: body.length, type });
      } catch (e) {
        out.errors.push({ phase: 'audio-response-save', url, message: e.message });
      }
    }
  });

  try {
    checkpoint('browser-started', { phase: PHASE });
    if (PHASE === 'all') {
      for (let run = 1; run <= 3; run++) await firstVisit(page, run);
      checkpoint('first-visit-runs-complete');
      await testHomepageStt(page);
    }
    if (PHASE === 'stt-home') await testHomepageStt(page);
    if (PHASE === 'stt-home') {
      checkpoint('stt-home-only-complete');
      return;
    }
    await testCustomFlow(page);
    await testHotTopic(page);
    await testMobile(page);
  } catch (e) {
    out.errors.push({ phase: 'top-level', message: e.stack || e.message });
    checkpoint('top-level-error', { message: e.message });
  } finally {
    out.finished = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE, `browser-run-${RUN_NAME}.json`), JSON.stringify(out, null, 2));
    await context.close();
  }
})();
