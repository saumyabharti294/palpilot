import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { runTurn, resetSession, addNoteToAll, MODEL } from "./src/agent.js";
import { executeApproval, runTool } from "./src/tools.js";
import { paypal, isLive, simMarkInvoicePaid, simActivateSubscription, resetSim, verifyWebhook } from "./src/paypal.js";
import { ledger, approvals, getApproval, updateApproval, logEvent, resetAll } from "./src/store.js";
import { handlePayPalEvent, recordInvoicePaid, recordSubscription } from "./src/events.js";

const app = express();
const PORT = process.env.PORT || 3000;

// PayPal signs the exact bytes it sent, so this route must see the raw body.
app.post("/api/webhooks/paypal", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const raw = req.body.toString("utf8");
    if (!(await verifyWebhook(req.headers, raw))) return res.status(400).json({ error: "Invalid webhook signature" });
    handlePayPalEvent(JSON.parse(raw));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

app.use(express.json({ limit: "15mb" }));

// Only the buyer's side is public. Everything else belongs to the merchant.
const isBuyerRoute = (req) =>
  req.path === "/pay.html" ||
  req.path === "/logo.svg" ||
  req.path === "/return" ||
  (req.method === "GET" && req.path === "/api/config") ||
  /^\/api\/orders\/[^/]+(\/capture)?$/.test(req.path) ||
  req.path.startsWith("/api/sim/");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

function requireMerchant(req, res, next) {
  if (isBuyerRoute(req)) return next();
  // Browsers attach saved logins to cross-site posts, so a malicious page
  // could otherwise click Approve on the merchant's behalf.
  if (req.method !== "GET" && req.headers["sec-fetch-site"] === "cross-site") {
    return res.status(403).json({ error: "Cross-site request refused" });
  }
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === "production") return res.status(503).send("Set ADMIN_PASSWORD on the server to open the dashboard.");
    return next();
  }
  const [scheme, encoded = ""] = (req.headers.authorization ?? "").split(" ");
  const supplied = scheme === "Basic" ? Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":") : "";
  if (crypto.timingSafeEqual(sha256(supplied), sha256(password))) return next();
  res.set("WWW-Authenticate", 'Basic realm="PalPilot merchant", charset="UTF-8"').status(401).send("Login required");
}

app.use(requireMerchant);
app.use(express.static("public"));

app.get("/api/config", (_req, res) => {
  res.json({
    mode: isLive() ? (process.env.PAYPAL_ENV === "live" ? "live" : "sandbox") : "simulator",
    paypalClientId: isLive() ? process.env.PAYPAL_CLIENT_ID : null,
    palguardLimit: Number(process.env.PALGUARD_LIMIT || 500),
    aiReady: Boolean(process.env.GOOGLE_API_KEY),
  });
});

// Chat with the agent, streamed back to the browser as newline-delimited JSON events.
app.post("/api/chat", async (req, res) => {
  const { sessionId = "default", text = "", images = [] } = req.body ?? {};
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const emit = (e) => res.write(JSON.stringify(e) + "\n");
  try {
    await runTurn(sessionId, { text, images }, emit);
  } catch (err) {
    console.error(err);
    emit({ type: "error", message: err.message });
  }
  emit({ type: "done" });
  res.end();
});

app.post("/api/reset", (req, res) => {
  resetSession(req.body?.sessionId ?? "default");
  if (req.body?.wipeData) {
    resetAll();
    if (!isLive()) resetSim();
  }
  res.json({ ok: true });
});

app.get("/api/state", (_req, res) => {
  const L = ledger();
  const sum = (kinds) => L.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + Number(e.amount || 0), 0);
  const sentIds = new Set(L.filter((e) => e.kind === "invoice_sent").map((e) => e.invoice_id));
  const closedIds = new Set(L.filter((e) => e.kind === "invoice_paid" || e.kind === "invoice_cancelled").map((e) => e.invoice_id));
  const outstanding = L.filter((e) => e.kind === "invoice_sent" && !closedIds.has(e.invoice_id)).reduce((s, e) => s + Number(e.amount || 0), 0);
  res.json({
    stats: {
      collected: (sum(["checkout_paid", "invoice_paid"])).toFixed(2),
      outstanding: outstanding.toFixed(2),
      paidOut: sum(["payout_sent", "refund_issued"]).toFixed(2),
      pending: approvals().filter((a) => a.status === "PENDING").length,
      invoicesSent: sentIds.size,
    },
    approvals: approvals().slice(0, 30),
    ledger: L.slice(0, 60),
  });
});

