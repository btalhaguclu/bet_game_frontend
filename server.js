// server.js
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =====================
// In-memory veri (demo)
// =====================
let users = [];          // { id, name, token, points }
let dailyMatches = {};   // key: date YYYY-MM-DD -> [matches]
let coupons = [];        // { id, userId, date, items: [{matchId,prediction,odd}], locked, evaluated, gainedPoints }
let dailyResults = {};   // key: date YYYY-MM-DD -> { matchId: result }

// basit id generator
let nextUserId = 1;
let nextCouponId = 1;

function todayKey() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
}

// =====================
// Maç & Oran çekme
// =====================

// DEMO: gerçek API yerine random üreten fonksiyon
function generateDemoMatches(dateKey) {
    const POOL = [
        { league: "Süper Lig", home: "Galatasaray", away: "Fenerbahçe" },
        { league: "Süper Lig", home: "Beşiktaş", away: "Trabzonspor" },
        { league: "La Liga", home: "Real Madrid", away: "Barcelona" },
        { league: "Premier League", home: "Liverpool", away: "Manchester City" },
        { league: "Serie A", home: "Milan", away: "Inter" },
        { league: "Bundesliga", home: "Bayern Münih", away: "Dortmund" },
        { league: "Ligue 1", home: "PSG", away: "Lyon" },
        { league: "Eredivisie", home: "Ajax", away: "PSV" },
    ];

    function randOdd(min, max) {
        const v = min + Math.random() * (max - min);
        return Math.round(v * 100) / 100;
    }

    const shuffled = [...POOL].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 5);
    let id = 1;
    dailyMatches[dateKey] = selected.map(m => ({
        id: id++,
        league: m.league,
        home: m.home,
        away: m.away,
        odd1: randOdd(1.5, 2.6),
        oddX: randOdd(2.7, 3.8),
        odd2: randOdd(1.8, 3.1),
    }));
}

// *** GERÇEK API ENTEGRASYONU NOKTASI ***
// Bu fonksiyonu demo yerine gerçek API çağrısıyla değiştirebilirsin.
// Örnek: https://www.api-football.com/ (ücretsiz tier var, API key gerekir)
async function fetchRealMatchesFromApi(dateKey) {
    // ÖRNEK (pseudo kod):
    //
    // const apiKey = process.env.API_FOOTBALL_KEY;
    // const resp = await fetch(
    //   `https://v3.football.api-sports.io/fixtures?date=${dateKey}`,
    //   { headers: { "x-apisports-key": apiKey } }
    // );
    // const data = await resp.json();
    // dailyMatches[dateKey] = data.response.map((fx, idx) => ({
    //   id: idx + 1,
    //   league: fx.league.name,
    //   home: fx.teams.home.name,
    //   away: fx.teams.away.name,
    //   odd1: 2.0, // burada ayrıca odds endpoint'inden oran çekmen gerekir
    //   oddX: 3.2,
    //   odd2: 3.0
    // }));
    //
    // Şimdilik demo kullanıyoruz:
    generateDemoMatches(dateKey);
}

// =====================
// User endpoints
// =====================
app.post("/api/register", (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: "Name required" });
    }
    const trimmed = name.trim();
    // basit token
    const token = Math.random().toString(36).slice(2);
    const user = {
        id: nextUserId++,
        name: trimmed,
        token,
        points: 0
    };
    users.push(user);
    res.json({ token, name: user.name, points: user.points });
});

app.post("/api/login", (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const user = users.find(u => u.token === token);
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ token: user.token, name: user.name, points: user.points });
});

function authMiddleware(req, res, next) {
    const token = req.headers["x-auth-token"];
    if (!token) return res.status(401).json({ error: "No token" });
    const user = users.find(u => u.token === token);
    if (!user) return res.status(401).json({ error: "Invalid token" });
    req.user = user;
    next();
}

// =====================
// Maç listesi
// =====================
app.get("/api/matches/today", async (req, res) => {
    const dateKey = todayKey();

    if (!dailyMatches[dateKey]) {
        await fetchRealMatchesFromApi(dateKey);
    }

    res.json({ date: dateKey, matches: dailyMatches[dateKey] || [] });
});

// =====================
// Kupon endpoints
// =====================

