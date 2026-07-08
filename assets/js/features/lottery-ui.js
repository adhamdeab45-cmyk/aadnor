import { $, showStatus, setBusy } from "../core/utils.js";
import { buyTicket, randomTicket } from "../services/lottery.service.js";

export function initLotteryUi() {
  $("#btnRandomTicket")?.addEventListener("click", () => $("#ticketNumber").value = randomTicket());
  $("#btnBuyTicket")?.addEventListener("click", async (e) => {
    const st = $("#ticketStatus"); setBusy(e.currentTarget, true);
    try {
      const res = await buyTicket($("#ticketNumber").value);
      showStatus(st, `تم شراء التذكرة ${res.ticketNumber} بنجاح`, "ok");
    } catch (err) { showStatus(st, err.message, "error"); }
    finally { setBusy(e.currentTarget, false); }
  });
}
