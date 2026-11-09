// PayPal REST client (sandbox by default) with a built-in simulator so the
// app runs end-to-end even before PayPal credentials are configured.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export const isLive = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

/** The address buyers and PayPal should use to reach this app. */
export function appUrl() {
  const port = process.env.PORT || 3000;
  const configured = process.env.APP_URL;
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain, RENDER_EXTERNAL_URL: renderUrl } = process.env;
  // A localhost address is useless to buyers, so prefer the host's public address.
  if (!configured || /\/\/(localhost|127\.0\.0\.1)\b/.test(configured)) {
    if (renderUrl) return renderUrl;
    if (name && domain) return `https://${name}-${port}.${domain}`;
  }
  return configured || `http://localhost:${port}`;
}

export class PayPalError extends Error {
  constructor(status, body) {
    const detail =
      body?.details?.map((d) => `${d.field ?? ""} ${d.issue ?? ""} ${d.description ?? ""}`.trim()).join("; ") ||
      body?.message ||
      body?.error_description ||
      JSON.stringify(body);
    super(`PayPal ${status}: ${body?.name ?? body?.error ?? "ERROR"} — ${detail}`);
    this.status = status;
    this.body = body;
  }
}

let cachedToken = null;

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json();
  if (!res.ok) throw new PayPalError(res.status, body);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

/** Make a PayPal REST call. Falls back to the simulator when no credentials are set. */
export async function paypal(method, path, body) {
  if (!isLive()) return simulate(method, path, body);
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? safeJson(text) : {};
  if (!res.ok) throw new PayPalError(res.status, json);
  return json;
}

const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
};

/** Ask PayPal whether a webhook delivery is genuine. rawBody is spliced in unparsed to keep the signed bytes intact. */
export async function verifyWebhook(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!isLive() || !webhookId) return false;
  const fields = [];
  for (const [field, header] of Object.entries(WEBHOOK_HEADERS)) {
    if (!headers[header]) return false;
    fields.push(`${JSON.stringify(field)}:${JSON.stringify(headers[header])}`);
  }
  const token = await getToken();
  const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: `{${fields.join(",")},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`,
  });
  if (!res.ok) return false;
  return (await res.json()).verification_status === "SUCCESS";
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

// ---------------------------------------------------------------------------
// Simulator: a small in-memory imitation of the sandbox endpoints PalPilot uses.
// Shapes follow the real API responses closely enough for the agent and UI.
// ---------------------------------------------------------------------------
const SIM_FILE = path.resolve("data/simulator.json");
const SIM_KEYS = ["invoices", "orders", "captures", "products", "plans", "subs", "payouts"];
const sim = loadSim();

function loadSim() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SIM_FILE, "utf8"));
  } catch {}
  const s = { seq: raw.seq ?? 1000 };
  for (const k of SIM_KEYS) s[k] = new Map(Object.entries(raw[k] ?? {}));
  return s;
}

function saveSim() {
  const out = { seq: sim.seq };
  for (const k of SIM_KEYS) out[k] = Object.fromEntries(sim[k]);
  fs.mkdirSync(path.dirname(SIM_FILE), { recursive: true });
  fs.writeFileSync(SIM_FILE, JSON.stringify(out));
}

/** Mark a simulated invoice paid (used by the simulator-only buyer page). */
export function simMarkInvoicePaid(invoiceId) {
  const inv = sim.invoices.get(invoiceId);
  if (!inv) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Invoice not found (simulator)" });
  inv.status = "PAID";
  saveSim();
  return inv;
}

/** Mark a simulated subscription approved by its buyer. */
export function simActivateSubscription(subId) {
  const sub = sim.subs.get(subId);
  if (!sub) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Subscription not found (simulator)" });
  sub.status = "ACTIVE";
  saveSim();
  return sub;
}

export function resetSim() {
  for (const k of SIM_KEYS) sim[k].clear();
  saveSim();
}
const id = (prefix, n = 17) => prefix + crypto.randomBytes(16).toString("hex").toUpperCase().slice(0, n);
const total = (items = []) =>
  items.reduce((s, it) => s + Number(it.unit_amount?.value || 0) * Number(it.quantity || 1), 0).toFixed(2);

function simulate(method, p, body) {
  const result = simulateRoute(method, p, body);
  if (method !== "GET") saveSim();
  return structuredClone(result);
}

