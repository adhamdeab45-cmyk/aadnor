(function(){
  'use strict';
  const {$,money,escape,date,toast,openModal,closeModal,generic,setStatus,page,openDrawer,closeDrawer,maskName}=UI;
  const {auth,db,storage,functions}=ADNOR;
  const state={
    user:null,profile:null,userData:null,settings:{},publicContent:{},lottery:{},game:{},reward:{},referral:{},drawType:'daily',
    publicDraws:[],publicAgents:[],paymentMethods:{},vip:{},tickets:{},transactions:{},notifications:{},globalNotifications:{},
    tasks:{},userTasks:{},support:{},gameHistory:{},notificationReadAt:0,unsubs:[],selectedDeposit:null,selectedWithdraw:null,
    confirmationResult:null,deferredPrompt:null,hideBalance:false,muted:false,theme:'dark',spinning:false,healthTimer:null,tickerItems:[],tickerIndex:0,tickerTimer:null
  };
  const drawOrder=['daily','weekly','monthly','yearly'];
  const drawNames={daily:'السحب اليومي',weekly:'السحب الأسبوعي',monthly:'السحب الشهري',yearly:'السحب السنوي'};
  const defaultLottery={ticketPrice:1,closeMinutes:5,allowBonus:true,maxTicketsPerDraw:100,daily:{enabled:true,label:'السحب اليومي',prize:4500,nextPublishAt:0},weekly:{enabled:true,label:'السحب الأسبوعي',prize:15000,nextPublishAt:0},monthly:{enabled:true,label:'السحب الشهري',prize:45000,nextPublishAt:0},yearly:{enabled:true,label:'السحب السنوي',prize:750000,nextPublishAt:0}};
  const defaultGame={enabled:true,minBet:1,maxBet:500,allowBonus:true,segments:[
    {label:'$5',type:'cash',value:5},{label:'$10',type:'cash',value:10},{label:'تذكرتان',type:'free_tickets',value:2},{label:'حاول مجدداً',type:'lose',value:0},
    {label:'$50',type:'cash',value:50},{label:'لفتان',type:'free_spins',value:2},{label:'VIP',type:'vip',value:30},{label:'$100',type:'cash',value:100}
  ]};

  function pathOn(path,cb){const r=db.ref(path);r.on('value',cb);state.unsubs.push(()=>r.off('value',cb));return r}
  function cleanup(){state.unsubs.splice(0).forEach(fn=>{try{fn()}catch(e){}})}
  function mergeLottery(v){const out=JSON.parse(JSON.stringify(defaultLottery));if(!v)return out;Object.assign(out,v);out.ticketPrice=Number(v.ticketPrice)>0?Number(v.ticketPrice):defaultLottery.ticketPrice;drawOrder.forEach(k=>{out[k]=Object.assign({},defaultLottery[k],v[k]||{});out[k].prize=Number(out[k].prize)>0?Number(out[k].prize):defaultLottery[k].prize});return out}
  function mergeGame(v){return Object.assign({},defaultGame,v||{},{segments:Array.isArray(v?.segments)?v.segments:defaultGame.segments})}
  function functionError(e){
    const code=String(e?.code||'').replace('functions/','');
    const map={'unauthenticated':'سجّل الدخول أولاً.','permission-denied':'ليس لديك صلاحية لهذه العملية.','failed-precondition':'العملية غير متاحة حالياً.','resource-exhausted':'تم تجاوز الحد المسموح.','invalid-argument':'تحقق من البيانات المدخلة.','not-found':'العنصر المطلوب غير موجود.','already-exists':'تم تنفيذ هذه العملية سابقاً.','unavailable':'تعذر الاتصال بقاعدة Firebase.','internal':'حدث خطأ في Firebase.'};
    return e?.message?.includes('Failed to fetch')?'تعذر الاتصال بخدمات Firebase.':(map[code]||e?.message||'تعذر تنفيذ العملية.');
  }
  async function call(name,data={},timeout=20000){
    const fn=functions.httpsCallable(name);let timer;
    try{return await Promise.race([fn(data),new Promise((_,rej)=>timer=setTimeout(()=>rej(new Error('انتهت مهلة الاتصال بـ Firebase.')),timeout))])}
    finally{clearTimeout(timer)}
  }
  function serverTime(){return Date.now()}
  function deviceId(){let v=localStorage.getItem('adnor_device_id');if(!v){v=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now());localStorage.setItem('adnor_device_id',v)}return v}
  function track(name,params={}){try{ADNOR.analytics?.logEvent(name,params)}catch(e){}}
  function applyTheme(theme){state.theme=theme==='light'?'light':'dark';document.documentElement.dataset.theme=state.theme;localStorage.setItem('adnor_theme',state.theme)}
  function playSound(kind='click'){if(state.muted)return;try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;const c=playSound.ctx||(playSound.ctx=new C()),o=c.createOscillator(),g=c.createGain(),freq=kind==='win'?740:kind==='spin'?420:kind==='error'?180:280;o.type=kind==='win'?'sine':'triangle';o.frequency.setValueAtTime(freq,c.currentTime);if(kind==='win')o.frequency.exponentialRampToValueAtTime(1040,c.currentTime+.22);g.gain.setValueAtTime(.0001,c.currentTime);g.gain.exponentialRampToValueAtTime(.08,c.currentTime+.015);g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+(kind==='win'?.32:.11));o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+(kind==='win'?.34:.13))}catch(e){}}
  async function checkAppHealth(){if(!state.user||state.settings.maintenanceEnabled)return;try{const r=await call('healthCheck',{},8000);$('systemStatusText').textContent=r.data?.ok?'ONLINE':'ERROR';$('systemStatusText').dataset.state=r.data?.ok?'online':'error'}catch(e){$('systemStatusText').textContent=navigator.onLine?'FIREBASE ERROR':'OFFLINE';$('systemStatusText').dataset.state='error'}}
  function currentDraw(){
    const now=serverTime();const enabled=drawOrder.map(type=>({type,...state.lottery[type]})).filter(d=>d.enabled!==false&&Number(d.nextPublishAt||0)>now).sort((a,b)=>a.nextPublishAt-b.nextPublishAt);
    return enabled[0]||{type:'daily',...state.lottery.daily};
  }
  function drawLabel(type){return state.lottery[type]?.label||drawNames[type]||type}
  function formatCountdown(ms){if(ms<=0)return '00:00:00';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=s%60;return d?`${d}d ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`}
  function tick(){
    const d=currentDraw(),ms=Number(d.nextPublishAt||0)-serverTime();
    $('landingPrize').textContent=money(d.prize);$('landingDrawLabel').textContent=d.label||drawLabel(d.type);
    $('homePrize').textContent=money(d.prize);$('homeDrawLabel').textContent=d.label||drawLabel(d.type);
    $('homeCountdown').textContent=formatCountdown(ms);$('lotteryCountdown').textContent=formatCountdown(Number(state.lottery[state.drawType]?.nextPublishAt||0)-serverTime());
    const total=Math.max(0,Math.floor(ms/1000));$('cdDays').textContent=String(Math.floor(total/86400)).padStart(2,'0');$('cdHours').textContent=String(Math.floor((total%86400)/3600)).padStart(2,'0');$('cdMinutes').textContent=String(Math.floor((total%3600)/60)).padStart(2,'0');$('cdSeconds').textContent=String(total%60).padStart(2,'0');
  }


  function tickerLanguage(ar,en,tr){return I18N.language==='en'?en:I18N.language==='tr'?tr:ar}
  function rebuildTicker(){
    const items=[];
    const latest=state.publicDraws.slice().sort((a,b)=>Number(b.publishedAt||0)-Number(a.publishedAt||0))[0];
    if(latest){
      const name=latest.winnerNameMasked||maskName(latest.winnerName||latest.winnerEmail||'ADNOR User');
      items.push(tickerLanguage(
        `🏆 ${latest.drawLabel||drawLabel(latest.drawType)} • الفائز ${name} • التذكرة ${latest.ticketNumber||'—'} • الجائزة ${money(latest.prize)}`,
        `🏆 ${latest.drawLabel||drawLabel(latest.drawType)} • Winner ${name} • Ticket ${latest.ticketNumber||'—'} • Prize ${money(latest.prize)}`,
        `🏆 ${latest.drawLabel||drawLabel(latest.drawType)} • Kazanan ${name} • Bilet ${latest.ticketNumber||'—'} • Ödül ${money(latest.prize)}`
      ));
    }
    const next=currentDraw();
    if(next&&Number(next.nextPublishAt||0)>Date.now())items.push(tickerLanguage(
      `⏳ السحب القادم: ${next.label||drawLabel(next.type)} • الجائزة ${money(next.prize)} • الموعد ${date(next.nextPublishAt)}`,
      `⏳ Next draw: ${next.label||drawLabel(next.type)} • Prize ${money(next.prize)} • ${date(next.nextPublishAt)}`,
      `⏳ Sıradaki çekiliş: ${next.label||drawLabel(next.type)} • Ödül ${money(next.prize)} • ${date(next.nextPublishAt)}`
    ));
    const verified=state.publicAgents.filter(a=>a.verified===true).length;
    if(verified)items.push(tickerLanguage(
      `🛡️ دليل ADNOR يضم ${verified.toLocaleString()} وكيل شحن موثّق • تعامل فقط مع الوكلاء الظاهرين داخل المنصة`,
      `🛡️ ADNOR directory lists ${verified.toLocaleString()} verified agents • Deal only with agents shown on the platform`,
      `🛡️ ADNOR dizininde ${verified.toLocaleString()} doğrulanmış acente var • Yalnızca platformdaki acentelerle işlem yapın`
    ));
    if(!items.length)items.push(tickerLanguage('♛ ADNOR ONLINE • النتائج الرسمية تظهر فور نشر الإدارة','♛ ADNOR ONLINE • Official results appear as soon as the administration publishes them','♛ ADNOR ONLINE • Resmî sonuçlar yönetim yayınladığında görünür'));
    state.tickerItems=items;state.tickerIndex=Math.min(state.tickerIndex,items.length-1);showTicker();
  }
  function showTicker(){
    const el=$('officialTickerText'),bar=$('officialTicker');if(!el||!bar||!state.tickerItems.length)return;
    el.textContent=state.tickerItems[state.tickerIndex%state.tickerItems.length];
    bar.classList.add('refresh');void bar.offsetWidth;bar.classList.remove('refresh');
  }
  function startTicker(){clearInterval(state.tickerTimer);state.tickerTimer=setInterval(()=>{if(!state.tickerItems.length)return;state.tickerIndex=(state.tickerIndex+1)%state.tickerItems.length;showTicker()},6500)}

  function renderPublicDraws(){
    const list=state.publicDraws.slice().sort((a,b)=>Number(b.publishedAt||0)-Number(a.publishedAt||0));
    const html=list.length?list.slice(0,6).map(draw=>winnerCard(draw)).join(''):`<div class="empty-card">${I18N.t('noWinners')}</div>`;
    $('landingWinners').innerHTML=html;$('winnersList').innerHTML=html;
    $('homeWinner').innerHTML=list[0]?winnerMini(list[0]):'<div class="empty-card">لا توجد نتيجة منشورة بعد.</div>';rebuildTicker();
  }
  function winnerCard(d){
    const name=d.winnerNameMasked||maskName(d.winnerName||d.winnerEmail||'ADNOR User');
    return `<article class="winner-card"><div class="winner-icon">🏆</div><h3>${escape(name)}</h3><div class="prize">${money(d.prize)}</div><p>${escape(d.drawLabel||drawLabel(d.drawType))}<br>التذكرة: ${escape(d.ticketNumber||'—')}</p><div class="winner-meta"><span>${date(d.publishedAt||d.publishAt)}</span><span>#${escape(d.reference||String(d.id||'').slice(-8)||'—')}</span></div><button class="btn glass full share-result" data-id="${escape(d.id||'')}">مشاركة النتيجة</button></article>`
  }
  function winnerMini(d){return `<div class="list-item"><i>🏆</i><div><b>${escape(d.winnerNameMasked||maskName(d.winnerName||d.winnerEmail))}</b><span>${escape(d.drawLabel||drawLabel(d.drawType))} • ${escape(d.ticketNumber||'—')}</span></div><strong>${money(d.prize)}</strong></div>`}
  function renderAgents(){
    const render=(box,country,query)=>{
      const q=String(query||'').trim().toLowerCase();const list=state.publicAgents.filter(a=>(!country||a.country===country)&&(!q||[a.name,a.country,a.city,a.paymentMethods].join(' ').toLowerCase().includes(q)));
      box.innerHTML=list.length?list.map(agentCard).join(''):`<div class="empty-card">${I18N.t('noAgents')}</div>`;
    };
    const countries=[...new Set(state.publicAgents.map(a=>a.country).filter(Boolean))].sort();
    [$('landingAgentCountry'),$('agentCountry')].forEach(sel=>{const old=sel.value;sel.innerHTML='<option value="">'+(I18N.language==='tr'?'Tüm ülkeler':I18N.language==='en'?'All countries':'كل الدول')+'</option>'+countries.map(c=>`<option>${escape(c)}</option>`).join('');sel.value=old});
    render($('landingAgents'),$('landingAgentCountry').value,$('landingAgentSearch').value);render($('agentsList'),$('agentCountry').value,$('agentSearch').value);rebuildTicker();
  }
  function agentCard(a){
    const wa=String(a.whatsapp||'').replace(/\D/g,'');const tg=String(a.telegram||'').replace(/^@/,'');
    const verifiedLabel=I18N.language==='tr'?'✓ Doğrulandı':I18N.language==='en'?'✓ Verified':'✓ موثّق';
    return `<article class="agent-card"><div class="agent-top"><span class="location">📍 ${escape([a.country,a.city].filter(Boolean).join(' — '))}</span>${a.verified?`<span class="verified">${verifiedLabel}</span>`:''}</div><h3>${escape(a.name||'وكيل ADNOR')}</h3><p>${escape(a.paymentMethods||'طرق الدفع يحددها الوكيل')}<br>${escape(a.workingHours||'')}</p><div class="agent-proof"><b>${Number(a.completedOperations||0).toLocaleString()}</b><span>${I18N.t('verifiedOperations')}</span></div><div class="agent-actions">${wa?`<a target="_blank" rel="noopener" href="https://wa.me/${wa}">WhatsApp</a>`:'<span></span>'}${tg?`<a target="_blank" rel="noopener" href="https://t.me/${encodeURIComponent(tg)}">Telegram</a>`:'<span></span>'}<button type="button" class="report-agent" data-agent-id="${escape(a.id||'')}">${I18N.t('reportAgent')}</button></div></article>`
  }
  function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect?ctx.roundRect(x,y,w,h,r):(ctx.rect(x,y,w,h));ctx.fill()}
  async function winnerCardBlob(d){const c=document.createElement('canvas');c.width=c.height=1080;const x=c.getContext('2d'),g=x.createLinearGradient(0,0,0,1080);g.addColorStop(0,'#071a31');g.addColorStop(.55,'#020914');g.addColorStop(1,'#0b1b30');x.fillStyle=g;x.fillRect(0,0,1080,1080);const glow=x.createRadialGradient(540,180,20,540,180,520);glow.addColorStop(0,'rgba(255,220,110,.34)');glow.addColorStop(1,'rgba(255,220,110,0)');x.fillStyle=glow;x.fillRect(0,0,1080,800);x.strokeStyle='rgba(255,218,111,.65)';x.lineWidth=7;x.strokeRect(38,38,1004,1004);x.strokeStyle='rgba(255,239,170,.22)';x.lineWidth=2;x.strokeRect(58,58,964,964);x.textAlign='center';x.direction='rtl';x.fillStyle='#ffe58e';x.font='900 95px Cinzel, serif';x.fillText('♛ ADNOR',540,170);x.fillStyle='#b8c6d8';x.font='700 34px IBM Plex Sans Arabic, sans-serif';x.fillText(d.drawLabel||drawLabel(d.drawType),540,245);x.fillStyle='#fff2b2';x.font='900 108px IBM Plex Sans Arabic, sans-serif';x.fillText(money(d.prize),540,405);x.fillStyle='rgba(5,18,35,.88)';roundRect(x,140,480,800,330,42);x.fillStyle='#ffffff';x.font='800 48px IBM Plex Sans Arabic, sans-serif';x.fillText(d.winnerNameMasked||maskName(d.winnerName||d.winnerEmail||'ADNOR User'),540,575);x.fillStyle='#d2ddea';x.font='700 35px IBM Plex Sans Arabic, sans-serif';x.fillText(`رقم التذكرة: ${d.ticketNumber||'—'}`,540,650);x.fillText(`مرجع النتيجة: ${d.reference||String(d.id||'').slice(-8)||'—'}`,540,710);x.fillText(date(d.publishedAt||d.publishAt),540,770);x.fillStyle='#71f2c5';x.font='800 32px IBM Plex Sans Arabic, sans-serif';x.fillText(d.credited===false?'بانتظار إضافة الجائزة':'تم اعتماد النتيجة وإضافة الجائزة',540,875);x.fillStyle='#8292a6';x.font='600 25px IBM Plex Sans Arabic, sans-serif';x.fillText('النتيجة الرسمية المنشورة عبر منصة ADNOR',540,955);return new Promise(resolve=>c.toBlob(resolve,'image/png',.95))}
  async function shareResult(id){const d=state.publicDraws.find(x=>String(x.id)===String(id));if(!d)return;const text=`أنا أشارك نتيجة ${d.drawLabel||drawLabel(d.drawType)} في ADNOR — الجائزة ${money(d.prize)} — التذكرة ${d.ticketNumber||'—'}`,url=location.origin+location.pathname+'#winners';try{const blob=await winnerCardBlob(d),file=new File([blob],`ADNOR-${d.reference||d.id||'winner'}.png`,{type:'image/png'});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({title:'ADNOR',text,url,files:[file]});track('share_result',{draw_type:d.drawType||'unknown'});return}if(navigator.share){await navigator.share({title:'ADNOR',text,url});track('share_result',{draw_type:d.drawType||'unknown'});return}const objectUrl=URL.createObjectURL(blob);generic('بطاقة مشاركة الفائز',`<img src="${objectUrl}" alt="ADNOR winner card" style="width:100%;border-radius:18px"><a class="btn gold full" download="ADNOR-winner.png" href="${objectUrl}">حفظ بطاقة المشاركة</a><button id="copyWinnerText" class="btn glass full">نسخ النص</button>`);setTimeout(()=>{$('copyWinnerText').onclick=()=>navigator.clipboard.writeText(text+' '+url).then(()=>toast('تم نسخ نص المشاركة'))},0)}catch(e){navigator.clipboard?.writeText(text+' '+url);toast('تم نسخ نص المشاركة')}}


  function listenPublic(){
    pathOn('settings/global',s=>{state.settings=s.val()||{};applyGlobalSettings()});
    pathOn('settings/public',s=>{state.publicContent=s.val()||{};applyPublicContent()});
    pathOn('settings/lottery',s=>{state.lottery=mergeLottery(s.val());renderLottery();tick()});
    pathOn('settings/games/wheel',s=>{state.game=mergeGame(s.val());renderWheel()});
    pathOn('settings/rewards/daily',s=>{state.reward=s.val()||{};renderTasks()});
    pathOn('settings/vip',s=>{state.vip=s.val()||{};renderUser()});
    pathOn('public_draws',s=>{state.publicDraws=Object.entries(s.val()||{}).map(([id,v])=>({id,...v})).filter(x=>x.status==='published'||x.published===true);renderPublicDraws()});
    pathOn('public_agents',s=>{state.publicAgents=Object.entries(s.val()||{}).map(([id,v])=>({id,...v})).filter(x=>x.active!==false&&x.publicVisible!==false);renderAgents()});
    pathOn('payment_methods',s=>{state.paymentMethods=s.val()||{};renderPaymentMethods()});
  }
  function applyPublicContent(){
    const c=state.publicContent||{},lang=I18N.language||'ar',suffix=lang==='en'?'En':lang==='tr'?'Tr':'Ar';
    const h=document.querySelector('.hero h1'),p=document.querySelector('.hero-copy>p');
    const title=c['heroTitle'+suffix]||(lang==='ar'?c.heroTitle:'')||I18N.t('heroTitle');
    const text=c['heroText'+suffix]||(lang==='ar'?c.heroText:'')||I18N.t('heroText');
    if(h)h.textContent=title;if(p)p.textContent=text;
    const support=$('footerSupportLink');if(support)support.href=c.supportEmail?'mailto:'+c.supportEmail:'#trust';
  }
  function applyGlobalSettings(){
    const blocked=state.settings.loginEnabled===false||(state.settings.maintenanceEnabled&&!state.user);$('heroJoinBtn').disabled=blocked;$('quickJoinBtn').disabled=blocked;$('openAuthBtn').disabled=blocked;if(blocked&&state.settings.maintenanceEnabled)toast(state.settings.maintenanceMessage||'الموقع تحت الصيانة مؤقتاً.');
    if($('buyTicketBtn'))$('buyTicketBtn').disabled=state.settings.lotteryEnabled===false;if($('spinBtn'))$('spinBtn').disabled=state.settings.wheelEnabled===false||state.game.enabled===false;if($('submitDepositBtn'))$('submitDepositBtn').disabled=state.settings.depositEnabled===false;if($('submitWithdrawBtn'))$('submitWithdrawBtn').disabled=state.settings.withdrawEnabled===false;if($('newSupportBtn'))$('newSupportBtn').disabled=state.settings.supportEnabled===false;
    if(state.settings.maintenanceEnabled)$('systemStatusText').textContent='MAINTENANCE';else if(!state.user)$('systemStatusText').textContent='ONLINE';renderPaymentMethods();
  }

  async function ensureProfile(){
    try{await call('ensureUser',{language:I18N.language,deviceId:deviceId(),userAgent:navigator.userAgent||'',platform:navigator.platform||''});const pending=localStorage.getItem('adnor_referral_pending');if(pending){try{await call('applyReferralCode',{code:pending,deviceId:deviceId()});localStorage.removeItem('adnor_referral_pending');toast('تم تطبيق كود الدعوة')}catch(e){console.warn('pending referral',e)}}return true}
    catch(e){console.warn('ensureUser',e);toast(functionError(e));await auth.signOut().catch(()=>{});return false}
  }
  function authView(logged){
    $('landing').classList.toggle('hidden',logged);$('publicHeader').classList.toggle('hidden',logged);$('app').classList.toggle('hidden',!logged);closeModal('authModal');
  }
  async function onSignedIn(user){
    state.user=user;authView(true);if(!(await ensureProfile()))return;listenPrivate();const admin=await ADNOR.roles.isAdmin(user).catch(()=>false);$('adminLink').classList.toggle('hidden',!admin);page('home');track('login_success',{provider:user.providerData?.[0]?.providerId||'unknown'});checkAppHealth();clearInterval(state.healthTimer);state.healthTimer=setInterval(checkAppHealth,60000);
  }
  function onSignedOut(){cleanup();clearInterval(state.healthTimer);state.healthTimer=null;state.user=null;state.userData=null;authView(false);listenPublic()}
  function listenPrivate(){
    cleanup();listenPublic();const uid=state.user.uid;
    pathOn('users/'+uid,s=>{state.userData=s.val()||{};if(state.userData.uid&&state.userData.status&&state.userData.status!=='active'){toast(state.userData.statusReason||'الحساب غير مفعّل.');auth.signOut().catch(()=>{});return}renderUser()});
    pathOn('profiles/'+uid,s=>{state.profile=s.val()||{};renderUser()});
    pathOn('user_tickets/'+uid,s=>{state.tickets=s.val()||{};renderTickets();renderUser()});
    pathOn('transactions/'+uid,s=>{state.transactions=s.val()||{};renderTransactions()});
    pathOn('user_notifications/'+uid,s=>{state.notifications=s.val()||{};renderNotifications()});
    pathOn('global_notifications',s=>{state.globalNotifications=s.val()||{};renderNotifications()});
    pathOn('notification_reads/'+uid,s=>{state.notificationReadAt=Number(s.val()?.lastReadAt||0);renderNotifications()});
    pathOn('tasks/definitions',s=>{state.tasks=s.val()||{};renderTasks()});
    pathOn('user_tasks/'+uid,s=>{state.userTasks=s.val()||{};renderTasks()});
    pathOn('support/'+uid,s=>{state.support=s.val()||{};renderSupport()});
    pathOn('game_history/'+uid,s=>{state.gameHistory=s.val()||{};renderGameHistory()});
  }

  function renderUser(){
    const u=state.userData||{},p=state.profile||{};const real=Number(u.realBalance||0),bonus=Number(u.bonusBalance||0),reserved=Number(u.reservedWithdrawalBalance||0);const active=Object.values(state.tickets||{}).filter(t=>t.status==='active').length;
    const val=(n)=>state.hideBalance?'••••':money(n);['homeBalance','walletReal'].forEach(id=>$(id).textContent=val(real));['homeBonus','walletBonus'].forEach(id=>$(id).textContent=val(bonus));['homeReserved','walletReserved'].forEach(id=>$(id).textContent=val(reserved));$('homeTickets').textContent=active;
    const name=p.displayName||u.displayName||state.user?.displayName||'ADNOR User',email=u.email||state.user?.email||state.user?.phoneNumber||'—';$('accountName').textContent=name;$('accountEmail').textContent=email;$('accountPublicId').textContent='ID '+(u.publicId||'—');$('accountAvatar').textContent=name.charAt(0).toUpperCase();$('vipBadge').textContent=state.vip.badgeLabel||'VIP';$('vipBadge').classList.toggle('hidden',!u.isVIP);$('drawerUser').innerHTML=`<b>${escape(name)}</b><br>${escape(email)}<br>ID ${escape(u.publicId||'—')}`;
    $('streakDays').textContent=Number(u.loginStreak||0);
  }
  function renderLottery(){
    const tabs=$('drawTabs');tabs.innerHTML=drawOrder.map(type=>`<button data-draw="${type}" class="${state.drawType===type?'active':''}" ${state.lottery[type]?.enabled===false?'disabled':''}>${escape(drawLabel(type))}</button>`).join('');
    const d=state.lottery[state.drawType]||{};$('lotteryLabel').textContent=drawLabel(state.drawType);$('lotteryPrize').textContent=money(d.prize);$('lotteryCloseText').textContent=`يغلق الشراء قبل النشر بـ ${Number(state.lottery.closeMinutes||5)} دقائق.`;$('buyTicketBtn').disabled=state.settings.lotteryEnabled===false||d.enabled===false;updateTicketTotal();
  }
  function updateTicketTotal(){const count=Math.max(1,Math.min(100,Number($('ticketCount').value||1)));$('ticketCount').value=count;$('ticketTotal').textContent=money(count*Number(state.lottery.ticketPrice||1))}
  function renderTickets(){
    let list=Object.entries(state.tickets||{}).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));const f=$('ticketFilter').value;if(f!=='all')list=list.filter(t=>t.status===f);
    $('ticketsList').innerHTML=list.length?list.map(t=>`<div class="list-item"><i>🎟️</i><div><b>${escape(t.number||'—')}</b><span>${escape(t.drawLabel||drawLabel(t.drawType))} • ${date(t.createdAt)}</span></div><strong>${escape(t.status||'active')}</strong></div>`).join(''):'<div class="empty-card">لا توجد تذاكر في هذا القسم.</div>';
  }
  function renderWheel(){
    const seg=state.game.segments||defaultGame.segments;$('wheelLegend').innerHTML=seg.map(x=>`<span>${escape(x.label)}</span>`).join('');$('wheelBet').min=Number(state.game.minBet||1);$('wheelBet').max=Number(state.game.maxBet||500);$('spinBtn').disabled=state.settings.wheelEnabled===false||state.game.enabled===false;
  }
  function renderGameHistory(){const list=Object.entries(state.gameHistory||{}).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,30);$('gameHistory').innerHTML=list.length?list.map(g=>`<div class="list-item"><i>🎮</i><div><b>${escape(g.resultLabel||g.type||'Wheel')}</b><span>${date(g.createdAt)} • لعب ${money(g.bet)}</span></div><strong>${g.rewardAmount?money(g.rewardAmount):escape(g.rewardText||'')}</strong></div>`).join(''):'<div class="empty-card">لا توجد جولات بعد.</div>'}
  function renderTransactions(){const list=Object.entries(state.transactions||{}).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));const row=x=>`<div class="list-item"><i>${Number(x.amount||0)>=0?'↗':'↘'}</i><div><b>${escape(x.title||x.type||'عملية')}</b><span>${date(x.createdAt)} • #${escape(String(x.reference||x.id).slice(-8))}</span></div><strong>${Number(x.amount||0)>=0?'+':''}${money(x.amount||0)}</strong></div>`;$('homeTransactions').innerHTML=list.length?list.slice(0,5).map(row).join(''):'<div class="empty-card">لا توجد عمليات بعد.</div>';$('walletHistory').innerHTML=list.length?list.slice(0,100).map(row).join(''):'<div class="empty-card">لا توجد عمليات بعد.</div>'}
  function renderPaymentMethods(){
    const methods=Object.entries(state.paymentMethods||{}).map(([id,v])=>({id,...v})).filter(m=>m.active!==false).sort((a,b)=>Number(a.order||0)-Number(b.order||0));
    const dep=methods.filter(m=>['deposit','both'].includes(m.type)),withd=methods.filter(m=>['withdraw','both'].includes(m.type));
    $('depositMethods').innerHTML=state.settings.depositEnabled===false?'<div class="empty-card">الإيداع متوقف مؤقتاً من الإدارة.</div>':dep.length?dep.map(m=>methodButton(m,'deposit')).join(''):'<div class="empty-card">لا توجد طريقة إيداع مفعّلة.</div>';$('withdrawMethods').innerHTML=state.settings.withdrawEnabled===false?'<div class="empty-card">السحب متوقف مؤقتاً من الإدارة.</div>':withd.length?withd.map(m=>methodButton(m,'withdraw')).join(''):'<div class="empty-card">لا توجد طريقة سحب مفعّلة.</div>';$('submitDepositBtn').disabled=state.settings.depositEnabled===false;$('submitWithdrawBtn').disabled=state.settings.withdrawEnabled===false;
  }
  function methodButton(m,kind){return `<button class="method-btn ${state[kind==='deposit'?'selectedDeposit':'selectedWithdraw']===m.id?'active':''}" data-method-kind="${kind}" data-method="${escape(m.id)}"><b>${escape(m.name||m.id)}</b><span>الحد الأدنى ${money(m.minAmount||0)}</span></button>`}
  function selectMethod(kind,id){state[kind==='deposit'?'selectedDeposit':'selectedWithdraw']=id;renderPaymentMethods();if(kind==='deposit'){const m=state.paymentMethods[id]||{};$('depositInstructions').innerHTML=escape(m.instructions||'اتبع تعليمات طريقة الدفع ثم أرفق الإثبات.').replace(/\n/g,'<br>')}}
  function renderNotifications(){const all=[...Object.entries(state.globalNotifications||{}).map(([id,v])=>({id,global:true,...v})),...Object.entries(state.notifications||{}).map(([id,v])=>({id,...v}))].filter(n=>!n.publishAt||Number(n.publishAt)<=Date.now()).sort((a,b)=>(Number(b.pinned||0)-Number(a.pinned||0))||Number(b.createdAt||0)-Number(a.createdAt||0));$('notifBadge').textContent=all.filter(n=>Number(n.createdAt||0)>state.notificationReadAt).length;state._notifList=all}
  function openNotifications(){const list=state._notifList||[];generic('الإشعارات',list.length?`<div class="list-stack">${list.map(n=>`<div class="list-item"><i>🔔</i><div><b>${escape(n.title||'إشعار')}</b><span>${escape(n.message||n.text||'')}<br>${date(n.createdAt)}</span></div></div>`).join('')}</div>`:'<div class="empty-card">لا توجد إشعارات.</div>');if(state.user)db.ref('notification_reads/'+state.user.uid).set({lastReadAt:firebase.database.ServerValue.TIMESTAMP}).catch(()=>{})}
  function todayKey(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
  function renderTasks(){
    if(!$('tasksList'))return;const day=todayKey(),done=state.userTasks[day]||{};const tasks=Object.entries(state.tasks||{}).map(([id,v])=>({id,...v})).filter(t=>t.active!==false).sort((a,b)=>Number(a.order||0)-Number(b.order||0));
    $('tasksList').innerHTML=tasks.length?tasks.map(t=>{const p=done[t.id]||{};let action=p.claimed?'<em>✓ تم الاستلام</em>':p.completed?`<button class="btn gold claim-task" data-task-id="${escape(t.id)}">استلام</button>`:'<em>بانتظار الإنجاز</em>';return `<article class="task-card"><i>${escape(t.icon||'🎯')}</i><div><b>${escape(t.title||t.id)}</b><span>${escape(t.description||'')} • ${rewardText(t.reward)}</span></div>${action}</article>`}).join(''):'<div class="empty-card">لا توجد مهام مفعّلة اليوم.</div>';$('taskProgressText').textContent=`${Object.values(done).filter(x=>x.completed).length}/${tasks.length}`;
  }
  function rewardText(r){if(!r)return 'مكافأة';if(r.type==='cash'||r.type==='bonus')return money(r.value);if(r.type==='free_tickets')return `${r.value} تذاكر`;if(r.type==='free_spins')return `${r.value} لفات`;return r.label||'مكافأة'}
  function renderSupport(){const list=Object.entries(state.support||{}).map(([id,v])=>({id,...v})).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));$('supportList').innerHTML=list.length?list.map(t=>`<div class="list-item"><i>💬</i><div><b>${escape(t.subject||'طلب دعم')}</b><span>${escape(t.status||'open')} • ${date(t.createdAt)}${t.adminReply?'<br>'+escape(t.adminReply):''}</span></div></div>`).join(''):'<div class="empty-card">لا توجد طلبات دعم.</div>'}

  async function googleLogin(){if(state.settings.loginEnabled===false)return setStatus('authStatus','تسجيل الدخول متوقف حالياً.','bad');if(!$('ageConfirm').checked)return setStatus('authStatus','يجب تأكيد العمر والموافقة على الشروط.','bad');setStatus('authStatus','جاري فتح Google...');try{await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())}catch(e){setStatus('authStatus',e.message,'bad')}}
  async function sendOtp(){if(state.settings.loginEnabled===false)return setStatus('authStatus','تسجيل الدخول متوقف حالياً.','bad');if(!$('ageConfirm').checked)return setStatus('authStatus','يجب تأكيد العمر والموافقة على الشروط.','bad');const phone=$('phoneCountry').value+$('phoneNumber').value.replace(/\D/g,'');if(phone.length<9)return setStatus('authStatus','اكتب رقم هاتف صحيحاً.','bad');try{if(!window.recaptchaVerifier)window.recaptchaVerifier=new firebase.auth.RecaptchaVerifier('recaptcha-container',{size:'invisible'});state.confirmationResult=await auth.signInWithPhoneNumber(phone,window.recaptchaVerifier);$('otpArea').classList.remove('hidden');setStatus('authStatus','تم إرسال الرمز.','ok')}catch(e){setStatus('authStatus',e.message,'bad');window.recaptchaVerifier?.clear();window.recaptchaVerifier=null}}
  async function verifyOtp(){try{await state.confirmationResult.confirm($('otpCode').value.trim())}catch(e){setStatus('authStatus','الرمز غير صحيح.','bad')}}
  async function buyTickets(){if(!state.user)return openModal('authModal');const count=Number($('ticketCount').value||1);$('buyTicketBtn').disabled=true;setStatus('ticketStatus','جاري تنفيذ العملية...');try{const res=await call('buyTickets',{drawType:state.drawType,count,useBonus:$('useBonusTicket').checked});setStatus('ticketStatus',`تم شراء ${res.data.count} تذكرة. المرجع ${res.data.reference}`,'ok');toast('تم شراء التذاكر بنجاح');playSound('win');track('ticket_purchase',{draw_type:state.drawType,count:res.data.count,total:res.data.total||0})}catch(e){setStatus('ticketStatus',functionError(e),'bad')}finally{$('buyTicketBtn').disabled=state.settings.lotteryEnabled===false}}
  async function spinWheel(){if(state.spinning)return;const bet=Number($('wheelBet').value||0);state.spinning=true;$('spinBtn').disabled=true;$('wheelResult').className='result-box';$('wheelResult').textContent='جاري تثبيت النتيجة في Firebase...';try{const res=await call('spinWheel',{bet,useBonus:$('useBonusWheel').checked});const deg=1440+Number(res.data.segmentIndex||0)*(360/(state.game.segments?.length||8))+20;$('wheel').style.transform=`rotate(${deg}deg)`;setTimeout(()=>{$('wheelResult').textContent=res.data.message||res.data.resultLabel;$('wheelResult').className='result-box '+(res.data.won?'win':'');playSound(res.data.won?'win':'click');track('wheel_spin',{result_type:res.data.resultType||'unknown',bet});state.spinning=false;$('spinBtn').disabled=state.settings.wheelEnabled===false||state.game.enabled===false},4000)}catch(e){$('wheelResult').textContent=functionError(e);state.spinning=false;$('spinBtn').disabled=state.settings.wheelEnabled===false||state.game.enabled===false}}
  async function uploadProof(file){if(!file)return '';if(file.size>8*1024*1024)throw new Error('حجم الملف يجب أن يكون أقل من 8MB.');const ext=(file.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'');const path=`deposit-proofs/${state.user.uid}/${Date.now()}-${crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)}.${ext}`;const snap=await storage.ref(path).put(file,{contentType:file.type||'application/octet-stream'});return snap.ref.fullPath}
  async function submitDeposit(){const methodId=state.selectedDeposit,amount=Number($('depositAmount').value||0),file=$('depositProof').files[0];if(!methodId)return setStatus('depositStatus','اختر طريقة الدفع.','bad');$('submitDepositBtn').disabled=true;setStatus('depositStatus','جاري رفع الإثبات...');try{const proofPath=await uploadProof(file);const res=await call('submitDeposit',{methodId,amount,proofPath});setStatus('depositStatus',`تم إرسال الطلب. المرجع ${res.data.reference}`,'ok');$('depositAmount').value='';$('depositProof').value='';playSound('win');track('deposit_request',{method:methodId,amount})}catch(e){setStatus('depositStatus',functionError(e),'bad')}finally{$('submitDepositBtn').disabled=state.settings.depositEnabled===false}}
  async function submitWithdraw(){const methodId=state.selectedWithdraw,amount=Number($('withdrawAmount').value||0),details=$('withdrawDetails').value.trim();if(!methodId)return setStatus('withdrawStatus','اختر طريقة السحب.','bad');$('submitWithdrawBtn').disabled=true;setStatus('withdrawStatus','جاري حجز المبلغ...');try{const res=await call('requestWithdrawal',{methodId,amount,details});setStatus('withdrawStatus',`تم إرسال الطلب وحجز المبلغ. المرجع ${res.data.reference}`,'ok');$('withdrawAmount').value='';$('withdrawDetails').value='';playSound('win');track('withdraw_request',{method:methodId,amount})}catch(e){setStatus('withdrawStatus',functionError(e),'bad')}finally{$('submitWithdrawBtn').disabled=state.settings.withdrawEnabled===false}}
  async function claimDaily(){const btn=$('claimDailyBtn');btn.disabled=true;try{const res=await call('claimDailyReward',{});toast(res.data.message||'تمت إضافة المكافأة');playSound('win');track('daily_reward',{streak:res.data.streak||0})}catch(e){toast(functionError(e))}finally{btn.disabled=false}}
  async function claimTask(taskId){try{const r=await call('claimTaskReward',{taskId});toast('تم استلام مكافأة المهمة');playSound('win');track('task_reward',{task_id:taskId});return r}catch(e){toast(functionError(e))}}
  function editProfile(){const p=state.profile||{};generic('تعديل الملف',`<label>الاسم</label><input id="profileNameInput" class="big-input" value="${escape(p.displayName||state.userData?.displayName||'')}"><label>الدولة</label><input id="profileCountryInput" class="big-input" value="${escape(p.country||'')}"><label>المدينة</label><input id="profileCityInput" class="big-input" value="${escape(p.city||'')}"><button id="saveProfileModalBtn" class="btn gold full">حفظ</button>`);setTimeout(()=>$('saveProfileModalBtn').onclick=saveProfile,0)}
  async function saveProfile(){const data={displayName:$('profileNameInput').value.trim().slice(0,60),country:$('profileCountryInput').value.trim().slice(0,60),city:$('profileCityInput').value.trim().slice(0,60),updatedAt:firebase.database.ServerValue.TIMESTAMP};try{await db.ref('profiles/'+state.user.uid).update(data);closeModal('genericModal');toast('تم حفظ الملف')}catch(e){toast(e.message)}}
  async function referral(){const code=state.userData?.referralCode||'—';let refs={};try{refs=(await db.ref('referrals/'+state.user.uid).once('value')).val()||{}}catch(e){}const list=Object.values(refs).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));generic('الدعوات',`<p>كود الدعوة الخاص بك:</p><input class="big-input" readonly value="${escape(code)}"><button id="copyReferralBtn" class="btn gold full">نسخ الرابط</button><hr><p>استخدام كود دعوة:</p><input id="applyReferralInput" class="big-input" placeholder="اكتب الكود"><button id="applyReferralBtn" class="btn glass full">تطبيق الكود</button><hr><p>الدعوات المستخدمة: ${list.length}</p><div class="list-stack">${list.slice(0,30).map(r=>`<div class="list-item"><i>🔗</i><div><b>${escape(r.emailMasked||r.publicId||'مستخدم')}</b><span>${date(r.createdAt)}</span></div></div>`).join('')||'<div class="empty-card">لا توجد دعوات مستخدمة بعد.</div>'}</div>`);setTimeout(()=>{$('copyReferralBtn').onclick=()=>navigator.clipboard.writeText(`${location.origin}${location.pathname}?ref=${code}`).then(()=>toast('تم النسخ'));$('applyReferralBtn').onclick=async()=>{try{await call('applyReferralCode',{code:$('applyReferralInput').value.trim(),deviceId:deviceId()});toast('تم تطبيق الكود');closeModal('genericModal')}catch(e){toast(functionError(e))}}},0)}
  function settingsModal(){generic('الإعدادات',`<label>اللغة</label><select id="settingsLanguage" class="big-input"><option value="ar">العربية</option><option value="tr">Türkçe</option><option value="en">English</option></select><label>المظهر</label><select id="settingsTheme" class="big-input"><option value="dark">داكن</option><option value="light">فاتح</option></select><label class="switch-row"><span>كتم الأصوات</span><input id="settingsMuted" type="checkbox" ${state.muted?'checked':''}></label><label class="switch-row"><span>إخفاء الرصيد</span><input id="settingsHideBalance" type="checkbox" ${state.hideBalance?'checked':''}></label><button id="saveSettingsBtn" class="btn gold full">حفظ</button>`);setTimeout(()=>{$('settingsLanguage').value=I18N.language;$('settingsTheme').value=state.theme;$('saveSettingsBtn').onclick=async()=>{const lang=$('settingsLanguage').value;I18N.apply(lang);applyTheme($('settingsTheme').value);state.muted=$('settingsMuted').checked;state.hideBalance=$('settingsHideBalance').checked;localStorage.setItem('adnor_muted',state.muted?'1':'0');localStorage.setItem('adnor_hide_balance',state.hideBalance?'1':'0');if(state.user)db.ref('profiles/'+state.user.uid).update({language:lang,updatedAt:firebase.database.ServerValue.TIMESTAMP}).catch(()=>{});renderUser();playSound('click');closeModal('genericModal')}},0)}
  function newSupport(){generic('طلب دعم جديد',`<label>الموضوع</label><input id="supportSubject" class="big-input" maxlength="150"><label>الرسالة</label><textarea id="supportMessage" rows="5" maxlength="5000"></textarea><button id="sendSupportBtn" class="btn gold full">إرسال</button>`);setTimeout(()=>$('sendSupportBtn').onclick=async()=>{const btn=$('sendSupportBtn'),subject=$('supportSubject').value.trim(),message=$('supportMessage').value.trim();if(!subject||!message)return toast('اكتب الموضوع والرسالة');btn.disabled=true;try{const r=await call('submitSupportTicket',{subject,message});closeModal('genericModal');toast(`تم إرسال طلب الدعم. المرجع ${r.data.reference}`);playSound('win');track('support_ticket')}catch(e){toast(functionError(e))}finally{btn.disabled=false}},0)}

  function reportAgent(agentId){
    const agent=state.publicAgents.find(a=>String(a.id)===String(agentId));if(!agent)return;
    if(!state.user){openModal('authModal');toast('سجّل الدخول أولاً لإرسال البلاغ.');return}
    const title=I18N.language==='tr'?'Acente bildirimi':I18N.language==='en'?'Report an agent':'الإبلاغ عن وكيل';
    generic(title,`<div class="agent-report-summary"><b>${escape(agent.name||'ADNOR Agent')}</b><span>${escape([agent.country,agent.city].filter(Boolean).join(' — '))}</span></div><label>سبب البلاغ</label><select id="agentReportReason" class="big-input"><option value="contact">تعذر التواصل</option><option value="payment">مشكلة في الدفع أو الشحن</option><option value="impersonation">اشتباه بانتحال أو احتيال</option><option value="other">سبب آخر</option></select><label>التفاصيل</label><textarea id="agentReportDetails" rows="5" maxlength="3000" placeholder="اكتب ما حدث بدون إرسال كلمات سر أو معلومات بنكية حساسة"></textarea><button id="sendAgentReportBtn" class="btn gold full">إرسال البلاغ</button>`);
    setTimeout(()=>{$('sendAgentReportBtn').onclick=async()=>{const btn=$('sendAgentReportBtn'),reason=$('agentReportReason').value,details=$('agentReportDetails').value.trim();if(details.length<10)return toast('اكتب تفاصيل كافية عن البلاغ.');btn.disabled=true;try{const subject=`بلاغ عن وكيل: ${agent.name||agent.id}`;const message=`Agent UID: ${agent.id}\nLocation: ${[agent.country,agent.city].filter(Boolean).join(' — ')}\nReason: ${reason}\nDetails: ${details}`;const r=await call('submitSupportTicket',{subject,message,category:'agent_report',relatedAgentUid:agent.id});closeModal('genericModal');toast(`تم إرسال البلاغ. المرجع ${r.data.reference}`);track('agent_report',{agent_id:agent.id,reason})}catch(e){toast(functionError(e))}finally{btn.disabled=false}}},0)
  }

  async function logoutUser(){try{await call('logLogout',{deviceId:deviceId()},5000)}catch(e){}await auth.signOut()}
  function bind(){
    $('year').textContent=new Date().getFullYear();
    ['openAuthBtn','heroJoinBtn','quickJoinBtn'].forEach(id=>$(id).onclick=()=>openModal('authModal'));
    $('googleLoginBtn').onclick=googleLogin;$('sendOtpBtn').onclick=sendOtp;$('verifyOtpBtn').onclick=verifyOtp;
    $('landingLanguage').onchange=e=>I18N.apply(e.target.value);
    $('menuBtn').onclick=openDrawer;$('drawerClose').onclick=closeDrawer;$('drawerOverlay').onclick=closeDrawer;$('notifBtn').onclick=openNotifications;
    $('ticketMinus').onclick=()=>{$('ticketCount').value=Math.max(1,Number($('ticketCount').value||1)-1);updateTicketTotal()};$('ticketPlus').onclick=()=>{$('ticketCount').value=Math.min(100,Number($('ticketCount').value||1)+1);updateTicketTotal()};$('ticketCount').oninput=updateTicketTotal;$('ticketFilter').onchange=renderTickets;$('buyTicketBtn').onclick=buyTickets;
    $('drawTabs').onclick=e=>{const b=e.target.closest('[data-draw]');if(!b)return;state.drawType=b.dataset.draw;renderLottery();tick()};
    $('spinBtn').onclick=spinWheel;document.querySelector('.chip-row').onclick=e=>{const b=e.target.closest('[data-bet]');if(b)$('wheelBet').value=b.dataset.bet};
    document.addEventListener('click',e=>{const m=e.target.closest('[data-method]');if(m)selectMethod(m.dataset.methodKind,m.dataset.method);const share=e.target.closest('.share-result');if(share)shareResult(share.dataset.id);const report=e.target.closest('.report-agent');if(report)reportAgent(report.dataset.agentId);const task=e.target.closest('.claim-task');if(task){task.disabled=true;claimTask(task.dataset.taskId).finally(()=>task.disabled=false)}});
    document.querySelector('.wallet-tabs').onclick=e=>{const b=e.target.closest('[data-wallet]');if(!b)return;document.querySelectorAll('.wallet-tabs button').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.wallet-pane').forEach(x=>x.classList.toggle('active',x.id==='wallet-'+b.dataset.wallet))};
    document.addEventListener('click',e=>{const b=e.target.closest('[data-wallet-tab]');if(b){page('wallet');setTimeout(()=>document.querySelector(`[data-wallet="${b.dataset.walletTab}"]`)?.click(),0)}});
    $('submitDepositBtn').onclick=submitDeposit;$('submitWithdrawBtn').onclick=submitWithdraw;$('claimDailyBtn').onclick=claimDaily;$('toggleBalanceBtn').onclick=()=>{state.hideBalance=!state.hideBalance;renderUser()};
    $('editProfileBtn').onclick=editProfile;$('referralBtn').onclick=referral;$('settingsBtn').onclick=settingsModal;$('supportBtn').onclick=()=>page('account');$('newSupportBtn').onclick=newSupport;$('logoutBtn').onclick=logoutUser;
    $('landingAgentCountry').onchange=renderAgents;$('landingAgentSearch').oninput=renderAgents;$('agentCountry').onchange=renderAgents;$('agentSearch').oninput=renderAgents;
    $('installBtn').onclick=async()=>{if(state.deferredPrompt){state.deferredPrompt.prompt();await state.deferredPrompt.userChoice;state.deferredPrompt=null}else toast('استخدم خيار تثبيت التطبيق من قائمة المتصفح.')};
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredPrompt=e});
    window.addEventListener('adnor:language',()=>{applyPublicContent();renderPublicDraws();renderAgents();renderLottery();renderTasks();rebuildTicker()});
    window.addEventListener('adnor:page',e=>track('screen_view',{screen_name:e.detail.page}));document.addEventListener('click',e=>{if(e.target.closest('button,.btn'))playSound('click')},{passive:true});window.addEventListener('online',()=>{toast('عاد الاتصال بالإنترنت');checkAppHealth()});window.addEventListener('offline',()=>{$('systemStatusText').textContent='OFFLINE';toast('أنت غير متصل بالإنترنت')});
  }
  function initReferral(){const p=new URLSearchParams(location.search),ref=p.get('ref');if(ref)localStorage.setItem('adnor_referral_pending',ref.slice(0,40))}
  function init(){state.hideBalance=localStorage.getItem('adnor_hide_balance')==='1';state.muted=localStorage.getItem('adnor_muted')==='1';applyTheme(localStorage.getItem('adnor_theme')||'dark');initReferral();bind();listenPublic();startTicker();rebuildTicker();auth.onAuthStateChanged(u=>u?onSignedIn(u):onSignedOut());setInterval(tick,1000);tick();if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('sw.js').catch(console.warn)}
  document.addEventListener('DOMContentLoaded',init);
})();
