// Netlify Function (v2 / modern format) — Best Dress Collection
// GET  /api/place-order  -> returns configured delivery charges (public, non-secret)
// POST /api/place-order  -> validates an order and sends it to Telegram
//
// Required environment variables (Netlify -> Site configuration -> Environment variables):
//   TELEGRAM_BOT_TOKEN            (secret — from @BotFather)
//   TELEGRAM_CHAT_ID              (7809248639)
// Optional (defaults: inside Dhaka 70, outside Dhaka 150 — set these only to change them):
//   DELIVERY_CHARGE_INSIDE_DHAKA  (whole number, Taka)
//   DELIVERY_CHARGE_OUTSIDE_DHAKA (whole number, Taka)

// ---------- Fixed business rules (server is the source of truth) ----------
const PRODUCT_NAME = "গর্জিয়াস গোলাপ এমব্রয়ডারি বোরকা";
const UNIT_PRICE = 1150;
const MAX_QUANTITY = 10;
const SIZES = ["48", "50", "52", "54", "56"];
const AREAS = { inside: "ঢাকার ভিতরে", outside: "ঢাকার বাইরে" };
const PAYMENTS = { bkash: "bKash", nagad: "Nagad", cod: "Cash on Delivery" };

const PHONE_RE = /^01[3-9]\d{8}$/;
const TRX_RE = /^[A-Za-z0-9]{6,20}$/;
const ORDER_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_BODY_BYTES = 10 * 1024;

// ---------- Best-effort in-memory protection ----------
// NOTE: Netlify may run several function instances, so these Maps are per-instance
// (good enough for basic spam protection; use a database/Redis for strict limits).
const RATE_LIMIT_MAX = 5;               // orders per IP
const RATE_LIMIT_WINDOW_MS = 10 * 60e3; // per 10 minutes
const hits = new Map();                 // ip -> [timestamps]
const seenOrders = new Map();           // orderId -> timestamp
const SEEN_TTL_MS = 60 * 60e3;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (list.length >= RATE_LIMIT_MAX) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) { // simple cleanup
    for (const [k, v] of hits) if (!v.some(t => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(k);
  }
  return false;
}
function pruneSeen() {
  const now = Date.now();
  for (const [k, t] of seenOrders) if (now - t > SEEN_TTL_MS) seenOrders.delete(k);
}

// ---------- Helpers ----------
const json = (status, body, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });

// Delivery charges (Taka). Defaults below; an environment variable, if set, overrides them.
const DEFAULT_CHARGE_INSIDE_DHAKA = 70;
const DEFAULT_CHARGE_OUTSIDE_DHAKA = 150;

function readCharge(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 && n <= 5000 ? n : fallback;
}
function getCharges() {
  return {
    inside: readCharge("DELIVERY_CHARGE_INSIDE_DHAKA", DEFAULT_CHARGE_INSIDE_DHAKA),
    outside: readCharge("DELIVERY_CHARGE_OUTSIDE_DHAKA", DEFAULT_CHARGE_OUTSIDE_DHAKA),
  };
}

// Remove control chars, collapse whitespace, limit length.
const clean = (v, max) =>
  String(v ?? "").replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const toEnDigits = s => String(s).replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));

function normalizePhone(raw) {
  let p = toEnDigits(clean(raw, 20)).replace(/[\s\-().]/g, "");
  if (p.startsWith("+88")) p = p.slice(3);
  else if (p.startsWith("88") && p.length === 13) p = p.slice(2);
  return p;
}

const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const bn = (() => {
  try { const f = new Intl.NumberFormat("bn-BD"); return n => f.format(n); }
  catch { return n => String(n); }
})();
const taka = n => `${bn(n)} টাকা`;

