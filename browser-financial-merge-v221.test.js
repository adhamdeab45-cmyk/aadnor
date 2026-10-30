'use strict';
const assert=require('node:assert/strict');
let currentUser={uid:'auth_uid'};
let adnorFinancialUid='legacy_wallet';
let adnorServerFinancialProfile={uid:'legacy_wallet',realBalance:299886.11,bonusBalance:7,publicId:'100999'};
const fields=['realBalance','bonusBalance','reservedWithdrawalBalance','freeSpins','freeTickets','freeLotteryTickets','adnBalance','referralBonusEarned','isFrozen','frozen','isVIP','vipUntil','selfExcludedUntil'];
function merge(base={}){const merged={...base},financial=adnorServerFinancialProfile||{};fields.forEach(k=>{if(financial[k]!==undefined)merged[k]=financial[k]});['publicId','userId','accountNumber'].forEach(k=>{if(financial[k])merged[k]=financial[k]});merged.authUid=currentUser.uid;merged.financialUid=adnorFinancialUid;return merged}
let profile=merge({uid:'auth_uid',realBalance:0,bonusBalance:0,name:'User'});
assert.equal(profile.realBalance,299886.11);assert.equal(profile.financialUid,'legacy_wallet');
adnorServerFinancialProfile={...adnorServerFinancialProfile,realBalance:299887.11,bonusBalance:6};profile=merge({uid:'auth_uid',realBalance:0,bonusBalance:0});assert.equal(profile.realBalance,299887.11);assert.equal(profile.bonusBalance,6);
console.log('V221_BROWSER_FINANCIAL_MERGE_OK');
