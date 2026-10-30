'use strict';
function numberValue(value){const n=Number(value||0);return Number.isFinite(n)?Math.round((n+Number.EPSILON)*100)/100:0;}
function buildAuthenticatedUserView(decodedToken, identity){
  const profile=identity&&identity.profile&&typeof identity.profile==='object'?identity.profile:{};
  const authUid=String(decodedToken&&decodedToken.uid||'');
  return {
    uid:authUid,
    authUid,
    financialUid:String(identity&&identity.uid||authUid),
    databaseUid:String(identity&&identity.uid||authUid),
    accountSource:String(identity&&identity.source||'resolved'),
    email:decodedToken&&decodedToken.email||profile.email||null,
    phoneNumber:decodedToken&&decodedToken.phone_number||profile.phoneNumber||profile.phone||null,
    emailVerified:decodedToken&&decodedToken.email_verified===true,
    signInProvider:decodedToken&&decodedToken.firebase&&decodedToken.firebase.sign_in_provider||null,
    profile:{
      uid:String(identity&&identity.uid||authUid),
      publicId:profile.publicId||profile.userId||profile.accountNumber||'',
      userId:profile.userId||profile.publicId||profile.accountNumber||'',
      accountNumber:profile.accountNumber||profile.publicId||profile.userId||'',
      name:profile.name||profile.displayName||decodedToken&&decodedToken.name||'',
      displayName:profile.displayName||profile.name||decodedToken&&decodedToken.name||'',
      email:profile.email||decodedToken&&decodedToken.email||'',
      phoneNumber:profile.phoneNumber||profile.phone||decodedToken&&decodedToken.phone_number||'',
      realBalance:numberValue(profile.realBalance),
      bonusBalance:numberValue(profile.bonusBalance),
      reservedWithdrawalBalance:numberValue(profile.reservedWithdrawalBalance),
      freeSpins:Number(profile.freeSpins||0),
      freeTickets:Number(profile.freeTickets||profile.freeLotteryTickets||0),
      isFrozen:profile.isFrozen===true||profile.frozen===true,
      isVIP:profile.isVIP===true,
      vipUntil:Number(profile.vipUntil||0),
      selfExcludedUntil:Number(profile.selfExcludedUntil||0),
      role:profile.role||'user',
      isAdmin:profile.isAdmin===true
    }
  };
}
module.exports={buildAuthenticatedUserView};
