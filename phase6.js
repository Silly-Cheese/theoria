import {db,doc,getDoc,setDoc,collection,getDocs,query,where,serverTimestamp} from "./firebase.js";
import {initProductivity} from "./modules/productivity.js?v=20260930-securityenforced2";
import {initTeaching} from "./modules/teaching.js?v=20260930-securityenforced2";
import {initAdmin} from "./modules/admin.js?v=20260930-securityenforced2";
import {initResilience} from "./modules/resilience.js?v=20260930-securityenforced2";
import {initClassroom} from "./modules/classroom.js?v=20261002-classroom7";

const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const $=s=>document.querySelector(s);

const productivity=initProductivity();
const teaching=initTeaching();
const admin=initAdmin();
const resilience=initResilience();
const classroom=initClassroom();

async function loadFeatureFlags(){
  try{
    const snap=await getDoc(doc(db,"system","platform"));
    return snap.exists()?(snap.data().features||{}):{};
  }catch(_){return {};}
}
function featureEnabled(flags,key){return flags[key]!==false;}

async function applyFeatureFlags(){
  const flags=await loadFeatureFlags();
  window.TheoriaFeatureFlags=flags;
  const map={
    planner:"planner",
    communications:"communications",
    analytics:"insights",
    courseProgression:"progression",
    studentProfiles:"academic-profile",
    programMap:"program-map",
    transcript:"transcript"
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
    const snap=await getDoc(doc(db,"system","announcement"));
    if(!snap.exists())return;
    const latest={id:"announcement",...snap.data()},now=new Date(),exp=latest.expiresAt?.toDate?.();
    if(exp&&exp<now)return;
    const key="theoria-system-announcement:"+(latest.createdAt?.toMillis?.()||latest.title||"current");
    if(sessionStorage.getItem(key))return;
    sessionStorage.setItem(key,"1");
    const home=document.querySelector("#page-home .page-head");
    if(home)home.insertAdjacentHTML("afterend",'<div class="system-announcement-banner"><div><span>'+String(latest.severity||"Information")+'</span><strong>'+String(latest.title||"Theoria Notice").replace(/[<>]/g,"")+'</strong><p>'+String(latest.body||"").replace(/[<>]/g,"")+'</p></div><button class="text-btn" data-phase6-action="dismiss-system-banner">Dismiss</button></div>');
  }catch(_){}
}

