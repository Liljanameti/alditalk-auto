import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { config } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

config({ override: true });
puppeteer.use(StealthPlugin());

const URLS = {
  ALDITALK_PORTAL: 'https://www.alditalk-kundenportal.de/portal/auth/uebersicht/'
} as const;

const TIMEOUTS = {
  COOKIE_WAIT: 10,
  SHORT_WAIT: 5,
  EXTEND_WAIT: 15,
  LOOP_INTERVAL: 15 * 60
} as const;

const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const wait = (seconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, seconds * 1000));

const takeScreenshot = async (page: Page, name: string): Promise<void> => {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`Screenshot: ${name}`);
  } catch (e) {
    console.error(`Screenshot failed ${name}:`, e);
  }
};

const createBrowser = async (): Promise<Browser> => {
  return await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--no-proxy-server',
      '--window-size=1080,1024'
    ]
  });
};

const waitForPageLoad = async (page: Page): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    const isLoaded = await page.evaluate(() => document.readyState === 'complete');
    if (isLoaded) {
      console.log('Page loaded');
      return;
    }
    await wait(1);
  }
  console.log('Page load timeout, continuing');
};

const acceptCookies = async (page: Page): Promise<void> => {
  await wait(TIMEOUTS.COOKIE_WAIT);

  // Method 1: Aria selector
  try {
    await page.locator('::-p-aria([name="Akzeptieren"][role="button"])').setTimeout(5000).click();
    console.log('Cookies accepted (aria)');
    await wait(3);
    return;
  } catch {}

  // Method 2: Find "Akzeptieren" button by text (handles Cookie-Einwilligung dialog)
  try {
    const elements = await page.$$('button, one-button, [role="button"]');
    for (const el of elements) {
      const text = await page.evaluate(e => (e.textContent || '').trim(), el);
      if (text === 'Akzeptieren') {
        await el.click();
        console.log('Cookies accepted (text match)');
        await wait(3);
        return;
      }
    }
  } catch {}

  // Method 3: Shadow DOM search
  try {
    const clicked = await page.evaluate(() => {
      const find = (root: Document | ShadowRoot): boolean => {
        const els = root.querySelectorAll('button, [role="button"]');
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (text === 'Akzeptieren') {
            (el as HTMLElement).click();
            return true;
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot && find(el.shadowRoot)) return true;
        }
        return false;
      };
      return find(document);
    });
    if (clicked) {
      console.log('Cookies accepted (shadow DOM)');
      await wait(3);
      return;
    }
  } catch {}

  console.log('No cookie banner found');
};

const performLogin = async (page: Page): Promise<void> => {
  const { USERNAME, PASSWORD } = process.env;
  if (!USERNAME || !PASSWORD) {
    throw new Error('Missing USERNAME or PASSWORD in .env');
  }

  console.log(`Logging in as ${USERNAME}`);

  await page.locator('::-p-aria([name="Rufnummer"])').setTimeout(15000).fill(USERNAME);
  await wait(2);
  await page.locator('::-p-aria([name="Passwort"])').setTimeout(15000).fill(PASSWORD);
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
  } catch {}

  // Click login button
  const elements = await page.$$('button, one-button, [role="button"]');
  let loginClicked = false;
  for (const el of elements) {
    const text = await page.evaluate(e => (e.textContent || '').trim(), el);
    if (text === 'Anmelden') {
      await el.click();
      loginClicked = true;
      console.log('Login button clicked');
      break;
    }
  }

  if (!loginClicked) {
    try {
      await page.locator('::-p-aria([name="Anmelden"][role="button"])').setTimeout(5000).click();
      console.log('Login clicked via aria');
    } catch {
      console.error('Could not click login button');
    }
  }

  await wait(TIMEOUTS.SHORT_WAIT);
};

