'use strict';
const fs=require('fs');
const path=require('path');
const cp=require('child_process');
const root=path.resolve(__dirname,'..');
let failed=false;
const ok=m=>console.log('✓',m);
const bad=m=>{failed=true;console.error('✗',m)};
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);if(e.name==='node_modules'||e.name.startsWith('.git'))return[];return e.isDirectory()?walk(p):[p]})}
const files=walk(root);
const rel=f=>path.relative(root,f);
const required=['index.html','admin.html','agent.html','bootstrap.html','firebase.json','.firebaserc','database.rules.json','storage.rules','database.seed.json','functions/index.js','README_AR.md','DEPLOY_CHECKLIST_AR.md','SECURITY_AR.md'];
for(const f of required)fs.existsSync(path.join(root,f))?ok('Required '+f):bad('Missing required file: '+f);
for(const f of files.filter(f=>f.endsWith('.js'))){try{cp.execFileSync(process.execPath,['--check',f],{stdio:'pipe'});ok('JS '+rel(f))}catch(e){bad('JS '+rel(f)+'\n'+String(e.stderr||e.message))}}
for(const f of files.filter(f=>f.endsWith('.json'))){try{JSON.parse(fs.readFileSync(f,'utf8'));ok('JSON '+rel(f))}catch(e){bad('JSON '+rel(f)+': '+e.message)}}
const html=files.filter(f=>f.endsWith('.html'));
for(const f of html){
  const s=fs.readFileSync(f,'utf8'),ids=[...s.matchAll(/\bid=["']([^"']+)/g)].map(x=>x[1]),dups=[...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))];
  if(dups.length)bad('Duplicate IDs '+rel(f)+': '+dups.join(','));else ok('HTML IDs '+rel(f));
  for(const m of s.matchAll(/(?:href|src)=["']([^"']+)/g)){
    const ref=m[1].split(/[?#]/)[0];if(!ref||/^(https?:|mailto:|tel:|data:|javascript:|#)/.test(ref))continue;
    const target=path.resolve(path.dirname(f),ref);if(!fs.existsSync(target))bad('Missing '+rel(target)+' from '+rel(f));
  }
}
const frontendFiles=['assets/js/app.js','assets/js/admin.js','assets/js/agent.js','bootstrap.html'];
const front=frontendFiles.map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
const back=fs.readFileSync(path.join(root,'functions/index.js'),'utf8');
const called=new Set([...front.matchAll(/(?:call|httpsCallable)\(["']([^"']+)/g)].map(x=>x[1]));
const exportList=[...back.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)].map(x=>x[1]);
const exported=new Set(exportList);
for(const name of called)if(!exported.has(name))bad('Missing backend export: '+name);else ok('Callable '+name);
const duplicateExports=[...new Set(exportList.filter((x,i)=>exportList.indexOf(x)!==i))];
if(duplicateExports.length)bad('Duplicate backend exports: '+duplicateExports.join(','));else ok('Unique backend exports ('+exported.size+')');
if(exported.size<30)bad('Unexpectedly low Cloud Functions export count: '+exported.size);

const forbidden=['ADN Token','token market','adnBalance','adn_market'];
const source=files.filter(f=>/\.(js|html|css|json)$/.test(f)&&path.resolve(f)!==path.resolve(__filename)).map(f=>fs.readFileSync(f,'utf8')).join('\n').toLowerCase();
for(const term of forbidden)if(source.includes(term.toLowerCase()))bad('Removed ADN feature returned: '+term);else ok('Removed feature absent: '+term);

// Frontend must never write sensitive financial paths directly.
const sensitiveWrites=[/ref\([^\n]{0,220}(?:realBalance|bonusBalance|reservedBalance)[^\n]{0,220}\)\s*\.(?:set|update|transaction|remove)\s*\(/i,/ref\([^\n]{0,220}(?:draw_jobs|draw_tickets|agent_recharges|finance\/)[^\n]{0,220}\)\s*\.(?:set|update|transaction|remove)\s*\(/i];
for(const pattern of sensitiveWrites)pattern.test(front)?bad('Possible direct sensitive frontend database write: '+pattern):ok('No direct sensitive frontend write: '+pattern);

const rules=JSON.parse(fs.readFileSync(path.join(root,'database.rules.json'),'utf8'));
const rulesText=JSON.stringify(rules);
if(!rulesText.includes("root.child('admins').child(auth.uid).child('active').val() === true"))bad('Database admin rules do not verify live admin status.');else ok('Database rules verify live admin status');
const storage=fs.readFileSync(path.join(root,'storage.rules'),'utf8');
if(!storage.includes('allow update, delete: if false'))bad('Storage evidence is not immutable.');else ok('Storage evidence is immutable');
const seed=JSON.parse(fs.readFileSync(path.join(root,'database.seed.json'),'utf8'));
if(seed.settings?.global?.depositEnabled!==false||seed.settings?.global?.withdrawEnabled!==false)bad('Safe seed must start deposit and withdrawal disabled.');else ok('Safe seed starts money movement disabled');
const methods=Object.values(seed.payment_methods||{});
if(methods.some(m=>m&&m.active===true))bad('Safe seed contains an active payment method.');else ok('Safe seed has no active payment method');
const fb=JSON.parse(fs.readFileSync(path.join(root,'firebase.json'),'utf8'));
const ignored=(fb.hosting?.ignore||[]).join(' ');
if(!ignored.includes('functions/**')||!ignored.includes('database.seed.json'))bad('Hosting ignore list may expose private project files.');else ok('Hosting excludes server/private files');
const serviceFiles=files.filter(f=>/service.?account/i.test(path.basename(f))&&f.endsWith('.json'));
if(serviceFiles.length)bad('Service-account JSON found in project: '+serviceFiles.map(rel).join(','));else ok('No service-account JSON included');
const indexHtml=fs.readFileSync(path.join(root,'index.html'),'utf8');
const appJs=fs.readFileSync(path.join(root,'assets/js/app.js'),'utf8');
if(!indexHtml.includes('id="officialTicker"')||!appJs.includes('rebuildTicker'))bad('Official ticker is missing or not data-driven.');else ok('Official ticker is present and data-driven');
if(!appJs.includes("support.href=c.supportEmail?'mailto:'+c.supportEmail:'#trust'"))bad('Public support fallback may expose a fake email.');else ok('Public support link has a safe fallback');
if(!back.includes('deposit_proof_usage'))bad('Deposit proof reuse protection is missing.');else ok('Deposit proof reuse protection present');
if(!back.includes('draw_cycles'))bad('Draw-cycle snapshot protection is missing.');else ok('Draw-cycle snapshot protection present');
if(!back.includes('{...current,completed:true'))bad('Task claim state preservation protection is missing.');else ok('Task claim state preservation protection present');

if(failed){console.error('\nQA FAILED');process.exit(1)}
console.log('\nQA PASSED');
