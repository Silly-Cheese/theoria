const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();

const DRAFT_PREFIX="theoria-form-draft:v2:";
const ERROR_KEY="theoria-client-errors:v2";
const CONNECTIVITY_KEY="theoria-connectivity-events:v2";
let saveTimer=null;

function userKey(){return state()?.user?.uid||"anonymous";}
function currentPage(){return document.querySelector(".page.active")?.id?.replace(/^page-/,"")||"unknown";}
function draftKey(form){
  const id=form?.id||form?.getAttribute?.("data-draft-key");
  return id?DRAFT_PREFIX+userKey()+":"+currentPage()+":"+id:null;
}
function safeField(el){
  if(!el?.name)return false;
  if(["password","file","hidden","submit","button"].includes(String(el.type||"").toLowerCase()))return false;
  if(el.closest("#signInForm,#registerForm"))return false;
  if(el.hasAttribute("data-no-autosave"))return false;
  return ["INPUT","TEXTAREA","SELECT"].includes(el.tagName);
}
function serializeForm(form){
  const values={};
  form.querySelectorAll("input[name],textarea[name],select[name]").forEach(el=>{
    if(!safeField(el))return;
    if(el.type==="checkbox")values[el.name]={type:"checkbox",value:el.checked};
    else if(el.type==="radio"){
      if(el.checked)values[el.name]={type:"radio",value:el.value};
    }else values[el.name]={type:"value",value:el.value};
  });
  return {page:currentPage(),formId:form.id||"",values,savedAt:Date.now(),title:form.querySelector("[name=title]")?.value||document.querySelector(".page.active .page-title")?.textContent||"Draft"};
}
function saveForm(form){
  const key=draftKey(form);if(!key)return;
  try{localStorage.setItem(key,JSON.stringify(serializeForm(form)));}catch(_){}
}
function restoreForm(form,draft){
  if(!form||!draft?.values)return;
  Object.entries(draft.values).forEach(([name,entry])=>{
    const fields=[...form.querySelectorAll('[name="'+CSS.escape(name)+'"]')];
    if(!fields.length)return;
    if(entry.type==="checkbox")fields[0].checked=!!entry.value;
    else if(entry.type==="radio"){
      const radio=fields.find(x=>x.value===entry.value);if(radio)radio.checked=true;
    }else{
      fields[0].value=entry.value??"";
      fields[0].dispatchEvent(new Event("input",{bubbles:true}));
      fields[0].dispatchEvent(new Event("change",{bubbles:true}));
    }
  });
}
function listDrafts(){
  const rows=[];
  try{
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(!key?.startsWith(DRAFT_PREFIX+userKey()+":"))continue;
      try{rows.push({key,...JSON.parse(localStorage.getItem(key)||"{}")});}catch(_){}
    }
  }catch(_){}
  return rows.sort((a,b)=>Number(b.savedAt||0)-Number(a.savedAt||0));
}
function deleteDraft(key){try{localStorage.removeItem(key);}catch(_){}}

