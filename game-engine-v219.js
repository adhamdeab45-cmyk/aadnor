'use strict';

const crypto = require('node:crypto');

function money(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
}

function safeText(value, maximum = 220) {
  return String(value ?? '').trim().slice(0, maximum);
}

function gameError(code, statusCode = 409, details) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function validGameId(value) {
  const gameId = safeText(value, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!gameId) throw gameError('GAME_REQUIRED', 400);
  return gameId;
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const rawCut = Number(value.platformCutPercent ?? 5);
  return {
    platformCutPercent: Math.max(0, Math.min(30, rawCut > 30 ? 5 : rawCut)),
    defaultOpeningReserve: Math.max(0, money(value.defaultOpeningReserve ?? 5000)),
    updatedAt: Number(value.updatedAt || 0)
  };
}

function treasuryHasActivity(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (Number(raw.roundsCount || 0) > 0) return true;
  if (money(raw.totalBetsReal) > 0 || money(raw.totalBetsBonus) > 0) return true;
  if (money(raw.paidOut) > 0 || money(raw.platformProfit) > 0) return true;
  const operations = raw.recentOperations && typeof raw.recentOperations === 'object'
    ? raw.recentOperations : {};
  return Object.values(operations).some((entry) => entry && entry.status === 'accounted');
}

function normalizeTreasuryNode(raw, settings, gameId, gameName, now) {
  const node = raw && typeof raw === 'object' ? { ...raw } : {};
  const active = treasuryHasActivity(node);
  const currentPool = Math.max(0, money(node.playerPool));
  const openingSeed = active ? 0 : Math.max(0, money(settings.defaultOpeningReserve - currentPool));
  node.gameId = gameId;
  node.gameName = safeText(gameName || node.gameName || gameId, 120);
  node.playerPool = money(currentPool + openingSeed);
  node.platformFunding = money(active
    ? Math.max(0, money(node.platformFunding))
    : Math.max(0, money(node.platformFunding), currentPool + openingSeed));
  node.platformProfit = Math.max(0, money(node.platformProfit));
  node.totalBetsReal = Math.max(0, money(node.totalBetsReal));
  node.totalBetsBonus = Math.max(0, money(node.totalBetsBonus));
  node.paidOut = Math.max(0, money(node.paidOut));
  node.roundsCount = Math.max(0, Math.floor(Number(node.roundsCount || 0)));
  node.createdAt = Number(node.createdAt || now);
  node.updatedAt = now;
  node.recentOperations = node.recentOperations && typeof node.recentOperations === 'object'
    ? node.recentOperations : {};
  return { node, openingSeed };
}

function paymentSplit(profile, amount, allowReal, allowBonus) {
  const realBefore = money(profile.realBalance);
  const bonusBefore = money(profile.bonusBalance);
  const useReal = allowReal ? Math.min(realBefore, amount) : 0;
  const remaining = money(amount - useReal);
  const useBonus = allowBonus ? Math.min(bonusBefore, remaining) : 0;
  if (money(useReal + useBonus) < amount) return null;
  return {
    realBefore,
    bonusBefore,
    useReal: money(useReal),
    useBonus: money(useBonus),
    realAfterHold: money(realBefore - useReal),
    bonusAfterHold: money(bonusBefore - useBonus)
  };
}

function normalizeOutcomes(rawOutcomes) {
  const outcomes = Array.isArray(rawOutcomes) ? rawOutcomes : [];
  return outcomes.map((raw, index) => {
    const multiplier = Math.max(0, Math.min(10000, Number(raw && raw.multiplier || 0)));
    const weight = Math.max(0, Math.min(1_000_000, Number(raw && raw.weight || 0)));
    return {
      type: safeText(raw && raw.type || (multiplier > 0 ? 'win' : 'loss'), 20),
      multiplier,
      weight,
      label: safeText(raw && raw.label || `${multiplier}x`, 50),
      segmentIndex: Number.isInteger(raw && raw.segmentIndex) ? raw.segmentIndex : index,
      fallAfterOptions: Array.isArray(raw && raw.fallAfterOptions)
        ? raw.fallAfterOptions.map(Number).filter((value) => Number.isFinite(value) && value > 0)
        : []
    };
  }).filter((outcome) => Number.isFinite(outcome.multiplier) && outcome.weight > 0);
}

