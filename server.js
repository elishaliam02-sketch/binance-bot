const Binance = require('node-binance-api');
const express = require('express');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
// ─── הגדרות ───────────────────────────────────────────────
const CONFIG = {
  TRADE_AMOUNT_USDT: 15,        // כמה USDT לכל עסקה
  MAX_OPEN_TRADES: 3,           // מקסימום עסקאות פתוחות במקביל
  STOP_LOSS_PCT: 0.03,          // 3% stop loss
  TAKE_PROFIT_PCT: 0.06,        // 6% take profit
  SCAN_INTERVAL_MS: 5 * 60 * 1000, // סריקה כל 5 דקות
  RSI_OVERSOLD: 32,
  RSI_OVERBOUGHT: 68,
  MIN_VOLUME_USDT: 5_000_000,   // מינימום נפח יומי $5M
  CANDLE_INTERVAL: '15m',
  CANDLE_LIMIT: 100,
};
 
// מטבעות לסריקה – הכי נסחרים בביינאנס
const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','MATICUSDT',
  'LINKUSDT','UNIUSDT','ATOMUSDT','LTCUSDT','ETCUSDT',
  'ALGOUSDT','NEARUSDT','FTMUSDT','SANDUSDT','MANAUSDT',
  'AXSUSDT','GALAUSDT','CHZUSDT','APEUSDT','OPUSDT',
  'ARBUSDT','SHIBUSDT','TRXUSDT','XLMUSDT','VETUSDT',
  'ICPUSDT','FILUSDT','AAVEUSDT','MKRUSDT','COMPUSDT',
  'SNXUSDT','CRVUSDT','YFIUSDT','SUSHIUSDT','1INCHUSDT',
  'RUNEUSDT','KAVAUSDT','ZILUSDT','ONTUSDT','ZENUSDT',
];
 
// ─── Binance Client ────────────────────────────────────────
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY || '',
  APISECRET: process.env.BINANCE_API_SECRET || '',
  useServerTime: true,
  recvWindow: 10000,
  family: 4,
  urls: {
    base: 'https://api1.binance.com/api/',
    stream: 'wss://stream.binance.com:9443/ws/',
    combineStream: 'wss://stream.binance.com:9443/stream?streams=',
  },
});
 
// ─── State ─────────────────────────────────────────────────
const state = {
  openTrades: {},   // { symbol: { buyPrice, qty, openTime, stopLoss, takeProfit } }
  log: [],
  stats: { wins: 0, losses: 0, totalPnl: 0, scans: 0 },
  lastScan: null,
  signals: [],
  isRunning: false,
};
 
// ─── Logging ───────────────────────────────────────────────
function log(msg, type = 'INFO') {
  const entry = { time: new Date().toISOString(), type, msg };
  state.log.unshift(entry);
  if (state.log.length > 500) state.log.pop();
  console.log(`[${entry.time}] [${type}] ${msg}`);
}
 
// ─── Math Helpers ──────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
 
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}
 
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  // Signal: EMA9 of MACD (approximate using last values)
  const macdValues = closes.slice(-20).map((_, i, arr) => {
    const slice = closes.slice(0, closes.length - 20 + i + 1);
    return calcEMA(slice, 12) - calcEMA(slice, 26);
  });
  const signal = calcEMA(macdValues, 9);
  return { macdLine, signal, histogram: macdLine - signal };
}
 
function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + stdDev * std,
    middle: mean,
    lower: mean - stdDev * std,
    bandwidth: (2 * stdDev * std) / mean,
  };
}
 
function calcVolumeSpike(volumes) {
  const avg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const current = volumes[volumes.length - 1];
  return current / avg; // >2 = spike
}
 
// ─── Signal Scoring ────────────────────────────────────────
function scoreSymbol(symbol, candles) {
  const closes  = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[5]));
  const current = closes[closes.length - 1];
 
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollingerBands(closes);
  const volSpike = calcVolumeSpike(volumes);
 
  let score = 0;
  const reasons = [];
 
  // RSI – oversold = bullish
  if (rsi < CONFIG.RSI_OVERSOLD) {
    score += 30;
    reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
  } else if (rsi > CONFIG.RSI_OVERBOUGHT) {
    score -= 20;
    reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
  }
 
  // MACD – bullish crossover
  if (macd.histogram > 0 && macd.macdLine > macd.signal) {
    score += 25;
    reasons.push('MACD bullish crossover');
  } else if (macd.histogram < 0) {
    score -= 15;
  }
 
  // Bollinger Bands – price near lower band
  const bbPosition = (current - bb.lower) / (bb.upper - bb.lower);
  if (bbPosition < 0.2) {
    score += 25;
    reasons.push(`Near BB lower (${(bbPosition * 100).toFixed(0)}%)`);
  } else if (bbPosition > 0.8) {
    score -= 10;
  }
 
  // Volume spike – confirms momentum
  if (volSpike > 2) {
    score += 20;
    reasons.push(`Volume spike x${volSpike.toFixed(1)}`);
  } else if (volSpike > 1.5) {
    score += 10;
    reasons.push(`Vol up x${volSpike.toFixed(1)}`);
  }
 
  // Bandwidth – volatility (wide BB = opportunity)
  if (bb.bandwidth > 0.05) {
    score += 5;
    reasons.push('High volatility');
  }
 
  return { symbol, score, rsi, macd, bb, volSpike, current, reasons };
}
 