function recoveryCenter(){
  const drafts=listDrafts(),errors=errorRows(),events=connectivityRows();
  const m=modal({
    eyebrow:"Recovery & Diagnostics",
    title:"Local Resilience Center",
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">Connectivity Protection</div><h3>'+(navigator.onLine?"Online":"Offline")+'</h3><p>Theoria keeps local recovery snapshots for editable forms and assessment responses so a temporary connection problem does not have to erase work.</p></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Recoverable Form Drafts</h3><p>Local-only snapshots stored on this device.</p></div></div>'+
      (drafts.length?'<div class="recovery-list">'+drafts.map((d,i)=>'<div class="recovery-row"><div><strong>'+escapeHtml(d.title||d.formId||"Draft")+'</strong><span>'+escapeHtml(d.page||"")+' • '+new Date(d.savedAt||0).toLocaleString()+'</span></div><div class="inline-actions"><button class="secondary-btn small-btn" data-resilience-action="restore-draft" data-index="'+i+'">Restore</button><button class="text-btn danger-text" data-resilience-action="delete-draft" data-index="'+i+'">Delete</button></div></div>').join("")+'</div>':'<div class="empty-mini">No recoverable form drafts on this device.</div>')+'</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Client Diagnostics</h3><p>Recent browser-side errors and connectivity transitions. This stays on this device unless you choose to export it.</p></div></div><div class="detail-list"><div><span>Recent Errors</span><strong>'+errors.length+'</strong></div><div><span>Connectivity Events</span><strong>'+events.length+'</strong></div></div><button class="secondary-btn small-btn" style="margin-top:12px" data-resilience-action="export-diagnostics">Export Diagnostics</button></section>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
  m._resilienceDrafts=drafts;
}

function escapeHtml(v){
  return String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function errorRows(){try{return JSON.parse(localStorage.getItem(ERROR_KEY)||"[]");}catch{return [];}}
function connectivityRows(){try{return JSON.parse(localStorage.getItem(CONNECTIVITY_KEY)||"[]");}catch{return [];}}
function pushLocal(key,row,limit=30){
  try{
    const rows=JSON.parse(localStorage.getItem(key)||"[]");rows.push(row);
    localStorage.setItem(key,JSON.stringify(rows.slice(-limit)));
  }catch(_){}
}
function recordError(kind,error){
  pushLocal(ERROR_KEY,{kind,message:String(error?.message||error||"Unknown error"),stack:String(error?.stack||"").slice(0,3000),page:currentPage(),at:Date.now()},30);
}
function recordConnectivity(status){
  pushLocal(CONNECTIVITY_KEY,{status,page:currentPage(),at:Date.now()},30);
}
function connectivityBanner(){
  let el=$("#theoriaConnectivityBanner");
  if(!el){
    document.body.insertAdjacentHTML("beforeend",'<div id="theoriaConnectivityBanner" class="connectivity-banner hidden" role="status"></div>');
    el=$("#theoriaConnectivityBanner");
  }
  if(navigator.onLine){
    el.textContent="Connection restored. Local drafts remain available until your changes are saved.";
    el.classList.remove("offline","hidden");el.classList.add("online");
    setTimeout(()=>el.classList.add("hidden"),3500);
  }else{
    el.textContent="You are offline. Theoria will keep local recovery drafts on this device.";
    el.classList.remove("online","hidden");el.classList.add("offline");
  }
}
function installConnectivity(){
  window.addEventListener("offline",()=>{recordConnectivity("offline");connectivityBanner();});
  window.addEventListener("online",()=>{recordConnectivity("online");connectivityBanner();});
  window.addEventListener("error",e=>recordError("error",e.error||e.message));
  window.addEventListener("unhandledrejection",e=>recordError("unhandledrejection",e.reason));
}
function installFormAutosave(){
  document.addEventListener("input",e=>{
    const el=e.target;if(!safeField(el))return;
    const form=el.closest("form");if(!form||!draftKey(form))return;
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveForm(form),500);
  },true);
}
function addStatusButton(){
  const top=document.querySelector(".top-actions");if(!top||$("#resilienceStatusBtn"))return;
  top.insertAdjacentHTML("afterbegin",'<button id="resilienceStatusBtn" class="icon-action-btn" data-resilience-action="recovery-center" title="Recovery & connection status">↻</button>');
}
function tryRestoreDraft(draft){
  const page=draft.page||"";
  if(page&&core()?.setPage)core().setPage(page);
  setTimeout(()=>{
    const form=draft.formId?document.getElementById(draft.formId):null;
    if(!form){toast("Open the matching editor first, then choose Restore again.");return;}
    restoreForm(form,draft);toast("Local draft restored into the open form.");
  },120);
}
function exportDiagnostics(){
  const data={generatedAt:new Date().toISOString(),online:navigator.onLine,userAgent:navigator.userAgent,page:currentPage(),errors:errorRows(),connectivity:connectivityRows(),draftCount:listDrafts().length};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="theoria-client-diagnostics.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function bindActions(){
  document.addEventListener("click",e=>{
    const b=e.target.closest("[data-resilience-action]");if(!b)return;
    const action=b.dataset.resilienceAction;
    if(action==="recovery-center")return recoveryCenter();
    if(action==="export-diagnostics")return exportDiagnostics();
    if(action==="restore-draft"){
      const root=b.closest(".modal-card,.modal-panel,.modal-content")||document;
      const drafts=listDrafts(),draft=drafts[Number(b.dataset.index)];if(!draft)return;
      closeModal();return tryRestoreDraft(draft);
    }
    if(action==="delete-draft"){
      const draft=listDrafts()[Number(b.dataset.index)];if(draft)deleteDraft(draft.key);
      closeModal();return recoveryCenter();
    }
  });
}
export function initResilience(){
  installConnectivity();installFormAutosave();bindActions();addStatusButton();
  window.addEventListener("theoria:ready",()=>{addStatusButton();if(!navigator.onLine)connectivityBanner();});
  return {saveForm,listDrafts,recoveryCenter,recordError};
}
