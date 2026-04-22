import puppeteer from 'puppeteer';
import { config } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

config({ override: true });

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');
const CAPTURE_DIR = path.join(__dirname, '..', 'api-capture');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

const wait = (seconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, seconds * 1000));

async function captureApiCalls() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu',
      '--ignore-certificate-errors', '--no-proxy-server'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1024 });

  const apiCalls: any[] = [];

  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    const method = request.method();
    const headers = request.headers();
    const postData = request.postData();

    if (!url.includes('.png') && !url.includes('.jpg') && !url.includes('.css') &&
        !url.includes('.woff') && !url.includes('.svg') && !url.includes('google') &&
        !url.includes('analytics') && !url.includes('facebook')) {
      apiCalls.push({
        timestamp: new Date().toISOString(),
        type: 'REQUEST',
        method,
        url,
        headers: { ...headers },
        postData: postData || null
      });
    }
    request.continue();
  });

  page.on('response', async response => {
    const url = response.url();
    const status = response.status();

    if (url.includes('/api/') || url.includes('/portal/') || url.includes('/auth/') ||
        url.includes('kundenportal') || url.includes('/graphql') || url.includes('/rest/')) {
      let body = null;
      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('json') || contentType.includes('text')) {
          body = await response.text();
        }
      } catch {}

      apiCalls.push({
        timestamp: new Date().toISOString(),
        type: 'RESPONSE',
        status,
        url,
        body: body?.substring(0, 5000) || null
      });
    }
  });

  console.log('=== STEP 1: Navigate to portal ===');
  await page.goto('https://www.alditalk-kundenportal.de/portal/auth/uebersicht/', {
    waitUntil: 'networkidle2', timeout: 60000
  });

  console.log('=== STEP 2: Accept cookies ===');
  await wait(10);
  try {
    await page.locator('::-p-aria([name="Akzeptieren"][role="button"])').setTimeout(10000).click();
    console.log('Cookies accepted');
    await wait(3);
  } catch {
    console.log('No cookie banner');
  }

  console.log('=== STEP 3: Login ===');
  const { USERNAME, PASSWORD } = process.env;
  await page.locator('::-p-aria([name="Rufnummer"])').setTimeout(15000).fill(USERNAME!);
  await wait(2);
  await page.locator('::-p-aria([name="Passwort"])').setTimeout(15000).fill(PASSWORD!);
  await wait(2);

  // Check "Angemeldet bleiben"
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      const isChecked = await page.evaluate(el => (el as HTMLInputElement).checked, checkbox);
      if (!isChecked) {
        await checkbox.click();
        console.log('Checked "Angemeldet bleiben"');
      }
    }
  } catch {
    console.log('Could not find checkbox');
  }

  // Click login
  const elements = await page.$$('button, one-button, [role="button"]');
  for (const el of elements) {
    const text = await page.evaluate(e => (e.textContent || '').trim(), el);
    if (text === 'Anmelden') {
      await el.click();
      console.log('Login clicked');
      break;
    }
  }

  await wait(10);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'api-01-logged-in.png'), fullPage: true });

  // Accept cookies again if needed
  try {
    await page.locator('::-p-aria([name="Akzeptieren"][role="button"])').setTimeout(5000).click();
    await wait(3);
  } catch {}

  console.log('=== STEP 4: Capture current page state ===');
  await wait(10);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'api-02-dashboard.png'), fullPage: true });

  // Get all cookies and localStorage
  const cookies = await page.cookies();
  const localStorage = await page.evaluate(() => {
    const items: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) items[key] = window.localStorage.getItem(key) || '';
    }
    return items;
  });

  const sessionStorage = await page.evaluate(() => {
    const items: Record<string, string> = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key) items[key] = window.sessionStorage.getItem(key) || '';
    }
    return items;
  });

  console.log('=== STEP 5: Clear API log and click +1 GB ===');
  const preClickCalls = [...apiCalls];
  apiCalls.length = 0;

  // Find and click the +1 GB button
  const buttons = await page.$$('one-button[slot="action"]');
  let clicked = false;
  for (const button of buttons) {
    try {
      const textContent = await button.$eval('one-text', el => el.textContent?.trim());
      if (textContent === '1 GB') {
        await button.click();
        console.log('+1 GB button clicked!');
        clicked = true;
        break;
      }
    } catch { continue; }
  }

  if (!clicked) {
    console.log('Could not find +1 GB button');
  }

  await wait(5);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'api-03-after-1gb-click.png'), fullPage: true });

  // Dump the popup/dialog content
  const popupContent = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return body.substring(0, 3000);
  });
  console.log('Page content after +1 GB click:\n' + popupContent);

  // Dump all interactive elements with their positions
  const interactiveEls = await page.evaluate(() => {
    const results: string[] = [];
    const collect = (root: Document | ShadowRoot, prefix: string) => {
      const els = root.querySelectorAll('button, [role="button"], one-button, a, input, select');
      els.forEach(el => {
        const text = (el.textContent || '').trim().substring(0, 100);
        const rect = (el as HTMLElement).getBoundingClientRect();
        const tag = el.tagName;
        const type = el.getAttribute('type') || '';
        const name = el.getAttribute('name') || '';
        const aria = el.getAttribute('aria-label') || '';
        if (rect.width > 0 && rect.height > 0) {
          results.push(`${prefix}[${tag}${type ? ' type=' + type : ''}${name ? ' name=' + name : ''}${aria ? ' aria=' + aria : ''}] "${text}" at (${Math.round(rect.x)},${Math.round(rect.y)})`);
        }
      });
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          collect(el.shadowRoot, prefix + '  shadow>');
        }
      });
    };
    collect(document, '');
    return results;
  });
  console.log('\nAll interactive elements:\n' + interactiveEls.join('\n'));

  // Save all captured data
  fs.writeFileSync(path.join(CAPTURE_DIR, 'pre-click-api-calls.json'), JSON.stringify(preClickCalls, null, 2));
  fs.writeFileSync(path.join(CAPTURE_DIR, 'post-click-api-calls.json'), JSON.stringify(apiCalls, null, 2));
  fs.writeFileSync(path.join(CAPTURE_DIR, 'cookies.json'), JSON.stringify(cookies, null, 2));
  fs.writeFileSync(path.join(CAPTURE_DIR, 'localStorage.json'), JSON.stringify(localStorage, null, 2));
  fs.writeFileSync(path.join(CAPTURE_DIR, 'sessionStorage.json'), JSON.stringify(sessionStorage, null, 2));

  console.log('\n=== API calls after +1 GB click ===');
  for (const call of apiCalls) {
    if (call.type === 'REQUEST') {
      console.log(`${call.method} ${call.url}`);
      if (call.postData) console.log(`  Body: ${call.postData.substring(0, 500)}`);
    } else {
      console.log(`  -> ${call.status} ${call.url}`);
      if (call.body) console.log(`  Response: ${call.body.substring(0, 500)}`);
    }
  }

  await browser.close();
  console.log('\n=== Capture complete. Files saved to', CAPTURE_DIR, '===');
}

captureApiCalls().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
