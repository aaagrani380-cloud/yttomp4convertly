const STORE = { events:'convertly_events', theme:'convertly_theme', api:'convertly_api_base' };
let sb = window.convertlySupabase || null;
let authUser = null;
let profile = null;
let proAccess = false;

function getStore(key, fallback){ try{return JSON.parse(localStorage.getItem(key)) ?? fallback;}catch{return fallback;} }
function setStore(key,value){localStorage.setItem(key,JSON.stringify(value));}
function toast(message){let el=document.getElementById('toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';document.body.appendChild(el);}el.textContent=message;el.classList.add('show');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>el.classList.remove('show'),3200);}
function applyTheme(){const light=getStore(STORE.theme,'dark')==='light';document.body.classList.toggle('light',light);const btn=document.getElementById('themeBtn');if(btn)btn.textContent=light?'☾':'☼';}
function setupTheme(){applyTheme();document.getElementById('themeBtn')?.addEventListener('click',()=>{const next=document.body.classList.contains('light')?'dark':'light';setStore(STORE.theme,next);applyTheme();});}
function setupNav(){const menu=document.getElementById('menuBtn'),links=document.getElementById('navLinks');menu?.addEventListener('click',()=>links?.classList.toggle('mobile-open'));}
function setupModals(){const modal=document.getElementById('infoModal');if(!modal)return;const title=document.getElementById('modalTitle'),body=document.getElementById('modalBody');const content={
 privacy:['Privacy Policy','<p>Convertly follows a minimal-data approach. Account data is stored with the authentication/database provider. Conversion files should be temporary and automatically cleaned up.</p><p>We do not store payment card details on the Convertly application server. For questions, contact <a href="mailto:gamerzneel01@gmail.com">gamerzneel01@gmail.com</a>.</p>'],
 terms:['Terms of Use','<p>Use Convertly only with media you own or are authorized to process. Do not bypass DRM, authentication, paywalls, or platform restrictions.</p><p>Availability, limits, subscriptions and refunds are subject to the published service rules and payment-provider terms.</p>'],
 copyright:['Copyright','<p>You are responsible for having the necessary rights or permissions for media you process. Convertly does not grant rights to third-party content.</p><p>Copyright questions and notices: <a href="mailto:gamerzneel01@gmail.com">gamerzneel01@gmail.com</a>.</p>'],
 payment:['Pro checkout','<p>Pro checkout is connected to the future Safepay server-side subscription flow. The browser must never be trusted to grant Pro access.</p><p>After payment, a verified webhook updates the user subscription in Supabase.</p>']};
 function open(key){const item=content[key];if(!item)return;title.textContent=item[0];body.innerHTML=item[1];modal.classList.add('show');modal.setAttribute('aria-hidden','false');}
 function close(){modal.classList.remove('show');modal.setAttribute('aria-hidden','true');}
 document.querySelectorAll('[data-legal]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();open(a.dataset.legal)}));document.getElementById('modalClose')?.addEventListener('click',close);modal.addEventListener('click',e=>{if(e.target===modal)close()});document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});window.openConvertlyModal=open;}
function isYoutubeUrl(value){try{const u=new URL(value);return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname);}catch{return false;}}
function getApiBase(){return(window.CONVERTLY_API_BASE||getStore(STORE.api,'')||((location.protocol==='file:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')?'http://localhost:8787':location.origin)).replace(/\/$/,'');}

function notificationSupported(){return 'Notification' in window;}
function notificationsEnabled(){return getStore('convertly_notifications',true)!==false;}
async function requestBrowserNotifications(){
 if(!notificationSupported()){toast('Browser notifications are not supported here.');return false;}
 if(Notification.permission==='granted'){setStore('convertly_notifications',true);toast('Browser notifications are enabled.');return true;}
 if(Notification.permission==='denied'){setStore('convertly_notifications',false);toast('Notifications are blocked in this browser. You can allow them from site settings.');return false;}
 try{const permission=await Notification.requestPermission();const ok=permission==='granted';setStore('convertly_notifications',ok);toast(ok?'Browser notifications enabled.':'Notification permission was not granted.');return ok;}catch{toast('Could not request notification permission.');return false;}
}
function notifyConversion(title,body,tag='convertly-conversion'){
 if(!notificationSupported()||Notification.permission!=='granted'||!notificationsEnabled()||document.visibilityState==='visible')return;
 try{new Notification(title,{body,tag,icon:'/nexora-mark.png'});}catch{}
}
function setupBrowserNotifications(){
 const status=document.getElementById('conversionStatus');if(!status)return;
 let wrap=document.getElementById('notificationControls');
 if(!wrap){wrap=document.createElement('div');wrap.id='notificationControls';wrap.className='notification-controls';status.insertAdjacentElement('afterend',wrap);}
 const button=document.createElement('button');button.type='button';button.className='notification-btn';button.id='notificationBtn';button.textContent='Enable browser notifications';wrap.replaceChildren(button);
 const sync=()=>{if(!notificationSupported()){button.hidden=true;return;}button.hidden=false;button.textContent=Notification.permission==='granted'&&notificationsEnabled()?'Browser notifications enabled':'Enable browser notifications';button.disabled=Notification.permission==='granted'&&notificationsEnabled();};
 button.addEventListener('click',async()=>{await requestBrowserNotifications();sync();});
 sync();
}

function setConversionStatus(message, type='info', actionUrl='', outputFormat='mp4', progress=null) {
  const el = document.getElementById('conversionStatus');
  if (!el) return;
  el.className = `conversion-status ${type}`;
  const label = outputFormat === 'mp3' ? 'Download MP3' : 'Download MP4';
  const hasProgress = Number.isFinite(Number(progress));
  const pct = hasProgress ? Math.min(100, Math.max(0, Math.round(Number(progress)))) : null;
  const safeMessage = escapeHtml(message);
  if (!actionUrl) {
    if (hasProgress) {
      el.innerHTML = `<div class=\"conversion-message\">${safeMessage}</div><div class=\"status-line\"><strong>${pct}%</strong></div><div class=\"status-progress\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"100\" aria-valuenow=\"${pct}\"><span style=\"width:${pct}%\"></span></div>`;
    } else el.innerHTML = safeMessage;
    return;
  }
  el.innerHTML = `<div class=\"conversion-message\">${safeMessage}</div><button type=\"button\" class=\"status-download\" id=\"statusDownloadButton\">${label}</button>`;
  const downloadButton = el.querySelector('#statusDownloadButton');
  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  downloadButton.addEventListener('click', async () => {
    try {
      downloadButton.disabled = true;
      downloadButton.textContent = 'Preparing download...';
      const downloadApi = actionUrl.includes('/api/download/') && !actionUrl.includes('/api/share/');
      let response;
      if (downloadApi) { const headers={}; if(authUser&&sb){const {data:{session}}=await sb.auth.getSession(); if(session?.access_token) headers.Authorization=`Bearer ${session.access_token}`;} response=await fetch(actionUrl,{headers}); } else response=await fetch(actionUrl);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `convertly-${Date.now()}.${outputFormat}`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      downloadButton.textContent = 'Downloaded ✓';
    } catch (error) {
      console.error('Download error:', error);
      downloadButton.disabled = false;
      downloadButton.textContent = 'Retry Download';
    }
  });
}
function formatEta(seconds){const s=Math.max(0,Number(seconds||0));if(!s)return 'less than a minute';if(s<60)return `${s}s`;const m=Math.floor(s/60),r=s%60;return r?`${m}m ${r}s`:`${m}m`;}
async function pollConversion(jobId, outputFormat='mp4'){const base=getApiBase();if(!base)return;for(let i=0;i<180;i++){await new Promise(r=>setTimeout(r,1000));try{const {data:{session}}=await sb.auth.getSession();const headers=session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{ };const r=await fetch(`${base}/api/conversion/${encodeURIComponent(jobId)}`,{headers});if(!r.ok){if(r.status===404){setConversionStatus('Conversion job was not found.','error');return;}continue;}const job=await r.json();const rawPct=Number(job.progress||0);const pct=job.status==='processing'?Math.min(99,Math.max(1,Math.round(rawPct))):Math.min(100,Math.max(0,Math.round(rawPct)));const eta=job.status==='processing'&&job.etaSeconds!=null?` · ETA ${formatEta(job.etaSeconds)}`:'';setConversionStatus(`${job.status} · ${pct}%${eta}`,'info','',outputFormat,pct);if(job.status==='completed'){notifyConversion('Convertly: conversion complete',`Your ${outputFormat.toUpperCase()} conversion is ready to download.`,'conversion-'+jobId);setConversionStatus('Conversion complete.','success',`${base}/api/download/${encodeURIComponent(jobId)}`,outputFormat);return;}if(job.status==='failed'||job.status==='canceled'||job.status==='expired'){notifyConversion(`Convertly: conversion ${job.status}`,job.error_message||`Your conversion ${job.status}.`,'conversion-'+jobId);setConversionStatus(job.error_message||`Conversion ${job.status}.`,'error');return;}}catch(error){if(i===179)setConversionStatus(error.message||'Conversion status check failed.','error');}}setConversionStatus('Conversion is taking longer than expected. Check your account history for the latest status.','error');}
async function track(event,data={}){const payload={event_name:event,metadata:{...data,path:location.pathname}};try{if(sb&&authUser){await sb.from('analytics_events').insert({user_id:authUser.id,...payload});}}catch{} }
async function refreshAuthState(){
 if(!sb)return;
 const {data:{session}}=await sb.auth.getSession(); authUser=session?.user||null; profile=null; proAccess=false;
 if(authUser){
   const p=await sb.from('profiles').select('id,email,display_name,role').eq('id',authUser.id).maybeSingle();
   profile=p.data||null;
   const {data:pro}=await sb.rpc('has_pro_access'); proAccess=pro===true;
 }
 window.CONVERTLY_USER=authUser;window.CONVERTLY_PROFILE=profile;window.CONVERTLY_PRO=proAccess;
 syncGlobalAuthUI();
}
function isAdmin(){return profile?.role==='admin';}
function hasProAccess(){return proAccess===true || isAdmin();}
function syncGlobalAuthUI(){
 document.querySelectorAll('[data-user-email]').forEach(el=>el.textContent=authUser?.email||'Guest');
 document.querySelectorAll('[data-pro-status]').forEach(el=>el.textContent=hasProAccess()?'Pro':'Free');
 document.querySelectorAll('[data-admin-link]').forEach(el=>el.hidden=!isAdmin());
 const badge=document.getElementById('proBadge');if(badge){badge.textContent=isAdmin()?'ADMIN · PRO':hasProAccess()?'PRO':'FREE';badge.classList.toggle('active',hasProAccess());}
 document.querySelectorAll('.pro-only').forEach(o=>o.disabled=!hasProAccess());document.querySelectorAll('[data-free-ad]').forEach(ad=>{ad.hidden=hasProAccess();});
}
async function addHistory(item){
 if(!sb||!authUser)return;
 try{await sb.from('conversions').insert({user_id:authUser.id,source:item.source||'youtube',source_url:item.url,quality:Number(item.quality),format:item.format,status:item.status||'queued',job_id:item.jobId||null});}catch{}
}
async function requestConversion(payload){
 const base=getApiBase();if(!base)throw new Error('Conversion backend is not configured.');
 const headers={'Content-Type':'application/json'};if(authUser){const {data:{session}}=await sb.auth.getSession();if(session?.access_token)headers.Authorization=`Bearer ${session.access_token}`;}
 const response=await fetch(`${base}/api/convert`,{method:'POST',headers,credentials:'include',body:JSON.stringify(payload)});if(!response.ok){const text=await response.text().catch(()=> '');throw new Error(text||`Conversion service returned ${response.status}`);}return await response.json();
}
async function requestBatchConversion(items){
 const base=getApiBase();if(!base)throw new Error('Conversion backend is not configured.');
 const headers={'Content-Type':'application/json'};
 if(authUser){const {data:{session}}=await sb.auth.getSession();if(session?.access_token)headers.Authorization=`Bearer ${session.access_token}`;}
 const response=await fetch(`${base}/api/batch-convert`,{method:'POST',headers,credentials:'include',body:JSON.stringify({items})});
 const text=await response.text().catch(()=> '');
 let data={};try{data=text?JSON.parse(text):{};}catch{data={error:text};}
 if(!response.ok)throw new Error(data.error||`Batch service returned ${response.status}`);
 return data;
}
async function downloadConversion(jobId, outputFormat='mp4', button=null){
 const base=getApiBase(); if(!base) throw new Error('Conversion backend is not configured.');
 const headers={};
 if(authUser && sb){const {data:{session}}=await sb.auth.getSession();if(session?.access_token)headers.Authorization=`Bearer ${session.access_token}`;}
 const response=await fetch(`${base}/api/download/${encodeURIComponent(jobId)}`,{headers});
 if(!response.ok){let message=`Download failed: ${response.status}`;try{const data=await response.json();message=data.error||message;}catch{}throw new Error(message);}
 const contentType=response.headers.get('content-type')||'';
 let blob;
 if(contentType.includes('application/json')){const out=await response.json();const direct=await fetch(out.url);if(!direct.ok)throw new Error(`File download failed: ${direct.status}`);blob=await direct.blob();}
 else blob=await response.blob();
 const blobUrl=URL.createObjectURL(blob);
 const link=document.createElement('a');link.href=blobUrl;link.download=`convertly-${Date.now()}.${outputFormat}`;document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(blobUrl),2000);
 if(button){button.disabled=false;button.textContent='Downloaded ✓';}
}

