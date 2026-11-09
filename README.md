<p align="center"><img src="public/logo.svg" alt="PalPilot logo" width="120" /></p>

# PalPilot

**An AI back-office copilot for small businesses that get paid with PayPal.**

You tell PalPilot what you need in plain words, or you snap a photo of a quote, a receipt or a timesheet. A Gemini agent turns that into real PayPal API calls: invoices, checkout links, subscriptions, contractor payouts and refunds. Before any of those actions moves money or emails a customer, **PalGuard** holds it for you to approve.

> "Invoice Dana $450 for the logo plus two $60 revision rounds, due in 10 days, and send it."
>
> → PalPilot creates a PayPal invoice draft, checks the total ($570), and queues "Send invoice" in PalGuard, flagged high risk because it is over your $500 limit. You click **Approve** and PayPal emails the invoice.

Built for the *Build What's Next with PayPal and AI* hackathon.

---

## Features

| | Name | What it does | PayPal API |
|---|---|---|---|
| 🤖 | **PalPilot Agent** | A chat agent built on Gemini function calling. It plans and runs several steps in a row, reads attached images (quotes, receipts, timesheets, chat screenshots) and writes reminder emails. | All of the APIs below |
| 📝 | **InvoicePal** | Create draft invoices, list and track them, send them, remind customers, cancel. | Invoicing v2 |
| 🔗 | **PayLinks** | One-off checkout links with automatic capture, plus a buyer page that uses PayPal Smart Buttons. | Orders v2 + JS SDK |
| 🔁 | **PalPlans** | A recurring membership from one sentence: product, billing plan (optional free trial) and subscribe link. | Catalog Products + Subscriptions v1 |
| 💸 | **PalPayouts** | Pay contractors, affiliates or partners by email, in a batch. | Payouts v1 |
| ↩️ | **Refunds** | Full or partial refunds of captured payments. | Payments v2 |
| 🔎 | **PayLens** | Ask about your money in plain words, e.g. "What's unpaid? Who should I chase first?" | Transaction Search + Invoicing |
| 🛡️ | **PalGuard** | Human-in-the-loop approval for every money-moving or customer-facing action. Deterministic risk checks (amount limit, first-time recipient, duplicate in the last 24h) appear next to the agent's stated reason. | — |
| 📒 | **PalLedger** | An audit trail of everything PalPilot did, plus live totals for collected, outstanding and paid out. | — |

### How it works

```
Browser (chat + PalGuard + PalLedger)
   │  NDJSON stream of agent steps
   ▼
Express server ── Gemini (gemini-3.5-flash, function calling, vision)
   │                 │ tool calls
   │                 ▼
   │           13 PayPal tools ──► safe tools run immediately (drafts, links, plans, reads)
   │                           └─► money tools ──► PalGuard queue ──► merchant approves ──► PayPal
   ▼
PayPal REST API (sandbox)  ◄── buyer pays via pay.html (PayPal JS SDK Smart Buttons) → capture
```

- **Safe by design:** the model can never move money on its own. The money tools (`send_invoice`, `send_payment_reminder`, `cancel_invoice`, `send_payouts`, `refund_payment`) only *queue* a request. PayPal is called only after a human clicks Approve, and the agent is told the result on its next turn.
- **Closed loop:** when a buyer pays (PayPal return URL or JS SDK `onApprove`), the server captures the order, writes it to the ledger and tells the agent. You can then say "refund the yoga class" and the agent finds the capture id itself.

---

## Run it (about 2 minutes)

