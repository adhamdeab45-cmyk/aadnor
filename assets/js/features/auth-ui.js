import { $, showStatus, setBusy, money, escapeHtml } from "../core/utils.js";
import { loginEmail, loginGoogle, logout } from "../services/auth.service.js";
import { state, watchState } from "../core/state.js";

export function initAuthUi() {
  const loginPanel = $("#loginPanel"), appPanel = $("#appPanel"), authBox = $("#authBox"), st = $("#loginStatus");
  $("#btnEmailLogin")?.addEventListener("click", async (e) => {
    setBusy(e.currentTarget, true);
    try { await loginEmail($("#loginEmail").value, $("#loginPass").value); showStatus(st, "تم الدخول بنجاح", "ok"); }
    catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
  $("#btnGoogleLogin")?.addEventListener("click", async (e) => {
    setBusy(e.currentTarget, true);
    try { await loginGoogle(); showStatus(st, "تم الدخول بنجاح", "ok"); }
    catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
  watchState(({ user, profile }) => {
    loginPanel.classList.toggle("hide", !!user);
    appPanel.classList.toggle("hide", !user);
    if (!user) {
      authBox.innerHTML = `<span class="muted">غير مسجل</span>`;
      return;
    }
    authBox.innerHTML = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span>${escapeHtml(profile?.name || user.displayName || user.email || "مستخدم")}</span><button id="logoutBtn" class="btn secondary">خروج</button></div>`;
    $("#logoutBtn")?.addEventListener("click", logout);
  });
}
