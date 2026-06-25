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

// פקודת קנייה/מכירה
app.post("/order", async (req, res) => {
  try {
    const { symbol, side, quantity } = req.body;
    const r = await client.newOrder(symbol, side, "MARKET", { quantity });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () => console.log("הבוט פועל על פורט 3001"));