// PalGuard decisions
app.post("/api/approvals/:id/approve", async (req, res) => {
  try {
    const a = await executeApproval(req.params.id);
    addNoteToAll(`${a.id} (${a.title}) was APPROVED by the merchant and executed. Result: ${JSON.stringify(a.result)}`);
    res.json(a);
  } catch (err) {
    const a = getApproval(req.params.id);
    if (a) addNoteToAll(`${a.id} (${a.title}) was approved but FAILED at PayPal: ${err.message}`);
    res.status(400).json({ error: err.message, approval: a });
  }
});

app.post("/api/approvals/:id/reject", (req, res) => {
  const a = getApproval(req.params.id);
  if (!a || a.status !== "PENDING") return res.status(400).json({ error: "Not pending" });
  updateApproval(a.id, { status: "REJECTED" });
  logEvent("approval_rejected", `PalGuard: rejected “${a.title}”`);
  addNoteToAll(`${a.id} (${a.title}) was REJECTED by the merchant. Do not retry it unless asked.`);
  res.json(getApproval(a.id));
});

// Buyer-facing pay page support (public/pay.html uses the PayPal JS SDK)
app.get("/api/orders/:id", async (req, res) => {
  try {
    res.json(await runTool("get_order_status", { order_id: req.params.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function captureOrder(orderId) {
  const o = await paypal("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
  const pu = o.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  const already = ledger().some((e) => e.kind === "checkout_paid" && e.order_id === orderId);
  if (!already) {
    logEvent("checkout_paid", `Payment received: ${cap?.amount?.currency_code} ${cap?.amount?.value}${pu?.description ? ` — ${pu.description}` : ""}`, {
      order_id: orderId, capture_id: cap?.id, amount: cap?.amount?.value, direction: "in",
    });
    addNoteToAll(`A buyer paid checkout order ${orderId}: ${cap?.amount?.currency_code} ${cap?.amount?.value}, capture id ${cap?.id}.`);
  }
  return { order_id: orderId, status: o.status, capture_id: cap?.id, amount: cap?.amount };
}

app.post("/api/orders/:id/capture", async (req, res) => {
  try {
    res.json(await captureOrder(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Return URL after a buyer approves on paypal.com
app.get("/return", async (req, res) => {
  try {
    if (req.query.type === "subscription" || req.query.subscription_id) {
      // The query string is visible to anyone, so ask PayPal what really happened.
      const id = String(req.query.subscription_id ?? "");
      if (!id) return res.status(400).send("Missing subscription id");
      const sub = await paypal("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
      if (!["ACTIVE", "APPROVED"].includes(sub.status)) return res.status(400).send("Subscription is not active");
      recordSubscription(sub.id);
      return res.redirect("/pay.html?done=subscription");
    }
    const r = await captureOrder(req.query.token);
    res.redirect(`/pay.html?done=order&order=${encodeURIComponent(r.order_id)}`);
  } catch (err) {
    res.status(400).send(`Could not capture payment: ${err.message}`);
  }
});

// Simulator-only helpers so the buyer side can be demoed without PayPal keys
app.get("/api/sim/invoices/:id", async (req, res) => {
  if (isLive()) return res.status(400).json({ error: "Live invoices are viewed on PayPal" });
  try {
    res.json(await paypal("GET", `/v2/invoicing/invoices/${req.params.id}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/sim/invoices/:id/pay", async (req, res) => {
  if (isLive()) return res.status(400).json({ error: "Live invoices are paid on PayPal" });
  try {
    const inv = simMarkInvoicePaid(req.params.id);
    recordInvoicePaid(inv);
    res.json(inv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/sim/subscriptions/:id/approve", (req, res) => {
  if (isLive()) return res.status(400).json({ error: "Live subscriptions are approved on PayPal" });
  try {
    recordSubscription(simActivateSubscription(req.params.id).id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  PalPilot is running → http://localhost:${PORT}`);
  console.log(`  PayPal: ${isLive() ? `${process.env.PAYPAL_ENV === "live" ? "LIVE" : "sandbox"} API` : "simulator (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for the sandbox)"}`);
  console.log(`  AI model: ${MODEL} (Google AI)`);
  console.log(`  Dashboard login: ${process.env.ADMIN_PASSWORD ? "on" : "OFF (set ADMIN_PASSWORD before exposing this server)"}\n`);
});