// ─── Trading Logic ─────────────────────────────────────────
async function getCandles(symbol) {
  return new Promise((resolve, reject) => {
    binance.candlesticks(symbol, CONFIG.CANDLE_INTERVAL, (err, ticks) => {
      if (err) return reject(err);
      resolve(ticks);
    }, { limit: CONFIG.CANDLE_LIMIT });
  });
}
 
async function getBalance(asset = 'USDT') {
  return new Promise((resolve, reject) => {
    binance.balance((err, balances) => {
      if (err) return reject(err);
      resolve(parseFloat(balances[asset]?.available || 0));
    });
  });
}
 
async function getSymbolInfo(symbol) {
  return new Promise((resolve, reject) => {
    binance.exchangeInfo((err, data) => {
      if (err) return reject(err);
      const info = data.symbols.find(s => s.symbol === symbol);
      resolve(info);
    });
  });
}
 
function roundStep(qty, stepSize) {
  const precision = Math.round(-Math.log10(parseFloat(stepSize)));
  return parseFloat(qty.toFixed(precision));
}
 
async function buyMarket(symbol, usdtAmount) {
  try {
    const info = await getSymbolInfo(symbol);
    const lotSize = info.filters.find(f => f.filterType === 'LOT_SIZE');
    const stepSize = lotSize?.stepSize || '0.001';
 
    // Get current price
    const price = await new Promise((res, rej) =>
      binance.prices(symbol, (err, p) => err ? rej(err) : res(parseFloat(p[symbol])))
    );
 
    const rawQty = usdtAmount / price;
    const qty = roundStep(rawQty, stepSize);
 
    return new Promise((resolve, reject) => {
      binance.marketBuy(symbol, qty, (err, response) => {
        if (err) return reject(JSON.parse(err.body || '{}'));
        resolve({ ...response, price, qty });
      });
    });
  } catch (e) {
    throw e;
  }
}
 
async function sellMarket(symbol, qty) {
  return new Promise((resolve, reject) => {
    binance.marketSell(symbol, qty, (err, response) => {
      if (err) return reject(JSON.parse(err.body || '{}'));
      resolve(response);
    });
  });
}
 
// ─── Open / Close Trades ───────────────────────────────────
async function openTrade(signal) {
  if (state.openTrades[signal.symbol]) return;
  if (Object.keys(state.openTrades).length >= CONFIG.MAX_OPEN_TRADES) return;
 
  try {
    const balance = await getBalance('USDT');
    if (balance < CONFIG.TRADE_AMOUNT_USDT) {
      log(`לא מספיק USDT (${balance.toFixed(2)})`, 'WARN');
      return;
    }
 
    const result = await buyMarket(signal.symbol, CONFIG.TRADE_AMOUNT_USDT);
    const buyPrice = signal.current;
    const stopLoss = buyPrice * (1 - CONFIG.STOP_LOSS_PCT);
    const takeProfit = buyPrice * (1 + CONFIG.TAKE_PROFIT_PCT);
 
    state.openTrades[signal.symbol] = {
      buyPrice,
      qty: result.qty,
      openTime: Date.now(),
      stopLoss,
      takeProfit,
      score: signal.score,
      reasons: signal.reasons,
    };
 
    log(`🟢 BUY ${signal.symbol} @ $${buyPrice.toFixed(4)} | SL: $${stopLoss.toFixed(4)} | TP: $${takeProfit.toFixed(4)} | Score: ${signal.score} | ${signal.reasons.join(', ')}`, 'TRADE');
  } catch (e) {
    log(`שגיאת קנייה ${signal.symbol}: ${e.msg || e.message}`, 'ERROR');
  }
}
 
