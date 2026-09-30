import {
  db, doc, getDoc, setDoc, updateDoc, collection, getDocs, addDoc, serverTimestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();

const STORAGE_PREFIX="theoria:";
let platformSettings={},securityListenersInstalled=false;

function currentPage(){return document.querySelector(".page.active")?.id?.replace("page-","")||"unknown";}
function autosaveKey(el){
  const form=el.closest("form"),name=el.name||el.id;if(!name)return null;
  const context=state()?.currentSection?.id||state()?.currentCourse?.id||window.TheoriaPhase3?.getCurrent?.()?.id||"global";
  return STORAGE_PREFIX+"draft:"+currentPage()+":"+context+":"+(form?.id||"form")+":"+name;
}

function storeDraft(el){
  const key=autosaveKey(el);if(!key)return;
  try{
    const current=JSON.parse(localStorage.getItem(key)||"[]"),value=el.type==="checkbox"?el.checked:el.value;
    const last=current[0];
    if(last&&JSON.stringify(last.value)===JSON.stringify(value))return;
    current.unshift({value,at:new Date().toISOString(),label:el.getAttribute("aria-label")||el.closest(".field")?.querySelector("label")?.textContent||el.name||el.id});
    localStorage.setItem(key,JSON.stringify(current.slice(0,5)));
  }catch(_){}
}

let draftTimer=null;
document.addEventListener("input",e=>{
  const el=e.target;if(!(el.matches("textarea")||el.matches('input[type="text"]')||el.matches('input[type="url"]')))return;
  clearTimeout(draftTimer);draftTimer=setTimeout(()=>storeDraft(el),350);
},true);

function recoveryEntries(){
  const rows=[];
  try{
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);if(!key?.startsWith(STORAGE_PREFIX+"draft:"))continue;
      const history=JSON.parse(localStorage.getItem(key)||"[]");if(history.length)rows.push({key,...history[0],history});
    }
  }catch(_){}
  return rows.sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,30);
}

