'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..');
function snap(v=null){return{val:()=>v,exists:()=>v!==null&&v!==undefined}}
function firebaseMock(win){
  const refObj=p=>({
    on:(ev,cb)=>cb(snap(null)),off:()=>{},get:async()=>snap(null),once:async()=>snap(null),
    set:async()=>{},update:async()=>{},remove:async()=>{},
    push:()=>({key:'mockid',set:async()=>{}}),
    orderByChild:()=>refObj(p),equalTo:()=>refObj(p),limitToFirst:()=>refObj(p),limitToLast:()=>refObj(p),
    transaction:async fn=>({committed:true,snapshot:snap(fn(null))})
  });
  const db={ref:refObj};
  const authObj={currentUser:null,setPersistence:async()=>{},onAuthStateChanged:cb=>{cb(null);return()=>{}},signInWithPopup:async()=>({user:{}}),signInWithPhoneNumber:async()=>({confirm:async()=>({})}),signInWithEmailAndPassword:async()=>({}),signOut:async()=>{}};
  const funcs={httpsCallable:()=>async()=>({data:{ok:true}})};
  const storage={ref:()=>({put:async()=>({ref:{fullPath:'mock'}}),getDownloadURL:async()=>''})};
  function auth(){return authObj}auth.Auth={Persistence:{LOCAL:'local'}};auth.GoogleAuthProvider=function(){};auth.RecaptchaVerifier=function(){this.clear=()=>{}};
  function database(){return db}database.ServerValue={TIMESTAMP:Date.now()};
  function storageFn(){return storage}
  const appObj={functions:()=>funcs};
  const firebase={apps:[],initializeApp:()=>{firebase.apps.push(appObj);return appObj},app:()=>appObj,auth,database,storage:storageFn};
  win.firebase=firebase;
}
async function run(htmlFile,scripts,{inline=false}={}){
  const virtualConsole=new VirtualConsole();
  const errors=[];
  virtualConsole.on('jsdomError',e=>errors.push(e.stack||String(e)));
  const html=fs.readFileSync(path.join(root,htmlFile),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/'+htmlFile,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window;
  firebaseMock(w);
  w.addEventListener('error',e=>errors.push(e.error?.stack||e.message));
  w.addEventListener('unhandledrejection',e=>errors.push(String(e.reason||'Unhandled rejection')));
  w.alert=()=>{};w.confirm=()=>true;w.prompt=()=>'';w.navigator.clipboard={writeText:async()=>{}};w.scrollTo=()=>{};w.open=()=>{};if(!w.crypto.randomUUID)Object.defineProperty(w.crypto,'randomUUID',{value:crypto.randomUUID.bind(crypto)});
  for(const script of scripts)w.eval(fs.readFileSync(path.join(root,script),'utf8'));
  if(inline){for(const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)){const code=match[1].trim();if(code)w.eval(code)}}
  w.document.dispatchEvent(new w.Event('DOMContentLoaded',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,80));
  if(errors.length)throw new Error(`${htmlFile} runtime errors:\n${errors.join('\n')}`);
  console.log('✓ DOM smoke '+htmlFile);
  dom.window.close();
}
(async()=>{
  await run('index.html',['assets/js/firebase-config.js','assets/js/i18n.js','assets/js/ui.js','assets/js/app.js']);
  await run('admin.html',['assets/js/firebase-config.js','assets/js/i18n.js','assets/js/ui.js','assets/js/admin.js']);
  await run('agent.html',['assets/js/firebase-config.js','assets/js/i18n.js','assets/js/ui.js','assets/js/agent.js']);
  await run('bootstrap.html',['assets/js/firebase-config.js'],{inline:true});
  console.log('\nDOM SMOKE PASSED');
})().catch(e=>{console.error(e);process.exit(1)});
