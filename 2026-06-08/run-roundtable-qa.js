const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { chromium } = require('playwright');

const reportDir = __dirname;
const screenshotDir = path.join(reportDir, 'screenshots');
const baseUrl = 'https://doppel-health.zeabur.app/group';
const origin = new URL(baseUrl).origin;
const startedAt = new Date().toISOString();

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[idx]);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function waitSoft(page, ms) {
  await page.waitForTimeout(ms);
}

async function clickFirst(page, candidates, timeout = 1200) {
  for (const candidate of candidates) {
    const locators = [
      page.getByRole('button', { name: candidate }),
      page.getByText(candidate, { exact: false }),
      page.locator(`button:has-text("${candidate}")`),
      page.locator(`a:has-text("${candidate}")`)
    ];
    for (const locator of locators) {
      try {
        const first = locator.first();
        if (await first.isVisible({ timeout })) {
          await first.click({ timeout: 3000 });
          return { clicked: true, label: String(candidate) };
        }
      } catch {}
    }
  }
  return { clicked: false };
}

async function firstVisible(locators, timeout = 1000) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      if (await first.isVisible({ timeout })) return first;
    } catch {}
  }
  return null;
}

async function capturePageState(page, label) {
  const state = await page.evaluate((stateLabel) => {
    const text = document.body ? document.body.innerText : '';
    const buttons = [...document.querySelectorAll('button')]
      .slice(0, 30)
      .map((el) => el.innerText || el.getAttribute('aria-label') || el.textContent || '')
      .filter(Boolean);
    const links = [...document.querySelectorAll('a')]
      .slice(0, 30)
      .map((el) => ({ text: el.innerText || el.textContent || '', href: el.href }));
    const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        aria: el.getAttribute('aria-label') || ''
      }));
    const videos = [...document.querySelectorAll('video')].map((el) => ({
      src: el.currentSrc || el.src || '',
      readyState: el.readyState,
      width: el.videoWidth,
      height: el.videoHeight
    }));
    const canvases = [...document.querySelectorAll('canvas')].map((el) => ({
      width: el.width,
      height: el.height,
      cssWidth: Math.round(el.getBoundingClientRect().width),
      cssHeight: Math.round(el.getBoundingClientRect().height)
    }));
    return {
      label: stateLabel,
      url: location.href,
      title: document.title,
      textSample: text.slice(0, 1600),
      textLength: text.length,
      buttons,
      links,
      inputs,
      videos,
      canvases,
      bodyHeight: document.body ? document.body.scrollHeight : 0,
      viewport: { width: innerWidth, height: innerHeight }
    };
  }, label);
  return state;
}

async function findPortalEntry(page) {
  await clickFirst(page, [/我已閱讀並同意|已閱讀|同意本服務|同意/i], 800);
  await waitSoft(page, 800);

  const directChat = page.locator('a[href*="/group/chat"]').first();
  try {
    if (await directChat.isVisible({ timeout: 1000 })) {
      const href = await directChat.getAttribute('href');
      await directChat.click();
      return { method: 'chat-link', href };
    }
  } catch {}

  await clickFirst(page, [/文字輸入|Text/i], 800);
  await waitSoft(page, 800);

  const topicInput = await firstVisible([
    page.locator('textarea'),
    page.locator('input:not([type="hidden"])'),
    page.locator('[contenteditable="true"]')
  ]);
  if (topicInput) {
    try {
      await topicInput.fill('我想聊睡眠品質與壓力調節');
    } catch {
      await topicInput.click();
      await page.keyboard.type('我想聊睡眠品質與壓力調節');
    }
    const clicked = await clickFirst(page, [/加入這場討論|加入|說出你的問題|開始|開始討論|進入|送出|送出主題|Start|Chat|聊天|討論/i]);
    if (clicked.clicked) return { method: 'topic-input', button: clicked.label };
  }

  const topicCandidate = page.locator('button, a, [role="button"]').filter({
    hasText: /加入這場討論|加入|睡眠|壓力|健康|醫療|熱門|話題|開始|Start|Chat|討論/i
  }).first();
  try {
    if (await topicCandidate.isVisible({ timeout: 1500 })) {
      const text = await topicCandidate.innerText().catch(() => '');
      await topicCandidate.click();
      return { method: 'topic-click', text };
    }
  } catch {}

  return { method: 'not-found' };
}

