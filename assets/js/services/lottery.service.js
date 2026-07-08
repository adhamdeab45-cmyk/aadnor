import { api } from "../core/api.js";
export async function buyTicket(ticketNumber) { return api.buyTicket({ ticketNumber: String(ticketNumber || "").trim() }); }
export function randomTicket() { return String(Math.floor(Math.random() * 1000000)).padStart(6, "0"); }