async function runAcademicWorkflowChecks(){
  const s=state();if(!s?.user||s.role!=="instructor")return;
  if(s.profile?.notificationPreferences?.workflows===false)return;
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
    try{
      const withdrawalSnap=await getDocs(collection(db,"sections",section.id,"withdrawalRequests"));
      const pending=withdrawalSnap.docs.filter(d=>d.data().status==="Pending");
      if(pending.length){
        const id="workflow_withdrawal_"+section.id;
        const ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        const body=pending.length+" withdrawal request"+(pending.length===1?" is":"s are")+" waiting for review in "+(section.sectionName||section.courseTitle)+".";
        if(!existing.exists()||existing.data().body!==body)await setDoc(ref,{type:"workflow",title:"Withdrawal requests need review",body,sectionId:section.id,targetPage:"sections",read:false,createdAt:serverTimestamp()},{merge:true});
      }
    }catch(_){}
    try{
      const [members,pathways]=await Promise.all([
        getDocs(collection(db,"sections",section.id,"members")),
        getDocs(collection(db,"sections",section.id,"gradingPathways"))
      ]);
      const selected=new Set(pathways.docs.map(d=>d.id));
      const missing=members.docs.filter(d=>!selected.has(d.id)).length;
      if(missing){
        const id="workflow_pathway_"+section.id;
        const ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        const body=missing+" student"+(missing===1?" has":"s have")+" not selected a grading pathway in "+(section.sectionName||section.courseTitle)+".";
        if(!existing.exists()||existing.data().body!==body)await setDoc(ref,{type:"workflow",title:"Grading pathways are incomplete",body,sectionId:section.id,targetPage:"sections",read:false,createdAt:serverTimestamp()},{merge:true});
      }
    }catch(_){}
    try{
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs")),now=Date.now(),horizon=now+48*60*60*1000;
      const opening=refs.docs.filter(d=>{const t=d.data().opensAt?.toMillis?.();return t&&t>=now&&t<=horizon;});
      if(opening.length){
        const id="workflow_assessment_open_"+section.id;
        const ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        const body=opening.length+" assessment"+(opening.length===1?" opens":"s open")+" within 48 hours in "+(section.sectionName||section.courseTitle)+". Review security, access, and scheduling.";
        if(!existing.exists()||existing.data().body!==body)await setDoc(ref,{type:"workflow",title:"Assessment administration approaching",body,sectionId:section.id,targetPage:"assessments",read:false,createdAt:serverTimestamp()},{merge:true});
      }
    }catch(_){}
    try{
      const assessments=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
      let pendingGrading=0,pendingEntrance=0;
      for(const assessmentDoc of assessments.docs){
        const assessment=assessmentDoc.data();
        const [subs,results]=await Promise.all([
          getDocs(collection(db,"assessments",assessmentDoc.id,"submissions")),
          getDocs(collection(db,"assessments",assessmentDoc.id,"results"))
        ]);
        const complete=new Set(results.docs.filter(d=>d.data().complete===true).map(d=>d.id));
        const waiting=subs.docs.filter(d=>["submitted","graded"].includes(d.data().status)&&!complete.has(d.id)).length;
        pendingGrading+=waiting;if(assessment.entranceExam===true)pendingEntrance+=waiting;
      }
      if(pendingGrading){
        const id="workflow_grading_"+section.id,ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        if(!existing.exists()||existing.data().body!==pendingGrading+" submitted assessment"+(pendingGrading===1?" needs":"s need")+" evaluation in "+(section.sectionName||section.courseTitle)+"."){
          await setDoc(ref,{type:"workflow",title:"Assessment grading is waiting",body:pendingGrading+" submitted assessment"+(pendingGrading===1?" needs":"s need")+" evaluation in "+(section.sectionName||section.courseTitle)+".",sectionId:section.id,targetPage:"assessments",read:false,createdAt:serverTimestamp()},{merge:true});
        }
      }
      if(pendingEntrance){
        const id="workflow_entrance_"+section.id,ref=doc(db,"users",uid,"notifications",id),existing=await getDoc(ref);
        if(!existing.exists()||existing.data().body!==pendingEntrance+" entrance candidate"+(pendingEntrance===1?" is":"s are")+" waiting for evaluation."){
          await setDoc(ref,{type:"workflow",title:"Entrance candidates are waiting",body:pendingEntrance+" entrance candidate"+(pendingEntrance===1?" is":"s are")+" waiting for evaluation.",sectionId:section.id,targetPage:"assessments",read:false,createdAt:serverTimestamp()},{merge:true});
        }
      }
    }catch(_){}
  }
  productivity.updateNotificationBadge?.();
}