async function runJourney(browser, viewportName, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: viewportName === 'mobile' ? 2 : 1,
    isMobile: viewportName === 'mobile',
    hasTouch: viewportName === 'mobile',
    locale: 'zh-TW'
  });
  const page = await context.newPage();
  const consoleMessages = [];
  const networkFailures = [];
  const badResponses = [];
  const timings = {};

  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 500) });
    }
  });
  page.on('requestfailed', (req) => {
    networkFailures.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText || '' });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) badResponses.push({ url: res.url(), status });
  });

  const checks = [];
  const states = [];

  const navStart = performance.now();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  timings.domContentLoadedMs = Math.round(performance.now() - navStart);
  await waitSoft(page, 3000);
  timings.portalSettledMs = Math.round(performance.now() - navStart);
  await page.screenshot({ path: path.join(screenshotDir, `${viewportName}-portal.png`), fullPage: true });
  const portalState = await capturePageState(page, `${viewportName} portal`);
  states.push(portalState);
  checks.push({
    name: 'Portal page loads from /group',
    status: page.url().startsWith(baseUrl) ? 'PASS' : 'FAIL',
    detail: page.url()
  });
  checks.push({
    name: 'Portal has visible user-facing content',
    status: portalState.textLength > 100 ? 'PASS' : 'FAIL',
    detail: `${portalState.textLength} visible text chars`
  });
  checks.push({
    name: 'Scope stays out of /admin and /create',
    status: /\/(admin|create)(\/|$)/.test(page.url()) ? 'FAIL' : 'PASS',
    detail: page.url()
  });

  const entry = await findPortalEntry(page);
  await Promise.race([
    page.waitForURL((url) => url.href.includes('/group/chat'), { timeout: 12000 }).catch(() => null),
    page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null)
  ]);
  await waitSoft(page, 5000);
  await page.screenshot({ path: path.join(screenshotDir, `${viewportName}-chat.png`), fullPage: true });
  const chatState = await capturePageState(page, `${viewportName} chat`);
  states.push(chatState);
  checks.push({
    name: 'Portal can enter chat experience',
    status: page.url().includes('/group/chat') || /chat|聊天|對話|送出|輸入|summary|總結/i.test(chatState.textSample) ? 'PASS' : 'FAIL',
    detail: `${entry.method}; ${page.url()}`
  });
  checks.push({
    name: 'Chat view has an input affordance',
    status: chatState.inputs.length > 0 || /輸入|留言|送出|Send/i.test(chatState.textSample) ? 'PASS' : 'WARN',
    detail: `${chatState.inputs.length} input-like elements`
  });

  await clickFirst(page, [/文字輸入|Text/i], 800);
  await waitSoft(page, 1200);

  const chatInput = await firstVisible([
    page.locator('textarea'),
    page.locator('input:not([type="hidden"])'),
    page.locator('[contenteditable="true"]')
  ], 1800);
  let sendResult = { attempted: false };
  if (chatInput) {
    sendResult.attempted = true;
    try {
      await chatInput.fill('我最近睡眠品質不好，請給我一個簡短建議。');
    } catch {
      await chatInput.click();
      await page.keyboard.type('我最近睡眠品質不好，請給我一個簡短建議。');
    }
    const before = page.url();
    const sendClicked = await clickFirst(page, [/送出|傳送|Send|提交|發送|➤|→/i], 800);
    sendResult = { attempted: true, clicked: sendClicked.clicked, button: sendClicked.label || '', before };
    await waitSoft(page, sendClicked.clicked ? 12000 : 4000);
  }
  await page.screenshot({ path: path.join(screenshotDir, `${viewportName}-final.png`), fullPage: true });
  const finalState = await capturePageState(page, `${viewportName} final`);
  states.push(finalState);
  checks.push({
    name: 'User message send path is usable',
    status: sendResult.attempted && sendResult.clicked ? 'PASS' : (sendResult.attempted ? 'WARN' : 'FAIL'),
    detail: JSON.stringify(sendResult)
  });
  checks.push({
    name: 'No failed network requests during journey',
    status: networkFailures.length === 0 ? 'PASS' : 'WARN',
    detail: `${networkFailures.length} request failures`
  });
  checks.push({
    name: 'No HTTP 4xx/5xx responses during journey',
    status: badResponses.length === 0 ? 'PASS' : 'WARN',
    detail: `${badResponses.length} bad responses`
  });

  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
    return {
      navigation: nav ? {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        loadEventEnd: Math.round(nav.loadEventEnd),
        responseStart: Math.round(nav.responseStart),
        transferSize: nav.transferSize || 0
      } : null,
      paints
    };
  }).catch(() => null);

  await context.close();
  return {
    viewportName,
    viewport,
    startedAt,
    finishedAt: new Date().toISOString(),
    timings,
    performance: perf,
    checks,
    states,
    consoleMessages,
    networkFailures,
    badResponses,
    screenshots: {
      portal: `screenshots/${viewportName}-portal.png`,
      chat: `screenshots/${viewportName}-chat.png`,
      final: `screenshots/${viewportName}-final.png`
    }
  };
}

