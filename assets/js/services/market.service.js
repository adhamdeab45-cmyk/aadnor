import { db, ref, onValue } from "../core/firebase.js";
import { api } from "../core/api.js";

export function watchAdnPrice(callback) {
  return onValue(ref(db, "public/adn/price"), snap => callback(Number(snap.val() || 0.01)));
}
export async function buyAdn(usd) { return api.tradeAdn({ side: "buy", usd: Number(usd) }); }
export async function sellAdn(adn) { return api.tradeAdn({ side: "sell", adn: Number(adn) }); }