async function checkAndCloseTrades() {
  for (const [symbol, trade] of Object.entries(state.openTrades)) {
    try {
      const price = await new Promise((res, rej) =>
        binance.prices(symbol, (err, p) => err ? rej(err) : res(parseFloat(p[symbol])))
      );
 
      const pnlPct = (price - trade.buyPrice) / trade.buyPrice;
 
      if (price <= trade.stopLoss || price >= trade.takeProfit) {
        await sellMarket(symbol, trade.qty);
        const pnlUsdt = pnlPct * CONFIG.TRADE_AMOUNT_USDT;
 
        if (price >= trade.takeProfit) {
          state.stats.wins++;
          log(`🎯 TP HIT ${symbol} @ $${price.toFixed(4)} | PnL: +$${pnlUsdt.toFixed(2)} (+${(pnlPct*100).toFixed(2)}%)`, 'WIN');
        } else {
          state.stats.losses++;
          log(`🛑 SL HIT ${symbol} @ $${price.toFixed(4)} | PnL: -$${Math.abs(pnlUsdt).toFixed(2)} (${(pnlPct*100).toFixed(2)}%)`, 'LOSS');
        }
 
        state.stats.totalPnl += pnlUsdt;
        delete state.openTrades[symbol];
      }
    } catch (e) {
      log(`שגיאת בדיקת ${symbol}: ${e.message}`, 'ERROR');
    }
  }
}
 
// ─── Main Scan Loop ────────────────────────────────────────
async function scanMarket() {
  state.stats.scans++;
  state.lastScan = new Date().toISOString();
  log(`🔍 סריקה #${state.stats.scans} – בודק ${SYMBOLS.length} מטבעות...`);
 
  await checkAndCloseTrades();
 
  if (Object.keys(state.openTrades).length >= CONFIG.MAX_OPEN_TRADES) {
    log('מקסימום עסקאות פתוחות – מדלג על סריקה');
    return;
  }
 
  const scores = [];
  for (const symbol of SYMBOLS) {
    try {
      const candles = await getCandles(symbol);
      if (!candles || candles.length < 30) continue;
      const s = scoreSymbol(symbol, candles);
      scores.push(s);
      await new Promise(r => setTimeout(r, 100)); // rate limit
    } catch (e) {
      // skip symbol
    }
  }
 
  scores.sort((a, b) => b.score - a.score);
  state.signals = scores.slice(0, 10);
 
  const topSignals = scores.filter(s =>
    s.score >= 50 && !state.openTrades[s.symbol]
  );
 
  log(`📊 Top signal: ${scores[0]?.symbol} score=${scores[0]?.score} | ${scores[0]?.reasons?.join(', ')}`);
 
  for (const signal of topSignals.slice(0, CONFIG.MAX_OPEN_TRADES)) {
    await openTrade(signal);
  }
}
 
