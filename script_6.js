
(function(){
  if(window.__ADNOR_MEGA_FINAL_PATCH_V14__) return;
  window.__ADNOR_MEGA_FINAL_PATCH_V14__ = true;

  function $(id){ return document.getElementById(id); }
  function q(sel){ return document.querySelector(sel); }
  function qa(sel){ return Array.from(document.querySelectorAll(sel)); }
  function safe(v){ return String(v == null ? '' : v); }
  function html(v){ try{return esc(v)}catch(e){return safe(v).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]})} }
  function num(v){ try{return n(v)}catch(e){ const x=Number(v); return Number.isFinite(x)?x:0; } }
  function money2(v){ try{return money(v)}catch(e){return '$'+Number(num(v)).toFixed(2)} }
  function arr2(v){ try{return arr(v)}catch(e){return Array.isArray(v)?v:(v&&typeof v==='object'?Object.values(v):[])} }
  function msg(t){ try{ toast(t); }catch(e){ alert(t); } }
  function uid(){ return APP && APP.user && APP.user.uid; }
  function getToken(){ return localStorage.getItem('ADNOR_ADMIN_TOKEN') || ''; }
  function setToken(v){ localStorage.setItem('ADNOR_ADMIN_TOKEN', v || ''); }
  function adminHeaders(){ return {'Content-Type':'application/json','X-Admin-Token':getToken()}; }
  async function apiPost(path, body){
    const r = await fetch(path,{method:'POST',headers:adminHeaders(),body:JSON.stringify(body||{}),cache:'no-store'});
    let j = null; try{ j = await r.json(); }catch(e){}
    if(!r.ok || !j || j.ok===false) throw new Error((j && (j.error||j.reason)) || ('HTTP '+r.status));
    return j;
  }
  function fileToDataURL(file, maxBytes){
    return new Promise(function(resolve,reject){
      if(!file) return resolve('');
      if(maxBytes && file.size > maxBytes) return reject(new Error('حجم الصورة كبير. اختر صورة أصغر.'));
      const r = new FileReader();
      r.onload = function(){ resolve(String(r.result||'')); };
      r.onerror = function(){ reject(new Error('فشل قراءة الصورة')); };
      r.readAsDataURL(file);
    });
  }
  function installStyle(){
    if($('adnorMegaStyle')) return;
    const st=document.createElement('style');
    st.id='adnorMegaStyle';
    st.textContent = `
      .version-badge,#server24Badge{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}
      #profileCard{display:none!important}
      .user-chip{direction:rtl!important;text-align:right!important;max-width:145px!important;color:#f8d774!important;font-weight:900!important}
      .draw-card{border-color:rgba(255,215,100,.42)!important;box-shadow:0 0 45px rgba(245,189,63,.14),var(--shadow)!important}
      .ticket-royal-panel{background:radial-gradient(circle at 50% 0,rgba(255,216,110,.20),rgba(2,8,18,.70))!important;border:1px solid rgba(255,216,110,.45)!important;box-shadow:inset 0 0 24px rgba(255,216,110,.09)!important}
      .ticket-box input,#ticketInput{background:linear-gradient(180deg,#071426,#102e56)!important;border:1px solid rgba(255,216,110,.65)!important;color:#ffe7a0!important;text-shadow:0 0 12px rgba(255,213,90,.58)!important;border-radius:18px!important;box-shadow:inset 0 0 20px rgba(0,0,0,.45),0 0 18px rgba(255,213,90,.15)!important}
      .last-machine{position:relative;overflow:hidden;border:1px solid rgba(255,216,110,.38)!important;background:linear-gradient(135deg,rgba(5,16,32,.90),rgba(17,43,80,.90))!important;box-shadow:inset 0 0 20px rgba(255,216,110,.08)!important}
      .last-machine b,.last-machine #drawStatusText{font-family:monospace!important;letter-spacing:2px;text-shadow:0 0 14px rgba(255,216,110,.55)}
      .last-machine:before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent);transform:translateX(-120%);animation:adnorSweep 3.2s infinite;pointer-events:none}@keyframes adnorSweep{70%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
      .wheel-card-royal{background:radial-gradient(circle at 50% 15%,rgba(245,189,63,.22),rgba(6,16,32,.98) 55%,#020711)!important;border:1px solid rgba(255,216,110,.55)!important;text-align:center;overflow:hidden}
      .wheel-card-royal h3{font-size:34px!important;text-shadow:0 0 18px rgba(245,189,63,.58)}
      .wheel-tools{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:12px 0}.wheel-tools button{min-width:54px;border-radius:14px;border:1px solid rgba(255,216,110,.52);background:rgba(0,0,0,.20);color:#ffe7a0;font-weight:900;padding:10px}
      .wheel-wrap{width:min(410px,90vw)!important;height:min(410px,90vw)!important}.wheel{border:9px solid #d99b20!important;box-shadow:0 0 40px rgba(245,189,63,.4),inset 0 0 35px rgba(0,0,0,.8)!important}.wheel-center{width:72px!important;height:72px!important;inset:calc(50% - 36px)!important;font-size:20px!important;box-shadow:0 0 28px rgba(245,189,63,.75)!important}.pointer{border-left-width:26px!important;border-right-width:26px!important;border-top-width:44px!important;top:-14px!important;filter:drop-shadow(0 0 12px rgba(255,210,80,.8))!important}
      .adnor-login-splash{position:fixed;inset:0;z-index:99000;background:radial-gradient(circle at 50% 10%,rgba(30,70,130,.98),#020711 70%);display:grid;place-items:center;padding:18px}.adnor-login-splash-card{width:min(520px,94vw);min-height:260px;border:1px solid rgba(255,216,110,.55);border-radius:26px;background:linear-gradient(145deg,rgba(14,36,67,.96),rgba(2,8,18,.96));box-shadow:0 30px 90px rgba(0,0,0,.65),0 0 45px rgba(245,189,63,.17);padding:22px;text-align:center;overflow:hidden}.adnor-login-splash-card img{max-width:100%;max-height:280px;border-radius:18px;margin:8px auto;display:block}.adnor-login-splash-card h2{color:#ffdf7d;margin:6px 0;text-shadow:0 0 14px rgba(255,216,110,.6)}.adnor-login-splash-count{margin-top:10px;color:#93fbd0;font-family:monospace;font-weight:900}.receipt-thumb{max-width:120px;max-height:100px;border-radius:10px;border:1px solid rgba(255,216,110,.35);display:block;margin:6px 0}.receipt-full{max-width:100%;border-radius:16px;border:1px solid rgba(255,216,110,.35)}
      .admin-note{border:1px solid rgba(24,242,155,.32);background:rgba(24,242,155,.07);border-radius:14px;padding:10px;margin:8px 0;color:#d7fff0}.danger-soft{border-color:rgba(239,68,68,.45)!important;background:rgba(239,68,68,.10)!important}
      @media(max-width:760px){.wheel-card-royal h3{font-size:28px!important}.user-chip{display:block!important;max-width:112px!important;font-size:9px!important}.wallet-pill{min-width:105px!important}.topgrid{grid-template-columns:42px 1fr auto!important}}
    `;
    document.head.appendChild(st);
  }
  function displayUser(u){
    if(!u) return 'ADNOR USER';
    const name = (u.name || u.username || u.displayName || '').trim();
    const id = (u.uid || '').slice(0,5).toUpperCase();
    return (name ? name : 'ADNOR USER') + (id ? ' | ID '+id : '');
  }
  function ensureNavOrder(){
    const nav=q('.bottomnav');
    if(!nav || nav.__adnorOrdered) return;
    nav.innerHTML = '<button id="nav-lottery" class="navbtn active" onclick="UI.page(\'lottery\')"><i class="fas fa-ticket"></i>اليانصيب</button><button id="nav-games" class="navbtn" onclick="UI.page(\'games\')"><i class="fas fa-gamepad"></i>الألعاب</button><button id="nav-wallet" class="navbtn" onclick="UI.page(\'wallet\')"><i class="fas fa-wallet"></i>المحفظة</button><button id="nav-support" class="navbtn" onclick="UI.page(\'support\')"><i class="fas fa-headset"></i>الدعم</button>';
    nav.__adnorOrdered = true;
  }
  function normalizeSettings(){
    if(!window.APP || !APP.settings) return;
    APP.settings.loginSplash = APP.settings.loginSplash || {enabled:false,duration:3,title:'أهلاً بك في ADNOR',text:'',imageData:'',mode:'eachLogin'};
    APP.settings.scratch = Object.assign({enabled:true,min:0.10,max:1,fixed:0,chance:35,cooldownHours:24,creditTo:'bonus'}, APP.settings.scratch||{});
    APP.settings.wheel = APP.settings.wheel || {};
    if(!APP.settings.wheel.slices || !APP.settings.wheel.slices.length || !APP.settings.wheel.royalVersion){
      APP.settings.wheel.slices = [
        {label:'1x',mult:1,weight:28,color:'#c51f2b'},
        {label:'2x',mult:2,weight:14,color:'#0d65b7'},
        {label:'4x',mult:4,weight:8,color:'#f59e0b'},
        {label:'8x',mult:8,weight:5,color:'#15803d'},
        {label:'16x',mult:16,weight:3,color:'#7c3aed'},
        {label:'32x',mult:32,weight:2,color:'#0f766e'},
        {label:'64x',mult:64,weight:1.2,color:'#b45309'},
        {label:'128x',mult:128,weight:.8,color:'#be123c'},
        {label:'236x',mult:236,weight:.45,color:'#2563eb'},
        {label:'472x',mult:472,weight:.25,color:'#16a34a'},
        {label:'5 تذاكر',mult:0,weight:3,color:'#d97706',ticketPrize:5},
        {label:'1000x',mult:1000,weight:.08,color:'#7f1d1d'},
        {label:'0x',mult:0,weight:35,color:'#111827'}
      ];
      APP.settings.wheel.royalVersion = 'v2-13';
    }
    APP.settings.wheel.userOverrides = APP.settings.wheel.userOverrides || {};
  }
  function maybeSaveNormalizedSettings(){
    try{
      if(isAdmin && isAdmin() && APP && APP.settings && !APP.__megaDefaultsSaved){
        APP.__megaDefaultsSaved=true;
        const patch={loginSplash:APP.settings.loginSplash,scratch:APP.settings.scratch,wheel:APP.settings.wheel};
        db.ref('global_system/settings').update(patch).catch(function(){});
      }
    }catch(e){}
  }
  function showLoginSplash(){
    try{
      const cfg=(APP.settings&&APP.settings.loginSplash)||{};
      if(!cfg.enabled) return;
      if(!APP.user) return;
      const key='ADNOR_LOGIN_SPLASH_'+(cfg.updatedAt||'default')+'_'+(APP.user.uid||'u');
      if(sessionStorage.getItem(key)==='1') return;
      sessionStorage.setItem(key,'1');
      const duration=Math.max(1, Math.min(10, num(cfg.duration)||3));
      const box=document.createElement('div');
      box.className='adnor-login-splash';
      box.innerHTML='<div class="adnor-login-splash-card">'+(cfg.imageData?'<img src="'+html(cfg.imageData)+'" alt="ADNOR">':'<div style="font-size:64px">👑</div>')+'<h2>'+html(cfg.title||'ADNOR')+'</h2><p class="muted" style="font-size:18px;line-height:1.8">'+html(cfg.text||'')+'</p><div class="adnor-login-splash-count" id="adnorSplashCount">'+duration+'</div></div>';
      document.body.appendChild(box);
      let left=duration;
      const intv=setInterval(function(){left--; const c=$('adnorSplashCount'); if(c)c.textContent=String(Math.max(0,left)); if(left<=0){clearInterval(intv); box.remove();}},1000);
    }catch(e){}
  }
  function ensureReceiptInput(){
    const form=$('depForm');
    if(!form || $('depReceipt')) return;
    const holder=document.createElement('div');
    holder.className='field';
    holder.innerHTML='<label>رفع صورة الإيصال</label><input id="depReceipt" type="file" accept="image/*" class="finp"><small class="muted">ارفع صورة التحويل حتى يوافق الأدمن على الطلب.</small>';
    const btn=form.querySelector('button');
    if(btn) form.insertBefore(holder,btn); else form.appendChild(holder);
  }
  function decorateLottery(){
    const purchase = q('#page-lottery .draw-card > .card');
    if(purchase){ purchase.id='dailyBuyCard'; purchase.classList.add('ticket-royal-panel'); }
    const dr=q('.draw-stats');
    if(dr && !dr.__lastDecorated){ dr.classList.add('last-machine'); dr.__lastDecorated=true; }
    const line=$('drawStatusLine');
    if(line) line.classList.add('last-machine');
  }
  function applyAllVisuals(){
    installStyle(); normalizeSettings(); ensureNavOrder(); ensureReceiptInput(); decorateLottery();
    const b=$('server24Badge'); if(b) b.remove();
    qa('.version-badge').forEach(x=>x.remove());
  }

  function patchUI(){
    if(!window.UI || UI.__megaPatched) return;
    const oldRender = UI.render ? UI.render.bind(UI) : function(){};
    UI.render = function(){
      try{ normalizeSettings(); oldRender(); }catch(e){ console.error('UI.render patch old error',e); }
      try{
        if(APP.user){
          const chip=$('userChip'); if(chip) chip.textContent=displayUser(APP.user);
          if($('profileCard')) $('profileCard').style.display='none';
        }
        applyAllVisuals();
        if(window.GAMES && GAMES.drawWheel) GAMES.drawWheel();
        updateScratchHint();
      }catch(e){ console.error('UI.render mega error',e); }
    };
    const oldPage = UI.page ? UI.page.bind(UI) : null;
    UI.page = function(id){
      if(oldPage) oldPage(id);
      setTimeout(function(){ applyAllVisuals(); if(id==='games'&&window.GAMES&&GAMES.drawWheel)GAMES.drawWheel(); },80);
    };
    UI.settings = function(){
      const u=APP.user||{};
      UI.modal('<h3>⚙️ الإعدادات والملف الشخصي</h3><div class="profile-grid" style="margin-bottom:12px"><div class="profile-head"><b>'+html(u.name||'مستخدم')+'</b><small>'+html(u.uid||'')+'</small></div><div class="mini"><span>اسم العرض</span><b>'+html(u.name||'-')+'</b></div><div class="mini"><span>ID الحساب</span><b class="ltr">'+html((u.uid||'').slice(0,8))+'</b></div><div class="mini"><span>الهاتف</span><b>'+html(u.phone||'-')+'</b></div><div class="mini"><span>التذاكر</span><b>'+arr2(u.tickets).length+'</b></div></div><div class="field"><label>تغيير الاسم</label><input id="newName" class="finp" value="'+html(u.name||'')+'"></div><div class="field"><label>اللغة</label><select id="langSel" class="finp"><option value="ar">العربية</option><option value="tr">Türkçe</option><option value="en">English</option></select></div><button class="btn full" onclick="APP.user.name=document.getElementById(\'newName\').value.trim()||APP.user.name;APP.user.lang=document.getElementById(\'langSel\').value;USER.save();UI.closeModal();UI.render();toast(\'✅ تم حفظ الإعدادات\')">حفظ</button><button class="btn ghost full" style="margin-top:10px" onclick="UI.modal(\'<h3>عن اليانصيب</h3><p>شراء التذاكر يكون في اليومي فقط. التذاكر غير الرابحة تنتقل للأسبوعي ثم الشهري ثم السنوي.</p><button class=\\\'btn full\\\' onclick=\\\'UI.closeModal()\\\'>تم</button>\')">عن النظام</button>');
    };
    UI.__megaPatched=true;
  }
  function patchDraw(){
    if(!window.DRAW || DRAW.__megaPatched) return;
    const oldRender=DRAW.render.bind(DRAW);
    DRAW.render=function(){
      try{ oldRender(); }catch(e){ console.error('old draw render error',e); }
      try{
        const lv=APP.currentDraw||'daily';
        const buy=$('dailyBuyCard') || q('#page-lottery .draw-card > .card');
        if(buy){ buy.id='dailyBuyCard'; buy.style.display = (lv==='daily') ? '' : 'none'; }
        const line=$('drawStatusLine'); if(line) line.classList.add('last-machine');
        const last=$('drawLast'); if(last) last.parentElement && last.parentElement.classList.add('last-machine');
        decorateLottery();
      }catch(e){}
    };
    DRAW.__megaPatched=true;
  }
  function updateScratchHint(){
    const hint=$('scratchHint'); if(!hint || !APP.user) return;
    const s=(APP.settings&&APP.settings.scratch)||{};
    const cd=(num(s.cooldownHours)||24)*3600000;
    const last=num(APP.user.scratchLast);
    const rem=last+cd-Date.now();
    if(rem>0){
      const sec=Math.floor(rem/1000)%60, min=Math.floor(rem/60000)%60, hr=Math.floor(rem/3600000);
      hint.textContent='باقي '+String(hr).padStart(2,'0')+':'+String(min).padStart(2,'0')+':'+String(sec).padStart(2,'0')+' لفتح الصندوق مرة ثانية';
    }else hint.textContent='اضغط واكتشف ربحك اليومي';
  }
  function patchScratch(){
    if(!window.SCRATCH || SCRATCH.__megaPatched) return;
    SCRATCH.open = async function(){
      const s=(APP.settings&&APP.settings.scratch)||{};
      if(!s.enabled) return msg('صندوق الحظ متوقف حالياً');
      const cd=(num(s.cooldownHours)||24)*3600000;
      const last=num(APP.user&&APP.user.scratchLast);
      if(Date.now()-last<cd){ updateScratchHint(); return msg('⏳ استخدمت صندوق الحظ اليومي. انتظر انتهاء العداد.'); }
      const fixed=num(s.fixed);
      const win = fixed>0 || Math.random()*100 < num(s.chance);
      let amt=0;
      if(win) amt = fixed>0 ? fixed : (num(s.min)+Math.random()*(num(s.max)-num(s.min)));
      amt=Math.max(0, Number(amt.toFixed(2)));
      APP.user.scratchLast=Date.now();
      const field=(s.creditTo==='balance')?'balance':'bonus';
      APP.user[field]=num(APP.user[field])+amt;
      APP.user.txs=arr2(APP.user.txs);
      APP.user.txs.unshift({type:'🎁 صندوق الحظ اليومي',amt:amt,status:win?'✅':'❌',time:nowStr(),at:Date.now()});
      await USER.save();
      updateScratchHint();
      msg(win?'🎉 ربحت '+money2(amt)+' '+(field==='bonus'?'بونص':'رصيد'):'حظ أوفر بكرة');
    };
    SCRATCH.__megaPatched=true;
  }
  async function addFreeTickets(count){
    count=Math.max(1,Math.min(20,Math.floor(num(count))));
    const pk=periodKey('daily');
    const added=[];
    for(let i=0;i<count;i++){
      let t='';
      for(let tries=0;tries<150;tries++){
        t=Array.from({length:7},()=>Math.floor(Math.random()*10)).join('');
        const ex=await db.ref('tickets/daily/'+pk+'/'+t).once('value');
        if(!ex.exists()) break;
      }
      const data={uid:APP.user.uid,name:APP.user.name,email:APP.user.email,number:t,level:'daily',periodKey:pk,price:0,free:true,source:'wheel',createdAt:Date.now()};
      await db.ref('tickets/daily/'+pk+'/'+t).set(data);
      APP.user.tickets=arr2(APP.user.tickets); APP.user.tickets.push(data); added.push(t);
    }
    return added;
  }
  function pickWheelSlice(){
    const slices=(APP.settings.wheel&&APP.settings.wheel.slices)||[];
    const overrides=(APP.settings.wheel&&APP.settings.wheel.userOverrides)||{};
    const u=APP.user||{};
    const ov=overrides[u.uid];
    if(ov && (ov.count==null || num(ov.count)>0)){
      const idx=Math.max(0,Math.min(slices.length-1,Number(ov.index)||0));
      if(ov.count!=null){ ov.count=num(ov.count)-1; if(ov.count<=0) delete overrides[u.uid]; db.ref('global_system/settings/wheel/userOverrides').set(overrides).catch(function(){}); }
      return {slice:slices[idx],idx:idx,forced:true};
    }
    const total=slices.reduce((a,b)=>a+num(b.weight),0)||1;
    let r=Math.random()*total, idx=0;
    for(let i=0;i<slices.length;i++){ r-=num(slices[i].weight); if(r<=0){idx=i;break;} }
    return {slice:slices[idx],idx:idx,forced:false};
  }
  function patchGames(){
    if(!window.GAMES || GAMES.__megaPatched) return;
    GAMES.drawWheel=function(){
      const svg=$('wheelSvg'); if(!svg || !APP.settings || !APP.settings.wheel) return;
      normalizeSettings();
      const slices=APP.settings.wheel.slices||[]; const r=150,c=150,ang=360/slices.length;
      svg.innerHTML=slices.map(function(sl,i){
        const a1=(i*ang-90)*Math.PI/180,a2=((i+1)*ang-90)*Math.PI/180;
        const x1=c+r*Math.cos(a1),y1=c+r*Math.sin(a1),x2=c+r*Math.cos(a2),y2=c+r*Math.sin(a2);
        const mid=(i*ang+ang/2-90)*Math.PI/180,tx=c+94*Math.cos(mid),ty=c+94*Math.sin(mid);
        return '<path d="M150 150 L'+x1+' '+y1+' A150 150 0 '+(ang>180?1:0)+' 1 '+x2+' '+y2+' Z" fill="'+html(sl.color||'#0b2444')+'" stroke="rgba(255,230,160,.75)" stroke-width="1.2"/><text x="'+tx+'" y="'+ty+'" fill="#fff" font-size="16" font-weight="900" text-anchor="middle" dominant-baseline="middle" transform="rotate('+(i*ang+ang/2)+' '+tx+' '+ty+')">'+html(sl.label)+'</text>';
      }).join('');
      const card=q('#page-games .card:nth-of-type(2)'); if(card) card.classList.add('wheel-card-royal');
      const btn=card&&card.querySelector('button.btn.full'); if(btn) btn.innerHTML='أدر العجلة';
      const wrap=card&&card.querySelector('.field');
      if(wrap && !$('wheelTools')){
        wrap.insertAdjacentHTML('afterend','<div class="wheel-tools" id="wheelTools"><button onclick="ADNOR_WHEEL_BET(-50)">-50</button><button onclick="ADNOR_WHEEL_BET(-10)">-10</button><button onclick="ADNOR_WHEEL_BET(-1)">-</button><button onclick="ADNOR_WHEEL_BET(1)">+</button><button onclick="ADNOR_WHEEL_BET(10)">+10</button><button onclick="ADNOR_WHEEL_BET(50)">+50</button></div>');
      }
    };
    window.ADNOR_WHEEL_BET=function(delta){ const inp=$('wheelBet'); if(!inp)return; inp.value=Math.max(1,num(inp.value)+delta); };
    GAMES.spinWheel=async function(){
      const bet=Math.max(1,num($('wheelBet')&&$('wheelBet').value));
      if(APP.total()<bet) return msg('رصيد غير كاف');
      normalizeSettings();
      const picked=pickWheelSlice(); const sl=picked.slice||{}; const slices=APP.settings.wheel.slices||[]; const idx=picked.idx||0;
      if(num(APP.user.balance)>=bet) APP.user.balance=num(APP.user.balance)-bet; else APP.user.bonus=num(APP.user.bonus)-bet;
      let win=0, added=[];
      if(sl.ticketPrize){ added=await addFreeTickets(sl.ticketPrize); }
      else { win=bet*num(sl.mult); APP.user.balance=num(APP.user.balance)+win; }
      APP.user.txs=arr2(APP.user.txs);
      APP.user.txs.unshift({type:'🎡 عجلة الحظ '+(sl.label||''),amt:win-bet,status:'✅',ticketPrize:sl.ticketPrize||0,forced:!!picked.forced,time:nowStr(),at:Date.now()});
      await USER.save();
      await db.ref('wheel_logs').push({uid:APP.user.uid,name:APP.user.name,label:sl.label,bet,win,ticketPrize:sl.ticketPrize||0,addedTickets:added,forced:!!picked.forced,at:Date.now(),time:nowStr()});
      const w=$('wheel'); if(w){ const angle=1440+(360-(idx*(360/slices.length)+(180/slices.length))); w.style.transform='rotate('+angle+'deg)'; }
      setTimeout(function(){ msg(sl.ticketPrize?'🎫 ربحت '+sl.ticketPrize+' تذاكر يانصيب':('نتيجة العجلة: '+(sl.label||'')+' | الربح: '+money2(win))); },4200);
    };
    GAMES.__megaPatched=true;
  }
  function patchWallet(){
    if(!window.WALLET || WALLET.__megaPatched) return;
    WALLET.deposit = async function(){
      const amount=num($('depAmount')&&$('depAmount').value);
      if(amount<=0) return msg('اكتب مبلغ صحيح');
      const p=APP.settings.payment||{}; const all=arr2(p.deposit).concat(arr2(p.banks));
      const method=all[num($('depMethod')&&$('depMethod').value)]||{};
      let receipt='';
      try{ receipt = await fileToDataURL(($('depReceipt')&&$('depReceipt').files&&$('depReceipt').files[0])||null, 900*1024); }
      catch(e){ return msg(e.message); }
      if(!receipt) return msg('ارفع صورة الإيصال أولاً');
      const data={uid:APP.user.uid,name:APP.user.name,email:APP.user.email,phone:APP.user.phone||'',amount,method:method.name||'',methodDetails:method.details||method.address||'',note:($('depNote')&&$('depNote').value)||'',receiptData:receipt,status:'pending',time:nowStr(),createdAt:Date.now()};
      await db.ref('finance/deposits').push(data);
      APP.user.txs=arr2(APP.user.txs); APP.user.txs.unshift({type:'📥 طلب إيداع قيد المراجعة',amt:amount,status:'⏳',time:nowStr(),at:Date.now()});
      await USER.save();
      if($('depAmount')) $('depAmount').value=''; if($('depNote')) $('depNote').value=''; if($('depReceipt')) $('depReceipt').value='';
      msg('✅ تم إرسال طلب الإيداع مع الإيصال. الرصيد يضاف بعد موافقة الأدمن.');
    };
    WALLET.__megaPatched=true;
  }
  function patchSupport(){
    if(!window.SUPPORT || SUPPORT.__megaPatched) return;
    SUPPORT.send = async function(){
      const title=($('supTitle')&&$('supTitle').value.trim())||''; const body=($('supBody')&&$('supBody').value.trim())||'';
      if(!title||!body)return msg('اكتب التفاصيل');
      await db.ref('support').push({uid:APP.user.uid,name:APP.user.name,email:APP.user.email,phone:APP.user.phone||'',title,body,reply:'',status:'جديدة',time:nowStr(),createdAt:Date.now()});
      UI.closeModal(); msg('✅ تم إرسال رسالتك للدعم. ستظهر للأدمن مباشرة.');
    };
    const oldRenderSupport=UI.renderSupport.bind(UI);
    UI.renderSupport=function(){
      try{ oldRenderSupport(); }catch(e){}
      const my=Object.entries(APP.support||{}).filter(function(pair){return pair[1].uid===uid();}).sort(function(a,b){return num(b[1].createdAt)-num(a[1].createdAt);});
      const mt=$('mySupportTickets');
      if(mt) mt.innerHTML=my.map(function(pair){const id=pair[0],t=pair[1]; return '<div class="row"><div><b>'+html(t.title||'دعم')+'</b><small>'+html(t.status||'قيد المراجعة')+' - '+html(t.time||'')+'</small><p>'+html(t.body||'')+'</p>'+(t.reply?'<div class="admin-note"><b>رد الدعم:</b><br>'+html(t.reply)+'</div>':'')+'</div></div>';}).join('')||'<p class="muted">لا توجد تذاكر</p>';
    };
    SUPPORT.__megaPatched=true;
  }
  function patchInject(){
    if(!window.INJECT) return;
    INJECT.apply=function(){
      const list=arr2(APP.settings.injectCodes);
      list.forEach(function(c,i){
        const id=c.id||('code_'+(c.createdAt||i));
        if(c.archived||c.enabled===false){ const old=$('inject_'+id); if(old) old.remove(); return; }
        if($('inject_'+id)) return;
        const box=document.createElement('div'); box.id='inject_'+id; box.setAttribute('data-inject-id',id); box.innerHTML=c.body||'';
        Array.from(box.querySelectorAll('script')).forEach(function(old){ const s=document.createElement('script'); s.textContent='try{\n'+old.textContent+'\n}catch(e){console.error("ADNOR injected code error",e)}'; old.replaceWith(s); });
        document.body.appendChild(box);
      });
    };
  }
  function buildAdminGames(){
    normalizeSettings();
    const s=APP.settings.scratch||{}; const wheel=APP.settings.wheel||{}; const slices=wheel.slices||[]; const ovs=wheel.userOverrides||{};
    return '<div class="card"><h3>🎁 إعدادات صندوق الحظ اليومي</h3><div class="admin-grid"><div class="admin-field"><label>تشغيل الصندوق</label><select id="scrEnabled" class="finp"><option value="1" '+(s.enabled!==false?'selected':'')+'>مفعل</option><option value="0" '+(s.enabled===false?'selected':'')+'>متوقف</option></select></div><div class="admin-field"><label>ربح ثابت اختياري</label><input id="scrFixed" class="finp" type="number" step="0.01" value="'+num(s.fixed)+'"></div><div class="admin-field"><label>أقل ربح</label><input id="scrMin" class="finp" type="number" step="0.01" value="'+num(s.min)+'"></div><div class="admin-field"><label>أعلى ربح</label><input id="scrMax" class="finp" type="number" step="0.01" value="'+num(s.max)+'"></div><div class="admin-field"><label>نسبة الربح %</label><input id="scrChance" class="finp" type="number" value="'+num(s.chance)+'"></div><div class="admin-field"><label>كل كم ساعة؟</label><input id="scrCooldown" class="finp" type="number" value="'+(num(s.cooldownHours)||24)+'"></div><div class="admin-field"><label>إضافة الربح إلى</label><select id="scrCredit" class="finp"><option value="bonus" '+(s.creditTo!=='balance'?'selected':'')+'>البونص</option><option value="balance" '+(s.creditTo==='balance'?'selected':'')+'>الرصيد الأساسي</option></select></div></div><button class="btn full" onclick="ADMIN.saveScratchMega()">حفظ صندوق الحظ</button></div>'+ 
    '<div class="card"><h3>🎡 إدارة عجلة الحظ الملكية</h3><p class="muted">تم حفظ كل الخانات التي طلبتها. العدد الحالي: '+slices.length+' خانة.</p>'+slices.map(function(sl,i){return '<div class="row"><b>'+(i+1)+'</b><input class="finp" id="wl_'+i+'" value="'+html(sl.label)+'"><input class="finp" type="number" id="wm_'+i+'" value="'+num(sl.mult)+'" title="الضرب"><input class="finp" type="number" step="0.01" id="ww_'+i+'" value="'+num(sl.weight)+'" title="احتمال الظهور"><input class="finp" id="wc_'+i+'" value="'+html(sl.color||'')+'" title="لون"><input class="finp" type="number" id="wt_'+i+'" value="'+num(sl.ticketPrize)+'" title="عدد تذاكر مجانية"></div>';}).join('')+'<button class="btn full" onclick="ADMIN.saveWheelMega()">حفظ العجلة</button></div>'+ 
    '<div class="card"><h3>🎯 تخصيص نتيجة لمستخدم</h3><div class="field"><label>UID المستخدم</label><input id="wheelUserUid" class="finp" placeholder="الصق ID المستخدم"></div><div class="grid two"><div class="field"><label>النتيجة القادمة</label><select id="wheelForcedIndex" class="finp">'+slices.map(function(sl,i){return '<option value="'+i+'">'+(i+1)+' — '+html(sl.label)+'</option>';}).join('')+'</select></div><div class="field"><label>عدد المرات</label><input id="wheelForcedCount" class="finp" type="number" value="1"></div></div><button class="btn green full" onclick="ADMIN.saveWheelOverride()">حفظ تخصيص المستخدم</button><button class="btn red full" style="margin-top:8px" onclick="ADMIN.clearWheelOverride()">حذف تخصيص المستخدم</button><div class="log" style="margin-top:10px">'+html(JSON.stringify(ovs,null,2))+'</div></div>';
  }
  function patchAdmin(){
    if(!window.ADMIN || ADMIN.__megaPatched) return;
    ADMIN.tokenBox=function(){return '<div class="card"><h3>🔐 ADMIN_TOKEN</h3><p class="muted">ضع نفس التوكن الموجود في Secrets لتشغيل أوامر السيرفر.</p><input id="adminTokenInput" class="finp" type="password" value="'+html(getToken())+'"><button class="btn green full" style="margin-top:8px" onclick="ADMIN.saveTokenMega()">حفظ التوكن</button></div>';};
    ADMIN.saveTokenMega=function(){setToken(($('adminTokenInput')||{}).value||''); msg('✅ تم حفظ التوكن');};
    ADMIN.draws=function(){
      let out=ADMIN.tokenBox()+'<div class="card"><h3>🎯 السحوبات المجدولة</h3><p class="muted">اكتب الرقم قبل الساعة 8 واضغط جدولة. المستخدم لا يرى الرقم إلا وقت التنفيذ.</p><div class="admin-grid">';
      LEVELS.forEach(function(lv){const d=APP.settings.draws[lv]||{}; out+='<div class="admin-field"><label>'+LABEL[lv]+'</label><input class="finp" id="man_'+lv+'" maxlength="7" inputmode="numeric" placeholder="رقم الفائز 7 خانات" value="'+html(d.manualNumber||'')+'"><label>عدد المشاركين الظاهر</label><input class="finp" type="number" id="par_'+lv+'" value="'+Math.max(num(d.participants), (DRAW.ticketCount?DRAW.ticketCount(lv):0))+'"><label>جائزة البداية</label><input class="finp" type="number" id="base_'+lv+'" value="'+num(d.base)+'"><label>الهدف الأدنى/الأعلى</label><div class="grid two"><input class="finp" type="number" id="tmin_'+lv+'" value="'+num(d.targetMin)+'"><input class="finp" type="number" id="tmax_'+lv+'" value="'+num(d.targetMax)+'"></div><p class="muted">آخر نتيجة: <b class="gold">'+html(d.lastResult||'0000000')+'</b><br>الحالة: '+html(d.lastStatus||'انتظار')+'</p><button class="btn full" onclick="ADMIN.saveDrawSettingsMega(\''+lv+'\')">حفظ الجائزة والمشاركين</button><button class="btn green full" style="margin-top:7px" onclick="ADMIN.scheduleDrawMega(\''+lv+'\')">تنفيذ عند الساعة 8:00 مساءً</button><button class="btn red full" style="margin-top:7px" onclick="ADMIN.executeDrawMega(\''+lv+'\')">تنفيذ الآن</button></div>';});
      return out+'</div></div>';
    };
    ADMIN.saveDrawSettingsMega=async function(lv){ if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً'); await apiPost('/api/admin/draw/settings',{level:lv,base:num($('base_'+lv).value),targetMin:num($('tmin_'+lv).value),targetMax:num($('tmax_'+lv).value),participants:num($('par_'+lv).value)}); msg('✅ تم حفظ إعدادات '+LABEL[lv]); };
    ADMIN.scheduleDrawMega=async function(lv){ try{ if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً'); const number=pad7(($('man_'+lv)||{}).value||''); if(!number||number.length!==7)return msg('اكتب رقم فائز 7 خانات'); await ADMIN.saveDrawSettingsMega(lv).catch(function(){}); await apiPost('/api/admin/draw/schedule',{level:lv,number}); msg('✅ تم حفظ الرقم وجدولته للساعة 8:00 مساءً'); }catch(e){msg('⚠️ '+e.message);} };
    ADMIN.executeDrawMega=async function(lv){ try{ if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً'); const number=pad7(($('man_'+lv)||{}).value||((APP.settings.draws[lv]||{}).manualNumber||'')); if(!number||number.length!==7)return msg('اكتب رقم فائز 7 خانات'); const out=await apiPost('/api/admin/draw/run',{level:lv,number,force:true}); msg('✅ تم تنفيذ السحب: '+html(JSON.stringify(out.result||out))); }catch(e){msg('⚠️ '+e.message);} };

    ADMIN.finance=function(){
      const dep=Object.entries(APP.finance.deposits||{}).sort((a,b)=>num(b[1].createdAt)-num(a[1].createdAt)).map(function(pair){const id=pair[0],x=pair[1]; return '<tr><td>'+html(x.name||'')+'<br><small>'+html(x.email||'')+'</small></td><td>'+money2(x.amount)+'</td><td>'+html(x.method||'')+'</td><td>'+html(x.status||'pending')+'</td><td>'+(x.receiptData?'<img class="receipt-thumb" src="'+html(x.receiptData)+'" onclick="ADMIN.viewReceipt(\''+id+'\')">':'لا يوجد')+'</td><td><button class="smallbtn" onclick="ADMIN.approveDep(\''+id+'\')">قبول</button><button class="smallbtn" onclick="ADMIN.rejectDep(\''+id+'\')">رفض</button></td></tr>';}).join('');
      const wit=Object.entries(APP.finance.withdraws||{}).map(function(pair){const id=pair[0],x=pair[1];return '<tr><td>'+html(x.name)+'<br><small>'+html(x.email)+'</small></td><td>'+money2(x.amount)+'</td><td>'+html(x.method)+'</td><td>'+html(x.status)+'</td><td><button class="smallbtn" onclick="ADMIN.markWithdraw(\''+id+'\')">تم</button></td></tr>';}).join('');
      return '<div class="card"><h3>📥 طلبات الإيداع مع الإيصالات</h3><div class="table"><table><tr><th>المستخدم</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th>الإيصال</th><th>تحكم</th></tr>'+dep+'</table></div></div><div class="card"><h3>📤 طلبات السحب</h3><div class="table"><table><tr><th>المستخدم</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th>تحكم</th></tr>'+wit+'</table></div></div><div class="card"><h3>طرق الدفع</h3><textarea id="payJson" class="finp" style="height:240px">'+html(JSON.stringify(APP.settings.payment,null,2))+'</textarea><button class="btn full" onclick="ADMIN.savePayment()">حفظ طرق الدفع</button></div>';
    };
    ADMIN.viewReceipt=function(id){const x=(APP.finance.deposits||{})[id]; if(!x||!x.receiptData)return msg('لا يوجد إيصال'); UI.modal('<h3>إيصال الإيداع</h3><img class="receipt-full" src="'+html(x.receiptData)+'"><p class="muted">'+html(x.name||'')+' — '+money2(x.amount)+'</p><button class="btn full" onclick="UI.closeModal()">إغلاق</button>');};
    ADMIN.rejectDep=async function(id){await db.ref('finance/deposits/'+id).update({status:'rejected',reviewedAt:Date.now()}); msg('تم رفض الإيداع');};

    ADMIN.games=buildAdminGames;
    ADMIN.saveScratchMega=async function(){const s={enabled:($('scrEnabled').value==='1'),fixed:num($('scrFixed').value),min:num($('scrMin').value),max:num($('scrMax').value),chance:num($('scrChance').value),cooldownHours:num($('scrCooldown').value)||24,creditTo:$('scrCredit').value}; await db.ref('global_system/settings/scratch').set(s); msg('✅ تم حفظ صندوق الحظ');};
    ADMIN.saveWheelMega=async function(){const slices=(APP.settings.wheel.slices||[]).map(function(sl,i){return {label:($('wl_'+i)||{}).value||sl.label,mult:num(($('wm_'+i)||{}).value),weight:num(($('ww_'+i)||{}).value),color:($('wc_'+i)||{}).value||sl.color,ticketPrize:num(($('wt_'+i)||{}).value)};}); await db.ref('global_system/settings/wheel').update({slices:slices,royalVersion:'v2-13'}); msg('✅ تم حفظ العجلة الملكية');};
    ADMIN.saveWheelOverride=async function(){const u=($('wheelUserUid')||{}).value||''; if(!u)return msg('اكتب UID المستخدم'); const ovs=(APP.settings.wheel.userOverrides||{}); ovs[u]={index:num($('wheelForcedIndex').value),count:num($('wheelForcedCount').value)||1,updatedAt:Date.now()}; await db.ref('global_system/settings/wheel/userOverrides').set(ovs); msg('✅ تم تخصيص نتيجة المستخدم');};
    ADMIN.clearWheelOverride=async function(){const u=($('wheelUserUid')||{}).value||''; if(!u)return msg('اكتب UID المستخدم'); const ovs=(APP.settings.wheel.userOverrides||{}); delete ovs[u]; await db.ref('global_system/settings/wheel/userOverrides').set(ovs); msg('✅ تم حذف التخصيص');};

    ADMIN.support=function(){
      return '<div class="card"><h3>طرق التواصل</h3><textarea id="contactsJson" class="finp" style="height:180px">'+html(JSON.stringify(APP.settings.contacts,null,2))+'</textarea><button class="btn full" onclick="ADMIN.saveContacts()">حفظ التواصل</button></div><div class="card"><h3>📩 رسائل الدعم</h3>'+Object.entries(APP.support||{}).sort(function(a,b){return num(b[1].createdAt)-num(a[1].createdAt)}).map(function(pair){const id=pair[0],t=pair[1]; return '<div class="card"><b>'+html(t.title||'دعم')+'</b><small>'+html(t.name||'')+' | '+html(t.email||'')+' | '+html(t.time||'')+' | '+html(t.status||'')+'</small><p>'+html(t.body||'')+'</p>'+(t.reply?'<div class="admin-note"><b>الرد الحالي:</b><br>'+html(t.reply)+'</div>':'')+'<textarea id="reply_'+id+'" class="finp" placeholder="اكتب رد الأدمن">'+html(t.reply||'')+'</textarea><div class="grid two"><button class="btn green" onclick="ADMIN.replyTicket(\''+id+'\')">إرسال الرد</button><button class="btn ghost" onclick="ADMIN.closeTicket(\''+id+'\')">إغلاق</button></div></div>';}).join('')+'</div>';
    };
    ADMIN.replyTicket=async function(id){const reply=($('reply_'+id)||{}).value||''; await db.ref('support/'+id).update({reply:reply,status:'تم الرد',repliedAt:Date.now()}); msg('✅ تم إرسال الرد');};

    ADMIN.legal=function(){const sp=APP.settings.loginSplash||{}; return '<div class="card"><h3>السياسة واللغة</h3><div class="field"><label>ساعة السحب</label><input id="drawHour" class="finp" type="number" value="'+(APP.settings.drawHour||20)+'"></div><div class="field"><label>نص السياسة</label><textarea id="legalText" class="finp" style="height:150px">'+html(APP.settings.legal.text)+'</textarea></div><div class="admin-grid"><div class="admin-field"><label>مكافأة صاحب الدعوة</label><input id="refA" class="finp" type="number" value="'+num(APP.settings.referral.referrerBonus)+'"></div><div class="admin-field"><label>مكافأة المستخدم الجديد</label><input id="refB" class="finp" type="number" value="'+num(APP.settings.referral.newUserBonus)+'"></div></div><button class="btn full" onclick="ADMIN.saveLegalMega()">حفظ</button></div><div class="card"><h3>🖼️ شاشة الدخول الافتتاحية</h3><div class="admin-grid"><div class="admin-field"><label>تشغيل</label><select id="spEnabled" class="finp"><option value="1" '+(sp.enabled?'selected':'')+'>مفعل</option><option value="0" '+(!sp.enabled?'selected':'')+'>متوقف</option></select></div><div class="admin-field"><label>المدة بالثواني</label><input id="spDuration" class="finp" type="number" value="'+(num(sp.duration)||3)+'"></div></div><div class="field"><label>العنوان</label><input id="spTitle" class="finp" value="'+html(sp.title||'')+'"></div><div class="field"><label>الرسالة / رقم الفائز / إعلان</label><textarea id="spText" class="finp">'+html(sp.text||'')+'</textarea></div><div class="field"><label>رفع صورة</label><input id="spImage" class="finp" type="file" accept="image/*"></div>'+(sp.imageData?'<img class="receipt-thumb" src="'+html(sp.imageData)+'">':'')+'<button class="btn full" onclick="ADMIN.saveSplashMega()">حفظ شاشة الافتتاح</button></div>';};
    ADMIN.saveLegalMega=async function(){await db.ref('global_system/settings').update({drawHour:num($('drawHour').value)||20,legal:{enabled:true,text:$('legalText').value},referral:{referrerBonus:num($('refA').value),newUserBonus:num($('refB').value),type:'bonus'}}); msg('✅ تم الحفظ');};
    ADMIN.saveSplashMega=async function(){const old=(APP.settings.loginSplash||{}); let imageData=old.imageData||''; const file=$('spImage')&&$('spImage').files&&$('spImage').files[0]; if(file) imageData=await fileToDataURL(file,900*1024); const sp={enabled:$('spEnabled').value==='1',duration:num($('spDuration').value)||3,title:$('spTitle').value,text:$('spText').value,imageData,updatedAt:Date.now()}; await db.ref('global_system/settings/loginSplash').set(sp); msg('✅ تم حفظ شاشة الافتتاح');};

    ADMIN.inject=function(){const list=arr2(APP.settings.injectCodes); return '<div class="card"><h3>⚡ حقن الأكواد الآمن</h3><p class="muted">كل كود جديد ينضاف ولا يحذف القديم. الحذف صار أرشفة، مع نسخة احتياطية.</p><div class="field"><label>اسم الكود</label><input id="codeName" class="finp"></div><div class="field"><label>الكود HTML/CSS/JS</label><textarea id="codeBody" class="finp" style="height:180px"></textarea></div><button class="btn full" onclick="ADMIN.addCodeMega()">إضافة الكود</button></div><div class="card"><h3>الأكواد المحفوظة</h3>'+list.map(function(c,i){return '<div class="code-item '+(c.archived?'danger-soft':'')+'"><b>'+html(c.name||('كود '+(i+1)))+'</b><small> '+(c.archived?'مؤرشف':(c.enabled!==false?'مفعل':'متوقف'))+' | '+html(c.id||'')+'</small><div class="row"><button class="smallbtn" onclick="ADMIN.toggleCodeMega('+i+')">تفعيل/إيقاف</button><button class="smallbtn" onclick="ADMIN.editCodeMega('+i+')">تعديل</button><button class="smallbtn" onclick="ADMIN.archiveCodeMega('+i+')">أرشفة/استرجاع</button><button class="smallbtn" onclick="navigator.clipboard.writeText((APP.settings.injectCodes['+i+']||{}).body||\'\')">نسخ</button></div></div>';}).join('')+'</div>';};
    ADMIN.backupCodes=async function(list){await db.ref('global_system/settings/injectBackups').push({list:list||arr2(APP.settings.injectCodes),at:Date.now(),time:nowStr()});};
    ADMIN.addCodeMega=async function(){const list=arr2(APP.settings.injectCodes); await ADMIN.backupCodes(list); list.push({id:'inj_'+Date.now().toString(36),name:$('codeName').value||'كود جديد',body:$('codeBody').value,enabled:true,archived:false,createdAt:Date.now()}); await db.ref('global_system/settings/injectCodes').set(list); msg('✅ تم إضافة الكود بدون حذف القديم');};
    ADMIN.toggleCodeMega=async function(i){const list=arr2(APP.settings.injectCodes); await ADMIN.backupCodes(list); list[i].enabled=list[i].enabled===false; await db.ref('global_system/settings/injectCodes').set(list);};
    ADMIN.archiveCodeMega=async function(i){const list=arr2(APP.settings.injectCodes); await ADMIN.backupCodes(list); list[i].archived=!list[i].archived; await db.ref('global_system/settings/injectCodes').set(list);};
    ADMIN.editCodeMega=function(i){const c=arr2(APP.settings.injectCodes)[i]||{}; UI.modal('<h3>تعديل الكود</h3><div class="field"><label>الاسم</label><input id="editCodeName" class="finp" value="'+html(c.name||'')+'"></div><div class="field"><label>الكود</label><textarea id="editCodeBody" class="finp" style="height:240px">'+html(c.body||'')+'</textarea></div><button class="btn full" onclick="ADMIN.saveEditCodeMega('+i+')">حفظ التعديل</button>');};
    ADMIN.saveEditCodeMega=async function(i){const list=arr2(APP.settings.injectCodes); await ADMIN.backupCodes(list); list[i].name=$('editCodeName').value; list[i].body=$('editCodeBody').value; list[i].updatedAt=Date.now(); await db.ref('global_system/settings/injectCodes').set(list); UI.closeModal(); msg('✅ تم تعديل الكود');};
    ADMIN.__megaPatched=true;
  }
  function patchAuth(){
    if(!window.AUTH || AUTH.__megaPatched) return;
    AUTH.google = async function(){
      if(this.busy)return; if(!this.needLegal())return;
      this.busy=true; clearAuthError();
      const btn=$('googleBtn'), old=btn?btn.innerHTML:''; if(btn){btn.disabled=true;btn.textContent='⏳ جاري فتح Google...';}
      try{
        const provider=new firebase.auth.GoogleAuthProvider(); provider.setCustomParameters({prompt:'select_account'});
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(){});
        if(/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) await auth.signInWithRedirect(provider);
        else await auth.signInWithPopup(provider);
      }catch(e){ showAuthError('Google Login: '+(AUTH.friendlyError?AUTH.friendlyError(e):(e.message||e))); }
      finally{this.busy=false; if(btn){btn.disabled=false;btn.innerHTML=old;}}
    };
    AUTH.__megaPatched=true;
  }
  function boot(){
    try{ normalizeSettings(); installStyle(); patchAuth(); patchUI(); patchDraw(); patchScratch(); patchGames(); patchWallet(); patchSupport(); patchAdmin(); patchInject(); applyAllVisuals(); maybeSaveNormalizedSettings(); if(window.INJECT)INJECT.apply(); }catch(e){ console.error('ADNOR mega patch boot error',e); }
  }
  setTimeout(boot,200); setTimeout(boot,900); setTimeout(boot,2200); setInterval(boot,5000); setInterval(updateScratchHint,1000);
  // Show controlled 3-second splash once a successful auth opens the app.
  const splashTry=setInterval(function(){ if(APP && APP.user && !$('auth').classList.contains('hidden')) return; if(APP && APP.user && $('app') && !$('app').classList.contains('hidden')){ showLoginSplash(); clearInterval(splashTry); } },800);
})();