async function pollBatch(batchId){
 const base=getApiBase();if(!base)return;
 for(let i=0;i<360;i++){
  await new Promise(r=>setTimeout(r,1500));
  try{
   const headers={};if(authUser){const {data:{session}}=await sb.auth.getSession();if(session?.access_token)headers.Authorization=`Bearer ${session.access_token}`;}
   const r=await fetch(`${base}/api/batch/${encodeURIComponent(batchId)}`,{headers});
   if(!r.ok)throw new Error('Could not load batch status.');
   const batch=await r.json();
   const done=Number(batch.completed||0),failed=Number(batch.failed||0),total=Number(batch.total||0);
   const batchEta=batch.etaSeconds==null?'':` · ETA ${formatEta(batch.etaSeconds)}`;setConversionStatus(`Batch ${batch.status} · ${done + failed}/${total} finished · ${failed} failed · ${Math.round(batch.progress||0)}%${batchEta}`,'info');
   if(batch.status==='completed'||batch.status==='completed_with_errors'){notifyConversion('Convertly: batch complete',`${done} completed, ${failed} failed out of ${total}.`,'batch-'+batchId);
    const summary=batch.items.map((item,i)=>`${i+1}. ${item.status}${item.status==='completed'?' — <button type="button" class="status-download batch-download" data-job-id="'+escapeHtml(item.jobId)+'" data-format="'+escapeHtml(item.format||'mp4')+'">Download</button>':item.error?' — '+escapeHtml(item.error):''}`).join('<br>');
    const el=document.getElementById('conversionStatus');if(el){el.className=`conversion-status ${failed?'error':'success'}`;el.innerHTML=`Batch complete · ${done}/${total} succeeded${failed?` · ${failed} failed`:''}<div class="batch-results">${summary}</div>`;el.querySelectorAll('.batch-download').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;btn.textContent='Preparing…';try{await downloadConversion(btn.dataset.jobId,btn.dataset.format,btn);}catch(e){btn.disabled=false;btn.textContent='Retry Download';toast(e.message||'Download failed.');}}));}
    return;
   }
  }catch(error){setConversionStatus(error.message||'Batch status check failed.','error');return;}
 }
 setConversionStatus('Batch is taking longer than expected. Check your account history.','error');
}
const PRESET_STORE_KEY='convertly_presets_v1';
const BUILTIN_PRESETS={
 fast720:{name:'Fast 720p',quality:'720',format:'mp4',targetSize:''},
 high1080:{name:'High Quality 1080p',quality:'1080',format:'mp4',targetSize:''},
 small20:{name:'Small File · 20 MB',quality:'720',format:'mp4',targetSize:'20'},
 audio192:{name:'Audio MP3 · 192 kbps',quality:'1080',format:'mp3',targetSize:''}
};
function loadSavedPresets(){try{const value=JSON.parse(localStorage.getItem(PRESET_STORE_KEY)||'[]');return Array.isArray(value)?value.filter(p=>p&&p.id&&p.name):[];}catch{return[];}}
function saveSavedPresets(items){try{localStorage.setItem(PRESET_STORE_KEY,JSON.stringify(items));}catch{toast('Could not save preset on this device.');}}
const SOCIAL_PRESETS={
 youtube:{name:'YouTube · 1080p',quality:'1080',format:'mp4',targetSize:''},
 shorts:{name:'YouTube Shorts · 1080p',quality:'1080',format:'mp4',targetSize:''},
 instagram:{name:'Instagram Reels · 1080p',quality:'1080',format:'mp4',targetSize:''},
 tiktok:{name:'TikTok · 1080p',quality:'1080',format:'mp4',targetSize:''},
 facebook:{name:'Facebook · 1080p',quality:'1080',format:'mp4',targetSize:''},
 x:{name:'X · 720p',quality:'720',format:'mp4',targetSize:''}
};
function setupSocialPresets({quality,format,targetSize}){
 const select=document.getElementById('socialPresetSelect');if(!select)return {refresh(){}};
 const refresh=()=>{select.value='';};
 select.addEventListener('change',()=>{const preset=SOCIAL_PRESETS[select.value];if(!preset)return;quality.value=preset.quality;format.value=preset.format;if(targetSize)targetSize.value=preset.targetSize||'';format.dispatchEvent(new Event('change',{bubbles:true}));refresh();toast(`${preset.name} applied.`);});
 return {refresh};
}

