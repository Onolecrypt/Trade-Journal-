// Signal alerts engine. This is the scanner's own rules and data code, packaged to run on a schedule in GitHub Actions.
// It is generated from scanner.html, so the alerts follow exactly the same rules you see in the app.
'use strict';
const localStorage = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })();
let VOLHIST = false;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MARKETS = {
  'XAU/USD': { name: 'Gold', spread: 0.30, dec: 2, perUnit: () => 100 },
  'EUR/USD': { name: 'Euro / Dollar', spread: 0.00012, dec: 5, perUnit: () => 100000 },
  'GBP/USD': { name: 'Pound / Dollar', spread: 0.00015, dec: 5, perUnit: () => 100000 },
  'USD/JPY': { name: 'Dollar / Yen', spread: 0.015, dec: 3, perUnit: e => 100000 / e }
};
const STYLES = { swing: { ltf: '1h', htf: '4h', htfLabel: '4H trend' }, intraday: { ltf: '15min', htf: '1h', htfLabel: '1H trend' } };
const MS = { '15min': 900000, '1h': 3600000, '4h': 14400000 };
// The data arrives in UTC, but every time you read here is shown in your own zone.
// East Africa Time (Uganda, Kenya, Tanzania) is UTC+3. Change both lines to show another zone.
const TZ_HOURS = 3, TZ_NAME = 'EAT';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shifted = ts => new Date(ts + TZ_HOURS * 3600000);
const clock = ts => shifted(ts).toISOString().slice(11, 16);
const when = ts => shifted(ts).toISOString().slice(0, 10) === shifted(Date.now()).toISOString().slice(0, 10) ? clock(ts) : DOW[shifted(ts).getUTCDay()] + ' ' + clock(ts);

/* ---------- indicators (all causal: a value at bar i uses only bars up to i) ---------- */
function EMA(v, p) {
  const out = new Array(v.length).fill(NaN);
  if (v.length < p) return out;
  let s = 0; for (let i = 0; i < p; i++) s += v[i];
  let e = s / p; out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function ATR(h, l, c, p) {
  const n = c.length, out = new Array(n).fill(NaN), tr = new Array(n);
  tr[0] = h[0] - l[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  if (n < p) return out;
  let a = 0; for (let i = 0; i < p; i++) a += tr[i];
  a /= p; out[p - 1] = a;
  for (let i = p; i < n; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
  return out;
}
function RSI(c, p) {
  const n = c.length, out = new Array(n).fill(NaN);
  if (n <= p) return out;
  let g = 0, ls = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; }
  g /= p; ls /= p;
  out[p] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls);
  for (let i = p + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p; ls = (ls * (p - 1) + (d < 0 ? -d : 0)) / p;
    out[i] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls);
  }
  return out;
}
function ADX(h, l, c, p) {
  const n = c.length, out = new Array(n).fill(NaN);
  if (n < 2 * p + 1) return out;
  const tr = [], pd = [], md = [];
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0);
  }
  let sT = 0, sP = 0, sM = 0;
  for (let i = 0; i < p; i++) { sT += tr[i]; sP += pd[i]; sM += md[i]; }
  const dx = [];
  const dxAt = () => { const a = 100 * sP / sT, b = 100 * sM / sT; return a + b === 0 ? 0 : 100 * Math.abs(a - b) / (a + b); };
  dx.push(dxAt());
  for (let i = p; i < tr.length; i++) {
    sT = sT - sT / p + tr[i]; sP = sP - sP / p + pd[i]; sM = sM - sM / p + md[i];
    dx.push(dxAt());
  }
  let adx = 0; for (let m = 0; m < p; m++) adx += dx[m];
  adx /= p; out[2 * p - 1] = adx;
  for (let m = p; m < dx.length; m++) { adx = (adx * (p - 1) + dx[m]) / p; out[p + m] = adx; }
  return out;
}

/* ---------- data prep ---------- */
function prepCandles(values, interval, now) {
  const ms = MS[interval];
  const rows = values.map(v => ({ t: Date.parse(String(v.datetime).replace(' ', 'T') + (String(v.datetime).length <= 10 ? 'T00:00:00Z' : 'Z')), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume || 0 }))
    .filter(r => isFinite(r.t) && isFinite(r.o) && isFinite(r.h) && isFinite(r.l) && isFinite(r.c))
    .sort((a, b) => a.t - b.t);
  while (rows.length && rows[rows.length - 1].t + ms > now) rows.pop();   // drop the candle that is still forming
  return rows;
}
function buildL(rows) {
  const t = rows.map(r => r.t), o = rows.map(r => r.o), h = rows.map(r => r.h), l = rows.map(r => r.l), c = rows.map(r => r.c);
  return { t, o, h, l, c, v: rows.map(r => r.v), e20: EMA(c, 20), e50: EMA(c, 50), rsi: RSI(c, 14), atr: ATR(h, l, c, 14) };
}
function buildH(rows) {
  const t = rows.map(r => r.t), h = rows.map(r => r.h), l = rows.map(r => r.l), c = rows.map(r => r.c);
  return { t, h, l, c, e50: EMA(c, 50), e200: EMA(c, 200), adx: ADX(h, l, c, 14) };
}
// for each lower-timeframe bar, the latest higher-timeframe bar that had already closed when it closed
function alignHtf(L, H, ltfMs, htfMs) {
  const out = new Array(L.t.length).fill(-1); let j = -1;
  for (let i = 0; i < L.t.length; i++) {
    const close = L.t[i] + ltfMs;
    while (j + 1 < H.t.length && H.t[j + 1] + htfMs <= close) j++;
    out[i] = j;
  }
  return out;
}

