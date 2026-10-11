require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");
const db = require("./src-db");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const PORT = Number(process.env.PORT || 3000);
const OWNER_ID = process.env.OWNER_DISCORD_ID || "1277871426216529953";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET. Copy .env.example to .env and configure it.");
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: path.join(__dirname, "data") }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "سجّل الدخول عبر Discord أولاً." });
  next();
}
function requireOwner(req, res, next) {
  if (!req.session.user || req.session.user.id !== OWNER_ID) {
    return res.status(403).json({ error: "هذا الإجراء متاح لمالك الموقع فقط." });
  }
  next();
}
function getDiscordConfig() {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    throw new Error("Discord OAuth is not configured. Fill in the Discord values in .env.");
  }
  return { clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET, redirectUri: DISCORD_REDIRECT_URI };
}

app.get("/auth/discord", (req, res) => {
  let cfg;
  try { cfg = getDiscordConfig(); } catch (e) { return res.status(503).send(e.message); }
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const cfg = getDiscordConfig();
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send("OAuth state check failed. Please try signing in again.");
    }
    delete req.session.oauthState;
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: cfg.redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) return res.status(401).send("Discord sign-in failed.");

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) return res.status(401).send("Could not retrieve your Discord account.");

    db.prepare(`INSERT INTO users (id, username, avatar, coins, created_at)
      VALUES (?, ?, ?, 0, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar`)
      .run(user.id, user.global_name || user.username, user.avatar || null);

    req.session.user = { id: user.id, username: user.global_name || user.username, avatar: user.avatar || null };
    res.redirect("/");
  } catch (e) {
    console.error("Discord callback error:", e.message);
    res.status(500).send("Login setup error. Check server configuration.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const user = db.prepare("SELECT id, username, avatar, coins FROM users WHERE id=?").get(req.session.user.id);
  res.json({ loggedIn: true, user, isOwner: req.session.user.id === OWNER_ID });
});

app.get("/api/owner/users", requireOwner, (req, res) => {
  const users = db.prepare("SELECT id, username, coins, created_at FROM users ORDER BY coins DESC LIMIT 200").all();
  res.json({ users });
});

// Only the configured owner ID may grant coins. Amounts must be positive integers.
app.post("/api/owner/coins/grant", requireOwner, (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || "Owner grant").trim().slice(0, 200);
  if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: "Discord ID غير صالح." });
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
    return res.status(400).json({ error: "الكمية يجب أن تكون عددًا صحيحًا بين 1 و1,000,000." });
  }
  const target = db.prepare("SELECT id FROM users WHERE id=?").get(userId);
  if (!target) return res.status(404).json({ error: "يجب أن يسجّل العضو الدخول للموقع أولاً." });
  const grant = db.transaction(() => {
    db.prepare("UPDATE users SET coins=coins+? WHERE id=?").run(amount, userId);
    db.prepare(`INSERT INTO coin_transactions (user_id, actor_id, amount, reason, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))`).run(userId, req.session.user.id, amount, reason);
  });
  grant();
  res.json({ ok: true, message: `تمت إضافة ${amount} كوينز.` });
});

app.get("/api/owner/coins/log", requireOwner, (req, res) => {
  const rows = db.prepare(`SELECT user_id, actor_id, amount, reason, created_at
    FROM coin_transactions ORDER BY id DESC LIMIT 100`).all();
  res.json({ transactions: rows });
});

app.get("/api/owner/orders", requireOwner, (req, res) => {
  const orders = db.prepare(`SELECT panel_orders.id, panel_orders.user_id, users.username,
    panel_orders.plan_key, panel_orders.cost, panel_orders.status, panel_orders.created_at
    FROM panel_orders
    LEFT JOIN users ON users.id = panel_orders.user_id
    ORDER BY panel_orders.id DESC LIMIT 100`).all();
  res.json({ orders });
});

// Purchases deduct coins atomically. This starter records a panel purchase request;
// it does NOT run uploaded bot code or provision a real server.
app.post("/api/panels/purchase", requireLogin, (req, res) => {
  const plans = { starter: { cost: 100, label: "Starter Panel" }, standard: { cost: 250, label: "Standard Panel" } };
  const planKey = String(req.body.plan || "");
  const plan = plans[planKey];
  if (!plan) return res.status(400).json({ error: "الباقة غير معروفة." });
  const purchase = db.transaction(() => {
    const user = db.prepare("SELECT coins FROM users WHERE id=?").get(req.session.user.id);
    if (!user || user.coins < plan.cost) throw new Error("INSUFFICIENT_COINS");
    db.prepare("UPDATE users SET coins=coins-? WHERE id=?").run(plan.cost, req.session.user.id);
    db.prepare(`INSERT INTO coin_transactions (user_id, actor_id, amount, reason, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))`).run(req.session.user.id, req.session.user.id, -plan.cost, `Purchase: ${plan.label}`);
    db.prepare(`INSERT INTO panel_orders (user_id, plan_key, cost, status, created_at)
      VALUES (?, ?, ?, 'pending', datetime('now'))`).run(req.session.user.id, planKey, plan.cost);
  });
  try { purchase(); } catch (e) {
    if (e.message === "INSUFFICIENT_COINS") return res.status(400).json({ error: "رصيدك من الكوينزات غير كافٍ." });
    console.error(e);
    return res.status(500).json({ error: "تعذر إتمام الشراء." });
  }
  res.json({ ok: true, message: "تم تسجيل طلب الشراء. لم يتم إنشاء خادم فعلي بعد." });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "Nexora Host", baseUrl: BASE_URL }));
app.listen(PORT, () => console.log(`Nexora Host starter listening on ${BASE_URL}`));

// Optional Discord bot: the website still starts if DISCORD_BOT_TOKEN is not configured.
require("./bot.js");
