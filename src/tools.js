// PayPal tools exposed to the Gemini agent.
// Read-only and "draft" tools run immediately. Anything that moves money or
// contacts a customer goes to the PalGuard approval queue instead.
import crypto from "node:crypto";
import { paypal, appUrl } from "./paypal.js";
import { logEvent, ledger, addApproval, approvals, getApproval, updateApproval } from "./store.js";

const LIMIT = () => Number(process.env.PALGUARD_LIMIT || 500);
const money = (v) => Number(v).toFixed(2);
const cur = (c) => (c || "USD").toUpperCase();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** Reject anything that isn't a positive amount with at most two decimals. */
function validAmount(v, label = "amount") {
  const s = String(v ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
    throw new Error(`Invalid ${label} "${v}": use a positive decimal such as "125.00"`);
  }
  return s;
}

function validEmail(v) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ""))) throw new Error(`Invalid email address "${v}"`);
  return v;
}

const moneyProp = { type: "string", description: "Decimal amount as a string, e.g. \"125.00\"" };
const currencyProp = { type: "string", description: "ISO-4217 code, default USD" };

export const toolDefinitions = [
  {
    name: "create_invoice",
    description:
      "Create a DRAFT PayPal invoice (Invoicing API v2). Drafts are not sent to the customer; call send_invoice afterwards to request sending. Use when the merchant wants to bill someone.",
    input_schema: {
      type: "object",
      properties: {
        recipient_name: { type: "string" },
        recipient_email: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number" },
              unit_amount: moneyProp,
            },
            required: ["name", "quantity", "unit_amount"],
          },
        },
        currency: currencyProp,
        due_in_days: { type: "integer", description: "Days until payment is due (default 14)" },
        note: { type: "string", description: "Friendly note shown to the customer" },
      },
      required: ["recipient_name", "recipient_email", "items"],
    },
  },
  {
    name: "list_invoices",
    description: "List recent PayPal invoices with status (DRAFT, SENT, PAID, CANCELLED, ...) and amounts. Use to find unpaid or overdue invoices.",
    input_schema: { type: "object", properties: { page_size: { type: "integer", description: "1-50, default 20" } } },
  },
  {
    name: "get_invoice",
    description: "Get full details of one PayPal invoice by id.",
    input_schema: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
  },
  {
    name: "send_invoice",
    description: "Request that a draft invoice be emailed to the customer. Queued for merchant approval in PalGuard; not sent until approved.",
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, reason: { type: "string", description: "One sentence on why this should be sent" } },
      required: ["invoice_id", "reason"],
    },
  },
  {
    name: "send_payment_reminder",
    description: "Request a payment reminder email for a SENT, unpaid invoice. Queued for merchant approval in PalGuard. Write the reminder note yourself — polite, short, specific.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
        subject: { type: "string" },
        note: { type: "string" },
        reason: { type: "string" },
      },
      required: ["invoice_id", "subject", "note", "reason"],
    },
  },
  {
    name: "cancel_invoice",
    description: "Request cancellation of a sent invoice. Queued for merchant approval in PalGuard.",
    input_schema: {
      type: "object",
      properties: { invoice_id: { type: "string" }, note: { type: "string" }, reason: { type: "string" } },
      required: ["invoice_id", "reason"],
    },
  },
  {
    name: "create_checkout_link",
    description:
      "Create a one-off PayPal checkout (Orders API v2, intent CAPTURE) and return a shareable payment link. The payment is captured automatically after the buyer approves. Safe: no money moves until a buyer pays.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What the buyer is paying for" },
        amount: moneyProp,
        currency: currencyProp,
      },
      required: ["description", "amount"],
    },
  },
  {
    name: "get_order_status",
    description: "Check the status of a PayPal checkout order, including capture ids needed for refunds.",
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "create_subscription_plan",
    description:
      "Set up recurring billing: creates a PayPal catalog product, a billing plan, and a subscribe link (Subscriptions API v1).",
    input_schema: {
      type: "object",
      properties: {
        product_name: { type: "string" },
        product_description: { type: "string" },
        price: moneyProp,
        currency: currencyProp,
        interval: { type: "string", enum: ["DAY", "WEEK", "MONTH", "YEAR"] },
        trial_days: { type: "integer", description: "Optional free trial length in days (0 for none)" },
      },
      required: ["product_name", "price", "interval"],
    },
  },
  {
    name: "send_payouts",
    description:
      "Request to pay one or more people by email (Payouts API v1), e.g. contractors, affiliates, or splitting revenue. Queued for merchant approval in PalGuard.",
    input_schema: {
      type: "object",
      properties: {
        payouts: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              amount: moneyProp,
              note: { type: "string" },
            },
            required: ["email", "amount"],
          },
        },
        currency: currencyProp,
        email_subject: { type: "string" },
        reason: { type: "string" },
      },
      required: ["payouts", "reason"],
    },
  },
  {
    name: "refund_payment",
    description:
      "Request a full or partial refund of a captured payment (Payments API v2). Needs a capture id (get it from get_order_status). Queued for merchant approval in PalGuard.",
    input_schema: {
      type: "object",
      properties: {
        capture_id: { type: "string" },
        amount: { type: "string", description: "Partial refund amount; omit for a full refund" },
        currency: currencyProp,
        note_to_payer: { type: "string" },
        reason: { type: "string" },
      },
      required: ["capture_id", "reason"],
    },
  },
  {
    name: "search_transactions",
    description:
      "Search PayPal transaction history (Transaction Search API) for the last N days (max 31). Some sandbox accounts lack this permission; if it fails, fall back to get_activity_log.",
    input_schema: { type: "object", properties: { days_back: { type: "integer" } } },
  },
  {
    name: "get_activity_log",
    description:
      "Read PalPilot's own ledger of everything created, sent, paid, refunded or paid out, plus PalGuard approval statuses. Good for summaries, cash-flow questions and follow-ups.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
];

