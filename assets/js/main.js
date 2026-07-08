import { setupTabs } from "./core/router.js";
import { initAuthState } from "./core/state.js";
import { api } from "./core/api.js";
import { showStatus, $ } from "./core/utils.js";
import { initAuthUi } from "./features/auth-ui.js";
import { initBalanceUi } from "./features/balance-ui.js";
import { initMarketUi } from "./features/market-ui.js";
import { initFinanceUi } from "./features/finance-ui.js";
import { initLotteryUi } from "./features/lottery-ui.js";
import { initWheelUi } from "./features/wheel-ui.js";

setupTabs("home");
initAuthState();
initAuthUi();
initBalanceUi();
initMarketUi();
initFinanceUi();
initLotteryUi();
initWheelUi();

api.health().then(r => showStatus($("#serverHealth"), `السيرفر شغال: ${r.version}`, "ok")).catch(e => showStatus($("#serverHealth"), `الدوال غير منشورة أو لا تعمل: ${e.message}`, "error"));
