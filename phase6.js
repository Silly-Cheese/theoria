import {db,doc,getDoc,setDoc,collection,getDocs,serverTimestamp} from "./firebase.js";
import {initProductivity} from "./modules/productivity.js";
import {initTeaching} from "./modules/teaching.js";
import {initAdmin} from "./modules/admin.js";

const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const $=s=>document.querySelector(s);

const productivity=initProductivity();
const teaching=initTeaching();
const admin=initAdmin();

async function loadFeatureFlags(){
  try{
    const snap=await getDoc(doc(db,"system","config"));
    return snap.exists()?(snap.data().features||{}):{};
  }catch(_){return {};}
}
function featureEnabled(flags,key){return flags[key]!==false;}

async function applyFeatureFlags(){
  const flags=await loadFeatureFlags();
  const map={
    planner:"planner",
    communications:"communications",
    analytics:"insights",
    courseProgression:"progression"
  };
  Object.entries(map).forEach(([flag,page])=>{
    document.querySelectorAll('[data-page="'+page+'"],#page-'+page).forEach(el=>el.classList.toggle("feature-disabled",!featureEnabled(flags,flag)));
  });
  const owner=state()?.isSystemOwner;
  document.querySelectorAll(".owner-platform-only").forEach(el=>el.classList.toggle("hidden",!owner));
  if(flags.maintenanceMode===true&&!owner){
    core()?.openModal?.({
      eyebrow:"Theoria Maintenance",
      title:"Administrative maintenance is active",
      body:'<div class="academic-banner"><div class="kicker">System Notice</div><h3>Theoria is currently in maintenance mode.</h3><p>Your existing academic data remains preserved. Some editing workflows may be temporarily unavailable while the System Owner completes maintenance.</p></div>',
      footer:'<button class="primary-btn" data-close-modal>Continue Read-Only</button>'
    });
  }
}

async function showSystemAnnouncement(){
  try{
    const snap=await getDocs(collection(db,"systemAnnouncements"));
    const now=new Date();
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>{
      const exp=x.expiresAt?.toDate?.();return !exp||exp>=now;
    }).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    const latest=rows[0];if(!latest)return;
    const key="theoria-system-announcement:"+latest.id;
    if(sessionStorage.getItem(key))return;
    sessionStorage.setItem(key,"1");
    const home=document.querySelector("#page-home .page-head");
    if(home)home.insertAdjacentHTML("afterend",'<div class="system-announcement-banner"><div><span>'+String(latest.severity||"Information")+'</span><strong>'+String(latest.title||"Theoria Notice").replace(/[<>]/g,"")+'</strong><p>'+String(latest.body||"").replace(/[<>]/g,"")+'</p></div><button class="text-btn" data-phase6-action="dismiss-system-banner">Dismiss</button></div>');
  }catch(_){}
}

async function runAcademicWorkflowChecks(){
  const s=state();if(!s?.user||s.role!=="instructor")return;
  const uid=s.user.uid;
  const today=new Date();today.setHours(0,0,0,0);
  for(const section of (s.sections||[]).filter(x=>x.ownerId===uid&&x.status!=="Archived")){
    const end=section.endDate?new Date(section.endDate+"T23:59:59"):null;
    if(end&&end<today){
      try{
        const id="workflow_section_end_"+section.id;
        const ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        if(!existing.exists())await setDoc(ref,{type:"workflow",title:"Section term has ended",body:(section.courseCode||"Course")+" • "+(section.sectionName||section.courseTitle)+" is past its end date. Review records, then archive or roll it over.",sectionId:section.id,targetPage:"sections",read:false,createdAt:serverTimestamp()});
      }catch(_){}
    }
    try{
      const appeals=await getDocs(collection(db,"sections",section.id,"appeals"));
      const open=appeals.docs.filter(d=>["Pending","Under Review"].includes(d.data().status));
      if(open.length){
        const id="workflow_appeals_"+section.id;
        const ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        if(!existing.exists())await setDoc(ref,{type:"workflow",title:"Grade appeals need attention",body:open.length+" unresolved appeal"+(open.length===1?"":"s")+" in "+(section.sectionName||section.courseTitle)+".",sectionId:section.id,targetPage:"reports",read:false,createdAt:serverTimestamp()});
      }
    }catch(_){}
  }
  productivity.updateNotificationBadge?.();
}