function setupPresets({quality,format,targetSize}){
 const select=document.getElementById('presetSelect'),saveBtn=document.getElementById('savePresetBtn'),deleteBtn=document.getElementById('deletePresetBtn');
 if(!select||!saveBtn)return {refresh:()=>{}};
 const saved=loadSavedPresets();
 const renderSaved=()=>{select.querySelectorAll('option[data-custom-preset]').forEach(o=>o.remove());if(saved.length){const group=document.createElement('optgroup');group.label='Saved on this device';saved.forEach(p=>{const o=document.createElement('option');o.value=`custom:${p.id}`;o.textContent=p.name;o.dataset.customPreset='1';group.appendChild(o);});select.appendChild(group);}};
 renderSaved();
 const refresh=()=>{const selected=select.value;const isCustom=selected.startsWith('custom:');if(deleteBtn)deleteBtn.hidden=!isCustom;};
 const apply=(preset)=>{if(!preset)return;quality.value=preset.quality;format.value=preset.format;targetSize.value=preset.targetSize||'';format.dispatchEvent(new Event('change',{bubbles:true}));select.value=preset.id&&BUILTIN_PRESETS[preset.id]?preset.id:`custom:${preset.id}`;refresh();toast(`${preset.name} applied.`);};
 select.addEventListener('change',()=>{const id=select.value;if(!id){refresh();return;}if(BUILTIN_PRESETS[id])apply({...BUILTIN_PRESETS[id],id});else if(id.startsWith('custom:')){const p=saved.find(x=>`custom:${x.id}`===id);if(p)apply(p);}});
 saveBtn.addEventListener('click',()=>{const name=window.prompt('Preset name:');if(!name||!name.trim())return;const preset={id:crypto.randomUUID?.()||String(Date.now()),name:name.trim(),quality:quality.value,format:format.value,targetSize:targetSize.value||''};saved.push(preset);saveSavedPresets(saved);renderSaved();select.value=`custom:${preset.id}`;refresh();toast('Preset saved on this device.');});
 deleteBtn?.addEventListener('click',()=>{const id=select.value.replace(/^custom:/,'');const index=saved.findIndex(p=>p.id===id);if(index<0)return;if(!window.confirm('Delete this saved preset?'))return;saved.splice(index,1);saveSavedPresets(saved);renderSaved();select.value='';refresh();toast('Saved preset deleted.');});
 refresh();return {refresh};
}
function setupConverter(){
 const quality=document.getElementById('qualitySelect'),format=document.getElementById('formatSelect'),input=document.getElementById('urlInput'),convert=document.getElementById('convertBtn'),targetSize=document.getElementById('targetSizeSelect'),targetSizeWrap=document.getElementById('targetSizeWrap'),permissionCheckbox=document.getElementById('permissionCheckbox'),batchBtn=document.getElementById('batchConvertBtn');if(!quality||!format||!input||!convert)return;
 const presetController=setupPresets({quality,format,targetSize});
 const socialPresetController=setupSocialPresets({quality,format,targetSize});
 const badge=document.getElementById('proBadge');
 const sync=()=>{const pro=hasProAccess();badge&&(badge.textContent=isAdmin()?'ADMIN · PRO':pro?'PRO':'FREE');badge?.classList.toggle('active',pro);document.querySelectorAll('.pro-only').forEach(o=>o.disabled=!pro);if(!pro&&+quality.value>1080)quality.value='1080';const mp3=format.value==='mp3';if(targetSizeWrap)targetSizeWrap.hidden=mp3;if(targetSize)targetSize.disabled=mp3;if(mp3&&+quality.value>1080)quality.value='1080';convert.innerHTML=mp3?'Convert to MP3 <span>→</span>':'Convert to MP4 <span>→</span>';const note=document.querySelector('.quality-note');if(note)note.textContent=mp3?'MP3 audio · 192 kbps target · authorized content only':'Main tool: YouTube → MP4 · Free max 1080p · Pro 1440p/4K';};
 const syncPermission=()=>{const ok=Boolean(permissionCheckbox?.checked);if(convert)convert.disabled=!ok;if(batchBtn)batchBtn.disabled=!ok;};
 permissionCheckbox?.addEventListener('change',syncPermission);
 sync();syncPermission();
 const requested=new URLSearchParams(location.search).get('format');if(requested==='mp3'&&[...format.options].some(o=>o.value==='mp3'))format.value='mp3';sync();
 format.addEventListener('change',()=>{sync();presetController.refresh();socialPresetController.refresh();});
 sb?.auth.onAuthStateChange(()=>setTimeout(refreshAuthState,0));
 document.getElementById('upgradeBtn')?.addEventListener('click',()=>window.openConvertlyModal?.('payment'));
 document.getElementById('proCta')?.addEventListener('click',()=>window.openConvertlyModal?.('payment'));
 convert.addEventListener('click',async()=>{if(!permissionCheckbox?.checked)return toast('Please confirm that you own this content or have permission to download and convert it.');const url=input.value.trim();if(!url)return toast('Paste a YouTube URL first.');if(!isYoutubeUrl(url))return toast('For the main tool, please enter a valid YouTube URL.');// Guest conversion is allowed in local/dev mode; production can keep authentication enforced by the backend environment.
 const pro=hasProAccess();if(format.value==='mp4'&&+quality.value>1080&&!pro){toast('1440p and 4K are Pro-only.');window.openConvertlyModal?.('payment');return;}if(format.value==='mp3'&&+quality.value>1080)quality.value='1080';const payload={source:'youtube',url,quality:Number(quality.value),format:format.value,targetSizeMB:format.value==='mp4'&&targetSize?.value?Number(targetSize.value):null,permissionConfirmed:true};convert.disabled=true;const original=convert.innerHTML;convert.textContent='Checking…';try{const result=await requestConversion(payload);await track('conversion_started',{quality:quality.value,format:format.value,pro,permissionConfirmed:true});setConversionStatus('queued · 1%','info','',format.value,1);toast(result.message||'Conversion queued.');pollConversion(result.jobId,format.value);}catch(error){await track('conversion_error',{message:error.message});toast(error.message||'Conversion service is unavailable.');}finally{convert.disabled=!permissionCheckbox.checked;convert.innerHTML=original;}});
 document.getElementById('pasteBtn')?.addEventListener('click',async()=>{try{const t=await navigator.clipboard.readText();if(t){input.value=t;toast('YouTube URL pasted.')}}catch{input.focus();toast('Clipboard permission unavailable — paste manually.')}});
 const batchPanel=document.getElementById('batchPanel'),urlPanel=document.getElementById('urlPanel'),batchUrls=document.getElementById('batchUrls');
 document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{
   document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');
   const batch=tab.dataset.mode==='batch';if(urlPanel)urlPanel.hidden=batch;if(batchPanel)batchPanel.hidden=!batch;if(document.getElementById('conversionSettings'))document.getElementById('conversionSettings').hidden=batch;
 }));
 batchBtn?.addEventListener('click',async()=>{
   const urls=(batchUrls?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   if(!urls.length)return toast('Add at least one YouTube URL.');
   const maxBatchUrls=hasProAccess()||isAdmin()?20:5;if(urls.length>maxBatchUrls)return toast(`Your ${hasProAccess()||isAdmin()?'Pro':'Free'} plan allows up to ${maxBatchUrls} URLs per batch.`);
   if(!permissionCheckbox?.checked)return toast('Please confirm that you own this content or have permission to download and convert it.');
   const items=urls.map(url=>({source:'youtube',url,quality:Number(quality.value),format:format.value,targetSizeMB:format.value==='mp4'&&targetSize?.value?Number(targetSize.value):null,permissionConfirmed:true}));
   batchBtn.disabled=true;const original=batchBtn.innerHTML;batchBtn.textContent='Queueing…';
   try{const result=await requestBatchConversion(items);await track('batch_conversion_started',{count:result.total,format:format.value,quality:quality.value,permissionConfirmed:true});setConversionStatus(`Batch queued · ${result.total} items`,'info');toast('Batch queued.');pollBatch(result.batchId);}catch(error){toast(error.message||'Could not start batch.');setConversionStatus(error.message||'Could not start batch.','error');}finally{batchBtn.disabled=!permissionCheckbox.checked;batchBtn.innerHTML=original;}
 });

}
let accountHistoryRows=[];
let accountHistoryVisible=20;
function historyStatusLabel(status){return String(status||'').replace(/^./,m=>m.toUpperCase());}
function historyActions(h){
 const actions=[]; const base=getApiBase();
 if(h.status==='completed' && base && h.id){actions.push(`<button type="button" class="history-action history-download" data-id="${escapeHtml(h.id)}" data-format="${escapeHtml(h.format||'mp4')}">Download</button>`);actions.push(`<button class="history-action history-share" data-id="${escapeHtml(h.id)}">Share</button>`);}
 if((h.status==='failed'||h.status==='canceled') && base && h.id) actions.push(`<button class="history-action history-retry" data-id="${escapeHtml(h.id)}">Retry</button>`);
 return actions.join('');
}
function renderAccountHistory(){
 const list=document.getElementById('historyList'),summary=document.getElementById('historySummary'),more=document.getElementById('historyMore'); if(!list)return;
 const q=(document.getElementById('historySearch')?.value||'').trim().toLowerCase(); const status=document.getElementById('historyStatus')?.value||'all';
 const filtered=accountHistoryRows.filter(h=>{const hay=`${h.source_url||''} ${h.source||''} ${h.format||''} ${h.quality||''}`.toLowerCase();return (!q||hay.includes(q))&&(status==='all'||h.status===status);});
 const visible=filtered.slice(0,accountHistoryVisible);
 list.innerHTML=visible.length?visible.map(h=>{const title=`${h.source||'youtube'} → ${(h.format||'mp4').toUpperCase()}`;const detail=`${h.quality}p · ${new Date(h.created_at).toLocaleString()}`;const error=h.status==='failed'||h.status==='canceled'?`<small class="history-error">${escapeHtml(h.error_message||'No additional details.')}</small>`:'';return `<li class="history-item"><div class="history-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(detail)}</small><small class="history-url" title="${escapeHtml(h.source_url||'')}">${escapeHtml(h.source_url||'')}</small>${error}</div><div class="history-side"><span class="history-status status-${escapeHtml(h.status||'unknown')}">${escapeHtml(historyStatusLabel(h.status))}</span><div class="history-actions">${historyActions(h)}</div></div></li>`;}).join(''):'<li class="empty-state">No matching conversions found.</li>';
 if(summary)summary.textContent=filtered.length?`Showing ${visible.length} of ${filtered.length} matching conversions.`:'No conversions match your filters.';
 if(more){more.hidden=visible.length>=filtered.length;more.textContent='Load more';}
 list.querySelectorAll('.history-download').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;btn.textContent='Preparing…';try{await downloadConversion(btn.dataset.id,btn.dataset.format,btn);}catch(e){btn.disabled=false;btn.textContent='Retry Download';toast(e.message||'Download failed.');}}));
 list.querySelectorAll('.history-retry').forEach(btn=>btn.addEventListener('click',async()=>{if(!window.confirm('Please confirm that you own this content or have permission from the copyright owner to download and convert it. Continue retry?'))return;btn.disabled=true;try{const base=getApiBase();const {data:{session}}=await sb.auth.getSession();const r=await fetch(`${base}/api/conversion/${encodeURIComponent(btn.dataset.id)}/retry`,{method:'POST',headers:{Authorization:`Bearer ${session?.access_token||''}`,'Content-Type':'application/json'},body:JSON.stringify({permissionConfirmed:true})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Retry failed.');toast('Retry queued.');await loadAccountHistory();}catch(e){toast(e.message||'Retry failed.');}finally{btn.disabled=false;}}));
 list.querySelectorAll('.history-share').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{const base=getApiBase();const headers={};if(sb){const {data:{session}}=await sb.auth.getSession();if(session?.access_token)headers.Authorization=`Bearer ${session.access_token}`;}const r=await fetch(`${base}/api/conversion/${encodeURIComponent(btn.dataset.id)}/share`,{method:'POST',headers});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not create share link.');if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(d.url);toast(`Share link copied. Expires in ${Math.round(d.expiresIn/3600)} hours.`);}else{window.prompt('Copy this share link:',d.url);}}catch(e){toast(e.message||'Could not create share link.');}finally{btn.disabled=false;}}));
}
async function loadAccountHistory(){
 const list=document.getElementById('historyList');if(!list)return;if(!sb||!authUser){list.innerHTML='<li class="empty-state">Log in to view your conversion history.</li>';return;}
 const {data,error}=await sb.from('conversions').select('id,source,source_url,format,quality,status,progress,error_message,created_at,completed_at,download_expires_at').eq('user_id',authUser.id).order('created_at',{ascending:false}).limit(100);
 if(error){list.innerHTML='<li class="empty-state">Could not load history yet.</li>';return;}
 accountHistoryRows=data||[];accountHistoryVisible=20;renderAccountHistory();
}

async function loadUsageLimits(){const card=document.getElementById('usageLimits');if(!card)return;if(!authUser){card.innerHTML='<p class="small-note">Log in to see your daily limits.</p>';return;}const base=getApiBase();if(!base){card.innerHTML='<p class="small-note">Conversion API is not configured yet.</p>';return;}try{const {data:{session}}=await sb.auth.getSession();const r=await fetch(`${base}/api/limits`,{headers:{Authorization:`Bearer ${session?.access_token||''}`}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load limits');const high=d.limits.dailyHighQuality?`${d.usage.dailyHighQuality}/${d.limits.dailyHighQuality} high-quality`:'1080p max on Free';card.innerHTML=`<div class="usage-row"><b>${escapeHtml(d.plan.toUpperCase())}</b><span>${d.usage.dailyConversions}/${d.limits.dailyConversions} conversions today</span></div><div class="usage-row"><span>${high}</span><span>${d.usage.activeJobs}/${d.limits.maxActive} active jobs</span></div><p class="small-note">Daily limits reset at 00:00 UTC. Free: 1080p max and shorter source duration; Pro: 1440p/4K with higher limits. Downloads are temporary and automatically removed.</p>`;}catch(error){card.innerHTML=`<p class="small-note">${escapeHtml(error.message||'Could not load usage limits.')}</p>`;}}
async function setupAccount(){await track('account_view');syncGlobalAuthUI();await loadAccountHistory();await loadUsageLimits();
 document.getElementById('historySearch')?.addEventListener('input',()=>{accountHistoryVisible=20;renderAccountHistory();});
 document.getElementById('historyStatus')?.addEventListener('change',()=>{accountHistoryVisible=20;renderAccountHistory();});
 document.getElementById('historyRefresh')?.addEventListener('click',async()=>{const b=document.getElementById('historyRefresh');if(b)b.disabled=true;try{await loadAccountHistory();toast('History refreshed.');}finally{if(b)b.disabled=false;}});
 document.getElementById('historyMore')?.addEventListener('click',()=>{accountHistoryVisible+=20;renderAccountHistory();});
 const email=document.getElementById('authEmail'),password=document.getElementById('authPassword'),status=document.getElementById('authStatus');
 const setStatus=m=>{if(status)status.textContent=m;};
 document.getElementById('signupBtn')?.addEventListener('click',async()=>{if(!sb)return setStatus('Supabase client is unavailable.');if(!email?.value||!password?.value)return setStatus('Enter email and password.');setStatus('Creating account…');const {error}=await sb.auth.signUp({email:email.value.trim(),password:password.value});if(error)return setStatus(error.message);setStatus('Account created. Check your email if confirmation is enabled.');});
 document.getElementById('loginBtn')?.addEventListener('click',async()=>{if(!sb)return setStatus('Supabase client is unavailable.');if(!email?.value||!password?.value)return setStatus('Enter email and password.');setStatus('Signing in…');const {error}=await sb.auth.signInWithPassword({email:email.value.trim(),password:password.value});if(error)return setStatus(error.message);await refreshAuthState();await loadAccountHistory();await loadUsageLimits();setStatus('Signed in successfully.');location.reload();});
 document.getElementById('googleBtn')?.addEventListener('click',async()=>{if(!sb)return;const redirectTo=location.origin+location.pathname;const {error}=await sb.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error)setStatus(error.message);});
 document.getElementById('logoutBtn')?.addEventListener('click',async()=>{await sb?.auth.signOut();authUser=null;profile=null;proAccess=false;location.reload();});
 document.getElementById('resetBtn')?.addEventListener('click',async()=>{if(!sb||!email?.value)return setStatus('Enter your email first.');const {error}=await sb.auth.resetPasswordForEmail(email.value.trim(),{redirectTo:location.href});setStatus(error?'Could not send reset email.': 'Password reset email sent.');});
 document.getElementById('copyReferral')?.addEventListener('click',async()=>{if(!authUser)return toast('Log in first.');const url=location.origin+location.pathname.replace(/account\.html$/,'')+'?ref='+authUser.id.slice(0,8);try{await navigator.clipboard.writeText(url);toast('Referral link copied.')}catch{toast(url)}});
 sb?.auth.onAuthStateChange(()=>setTimeout(async()=>{await refreshAuthState();await loadAccountHistory();await loadUsageLimits();},0));
}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function setupToolFilters(){const buttons=document.querySelectorAll('[data-tool-filter]'),cards=document.querySelectorAll('[data-tool-category]');if(!buttons.length||!cards.length)return;buttons.forEach(btn=>btn.addEventListener('click',()=>{buttons.forEach(b=>b.classList.remove('active'));btn.classList.add('active');const filter=btn.dataset.toolFilter;cards.forEach(card=>{card.hidden=filter!=='all'&&card.dataset.toolCategory!==filter;});}));}
async function setupAdmin(){const status=document.getElementById('adminStatus');if(!status)return;await refreshAuthState();if(!authUser){status.textContent='Login required';document.querySelectorAll('[data-admin-content]').forEach(el=>el.innerHTML='<p class="small-note">Please sign in with the admin account first.</p>');return;}if(!isAdmin()){status.textContent='Access denied';document.querySelectorAll('[data-admin-content]').forEach(el=>el.innerHTML='<p class="small-note">This account is not an administrator.</p>');return;}status.textContent='ADMIN · PRO';document.querySelectorAll('[data-admin-pro]').forEach(el=>el.textContent='Enabled');document.getElementById('backendHealthBtn')?.addEventListener('click',async()=>{const base=getApiBase();if(!base)return toast('Add your conversion API URL first.');try{const r=await fetch(`${base}/api/health`);if(!r.ok)throw new Error();toast('Backend health check passed.');}catch{toast('Backend health check failed.');}});const apiInput=document.getElementById('apiBaseInput');if(apiInput){apiInput.value=getApiBase();apiInput.addEventListener('change',()=>{setStore(STORE.api,apiInput.value.trim());window.CONVERTLY_API_BASE=apiInput.value.trim();toast('API base saved.');});}}
async function boot(){window.CONVERTLY_API_BASE=getStore(STORE.api,'');setupTheme();setupNav();setupModals();setupToolFilters();setupBrowserNotifications();setupPWA();await refreshAuthState();setupConverter();await setupAccount();await setupAdmin();}
document.addEventListener('DOMContentLoaded',boot);

function setupPWA(){
  if('serviceWorker' in navigator){
    window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{}));
  }
  const installBtn=document.getElementById('installAppBtn');
  if(!installBtn)return;
  let deferredPrompt=null;
  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();
    deferredPrompt=event;
    installBtn.hidden=false;
  });
  window.addEventListener('appinstalled',()=>{
    deferredPrompt=null;
    installBtn.hidden=true;
    toast('Convertly installed successfully.');
  });
  installBtn.addEventListener('click',async()=>{
    if(!deferredPrompt){toast('Use your browser menu to install Convertly when available.');return;}
    deferredPrompt.prompt();
    try{await deferredPrompt.userChoice;}catch{}
    deferredPrompt=null;
    installBtn.hidden=true;
  });
}


document.addEventListener('DOMContentLoaded', async () => {
  const box = document.getElementById('creditStatus');
  if (!box || !window.convertlySupabase) return;
  try {
    const { data: { session } } = await window.convertlySupabase.auth.getSession();
    if (!session) return;
    const base = (window.CONVERTLY_API_BASE || localStorage.getItem('convertly_api_base') || '').replace(/\/$/, '');
    if (!base) { box.innerHTML = '<p class="small-note">Connect the production API to view credits.</p>'; return; }
    const r = await fetch(`${base}/api/billing/status`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Could not load credits.');
    if (!d.pro) { box.innerHTML = '<p>Current balance: <b>0</b> credits</p><p class="small-note">Credits are available to active Pro accounts.</p>'; return; }
    box.innerHTML = `<p>Available: <b>${Number(d.credits?.balance || 0)}</b> credits</p><p class="small-note">Monthly allowance: ${Number(d.credits?.monthlyAllowance || 0)} · Reset: ${d.credits?.resetAt ? new Date(d.credits.resetAt).toLocaleDateString() : '—'}</p>`;
  } catch (error) { box.innerHTML = `<p class="small-note">${String(error.message || 'Could not load credits.')}</p>`; }
});