/* ---------- candlestick and chart patterns: confluence only, never a condition ---------- */
// Every pattern here is read from candles up to the one being judged. Swing points count only once three
// candles have passed on each side, so nothing is seen before it could really have been seen.
const GRADE_MAX = 12;
function swingPoints(L, i, k, look) {
  const hi = [], lo = [];
  for (let m = Math.max(k, i - look); m <= i - k; m++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(L.h[m] > L.h[m - j] && L.h[m] >= L.h[m + j])) isH = false;
      if (!(L.l[m] < L.l[m - j] && L.l[m] <= L.l[m + j])) isL = false;
    }
    if (isH) hi.push({ m, v: L.h[m] });
    if (isL) lo.push({ m, v: L.l[m] });
  }
  return { hi, lo };
}
function candlePatterns(L, i) {
  const out = [], { o, h, l, c } = L, A = L.atr[i];
  if (i < 3 || !(A > 0)) return out;
  const body = k => Math.abs(c[k] - o[k]), rng = k => h[k] - l[k], up = k => c[k] > o[k], dn = k => c[k] < o[k];
  const add = (dir, family, name, text, from, shape) => out.push({ kind: 'candle', dir, family, name, text, shape, prims: [{ t: 'span', i1: from, i2: i }] });
  if (up(i) && dn(i - 1) && c[i] >= o[i - 1] && o[i] <= c[i - 1] && body(i) > body(i - 1)) add(1, 'Engulfing', 'Bullish engulfing', 'a bullish engulfing candle', i - 1, 'reversal');
  if (dn(i) && up(i - 1) && c[i] <= o[i - 1] && o[i] >= c[i - 1] && body(i) > body(i - 1)) add(-1, 'Engulfing', 'Bearish engulfing', 'a bearish engulfing candle', i - 1, 'reversal');
  const R = rng(i);
  if (R >= 0.5 * A && (Math.min(o[i], c[i]) - l[i]) >= 2 * body(i) && (c[i] - l[i]) / R >= 0.6) add(1, 'Pin bar', 'Bullish pin bar', 'a bullish pin bar (hammer)', i, 'reversal');
  if (R >= 0.5 * A && (h[i] - Math.max(o[i], c[i])) >= 2 * body(i) && (h[i] - c[i]) / R >= 0.6) add(-1, 'Pin bar', 'Bearish pin bar', 'a bearish pin bar (shooting star)', i, 'reversal');
  if (dn(i - 2) && body(i - 2) >= 0.6 * A && body(i - 1) <= 0.3 * body(i - 2) && up(i) && body(i) >= 0.5 * A && c[i] > (o[i - 2] + c[i - 2]) / 2) add(1, 'Morning or evening star', 'Morning star', 'a morning star', i - 2, 'reversal');
  if (up(i - 2) && body(i - 2) >= 0.6 * A && body(i - 1) <= 0.3 * body(i - 2) && dn(i) && body(i) >= 0.5 * A && c[i] < (o[i - 2] + c[i - 2]) / 2) add(-1, 'Morning or evening star', 'Evening star', 'an evening star', i - 2, 'reversal');
  if (h[i - 1] < h[i - 2] && l[i - 1] > l[i - 2] && rng(i - 2) >= 0.8 * A) {
    if (up(i) && c[i] > h[i - 2]) add(1, 'Inside bar breakout', 'Inside bar breakout up', 'an inside bar breaking upward', i - 2, 'continuation');
    if (dn(i) && c[i] < l[i - 2]) add(-1, 'Inside bar breakout', 'Inside bar breakout down', 'an inside bar breaking downward', i - 2, 'continuation');
  }
  if (dn(i - 1) && up(i) && Math.abs(l[i] - l[i - 1]) <= 0.1 * A && body(i - 1) >= 0.2 * A && body(i) >= 0.2 * A) add(1, 'Tweezer', 'Tweezer bottom', 'a tweezer bottom', i - 1, 'reversal');
  if (up(i - 1) && dn(i) && Math.abs(h[i] - h[i - 1]) <= 0.1 * A && body(i - 1) >= 0.2 * A && body(i) >= 0.2 * A) add(-1, 'Tweezer', 'Tweezer top', 'a tweezer top', i - 1, 'reversal');
  return out;
}
function doublePattern(L, i, S, A) {
  const out = [], { c, h, l } = L;
  const test = (pts, dir) => {
    if (pts.length < 2) return;
    const b = pts[pts.length - 1], a = pts[pts.length - 2], gap = b.m - a.m;
    if (gap < 8 || gap > 80 || Math.abs(a.v - b.v) > 0.75 * A) return;
    let neck = dir > 0 ? -Infinity : Infinity;
    for (let k = a.m; k <= b.m; k++) neck = dir > 0 ? Math.max(neck, h[k]) : Math.min(neck, l[k]);
    if (dir > 0 ? neck < Math.max(a.v, b.v) + 1.5 * A : neck > Math.min(a.v, b.v) - 1.5 * A) return;
    let first = -1;
    for (let k = b.m + 1; k <= i; k++) if (dir > 0 ? c[k] > neck : c[k] < neck) { first = k; break; }
    if (first < 0 || i - first > 2) return;
    for (let k = b.m + 1; k <= i; k++) if (dir > 0 ? l[k] < Math.min(a.v, b.v) - 0.5 * A : h[k] > Math.max(a.v, b.v) + 0.5 * A) return;
    out.push({ kind: 'chart', dir, family: dir > 0 ? 'Double bottom' : 'Double top', name: dir > 0 ? 'Double bottom breakout' : 'Double top breakdown', shape: 'reversal',
      text: 'a double ' + (dir > 0 ? 'bottom breaking above' : 'top breaking below') + ' {L}', level: neck,
      prims: [{ t: 'pt', i: a.m, v: a.v }, { t: 'pt', i: b.m, v: b.v }, { t: 'line', i1: a.m, v1: neck, i2: i, v2: neck }] });
  };
  test(S.lo, 1); test(S.hi, -1);
  return out;
}
function headShouldersPattern(L, i, S, A) {
  const out = [], { c, h, l } = L;
  const test = (pts, dir) => {
    if (pts.length < 3) return;
    const top = dir < 0, C = pts[pts.length - 1], B = pts[pts.length - 2], Aa = pts[pts.length - 3];
    const head = top ? B.v - Math.max(Aa.v, C.v) : Math.min(Aa.v, C.v) - B.v;
    if (head < A || Math.abs(Aa.v - C.v) > A || B.m - Aa.m < 4 || C.m - B.m < 4 || C.m - Aa.m > 120) return;
    const trough = (m1, m2) => { let best = null; for (let k = m1; k <= m2; k++) { const v = top ? l[k] : h[k]; if (!best || (top ? v < best.v : v > best.v)) best = { m: k, v }; } return best; };
    const T1 = trough(Aa.m, B.m), T2 = trough(B.m, C.m);
    if (T2.m <= T1.m) return;
    const slope = (T2.v - T1.v) / (T2.m - T1.m), neck = k => T1.v + slope * (k - T1.m);
    let first = -1;
    for (let k = C.m + 1; k <= i; k++) if (top ? c[k] < neck(k) : c[k] > neck(k)) { first = k; break; }
    if (first < 0 || i - first > 2) return;
    out.push({ kind: 'chart', dir, family: top ? 'Head and shoulders' : 'Inverse head and shoulders', name: top ? 'Head and shoulders breakdown' : 'Inverse head and shoulders breakout', shape: 'reversal',
      text: top ? 'a head and shoulders breaking below its neckline' : 'an inverse head and shoulders breaking above its neckline', level: null,
      prims: [{ t: 'pt', i: Aa.m, v: Aa.v }, { t: 'pt', i: B.m, v: B.v }, { t: 'pt', i: C.m, v: C.v }, { t: 'line', i1: T1.m, v1: T1.v, i2: i, v2: neck(i) }] });
  };
  test(S.hi, -1); test(S.lo, 1);
  return out;
}
function flagPattern(L, i, A) {
  const { o, h, l, c } = L, out = [];
  const slopeOf = (arr, s, b) => { const n = b - s; let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let k = s; k < b; k++) { const x = k - s; sx += x; sy += arr[k]; sxy += x * arr[k]; sxx += x * x; } return (n * sxy - sx * sy) / (n * sxx - sx * sx); };
  for (const dir of [1, -1]) {
    let found = null;
    for (let b = i; b >= i - 2 && !found; b--) {
      for (let w = 5; w <= 20 && !found; w++) {
        const s = b - w;
        if (s - 12 < 0) continue;
        let ch = -Infinity, cl = Infinity, ph = -Infinity, pl = Infinity, ih = -1, il = -1;
        for (let k = s; k < b; k++) { ch = Math.max(ch, h[k]); cl = Math.min(cl, l[k]); }
        for (let k = s - 12; k < s; k++) { if (h[k] > ph) { ph = h[k]; ih = k; } if (l[k] < pl) { pl = l[k]; il = k; } }
        const pole = ph - pl;
        if (pole < 3 * A) continue;
        if (dir > 0) {
          if (!(il < ih) || s - ih > 3 || ph - cl > 0.5 * pole || ch > ph + 0.5 * A || ch - cl > 0.6 * pole) continue;
          if (!(c[b] > ch && c[b] > o[b]) || slopeOf(h, s, b) > 0) continue;
          found = { level: ch, pole: { t: 'line', i1: il, v1: pl, i2: ih, v2: ph }, box: { t: 'box', i1: s, i2: b - 1, hi: ch, lo: cl } };
        } else {
          if (!(ih < il) || s - il > 3 || ch - pl > 0.5 * pole || cl < pl - 0.5 * A || ch - cl > 0.6 * pole) continue;
          if (!(c[b] < cl && c[b] < o[b]) || slopeOf(l, s, b) < 0) continue;
          found = { level: cl, pole: { t: 'line', i1: ih, v1: ph, i2: il, v2: pl }, box: { t: 'box', i1: s, i2: b - 1, hi: ch, lo: cl } };
        }
      }
    }
    if (found) out.push({ kind: 'chart', dir, family: 'Flag or pennant', name: dir > 0 ? 'Bull flag breakout' : 'Bear flag breakdown', shape: 'continuation',
      text: 'a ' + (dir > 0 ? 'bull flag breaking above' : 'bear flag breaking below') + ' {L}', level: found.level, prims: [found.pole, found.box] });
  }
  return out;
}
function trianglePattern(L, i, S, A) {
  const { c } = L, win = 70, hs = S.hi.filter(p => p.m >= i - win), ls = S.lo.filter(p => p.m >= i - win);
  if (hs.length < 2 || ls.length < 2) return [];
  const h1 = hs[0], h2 = hs[hs.length - 1], l1 = ls[0], l2 = ls[ls.length - 1];
  if (h2.m - h1.m < 8 || l2.m - l1.m < 8) return [];
  const sH = (h2.v - h1.v) / (h2.m - h1.m), sL = (l2.v - l1.v) / (l2.m - l1.m), flat = 0.02 * A, steep = 0.03 * A;
  let family = null;
  if (Math.abs(sH) <= flat && sL >= steep) family = 'Ascending triangle';
  else if (sH <= -steep && Math.abs(sL) <= flat) family = 'Descending triangle';
  else if (sH <= -steep && sL >= steep) family = 'Symmetrical triangle';
  if (!family) return [];
  const hiLine = k => h1.v + sH * (k - h1.m), loLine = k => l1.v + sL * (k - l1.m), m0 = Math.min(h1.m, l1.m);
  const w0 = hiLine(m0) - loLine(m0), w1 = hiLine(i) - loLine(i);
  if (!(w0 > 0) || !(w1 > 0) || w1 > 0.7 * w0) return [];
  let first = -1, dir = 0;
  for (let k = Math.max(h2.m, l2.m) + 1; k <= i; k++) {
    if (c[k] > hiLine(k) + 0.05 * A) { first = k; dir = 1; break; }
    if (c[k] < loLine(k) - 0.05 * A) { first = k; dir = -1; break; }
  }
  if (first < 0 || i - first > 2) return [];
  return [{ kind: 'chart', dir, family, name: family + (dir > 0 ? ' breakout up' : ' breakout down'), shape: 'continuation',
    text: (/^[aeiou]/i.test(family) ? 'an ' : 'a ') + family.toLowerCase() + ' breaking ' + (dir > 0 ? 'above' : 'below') + ' {L}', level: dir > 0 ? hiLine(i) : loLine(i),
    prims: [{ t: 'line', i1: h1.m, v1: h1.v, i2: i, v2: hiLine(i) }, { t: 'line', i1: l1.m, v1: l1.v, i2: i, v2: loLine(i) }, { t: 'pt', i: h1.m, v: h1.v }, { t: 'pt', i: h2.m, v: h2.v }, { t: 'pt', i: l1.m, v: l1.v }, { t: 'pt', i: l2.m, v: l2.v }] }];
}
function rangeBreakout(L, i, A) {
  const { h, l, c } = L, n = 20;
  if (i - n < 0) return [];
  let hi = -Infinity, lo = Infinity;
  for (let k = i - n; k < i; k++) { hi = Math.max(hi, h[k]); lo = Math.min(lo, l[k]); }
  const H = hi - lo;
  if (H > 4 * A || H < 1.5 * A) return [];
  let tt = 0, tb = 0;
  for (let k = i - n; k < i; k++) { if (h[k] >= hi - 0.3 * A) tt++; if (l[k] <= lo + 0.3 * A) tb++; }
  if (tt < 2 || tb < 2) return [];
  const box = { t: 'box', i1: i - n, i2: i - 1, hi, lo };
  if (c[i] > hi + 0.1 * A && c[i - 1] <= hi) return [{ kind: 'chart', dir: 1, family: 'Range breakout', name: 'Range breakout up', shape: 'continuation', text: 'a range breaking upward above {L}', level: hi, prims: [box] }];
  if (c[i] < lo - 0.1 * A && c[i - 1] >= lo) return [{ kind: 'chart', dir: -1, family: 'Range breakout', name: 'Range breakout down', shape: 'continuation', text: 'a range breaking downward below {L}', level: lo, prims: [box] }];
  return [];
}
const trigFamily = t => /engulfing/i.test(t || '') ? 'Engulfing' : /pin bar/i.test(t || '') ? 'Pin bar' : '';
function findPatterns(L, i, dir, trig) {
  const A = L.atr[i];
  if (!(A > 0) || i < 30) return { agree: [], against: [] };
  const S = swingPoints(L, i, 3, 150), all = [];
  [candlePatterns(L, i), doublePattern(L, i, S, A), headShouldersPattern(L, i, S, A), flagPattern(L, i, A), trianglePattern(L, i, S, A), rangeBreakout(L, i, A)].forEach(a => a.forEach(p => all.push(p)));
  const tf = trigFamily(trig);
  all.forEach(p => { p.isTrigger = p.kind === 'candle' && !!tf && p.family === tf && p.dir === dir; });
  return { agree: all.filter(p => p.dir === dir), against: all.filter(p => p.dir === -dir) };
}
const describePattern = (p, f) => p.text.replace('{L}', p.level != null ? f(p.level) : '');

