require("dotenv").config();
const express = require("express");
const { Spot } = require("@binance/connector");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const client = new Spot(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_API_SECRET
);

// מחיר נוכחי
app.get("/price/:symbol", async (req, res) => {
  try {
    const r = await client.tickerPrice(req.params.symbol);
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// יתרות
app.get("/balances", async (req, res) => {
  try {
    const r = await client.account();
    const balances = r.data.balances.filter(b => parseFloat(b.free) > 0);
    res.json(balances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// לוגיקת DCA אוטומטי
let lastPrice = null;
let botActive = false;

async function runBot() {
  try {
    const r = await client.tickerPrice("BTCUSDT");
    const price = parseFloat(r.data.price);
    console.log("מחיר BTC: $" + price);

    if (lastPrice) {
      const change = ((price - lastPrice) / lastPrice) * 100;
      
      // קנה אם המחיר ירד ב-0.5%
      if (change < -0.5) {
        console.log("קונה BTC - ירידה של " + change.toFixed(2) + "%");
        // הסר הערה למסחר אמיתי:
        // await client.newOrder("BTCUSDT", "BUY", "MARKET", { quoteOrderQty: 10 });
      }
      
      // מכור אם המחיר עלה ב-1%
      if (change > 1) {
        console.log("מוכר BTC - עלייה של " + change.toFixed(2) + "%");
        // הסר הערה למסחר אמיתי:
        // await client.newOrder("BTCUSDT", "SELL", "MARKET", { quantity: 0.0001 });
      }
    }
    
    lastPrice = price;
  } catch (e) {
    console.log("שגיאה:", e.message);
  }
}

// הפעל בוט כל 30 שניות
setInterval(runBot, 30000);
runBot();

app.listen(3001, () => console.log("הבוט פועל!"));