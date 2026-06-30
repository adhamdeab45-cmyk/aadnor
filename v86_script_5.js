
(function(){
  if(window.__ADNOR_AUDITED_FINAL_PATCH_V5__) return;
  window.__ADNOR_AUDITED_FINAL_PATCH_V5__ = true;

  function $(id){return document.getElementById(id)}
  function safeText(v){return String(v == null ? '' : v)}
  function getToken(){return localStorage.getItem('ADNOR_ADMIN_TOKEN') || ''}
  function setToken(v){localStorage.setItem('ADNOR_ADMIN_TOKEN', v || '')}
  function msg(t){try{toast(t)}catch(e){alert(t)}}
  function adminHeaders(){return {'Content-Type':'application/json','X-Admin-Token':getToken()}}
  async function apiPost(path, body){
    const r = await fetch(path,{method:'POST',headers:adminHeaders(),body:JSON.stringify(body||{}),cache:'no-store'});
    let j = null; try{j = await r.json()}catch(e){}
    if(!r.ok || !j || j.ok===false) throw new Error((j && (j.error||j.reason)) || ('HTTP '+r.status));
    return j;
  }
  async function publicState(){
    const r = await fetch('/api/public/state?v=' + Date.now(), {cache:'no-store'});
    if(!r.ok) throw new Error('public state '+r.status);
    return await r.json();
  }
  function ensureStatusLine(){
    let line = $('drawStatusLine');
    const card = document.querySelector('.draw-card');
    if(!line && card){
      const stats = card.querySelector('.draw-stats');
      line = document.createElement('div');
      line.id = 'drawStatusLine';
      line.className = 'mini center';
      line.style.cssText='margin-top:10px;border-color:rgba(24,242,155,.28);background:rgba(24,242,155,.07)';
      line.innerHTML = '<span>حالة آخر سحب</span><b id="drawStatusText">انتظار</b>';
      if(stats && stats.parentNode) stats.parentNode.insertBefore(line, stats.nextSibling);
      else card.appendChild(line);
    }
    return line;
  }
  function ensureAuthPolish(){
    try{
      if(firebase && firebase.auth && firebase.auth.Auth && firebase.auth.Auth.Persistence){
        firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(){});
      }
      const brand = document.querySelector('.auth-card .brand p');
      if(brand) brand.textContent = 'دخول آمن — Google أو إيميل وكلمة سر';
      const googleBtn = document.getElementById('googleBtn');
      if(googleBtn){ googleBtn.classList.add('green'); googleBtn.innerHTML = '<i class="fa-brands fa-google"></i> دخول بحساب Google القديم'; }
      const authBtn = document.getElementById('authBtn');
      if(authBtn) authBtn.style.marginTop = '8px';
      let help = document.getElementById('authHelpBox');
      if(!help){
        help = document.createElement('div');
        help.id='authHelpBox';
        help.className='age-box';
        help.innerHTML='<b class="gold">ملاحظة مهمة:</b><br><span class="muted">إذا كان الحساب قديم عبر Gmail، لا تستخدم كلمة سر. اضغط زر Google فقط.</span>';
        const g = document.getElementById('googleBtn');
        if(g && g.parentNode) g.parentNode.insertBefore(help, g.nextSibling);
      }
    }catch(e){}
  }
  function mergePublicState(j){
    if(!j || !j.ok || !j.draws || !window.APP) return;
    APP.serverState = j;
    Object.keys(j.draws).forEach(function(lv){
      APP.settings.draws[lv] = APP.settings.draws[lv] || {};
      const d = APP.settings.draws[lv];
      const sd = j.draws[lv] || {};
      d.serverPrize = sd.prize;
      d.participants = Math.max(Number(d.participants)||0, Number(sd.participants)||0, Number(sd.ticketCount)||0);
      d.serverTicketCount = sd.ticketCount || 0;
      d.lastResult = sd.lastResult || d.lastResult || '0000000';
      d.lastStatus = sd.lastStatus || d.lastStatus || 'انتظار';
      d.lastAt = sd.lastAt || d.lastAt || 0;
      d.manualNumberSaved = !!sd.manualNumberSaved;
      d.releaseAt = sd.releaseAt || d.releaseAt || 0;
    });
  }
  async function syncPublicState(){
    try{
      const j = await publicState();
      mergePublicState(j);
      if(window.DRAW && DRAW.render) DRAW.render();
      serverBadge(true);
      return j;
    }catch(e){ serverBadge(false); }
  }
  function serverBadge(ok){
    let b = $('server24Badge');
    if(!b){
      b = document.createElement('div');
      b.id = 'server24Badge';
      b.style.cssText = 'position:fixed;right:10px;bottom:78px;z-index:9999;padding:7px 10px;border-radius:999px;font:900 11px Arial;background:rgba(3,10,22,.88);border:1px solid rgba(255,255,255,.18);color:#fff;box-shadow:0 0 18px rgba(0,0,0,.35)';
      document.body.appendChild(b);
    }
    b.innerHTML = ok ? '🟢 Server 24H متصل' : '🟠 السيرفر غير متصل';
  }
  function patchDrawRender(){
    if(!window.DRAW || DRAW.__auditedPatched) return;
    const oldRender = DRAW.render.bind(DRAW);
    DRAW.render = function(){
      try{ oldRender(); }catch(e){ console.error('DRAW.render old error', e); }
      try{
        ensureStatusLine();
        const lv = APP.currentDraw || 'daily';
        const d = (APP.settings.draws && APP.settings.draws[lv]) || {};
        if($('drawPrize') && d.serverPrize != null) $('drawPrize').textContent = money(d.serverPrize);
        if($('drawParticipants')) $('drawParticipants').textContent = int(Math.max(n(d.participants), n(d.serverTicketCount), (DRAW.ticketCount ? DRAW.ticketCount(lv) : 0)));
        if($('drawTickets')) $('drawTickets').textContent = int(Math.max((DRAW.ticketCount ? DRAW.ticketCount(lv) : 0), n(d.serverTicketCount)));
        if($('drawLast')) $('drawLast').textContent = d.lastResult || '0000000';
        if($('drawStatusText')) $('drawStatusText').textContent = d.lastStatus || 'انتظار';
        if($('topStatus')) $('topStatus').textContent = 'السحب اليومي الساعة 8:00 مساءً — Server 24H';
      }catch(e){console.error('DRAW.render patch error', e)}
    };
    DRAW.checkScheduled = function(){ return false; };
    DRAW.__auditedPatched = true;
  }
  function patchAdmin(){
    if(!window.ADMIN || ADMIN.__auditedPatched) return;
    ADMIN.tokenBox = function(){
      const t = getToken();
      return '<div class="card" style="border-color:rgba(24,242,155,.35)"><h3>🔐 ربط الأدمن بالسيرفر 24H</h3><p class="muted">ضع نفس ADMIN_TOKEN الموجود في Secrets. هذا يبقى محفوظاً عندك في المتصفح فقط.</p><div class="field"><label>ADMIN_TOKEN</label><input id="adminTokenInput" class="finp" type="password" value="'+esc(t)+'" placeholder="ADNOR_2026_Admin_..."></div><button class="btn green full" onclick="ADMIN.saveToken()">حفظ التوكن</button><button class="btn ghost full" style="margin-top:7px" onclick="ADMIN.testServer()">فحص السيرفر الآن</button><div id="serverTestBox" class="muted" style="margin-top:8px"></div></div>';
    };
    ADMIN.saveToken = function(){ setToken(($('adminTokenInput')||{}).value||''); msg('✅ تم حفظ توكن الأدمن'); };
    ADMIN.testServer = async function(){
      const box = $('serverTestBox');
      try{ const r = await fetch('/api/health?v='+Date.now(),{cache:'no-store'}); const j = await r.json(); if(box) box.innerHTML='✅ السيرفر شغال: '+esc(j.timezone||''); serverBadge(true); }
      catch(e){ if(box) box.innerHTML='❌ السيرفر غير شغال أو الرابط ليس سيرفر'; serverBadge(false); }
    };
    ADMIN.draws = function(){
      let html = ADMIN.tokenBox();
      html += '<div class="card"><h3>🎯 السحوبات اليدوية المربوطة بالسيرفر</h3><p class="muted">احفظ رقم الفائز من هنا. السيرفر يعرض النتيجة تلقائياً بوقت السحب، أو نفّذها فوراً للاختبار.</p><div class="admin-grid">';
      LEVELS.forEach(function(lv){
        const d = APP.settings.draws[lv] || {};
        html += '<div class="admin-field"><label>'+LABEL[lv]+'</label>'+
          '<input class="finp" id="man_'+lv+'" maxlength="7" inputmode="numeric" placeholder="رقم الفائز 7 خانات" value="'+esc(d.manualNumber||'')+'">'+
          '<label>عدد المشاركين الظاهر</label><input class="finp" type="number" id="par_'+lv+'" value="'+Math.max(n(d.participants), n(d.serverTicketCount), DRAW.ticketCount(lv))+'">'+
          '<label>جائزة البداية</label><input class="finp" type="number" id="base_'+lv+'" value="'+n(d.base)+'">'+
          '<label>الهدف الأدنى/الأعلى</label><div class="grid two"><input class="finp" type="number" id="tmin_'+lv+'" value="'+n(d.targetMin)+'"><input class="finp" type="number" id="tmax_'+lv+'" value="'+n(d.targetMax)+'"></div>'+
          '<p class="muted">الجائزة الآن: '+money(d.serverPrize!=null?d.serverPrize:prize(lv))+'<br>التذاكر: '+int(Math.max(n(d.serverTicketCount),DRAW.ticketCount(lv)))+'<br>آخر نتيجة: <b class="gold">'+esc(d.lastResult||'0000000')+'</b><br>الحالة: '+esc(d.lastStatus||'انتظار')+'</p>'+
          '<button class="btn full" onclick="ADMIN.saveDrawSettings(\''+lv+'\')">حفظ إعدادات الجائزة والمشاركين</button>'+
          '<button class="btn green full" style="margin-top:7px" onclick="ADMIN.saveDrawServer(\''+lv+'\')">حفظ رقم الفائز على السيرفر</button>'+
          '<button class="btn red full" style="margin-top:7px" onclick="ADMIN.executeDrawServer(\''+lv+'\')">تنفيذ السحب الآن من السيرفر</button>'+
          '</div>';
      });
      html += '</div><button class="btn blue full" style="margin-top:12px" onclick="ADMIN.syncServerCounters()">مزامنة العدادات والنتائج من السيرفر</button></div>';
      if(APP.serverState && APP.serverState.history && APP.serverState.history.length){
        html += '<div class="card"><h3>📜 آخر السحوبات من السيرفر</h3>'+APP.serverState.history.map(function(x){return '<div class="row"><div><b>'+esc(LABEL[x.level]||x.level)+' — '+esc(x.manualNumber||x.number||'')+'</b><small>'+esc(x.time||'')+' | '+esc(x.winnersCount||0)+' فائز | '+esc(x.movedCount||0)+' بطاقة انتقلت</small></div><span class="badge">'+esc(x.amount||0)+'</span></div>'}).join('')+'</div>';
      }
      return html;
    };
    ADMIN.saveDrawSettings = async function(lv){
      try{
        if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً في أعلى صفحة السحوبات');
        const body = { level:lv, base:n($('base_'+lv).value), targetMin:n($('tmin_'+lv).value), targetMax:n($('tmax_'+lv).value), participants:n($('par_'+lv).value) };
        await apiPost('/api/admin/draw/settings', body);
        await syncPublicState();
        msg('✅ تم حفظ إعدادات '+LABEL[lv]+' على السيرفر');
      }catch(e){ msg('⚠️ '+e.message); }
    };
    ADMIN.saveDrawServer = async function(lv){
      try{
        if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً في أعلى صفحة السحوبات');
        const num = pad7(($('man_'+lv)||{}).value||'');
        if(!num || num.length !== 7) return msg('اكتب رقم فائز 7 خانات');
        await ADMIN.saveDrawSettings(lv).catch(function(){});
        const out = await apiPost('/api/admin/draw/manual-number', {level:lv, number:num});
        await syncPublicState();
        msg('✅ تم حفظ رقم '+LABEL[lv]+' على السيرفر: '+out.number);
      }catch(e){ msg('⚠️ '+e.message); }
    };
    ADMIN.executeDrawServer = async function(lv){
      try{
        if(!getToken()) return msg('ضع ADMIN_TOKEN أولاً في أعلى صفحة السحوبات');
        const input = ($('man_'+lv)||{}).value || ((APP.settings.draws[lv]||{}).manualNumber || '');
        const num = pad7(input);
        if(!num || num.length !== 7) return msg('اكتب رقم فائز 7 خانات أو احفظ رقم سابقاً');
        const out = await apiPost('/api/admin/draw/run', {level:lv, number:num, force:true});
        await syncPublicState();
        const r = out.result || {};
        msg('✅ تم تنفيذ السحب من السيرفر. النتيجة: '+(r.manualNumber||num)+' — '+(r.winnersCount||0)+' فائز — '+(r.movedCount||0)+' بطاقة انتقلت');
      }catch(e){ msg('⚠️ '+e.message); }
    };
    ADMIN.syncServerCounters = async function(){
      try{
        if(getToken()) await apiPost('/api/admin/counters/sync', {});
        await syncPublicState();
        if(ADMIN.refreshIfOpen) ADMIN.refreshIfOpen();
        msg('✅ تم تحديث العدادات والنتائج');
      }catch(e){ msg('⚠️ '+e.message); }
    };
    ADMIN.__auditedPatched = true;
  }
  function patchTickets(){
    if(!window.TICKETS || TICKETS.__auditedPatched) return;
    const oldRandom = TICKETS.random.bind(TICKETS);
    TICKETS.random = function(){
      oldRandom();
      const inp = $('ticketInput');
      const used = Object.assign({}, APP.tickets.daily || {});
      let tries = 0;
      while(inp && used[pad7(inp.value)] && tries++ < 2000){ oldRandom(); }
    };
    TICKETS.__auditedPatched = true;
  }
  function boot(){
    ensureAuthPolish();
    patchDrawRender();
    patchAdmin();
    patchTickets();
    ensureStatusLine();
    syncPublicState();
  }
  window.ADNOR_FORCE_SERVER_SYNC = syncPublicState;
  setTimeout(boot, 300);
  setTimeout(boot, 1500);
  setTimeout(boot, 3500);
  setInterval(boot, 10000);
  setInterval(syncPublicState, 15000);
})();