Requirements: **Node.js 18+** and a free **Google AI Studio API key** (<https://aistudio.google.com/apikey>). PayPal sandbox keys are optional.

```bash
git clone <this repo> palpilot && cd palpilot
npm install
cp .env.example .env        # then paste your GOOGLE_API_KEY
npm start                   # → http://localhost:3000
```

### Simulator mode or PayPal sandbox

- **No PayPal keys:** PalPilot uses a built-in simulator that copies the shapes of the sandbox endpoints it calls, so every flow can be clicked through, including the buyer pay page. The badge in the header reads **PayPal simulator**.
- **With sandbox keys (recommended for judging):**
  1. Go to <https://developer.paypal.com/dashboard/applications/sandbox> and create an app (or open the default one).
  2. Copy its **Client ID** and **Secret** into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
  3. Restart. The badge now reads **PayPal sandbox** and every call goes to `api-m.sandbox.paypal.com`.
  4. To pay as a buyer, open a pay link and log in with a **sandbox personal account** (Dashboard → Testing Tools → Sandbox Accounts).

> Payouts and Transaction Search must be enabled on your sandbox app (App settings → Features). If a feature is off, PalPilot shows PayPal's error and explains how to fix it.

### Try these prompts

1. `Invoice Dana Lee (dana@example.com) $450 for logo design and $120 for 2 revision rounds, due in 10 days, then send it`, then approve it in PalGuard
2. `Make a payment link for a $35 yoga drop-in class`, then open the link and pay
3. `Refund half of that yoga payment, the class was cut short`
4. `Set up a $9/month "Coffee Club" membership with a 7 day free trial`
5. `Pay my contractors: sam@example.com $200 and priya@example.com $350 for the October sprint`, then send the same request again to see PalGuard flag it as a duplicate
6. 📎 Attach a photo of a handwritten quote: `Invoice this to the client`
7. `Which invoices are still unpaid, and what should I chase first? Draft the reminders.`

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | – | Required |
| `ADMIN_PASSWORD` | – | Dashboard login. Required when `NODE_ENV=production`; any username works |
| `PAYPAL_WEBHOOK_ID` | – | Needed to receive "invoice paid" and "subscription activated" events |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | – | Sandbox credentials. Leave blank to use the simulator |
| `PAYPAL_ENV` | `sandbox` | `live` switches to production endpoints (not recommended) |
| `APP_URL` | `http://localhost:3000` | Used for PayPal return URLs and pay links. Set it to your public URL when you deploy |
| `PALGUARD_LIMIT` | `500` | Amount at or above which PalGuard marks an action high risk |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model id |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.1-flash-lite` | Tried in order when the main model is overloaded or out of free quota |

> The Gemini free tier allows about 20 requests per day per model, and one chat message uses two or more. PalPilot moves down the model list when one runs out.

### Deploy (Render)

Create a new **Web Service** from this repo with build command `npm install` and start command `npm start`. Add the environment variables above, including `ADMIN_PASSWORD`, and set `APP_URL` to the service URL.

Then, in your PayPal app, add a webhook pointing at `https://<your-app>/api/webhooks/paypal` for **Invoicing invoice paid** and **Billing subscription activated**, and set `PAYPAL_WEBHOOK_ID` to its ID. Without this, invoices paid on PayPal never show up in PalLedger.

---

## AI tools used

- **Google Gemini (`@google/generative-ai`, free tier)** is the agent's brain:
  - **Function calling:** 13 PayPal tools with JSON-schema inputs. Gemini decides which to call, chains them (create draft → queue send), and runs independent calls in parallel.
  - **Vision:** reads attached images of quotes, receipts and timesheets and turns them into invoice line items or payouts.
  - **Language generation:** writes reminder emails, notes to customers and plain-language cash-flow summaries.
  - **Model fallback:** if a model is overloaded, times out or runs out of free quota, the request moves to the next one.

## Project layout

```
server.js          Express routes: chat stream, PalGuard approve/reject, order capture, return URL
src/agent.js       Gemini agent loop (function calling, vision, PalGuard updates)
src/tools.js       PayPal tool definitions + executors + PalGuard risk checks
src/paypal.js      PayPal REST client (OAuth2 client-credentials) + offline simulator
src/store.js       JSON-file ledger and approval queue
src/events.js      Records customer payments and subscriptions from webhooks and return URLs
public/            Dashboard (index.html, app.js, styles.css) and buyer page (pay.html)
```

## License

[MIT](LICENSE)
