require("dotenv").config();
const express = require("express");
const Binance = require("binance").Binance;
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const client = new Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
});

// מחיר נוכחי
app.get("/price/:symbol", async (req, res) => {
  try {
    const prices = await client.prices({ symbol: req.params.symbol });
    res.json(prices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// יתרות
app.get("/balances", async (req, res) => {
  try {
    const info = await client.accountInfo();
    const balances = info.balances.filter(b => parseFloat(b.free) > 0);
    res.json(balances);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let lastPrice = null;

async function runBot() {
  try {
    const prices = await client.prices({ symbol: "BTCUSDT" });
    const price = parseFloat(prices.BTCUSDT);
    console.log("מחיר BTC: $" + price);

    if (lastPrice) {
      const change = ((price - lastPrice) / lastPrice) * 100;
      if (change < -0.5) console.log("אות קנייה! ירידה של " + change.toFixed(2) + "%");
      if (change > 1) console.log("אות מכירה! עלייה של " + change.toFixed(2) + "%");
    }
    lastPrice = price;
  } catch (e) {
    console.log("שגיאה:", e.message);
  }
}

setInterval(runBot, 30000);
runBot();

app.listen(3001, () => console.log("הבוט פועל!"));