// ─── Web Dashboard ─────────────────────────────────────────
app.get('/', (req, res) => {
  const openTradesArr = Object.entries(state.openTrades).map(([sym, t]) => ({
    symbol: sym, ...t,
    ageMin: Math.round((Date.now() - t.openTime) / 60000),
  }));
 
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>⚡ Binance Bot Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0e17;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 20px;
    }
    h1 {
      color: #f6c90e;
      font-size: 1.6rem;
      margin-bottom: 4px;
      letter-spacing: 2px;
    }
    .subtitle { color: #64748b; font-size: 0.8rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: #111827;
      border: 1px solid #1e2d40;
      border-radius: 8px;
      padding: 16px;
    }
    .card-label { color: #64748b; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .card-value { font-size: 1.5rem; font-weight: bold; }
    .green { color: #22c55e; }
    .red { color: #ef4444; }
    .yellow { color: #f6c90e; }
    .blue { color: #38bdf8; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th { background: #111827; color: #64748b; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; padding: 8px 12px; text-align: right; border-bottom: 1px solid #1e2d40; }
    td { padding: 10px 12px; border-bottom: 1px solid #111827; font-size: 0.85rem; }
    tr:hover { background: #111827; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      font-weight: bold;
    }
    .badge-green { background: #14532d; color: #22c55e; }
    .badge-red { background: #450a0a; color: #ef4444; }
    .badge-yellow { background: #422006; color: #f6c90e; }
    .section-title { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 2px; margin: 20px 0 10px; border-bottom: 1px solid #1e2d40; padding-bottom: 6px; }
    .log-entry { font-size: 0.75rem; padding: 4px 0; border-bottom: 1px solid #0f172a; color: #94a3b8; }
    .log-entry.TRADE { color: #22c55e; }
    .log-entry.WIN { color: #22c55e; font-weight: bold; }
    .log-entry.LOSS { color: #ef4444; }
    .log-entry.ERROR { color: #f97316; }
    .log-entry.WARN { color: #f6c90e; }
    .score-bar { display: inline-block; height: 6px; background: #1e2d40; border-radius: 3px; vertical-align: middle; width: 80px; margin-right: 8px; position: relative; overflow: hidden; }
    .score-fill { height: 100%; background: linear-gradient(90deg, #f6c90e, #22c55e); border-radius: 3px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-left: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  </style>
</head>
<body>
  <h1>⚡ BINANCE BOT <span class="status-dot"></span></h1>
  <div class="subtitle">עודכן: ${new Date().toLocaleString('he-IL')} | רענון אוטומטי כל 30 שניות</div>
 
  <div class="grid">
    <div class="card">
      <div class="card-label">סריקות</div>
      <div class="card-value yellow">${state.stats.scans}</div>
    </div>
    <div class="card">
      <div class="card-label">סה"כ רווח/הפסד</div>
      <div class="card-value ${state.stats.totalPnl >= 0 ? 'green' : 'red'}">
        ${state.stats.totalPnl >= 0 ? '+' : ''}$${state.stats.totalPnl.toFixed(2)}
      </div>
    </div>
    <div class="card">
      <div class="card-label">ניצחונות / הפסדים</div>
      <div class="card-value"><span class="green">${state.stats.wins}</span> / <span class="red">${state.stats.losses}</span></div>
    </div>
    <div class="card">
      <div class="card-label">עסקאות פתוחות</div>
      <div class="card-value blue">${Object.keys(state.openTrades).length} / ${CONFIG.MAX_OPEN_TRADES}</div>
    </div>
  </div>
 
  ${openTradesArr.length > 0 ? `
  <div class="section-title">📈 עסקאות פתוחות</div>
  <table>
    <thead><tr>
      <th>מטבע</th><th>מחיר כניסה</th><th>Stop Loss</th><th>Take Profit</th><th>גיל (דק')</th><th>Score</th>
    </tr></thead>
    <tbody>
      ${openTradesArr.map(t => `
        <tr>
          <td><strong class="yellow">${t.symbol}</strong></td>
          <td>$${parseFloat(t.buyPrice).toFixed(4)}</td>
          <td class="red">$${parseFloat(t.stopLoss).toFixed(4)}</td>
          <td class="green">$${parseFloat(t.takeProfit).toFixed(4)}</td>
          <td>${t.ageMin}</td>
          <td><span class="badge badge-yellow">${t.score}</span></td>
        </tr>`).join('')}
    </tbody>
  </table>` : '<div class="card" style="margin-bottom:24px"><div class="card-label">אין עסקאות פתוחות כרגע</div></div>'}
 
  <div class="section-title">🔥 Top Signals (אחרון סריקה)</div>
  <table>
    <thead><tr>
      <th>מטבע</th><th>מחיר</th><th>RSI</th><th>Score</th><th>סיבות</th>
    </tr></thead>
    <tbody>
      ${state.signals.slice(0, 10).map(s => `
        <tr>
          <td><strong>${s.symbol}</strong></td>
          <td>$${s.current?.toFixed(4) || '-'}</td>
          <td class="${s.rsi < 35 ? 'green' : s.rsi > 65 ? 'red' : ''}">${s.rsi?.toFixed(1) || '-'}</td>
          <td>
            <span class="score-bar"><span class="score-fill" style="width:${Math.min(s.score, 100)}%"></span></span>
            <span class="badge ${s.score >= 50 ? 'badge-green' : 'badge-yellow'}">${s.score}</span>
          </td>
          <td style="color:#94a3b8;font-size:0.75rem">${s.reasons?.join(' · ') || '-'}</td>
        </tr>`).join('')}
    </tbody>
  </table>
 
  <div class="section-title">📋 לוג פעולות (אחרון 50)</div>
  <div>
    ${state.log.slice(0, 50).map(e => `
      <div class="log-entry ${e.type}">
        <span style="color:#334155">${e.time.replace('T',' ').slice(0,19)}</span>
        <span style="color:#475569"> [${e.type}]</span> ${e.msg}
      </div>`).join('')}
  </div>
</body>
</html>`;
  res.send(html);
});
 
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  scans: state.stats.scans,
  openTrades: Object.keys(state.openTrades).length,
  totalPnl: state.stats.totalPnl,
}));
 
// ─── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 Server running on port ${PORT}`);
  log(`⚡ Bot starting – scanning ${SYMBOLS.length} symbols every ${CONFIG.SCAN_INTERVAL_MS / 60000} minutes`);
 
  // First scan after 10 seconds
  setTimeout(scanMarket, 10_000);
 
  // Then every N minutes
  setInterval(scanMarket, CONFIG.SCAN_INTERVAL_MS);
});
