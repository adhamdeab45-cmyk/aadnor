import { $, showStatus, setBusy, requireNumber, money } from "../core/utils.js";
import { buyAdn, sellAdn, watchAdnPrice } from "../services/market.service.js";

export function initMarketUi() {
  watchAdnPrice((price) => {
    $("#homeAdnPrice").textContent = money(price);
  });
  $("#btnBuyAdn")?.addEventListener("click", async (e) => {
    const status = $("#buyStatus");
    setBusy(e.currentTarget, true, "جارٍ الشراء...");
    try {
      const usd = requireNumber($("#buyUsd").value, "قيمة الشراء", 0.01);
      const res = await buyAdn(usd);
      showStatus(status, `تم شراء ADN تلقائياً.\nالكمية: ${res.adn?.toLocaleString?.() || res.adn}\nالرصيد الجديد: ${money(res.realBalance)}`, "ok");
    } catch (err) { showStatus(status, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
  $("#btnSellAdn")?.addEventListener("click", async (e) => {
    const status = $("#sellStatus");
    setBusy(e.currentTarget, true, "جارٍ البيع...");
    try {
      const adn = requireNumber($("#sellAdn").value, "كمية ADN", 0.000001);
      const res = await sellAdn(adn);
      showStatus(status, `تم بيع ADN تلقائياً.\nالقيمة: ${money(res.usd)}\nالرصيد الجديد: ${money(res.realBalance)}`, "ok");
    } catch (err) { showStatus(status, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
}
