#!/usr/bin/env node
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  for (const p of [
    '/mnt/scratch/tmp/opencode/pw/node_modules',
    '/mnt/pid2/node_modules',
  ]) {
    try { ({ chromium } = require(require.resolve('playwright-core', { paths: [p] }))); break; } catch {}
  }
}
if (!chromium) {
  console.error('playwright-core not found. Set NODE_PATH or install it.');
  process.exit(1);
}
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHROMIUM = process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium';
const MAIL_API = (process.env.MAIL_API || 'https://thmail.malasahjago.workers.dev').replace(/\/$/, '');
const DOMAIN = process.env.EMAIL_DOMAIN || 'leluhurcy.us.ci';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID || '';
const STATE_DIR = path.join(__dirname, 'state');
const OUT_DIR = path.join(__dirname, 'accounts');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function rand(n = 5) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { res, text, json };
  } finally { clearTimeout(t); }
}

function extractVerifyLink(raw) {
  const decoded = raw
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=');
  const m = decoded.match(/https:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9._\-]+/);
  if (m) return m[0];
  const m2 = raw.match(/https:\/\/tokenharbor\.ai\/verify-email\?token=[^\s"'<>\\)]+/);
  return m2 ? m2[0].replace(/=\r?\n/g, '').replace(/=3D/gi, '=') : null;
}

async function getKeys() {
  const { json } = await fetchJson(MAIL_API + '/');
  return (json && json.keys) || [];
}

async function waitForNewVerifyEmail(baselineSet, toEmail, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const keys = await getKeys().catch(() => []);
    const newKeys = keys.filter(k => !baselineSet.has(k));
    // check newest first
    for (const k of [...newKeys].reverse()) {
      const { json } = await fetchJson(`${MAIL_API}/read?key=${encodeURIComponent(k)}`).catch(() => ({}));
      if (!json) continue;
      const to = (json.to || '').toLowerCase();
      const subj = (json.subject || '').toLowerCase();
      if (to.includes(toEmail.toLowerCase()) && subj.includes('verify')) {
        const link = extractVerifyLink(json.raw || '');
        if (link) return { key: k, link, mail: json };
      }
      // also accept if only one new and matches domain/user part roughly
      if (newKeys.length === 1 && to.includes(toEmail.split('@')[0].toLowerCase())) {
        const link = extractVerifyLink(json.raw || '');
        if (link) return { key: k, link, mail: json };
      }
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for verification email for ' + toEmail);
}

async function clickFirstVisible(page, selectors, { timeout = 2000 } = {}) {
  for (const sel of selectors) {
    try {
      if (sel.role) {
        const loc = page.getByRole(sel.role, { name: sel.name, exact: !!sel.exact }).first();
        if (await loc.count().catch(()=>0)) {
          if (await loc.isVisible().catch(()=>false)) {
            await loc.click({ force: true, timeout }).catch(()=>{});
            return sel.name || sel.role;
          }
        }
      } else {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(()=>0)) {
          if (await loc.isVisible().catch(()=>false)) {
            await loc.click({ force: true, timeout }).catch(()=>{});
            return sel;
          }
        }
      }
    } catch {}
  }
  return null;
}

async function postDiscord(content) {
  try {
    if (DISCORD_WEBHOOK) {
      await fetch(DISCORD_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
      return true;
    }
    if (DISCORD_TOKEN && DISCORD_CHANNEL) {
      await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return true;
    }
  } catch (e) { console.error('discord post failed:', e.message); }
  return false;
}

async function main() {
  const prefix = process.env.EMAIL_PREFIX || ('annt' + rand(4));
  const email = `${prefix}@${DOMAIN}`;
  const password = process.env.PASSWORD || ('Th' + crypto.randomBytes(12).toString('base64url') + '!9A');
  const keyLabel = process.env.KEY_LABEL || 'opencode';

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const statePath = path.join(STATE_DIR, `${prefix}.state.json`);
  const outPath = path.join(OUT_DIR, `${prefix}.json`);

  console.log('[+] Creating account:', email);
  const baseline = new Set(await getKeys().catch(() => []));

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    // 1) Signup
    await page.goto('https://tokenharbor.ai/login?mode=signup', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name=email]', { timeout: 30000 });
    await clickFirstVisible(page, [
      { role: 'button', name: 'Accept all' },
      { role: 'button', name: 'Essential only' },
    ]);
    const cb = page.locator('input[type=checkbox]').first();
    if (await cb.count()) await cb.check({ force: true }).catch(() => {});
    await page.locator('input[name=email]').fill(email);
    await page.locator('input[name=password]').fill(password);
    const invite = page.locator('input[name=invite_code]');
    if (await invite.count()) await invite.fill('').catch(() => {});

    const respP = page.waitForResponse(r => r.url().includes('/login') && r.request().method() === 'POST', { timeout: 30000 }).catch(() => null);
    await clickFirstVisible(page, [
      { role: 'button', name: 'Create account', exact: true },
      'form button[type=submit]',
    ]);
    const resp = await respP;
    console.log('[+] signup status:', resp ? resp.status() : 'no-post');
    await page.waitForURL('**/dashboard**', { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    await context.storageState({ path: statePath });
    console.log('[+] on:', page.url());

    // 2) Wait for verification email & verify in parallel-friendly way
    console.log('[+] waiting for verification email...');
    const { link, key: mailKey } = await waitForNewVerifyEmail(baseline, email, { timeoutMs: 120000, intervalMs: 2000 });
    console.log('[+] verify email key:', mailKey);

    // Open verify link in same authenticated context
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    console.log('[+] after verify:', page.url());
    await context.storageState({ path: statePath });

    // 3) Enable free models + create key
    await page.goto('https://tokenharbor.ai/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await clickFirstVisible(page, [
      { role: 'button', name: 'Enable free models' },
      { role: 'button', name: 'Enable free routes' },
      { role: 'button', name: 'Enable' },
      { role: 'button', name: 'I agree' },
      { role: 'button', name: 'Accept' },
    ]);
    await sleep(800);

    // Navigate to API key page
    const apiLink = page.getByRole('link', { name: 'API Key', exact: false }).first();
    if (await apiLink.count()) await apiLink.click({ force: true }).catch(() => {});
    else {
      const apiBtn = page.getByText('API Key', { exact: false }).first();
      if (await apiBtn.count()) await apiBtn.click({ force: true }).catch(() => {});
    }
    await sleep(1500);

    // Open new key dialog
    await clickFirstVisible(page, [
      { role: 'button', name: 'New key' },
      { role: 'button', name: 'Create API key' },
      { role: 'button', name: 'Create key' },
    ]);
    await sleep(800);

    // Fill label and create
    const inputs = page.locator('input:visible');
    if (await inputs.count()) {
      await inputs.last().fill(keyLabel).catch(() => {});
    }
    await clickFirstVisible(page, [
      { role: 'button', name: 'Create key', exact: true },
      { role: 'button', name: 'Create', exact: true },
      { role: 'button', name: 'Generate' },
    ]);
    await sleep(2500);

    // Extract key
    let apiKey = null;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const m = bodyText.match(/thk_(?:live|test)_[A-Za-z0-9_\-]+/g);
    if (m) {
      apiKey = m.find(k => k.length > 20) || m[0];
    }
    if (!apiKey) {
      // try dom values
      const vals = await page.evaluate(() => Array.from(document.querySelectorAll('input,code,pre,textarea')).map(e => e.value || e.innerText || '').join('\n'));
      const m2 = vals.match(/thk_(?:live|test)_[A-Za-z0-9_\-]+/g);
      if (m2) apiKey = m2.find(k => k.length > 20) || m2[0];
    }
    if (!apiKey) {
      await page.screenshot({ path: path.join(STATE_DIR, `${prefix}-nokey.png`), fullPage: true });
      throw new Error('Could not extract API key (see screenshot)');
    }

    const result = { email, password, api_key: apiKey, key_label: keyLabel, mail_key: mailKey, created_at: new Date().toISOString() };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    await context.storageState({ path: statePath });
    console.log('[+] API key:', apiKey);
    console.log('[+] saved:', outPath);

    // 4) Verify key quickly
    try {
      const { text } = await fetchJson('https://tokenharbor.ai/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } }, 15000);
      console.log('[+] /v1/models ok:', text.slice(0, 60));
    } catch (e) { console.log('[!] key test failed:', e.message); }

    // 5) Post to Discord if configured
    const msg = `Token Harbor account created\nEmail: ${email}\nAPI key: \`${apiKey}\``;
    await postDiscord(msg);

    console.log(JSON.stringify({ ok: true, email, api_key: apiKey, out: outPath }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[x]', e.stack || e.message);
  process.exit(1);
});
