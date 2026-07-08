import { functions, httpsCallable } from "./firebase.js";

const callableCache = new Map();

export async function callServer(name, payload = {}) {
  if (!callableCache.has(name)) callableCache.set(name, httpsCallable(functions, name));
  try {
    const res = await callableCache.get(name)(payload);
    return res.data || {};
  } catch (err) {
    const msg = err?.message || err?.details?.message || String(err);
    throw new Error(msg.replace(/^FirebaseError:\s*/i, ""));
  }
}

export const api = {
  health: () => callServer("health"),
  syncProfile: (data) => callServer("syncProfile", data),
  tradeAdn: (data) => callServer("tradeAdn", data),
  buyTicket: (data) => callServer("buyTicket", data),
  spinWheel: (data) => callServer("spinWheel", data),
  requestDeposit: (data) => callServer("requestDeposit", data),
  requestWithdraw: (data) => callServer("requestWithdraw", data),
  adminCreateAgent: (data) => callServer("adminCreateAgent", data),
  adminAdjustAgentBalance: (data) => callServer("adminAdjustAgentBalance", data),
  adminSetAgentActive: (data) => callServer("adminSetAgentActive", data),
  adminFinanceDecision: (data) => callServer("adminFinanceDecision", data),
  agentRecharge: (data) => callServer("agentRecharge", data),
};
