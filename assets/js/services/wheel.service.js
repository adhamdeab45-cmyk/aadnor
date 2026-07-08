import { api } from "../core/api.js";
export async function spinWheel(bet) { return api.spinWheel({ bet: Number(bet) }); }
