import { $, showStatus, setBusy, requireNumber, cleanText } from "../core/utils.js";
import { requestDeposit, requestWithdraw } from "../services/finance.service.js";

export function initFinanceUi() {
  $("#btnDeposit")?.addEventListener("click", async (e) => {
    const st = $("#depositStatus"); setBusy(e.currentTarget, true);
    try {
      const res = await requestDeposit(requireNumber($("#depositAmount").value, "مبلغ الإيداع", 1), cleanText($("#depositMethod").value), cleanText($("#depositNote").value));
      showStatus(st, `تم حفظ طلب الإيداع رقم: ${res.id}`, "ok");
    } catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
  $("#btnWithdraw")?.addEventListener("click", async (e) => {
    const st = $("#withdrawStatus"); setBusy(e.currentTarget, true);
    try {
      const res = await requestWithdraw(requireNumber($("#withdrawAmount").value, "مبلغ السحب", 1), cleanText($("#withdrawMethod").value), cleanText($("#withdrawNote").value));
      showStatus(st, `تم حفظ طلب السحب رقم: ${res.id}`, "ok");
    } catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
}