/* ---------- the rules ---------- */
function rvolAt(L, i) {
  if (!L.v || i < 20 || !(L.v[i] > 0)) return null;
  let sum = 0;
  for (let k = i - 20; k < i; k++) { if (!(L.v[k] > 0)) return null; sum += L.v[k]; }
  return L.v[i] / (sum / 20);
}
function evalBar(L, H, i, j, P) {
  const R = { status: 'none', dir: 0, checks: [], score: 0, why: '' };
  if (i < 70 || j < 6 || isNaN(L.atr[i]) || isNaN(L.rsi[i - 1]) || isNaN(L.e50[i]) || isNaN(H.e200[j]) || isNaN(H.adx[j])) { R.why = 'Not enough history yet.'; return R; }
  const hc = H.c[j], e50 = H.e50[j], e200 = H.e200[j], slope = e50 - H.e50[j - 5], adx = H.adx[j];
  let dir = 0;
  if (hc > e50 && e50 > e200 && slope > 0) dir = 1; else if (hc < e50 && e50 < e200 && slope < 0) dir = -1;
  const trendOk = dir !== 0 && adx >= P.adxMin;
  R.checks.push({ ok: trendOk, label: P.htfLabel, detail: dir ? (dir > 0 ? 'Up' : 'Down') + ', ADX ' + adx.toFixed(0) + (adx < P.adxMin ? ' (needs ' + P.adxMin + ' or more)' : '') : 'No clear trend, ADX ' + adx.toFixed(0) });
  if (!trendOk) { R.why = 'No clear trend on the higher timeframe.'; return R; }
  R.dir = dir;
  const { o, h, l, c } = L, atr = L.atr[i], e20 = L.e20[i], e50l = L.e50[i];

  let extreme = dir > 0 ? Infinity : -Infinity, rmin = Infinity, rmax = -Infinity;
  for (let k = i - 5; k <= i; k++) {
    extreme = dir > 0 ? Math.min(extreme, l[k]) : Math.max(extreme, h[k]);
    rmin = Math.min(rmin, L.rsi[k]); rmax = Math.max(rmax, L.rsi[k]);
  }
  const touched = dir > 0 ? extreme <= e20 + P.pullATR * atr : extreme >= e20 - P.pullATR * atr;
  const intact = dir > 0 ? c[i] > e50l : c[i] < e50l;
  const ext = dir * (c[i] - e20) / atr;
  const pullOk = touched && intact && ext <= 1.5;
  R.checks.push({ ok: pullOk, label: 'Pullback', detail: pullOk ? 'Price pulled back to the 20 EMA' : !intact ? 'Price broke the 50 EMA' : !touched ? 'No recent pullback to the 20 EMA' : 'Price already ran ' + ext.toFixed(1) + ' ATR past the 20 EMA' });

  const r0 = L.rsi[i], r1 = L.rsi[i - 1];
  const rsiOk = dir > 0 ? (rmin <= 50 && r0 > r1 && r0 < 70) : (rmax >= 50 && r0 < r1 && r0 > 30);
  R.checks.push({ ok: rsiOk, info: true, label: 'Momentum (RSI)', detail: 'RSI ' + r0.toFixed(0) + (rsiOk ? ', turning back with the trend' : ', not turning with the trend yet') });

  const body = Math.abs(c[i] - o[i]), range = h[i] - l[i], pb = Math.abs(c[i - 1] - o[i - 1]);
  let trig = '';
  if (dir > 0 && c[i] > o[i]) {
    if (c[i - 1] < o[i - 1] && c[i] >= o[i - 1] && o[i] <= c[i - 1] && body > pb) trig = 'Bullish engulfing candle';
    else if (range >= 0.5 * atr && (Math.min(o[i], c[i]) - l[i]) >= 2 * body && (c[i] - l[i]) / range >= 0.6) trig = 'Bullish pin bar';
    else if (c[i] > h[i - 1]) trig = 'Closed above the previous high';
  } else if (dir < 0 && c[i] < o[i]) {
    if (c[i - 1] > o[i - 1] && c[i] <= o[i - 1] && o[i] >= c[i - 1] && body > pb) trig = 'Bearish engulfing candle';
    else if (range >= 0.5 * atr && (h[i] - Math.max(o[i], c[i])) >= 2 * body && (h[i] - c[i]) / range >= 0.6) trig = 'Bearish pin bar';
    else if (c[i] < l[i - 1]) trig = 'Closed below the previous low';
  }
  R.checks.push({ ok: !!trig, label: 'Trigger candle', detail: trig || 'No trigger candle on the last closed bar' });

  let sa = 0; for (let k = i - 49; k <= i; k++) sa += L.atr[k];
  const avgA = sa / 50, volOk = atr >= 0.5 * avgA && atr <= 2.5 * avgA;
  R.checks.push({ ok: volOk, label: 'Volatility', detail: volOk ? 'Normal' : atr < 0.5 * avgA ? 'Too quiet' : 'Too wild' });

  const entry = c[i];
  let slDist = dir > 0 ? entry - (extreme - 0.15 * atr) : (extreme + 0.15 * atr) - entry;
  slDist = Math.max(slDist, atr);
  const stopOk = slDist <= P.maxStopATR * atr;
  R.checks.push({ ok: stopOk, label: 'Stop size', detail: (slDist / atr).toFixed(1) + ' ATR' + (stopOk ? '' : ' (too wide)') });

  const hr = new Date(L.t[i] + P.ltfMs).getUTCHours(), sessOk = hr >= P.sess[0] && hr < P.sess[1];
  R.checks.push({ ok: sessOk, info: true, label: 'Session', detail: sessOk ? 'Active hours' : 'Quiet hours, spreads may be wider' });

  R.score = 2 + (adx >= 25 ? 1 : 0) + (pullOk ? 2 : 0) + (rsiOk ? 1 : 0) + (trig ? 2 : 0) + (volOk ? 1 : 0) + (sessOk ? 1 : 0);
  Object.assign(R, { entry, sl: entry - dir * slDist, tp: entry + dir * P.targetR * slDist, slDist, atr, trigger: trig });
  R.rvol = rvolAt(L, i); R.priceOk = pullOk && !!trig && volOk && stopOk;
  R.gradeMax = GRADE_MAX;
  if (R.priceOk) {
    R.patterns = findPatterns(L, i, dir, trig);
    R.score += (R.patterns.agree.some(p => p.kind === 'candle' && !p.isTrigger) ? 1 : 0) + (R.patterns.agree.some(p => p.kind === 'chart') ? 1 : 0);
  }
  if (R.priceOk) {
    if (P.volGate && R.rvol != null && R.rvol < 1.1) { R.status = 'watch'; R.volHeld = true; R.why = 'Volume is below average (RVOL: ' + R.rvol.toFixed(2) + 'x), waiting for stronger participation.'; }
    else R.status = 'signal';
  }
  else if (pullOk && !trig) { R.status = 'watch'; R.why = 'The pullback is in place. Wait for a trigger candle.'; }
  else R.why = !pullOk ? 'Waiting for a pullback to the 20 EMA.' : !trig ? 'Waiting for a trigger candle.' : !volOk ? 'Volatility is not suitable.' : 'The stop would be too wide.';
  return R;
}