// ---------------------------------------------------------------- PalGuard
// Deterministic risk checks; the agent's stated reason is shown alongside.
function palguardAssess(kind, { amount = 0, recipients = [], dedupeKey }) {
  const flags = [];
  let level = "low";
  const bump = (l) => (level = ["low", "medium", "high"].indexOf(l) > ["low", "medium", "high"].indexOf(level) ? l : level);

  if (amount >= LIMIT()) {
    flags.push(`Amount ${money(amount)} is at or above your ${money(LIMIT())} review limit`);
    bump("high");
  }
  const known = new Set(ledger().flatMap((e) => e.recipients ?? []));
  const fresh = recipients.filter((r) => r && !known.has(r.toLowerCase()));
  if (fresh.length && (kind === "payout")) {
    flags.push(`First payment to: ${fresh.join(", ")}`);
    bump("medium");
  }
  const dayAgo = Date.now() - 86400000;
  const dup = approvals().find(
    (a) =>
      a.kind === kind &&
      a.status !== "REJECTED" &&
      Date.parse(a.createdAt) > dayAgo &&
      Number(a.amount) === Number(amount) &&
      JSON.stringify(a.recipients) === JSON.stringify(recipients) &&
      a.dedupeKey === dedupeKey,
  );
  if (dup && amount > 0) {
    flags.push(`Looks like a duplicate of ${dup.id} from the last 24h`);
    bump("high");
  }
  if (kind === "refund") {
    flags.push("Refunds send money back to the buyer");
    bump("medium");
  }
  if (!flags.length) flags.push("No risk signals found");
  return { level, flags };
}

function queue(kind, title, params, { amount = 0, currency = "USD", recipients = [], reason, dedupeKey }) {
  const risk = palguardAssess(kind, { amount, recipients, dedupeKey });
  const a = addApproval({ kind, title, params, amount: money(amount), currency, recipients, reason, risk, dedupeKey });
  logEvent("approval_requested", `PalGuard: ${title}`, { approvalId: a.id });
  return {
    status: "PENDING_APPROVAL",
    approval_id: a.id,
    risk_level: risk.level,
    risk_flags: risk.flags,
    message: "Queued in PalGuard. The merchant must approve it in the PalGuard panel before anything happens.",
  };
}

