'use strict';
const admin=require('firebase-admin');
const apply=process.argv.includes('--apply');
admin.initializeApp({credential:admin.credential.applicationDefault(),databaseURL:'https://adhamnnn-8a4d2-default-rtdb.firebaseio.com'});
const db=admin.database();
const keyify=v=>String(v||'').trim().toLowerCase().replace(/[.#$\[\]/]/g,'_');
(async()=>{
  const root=(await db.ref().get()).val()||{},updates={};
  const copyIfMissing=(oldPath,newPath,oldVal,newVal)=>{if(oldVal!=null&&newVal==null)updates[newPath]=oldVal};
  copyIfMissing('lottery_settings','settings/lottery',root.lottery_settings,root.settings?.lottery);
  copyIfMissing('referral_settings','settings/referral',root.referral_settings,root.settings?.referral);
  copyIfMissing('wheel_settings','settings/games/wheel',root.wheel_settings,root.settings?.games?.wheel);
  copyIfMissing('system_settings','settings/global',root.system_settings,root.settings?.global);
  const users=root.users||{},profiles=root.profiles||{};let maxId=100000;
  for(const [uid,u] of Object.entries(users)){
    if(u.publicId){updates[`indexes/publicId/${keyify(u.publicId)}`]=uid;maxId=Math.max(maxId,Number(u.publicId)||0)}
    if(u.email)updates[`indexes/email/${keyify(u.email)}`]=uid;
    if(u.phoneNumber)updates[`indexes/phone/${keyify(u.phoneNumber)}`]=uid;
    if(u.referralCode)updates[`referral_codes/${keyify(u.referralCode)}`]=uid;
    if(!profiles[uid])updates[`profiles/${uid}`]={displayName:u.displayName||u.email||u.phoneNumber||'ADNOR User',language:'ar',createdAt:u.createdAt||Date.now()};
  }
  if(!root.counters?.publicId)updates['counters/publicId']=maxId;
  for(const [uid,a] of Object.entries(root.agents||{}))if(a.publicVisible!==false)updates[`public_agents/${uid}`]={name:a.name||a.login||'',country:a.country||'',city:a.city||'',whatsapp:a.whatsapp||'',telegram:a.telegram||'',paymentMethods:a.paymentMethods||'',workingHours:a.workingHours||'',verified:!!a.verified,active:a.active!==false,publicVisible:true,completedOperations:Number(a.completedOperations||0),lastActiveAt:Number(a.lastActiveAt||0),updatedAt:Date.now()};
  const oldDraws=root.public_draw_history||root.draw_history||{};
  if(!root.public_draws&&oldDraws&&typeof oldDraws==='object')for(const [id,d] of Object.entries(oldDraws))if(d&&(!d.status||d.status==='published'))updates[`public_draws/${id}`]={id,drawType:d.drawType||d.type||'daily',drawLabel:d.drawLabel||d.label||'',prize:Number(d.prize||d.amount||0),ticketNumber:d.ticketNumber||d.number||'',winnerNameMasked:d.winnerNameMasked||d.winnerName||'AD***',status:'published',published:true,publishAt:Number(d.publishAt||d.createdAt||Date.now()),publishedAt:Number(d.publishedAt||d.publishAt||d.createdAt||Date.now()),credited:d.credited!==false,reference:d.reference||id};
  console.log('Migration updates:',Object.keys(updates).length);console.log(Object.keys(updates).slice(0,30));
  if(!apply){console.log('DRY RUN ONLY. Re-run with --apply to merge these paths.');process.exit(0)}
  await db.ref().update(updates);console.log('Migration completed without deleting old data.');process.exit(0)
})().catch(e=>{console.error(e);process.exit(1)});
