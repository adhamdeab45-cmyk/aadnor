import { api } from "../core/api.js";
export async function requestDeposit(amount, method, note) { return api.requestDeposit({ amount: Number(amount), method, note }); }
export async function requestWithdraw(amount, method, note) { return api.requestWithdraw({ amount: Number(amount), method, note }); }