/* ---------- history test ---------- */
function backtest(L, H, jIdx, P, spread) {
  const n = L.t.length, trades = [];
  let i = 70;
  while (i < n - 1) {
    const j = jIdx[i];
    const sig = j >= 0 ? evalBar(L, H, i, j, P) : null;
    if (!sig || sig.status !== 'signal') { i++; continue; }
    const d = sig.dir, entry = L.o[i + 1] + d * spread, risk = Math.abs(entry - sig.sl);
    if (!(risk > 0) || risk > 3 * sig.atr) { i++; continue; }
    let exit = NaN, k = i + 1;
    const kEnd = Math.min(n - 1, i + P.holdBars);
    for (; k <= kEnd; k++) {
      if (d > 0) { if (L.o[k] <= sig.sl) { exit = L.o[k]; break; } if (L.l[k] <= sig.sl) { exit = sig.sl; break; } if (L.h[k] >= sig.tp) { exit = sig.tp; break; } }
      else { if (L.o[k] >= sig.sl) { exit = L.o[k]; break; } if (L.h[k] >= sig.sl) { exit = sig.sl; break; } if (L.l[k] <= sig.tp) { exit = sig.tp; break; } }
    }
    if (isNaN(exit)) {
      if (kEnd < i + P.holdBars) break;          // the data ends while this trade is still open, so leave it out
      k = kEnd; exit = L.c[kEnd];                 // time stop
    }
    trades.push({ i, t: L.t[i], r: d * (exit - entry) / risk, dir: d, rvol: sig.rvol, pats: sig.patterns ? sig.patterns.agree.filter(p => !p.isTrigger).map(p => ({ kind: p.kind, family: p.family })) : [] });
    i = k;
  }
  return trades;
}
function mulberry(seed) { let a = seed | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function wilson(w, n) { const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; }
function summarize(trades) {
  const rs = trades.map(t => t.r), n = rs.length;
  if (!n) return { n: 0 };
  const mean = rs.reduce((a, x) => a + x, 0) / n, wins = rs.filter(x => x > 0).length;
  const gw = rs.filter(x => x > 0).reduce((a, x) => a + x, 0), gl = Math.abs(rs.filter(x => x < 0).reduce((a, x) => a + x, 0));
  let c = 0, peak = 0, dd = 0, ls = 0, run = 0; const cum = [0];
  rs.forEach(x => { c += x; cum.push(c); peak = Math.max(peak, c); dd = Math.max(dd, peak - c); run = x < 0 ? run + 1 : 0; ls = Math.max(ls, run); });
  const r = mulberry(n * 7919 + Math.round(mean * 1000)), B = 2000, means = new Float64Array(B);
  for (let b = 0; b < B; b++) { let s = 0; for (let k = 0; k < n; k++) s += rs[(r() * n) | 0]; means[b] = s / n; }
  means.sort();
  return { n, wins, wr: wins / n, wl: wilson(wins, n), mean, ci: [means[Math.floor(B * 0.025)], means[Math.floor(B * 0.975)]], pf: gl ? gw / gl : (gw ? Infinity : 0), dd, ls, cum };
}

/* ---------- key levels (context only, not part of the rules) ---------- */
function keyLevels(L, H, i, j, price) {
  const out = [];
  const day0 = t => Math.floor(t / 86400000) * 86400000, today = day0(L.t[i]);
  let k = i; while (k >= 0 && L.t[k] >= today) k--;
  if (k >= 0) {
    const pd = day0(L.t[k]); let hi = -Infinity, lo = Infinity, cl = L.c[k];
    for (; k >= 0 && day0(L.t[k]) === pd; k--) { hi = Math.max(hi, L.h[k]); lo = Math.min(lo, L.l[k]); }
    const p = (hi + lo + cl) / 3;
    out.push({ n: 'Daily pivot', v: p }, { n: 'Pivot R1', v: 2 * p - lo }, { n: 'Pivot S1', v: 2 * p - hi });
  }
  const sh = [], sl = [], a = Math.max(2, j - 150);
  for (let m = a; m <= j - 2; m++) {
    if (H.h[m] > H.h[m - 1] && H.h[m] > H.h[m - 2] && H.h[m] >= H.h[m + 1] && H.h[m] >= H.h[m + 2]) sh.push({ m, v: H.h[m] });
    if (H.l[m] < H.l[m - 1] && H.l[m] < H.l[m - 2] && H.l[m] <= H.l[m + 1] && H.l[m] <= H.l[m + 2]) sl.push({ m, v: H.l[m] });
  }
  const above = sh.filter(x => x.v > price).sort((x, y) => x.v - y.v)[0], below = sl.filter(x => x.v < price).sort((x, y) => y.v - x.v)[0];
  if (above) out.push({ n: 'Swing resistance', v: above.v });
  if (below) out.push({ n: 'Swing support', v: below.v });
  const ph = sh[sh.length - 1], pl = sl[sl.length - 1];
  if (ph && pl) {
    const up = ph.m > pl.m, rng = ph.v - pl.v;
    [0.5, 0.618].forEach(f => out.push({ n: 'Fib ' + (f * 100).toFixed(f === 0.5 ? 0 : 1) + '% of last ' + (up ? 'rise' : 'fall'), v: up ? ph.v - f * rng : pl.v + f * rng }));
  }
  return out.sort((x, y) => y.v - x.v);
}

/* ---------- data fetching ---------- */
const CACHE = {}, HITS = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function throttle(setStatus) {
  for (;;) {
    const now = Date.now(); while (HITS.length && now - HITS[0] > 61000) HITS.shift();
    if (HITS.length < 8) { HITS.push(now); return; }
    setStatus('Waiting for the free plan’s rate limit…'); await sleep(1500);
  }
}
async function getCandles(sym, interval, key, setStatus) {
  const ck = sym + '|' + interval, hit = CACHE[ck];
  if (hit && Date.now() - hit.at < 240000) return hit.rows;
  await throttle(setStatus);
  const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(sym) + '&interval=' + interval + '&outputsize=5000&timezone=UTC&apikey=' + encodeURIComponent(key);
  let res, data;
  try { res = await fetch(url); data = await res.json(); }
  catch (e) { throw new Error('Could not reach Twelve Data. This may be your connection, or the browser blocking the request. Try Test connection in Settings.'); }
  if (data.status === 'error' || !data.values) {
    const code = data.code;
    throw new Error(code === 401 || code === 403 ? 'Twelve Data rejected the key. Check it in Settings.' : code === 429 ? 'Twelve Data rate limit reached. Wait a minute and scan again.' : (data.message || 'Twelve Data returned no data for ' + sym + '.'));
  }
  CACHE[ck] = { at: Date.now(), rows: data.values };
  return data.values;
}

/* ---------- outside context (live scans only, never applied to past candles) ---------- */
const COT_CODES = { EUR: '099741', GBP: '096742', JPY: '097741', AUD: '232741', CAD: '090741', CHF: '092741', NZD: '112741' };
const GOLD_CODE = '088691';
// Approximate policy rates, used when the live refresh is not reachable. Edit freely. Last checked: November 2026.
const RATES_FALLBACK = { USD: 3.75, EUR: 2.25, GBP: 3.75, JPY: 0.75, AUD: 3.60, CAD: 2.25, CHF: 0.00, NZD: 2.25 };
const BIS_AREAS = { US: 'USD', XM: 'EUR', GB: 'GBP', JP: 'JPY', AU: 'AUD', CA: 'CAD', CH: 'CHF', NZ: 'NZD' };

function cacheGet(key, ttl) { try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.at < ttl) return c.data; } catch (e) {} return null; }
function cacheSet(key, data) { try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch (e) {} }
let PROXY = '';
const ext = url => PROXY ? PROXY + (PROXY.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url) : url;
async function fetchTimed(url, opts) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = setTimeout(() => { if (ctl) ctl.abort(); }, 9000);
  try {
    let res;
    try { res = await fetch(ext(url), Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {})); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timeout' : 'blocked'); }
    if (res && res.ok === false) throw new Error('HTTP ' + res.status);
    return res;
  } finally { clearTimeout(timer); }
}
function explain(m) {
  m = String(m || '');
  if (m === 'blocked') return 'blocked by the browser, or no connection';
  if (m === 'timeout') return 'it took too long to respond';
  if (m === 'HTTP 429') return 'the source is limiting requests, try again later';
  if (/^HTTP (401|403)/.test(m)) return 'the source refused the request';
  if (/^HTTP /.test(m)) return 'the source returned an error (' + m + ')';
  return 'the source returned something unexpected';
}
const pick = (row, names) => { for (const n of names) if (row[n] != null && row[n] !== '') return +row[n]; return NaN; };