const extendDataVolume = async (page: Page): Promise<boolean> => {
  await wait(TIMEOUTS.EXTEND_WAIT);
  await takeScreenshot(page, '04-before-extend');

  // Set up bot score monitoring
  let botOtpRequired: boolean | null = null;
  const responseHandler = async (response: any) => {
    const url = response.url();
    if (url.includes('validateBotScore')) {
      try {
        const body = await response.json();
        botOtpRequired = body.botProtectionOtpRequired;
        console.log(`Bot score check: otpRequired=${botOtpRequired}`);
      } catch {}
    }
    if (url.includes('bookOffer') || url.includes('book') || url.includes('extend') || url.includes('topup')) {
      try {
        const text = await response.text();
        console.log(`Booking API response (${response.status()}): ${text.substring(0, 500)}`);
      } catch {}
    }
  };
  page.on('response', responseHandler);

  // Find and click the +1 GB button
  const buttons = await page.$$('one-button[slot="action"]');
  let clicked = false;
  for (const button of buttons) {
    try {
      const textContent = await button.$eval('one-text', el => el.textContent?.trim());
      if (textContent === '1 GB') {
        await button.click();
        clicked = true;
        console.log('+1 GB button clicked');
        break;
      }
    } catch { continue; }
  }

  if (!clicked) {
    console.log('+1 GB button not found - may not be available yet');
    await takeScreenshot(page, '05-no-button');

    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    console.log('Page content:', pageText);

    page.off('response', responseHandler);
    return false;
  }

  await wait(5);
  await takeScreenshot(page, '05-after-1gb-click');

  if (botOtpRequired === true) {
    console.log('Bot protection OTP still required - stealth not sufficient');
    await takeScreenshot(page, '05-otp-popup');

    // Try closing the OTP dialog and using direct API
    const closeClicked = await page.evaluate(() => {
      const findClose = (root: Document | ShadowRoot): HTMLElement | null => {
        const candidates = root.querySelectorAll('button, [role="button"]');
        for (const el of candidates) {
          const aria = el.getAttribute('aria-label') || '';
          const text = (el.textContent || '').trim().toLowerCase();
          if (aria.toLowerCase().includes('schließen') || aria.toLowerCase().includes('close') || text === '×' || text === 'x') {
            return el as HTMLElement;
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = findClose(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      const btn = findClose(document);
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (closeClicked) {
      console.log('Closed OTP dialog');
      await wait(2);
    }

    page.off('response', responseHandler);
    return false;
  } else if (botOtpRequired === false) {
    console.log('Bot protection bypassed! No OTP required');
    await wait(5);
    await takeScreenshot(page, '06-booking-result');
    page.off('response', responseHandler);
    return true;
  } else {
    console.log('No validateBotScore response detected - checking page state');
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 800) || '');
    const hasOtp = pageText.toLowerCase().includes('otp') || pageText.toLowerCase().includes('verification code');
    if (hasOtp) {
      console.log('OTP dialog detected in page content');
      page.off('response', responseHandler);
      return false;
    }
    await takeScreenshot(page, '06-unknown-state');
    page.off('response', responseHandler);
    return true;
  }
};

const executeAutomation = async (): Promise<void> => {
  const browser = await createBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1024 });

    // Set realistic user agent and other headers
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    await page.goto(URLS.ALDITALK_PORTAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForPageLoad(page);
    await acceptCookies(page);
    await performLogin(page);
    await waitForPageLoad(page);
    await wait(5);
    await takeScreenshot(page, '03-after-login');

    // Handle cookie dialogs that may appear after login
    await acceptCookies(page);
    await acceptCookies(page);

    // Wait for dashboard data to load
    await wait(5);
    await takeScreenshot(page, '03b-dashboard-ready');

    const success = await extendDataVolume(page);
    if (success) {
      console.log('Data volume extension completed successfully!');
    } else {
      console.log('Data volume extension was not completed this cycle');
    }
  } finally {
    await browser.close();
  }
};

const startMainLoop = async (): Promise<void> => {
  while (true) {
    try {
      await executeAutomation();
    } catch (error) {
      console.error('Error in automation:', error);
    }

    console.log(`Waiting ${TIMEOUTS.LOOP_INTERVAL / 60} minutes before next check...`);
    await wait(TIMEOUTS.LOOP_INTERVAL);
  }
};

if (process.env.RUN_ONCE === '1') {
  executeAutomation()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
} else {
  startMainLoop().catch(error => {
    console.error('Fatal error:', error);
  });
}