function draftRecoveryModal(){
  const rows=recoveryEntries();
  modal({
    eyebrow:"Autosave Recovery",
    title:"Local Draft History",
    wide:true,
    body:rows.length?'<div class="draft-recovery-list">'+rows.map((r,i)=>'<article class="draft-recovery-row"><div><span>'+esc(new Date(r.at).toLocaleString())+'</span><strong>'+esc(r.label||"Saved draft")+'</strong><p>'+esc(String(r.value||"").slice(0,240))+'</p></div><button class="secondary-btn small-btn" data-platform-action="copy-draft" data-index="'+i+'">Copy</button></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">D</div><h3>No local drafts.</h3><p>Long text responses and authoring fields will create local recovery snapshots while you type.</p></div>',
    footer:'<button class="secondary-btn" data-platform-action="clear-drafts">Clear Local Drafts</button><button class="primary-btn" data-close-modal>Close</button>'
  });
  window.__theoriaRecoveryRows=rows;
}

function applyAccessibility(){
  const settings=JSON.parse(localStorage.getItem(STORAGE_PREFIX+"accessibility")||"{}");
  const root=document.documentElement;
  root.classList.toggle("a11y-high-contrast",!!settings.highContrast);
  root.classList.toggle("a11y-reduced-motion",!!settings.reducedMotion);
  root.classList.toggle("a11y-compact",settings.density==="compact");
  root.style.setProperty("--user-font-scale",String(settings.fontScale||1));
  document.body.style.fontSize="calc(1em * var(--user-font-scale))";
}

function accessibilityModal(){
  const current=JSON.parse(localStorage.getItem(STORAGE_PREFIX+"accessibility")||"{}");
  const m=modal({
    eyebrow:"Accessibility",
    title:"Display & Interaction Preferences",
    body:'<form id="accessibilityForm"><div class="field"><label>Text Scale</label><select name="fontScale"><option value="1">Standard</option><option value="1.1">110%</option><option value="1.2">120%</option><option value="1.35">135%</option></select></div><div class="field"><label>Interface Density</label><select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div><label class="policy-card"><input type="checkbox" name="highContrast" '+(current.highContrast?'checked':'')+'><div><strong>High contrast</strong><span>Increase borders and text contrast throughout Theoria.</span></div></label><label class="policy-card"><input type="checkbox" name="reducedMotion" '+(current.reducedMotion?'checked':'')+'><div><strong>Reduced motion</strong><span>Disable nonessential transitions and animations.</span></div></label><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn">Apply Preferences</button></div></form>'
  });
  const form=m.querySelector("#accessibilityForm");form.elements.fontScale.value=String(current.fontScale||1);form.elements.density.value=current.density||"comfortable";
  form.onsubmit=e=>{e.preventDefault();const fd=new FormData(form),settings={fontScale:Number(fd.get("fontScale")||1),density:String(fd.get("density")),highContrast:form.elements.highContrast.checked,reducedMotion:form.elements.reducedMotion.checked};localStorage.setItem(STORAGE_PREFIX+"accessibility",JSON.stringify(settings));applyAccessibility();closeModal();toast("Accessibility preferences applied.");};
}

function installConnectivity(){
  if($("#connectivityBanner"))return;
  document.body.insertAdjacentHTML("afterbegin",'<div id="connectivityBanner" class="connectivity-banner hidden"><strong>Offline</strong><span>Theoria will keep local draft snapshots, but Firebase changes cannot sync until your connection returns.</span></div>');
  const update=()=>$("#connectivityBanner")?.classList.toggle("hidden",navigator.onLine);
  window.addEventListener("online",()=>{update();toast("Connection restored.");});
  window.addEventListener("offline",update);update();
}

function installUtilityButtons(){
  const actions=document.querySelector(".top-actions");if(!actions)return;
  if(!$("#commandPaletteBtn"))actions.insertAdjacentHTML("afterbegin",'<button id="commandPaletteBtn" class="icon-action-btn" title="Search Theoria (Ctrl/Cmd + K)" aria-label="Search">⌕</button>');
  if(!$("#accessibilityBtn"))actions.insertAdjacentHTML("afterbegin",'<button id="accessibilityBtn" class="icon-action-btn" title="Accessibility" aria-label="Accessibility">A</button>');
  $("#commandPaletteBtn").onclick=commandPalette;
  $("#accessibilityBtn").onclick=accessibilityModal;
}

async function commandItems(){
  const s=state(),items=[];
  (s?.courses||[]).forEach(c=>items.push({type:"Course",title:(c.code||"")+" — "+(c.title||"Course"),subtitle:c.discipline||"",action:"course",id:c.id,keywords:[c.code,c.title,c.discipline]}));
  (s?.sections||[]).forEach(sec=>items.push({type:"Section",title:(sec.courseCode||"")+" — "+(sec.sectionName||sec.courseTitle||"Section"),subtitle:sec.term||"",action:"section",id:sec.id,keywords:[sec.courseCode,sec.sectionName,sec.courseTitle,sec.term]}));
  (s?.sectionData?.members||[]).forEach(m=>items.push({type:"Student",title:m.displayName||"Student",subtitle:m.email||"",action:"student",id:m.id,keywords:[m.displayName,m.email]}));
  if(s?.role==="instructor"){
    for(const course of (s.courses||[]).slice(0,20)){
      try{
        const q=await getDocs(collection(db,"courses",course.id,"items"));
        q.docs.slice(0,80).forEach(d=>{const x=d.data();items.push({type:"Question",title:(x.prompt||"Question").slice(0,110),subtitle:(course.code||"")+" • "+(x.topicNumber||"No topic"),action:"question",id:d.id,courseId:course.id,keywords:[x.prompt,x.topicNumber,...(x.competencyCodes||[]),...(x.tags||[])]});});
      }catch(_){}
    }
  }
  const pages=[
    ["planner","Planner"],["insights","Insights"],["mastery","Mastery"],["progression","Progression"],["reports","Reports"],["academic-profile","Academic Profile"],["library","Library"]
  ];
  if(s?.role==="instructor")pages.push(["teaching-tools","Teaching Tools"]);
  if(s?.isSystemOwner)pages.push(["admin-center","System Owner"]);
  pages.forEach(([id,title])=>items.push({type:"Page",title,subtitle:"Open workspace",action:"page",id,keywords:[title]}));
  return items;
}

async function commandPalette(){
  const m=modal({eyebrow:"Universal Search",title:"Search Theoria",wide:true,body:'<div class="command-search"><input id="commandSearchInput" type="search" placeholder="Search courses, sections, students, questions, or pages…" autocomplete="off"></div><div id="commandResults"><div class="empty-mini">Loading searchable academic content…</div></div>'});
  const items=await commandItems(),input=m.querySelector("#commandSearchInput"),box=m.querySelector("#commandResults");
  const draw=()=>{
    const q=input.value.trim().toLowerCase(),rows=(q?items.filter(item=>[item.title,item.subtitle,...(item.keywords||[])].join(" ").toLowerCase().includes(q)):items.filter(x=>x.type==="Page")).slice(0,30);
    box.innerHTML=rows.length?'<div class="command-results">'+rows.map((r,i)=>'<button class="command-result" data-platform-action="command-go" data-index="'+i+'"><span>'+esc(r.type)+'</span><div><strong>'+esc(r.title)+'</strong><small>'+esc(r.subtitle||"")+'</small></div></button>').join("")+'</div>':'<div class="empty-mini">No matching Theoria content.</div>';
    window.__theoriaCommandRows=rows;
  };
  input.oninput=draw;draw();setTimeout(()=>input.focus(),50);
}

function goCommand(index){
  const row=window.__theoriaCommandRows?.[Number(index)];if(!row)return;closeModal();
  if(row.action==="page")return core().setPage(row.id);
  if(row.action==="course")return core().openCourse?.(row.id);
  if(row.action==="section")return core().openSection(row.id);
  if(row.action==="student")return window.TheoriaAcademicTools?.studentProfileModal?.(row.id);
  if(row.action==="question"){core().setPage("itembank");toast("Question found in "+row.subtitle+". Use Question Bank search to open it.");}
}

function recordClientError(kind,error){
  try{
    const rows=JSON.parse(sessionStorage.getItem(STORAGE_PREFIX+"errors")||"[]");
    rows.unshift({kind,message:String(error?.message||error||"Unknown error"),stack:String(error?.stack||"").slice(0,1500),page:currentPage(),at:new Date().toISOString()});
    sessionStorage.setItem(STORAGE_PREFIX+"errors",JSON.stringify(rows.slice(0,30)));
  }catch(_){}
}
window.addEventListener("error",e=>recordClientError("error",e.error||e.message));
window.addEventListener("unhandledrejection",e=>recordClientError("promise",e.reason));

function clientDiagnosticsModal(){
  const rows=JSON.parse(sessionStorage.getItem(STORAGE_PREFIX+"errors")||"[]");
  modal({eyebrow:"Client Diagnostics",title:"Recent Browser Errors",wide:true,body:rows.length?'<div class="diagnostic-error-list">'+rows.map(r=>'<article><span>'+esc(r.kind)+' • '+esc(r.page)+' • '+esc(new Date(r.at).toLocaleTimeString())+'</span><strong>'+esc(r.message)+'</strong><pre>'+esc(r.stack||"")+'</pre></article>').join("")+'</div>':'<div class="notice"><strong>No client errors recorded this session.</strong><p>Theoria has not captured a browser exception or unhandled promise rejection.</p></div>'});
}

async function loadPlatformState(){
  try{
    const [settings,announcement]=await Promise.all([getDoc(doc(db,"system","platform")),getDoc(doc(db,"system","announcement"))]);
    platformSettings=settings.exists()?settings.data():{};
    applyFeatureFlags();
    if(announcement.exists()&&announcement.data().active!==false)showSystemAnnouncement(announcement.data());
    if(platformSettings.maintenanceMode&&!state()?.isSystemOwner)showMaintenance();
  }catch(_){}
}

function applyFeatureFlags(){
  const flags=platformSettings.featureFlags||{};
  const map={planner:"planner",rubrics:"teaching-tools",dataIntegrity:"admin-center"};
  Object.entries(map).forEach(([flag,page])=>{
    if(flags[flag]===false)document.querySelectorAll('[data-page="'+page+'"]').forEach(el=>el.classList.add("hidden"));
  });
}

function showSystemAnnouncement(a){
  if($("#systemAnnouncementBanner"))return;
  const top=document.querySelector(".topbar");if(!top)return;
  top.insertAdjacentHTML("afterend",'<div id="systemAnnouncementBanner" class="system-announcement '+(a.critical?'critical':'')+'"><div><strong>'+esc(a.title||"Theoria Notice")+'</strong><span>'+esc(a.body||"")+'</span></div><button class="text-btn" data-platform-action="dismiss-system-announcement">Dismiss</button></div>');
}

function showMaintenance(){
  if($("#maintenanceOverlay"))return;
  document.body.insertAdjacentHTML("beforeend",'<div id="maintenanceOverlay" class="maintenance-overlay"><div class="maintenance-card"><div class="brand-mark">Θ</div><div class="eyebrow">Theoria Maintenance</div><h2>Academic platform maintenance is in progress.</h2><p>Your account remains intact. Try again after the System Owner completes the maintenance window.</p><button class="secondary-btn" onclick="location.reload()">Retry</button></div></div>');
}

/* -------------------- ASSESSMENT SECURITY -------------------- */

async function renderAssessmentSecurity(detail){
  const root=$("#phase6AssessmentSecurity");if(!root||!detail)return;
  const a=detail.assessment,p=a.securityPolicy||{};
  root.innerHTML='<div class="academic-banner"><div class="kicker">Assessment Security Center</div><h3>Attempt controls and assessment-event expectations.</h3><p>Security settings support instructor review. Browser event signals are evidence for review, not automatic proof of misconduct.</p></div>'+
    '<form id="assessmentSecurityForm" class="academic-form"><div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Attempt Access</div></div><div class="panel-body"><div class="field"><label>Optional Access Code</label><input name="accessCode" value="'+esc(p.accessCode||"")+'" autocomplete="off"></div><div class="field"><label>Maximum Attempts</label><input name="maxAttempts" type="number" min="1" max="10" value="'+esc(p.maxAttempts||1)+'"></div><div class="field"><label>Late Entry</label><select name="lateEntryPolicy"><option value="allow">Allow while assessment remains open</option><option value="deny-after-start">Deny after scheduled open time + grace period</option></select></div><div class="field"><label>Late-entry Grace Period</label><div class="input-with-suffix"><input name="lateEntryGraceMinutes" type="number" min="0" value="'+esc(p.lateEntryGraceMinutes||0)+'"><span>min</span></div></div></div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Session Expectations</div></div><div class="panel-body"><label class="policy-card"><input type="checkbox" name="fullscreenExpectation" '+(p.fullscreenExpectation?'checked':'')+'><div><strong>Fullscreen expectation</strong><span>Prompt students to use fullscreen during the attempt.</span></div></label><label class="policy-card"><input type="checkbox" name="blockCopyPaste" '+(p.blockCopyPaste?'checked':'')+'><div><strong>Block copy / paste</strong><span>Prevent clipboard actions inside the active exam interface.</span></div></label><label class="policy-card"><input type="checkbox" name="logFocusEvents" '+(p.logFocusEvents!==false?'checked':'')+'><div><strong>Log focus changes</strong><span>Record visibility/focus events for instructor review.</span></div></label><label class="policy-card"><input type="checkbox" name="honorAcknowledgement" '+(p.honorAcknowledgement?'checked':'')+'><div><strong>Honor acknowledgement</strong><span>Add an explicit academic-integrity acknowledgement to preflight.</span></div></label></div></div></div>'+
    '<div class="modal-foot static-form-foot"><button class="primary-btn" type="submit">Save Security Policy</button></div></form>';
  const form=$("#assessmentSecurityForm");form.elements.lateEntryPolicy.value=p.lateEntryPolicy||"allow";
  form.onsubmit=async e=>{e.preventDefault();const fd=new FormData(form),securityPolicy={accessCode:String(fd.get("accessCode")||"").trim(),maxAttempts:Math.max(1,Number(fd.get("maxAttempts")||1)),lateEntryPolicy:String(fd.get("lateEntryPolicy")),lateEntryGraceMinutes:Math.max(0,Number(fd.get("lateEntryGraceMinutes")||0)),fullscreenExpectation:form.elements.fullscreenExpectation.checked,blockCopyPaste:form.elements.blockCopyPaste.checked,logFocusEvents:form.elements.logFocusEvents.checked,honorAcknowledgement:form.elements.honorAcknowledgement.checked,updatedAt:serverTimestamp()};try{await updateDoc(doc(db,"assessments",a.id),{securityPolicy,updatedAt:serverTimestamp()});a.securityPolicy=securityPolicy;toast("Assessment security policy saved.");}catch(error){toast(error.message||"Unable to save assessment security policy.");}};
}

function renderBlueprintDesigner(detail){
  const root=$("#phase6BlueprintDesigner");if(!root||!detail)return;
  const a=detail.assessment,questions=detail.questions||[];
  const byUnit=new Map(),byType=new Map(),byCog=new Map(),byComp=new Map();
  let total=0;
  questions.forEach(q=>{
    const pts=Number(q.points||0);total+=pts;
    const unit=(q.unitNumber?"Unit "+q.unitNumber+" — ":"")+(q.unitTitle||"Unmapped Unit");byUnit.set(unit,(byUnit.get(unit)||0)+pts);
    byType.set(q.type||"Question",(byType.get(q.type||"Question")||0)+pts);
    (q.competencyCodes||[]).forEach(c=>byComp.set(c,(byComp.get(c)||0)+pts/Math.max(1,(q.competencyCodes||[]).length)));
  });
  const bank=window.TheoriaPhase3?.getDetail?.()?.questions||[];
  bank.forEach(q=>{if(q.cognitiveLevel)byCog.set(q.cognitiveLevel,(byCog.get(q.cognitiveLevel)||0)+Number(q.points||0));});
  const bars=map=>[...map.entries()].sort((a,b)=>b[1]-a[1]).map(([label,pts])=>'<div class="blueprint-visual-row"><span>'+esc(label)+'</span><div><i style="width:'+(total?Math.min(100,pts/total*100):0)+'%"></i></div><strong>'+(total?Math.round(pts/total*1000)/10:0)+'%</strong></div>').join("");
  const targetMap=new Map((a.contentBlueprint||[]).map(x=>[x.id,Number(x.weight||0)]));
  const coverageWarnings=[];
  byUnit.forEach((pts,label)=>{const actual=total?pts/total*100:0;const unit=questions.find(q=>((q.unitNumber?"Unit "+q.unitNumber+" — ":"")+(q.unitTitle||"Unmapped Unit"))===label);const target=targetMap.get(unit?.unitId);if(target!==undefined&&Math.abs(actual-target)>=10)coverageWarnings.push(label+" is "+Math.round(actual*10)/10+"% vs "+target+"% target.");});
  root.innerHTML='<div class="academic-banner"><div class="kicker">Assessment Blueprint Designer</div><h3>See what this assessment actually measures.</h3><p>Question points are converted into content, type, and competency coverage so unintended imbalances are visible before publication.</p></div>'+
    (coverageWarnings.length?'<div class="notice danger-notice"><strong>Coverage mismatches detected.</strong><p>'+esc(coverageWarnings.join(" • "))+'</p></div>':'<div class="notice"><strong>Coverage review complete.</strong><p>No unit with an explicit content target differs by 10 percentage points or more.</p></div>')+
    '<div class="grid-2 blueprint-designer-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Unit Coverage</div></div><div class="panel-body">'+(bars(byUnit)||'<div class="empty-mini">No unit mappings.</div>')+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Question-Type Coverage</div></div><div class="panel-body">'+(bars(byType)||'<div class="empty-mini">No questions.</div>')+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Competency Coverage</div></div><div class="panel-body">'+(bars(byComp)||'<div class="empty-mini">No competency mappings.</div>')+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Cognitive-Level Coverage</div></div><div class="panel-body">'+(bars(byCog)||'<div class="empty-mini">Cognitive levels are not available on assessment snapshots.</div>')+'</div></div></div>';
}

function examSecurityPolicy(){return window.TheoriaPhase3?.getExam?.()?.assessment?.securityPolicy||{};}
async function securityEvent(type,details={}){
  const exam=window.TheoriaPhase3?.getExam?.();if(!exam||exam.assessment.securityPolicy?.logFocusEvents===false)return;
  try{await addDoc(collection(db,"assessments",exam.assessment.id,"submissions",state().user.uid,"events"),{studentId:state().user.uid,type,details,at:serverTimestamp()});}catch(_){}
}

function installExamSecurityListeners(){
  if(securityListenersInstalled)return;securityListenersInstalled=true;
  document.addEventListener("copy",e=>{if(window.TheoriaPhase3?.getExam?.()&&examSecurityPolicy().blockCopyPaste){e.preventDefault();securityEvent("copy_blocked");toast("Copy is disabled for this assessment.");}},true);
  document.addEventListener("paste",e=>{if(window.TheoriaPhase3?.getExam?.()&&examSecurityPolicy().blockCopyPaste){e.preventDefault();securityEvent("paste_blocked");toast("Paste is disabled for this assessment.");}},true);
  window.addEventListener("blur",()=>{if(window.TheoriaPhase3?.getExam?.())securityEvent("window_blur");});
  window.addEventListener("focus",()=>{if(window.TheoriaPhase3?.getExam?.())securityEvent("window_focus");});
  document.addEventListener("fullscreenchange",()=>{if(window.TheoriaPhase3?.getExam?.())securityEvent(document.fullscreenElement?"fullscreen_enter":"fullscreen_exit");});
}

async function requestFullscreenIfExpected(){
  const exam=window.TheoriaPhase3?.getExam?.(),p=exam?.assessment?.securityPolicy||{};if(!exam||!p.fullscreenExpectation)return;
  try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();}catch(_){}
}

