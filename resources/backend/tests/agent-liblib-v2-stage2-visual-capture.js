'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TARGET = 'http://127.0.0.1:3128/smart-canvas-core/smart-canvas.html?id=agent-stage2-fixture-canvas';
const OUTPUT_ROOT = path.resolve(__dirname, '../../../outputs/liblib-agent-stage2-visual-20260824');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function capture(page, theme) {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await page.evaluate(value => {
    localStorage.setItem('studio_theme', value);
    localStorage.setItem('canvas_theme', value);
  }, theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#smartAgentToggle').click();
  await page.locator('.smart-agent-skill-card').first().click();
  await page.locator('#smartAgentChatComposer').waitFor({ state: 'visible' });
  await page.evaluate(() => window.scrollTo(0, 0));

  const geometry = await page.evaluate(() => {
    const toRect = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        x: Math.round(value.x * 100) / 100,
        y: Math.round(value.y * 100) / 100,
        width: Math.round(value.width * 100) / 100,
        height: Math.round(value.height * 100) / 100,
        right: Math.round(value.right * 100) / 100,
        bottom: Math.round(value.bottom * 100) / 100
      };
    };
    const drawer = document.querySelector('#smartAgentDrawer');
    const composer = document.querySelector('#smartAgentChatComposer');
    const conversation = document.querySelector('#smartAgentConversation');
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      drawer: toRect(drawer),
      drawerShare: Math.round((drawer.getBoundingClientRect().width / innerWidth) * 10000) / 10000,
      conversation: toRect(conversation),
      composer: toRect(composer),
      composerVisible: getComputedStyle(composer).display !== 'none',
      textareaEnabled: !document.querySelector('#smartAgentQuestionInput').disabled,
      htmlTheme: document.documentElement.className
    };
  });

  const targetPath = path.join(OUTPUT_ROOT, `stage2-${theme}-software-100-2560x1440.png`);
  await page.screenshot({ path: targetPath });
  return { theme, targetPath, geometry };
}

(async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await context.newPage();
  const consoleErrors = [];
  const networkErrors = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', request => networkErrors.push(`FAILED ${request.url()}`));

  try {
    const captures = [];
    captures.push(await capture(page, 'light'));
    captures.push(await capture(page, 'dark'));
    const report = { success: true, captures, consoleErrors, networkErrors: [...new Set(networkErrors)] };
    fs.writeFileSync(path.join(OUTPUT_ROOT, 'stage2-visual-measurements.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
