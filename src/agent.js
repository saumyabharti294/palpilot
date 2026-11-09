// PalPilot agent: Google Gemini + PayPal tools.
// A free API key from Google AI Studio (aistudio.google.com) is all it needs.
import { GoogleGenerativeAI } from "@google/generative-ai";
import { toolDefinitions, runTool } from "./tools.js";
import { isLive } from "./paypal.js";

const genai = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
// The free tier allows about 20 requests per day per model, and models get
// overloaded or hang, so each request walks down this list until one answers.
const MODELS = [
  ...new Set([
    MODEL,
    ...(process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.1-flash-lite")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  ]),
];
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 25_000;
const MAX_STEPS = 12;

// Gemini function declarations — same JSON Schema as our tool definitions,
// but we strip keywords Gemini doesn't support (minItems, maxItems, $schema).
function sanitize(v) {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object") {
    const { minItems, maxItems, $schema, ...rest } = v;
    return Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, sanitize(x)]));
  }
  return v;
}

const functionDeclarations = toolDefinitions.map(({ name, description, input_schema }) => ({
  name,
  description,
  parameters: sanitize(input_schema),
}));

const SYSTEM = `You are PalPilot, an AI back-office copilot for a small business that runs its payments on PayPal.
You act through tools that call the PayPal REST APIs: invoicing, checkout orders, subscriptions, payouts, refunds and transaction search.

How you work:
- Turn plain requests ("bill Dana $400 for the logo, due in 2 weeks") into the right PayPal actions, then do them. Ask a question only when something you cannot reasonably infer is missing, such as a customer email.
- Photos or screenshots of quotes, receipts, timesheets or chats may be attached. Extract line items, amounts, names and emails from them carefully and say what you read.
- PalGuard safety rule: sending invoices, reminders, cancellations, payouts and refunds always go to the PalGuard approval queue, and the merchant approves them in the side panel. Never claim one of those actions happened until a later message confirms it was approved and executed. Always give a short, honest reason when you queue one.
- If the merchant repeats a payment that already happened, still queue it. PalGuard flags duplicates and the merchant decides. Mention that it looks like a repeat.
- Drafts, checkout links and subscription plans are safe to create directly, because no money moves until a buyer pays.
- Amounts are decimal strings. Default currency is USD. Double-check totals (quantity × unit price) before creating anything.
- When you create a link, give the merchant the shareable link so they can send it.
- For questions about cash flow, unpaid invoices or what happened recently, use list_invoices, search_transactions and get_activity_log, then answer with real numbers.
- If a PayPal call fails, explain the error in plain words and suggest a fix.
- Keep replies short and skimmable: a sentence or two, then bullets with ids, amounts and links when useful. Use Markdown.`;

const sessions = new Map();

function session(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [], notes: [] });
  return sessions.get(id);
}

export function resetSession(id) {
  sessions.delete(id);
}

export function addNote(id, note) {
  session(id).notes.push(note);
}

export function addNoteToAll(note) {
  for (const s of sessions.values()) s.notes.push(note);
}

const MODEL_CONFIG = {
  systemInstruction: SYSTEM,
  tools: [{ functionDeclarations }],
  generationConfig: { temperature: 0.2 },
};

function rateLimitWaitMs(err) {
  const delay = err?.errorDetails?.find((d) => d.retryDelay)?.retryDelay;
  return err?.status === 429 && delay ? parseFloat(delay) * 1000 : Infinity;
}

async function generate(contents) {
  for (let attempt = 0; ; attempt++) {
    let lastError;
    let wait = Infinity;
    for (const model of MODELS) {
      try {
        const result = await genai
          .getGenerativeModel({ model, ...MODEL_CONFIG })
          .generateContent({ contents }, { timeout: REQUEST_TIMEOUT_MS });
        if (result.response.candidates?.[0]?.content?.parts?.length) return result;
        lastError = new Error(`${model} returned an empty response`);
      } catch (err) {
        lastError = err;
        wait = Math.min(wait, rateLimitWaitMs(err));
      }
      console.warn(`Gemini ${model} failed: ${lastError.message.slice(0, 160)}`);
    }
    // A per-minute limit clears quickly, so ride it out once. A daily limit won't.
    if (attempt > 0 || wait > MAX_RATE_LIMIT_WAIT_MS) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

const unavailableMessage = (err) =>
  err?.status === 429
    ? "Gemini's free usage limit has been reached for now. Please try again later."
    : "Gemini is busy or unavailable right now. Please send that again in a moment.";

export async function runTurn(sessionId, { text, images = [] }, emit) {
  const s = session(sessionId);
  const historyStart = s.history.length;

  // Build user parts for this turn
  const parts = [];

  // Inline images (quotes, receipts, timesheets)
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
  }

  // Inject PalGuard updates as context the model can see
  const deliveredNotes = s.notes;
  if (s.notes.length) {
    parts.push({ text: `<palguard_updates>\n${s.notes.join("\n")}\n</palguard_updates>` });
    s.notes = [];
  }

  const today = new Date().toISOString().slice(0, 10);
  parts.push({
    text: `${text || "(see attachment)"}\n\n<context>Today is ${today}. PayPal mode: ${isLive() ? "sandbox API" : "simulator (no PayPal keys configured)"}.</context>`,
  });

  s.history.push({ role: "user", parts });

  for (let step = 0; step < MAX_STEPS; step++) {
    let result;
    try {
      result = await generate(s.history);
    } catch (err) {
      console.error(err);
      if (step === 0) {
        // Nothing ran yet, so forget this turn and let the merchant simply resend.
        s.history.length = historyStart;
        s.notes = [...deliveredNotes, ...s.notes];
        emit({ type: "error", message: unavailableMessage(err) });
      } else {
        // Tools already ran. Keep them in history so a retry doesn't repeat them.
        s.history.push({ role: "model", parts: [{ text: "(The AI service dropped out before I could finish this request.)" }] });
        emit({ type: "error", message: "Gemini dropped out partway through. The steps above did run, so check them before asking again." });
      }
      return;
    }

    const content = result.response.candidates[0].content;
    s.history.push(content); // keep full model turn in history

    // Collect text parts and function calls
    const functionCalls = [];
    for (const part of content.parts ?? []) {
      if (part.text?.trim()) emit({ type: "text", text: part.text });
      if (part.functionCall) functionCalls.push(part.functionCall);
    }

    // No tool calls → model is done
    if (functionCalls.length === 0) return;

    // Run all tool calls (in parallel) and collect responses
    const responseParts = await Promise.all(
      functionCalls.map(async (fc) => {
        emit({ type: "tool_start", name: fc.name, input: fc.args });
        try {
          const r = await runTool(fc.name, fc.args ?? {});
          emit({ type: "tool_result", name: fc.name, ok: true, result: r });
          return { functionResponse: { name: fc.name, response: r } };
        } catch (err) {
          emit({ type: "tool_result", name: fc.name, ok: false, result: { error: err.message } });
          return { functionResponse: { name: fc.name, response: { error: err.message } } };
        }
      }),
    );

    s.history.push({ role: "user", parts: responseParts });
  }

  emit({ type: "text", text: "_I hit my step limit for this request. Tell me to continue if you want me to keep going._" });
}
