// Tiny JSON-file store for the ledger (everything PalPilot did) and the
// PalGuard approval queue. Conversations stay in memory.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FILE = path.resolve("data/store.json");
const state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { ledger: [], approvals: [] };
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function logEvent(kind, summary, data = {}) {
  const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), kind, summary, ...data };
  state.ledger.unshift(entry);
  state.ledger = state.ledger.slice(0, 500);
  save();
  return entry;
}

export const ledger = () => state.ledger;

export function addApproval(a) {
  const entry = { id: "APR-" + crypto.randomBytes(3).toString("hex").toUpperCase(), status: "PENDING", createdAt: new Date().toISOString(), ...a };
  state.approvals.unshift(entry);
  save();
  return entry;
}

export const approvals = () => state.approvals;
export const getApproval = (id) => state.approvals.find((a) => a.id === id);

export function updateApproval(id, patch) {
  const a = getApproval(id);
  if (a) Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  save();
  return a;
}

export function resetAll() {
  state.ledger = [];
  state.approvals = [];
  save();
}