function updateConnectivityStatus(){
  const pill=document.querySelector("#connectivityStatus");if(!pill)return;
  pill.textContent=navigator.onLine?"Online":"Offline — recovery active";
  pill.classList.toggle("offline",!navigator.onLine);
}
function addPlatformControls(){
  const top=document.querySelector(".top-actions");if(!top)return;
  if(!document.querySelector("#contextHelpBtn"))top.insertAdjacentHTML("afterbegin",'<button id="contextHelpBtn" class="icon-action-btn context-help-btn" data-phase6-action="context-help" title="Help for this page">?</button>');
  if(!document.querySelector("#commandPaletteBtn"))top.insertAdjacentHTML("afterbegin",'<button id="commandPaletteBtn" class="icon-action-btn" data-productivity-action="open-command" title="Search Theoria (Ctrl/Cmd + K)">⌘K</button>');
  if(window.TheoriaFeatureFlags?.accessibility!==false&&!document.querySelector("#accessibilityBtn"))top.insertAdjacentHTML("afterbegin",'<button id="accessibilityBtn" class="icon-action-btn" data-productivity-action="accessibility" title="Accessibility">Aa</button>');
  if(window.TheoriaFeatureFlags?.communications!==false&&!document.querySelector("#notificationBtn"))top.insertAdjacentHTML("afterbegin",'<button id="notificationBtn" class="notification-btn" data-page-shortcut="communications" title="Notifications">◔<span id="notificationBadge" class="notification-badge hidden">0</span></button>');
  if(!document.querySelector("#connectivityStatus"))top.insertAdjacentHTML("afterbegin",'<span id="connectivityStatus" class="connectivity-pill">Online</span>');
  updateConnectivityStatus();
}

function addMobileDock(){
  if(document.querySelector("#mobileDock"))return;
  const s=state();if(!s?.user)return;
  const items=s.role==="instructor"
    ? [["home","Home","⌂"],["sections","Classes","▦"],["assessments","Assess","✓"],["itembank","Bank","Q"],["teaching-tools","Tools","T"]]
    : [["home","Home","⌂"],["sections","Courses","▦"],["assessments","Assess","✓"],["progress","Progress","↗"],["transcript","Record","R"]];
  const nav=document.createElement("nav");nav.id="mobileDock";nav.className="mobile-dock";nav.setAttribute("aria-label","Mobile navigation");
  nav.innerHTML=items.map(([page,label,icon])=>'<button class="mobile-dock-item" data-page-shortcut="'+page+'" data-mobile-page="'+page+'"><span>'+icon+'</span><small>'+label+'</small></button>').join("");
  document.body.appendChild(nav);syncMobileDock();
}
function syncMobileDock(page){
  const active=page||document.querySelector(".page.active")?.id?.replace(/^page-/,"")||"home";
  document.querySelectorAll("[data-mobile-page]").forEach(b=>b.classList.toggle("active",b.dataset.mobilePage===active));
}
function contextHelpModal(){
  const page=document.querySelector(".page.active")?.id?.replace(/^page-/,"")||"home";
  const current=window.TheoriaPhase3?.getCurrent?.();
  const help={
    home:["Home","Your dashboard surfaces the courses and academic actions that need attention. Instructors see an Action Inbox; students see their current learning flow."],
    sections:["Sections","A section is the live teaching instance of a catalog course. Open one to use the Course Guide, assignments, assessments, Gradebook, analytics, and records."],
    "section-detail":["Section Workspace","Use the tabs to move from Course Guide and coursework into assessment, grading, Content & Skills analytics, and permanent records. The Course Guide is the recommended starting point."],
    assessments:["Assessments","Templates are reusable course materials; assigned assessments are independent section copies. Topic Practice and Progress Checks can remain formative while Unit Assessments can count in Composite grades."],
    "assessment-detail":["Assessment Workspace",current?"This assessment uses the unified workflow: Overview, Questions, Blueprint, Security, Progress, Student Results, Grading, and Content & Skills.":"Review assessment structure, administration, security, grading, and results from one workspace."],
    itembank:["Question Bank","Filter the official bank by course, unit, topic, type, difficulty, cognitive level, status, competency, or tag. Questions are snapshotted into assessments so later bank edits do not silently alter active tests."],
    gradebook:["Gradebook","Use inline spreadsheet entry for coursework, open formal assessments for grading, and watch pathway-aware projections and certification readiness on the right."],
    mastery:["Mastery","Mastery uses competency-tagged scored evidence and remains separate from the course grade. Recalculations preserve longitudinal history."],
    transcript:["Transcript","The transcript is a historical academic record. Completed, withdrawn, incomplete, and in-progress courses remain visible; withdrawals do not satisfy completed-course prerequisites."],
    progress:["Progress","Progress combines competency mastery and current course evidence. Use weak topics and competencies to guide recommended practice."],
    reports:["Reports","Reports combine class performance, item analysis, Content & Skills evidence, certification readiness, and permanent academic records."]
  };
  const [title,body]=help[page]||["Theoria Help","Use the page heading, contextual actions, and course navigation to move through the academic workflow."];
  core()?.openModal?.({
    eyebrow:"Contextual Help",
    title,
    body:'<div class="academic-banner"><div class="kicker">How this workspace works</div><h3>'+title+'</h3><p>'+body+'</p></div><div class="help-principles"><div><strong>Course Guide first</strong><span>Instruction, practice, and assessment stay aligned to units, topics, and competencies.</span></div><div><strong>Evidence stays auditable</strong><span>Grades, assessment attempts, certification, and record amendments preserve their history.</span></div><div><strong>Formative ≠ final grade</strong><span>Topic Practice and Progress Checks can build mastery without affecting Composite grades unless an instructor opts in.</span></div></div>',
    footer:'<button class="primary-btn" data-close-modal>Got it</button>'
  });
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
  classroom.enhanceAll?.();
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
  if(b.dataset.phase6Action==="context-help")contextHelpModal();
});

