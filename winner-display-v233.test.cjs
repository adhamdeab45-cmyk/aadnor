const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const root=require('node:path').resolve(__dirname,'../../01-website')+require('node:path').sep;
const index=fs.readFileSync(root+'index.html','utf8');
const app=fs.readFileSync(root+'app.html','utf8');
function extract(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);if(a<0||b<0)throw new Error('missing '+start);return text.slice(a,b)}
const normalize=extract(index,'function normalizeResults(raw){','let publicUnsub=null,resultUnsub=null,gamesUnsub=null;');
const indexVm={Date,Set};vm.createContext(indexVm);vm.runInContext(normalize+'\nglobalThis.normalizeResults=normalizeResults;',indexVm);
const now=Date.now();
const rows=indexVm.normalizeResults({
  published:{daily:{drawType:'daily',winnerName:'OLD PUBLISHED',ticketNumber:'1111111',status:'published',publishAt:now-3000}},
  current:{daily:{drawType:'daily',winnerName:'NEW WINNER',ticketNumber:'2222222',status:'published',publishAt:now,updatedAt:now},weekly:{drawType:'weekly',winnerName:'WEEKLY',ticketNumber:'3333333',status:'published',publishAt:now-1000}},
  history:{daily:{old:{drawType:'daily',winnerName:'HISTORY OLD',ticketNumber:'4444444',status:'published',publishAt:now-5000}}},
  latestPublished:{drawType:'daily',winnerName:'STALE FALLBACK',ticketNumber:'5555555',status:'published',publishAt:now-9000}
});
assert.equal(rows.length,2);
assert.equal(rows.find(x=>x.type==='daily').name,'NEW WINNER');
assert.equal(rows.some(x=>x.name==='HISTORY OLD'||x.name==='STALE FALLBACK'),false);
const hidden=indexVm.normalizeResults({published:{daily:{drawType:'daily',winnerName:'OLD',ticketNumber:'1111111',status:'published'}},current:{daily:{drawType:'daily',winnerName:'OLD',ticketNumber:'1111111',status:'hidden',updatedAt:now}},latestPublished:{winnerName:'OLD',ticketNumber:'1111111',status:'published'}});
assert.equal(hidden.length,0,'hidden current result must not fall back to stale published result');
const selection=extract(app,'function v144PublishedRaw(type){','function v144DueScheduled(type)');
const selectionVm={v108Results:{published:{daily:{winnerName:'OLD',status:'published',updatedAt:now-1000}},current:{daily:{winnerName:'NEW',status:'published',updatedAt:now}}},v144Status:r=>String(r.status||''),v108IsVisible:r=>r.status==='published',v144SafeResult:r=>r,V144_PATH:'official'};
vm.createContext(selectionVm);vm.runInContext(selection+'\nglobalThis.pick=v144PublishedRaw;',selectionVm);
assert.equal(selectionVm.pick('daily').winnerName,'NEW');
const ticker=extract(app,'function v144TickerHtml(){','function v144RenderTicker()');
const tickerVm={V144_TYPES:['daily','weekly','monthly','yearly'],v144LatestVisible:()=>({winnerName:'LATEST ONLY'}),v144TickerSpanPublished:r=>'<b>'+r.winnerName+'</b>',v144TickerSpanUpcoming:t=>'<i>UPCOMING '+t+'</i>'};
vm.createContext(tickerVm);vm.runInContext(ticker+'\nglobalThis.makeTicker=v144TickerHtml;',tickerVm);
const html=tickerVm.makeTicker();
assert.equal((html.match(/LATEST ONLY/g)||[]).length,1);
assert.equal((html.match(/<b>/g)||[]).length,1,'ticker should contain one winner item');
assert.match(app,/animation-duration:30s!important/);
assert.match(app,/v108Results\.published=\{\.\.\.results\}/);
assert.doesNotMatch(app,/v108Results\.published=\{\.\.\.\(v108Results\.published/);
console.log('V228 winners OK: newest current result wins, history is excluded, hidden stale rows stay hidden, and ticker shows one winner.');