// Kupon oluştur / güncelle (aynı gün için sadece 1 kupon)
app.post("/api/coupon", authMiddleware, (req, res) => {
    const user = req.user;
    const { items } = req.body; // [{matchId,prediction}]
    const dateKey = todayKey();

    if (!dailyMatches[dateKey]) {
        return res.status(400).json({ error: "No matches for today" });
    }

    let coupon = coupons.find(c => c.userId === user.id && c.date === dateKey);
    if (coupon && coupon.locked) {
        return res.status(400).json({ error: "Coupon already locked" });
    }

    const matches = dailyMatches[dateKey];

    const normalizedItems = (items || []).map(it => {
        const m = matches.find(mm => mm.id === it.matchId);
        if (!m) return null;
        let odd = 1.0;
        if (it.prediction === "1") odd = m.odd1;
        else if (it.prediction === "X") odd = m.oddX;
        else if (it.prediction === "2") odd = m.odd2;
        return {
            matchId: m.id,
            prediction: it.prediction,
            odd
        };
    }).filter(Boolean);

    if (normalizedItems.length === 0) {
        return res.status(400).json({ error: "No valid items" });
    }

    if (!coupon) {
        coupon = {
            id: nextCouponId++,
            userId: user.id,
            date: dateKey,
            items: normalizedItems,
            locked: false,
            evaluated: false,
            gainedPoints: 0
        };
        coupons.push(coupon);
    } else {
        coupon.items = normalizedItems;
    }

    res.json({ coupon });
});

// Kuponu kilitle (fişi kestir)
app.post("/api/coupon/lock", authMiddleware, (req, res) => {
    const user = req.user;
    const dateKey = todayKey();

    const coupon = coupons.find(c => c.userId === user.id && c.date === dateKey);
    if (!coupon) return res.status(404).json({ error: "No coupon for today" });
    if (coupon.locked) return res.status(400).json({ error: "Already locked" });

    coupon.locked = true;
    res.json({ coupon });
});

// Bugünün kuponunu çek
app.get("/api/coupon/today", authMiddleware, (req, res) => {
    const user = req.user;
    const dateKey = todayKey();
    const coupon = coupons.find(c => c.userId === user.id && c.date === dateKey);
    res.json({ coupon: coupon || null, date: dateKey });
});

// =====================
// Sonuç ve puanlama
// =====================

// DEMO: random sonuç üret
function generateDemoResultsForDay(dateKey) {
    const matches = dailyMatches[dateKey] || [];
    const resMap = {};
    matches.forEach(m => {
        const opts = ["1", "X", "2"];
        resMap[m.id] = opts[Math.floor(Math.random() * 3)];
    });
    dailyResults[dateKey] = resMap;
}

// Sonuçları çek ve kuponları değerlendir
app.post("/api/results/evaluate", authMiddleware, (req, res) => {
    const user = req.user;
    const dateKey = todayKey();

    if (!dailyMatches[dateKey]) {
        return res.status(400).json({ error: "No matches for today" });
    }

    if (!dailyResults[dateKey]) {
        generateDemoResultsForDay(dateKey);
        // Gerçek API kullanacaksan burada skor/sonuç çekip doldurursun.
    }

    const coupon = coupons.find(c => c.userId === user.id && c.date === dateKey);
    if (!coupon) {
        return res.status(400).json({ error: "No coupon to evaluate" });
    }
    if (!coupon.locked) {
        return res.status(400).json({ error: "Coupon must be locked first" });
    }
    if (coupon.evaluated) {
        return res.json({ message: "Already evaluated", coupon, results: dailyResults[dateKey] });
    }

    const results = dailyResults[dateKey];
    let allCorrect = true;
    coupon.items.forEach(it => {
        const resVal = results[it.matchId];
        if (!resVal || resVal !== it.prediction) allCorrect = false;
    });

    let gained = 0;
    if (allCorrect) {
        const totalOdd = coupon.items.reduce((p, c) => p * c.odd, 1);
        gained = Math.round(totalOdd * 10);
        coupon.gainedPoints = gained;
        user.points += gained;
    } else {
        coupon.gainedPoints = 0;
    }
    coupon.evaluated = true;

    res.json({
        coupon,
        results,
        gainedPoints: coupon.gainedPoints,
        totalPoints: user.points
    });
});

// =====================
// Leaderboard
// =====================
app.get("/api/leaderboard", (req, res) => {
    const sorted = [...users].sort((a, b) => b.points - a.points);
    res.json({ players: sorted.slice(0, 50) });
});

// Fallback: SPA / ana sayfa
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