/* -------------------- PLATFORM BOOT -------------------- */

document.addEventListener("keydown",e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();commandPalette();}
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==="r"){e.preventDefault();draftRecoveryModal();}
});

window.addEventListener("theoria:ready",()=>{applyAccessibility();installConnectivity();installUtilityButtons();installExamSecurityListeners();loadPlatformState();});
window.addEventListener("theoria:page",e=>{if(e.detail.page==="exam")setTimeout(requestFullscreenIfExpected,250);});

document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-platform-action]");if(!b)return;
  const a=b.dataset.platformAction;
  if(a==="command-go")return goCommand(b.dataset.index);
  if(a==="copy-draft"){const row=window.__theoriaRecoveryRows?.[Number(b.dataset.index)];if(row){await navigator.clipboard.writeText(String(row.value||""));toast("Draft copied.");}return;}
  if(a==="clear-drafts"){for(const key of Object.keys(localStorage)){if(key.startsWith(STORAGE_PREFIX+"draft:"))localStorage.removeItem(key);}closeModal();toast("Local draft history cleared.");return;}
  if(a==="dismiss-system-announcement"){b.closest(".system-announcement")?.remove();return;}
  if(a==="client-diagnostics")return clientDiagnosticsModal();
});

window.TheoriaPlatform={
  renderAssessmentSecurity,
  renderBlueprintDesigner,
  requestFullscreenIfExpected,
  securityEvent,
  commandPalette,
  accessibilityModal,
  draftRecoveryModal,
  clientDiagnosticsModal,
  getSettings:()=>platformSettings
};

applyAccessibility();installConnectivity();installUtilityButtons();installExamSecurityListeners();
if(window.TheoriaCore)loadPlatformState();