async function timedFetch(url) {
  const start = performance.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OpenClaw RoundTable QA probe' } });
    await res.arrayBuffer();
    return { url, status: res.status, ok: res.ok, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return { url, status: 0, ok: false, ms: Math.round(performance.now() - start), error: error.message };
  }
}

async function runHttpProbe() {
  const urls = [
    `${origin}/group`,
    `${origin}/api/theme-cards`,
    `${origin}/api/topic-chips`,
    `${origin}/api/ad-config`
  ];
  const levels = [1, 5, 10];
  const results = {};
  for (const url of urls) {
    results[url] = {};
    for (const concurrency of levels) {
      const batches = Array.from({ length: concurrency }, () => timedFetch(url));
      const requests = await Promise.all(batches);
      const latencies = requests.map((r) => r.ms);
      results[url][concurrency] = {
        concurrency,
        total: requests.length,
        ok: requests.filter((r) => r.ok).length,
        error: requests.filter((r) => !r.ok).length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: Math.max(...latencies),
        statuses: requests.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {}),
        requests
      };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return { startedAt, finishedAt: new Date().toISOString(), urls, levels, results };
}

function summarize(raw, httpProbe) {
  const checks = raw.viewports.flatMap((v) => v.checks);
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const warn = checks.filter((c) => c.status === 'WARN').length;
  const pass = checks.filter((c) => c.status === 'PASS').length;
  const httpErrors = Object.values(httpProbe.results).flatMap((byLevel) =>
    Object.values(byLevel).filter((r) => r.error > 0)
  );
  const networkWarns = raw.viewports.reduce((sum, v) => sum + v.networkFailures.length + v.badResponses.length, 0);
  return {
    verdict: fail > 0 ? 'FAIL' : (warn > 0 || httpErrors.length || networkWarns ? 'PASS_WITH_WARNINGS' : 'PASS'),
    pass,
    warn,
    fail,
    networkWarns,
    httpProbeWarnings: httpErrors.length
  };
}

function renderReport(raw, httpProbe) {
  const summary = summarize(raw, httpProbe);
  const checkRows = raw.viewports.flatMap((v) => v.checks.map((c) => ({ viewport: v.viewportName, ...c })));
  const httpRows = Object.entries(httpProbe.results).flatMap(([url, levels]) =>
    Object.values(levels).map((r) => ({ url, ...r }))
  );
  const statusClass = (status) => String(status).toLowerCase().replaceAll('_', '-');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RoundTable /group QA Report - ${escapeHtml(raw.finishedAt)}</title>
  <style>
    :root { --ink:#17202a; --muted:#5f6c7b; --line:#d9e1e8; --ok:#0f7a4f; --warn:#a45b00; --fail:#b42318; --bg:#f7f9fb; --panel:#ffffff; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 28px 36px 18px; background: #ffffff; border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    h3 { margin: 18px 0 8px; font-size: 15px; }
    main { padding: 24px 36px 44px; max-width: 1280px; }
    section { margin: 0 0 24px; }
    .meta, .note { color: var(--muted); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; min-height: 86px; }
    .metric strong { display: block; font-size: 24px; line-height: 1.1; }
    .badge { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 2px 10px; font-weight: 700; font-size: 12px; border: 1px solid currentColor; }
    .pass, .pass-with-warnings { color: var(--ok); }
    .warn { color: var(--warn); }
    .fail { color: var(--fail); }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-bottom: 1px solid var(--line); }
    th { background: #eef3f7; font-size: 12px; text-transform: uppercase; color: #3d4c5c; letter-spacing: .04em; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .screens { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    figcaption { padding: 8px 10px; color: var(--muted); border-bottom: 1px solid var(--line); }
    img { display: block; width: 100%; height: auto; }
    .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    pre { margin: 0; padding: 12px; overflow: auto; background: #101820; color: #edf5ff; border-radius: 8px; max-height: 260px; }
    @media (max-width: 900px) { header, main { padding-left: 18px; padding-right: 18px; } .grid, .screens, .two { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>RoundTable /group QA Report</h1>
    <div class="meta">Target: <code>${escapeHtml(raw.baseUrl)}</code> · Scope: ${escapeHtml(raw.scope)} · Run: ${escapeHtml(raw.startedAt)} → ${escapeHtml(raw.finishedAt)}</div>
  </header>
  <main>
    <section>
      <h2>Executive Summary</h2>
      <div class="grid">
        <div class="metric"><span class="badge ${statusClass(summary.verdict)}">${escapeHtml(summary.verdict)}</span><strong>${summary.pass}/${summary.pass + summary.warn + summary.fail}</strong><span class="meta">checks passed</span></div>
        <div class="metric"><strong>${summary.warn}</strong><span class="meta">warnings</span></div>
        <div class="metric"><strong>${summary.fail}</strong><span class="meta">failures</span></div>
        <div class="metric"><strong>${summary.networkWarns}</strong><span class="meta">journey network issues</span></div>
      </div>
      <p class="note">This rerun tests the real end-user path from <code>/group</code>. It excludes <code>/admin</code> and <code>/create</code>. The load probe only uses low-risk GET requests and does not stress the generative chat API.</p>
    </section>

    <section>
      <h2>Functional Checks</h2>
      <table>
        <thead><tr><th>Viewport</th><th>Status</th><th>Check</th><th>Evidence</th></tr></thead>
        <tbody>
          ${checkRows.map((row) => `<tr><td>${escapeHtml(row.viewport)}</td><td><span class="badge ${statusClass(row.status)}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.name)}</td><td><code>${escapeHtml(row.detail)}</code></td></tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Performance Probe</h2>
      <table>
        <thead><tr><th>Endpoint</th><th>Concurrency</th><th>OK</th><th>Error</th><th>P50</th><th>P95</th><th>Max</th><th>Status Codes</th></tr></thead>
        <tbody>
          ${httpRows.map((row) => `<tr><td><code>${escapeHtml(row.url)}</code></td><td>${row.concurrency}</td><td>${row.ok}/${row.total}</td><td>${row.error}</td><td>${row.p50} ms</td><td>${row.p95} ms</td><td>${row.max} ms</td><td><code>${escapeHtml(JSON.stringify(row.statuses))}</code></td></tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Screenshots</h2>
      ${raw.viewports.map((v) => `<h3>${escapeHtml(v.viewportName)} ${v.viewport.width}x${v.viewport.height}</h3><div class="screens">
        <figure><figcaption>Portal</figcaption><img src="${escapeHtml(v.screenshots.portal)}" alt="${escapeHtml(v.viewportName)} portal screenshot"></figure>
        <figure><figcaption>Chat</figcaption><img src="${escapeHtml(v.screenshots.chat)}" alt="${escapeHtml(v.viewportName)} chat screenshot"></figure>
        <figure><figcaption>Final</figcaption><img src="${escapeHtml(v.screenshots.final)}" alt="${escapeHtml(v.viewportName)} final screenshot"></figure>
      </div>`).join('')}
    </section>

    <section>
      <h2>Console / Network Notes</h2>
      <div class="two">
        ${raw.viewports.map((v) => `<div>
          <h3>${escapeHtml(v.viewportName)}</h3>
          <pre>${escapeHtml(JSON.stringify({
            consoleMessages: v.consoleMessages,
            networkFailures: v.networkFailures,
            badResponses: v.badResponses,
            timings: v.timings,
            performance: v.performance
          }, null, 2))}</pre>
        </div>`).join('')}
      </div>
    </section>

    <section>
      <h2>Artifacts</h2>
      <p class="note">Raw data: <code>raw-results.json</code> · HTTP probe: <code>http-concurrency.json</code> · Screenshots: <code>screenshots/</code></p>
    </section>
  </main>
</body>
</html>`;
}

(async () => {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const viewports = [];
  try {
    viewports.push(await runJourney(browser, 'desktop', { width: 1365, height: 768 }));
    viewports.push(await runJourney(browser, 'mobile', { width: 390, height: 844 }));
  } finally {
    await browser.close();
  }
  const httpProbe = await runHttpProbe();
  const raw = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl,
    scope: 'End-user /group portal only. Excludes /admin and /create.',
    viewports,
    summary: null
  };
  raw.summary = summarize(raw, httpProbe);
  fs.writeFileSync(path.join(reportDir, 'raw-results.json'), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(reportDir, 'http-concurrency.json'), JSON.stringify(httpProbe, null, 2));
  fs.writeFileSync(path.join(reportDir, 'index.html'), renderReport(raw, httpProbe));
  console.log(JSON.stringify({ reportDir, html: path.join(reportDir, 'index.html'), summary: raw.summary }, null, 2));
})();
