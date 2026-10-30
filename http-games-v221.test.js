'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const {resolveAuthenticatedUser,clearResolverCache}=require('../src/auth-user-resolver-v221');
const {buildAuthenticatedUserView}=require('../src/auth-account-view-v221');
const {settleRound}=require('../src/game-engine-v219');
function clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v))}
function parts(p){return String(p||'').split('/').filter(Boolean)}
function getAt(root,path){let n=root;for(const k of parts(path)){if(!n||typeof n!=='object')return undefined;n=n[k]}return n}
function setAt(root,path,value){const keys=parts(path);if(!keys.length){for(const k of Object.keys(root))delete root[k];if(value&&typeof value==='object')Object.assign(root,clone(value));return}let n=root;for(let i=0;i<keys.length-1;i++){if(!n[keys[i]]||typeof n[keys[i]]!=='object')n[keys[i]]={};n=n[keys[i]]}const last=keys[keys.length-1];if(value==null)delete n[last];else n[last]=clone(value)}
class Snapshot{constructor(v){this.v=clone(v)}val(){return clone(this.v)}exists(){return this.v!==undefined&&this.v!==null}}
class Ref{constructor(db,path,q={}){this.db=db;this.path=path;this.q=q}child(p){return new Ref(this.db,this.path?`${this.path}/${p}`:p,this.q)}orderByChild(field){return new Ref(this.db,this.path,{...this.q,field})}equalTo(equal){return new Ref(this.db,this.path,{...this.q,equal})}limitToFirst(limit){return new Ref(this.db,this.path,{...this.q,limit})}async once(){let value=getAt(this.db.data,this.path);if(this.q.field&&value&&typeof value==='object'){const out={};for(const [k,item] of Object.entries(value)){if(item&&typeof item==='object'&&item[this.q.field]===this.q.equal){out[k]=item;if(Object.keys(out).length>=Number(this.q.limit||Infinity))break}}value=out}return new Snapshot(value)}async update(updates){for(const [p,v] of Object.entries(updates||{}))setAt(this.db.data,this.path?`${this.path}/${p}`:p,v)}async set(value){setAt(this.db.data,this.path,value)}async transaction(cb){const current=clone(getAt(this.db.data,this.path));const next=cb(current);if(next===undefined)return{committed:false,snapshot:new Snapshot(current)};setAt(this.db.data,this.path,next);return{committed:true,snapshot:new Snapshot(next)}}}
class DB{constructor(data){this.data=clone(data)}ref(path=''){return new Ref(this,path)}}
const authUid='auth_live';
const token={uid:authUid,email:'player@test.com',email_verified:true,firebase:{sign_in_provider:'google.com'}};
const db=new DB({users:{
 [authUid]:{uid:authUid,email:'player@test.com',emailLower:'player@test.com',realBalance:0,bonusBalance:0,publicId:'100001',createdAt:200},
 wallet_live:{uid:'wallet_live',email:'player@test.com',emailLower:'player@test.com',realBalance:100,bonusBalance:0,publicId:'100999',createdAt:100}
}});
async function resolve(){return resolveAuthenticatedUser(db,token,{createIfMissing:true})}
async function game(gameId,requestId){const identity=await resolve();return settleRound({db,uid:identity.uid,requestId,operationId:`${gameId}_${requestId}`,gameId,gameName:gameId==='wheel'?'العجلة':'السنجاب',bet:1,allowReal:true,allowBonus:false,outcomes:[{type:'win',multiplier:2,weight:100,label:'x2',segmentIndex:1}],settings:{platformCutPercent:5,defaultOpeningReserve:5000},randomSeed:0,now:1700000000000+(gameId==='wheel'?1:2)});}
const server=http.createServer(async(req,res)=>{try{if(req.url==='/auth/me'){const identity=await resolve();return reply(res,200,{ok:true,authenticated:true,user:buildAuthenticatedUserView(token,identity)})}if(req.url==='/game/golden-squirrel/play'){const settled=await game('golden_squirrel','squirrel_http_1');return reply(res,200,{ok:true,result:settled.receipt})}if(req.url==='/game/wheel/spin'){const settled=await game('wheel','wheel_http_1');return reply(res,200,{ok:true,result:settled.receipt})}reply(res,404,{ok:false})}catch(e){reply(res,500,{ok:false,error:e.message})}});
function reply(res,status,obj){res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(obj))}
function request(port,path,method='GET'){return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port,path,method},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(b)}))});r.on('error',reject);r.end()})}
(async()=>{clearResolverCache();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const me=await request(port,'/auth/me');assert.equal(me.status,200);assert.equal(me.data.user.authUid,authUid);assert.equal(me.data.user.financialUid,'wallet_live');assert.equal(me.data.user.profile.realBalance,100);
 const sq=await request(port,'/game/golden-squirrel/play','POST');assert.equal(sq.status,200);assert.equal(sq.data.result.balances.realBalance,101);
 const wheel=await request(port,'/game/wheel/spin','POST');assert.equal(wheel.status,200);assert.equal(wheel.data.result.balances.realBalance,102);
 const duplicate=await request(port,'/game/wheel/spin','POST');assert.equal(duplicate.status,200);assert.equal(duplicate.data.result.balances.realBalance,102);
 assert.equal(db.data.users.wallet_live.realBalance,102);assert.equal(db.data.users[authUid].realBalance,0);assert.equal(db.data.auth_user_links[authUid].uid,'wallet_live');
 console.log('HTTP_GAMES_V221_OK');server.close();
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