function rebalanceForTargetRtp(outcomes, targetRtp) {
  const target = Math.max(0.70, Math.min(1, Number(targetRtp || 0.95)));
  const zeroWeight = outcomes
    .filter((outcome) => outcome.multiplier === 0)
    .reduce((sum, outcome) => sum + outcome.weight, 0);
  const positive = outcomes.filter((outcome) => outcome.multiplier > 0);
  const positiveWeight = positive.reduce((sum, outcome) => sum + outcome.weight, 0);
  const weightedPayout = positive.reduce(
    (sum, outcome) => sum + outcome.weight * outcome.multiplier,
    0
  );
  const denominator = weightedPayout - target * positiveWeight;
  if (zeroWeight <= 0 || denominator <= 0) return outcomes;
  const scale = target * zeroWeight / denominator;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 25) return outcomes;
  return outcomes.map((outcome) => outcome.multiplier > 0
    ? { ...outcome, weight: outcome.weight * scale }
    : { ...outcome });
}

function deterministicPick(outcomes, seed) {
  const weighted = outcomes.map((outcome) => ({
    ...outcome,
    scaledWeight: Math.max(1, Math.round(outcome.weight * 1000))
  }));
  const total = weighted.reduce((sum, outcome) => sum + outcome.scaledWeight, 0);
  if (!total) throw gameError('GAME_CONFIGURATION_INVALID', 500);
  let point = Math.abs(Number(seed || 0)) % total;
  for (const outcome of weighted) {
    if (point < outcome.scaledWeight) return outcome;
    point -= outcome.scaledWeight;
  }
  return weighted[weighted.length - 1];
}

function pruneObjectByCreatedAt(value, maximum = 180, protectedKeys = []) {
  const entries = Object.entries(value || {});
  if (entries.length <= maximum) return value;
  const protectedSet = new Set((protectedKeys || []).map(String));
  const removable = entries
    .filter(([key]) => !protectedSet.has(String(key)))
    .sort((a, b) => {
      const timeDelta = Number(a[1] && a[1].createdAt || 0) - Number(b[1] && b[1].createdAt || 0);
      return timeDelta || String(a[0]).localeCompare(String(b[0]));
    });
  let removeCount = Math.max(0, entries.length - maximum);
  for (const [key] of removable) {
    if (removeCount <= 0) break;
    delete value[key];
    removeCount -= 1;
  }
  return value;
}

function receiptNamespace(gameId) {
  return `gameV219_${gameId}`;
}

function receiptBucket(profile, gameId) {
  if (!profile.serverReceipts || typeof profile.serverReceipts !== 'object') profile.serverReceipts = {};
  const namespace = receiptNamespace(gameId);
  if (!profile.serverReceipts[namespace] || typeof profile.serverReceipts[namespace] !== 'object') {
    profile.serverReceipts[namespace] = {};
  }
  return profile.serverReceipts[namespace];
}