// Execute an approved PalGuard action against PayPal.
export async function executeApproval(id) {
  const a = getApproval(id);
  if (!a) throw new Error("Unknown approval");
  if (a.status !== "PENDING") throw new Error(`Approval is already ${a.status}`);
  updateApproval(id, { status: "EXECUTING" });
  try {
    const p = a.params;
    let result;
    if (a.kind === "send_invoice") {
      await paypal("POST", `/v2/invoicing/invoices/${p.invoice_id}/send`, { send_to_invoicer: true });
      const inv = await paypal("GET", `/v2/invoicing/invoices/${p.invoice_id}`);
      result = { invoice_id: p.invoice_id, status: inv.status, pay_url: inv.detail?.metadata?.recipient_view_url };
      logEvent("invoice_sent", `Invoice ${inv.detail?.invoice_number ?? p.invoice_id} sent`, { ...result, amount: a.amount, recipients: a.recipients });
    } else if (a.kind === "reminder") {
      await paypal("POST", `/v2/invoicing/invoices/${p.invoice_id}/remind`, { subject: p.subject, note: p.note, send_to_invoicer: false });
      result = { invoice_id: p.invoice_id, reminded: true };
      logEvent("reminder_sent", `Reminder sent for ${p.invoice_id}`, result);
    } else if (a.kind === "cancel_invoice") {
      await paypal("POST", `/v2/invoicing/invoices/${p.invoice_id}/cancel`, { note: p.note || "Cancelled", send_to_recipient: true });
      result = { invoice_id: p.invoice_id, cancelled: true };
      logEvent("invoice_cancelled", `Invoice ${p.invoice_id} cancelled`, result);
    } else if (a.kind === "payout") {
      const batch = await paypal("POST", "/v1/payments/payouts", {
        sender_batch_header: { sender_batch_id: "palpilot_" + crypto.randomUUID(), email_subject: p.email_subject || "You have a payment" },
        items: p.payouts.map((x, i) => ({
          recipient_type: "EMAIL",
          receiver: x.email,
          amount: { value: money(x.amount), currency: a.currency },
          note: x.note || "Thanks!",
          sender_item_id: `item_${i + 1}`,
        })),
      });
      result = { payout_batch_id: batch.batch_header.payout_batch_id, batch_status: batch.batch_header.batch_status };
      logEvent("payout_sent", `Paid out ${a.currency} ${a.amount} to ${a.recipients.length} recipient(s)`, { ...result, amount: a.amount, direction: "out", recipients: a.recipients.map((r) => r.toLowerCase()) });
    } else if (a.kind === "refund") {
      const body = { note_to_payer: p.note_to_payer || "Refund from PalPilot merchant" };
      if (p.amount) body.amount = { value: money(p.amount), currency_code: a.currency };
      const r = await paypal("POST", `/v2/payments/captures/${p.capture_id}/refund`, body);
      result = { refund_id: r.id, status: r.status, amount: r.amount };
      logEvent("refund_issued", `Refund ${r.status} for capture ${p.capture_id}`, { ...result, direction: "out", amount: r.amount?.value ?? a.amount });
    }
    updateApproval(id, { status: "EXECUTED", result });
    return getApproval(id);
  } catch (err) {
    updateApproval(id, { status: "FAILED", error: err.message });
    logEvent("error", `PalGuard ${a.id} failed: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------- executors
const handlers = {
  async create_invoice(i) {
    const [given, ...rest] = i.recipient_name.trim().split(/\s+/);
    const currency = cur(i.currency);
    validEmail(i.recipient_email);
    for (const it of i.items) {
      validAmount(it.unit_amount, `price for "${it.name}"`);
      if (!(Number(it.quantity ?? 1) > 0)) throw new Error(`Invalid quantity for "${it.name}": ${it.quantity}`);
    }
    const inv = await paypal("POST", "/v2/invoicing/invoices", {
      detail: {
        currency_code: currency,
        note: i.note || "Thank you for your business!",
        payment_term: { due_date: daysFromNow(i.due_in_days ?? 14) },
      },
      primary_recipients: [
        { billing_info: { name: { given_name: given, surname: rest.join(" ") || undefined }, email_address: i.recipient_email } },
      ],
      items: i.items.map((it) => ({
        name: it.name,
        description: it.description,
        quantity: String(it.quantity ?? 1),
        unit_amount: { currency_code: currency, value: money(it.unit_amount) },
        unit_of_measure: "QUANTITY",
      })),
    });
    const totalValue = inv.amount?.value ?? money(i.items.reduce((s, it) => s + Number(it.unit_amount) * Number(it.quantity ?? 1), 0));
    logEvent("invoice_draft", `Draft invoice for ${i.recipient_name}: ${currency} ${totalValue}`, {
      invoice_id: inv.id, amount: totalValue, recipients: [i.recipient_email.toLowerCase()],
    });
    return { invoice_id: inv.id, invoice_number: inv.detail?.invoice_number, status: inv.status, total: `${currency} ${totalValue}`, due_date: inv.detail?.payment_term?.due_date };
  },

  async list_invoices(i) {
    const r = await paypal("GET", `/v2/invoicing/invoices?page=1&page_size=${Math.min(i.page_size ?? 20, 50)}&total_required=true`);
    return {
      total: r.total_items,
      invoices: (r.items ?? []).map((v) => ({
        invoice_id: v.id,
        number: v.detail?.invoice_number,
        status: v.status,
        recipient: v.primary_recipients?.[0]?.billing_info?.email_address,
        amount: v.amount ? `${v.amount.currency_code} ${v.amount.value}` : undefined,
        due_date: v.detail?.payment_term?.due_date,
        invoice_date: v.detail?.invoice_date,
      })),
    };
  },

  async get_invoice(i) {
    return paypal("GET", `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}`);
  },

  async send_invoice(i) {
    const inv = await paypal("GET", `/v2/invoicing/invoices/${encodeURIComponent(i.invoice_id)}`);
    const email = inv.primary_recipients?.[0]?.billing_info?.email_address;
    const amt = Number(inv.amount?.value ?? 0);
    return queue("send_invoice", `Send invoice ${inv.detail?.invoice_number ?? i.invoice_id} (${inv.amount?.currency_code ?? "USD"} ${money(amt)}) to ${email}`, i, {
      amount: amt, currency: inv.amount?.currency_code, recipients: [email], reason: i.reason,
    });
  },

  async send_payment_reminder(i) {
    return queue("reminder", `Remind customer about invoice ${i.invoice_id}: “${i.subject}”`, i, { reason: i.reason });
  },

  async cancel_invoice(i) {
    return queue("cancel_invoice", `Cancel invoice ${i.invoice_id}`, i, { reason: i.reason });
  },

  async create_checkout_link(i) {
    const currency = cur(i.currency);
    validAmount(i.amount);
    const order = await paypal("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ description: i.description.slice(0, 127), amount: { currency_code: currency, value: money(i.amount) } }],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: `${appUrl()}/return`,
            cancel_url: `${appUrl()}/?cancelled=1`,
          },
        },
      },
    });
    const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    const page = `${appUrl()}/pay.html?order=${order.id}`;
    logEvent("checkout_created", `Checkout link: ${i.description} — ${currency} ${money(i.amount)}`, { order_id: order.id, amount: money(i.amount), pay_url: page });
    return { order_id: order.id, status: order.status, shareable_pay_page: page, paypal_approve_url: approve };
  },

  async get_order_status(i) {
    const o = await paypal("GET", `/v2/checkout/orders/${encodeURIComponent(i.order_id)}`);
    const pu = o.purchase_units?.[0];
    return {
      order_id: o.id,
      status: o.status,
      amount: pu?.amount,
      description: pu?.description,
      payer: o.payer,
      captures: pu?.payments?.captures?.map((c) => ({ capture_id: c.id, status: c.status, amount: c.amount })),
    };
  },

  async create_subscription_plan(i) {
    const currency = cur(i.currency);
    validAmount(i.price, "price");
    const product = await paypal("POST", "/v1/catalogs/products", {
      name: i.product_name.slice(0, 127),
      description: (i.product_description || i.product_name).slice(0, 256),
      type: "SERVICE",
    });
    const cycles = [];
    if (i.trial_days > 0) {
      cycles.push({ frequency: { interval_unit: "DAY", interval_count: i.trial_days }, tenure_type: "TRIAL", sequence: 1, total_cycles: 1 });
    }
    cycles.push({
      frequency: { interval_unit: i.interval, interval_count: 1 },
      tenure_type: "REGULAR",
      sequence: cycles.length + 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: money(i.price), currency_code: currency } },
    });
    const plan = await paypal("POST", "/v1/billing/plans", {
      product_id: product.id,
      name: `${i.product_name} — ${i.interval.toLowerCase()}ly`,
      billing_cycles: cycles,
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    });
    const sub = await paypal("POST", "/v1/billing/subscriptions", {
      plan_id: plan.id,
      application_context: { return_url: `${appUrl()}/return?type=subscription`, cancel_url: `${appUrl()}/?cancelled=1`, user_action: "SUBSCRIBE_NOW" },
    });
    const link = sub.links?.find((l) => l.rel === "approve")?.href;
    logEvent("plan_created", `Subscription plan “${i.product_name}”: ${currency} ${money(i.price)}/${i.interval.toLowerCase()}`, { plan_id: plan.id, pay_url: link });
    return { product_id: product.id, plan_id: plan.id, plan_status: plan.status, subscribe_link: link };
  },

  async send_payouts(i) {
    const currency = cur(i.currency);
    for (const p of i.payouts) {
      validEmail(p.email);
      validAmount(p.amount, `payout to ${p.email}`);
    }
    const sum = i.payouts.reduce((s, p) => s + Number(p.amount), 0);
    const emails = i.payouts.map((p) => p.email);
    return queue("payout", `Pay out ${currency} ${money(sum)} to ${emails.join(", ")}`, i, {
      amount: sum, currency, recipients: emails, reason: i.reason,
    });
  },

  async refund_payment(i) {
    // Look the capture up so a full refund is risk-checked at its real value.
    const cap = await paypal("GET", `/v2/payments/captures/${encodeURIComponent(i.capture_id)}`);
    const captured = Number(cap.amount?.value);
    const currency = cap.amount?.currency_code ?? cur(i.currency);
    const amount = i.amount ? Number(validAmount(i.amount)) : captured;
    if (!(amount > 0)) throw new Error(`Could not read the captured amount for ${i.capture_id}`);
    if (amount > captured) throw new Error(`Refund ${money(amount)} is more than the ${money(captured)} captured`);
    return queue("refund", `Refund ${currency} ${money(amount)}${i.amount ? "" : " (full)"} on capture ${i.capture_id}`, i, {
      amount, currency, reason: i.reason, dedupeKey: i.capture_id,
    });
  },

  async search_transactions(i) {
    const days = Math.min(Math.max(i.days_back ?? 30, 1), 31);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "-0000");
    const r = await paypal("GET", `/v1/reporting/transactions?start_date=${encodeURIComponent(fmt(start))}&end_date=${encodeURIComponent(fmt(end))}&fields=transaction_info&page_size=100`);
    return {
      count: r.total_items ?? r.transaction_details?.length ?? 0,
      transactions: (r.transaction_details ?? []).slice(0, 100).map((t) => ({
        id: t.transaction_info.transaction_id,
        date: t.transaction_info.transaction_initiation_date,
        amount: t.transaction_info.transaction_amount,
        status: t.transaction_info.transaction_status,
        subject: t.transaction_info.transaction_subject,
      })),
    };
  },

  async get_activity_log(i) {
    return {
      ledger: ledger().slice(0, i.limit ?? 50).map(({ id, ...e }) => e),
      approvals: approvals().slice(0, 25).map((a) => ({ id: a.id, title: a.title, status: a.status, risk: a.risk.level, createdAt: a.createdAt })),
    };
  },
};

export async function runTool(name, input) {
  const h = handlers[name];
  if (!h) throw new Error(`Unknown tool ${name}`);
  return h(input ?? {});
}