function addPlatformControls(){
  const top=document.querySelector(".top-actions");if(!top)return;
  if(!document.querySelector("#commandPaletteBtn"))top.insertAdjacentHTML("afterbegin",'<button id="commandPaletteBtn" class="icon-action-btn" data-productivity-action="open-command" title="Search Theoria (Ctrl/Cmd + K)">⌘K</button>');
  if(!document.querySelector("#accessibilityBtn"))top.insertAdjacentHTML("afterbegin",'<button id="accessibilityBtn" class="icon-action-btn" data-productivity-action="accessibility" title="Accessibility">Aa</button>');
  if(!document.querySelector("#notificationBtn"))top.insertAdjacentHTML("afterbegin",'<button id="notificationBtn" class="notification-btn" data-page-shortcut="communications" title="Notifications">◔<span id="notificationBadge" class="notification-badge hidden">0</span></button>');
}

function enhanceCurrentContext(){
  const s=state();
  if(s?.role==="instructor"&&s.currentSection){
    const hero=document.querySelector("#sectionDetail .detail-top .inline-actions");
    if(hero&&!hero.querySelector('[data-teaching-action="section-tools"]'))hero.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-teaching-action="section-tools" data-section="'+s.currentSection.id+'">Teaching Tools</button>');
    if(hero&&s.currentSection.ownerId===s.user.uid&&!hero.querySelector('[data-admin-action="rollover-section"]'))hero.insertAdjacentHTML("beforeend",'<button class="text-btn" data-admin-action="rollover-section" data-section="'+s.currentSection.id+'">Rollover</button>');
  }
  if(s?.isSystemOwner&&s.currentCourse){
    const actions=document.querySelector("#courseDetail .detail-top .inline-actions,#courseDetail .detail-hero .inline-actions");
    if(actions&&!actions.querySelector('[data-admin-action="version-course"]'))actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-admin-action="version-course" data-course="'+s.currentCourse.id+'">New Version</button>');
  }
  const p3=window.TheoriaPhase3,current=p3?.getCurrent?.();
  if(current&&document.querySelector("#page-assessment-detail.active")){
    const actions=document.querySelector("#assessmentDetail .detail-top .inline-actions");
    if(actions&&!actions.querySelector('[data-teaching-action="assessment-security"]'))actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-teaching-action="assessment-security" data-id="'+current.id+'">Security</button><button class="secondary-btn small-btn" data-teaching-action="blueprint-designer" data-id="'+current.id+'">Blueprint</button>');
  }
}

document.addEventListener("click",e=>{
  const shortcut=e.target.closest("[data-page-shortcut]");if(shortcut)core()?.setPage?.(shortcut.dataset.pageShortcut);
  const b=e.target.closest("[data-phase6-action]");if(!b)return;
  if(b.dataset.phase6Action==="dismiss-system-banner")b.closest(".system-announcement-banner")?.remove();
});

window.addEventListener("theoria:ready",async()=>{
  addPlatformControls();
  await applyFeatureFlags();
  await showSystemAnnouncement();
  await productivity.synthesizeNotifications?.();
  await runAcademicWorkflowChecks();
  setTimeout(enhanceCurrentContext,100);
});

window.addEventListener("theoria:page",()=>setTimeout(enhanceCurrentContext,60));

window.TheoriaPhase6={
  productivity,teaching,admin,
  applyFeatureFlags,
  runAcademicWorkflowChecks,
  preflightSecurity:(assessment)=>teaching.preflightSecurity(assessment),
  openRubricGrade:(assignment,student,existing)=>teaching.openRubricGrade(assignment,student,existing),
  saveExamDraft:(assessmentId,payload)=>productivity.saveExamDraft(assessmentId,payload),
  loadExamDraft:(assessmentId)=>productivity.loadExamDraft(assessmentId),
  clearExamDraft:(assessmentId)=>productivity.clearExamDraft(assessmentId),
  examDraftHistory:(assessmentId)=>productivity.examDraftHistory(assessmentId)
};