function dhakaNow() {
  try {
    return new Date().toLocaleString("bn-BD", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date().toISOString();
  }
}

function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser or same-origin GET; other checks still apply
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

// ---------- Validation ----------
function validateOrder(input, charges) {
  const errors = [];
  const o = {};

  o.orderId = String(input.orderId ?? "");
  if (!ORDER_ID_RE.test(o.orderId)) errors.push("orderId");

  o.name = clean(input.name, 60);
  if (o.name.length < 2) errors.push("name");

  o.phone = normalizePhone(input.phone);
  if (!PHONE_RE.test(o.phone)) errors.push("phone");

  o.address = clean(input.address, 300);
  if (o.address.length < 10) errors.push("address");

  o.size = String(input.size ?? "");
  if (!SIZES.includes(o.size)) errors.push("size");

  o.quantity = Number(input.quantity);
  if (!Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > MAX_QUANTITY) errors.push("quantity");

  o.area = String(input.area ?? "");
  if (!Object.prototype.hasOwnProperty.call(AREAS, o.area)) errors.push("area");

  o.payment = String(input.payment ?? "");
  if (!Object.prototype.hasOwnProperty.call(PAYMENTS, o.payment)) errors.push("payment");

  o.trxId = "";
  if (o.payment === "bkash" || o.payment === "nagad") {
    o.trxId = clean(input.trxId, 20).toUpperCase();
    if (!TRX_RE.test(o.trxId)) errors.push("trxId");
  }

  o.notes = clean(input.notes, 300);

  if (errors.length) return { ok: false, errors };

  // Totals are always recalculated here — never trusted from the browser.
  o.unitPrice = UNIT_PRICE;
  o.subtotal = UNIT_PRICE * o.quantity;
  o.deliveryCharge = charges[o.area];
  o.total = o.subtotal + o.deliveryCharge;
  return { ok: true, order: o };
}

// ---------- Telegram ----------
function buildMessage(o) {
  const lines = [
    "🛍️ <b>নতুন অর্ডার — Best Dress Collection</b>",
    "",
    "📦 <b>পণ্যের নাম:</b>",
    escapeHtml(PRODUCT_NAME),
    "",
    "💰 <b>প্রতি পিস মূল্য:</b>",
    taka(o.unitPrice),
    "",
    "👤 <b>কাস্টমারের নাম:</b>",
    escapeHtml(o.name),
    "",
    "📱 <b>মোবাইল নম্বর:</b>",
    escapeHtml(o.phone),
    "",
    "🏠 <b>ডেলিভারি ঠিকানা:</b>",
    escapeHtml(o.address),
    "",
    "📍 <b>ডেলিভারি এলাকা:</b>",
    AREAS[o.area],
    "",
    "📏 <b>নির্বাচিত সাইজ:</b>",
    o.size === "48" ? "48 (বডি ফ্রি সাইজ)" : escapeHtml(o.size),
    "",
    "🔢 <b>পরিমাণ:</b>",
    bn(o.quantity),
    "",
    "💳 <b>পেমেন্ট মেথড:</b>",
    PAYMENTS[o.payment],
  ];
  if (o.trxId) {
    lines.push("", "🧾 <b>Transaction ID:</b>", `<code>${escapeHtml(o.trxId)}</code>`,
      "⚠️ <i>এই Transaction ID এখনো যাচাই করা হয়নি — পেমেন্ট ম্যানুয়ালি যাচাই করুন।</i>");
  }
  lines.push(
    "",
    "🚚 <b>ডেলিভারি চার্জ:</b>",
    taka(o.deliveryCharge),
    "",
    "💵 <b>সর্বমোট:</b>",
    taka(o.total)
  );
  if (o.payment === "cod") lines.push("(ডেলিভারির সময় পরিশোধযোগ্য)");
  if (o.notes) lines.push("", "📝 <b>অতিরিক্ত নির্দেশনা:</b>", escapeHtml(o.notes));
  lines.push("", "🕒 <b>অর্ডারের সময়:</b>", dhakaNow(), "", `🆔 <code>${escapeHtml(o.orderId)}</code>`);
  return lines.join("\n");
}

async function sendToTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram environment variables are not configured");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !data || data.ok !== true) {
      // Log only the status/description — never customer data or the token.
      throw new Error(`Telegram API error: ${res.status} ${data && data.description ? data.description : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Handler ----------
export default async (req, context) => {
  // Public config for the frontend (delivery charges are not secret).
  if (req.method === "GET") {
    const c = getCharges();
    return json(200, { inside: c.inside, outside: c.outside, configured: c.inside !== null && c.outside !== null });
  }

  if (req.method !== "POST") return json(405, { ok: false, message: "Method not allowed" }, { Allow: "GET, POST" });

  if (!sameOrigin(req)) return json(403, { ok: false, message: "অনুরোধটি অনুমোদিত নয়।" });

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return json(415, { ok: false, message: "অবৈধ অনুরোধ।" });

  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (rateLimited(ip)) {
    return json(429, { ok: false, message: "অল্প সময়ে অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।" }, { "Retry-After": "600" });
  }

  let input;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, message: "অনুরোধটি অনেক বড়।" });
    input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("bad body");
  } catch {
    return json(400, { ok: false, message: "অবৈধ অনুরোধ।" });
  }

  // Honeypot: bots fill hidden fields. Pretend success, send nothing.
  if (input.website) return json(200, { ok: true });

  // Very fast submissions are almost certainly bots.
  if (Number(input.elapsedMs) < 3000) {
    return json(400, { ok: false, message: "অনুগ্রহ করে ফর্মটি ঠিকভাবে পূরণ করে আবার চেষ্টা করুন।" });
  }

  const charges = getCharges();
  if (charges.inside === null || charges.outside === null) {
    console.error("Delivery charges are not configured (DELIVERY_CHARGE_INSIDE_DHAKA / DELIVERY_CHARGE_OUTSIDE_DHAKA).");
    return json(503, { ok: false, message: "ডেলিভারি চার্জ এখনো নির্ধারণ করা হয়নি। অনুগ্রহ করে পরে চেষ্টা করুন।" });
  }

  const result = validateOrder(input, charges);
  if (!result.ok) {
    return json(400, { ok: false, message: "ফর্মের তথ্যে ভুল আছে। অনুগ্রহ করে সব তথ্য সঠিকভাবে দিন।", fields: result.errors });
  }
  const order = result.order;

  // Duplicate protection (same orderId submitted twice).
  pruneSeen();
  if (seenOrders.has(order.orderId)) {
    return json(200, { ok: true, duplicate: true, total: order.total });
  }

  try {
    await sendToTelegram(buildMessage(order));
  } catch (err) {
    console.error("Order notification failed:", err.message);
    return json(502, { ok: false, message: "অর্ডার জমা দিতে সমস্যা হয়েছে।" });
  }

  seenOrders.set(order.orderId, Date.now());
  return json(200, { ok: true, total: order.total });
};

export const config = {
  path: "/api/place-order",
  method: ["GET", "POST"],
};
