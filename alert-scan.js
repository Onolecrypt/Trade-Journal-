// Signal alerts: runs on a schedule in GitHub Actions, applies the scanner's rules to fresh candles,
// and sends you a Telegram message when a live signal appears. It never places trades.
//
// Secrets (set in GitHub: Settings, Secrets and variables, Actions):
//   TWELVE_KEY         your Twelve Data key
//   TELEGRAM_TOKEN     the token BotFather gave your bot
//   TELEGRAM_CHAT_ID   your chat number
//   ALERT_BALANCE      optional, your account size, to include a lot size in the message
//   ALERT_RISK_PCT     optional, risk per trade in percent (default 1)
//
// Usage: node alert-scan.js            normal run
//        node alert-scan.js --test     only sends a test message
//        node alert-scan.js --dry      prints the messages instead of sending them
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./alert-engine.js');

const fmt = (sym, v) => v.toFixed(E.MARKETS[sym].dec);

function messageFor(r, cfg, env) {
  const sig = r.sig, buy = sig.dir > 0, live = sig.status === 'signal';
  const style = cfg.style === 'swing' ? 'Swing (4H trend, 1H entry)' : 'Intraday (1H trend, 15m entry)';
  const out = [];
  out.push((live ? (buy ? 'BUY SIGNAL: ' : 'SELL SIGNAL: ') : 'WATCH: ') + r.sym);
  out.push(style + (live ? ', grade ' + sig.score + ' of 10' : ''));
  out.push('');
  if (live) {
    out.push('Entry about ' + fmt(r.sym, sig.entry));
    out.push('Stop loss ' + fmt(r.sym, sig.sl));
    out.push('Target ' + fmt(r.sym, sig.tp) + ' (' + r.P.targetR + 'R)');
    const lot = E.lotCalc(r, { bal: env.ALERT_BALANCE, riskPct: env.ALERT_RISK_PCT || '1' });
    if (lot) out.push(lot.lots >= 0.01 ? 'Lot size ' + lot.lots.toFixed(2) + ' (risks about $' + lot.actual.toFixed(2) + ')' : 'Lot size: 0.01 lots already risks more than your limit');
  } else out.push(sig.why || 'A setup is forming.');
  out.push('Candle closed ' + E.when(r.to + E.MS[r.st.ltf]) + ' ' + E.TZ_NAME);
  if (r.gate && r.gate.lines.length) { out.push(''); r.gate.lines.forEach(l => out.push(l)); }
  out.push('');
  out.push(live ? 'Valid for about one candle. Check the news and your own analysis first. This is not financial advice.' : 'No entry yet. This is not financial advice.');
  if (cfg.journalUrl) out.push(cfg.journalUrl);
  return out.join('\n');
}

async function telegram(env, text) {
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error('Telegram refused the message: ' + (data.description || 'HTTP ' + res.status));
}

async function main(opts = {}) {
  const argv = opts.argv || process.argv.slice(2), env = opts.env || process.env, dir = opts.dir || __dirname, log = opts.log || console.log;
  const test = argv.includes('--test'), dry = argv.includes('--dry'), now = opts.now || Date.now();
  const cfg = Object.assign({ markets: ['XAU/USD', 'EUR/USD'], style: 'swing', targetR: 2, minGrade: 0, alertOnWatch: false, journalUrl: '' },
    JSON.parse(fs.readFileSync(path.join(dir, 'alert-config.json'), 'utf8')));
  const statePath = path.join(dir, 'alert-state.json');
  const send = opts.send || (async text => { if (dry) log('[dry run] would send:\n' + text + '\n'); else await telegram(env, text); });

  if (!dry && !opts.send && (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID)) throw new Error('Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID. Add them as secrets under Settings, Secrets and variables, Actions.');
  if (test) { await send('Test message: your signal alerts are connected.\nWatching ' + cfg.markets.join(', ') + ' on the ' + cfg.style + ' style.'); return { sent: 1, test: true }; }
  if (!env.TWELVE_KEY) throw new Error('Missing TWELVE_KEY. Add your Twelve Data key as a secret.');
  if (!E.STYLES[cfg.style]) throw new Error('alert-config.json: style must be "swing" or "intraday".');

  let state = { sent: {} };
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch (e) {}
  const st = E.STYLES[cfg.style], ctx = await E.loadContext(() => {}, { proxy: '' });
  let sent = 0, failed = 0, scanned = 0;

  for (const sym of cfg.markets) {
    try {
      const lraw = await E.getCandles(sym, st.ltf, env.TWELVE_KEY, () => {}), hraw = await E.getCandles(sym, st.htf, env.TWELVE_KEY, () => {});
      const r = E.analyze(sym, lraw, hraw, { style: cfg.style, targetR: cfg.targetR }, now, ctx);
      scanned++;
      const status = r.sig.status, live = status === 'signal' && !r.stale;
      if (r.stale) { log(sym + ': the last candle is old, the market looks closed.'); continue; }
      if (!live && !(cfg.alertOnWatch && status === 'watch')) { log(sym + ': ' + (status === 'watch' ? 'watch' : 'no trade') + (r.sig.why ? ' (' + r.sig.why + ')' : '')); continue; }
      if (live && r.sig.score < cfg.minGrade) { log(sym + ': signal below your minimum grade (' + r.sig.score + ' of 10).'); continue; }
      const key = [sym, r.to, status, r.sig.dir].join('|');
      if (state.sent[sym] === key) { log(sym + ': already sent for this candle.'); continue; }
      await send(messageFor(r, cfg, env));
      state.sent[sym] = key; sent++;
      log(sym + ': ' + (live ? 'signal sent.' : 'watch note sent.'));
    } catch (e) { failed++; log(sym + ': ' + e.message); if (/Telegram/.test(e.message)) throw e; }
  }
  if (!opts.noWrite) fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  if (!scanned && failed) throw new Error('Every market failed, so nothing was checked.');
  return { sent, scanned, failed };
}

module.exports = { main, messageFor };
if (require.main === module) main().then(r => console.log('Done:', JSON.stringify(r))).catch(e => { console.error(e.message); process.exit(1); });
