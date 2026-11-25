// What the scenarios here share: the test board, the site served from docs/,
// the organizer's program, and pages in a browser with no window.
//
//   go build -o /tmp/p2p-call . && go build -o /tmp/testboard ./scripts/testboard
//   P2P_BIN=/tmp/p2p-call BOARD_BIN=/tmp/testboard node scripts/try/link.cjs
//
// Playwright is taken from wherever PLAYWRIGHT points (a node_modules/playwright).
// Nothing here touches the real notice board: its daily allowance is small.
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const root = path.join(__dirname, '..', '..');
const BOARD = 'http://localhost:8794', SITE = 'http://localhost:8000/';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
let failed = 0;

// The program keeps its key in a folder of its own here, not in the real one:
// a scenario must not touch the organizer's real link or their list of removed.
const home = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'p2p-try-'));

function run(cmd, args, onLine) {
  const kid = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: home, P2P_NO_OPEN: '1' } });
  kids.push(kid);
  for (const s of [kid.stdout, kid.stderr]) {
    let rest = '';
    s.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) onLine && onLine(l);
    });
  }
  return kid;
}

const startBoard = async () => { run(process.env.BOARD_BIN, ['-port', '8794']); await sleep(500); };
const startSite = async () => { run('python3', ['-m', 'http.server', '8000', '--bind', '127.0.0.1', '--directory', 'docs']); await sleep(1200); };

// The organizer's program, with a link but no tunnel: resolves to { host, link, lines }.
function startProgram(extra = []) {
  return new Promise((done, fail) => {
    const lines = [];
    let host = '', link = '';
    const kid = run(process.env.P2P_BIN, ['-tunnel', 'self', '-site', SITE, '-relay', BOARD, '-no-browser', '-port', '8765', ...extra], (l) => {
      lines.push(l);
      const h = /http:\/\/localhost:\d+\/\?host=\w+/.exec(l), k = /http:\/\/localhost:8000\/#\S+/.exec(l);
      if (h) host = h[0];
      if (k) link = k[0];
      if (host && link) done({ host, link, lines, kid });
    });
    setTimeout(() => fail(new Error('the program did not start:\n' + lines.join('\n'))), 15000);
  });
}

let browser = null;
async function page(name, url, opts = {}) {
  if (!browser) browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await ctx.addInitScript(([board, spare]) => {
    if (location.hostname !== 'localhost') return;
    sessionStorage.setItem('sm.board', board);
    if (spare) sessionStorage.setItem('sm.spare', spare);
  }, [opts.board || BOARD, opts.spare || '']);
  const p = await ctx.newPage();
  p.label = name;
  p.on('pageerror', (e) => { log(name, 'PAGE ERROR', e.message); failed++; });
  if (opts.console) p.on('console', (m) => log(name, 'console:', m.text()));
  await p.goto(url);
  return p;
}

// Through the link's page (if that is where the url leads) and into the call.
async function enter(p, name) {
  await p.waitForSelector('#name');
  if (await p.locator('#joinBtn').count() === 0) {
    await p.fill('#name', name);
    await p.waitForSelector('#enter:not([hidden])', { timeout: 15000 });
    await p.click('#enter');
    await p.waitForSelector('#joinBtn', { timeout: 15000 });
  } else {
    await p.fill('#name', name);
  }
  await p.click('#joinBtn');
  await p.waitForSelector('#callScreen:not([hidden])', { timeout: 20000 });
}

async function meshed(pages, ms = 40000) {
  const until = Date.now() + ms;
  let states = [];
  while (Date.now() < until) {
    states = await Promise.all(pages.map((p) => p.evaluate(() => [...state.peers.values()].map((x) => x.pc.connectionState))));
    if (states.every((s) => s.length === pages.length - 1 && s.every((c) => c === 'connected'))) return true;
    await sleep(1000);
  }
  log('connections:', JSON.stringify(states));
  return false;
}

// Sound really arriving from everyone, on every page.
async function hears(pages) {
  await sleep(2500);
  let ok = true;
  for (const p of pages) {
    const got = await p.evaluate(async () => {
      const out = [];
      for (const peer of state.peers.values()) {
        let bytes = 0;
        (await peer.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
        out.push([peer.info.name, bytes]);
      }
      return out;
    });
    if (!got.every(([, b]) => b > 2000)) ok = false;
    log(' ', p.label, 'hears', got.map(([n, b]) => `${n}: ${b}`).join(', '));
  }
  return ok;
}

function check(what, ok) {
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) failed++;
}

async function finish() {
  if (browser) await browser.close().catch(() => {});
  for (const k of kids) k.kill();
  log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
}

module.exports = { BOARD, SITE, log, sleep, run, startBoard, startSite, startProgram, page, enter, meshed, hears, check, finish };