async function fetchCOT() {
  const base = 'https://publicreporting.cftc.gov/resource/', order = encodeURIComponent('report_date_as_yyyy_mm_dd DESC');
  const codes = Object.values(COT_CODES).map(c => "'" + c + "'").join(',');
  const [tr, gr] = await Promise.all([
    fetchTimed(base + 'gpe5-46if.json?$where=' + encodeURIComponent('cftc_contract_market_code in(' + codes + ')') + '&$order=' + order + '&$limit=60'),
    fetchTimed(base + '72hh-3qpy.json?$where=' + encodeURIComponent("cftc_contract_market_code='" + GOLD_CODE + "'") + '&$order=' + order + '&$limit=2')
  ]);
  const tff = await tr.json(), gold = await gr.json();
  if (!Array.isArray(tff)) throw new Error('unexpected COT response');
  const grab = (rows, code, lo, sh) => {
    const mine = (rows || []).filter(r => String(r.cftc_contract_market_code) === code).slice(0, 2);
    const val = r => { const lg = pick(r, lo), st = pick(r, sh), oi = pick(r, ['open_interest_all']); return isFinite(lg) && isFinite(st) && oi > 0 ? { net: lg - st, oi } : null; };
    const a = mine[0] ? val(mine[0]) : null, b = mine[1] ? val(mine[1]) : null;
    if (!a) return null;
    const pct = a.net / a.oi * 100;
    return { date: String(mine[0].report_date_as_yyyy_mm_dd).slice(0, 10), net: a.net, pct, chg: b ? pct - b.net / b.oi * 100 : null };
  };
  const out = {};
  for (const [ccy, code] of Object.entries(COT_CODES)) { const v = grab(tff, code, ['lev_money_positions_long', 'lev_money_positions_long_all'], ['lev_money_positions_short', 'lev_money_positions_short_all']); if (v) out[ccy] = v; }
  const g = grab(gold, GOLD_CODE, ['m_money_positions_long_all', 'm_money_positions_long'], ['m_money_positions_short_all', 'm_money_positions_short']);
  if (g) out.GOLD = g;
  return Object.keys(out).length ? out : null;
}
async function fetchNews() {
  const res = await fetchTimed('https://nfs.faireconomy.media/ff_calendar_thisweek.json'), arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('unexpected calendar response');
  return arr.filter(e => String(e.impact).toLowerCase() === 'high').map(e => ({ title: String(e.title || 'event'), ccy: String(e.country || '').toUpperCase(), ts: Date.parse(e.date) })).filter(e => isFinite(e.ts));
}
async function fetchRates() {
  const res = await fetchTimed('https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.' + Object.keys(BIS_AREAS).join('+') + '?lastNObservations=1', { headers: { Accept: 'application/vnd.sdmx.data+csv;version=2.0.0' } });
  const lines = (await res.text()).trim().split(/\r?\n/), head = lines[0].split(','), ia = head.indexOf('REF_AREA'), iv = head.indexOf('OBS_VALUE');
  if (ia < 0 || iv < 0) throw new Error('unexpected rates response');
  const out = {};
  lines.slice(1).forEach(l => { const c = l.split(','), ccy = BIS_AREAS[c[ia]], v = parseFloat(c[iv]); if (ccy && isFinite(v)) out[ccy] = v; });
  return Object.keys(out).length ? out : null;
}
// Weekly positioning history for one market, each report usable only from the Friday it was published (no look-ahead).
async function fetchCOTHistory(sym) {
  const { b, q } = legs(sym), want = [];
  if (b === 'XAU') want.push(['GOLD', GOLD_CODE, true]);
  else { if (b !== 'USD' && COT_CODES[b]) want.push([b, COT_CODES[b], false]); if (q !== 'USD' && COT_CODES[q]) want.push([q, COT_CODES[q], false]); }
  if (!want.length) return null;
  const base = 'https://publicreporting.cftc.gov/resource/', order = encodeURIComponent('report_date_as_yyyy_mm_dd DESC'), out = {};
  for (const [ccy, code, gold] of want) {
    const res = await fetchTimed(base + (gold ? '72hh-3qpy' : 'gpe5-46if') + '.json?$where=' + encodeURIComponent("cftc_contract_market_code='" + code + "'") + '&$order=' + order + '&$limit=130');
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length < 6) throw new Error('unexpected');
    const lo = gold ? ['m_money_positions_long_all', 'm_money_positions_long'] : ['lev_money_positions_long', 'lev_money_positions_long_all'];
    const sh = gold ? ['m_money_positions_short_all', 'm_money_positions_short'] : ['lev_money_positions_short', 'lev_money_positions_short_all'];
    const pts = rows.map(r => { const lg = pick(r, lo), st = pick(r, sh), oi = pick(r, ['open_interest_all']); return isFinite(lg) && isFinite(st) && oi > 0 ? { date: String(r.report_date_as_yyyy_mm_dd).slice(0, 10), pct: (lg - st) / oi * 100 } : null; }).filter(Boolean).sort((x, y) => x.date < y.date ? -1 : 1);
    out[ccy] = pts.map((p, k) => ({ avail: Date.parse(p.date + 'T00:00:00Z') + 3 * 86400000 + 21 * 3600000, pct: p.pct, chg: k ? p.pct - pts[k - 1].pct : null, date: p.date }));
  }
  return out;
}
function cotAtTime(hist, ts) {
  const o = {};
  for (const ccy of Object.keys(hist)) { let got = null; for (const p of hist[ccy]) { if (p.avail <= ts) got = p; else break; } if (got) o[ccy] = got; }
  return o;
}
function compareWith(label, withG, withoutG) {
  const A = summarize(withG), B = summarize(withoutG);
  const verdict = A.n < 10 || B.n < 10 ? 'Too few trades to judge' : A.ci[0] > B.ci[1] ? 'Helped: trades with it did clearly better' : A.ci[1] < B.ci[0] ? 'Hurt: trades with it did clearly worse' : 'No clear difference';
  return { mode: 'with', label, nWith: A.n, nWithout: B.n, meanWith: A.n ? A.mean : null, meanWithout: B.n ? B.mean : null, verdict };
}
function compareGroups(label, allowed, blocked) {
  const A = summarize(allowed), B = summarize(blocked);
  const verdict = A.n < 10 || B.n < 10 ? 'Too few trades to judge' : B.ci[1] < A.ci[0] ? 'Helped: what it blocked did clearly worse' : B.ci[0] > A.ci[1] ? 'Hurt: it blocked trades that did clearly better' : 'No clear difference';
  return { label, nAllowed: A.n, nBlocked: B.n, meanAllowed: A.n ? A.mean : null, meanBlocked: B.n ? B.mean : null, verdict };
}
async function extrasTest(r) {
  const trades = backtest(r.L, r.H, r.jIdx, Object.assign({}, r.P, { volGate: false }), MARKETS[r.sym].spread), rows = [], notes = [];
  if (!r.hasVol) notes.push(['Volume', 'No volume data for this market, so it cannot be tested.']);
  else rows.push(compareGroups('Volume at least 1.1x average', trades.filter(t => t.rvol == null || t.rvol >= 1.1), trades.filter(t => t.rvol != null && t.rvol < 1.1)));
  if (r.style !== 'swing') notes.push(['Positioning (COT)', 'It only blocks signals on the swing style, so there is nothing to test here.']);
  else {
    try {
      const hist = await fetchCOTHistory(r.sym);
      if (!hist) notes.push(['Positioning (COT)', 'No positioning data exists for this market.']);
      else {
        const opposed = t => { const c = cotFor(r.sym, cotAtTime(hist, r.L.t[t.i] + r.P.ltfMs)); return !!c && ((t.dir > 0 && c.bias === 'bearish') || (t.dir < 0 && c.bias === 'bullish')); };
        rows.push(compareGroups('Not against hedge-fund positioning', trades.filter(t => !opposed(t)), trades.filter(opposed)));
      }
    } catch (e) { notes.push(['Positioning (COT)', 'Its history could not be loaded (' + explain(e.message) + ').']); }
  }
  const has = (t, pred) => (t.pats || []).some(pred), addPat = (label, pred) => { const w = trades.filter(t => has(t, pred)); if (w.length) rows.push(compareWith(label, w, trades.filter(t => !has(t, pred)))); };
  if (!trades.some(t => t.pats && t.pats.length)) notes.push(['Patterns', 'None of the past signals had a pattern alongside them, so there is nothing to compare.']);
  else {
    addPat('Any candlestick pattern', p => p.kind === 'candle');
    addPat('Any chart pattern', p => p.kind === 'chart');
    const fam = {}; trades.forEach(t => (t.pats || []).forEach(p => { fam[p.family] = (fam[p.family] || 0) + 1; }));
    Object.keys(fam).sort((x, y) => fam[y] - fam[x]).slice(0, 6).forEach(f => addPat(f, p => p.family === f));
  }
  notes.push(['News', 'Cannot be tested: the free calendar only keeps the current week.'], ['Rate spread', 'Context only, so there is nothing to test.']);
  return { n: trades.length, rows, notes };
}

