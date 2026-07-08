export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

export function money(value, suffix = "$") {
  const n = Number(value || 0);
  return `${suffix}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function num(value, fallback = 0) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}
export function cleanText(v) { return String(v ?? "").trim(); }
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}
export function nowIso() { return new Date().toISOString(); }
export function uid6() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
export function loginToEmail(loginId) {
  const v = cleanText(loginId).toLowerCase();
  if (!v) return "";
  return v.includes("@") ? v : `${v}@agents.adnor.local`;
}
export function showStatus(el, message, type = "info") {
  if (!el) return;
  el.textContent = message || "";
  el.className = `status ${type}`;
}
export function setBusy(btn, busy, text = "جارٍ التنفيذ...") {
  if (!btn) return;
  if (busy) {
    btn.dataset.oldText = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.oldText || btn.textContent;
    btn.disabled = false;
  }
}
export function requireNumber(value, label, min = 0.000001) {
  const n = num(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} غير صحيح`);
  return n;
}
