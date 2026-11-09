const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let sessionId = localStorage.getItem("palpilot-session") || crypto.randomUUID();
localStorage.setItem("palpilot-session", sessionId);
let attachment = null;
let busy = false;

// Render Markdown but never raw HTML coming from the model or PayPal data.
if (window.marked) {
  marked.use({ renderer: { html: (t) => esc(typeof t === "string" ? t : t?.text) } });
  marked.use({ breaks: true });
}
const md = (t) => {
  const html = window.marked ? marked.parse(t) : esc(t).replace(/\n/g, "<br>");
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  return div.innerHTML;
};

const TOOL_LABELS = {
  create_invoice: "Creating PayPal invoice draft",
  list_invoices: "Reading PayPal invoices",
  get_invoice: "Fetching invoice",
  send_invoice: "Asking PalGuard to send invoice",
  send_payment_reminder: "Asking PalGuard to send a reminder",
  cancel_invoice: "Asking PalGuard to cancel invoice",
  create_checkout_link: "Creating PayPal checkout link",
  get_order_status: "Checking PayPal order",
  create_subscription_plan: "Creating PayPal subscription plan",
  send_payouts: "Asking PalGuard to send payouts",
  refund_payment: "Asking PalGuard to issue a refund",
  search_transactions: "Searching PayPal transactions",
  get_activity_log: "Reading PalLedger",
};

function add(el) {
  $(".welcome")?.remove();
  $("#messages").append(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
}
function bubble(cls, html) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.innerHTML = html;
  return add(d);
}

async function send(text) {
  if (busy || (!text.trim() && !attachment)) return;
  busy = true;
  $("#send").disabled = true;
  const images = attachment ? [{ mediaType: attachment.mediaType, data: attachment.data }] : [];
  bubble("user", (attachment ? `<img src="${attachment.url}" alt="attachment">` : "") + esc(text));
  clearAttachment();
  $("#input").value = "";
  autosize();
  const typing = add(Object.assign(document.createElement("div"), { className: "typing", textContent: "PalPilot is working" }));
  const pendingTools = [];

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, text, images }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === "text") {
          bubble("bot", md(e.text));
        } else if (e.type === "tool_start") {
          const d = document.createElement("details");
          d.className = "tool";
          d.innerHTML = `<summary>⚙️ ${esc(TOOL_LABELS[e.name] || e.name)}…</summary><pre>${esc(JSON.stringify(e.input, null, 2))}</pre>`;
          pendingTools.push({ name: e.name, el: add(d) });
        } else if (e.type === "tool_result") {
          const t = pendingTools.find((p) => p.name === e.name && !p.done) ;
          if (t) {
            t.done = true;
            t.el.classList.add(e.ok ? "ok" : "fail");
            t.el.querySelector("summary").innerHTML = `${e.ok ? "✅" : "⚠️"} ${esc(TOOL_LABELS[e.name] || e.name)} <b>${e.ok ? (e.result?.status === "PENDING_APPROVAL" ? "queued for approval" : "done") : "failed"}</b>`;
            t.el.querySelector("pre").textContent += "\n\n→ " + JSON.stringify(e.result, null, 2);
          }
          refresh();
        } else if (e.type === "error") {
          bubble("err", "⚠️ " + esc(e.message));
        }
        $("#messages").append(typing);
        $("#messages").scrollTop = $("#messages").scrollHeight;
      }
    }
  } catch (err) {
    bubble("err", "⚠️ " + esc(err.message));
  } finally {
    typing.remove();
    busy = false;
    $("#send").disabled = false;
    refresh();
  }
}

// ---------------------------------------------------------------- side panels
const ICONS = {
  invoice_draft: "📝", invoice_sent: "📨", invoice_paid: "💰", reminder_sent: "🔔", invoice_cancelled: "🚫",
  checkout_created: "🔗", checkout_paid: "💰", plan_created: "🔁", subscription_started: "🎉",
  payout_sent: "💸", refund_issued: "↩️", approval_requested: "🛡️", approval_rejected: "✋", error: "⚠️",
};

