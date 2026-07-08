import { $, money, escapeHtml } from "../core/utils.js";
import { watchState } from "../core/state.js";

export function initBalanceUi() {
  watchState(({ user, profile }) => {
    if (!user || !profile) return;
    $("#realBalance").textContent = money(profile.realBalance);
    $("#bonusBalance").textContent = money(profile.bonusBalance);
    $("#adnBalance").textContent = Number(profile.adnBalance || 0).toLocaleString("en-US", { maximumFractionDigits: 6 });
    $("#profileBox").innerHTML = `
      <b>${escapeHtml(profile.name || "مستخدم")}</b><br>
      <span class="muted ltr">UID: ${escapeHtml(user.uid)}</span><br>
      <span class="muted">Email: ${escapeHtml(user.email || "")}</span><br>
      <span>Real: ${money(profile.realBalance)} | Bonus: ${money(profile.bonusBalance)} | ADN: ${Number(profile.adnBalance || 0).toLocaleString()}</span>
    `;
  });
}