function simulateRoute(method, path, body) {
  const url = new URL(path, "http://sim");
  const p = url.pathname;
  let m;

  // Invoicing v2
  if (method === "POST" && p === "/v2/invoicing/invoices") {
    const inv = {
      id: id("INV2-", 19),
      status: "DRAFT",
      detail: { ...body.detail, invoice_number: String(++sim.seq), invoice_date: new Date().toISOString().slice(0, 10) },
      primary_recipients: body.primary_recipients,
      items: body.items,
      amount: { currency_code: body.detail.currency_code, value: total(body.items) },
    };
    sim.invoices.set(inv.id, inv);
    return inv;
  }
  if (method === "GET" && p === "/v2/invoicing/invoices") {
    const items = [...sim.invoices.values()].reverse();
    return { total_items: items.length, items };
  }
  if ((m = p.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/)) && method === "GET") {
    const inv = sim.invoices.get(m[1]);
    if (!inv) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Invoice not found (simulator)" });
    return inv;
  }
  if ((m = p.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/(send|remind|cancel)$/))) {
    const inv = sim.invoices.get(m[1]);
    if (!inv) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Invoice not found (simulator)" });
    if (m[2] === "send") {
      inv.status = "SENT";
      inv.detail.metadata = { recipient_view_url: `${appUrl()}/pay.html?invoice=${inv.id}` };
      return { href: inv.detail.metadata.recipient_view_url, rel: "payer-view", method: "GET" };
    }
    if (m[2] === "cancel") inv.status = "CANCELLED";
    return {};
  }

  // Orders v2
  if (method === "POST" && p === "/v2/checkout/orders") {
    const o = { id: id("SIM"), status: "PAYER_ACTION_REQUIRED", intent: body.intent, purchase_units: body.purchase_units, create_time: new Date().toISOString() };
    o.links = [{ rel: "payer-action", href: `${appUrl()}/pay.html?order=${o.id}`, method: "GET" }];
    sim.orders.set(o.id, o);
    return o;
  }
  if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === "GET") {
    const o = sim.orders.get(m[1]);
    if (!o) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Order not found (simulator)" });
    return o;
  }
  if ((m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
    const o = sim.orders.get(m[1]);
    if (!o) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Order not found (simulator)" });
    const cap = { id: id("CAP"), status: "COMPLETED", amount: o.purchase_units[0].amount };
    sim.captures.set(cap.id, cap);
    o.status = "COMPLETED";
    o.payer = { name: { given_name: "Sandbox", surname: "Buyer" }, email_address: "buyer@example.com" };
    o.purchase_units[0].payments = { captures: [cap] };
    return o;
  }

  // Payments v2 — captures and refunds
  if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)$/)) && method === "GET") {
    const cap = sim.captures.get(m[1]);
    if (!cap) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Capture not found (simulator)" });
    return cap;
  }
  if ((m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) {
    const cap = sim.captures.get(m[1]);
    if (!cap) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Capture not found (simulator)" });
    return { id: id("REF"), status: "COMPLETED", amount: body?.amount ?? cap.amount };
  }

  // Payouts v1
  if (method === "POST" && p === "/v1/payments/payouts") {
    const batch = { batch_header: { payout_batch_id: id("PB"), batch_status: "PENDING", sender_batch_header: body.sender_batch_header } };
    sim.payouts.set(batch.batch_header.payout_batch_id, batch);
    return batch;
  }

  // Catalog + Subscriptions
  if (method === "POST" && p === "/v1/catalogs/products") {
    const prod = { id: id("PROD-"), ...body };
    sim.products.set(prod.id, prod);
    return prod;
  }
  if (method === "POST" && p === "/v1/billing/plans") {
    const plan = { id: id("P-", 24), status: "ACTIVE", ...body };
    sim.plans.set(plan.id, plan);
    return plan;
  }
  if (method === "POST" && p === "/v1/billing/subscriptions") {
    const sub = { id: id("I-", 12), status: "APPROVAL_PENDING", plan_id: body.plan_id };
    sub.links = [{ rel: "approve", href: `${appUrl()}/pay.html?subscription=${sub.id}`, method: "GET" }];
    sim.subs.set(sub.id, sub);
    return sub;
  }
  if ((m = p.match(/^\/v1\/billing\/subscriptions\/([^/]+)$/)) && method === "GET") {
    const sub = sim.subs.get(m[1]);
    if (!sub) throw new PayPalError(404, { name: "RESOURCE_NOT_FOUND", message: "Subscription not found (simulator)" });
    return sub;
  }

  // Reporting
  if (method === "GET" && p === "/v1/reporting/transactions") {
    const txns = [...sim.orders.values()]
      .filter((o) => o.status === "COMPLETED")
      .map((o) => ({
        transaction_info: {
          transaction_id: o.purchase_units[0].payments.captures[0].id,
          transaction_amount: o.purchase_units[0].amount,
          transaction_status: "S",
          transaction_initiation_date: o.create_time,
          transaction_subject: o.purchase_units[0].description,
        },
      }));
    return { transaction_details: txns, total_items: txns.length };
  }

  throw new PayPalError(501, { name: "NOT_SIMULATED", message: `${method} ${p} is not simulated` });
}
