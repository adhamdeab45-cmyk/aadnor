(function(){
  const $=(id)=>document.getElementById(id);
  const money=(n)=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const escape=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const date=(v)=>{if(!v)return '—';const d=new Date(Number(v));return Number.isNaN(d.getTime())?'—':d.toLocaleString(I18N.language==='ar'?'ar-TR':I18N.language==='tr'?'tr-TR':'en-US')};
  function toast(msg){const el=$('toast');if(!el)return;el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),3200)}
  function openModal(id){const el=$(id);if(!el)return;el.classList.add('open');el.setAttribute('aria-hidden','false')}
  function closeModal(id){const el=$(id);if(!el)return;el.classList.remove('open');el.setAttribute('aria-hidden','true')}
  function generic(title,html){$('genericTitle').textContent=title;$('genericBody').innerHTML=html;openModal('genericModal')}
  function setStatus(el,msg,type=''){if(typeof el==='string')el=$(el);if(!el)return;el.textContent=msg;el.className='form-status'+(type?' '+type:'')}
  function page(name){document.querySelectorAll('.app-page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.querySelectorAll('[data-go]').forEach(b=>{if(b.closest('.bottom-nav'))b.classList.toggle('active',b.dataset.go===name)});window.scrollTo({top:0,behavior:'smooth'});closeDrawer();window.dispatchEvent(new CustomEvent('adnor:page',{detail:{page:name}}))}
  function openDrawer(){$('drawer')?.classList.add('open');$('drawerOverlay')?.classList.add('open')}
  function closeDrawer(){$('drawer')?.classList.remove('open');$('drawerOverlay')?.classList.remove('open')}
  function maskName(v){v=String(v||'ADNOR User');if(v.includes('@')){const [a,b]=v.split('@');return `${a.slice(0,2)}***${a.slice(-1)}@${b}`;}return v.length>4?v.slice(0,2)+'***'+v.slice(-1):v.slice(0,1)+'***'}
  async function confirmBox(message){return window.confirm(message)}
  async function promptBox(message,value=''){return window.prompt(message,value)}
  window.UI={$,money,escape,date,toast,openModal,closeModal,generic,setStatus,page,openDrawer,closeDrawer,maskName,confirm:confirmBox,prompt:promptBox};
  document.addEventListener('click',e=>{
    const close=e.target.closest('[data-close]');if(close)closeModal(close.dataset.close);
    const go=e.target.closest('[data-go]');if(go&&document.getElementById('app')&&!document.getElementById('app').classList.contains('hidden'))page(go.dataset.go);
    const scroll=e.target.closest('[data-scroll]');if(scroll)document.getElementById(scroll.dataset.scroll)?.scrollIntoView({behavior:'smooth'});
  });
})();
