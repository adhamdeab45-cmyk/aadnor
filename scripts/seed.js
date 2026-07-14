'use strict';
const admin=require('firebase-admin');const fs=require('fs');const path=require('path');
admin.initializeApp({credential:admin.credential.applicationDefault(),databaseURL:'https://adhamnnn-8a4d2-default-rtdb.firebaseio.com'});
const seed=JSON.parse(fs.readFileSync(path.join(__dirname,'..','database.seed.json'),'utf8'));
admin.database().ref().update(seed).then(()=>{console.log('ADNOR seed merged successfully.');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)});
