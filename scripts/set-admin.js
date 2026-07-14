'use strict';
const admin=require('firebase-admin');
const email=process.argv[2];
if(!email){console.error('Usage: node scripts/set-admin.js admin@email.com');process.exit(1)}
admin.initializeApp({credential:admin.credential.applicationDefault(),databaseURL:'https://adhamnnn-8a4d2-default-rtdb.firebaseio.com'});
(async()=>{
  const u=await admin.auth().getUserByEmail(email);
  const claims={...(u.customClaims||{}),admin:true,agent:false};
  await admin.auth().setCustomUserClaims(u.uid,claims);
  await admin.auth().revokeRefreshTokens(u.uid);
  await admin.database().ref().update({
    [`admins/${u.uid}`]:{email:u.email||email,active:true,createdAt:Date.now(),updatedAt:Date.now()},
    [`agents/${u.uid}/active`]:null,
    [`public_agents/${u.uid}`]:null
  });
  console.log('Admin enabled and old sessions revoked:',u.email,u.uid);
  console.log('Ask the user to sign out and sign in again before opening admin.html.');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