async function loadContext(setStatus, s) {
  PROXY = s && s.proxy ? s.proxy.trim() : '';
  if (setStatus) setStatus('Checking positioning, news and rates…');
  const errors = {};
  const get = async (name, key, ttl, fn) => {
    const c = cacheGet(key, ttl); if (c) return c;
    try { const d = await fn(); if (d) cacheSet(key, d); else errors[name] = 'unexpected'; return d || null; }
    catch (e) { errors[name] = e && e.message ? e.message : 'unexpected'; return null; }
  };
  const [cot, news, rates] = await Promise.all([get('cot', 'sc:cot', 86400000, fetchCOT), get('news', 'sc:news', 21600000, fetchNews), get('rates', 'sc:rates', 604800000, fetchRates)]);
  return { cot, news, rates: Object.assign({}, RATES_FALLBACK, rates || {}), errors };
}
const legs = sym => { const p = sym.split('/'); return { b: p[0], q: p[1] }; };
function cotFor(sym, cot) {
  if (!cot) return null;
  const { b, q } = legs(sym), parts = [];
  let net = 0, chg = 0, n = 0, haveChg = true;
  const add = (key, sign, label) => {
    const v = cot[key]; if (!v) return;
    net += sign * v.pct; n++;
    if (v.chg == null) haveChg = false; else chg += sign * v.chg;
    parts.push(label + ' futures ' + (v.pct >= 0 ? 'net long ' : 'net short ') + Math.abs(v.pct).toFixed(1) + '% of open interest');
  };
  if (b === 'XAU') add('GOLD', 1, 'Gold'); else { if (b !== 'USD') add(b, 1, b); if (q !== 'USD') add(q, -1, q); }
  if (!n) return null;
  return { bias: net > 1 ? 'bullish' : net < -1 ? 'bearish' : 'neutral', net, chg: haveChg ? chg : null, parts };
}
function rateFor(sym, rates) {
  const { b, q } = legs(sym);
  if (b === 'XAU' || !rates || rates[b] == null || rates[q] == null) return null;
  const d = rates[b] - rates[q];
  return { diff: d, text: Math.abs(d) < 0.05 ? 'Rate spread is flat' : 'Rate spread favors ' + (d > 0 ? b : q) + ' (+' + Math.abs(d).toFixed(2) + '%)' };
}
function newsFor(sym, news, now) {
  if (!news) return { status: 'unknown' };
  const { b, q } = legs(sym), set = b === 'XAU' ? [q] : [b, q];
  const hit = news.filter(e => set.includes(e.ccy) && Math.abs(e.ts - now) <= 3600000).sort((x, y) => Math.abs(x.ts - now) - Math.abs(y.ts - now))[0];
  return hit ? { status: 'near', ev: hit } : { status: 'clear' };
}
// Holds a signal at WATCH when the outside context disagrees, and builds the plain-English context lines.
function applyGates(sig, sym, style, ctx, now) {
  const cot = cotFor(sym, ctx.cot), rate = rateFor(sym, ctx.rates), nw = newsFor(sym, ctx.news, now);
  const info = { rvol: sig.rvol == null ? null : +sig.rvol.toFixed(2), newsStatus: nw.status, cotBias: cot ? cot.bias : null, rateDifferential: rate ? +rate.diff.toFixed(2) : null };
  const pat = sig.patterns || { agree: [], against: [] }, fl = v => v.toFixed(MARKETS[sym] ? MARKETS[sym].dec : 5);
  const patAgree = pat.agree.filter(p => !p.isTrigger).map(p => describePattern(p, fl));
  info.patterns = patAgree;
  if (sig.priceOk) {
    const reasons = [];
    if (sig.volHeld) reasons.push(sig.why);
    if (style === 'swing' && cot && ((sig.dir > 0 && cot.bias === 'bearish') || (sig.dir < 0 && cot.bias === 'bullish'))) reasons.push('Institutional COT positioning favors the opposite direction — held at WATCH.');
    if (nw.status === 'near') reasons.push('High-impact ' + nw.ev.ccy + ' news (' + nw.ev.title + ', ' + clock(nw.ev.ts) + ' ' + TZ_NAME + ') within 60 mins — holding off entry.');
    if (reasons.length) { sig.status = 'watch'; sig.why = reasons.join(' '); }
  }
  const lines = [], macro = [];
  if (rate) macro.push(rate.text);
  if (cot) macro.push('Hedge funds: ' + cot.parts.join(' and ') + (cot.chg != null ? ', ' + (cot.chg >= 0 ? 'up ' : 'down ') + Math.abs(cot.chg).toFixed(1) + ' points on the week' : '') + ', leaning ' + cot.bias + ' for ' + sym);
  if (macro.length) lines.push('Macro context: ' + macro.join(' · ') + '.');
  if (patAgree.length) lines.push('Pattern confluence: ' + patAgree.join(' · ') + '.');
  if (pat.against.length) lines.push('Caution: ' + pat.against.map(p => describePattern(p, fl)).join(' · ') + ', against this idea.');
  const tail = [];
  if (sig.rvol != null) tail.push('Volume ' + sig.rvol.toFixed(2) + 'x average');
  tail.push(nw.status === 'clear' ? 'No high-impact news within 60 minutes' : nw.status === 'near' ? 'High-impact news is close' : 'News calendar not available' + (ctx.errors && ctx.errors.news ? ' (' + explain(ctx.errors.news) + ')' : '') + ', check it yourself');
  lines.push(tail.join(' · ') + '.');
  return { info, lines };
}