async function retry(action, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 90 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function holdRound(db, input) {
  const userRef = db.ref(`users/${input.uid}`);
  let abortCode = '';
  let held = null;
  let tx;
  try {
    tx = await userRef.transaction((profile) => {
      abortCode = '';
      held = null;
      if (!profile || typeof profile !== 'object') {
        abortCode = 'USER_NOT_FOUND';
        return;
      }
      if (profile.frozen === true || profile.isFrozen === true) {
        abortCode = 'ACCOUNT_FROZEN';
        return;
      }
      if (Number(profile.selfExcludedUntil || 0) > input.now) {
        abortCode = 'SELF_EXCLUDED';
        return;
      }
      const bucket = receiptBucket(profile, input.gameId);
      const existing = bucket[input.requestId];
      if (existing && typeof existing === 'object') {
        if (money(existing.bet) !== input.bet || existing.operationId !== input.operationId) {
          abortCode = 'REQUEST_ID_REUSED';
          return;
        }
        held = existing;
        return profile;
      }

      const freeSpins = Math.max(0, Math.floor(Number(profile.freeSpins || 0)));
      const promoRound = input.allowFreeSpin === true && freeSpins > 0;
      let split = {
        realBefore: money(profile.realBalance),
        bonusBefore: money(profile.bonusBalance),
        useReal: 0,
        useBonus: 0,
        realAfterHold: money(profile.realBalance),
        bonusAfterHold: money(profile.bonusBalance)
      };
      if (promoRound) {
        profile.freeSpins = freeSpins - 1;
      } else {
        split = paymentSplit(profile, input.bet, input.allowReal, input.allowBonus);
        if (!split) {
          abortCode = 'INSUFFICIENT_PLAYABLE_BALANCE';
          return;
        }
        profile.realBalance = split.realAfterHold;
        profile.bonusBalance = split.bonusAfterHold;
      }
      profile.updatedAt = input.now;
      held = {
        operationId: input.operationId,
        requestId: input.requestId,
        gameId: input.gameId,
        gameName: input.gameName,
        bet: input.bet,
        randomSeed: input.randomSeed,
        promoRound,
        freeSpin: promoRound,
        paidFromReal: split.useReal,
        paidFromBonus: split.useBonus,
        realBefore: split.realBefore,
        bonusBefore: split.bonusBefore,
        realAfterHold: split.realAfterHold,
        bonusAfterHold: split.bonusAfterHold,
        status: 'held',
        createdAt: input.now,
        updatedAt: input.now,
        source: 'server_v219'
      };
      bucket[input.requestId] = held;
      pruneObjectByCreatedAt(bucket, 120, [input.requestId]);
      return profile;
    }, undefined, false);
  } catch (cause) {
    const recovered = (await userRef.child(`serverReceipts/${receiptNamespace(input.gameId)}/${input.requestId}`).once('value')).val();
    if (recovered && typeof recovered === 'object') return recovered;
    const error = gameError('GAME_USER_HOLD_FAILED', 500);
    error.cause = cause;
    throw error;
  }
  if (!tx.committed || !held) throw gameError(abortCode || 'GAME_USER_HOLD_FAILED', abortCode ? 409 : 500);
  return held;
}

async function accountTreasury(db, input) {
  const gameRef = db.ref(`game_treasury/by_game/${input.gameId}`);
  let abortCode = '';
  let accounting = null;
  let tx;
  try {
    tx = await gameRef.transaction((raw) => {
    abortCode = '';
    accounting = null;
    const prepared = normalizeTreasuryNode(raw, input.settings, input.gameId, input.gameName, input.now);
    const game = prepared.node;
    const operations = game.recentOperations;
    const existing = operations[input.operationId];
    if (existing && typeof existing === 'object') {
      if (existing.requestId !== input.requestId || existing.uid !== input.uid) {
        abortCode = 'REQUEST_ID_REUSED';
        return;
      }
      if (existing.status === 'rolled_back') {
        abortCode = 'GAME_SETTLEMENT_FAILED';
        return;
      }
      accounting = existing;
      return game;
    }

    const platformCut = input.promoRound ? 0 : money(input.paidFromReal * input.settings.platformCutPercent / 100);
    const playerPoolAdd = input.promoRound ? 0 : money(input.paidFromReal - platformCut);
    const availableAfterIncome = money(game.playerPool + playerPoolAdd);
    let candidates = normalizeOutcomes(input.outcomes);
    if (input.promoRound && Number(input.promoMaxMultiplier || 0) > 0) {
      candidates = candidates.filter((candidate) => candidate.multiplier <= input.promoMaxMultiplier);
    }
    candidates = candidates.filter((candidate) => money(input.bet * candidate.multiplier) <= availableAfterIncome);
    if (!candidates.some((candidate) => candidate.multiplier === 0)) {
      candidates.push({ type: 'loss', multiplier: 0, weight: 1, label: '0x', segmentIndex: 0, fallAfterOptions: [] });
    }
    if (input.rebalanceTargetRtp === true) {
      candidates = rebalanceForTargetRtp(candidates, (100 - input.settings.platformCutPercent) / 100);
    }
    const picked = deterministicPick(candidates, input.randomSeed);
    const payout = money(input.bet * picked.multiplier);
    if (payout > availableAfterIncome) {
      abortCode = 'GAME_TREASURY_LOW';
      return;
    }
    const fallAfterMultiplier = picked.fallAfterOptions.length
      ? picked.fallAfterOptions[Math.abs(Number(input.randomSeed || 0)) % picked.fallAfterOptions.length]
      : 0;

    game.totalBetsReal = money(game.totalBetsReal + input.paidFromReal);
    game.totalBetsBonus = money(game.totalBetsBonus + input.paidFromBonus);
    game.platformProfit = money(game.platformProfit + platformCut);
    game.playerPool = money(availableAfterIncome - payout);
    game.paidOut = money(game.paidOut + payout);
    game.roundsCount += 1;
    game.updatedAt = input.now;

    accounting = {
      operationId: input.operationId,
      requestId: input.requestId,
      uid: input.uid,
      gameId: input.gameId,
      gameName: input.gameName,
      status: 'accounted',
      bet: input.bet,
      promoRound: input.promoRound,
      paidFromReal: input.paidFromReal,
      paidFromBonus: input.paidFromBonus,
      platformCut,
      playerPoolAdd,
      openingSeed: prepared.openingSeed,
      playerPoolAfter: game.playerPool,
      payout,
      won: payout > 0,
      type: picked.type,
      multiplier: picked.multiplier,
      label: picked.label,
      segmentIndex: picked.segmentIndex,
      fallAfterMultiplier,
      createdAt: input.now,
      updatedAt: input.now,
      source: 'server_v219'
    };
    operations[input.operationId] = accounting;
    pruneObjectByCreatedAt(operations, 180, [input.operationId]);
    return game;
    }, undefined, false);
  } catch (cause) {
    const error = gameError('GAME_TREASURY_ACCOUNTING_FAILED', 500);
    error.cause = cause;
    throw error;
  }
  if (!tx.committed || !accounting) throw gameError(abortCode || 'GAME_TREASURY_ACCOUNTING_FAILED', abortCode ? 409 : 500);
  return accounting;
}

async function finalizeRound(db, input) {
  const userRef = db.ref(`users/${input.uid}`);
  let abortCode = '';
  let completed = null;
  let tx;
  try {
    tx = await userRef.transaction((profile) => {
    abortCode = '';
    completed = null;
    if (!profile || typeof profile !== 'object') {
      abortCode = 'USER_NOT_FOUND';
      return;
    }
    const bucket = receiptBucket(profile, input.gameId);
    const receipt = bucket[input.requestId];
    if (!receipt || typeof receipt !== 'object') {
      abortCode = 'GAME_RECEIPT_NOT_FOUND';
      return;
    }
    if (receipt.status === 'complete') {
      completed = receipt;
      return profile;
    }
    if (receipt.status !== 'held') {
      abortCode = 'GAME_SETTLEMENT_FAILED';
      return;
    }
    if (receipt.operationId !== input.accounting.operationId) {
      abortCode = 'REQUEST_ID_REUSED';
      return;
    }
    const realBeforePayout = money(profile.realBalance);
    const realAfter = money(realBeforePayout + input.accounting.payout);
    const bonusAfter = money(profile.bonusBalance);
    profile.realBalance = realAfter;
    profile.updatedAt = input.now;
    Object.assign(receipt, {
      status: 'complete',
      payout: input.accounting.payout,
      won: input.accounting.won,
      type: input.accounting.type,
      multiplier: input.accounting.multiplier,
      label: input.accounting.label,
      segmentIndex: input.accounting.segmentIndex,
      fallAfterMultiplier: input.accounting.fallAfterMultiplier,
      platformCut: input.accounting.platformCut,
      playerPoolAdd: input.accounting.playerPoolAdd,
      openingSeed: input.accounting.openingSeed,
      playerPoolAfter: input.accounting.playerPoolAfter,
      realBeforePayout,
      realAfter,
      bonusAfter,
      balances: { realBalance: realAfter, bonusBalance: bonusAfter },
      settledAt: input.now,
      updatedAt: input.now,
      source: 'server_v219'
    });
    completed = receipt;
    return profile;
    }, undefined, false);
  } catch (cause) {
    const error = gameError('GAME_SETTLEMENT_FAILED', 500);
    error.cause = cause;
    throw error;
  }
  if (!tx.committed || !completed) throw gameError(abortCode || 'GAME_SETTLEMENT_FAILED', abortCode ? 409 : 500);
  return completed;
}

async function rollbackTreasury(db, input) {
  const gameRef = db.ref(`game_treasury/by_game/${input.gameId}`);
  let rolledBack = null;
  await gameRef.transaction((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const operations = raw.recentOperations && typeof raw.recentOperations === 'object'
      ? raw.recentOperations : {};
    const operation = operations[input.operationId];
    if (!operation || operation.status !== 'accounted') return raw;
    raw.totalBetsReal = Math.max(0, money(raw.totalBetsReal - operation.paidFromReal));
    raw.totalBetsBonus = Math.max(0, money(raw.totalBetsBonus - operation.paidFromBonus));
    raw.platformProfit = Math.max(0, money(raw.platformProfit - operation.platformCut));
    raw.playerPool = Math.max(0, money(raw.playerPool - operation.playerPoolAdd + operation.payout));
    raw.paidOut = Math.max(0, money(raw.paidOut - operation.payout));
    raw.roundsCount = Math.max(0, Math.floor(Number(raw.roundsCount || 0)) - 1);
    raw.updatedAt = Date.now();
    operation.status = 'rolled_back';
    operation.rollbackReason = safeText(input.reason, 200);
    operation.updatedAt = Date.now();
    rolledBack = { ...operation };
    return raw;
  }, undefined, false);
  return rolledBack;
}

async function refundRound(db, input) {
  const userRef = db.ref(`users/${input.uid}`);
  let refunded = null;
  await userRef.transaction((profile) => {
    if (!profile || typeof profile !== 'object') return profile;
    const bucket = receiptBucket(profile, input.gameId);
    const receipt = bucket[input.requestId];
    if (!receipt || receipt.status !== 'held') return profile;
    profile.realBalance = money(profile.realBalance + receipt.paidFromReal);
    profile.bonusBalance = money(profile.bonusBalance + receipt.paidFromBonus);
    if (receipt.promoRound) profile.freeSpins = Math.max(0, Math.floor(Number(profile.freeSpins || 0)) + 1);
    profile.updatedAt = Date.now();
    receipt.status = 'refunded';
    receipt.refundReason = safeText(input.reason, 200);
    receipt.refundedAt = Date.now();
    receipt.updatedAt = Date.now();
    refunded = { ...receipt };
    return profile;
  }, undefined, false);
  return refunded;
}

async function settleRound(options) {
  const db = options.db;
  if (!db || typeof db.ref !== 'function') throw gameError('GAME_ENGINE_UNAVAILABLE', 503);
  const now = Number(options.now || Date.now());
  const gameId = validGameId(options.gameId);
  const bet = money(options.bet);
  if (!(bet > 0)) throw gameError('GAME_BET_OUT_OF_RANGE', 400);
  const requestId = safeText(options.requestId, 160);
  if (!requestId) throw gameError('INVALID_REQUEST_ID', 400);
  const operationId = safeText(options.operationId, 180);
  if (!operationId) throw gameError('INVALID_REQUEST_ID', 400);
  const settings = normalizeSettings(options.settings);
  const randomSeed = Number.isInteger(options.randomSeed)
    ? Math.abs(options.randomSeed)
    : crypto.randomInt(0, 2_147_483_647);

  const held = await retry(() => holdRound(db, {
    uid: options.uid,
    requestId,
    operationId,
    gameId,
    gameName: options.gameName,
    bet,
    allowReal: options.allowReal !== false,
    allowBonus: options.allowBonus === true,
    allowFreeSpin: options.allowFreeSpin === true,
    randomSeed,
    now
  }), 3);
  if (held.status === 'complete') {
    return { duplicate: true, receipt: held, accounting: null };
  }
  if (held.status === 'refunded') throw gameError('REQUEST_ID_REUSED', 409);

  let accounting;
  try {
    accounting = await retry(() => accountTreasury(db, {
      uid: options.uid,
      requestId,
      operationId,
      gameId,
      gameName: options.gameName,
      bet,
      paidFromReal: money(held.paidFromReal),
      paidFromBonus: money(held.paidFromBonus),
      promoRound: held.promoRound === true,
      randomSeed: Number(held.randomSeed || randomSeed),
      outcomes: options.outcomes,
      promoMaxMultiplier: Number(options.promoMaxMultiplier || 0),
      rebalanceTargetRtp: options.rebalanceTargetRtp === true,
      settings,
      now
    }), 3);
  } catch (error) {
    await retry(() => refundRound(db, { uid: options.uid, requestId, gameId, reason: error.message }), 3).catch(() => null);
    throw error;
  }

  let receipt;
  try {
    receipt = await retry(() => finalizeRound(db, {
      uid: options.uid,
      requestId,
      gameId,
      accounting,
      now: Date.now()
    }), 3);
  } catch (error) {
    await Promise.allSettled([
      retry(() => rollbackTreasury(db, { gameId, operationId, reason: error.message }), 3),
      retry(() => refundRound(db, { uid: options.uid, requestId, gameId, reason: error.message }), 3)
    ]);
    throw gameError('GAME_SETTLEMENT_FAILED', 500);
  }
  return { duplicate: false, receipt, accounting };
}

module.exports = {
  money,
  normalizeSettings,
  normalizeTreasuryNode,
  normalizeOutcomes,
  rebalanceForTargetRtp,
  deterministicPick,
  settleRound,
  holdRound,
  accountTreasury,
  finalizeRound,
  rollbackTreasury,
  refundRound,
  receiptNamespace
};