window.addEventListener("theoria:ready",async()=>{
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(error=>console.warn("Theoria offline shell registration failed:",error));
  }
  await applyFeatureFlags();
  addPlatformControls();
  addMobileDock();
  window.addEventListener("online",()=>{updateConnectivityStatus();core()?.showToast?.("Theoria is back online. Cloud saves are available again.");});
  window.addEventListener("offline",()=>{updateConnectivityStatus();core()?.showToast?.("Theoria is offline. Local draft recovery remains active until connectivity returns.");});
  await showSystemAnnouncement();
  await productivity.synthesizeNotifications?.();
  await runAcademicWorkflowChecks();
  setTimeout(enhanceCurrentContext,100);
});

window.addEventListener("theoria:page",e=>{syncMobileDock(e.detail?.page);setTimeout(enhanceCurrentContext,60);});

window.TheoriaPlatform={
  hashCode:(value)=>teaching.hashCode(value),
  authorizeAssessmentAccess:(assessment,code)=>teaching.authorizeAssessmentAccess(assessment,code),
  renderAssessmentSecurity:(detail)=>teaching.renderAssessmentSecurity(detail),
  renderBlueprintDesigner:(detail)=>teaching.renderBlueprintDesigner(detail)
};

window.TheoriaPhase6={
  productivity,teaching,admin,resilience,classroom,
  applyFeatureFlags,
  runAcademicWorkflowChecks,
  preflightSecurity:(assessment)=>teaching.preflightSecurity(assessment),
  openRubricGrade:(assignment,student,existing)=>teaching.openRubricGrade(assignment,student,existing),
  saveExamDraft:(assessmentId,payload)=>productivity.saveExamDraft(assessmentId,payload),
  loadExamDraft:(assessmentId)=>productivity.loadExamDraft(assessmentId),
  clearExamDraft:(assessmentId)=>productivity.clearExamDraft(assessmentId),
  examDraftHistory:(assessmentId)=>productivity.examDraftHistory(assessmentId),
  saveAssignmentDraft:(sectionId,assignmentId,payload)=>productivity.saveAssignmentDraft(sectionId,assignmentId,payload),
  loadAssignmentDraft:(sectionId,assignmentId)=>productivity.loadAssignmentDraft(sectionId,assignmentId),
  clearAssignmentDraft:(sectionId,assignmentId)=>productivity.clearAssignmentDraft(sectionId,assignmentId),
  assignmentDraftHistory:(sectionId,assignmentId)=>productivity.assignmentDraftHistory(sectionId,assignmentId)
};
