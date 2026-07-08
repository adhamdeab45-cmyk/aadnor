import { $, showStatus, setBusy, requireNumber, money } from "../core/utils.js";
import { spinWheel } from "../services/wheel.service.js";

export function initWheelUi() {
  $("#btnSpin")?.addEventListener("click", async (e) => {
    const st = $("#wheelResult"); setBusy(e.currentTarget, true, "العجلة تدور...");
    try {
      const res = await spinWheel(requireNumber($("#wheelBet").value, "قيمة الرهان", 0.01));
      showStatus(st, `النتيجة: ${res.multiplier}x\nالربح: ${money(res.win)}\nالرصيد الجديد: ${money(res.realBalance)}`, res.win > 0 ? "ok" : "info");
    } catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
}
