# PalPilot: hackathon submission kit

## Tagline
Your AI back office on PayPal. Say it, snap it, approve it.

## Text description
Freelancers and small shops lose hours to payment admin: writing invoices, chasing unpaid ones, paying contractors, setting up memberships, issuing refunds. PalPilot is an AI copilot that does that work through PayPal's developer platform.

The merchant chats in plain language, or attaches a photo of a quote or timesheet. A Gemini agent plans the steps and calls the PayPal APIs to do them: Invoicing v2 (draft, send, remind, cancel), Orders v2 (checkout links with automatic capture, paid on a page that uses PayPal Smart Buttons), Catalog and Subscriptions (recurring plans with free trials from one sentence), Payouts (batch payments to contractors), Payments v2 (refunds) and Transaction Search (plain-language cash-flow answers).

Trust is the core of the design. The model can never move money on its own. Every money-moving or customer-facing action goes to **PalGuard**, an approval queue that shows the agent's stated reason next to deterministic risk checks: an amount limit, a first-time recipient, a likely duplicate. Nothing reaches PayPal until the merchant clicks Approve, and the result goes back to the agent. **PalLedger** records every action and shows live totals for money collected, outstanding and paid out. When a buyer pays, the capture flows back to the agent, so a follow-up like "refund half of that" just works.

## Tools used
- **Google Gemini (free tier, Google AI Studio)**: agent reasoning and function calling across 13 PayPal tools, vision for reading quotes, receipts and timesheets, and writing of reminders and summaries.
- **PayPal REST APIs (sandbox)**: Invoicing v2, Orders v2, Payments v2, Payouts v1, Catalog Products v1, Subscriptions v1, Transaction Search v1, OAuth2.
- **PayPal JS SDK**: Smart Buttons on the buyer pay page.

## Demo video script (under 3 minutes)
1. **0:00–0:15. The problem.** "Payment admin eats a small business's week. PalPilot hands it to an AI and keeps you in control."
2. **0:15–0:50. Invoice in one sentence.** Click the Dana invoice chip. Show the tool steps streaming in, the PayPal draft, and the PalGuard card marked HIGH risk (over $500). Click Approve, and the ledger shows "Invoice sent".
3. **0:50–1:25. Get paid.** "Make a payment link for a $35 yoga class." Open the link and pay with Smart Buttons using a sandbox buyer. Back in the dashboard, the Collected total goes up.
4. **1:25–1:50. Refund by intent.** "Refund half of that yoga payment." The agent finds the capture id itself, and PalGuard asks for approval.
5. **1:50–2:20. Photo to payout.** Attach a photo of a timesheet: "Pay these contractors." Approve the batch. Send the same request again and PalGuard flags the duplicate.
6. **2:20–2:45. Ask about your money.** "What's unpaid and who should I chase first? Draft reminders." The agent queues reminders it wrote itself.
7. **2:45–3:00. Wrap.** "Thirteen PayPal capabilities, one conversation, and no money moves without you."
