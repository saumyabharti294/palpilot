// Records things that happen outside the chat (a customer paying, subscribing).
// Called from PayPal webhooks, the return URL and the simulator's buyer page,
// so each recorder ignores an event it has already logged.
import { addNoteToAll } from "./agent.js";
import { ledger, logEvent } from "./store.js";

export function recordSubscription(id) {
  if (ledger().some((e) => e.kind === "subscription_started" && e.subscription_id === id)) return;
  logEvent("subscription_started", `New subscriber: ${id}`, { subscription_id: id });
  addNoteToAll(`A customer subscribed: subscription ${id}.`);
}

export function recordInvoicePaid(inv) {
  if (ledger().some((e) => e.kind === "invoice_paid" && e.invoice_id === inv.id)) return;
  const sent = ledger().find((e) => e.kind === "invoice_sent" && e.invoice_id === inv.id);
  const value = inv.amount?.value ?? sent?.amount;
  const label = inv.detail?.invoice_number ?? inv.id;
  logEvent("invoice_paid", `Invoice ${label} paid: ${inv.amount?.currency_code ?? "USD"} ${value}`, {
    invoice_id: inv.id, amount: value, direction: "in",
  });
  addNoteToAll(`Invoice ${inv.id} was PAID by the customer.`);
}

/** Apply a webhook event whose signature has already been verified. */
export function handlePayPalEvent(event) {
  if (event.event_type === "INVOICING.INVOICE.PAID") {
    const inv = event.resource?.invoice ?? event.resource;
    if (inv?.id) recordInvoicePaid(inv);
  } else if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    if (event.resource?.id) recordSubscription(event.resource.id);
  }
}
