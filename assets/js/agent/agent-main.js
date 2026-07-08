import { auth, signInWithEmailAndPassword, signOut } from "../core/firebase.js";
import { initAuthState, watchState } from "../core/state.js";
import { api } from "../core/api.js";
import { $, showStatus, setBusy, cleanText, loginToEmail, money, requireNumber } from "../core/utils.js";

initAuthState({ agentMode: true });

function render({ user, agent }) {
  $('#agentLoginPanel').classList.toggle('hide', !!user);
  $('#agentApp').classList.toggle('hide', !user);
  $('#agentAuthBox').innerHTML = user ? `<button id="agentLogout" class="btn secondary">خروج</button>` : '<span class="muted">غير مسجل</span>';
  $('#agentLogout')?.addEventListener('click', () => signOut(auth));
  if (!user) return;
  if (!agent) {
    $('#agentActiveBox').textContent = 'غير وكيل';
    return;
  }
  $('#agentBalanceBox').textContent = money(agent.balance);
  $('#agentTotalBox').textContent = money(agent.totalCharged);
  $('#agentActiveBox').textContent = agent.active ? 'مفعل' : 'موقوف';
}
watchState(render);

$('#btnAgentLogin')?.addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    await signInWithEmailAndPassword(auth, loginToEmail($('#agentLoginId').value), cleanText($('#agentLoginPass').value));
    showStatus($('#agentLoginStatus'), 'تم الدخول', 'ok');
  } catch (err) { showStatus($('#agentLoginStatus'), err.message, 'error'); }
  finally { setBusy(e.currentTarget, false); }
});

$('#btnAgentRecharge')?.addEventListener('click', async e => {
  const st = $('#rechargeStatus'); setBusy(e.currentTarget, true);
  try {
    const res = await api.agentRecharge({ target: cleanText($('#targetUser').value), amount: requireNumber($('#rechargeAmount').value, 'مبلغ الشحن', 0.01), note: cleanText($('#rechargeNote').value) });
    showStatus(st, `تم الشحن بنجاح.\nالمستخدم: ${res.targetName}\nرصيد الوكيل الجديد: ${money(res.agentBalance)}`, 'ok');
  } catch (err) { showStatus(st, err.message, 'error'); }
  finally { setBusy(e.currentTarget, false); }
});