/* ---------- analysis of one market ---------- */
function paramsFor(sym, st, targetR) {
  return { adxMin: 20, pullATR: 0.3, maxStopATR: 2.5, holdBars: 60, targetR, htfLabel: st.htfLabel, ltfMs: MS[st.ltf], sess: sym === 'USD/JPY' ? [0, 21] : [7, 21] };
}
function analyze(sym, lraw, hraw, s, now, ctx) {
  const st = STYLES[s.style], P = paramsFor(sym, st, s.targetR), m = MARKETS[sym];
  const lrows = prepCandles(lraw, st.ltf, now), hrows = prepCandles(hraw, st.htf, now);
  if (lrows.length < 300 || hrows.length < 260) throw new Error('Not enough candles returned for ' + sym + ' (' + lrows.length + ' and ' + hrows.length + ').');
  const L = buildL(lrows), H = buildH(hrows), jIdx = alignHtf(L, H, MS[st.ltf], MS[st.htf]);
  const PL = Object.assign({}, P, { volGate: true });
  const i = L.t.length - 1, sig = evalBar(L, H, i, jIdx[i], PL);
  const ageMin = Math.round((now - (L.t[i] + MS[st.ltf])) / 60000);
  const stale = ageMin > 3 * MS[st.ltf] / 60000;
  const gate = applyGates(sig, sym, s.style, ctx || { cot: null, news: null, rates: RATES_FALLBACK }, now);
  const hasVol = L.v.slice(-100).filter(x => x > 0).length >= 90;
  const trades = backtest(L, H, jIdx, Object.assign({}, P, { volGate: VOLHIST }), m.spread), stats = summarize(trades);
  return { sym, st, P, L, H, jIdx, gate, hasVol, style: s.style, i, j: jIdx[i], sig, ageMin, stale, stats, levels: keyLevels(L, H, i, jIdx[i], L.c[i]), bars: L.t.length, from: L.t[0], to: L.t[i], price: L.c[i] };
}


function lotCalc(r, s) {
  const m = MARKETS[r.sym], sig = r.sig, bal = parseFloat(s.bal), rp = parseFloat(s.riskPct);
  if (!(bal > 0) || !(rp > 0)) return null;
  const dist = +Math.abs(sig.entry - sig.sl).toFixed(8), pu = m.perUnit(sig.entry), risk = bal * rp / 100;
  const lots = Math.floor(+(risk / (dist * pu) * 100).toFixed(6)) / 100;
  return { lots, actual: lots * dist * pu };
}

module.exports = { MARKETS, STYLES, MS, TZ_NAME, GRADE_MAX, clock, when, analyze, loadContext, getCandles, lotCalc };