function renderApprovals(list) {
  const box = $("#approvals");
  if (!list.length) return (box.innerHTML = '<p class="empty">Nothing waiting for approval.</p>');
  box.innerHTML = list
    .map((a) => {
      const res = a.result
        ? `<div class="result">${Object.entries(a.result).map(([k, v]) => {
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return `${esc(k)}: ${/^https?:\/\//.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">open link</a>` : esc(s)}`;
          }).join(" · ")}</div>`
        : "";
      return `<div class="approval ${a.status}">
        <div class="row"><h4>${esc(a.title)}</h4>
          ${a.status === "PENDING" ? `<span class="badge risk-${a.risk.level}">${a.risk.level} risk</span>` : `<span class="badge st-${a.status}">${a.status}</span>`}
        </div>
        ${a.reason ? `<p class="reason">🤖 ${esc(a.reason)}</p>` : ""}
        ${a.status === "PENDING" ? `<ul class="flags">${a.risk.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
          <div class="actions"><button class="approve" data-id="${a.id}">Approve</button><button class="reject" data-id="${a.id}">Reject</button></div>` : ""}
        ${a.error ? `<div class="result" style="color:var(--red)">${esc(a.error)}</div>` : res}
      </div>`;
    })
    .join("");
}

function renderLedger(list) {
  const ul = $("#ledger");
  const items = list.filter((e) => e.kind !== "approval_requested");
  if (!items.length) return (ul.innerHTML = '<li class="empty">No activity yet.</li>');
  ul.innerHTML = items
    .map((e) => `<li><span class="ico">${ICONS[e.kind] || "•"}</span><div>${esc(e.summary)}
      ${e.pay_url ? ` <a href="${esc(e.pay_url)}" target="_blank" rel="noopener">pay link ↗</a>` : ""}
      <time>${new Date(e.at).toLocaleString()}</time></div></li>`)
    .join("");
}

async function refresh() {
  const s = await (await fetch("/api/state")).json();
  $("#sCollected").textContent = fmt(s.stats.collected);
  $("#sOutstanding").textContent = fmt(s.stats.outstanding);
  $("#sPaidOut").textContent = fmt(s.stats.paidOut);
  $("#sPending").textContent = s.stats.pending;
  renderApprovals(s.approvals);
  renderLedger(s.ledger);
}

$("#approvals").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const action = btn.classList.contains("approve") ? "approve" : "reject";
  btn.closest(".actions").innerHTML = `<span class="muted">${action === "approve" ? "Executing on PayPal…" : "Rejecting…"}</span>`;
  const r = await fetch(`/api/approvals/${btn.dataset.id}/${action}`, { method: "POST" });
  const body = await r.json();
  await refresh();
  if (!busy) {
    if (r.ok && action === "approve") bubble("bot", md(`🛡️ **PalGuard:** approved and executed — ${esc(body.title)}.`));
    else if (!r.ok) bubble("err", "⚠️ " + esc(body.error));
  }
});

// ---------------------------------------------------------------- composer
function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
function clearAttachment() {
  attachment = null;
  $("#preview").hidden = true;
  $("#preview").innerHTML = "";
  $("#file").value = "";
}
$("#file").addEventListener("change", () => {
  const f = $("#file").files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) return alert("Please choose an image under 5 MB.");
  const r = new FileReader();
  r.onload = () => {
    const url = r.result;
    attachment = { url, mediaType: f.type, data: url.split(",")[1] };
    $("#preview").innerHTML = `<img src="${url}" alt=""> ${esc(f.name)} <button type="button" id="rm">✕</button>`;
    $("#preview").hidden = false;
    $("#rm").onclick = clearAttachment;
  };
  r.readAsDataURL(f);
});
$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send($("#input").value);
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("#input").value);
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));
$("#resetBtn").addEventListener("click", async () => {
  await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  sessionId = crypto.randomUUID();
  localStorage.setItem("palpilot-session", sessionId);
  location.reload();
});

(async () => {
  const c = await (await fetch("/api/config")).json();
  const m = $("#mode");
  m.textContent = c.mode === "simulator" ? "PayPal simulator" : c.mode === "sandbox" ? "PayPal sandbox" : "PayPal LIVE";
  m.className = "pill " + (c.mode === "simulator" ? "sim" : "sandbox");
  if (!c.aiReady) bubble("err", "⚠️ GOOGLE_API_KEY is not set on the server. Add it to <code>.env</code> and restart.");
  refresh();
  setInterval(() => !busy && refresh(), 5000);
})();
