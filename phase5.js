import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp
} from "./firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=value=>core()?.esc?.(value)??String(value??"");
const toast=message=>core()?.showToast?.(message);
const modal=args=>core()?.openModal?.(args);
const closeModal=()=>core()?.closeModal?.();

const ROLE_LABELS={
  coordinator:"Course Coordinator",
  teaching_assistant:"Teaching Assistant",
  grader:"Grader"
};

function toMillis(value){return value?.toMillis?.()||0;}
function pct(n,d){return d?Math.round((Number(n||0)/Number(d||0))*1000)/10:null;}
function safeArray(v){return Array.isArray(v)?v:[];}
function isInstructor(){return state()?.role==="instructor";}
function currentSection(){return state()?.currentSection||null;}
function canOwnSection(section){return !!section&&section.ownerId===state()?.user?.uid;}
function courseById(id){return state()?.courses?.find(c=>c.id===id)||null;}

async function logSectionEvent(sectionId,action,targetType="",targetId="",details={}){
  const s=state();if(!s?.user||!sectionId)return;
  try{
    await addDoc(collection(db,"sections",sectionId,"auditLog"),{
      action,targetType,targetId,details,
      actorId:s.user.uid,
      actorName:s.profile?.displayName||s.user.displayName||s.user.email||"User",
      actorRole:s.role,
      createdAt:serverTimestamp()
    });
  }catch(error){console.warn("Theoria audit log write failed:",error);}
}

async function logCourseEvent(courseId,action,targetType="",targetId="",details={}){
  const s=state();if(!s?.user||!courseId)return;
  try{
    await addDoc(collection(db,"courses",courseId,"auditLog"),{
      action,targetType,targetId,details,
      actorId:s.user.uid,
      actorName:s.profile?.displayName||s.user.displayName||s.user.email||"User",
      createdAt:serverTimestamp()
    });
  }catch(error){console.warn("Theoria course audit write failed:",error);}
}

/* -------------------- COURSE PROGRESSION -------------------- */

async function loadOwnAcademicEvidence(){
  const s=state(),records=[],mastery=[];
  if(!s?.user)return {records,mastery};
  const sectionsById=new Map((s.sections||[]).map(section=>[section.id,section]));
  try{
    const enrollmentSnap=await getDocs(collection(db,"users",s.user.uid,"enrollments"));
    for(const enrollment of enrollmentSnap.docs){
      if(!sectionsById.has(enrollment.id)){
        sectionsById.set(enrollment.id,{id:enrollment.id,...enrollment.data()});
      }
    }
  }catch(_){}
  for(const section of sectionsById.values()){
    try{
      const rec=await getDoc(doc(db,"sections",section.id,"academicRecords",s.user.uid));
      if(rec.exists())records.push({sectionId:section.id,...rec.data()});
    }catch(_){}
    try{
      const m=await getDoc(doc(db,"sections",section.id,"mastery",s.user.uid));
      if(m.exists())mastery.push({sectionId:section.id,courseId:section.courseId,...m.data()});
    }catch(_){}
  }
  return {records,mastery};
}

async function courseApproval(courseId,userId){
  try{
    const snap=await getDoc(doc(db,"courses",courseId,"approvals",userId));
    return snap.exists()?snap.data():null;
  }catch(_){return null;}
}

function competencyEvidenceFor(masteryRows,courseId,code){
  const candidates=masteryRows.filter(x=>!courseId||x.courseId===courseId);
  let best=null;
  for(const row of candidates){
    const hit=safeArray(row.competencies).find(c=>String(c.code||"").toUpperCase()===String(code||"").toUpperCase());
    if(hit&&hit.percent!==null&&hit.percent!==undefined){
      if(best===null||Number(hit.percent)>best)best=Number(hit.percent);
    }
  }
  return best;
}

async function evaluateCourseReadiness(course,evidence,userId){
  const policy=course.prerequisitePolicy||{};
  const checks=[];
  const minFinal=Number(policy.minFinalPercent||0);
  for(const requiredId of safeArray(policy.requiredCourseIds)){
    const requiredCourse=courseById(requiredId)||{id:requiredId,title:"Required course",code:"Course"};
    const records=evidence.records.filter(r=>r.courseId===requiredId&&r.status==="Certified"&&r.recordType!=="Withdrawal"&&r.enrollmentOutcome!=="Withdrawn");
    const best=records.length?Math.max(...records.map(r=>Number(r.finalPercent||0))):null;
    checks.push({
      label:(requiredCourse.code||"Course")+" — "+(requiredCourse.title||"Required course"),
      detail:minFinal?"Certified final grade ≥ "+minFinal+"%":"Certified completion required",
      ok:best!==null&&best>=minFinal,
      value:best===null?"No certified record":best+"%"
    });
  }

  for(const req of safeArray(policy.competencyRequirements)){
    const value=competencyEvidenceFor(evidence.mastery,req.courseId||"",req.code);
    const required=Number(req.minPercent||70);
    checks.push({
      label:"Competency "+String(req.code||"").toUpperCase(),
      detail:"Mastery ≥ "+required+"%",
      ok:value!==null&&value>=required,
      value:value===null?"No evidence":value+"%"
    });
  }

  if(policy.instructorApproval===true){
    const approval=await courseApproval(course.id,userId);
    checks.push({
      label:"Instructor approval",
      detail:"Manual academic approval required",
      ok:approval?.approved===true,
      value:approval?.approved===true?"Approved":"Pending"
    });
  }

  if(course.entranceExamRequired===true){
    checks.push({
      label:"Entrance examination",
      detail:"Completed at the section enrollment gate",
      ok:null,
      value:"Checked when joining a section"
    });
  }

  return {
    checks,
    ready:checks.filter(x=>x.ok!==null).every(x=>x.ok),
    hasRequirements:checks.length>0
  };
}

function prerequisiteSummary(course){
  const p=course.prerequisitePolicy||{};
  const count=safeArray(p.requiredCourseIds).length;
  const comps=safeArray(p.competencyRequirements).length;
  const bits=[];
  if(count)bits.push(count+" prerequisite course"+(count===1?"":"s"));
  if(comps)bits.push(comps+" competency threshold"+(comps===1?"":"s"));
  if(p.instructorApproval)bits.push("instructor approval");
  if(course.entranceExamRequired)bits.push("entrance exam");
  return bits.length?bits.join(" • "):"Open progression — no prerequisites configured";
}

async function prerequisiteModal(courseId){
  const s=state(),course=courseById(courseId);if(!course)return;
  if(!s.isSystemOwner&&!core().canManageCourse(course))return toast("You do not have permission to change this course progression.");
  const policy=course.prerequisitePolicy||{};
  const others=(s.courses||[]).filter(c=>c.id!==course.id&&c.catalogPublished!==false);
  const comps=safeArray(policy.competencyRequirements);

  const m=modal({
    eyebrow:"Academic Progression",
    title:"Prerequisites — "+(course.code||course.title),
    wide:true,
    body:'<form id="prerequisiteForm" class="academic-form">'+
      '<div class="academic-banner"><div class="kicker">Course Progression Engine</div><h3>'+esc(course.code+" — "+course.title)+'</h3><p>Define the evidence a student should have before beginning this course. Theoria will show readiness without silently making academic decisions for the instructor.</p></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Prior Courses</h3><p>Require certified completion of one or more earlier courses.</p></div></div>'+
      '<div class="prerequisite-course-grid">'+(others.length?others.map(c=>'<label class="policy-card compact-policy"><input type="checkbox" name="requiredCourse" value="'+c.id+'" '+(safeArray(policy.requiredCourseIds).includes(c.id)?'checked':'')+'><div><strong>'+esc(c.code+" — "+c.title)+'</strong><span>'+esc(c.discipline||"Academic course")+'</span></div></label>').join(""):'<div class="empty-mini">No other published courses are available.</div>')+'</div>'+
      '<div class="field" style="margin-top:12px"><label>Minimum Certified Final Grade</label><div class="input-with-suffix"><input name="minFinalPercent" type="number" min="0" max="100" value="'+esc(policy.minFinalPercent??0)+'"><span>%</span></div></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Competency Thresholds</h3><p>Require specific mastery evidence from prior study.</p></div><button type="button" class="secondary-btn small-btn" id="addCompetencyReq">+ Add Requirement</button></div><div id="competencyReqRows" class="structured-list"></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Additional Gates</h3><p>Use instructor approval and the existing entrance-examination system when appropriate.</p></div></div>'+
      '<label class="policy-card"><input type="checkbox" name="instructorApproval" '+(policy.instructorApproval?'checked':'')+'><div><strong>Require Instructor Approval</strong><span>A coordinator or instructor must explicitly approve readiness.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="entranceExamRequired" '+(course.entranceExamRequired?'checked':'')+'><div><strong>Require Entrance Examination</strong><span>Every teaching section must configure an entrance assessment before enrollment.</span></div></label></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Progression Policy</button></div></form>'
  });

  const box=m.querySelector("#competencyReqRows");
  const addRow=(row={})=>{
    const el=document.createElement("div");el.className="structured-row progression-competency-row";
    el.innerHTML='<div class="structured-index">◇</div><select class="structured-input req-course"><option value="">Any prior course</option>'+others.map(c=>'<option value="'+c.id+'">'+esc(c.code)+'</option>').join("")+'</select><input class="structured-input req-code" placeholder="Competency code" value="'+esc(row.code||"")+'"><div class="input-with-suffix mini"><input class="req-min" type="number" min="0" max="100" value="'+esc(row.minPercent??70)+'"><span>%</span></div><button type="button" class="row-remove">×</button>';
    el.querySelector(".req-course").value=row.courseId||"";
    el.querySelector(".row-remove").onclick=()=>el.remove();
    box.appendChild(el);
  };
  comps.forEach(addRow);m.querySelector("#addCompetencyReq").onclick=()=>addRow();

  const prerequisiteForm=m?.querySelector("#prerequisiteForm");
  if(!prerequisiteForm){closeModal();return toast("The progression editor could not be initialized. Refresh Theoria and try again.");}
  prerequisiteForm.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const competencyRequirements=[...box.querySelectorAll(".progression-competency-row")].map(row=>({
      courseId:row.querySelector(".req-course").value,
      code:row.querySelector(".req-code").value.trim().toUpperCase(),
      minPercent:Number(row.querySelector(".req-min").value||70)
    })).filter(x=>x.code);
    const prerequisitePolicy={
      requiredCourseIds:fd.getAll("requiredCourse"),
      minFinalPercent:Number(fd.get("minFinalPercent")||0),
      competencyRequirements,
      instructorApproval:e.currentTarget.querySelector('[name="instructorApproval"]')?.checked===true,
      updatedAt:serverTimestamp()
    };
    try{
      await updateDoc(doc(db,"courses",course.id),{
        prerequisitePolicy,
        entranceExamRequired:e.currentTarget.querySelector('[name="entranceExamRequired"]')?.checked===true,
        updatedAt:serverTimestamp()
      });
      Object.assign(course,{prerequisitePolicy,entranceExamRequired:e.currentTarget.querySelector('[name="entranceExamRequired"]')?.checked===true});
      await logCourseEvent(course.id,"progression_policy_updated","course",course.id,{
        requiredCourseIds:prerequisitePolicy.requiredCourseIds,
        competencyRequirements:competencyRequirements.map(x=>({courseId:x.courseId,code:x.code,minPercent:x.minPercent})),
        instructorApproval:prerequisitePolicy.instructorApproval,
        entranceExamRequired:course.entranceExamRequired
      });
      closeModal();toast("Course progression policy saved.");renderProgression();
    }catch(error){toast(error.message||"Unable to save the progression policy.");}
  };
}

async function evaluateEnrollmentEligibility(section,courseOverride=null){
  const s=state();if(!s?.user||s.role!=="student")return {ready:true,checks:[]};
  const course=courseOverride||courseById(section?.courseId);
  if(!course)return {ready:true,checks:[]};
  const evidence=await loadOwnAcademicEvidence();
  return evaluateCourseReadiness(course,evidence,s.user.uid);
}

async function renderProgression(){
  const el=$("#progressionContent"),s=state();if(!el||!s?.user)return;
  el.innerHTML='<div class="empty-mini">Evaluating academic progression…</div>';
  if(s.role==="instructor"){
    const courses=(s.courses||[]).filter(c=>c.catalogPublished!==false||s.isSystemOwner);
    el.innerHTML='<div class="academic-banner"><div class="kicker">Course Progression Engine</div><h3>Connect courses into intentional academic sequences.</h3><p>Prerequisite courses, certified grades, competency thresholds, entrance examinations, and instructor approval can work together as one readiness model.</p></div>'+
      '<div class="progression-grid">'+courses.map((course,index)=>'<article class="progression-course-card"><div class="progression-sequence">'+String(index+1).padStart(2,"0")+'</div><div><span>'+esc(course.discipline||"Course")+'</span><h3>'+esc(course.code+" — "+course.title)+'</h3><p>'+esc(prerequisiteSummary(course))+'</p></div><div class="card-actions">'+(s.isSystemOwner||core().canManageCourse(course)?'<button class="secondary-btn small-btn" data-phase5-action="manage-prerequisites" data-course="'+course.id+'">Manage Prerequisites</button>':'')+'</div></article>').join("")+'</div>';
    return;
  }

  const evidence=await loadOwnAcademicEvidence();
  const rows=[];
  for(const course of (s.courses||[]).filter(c=>c.catalogPublished!==false)){
    rows.push({course,eval:await evaluateCourseReadiness(course,evidence,s.user.uid)});
  }
  el.innerHTML='<div class="academic-banner"><div class="kicker">Academic Progression</div><h3>Your readiness map.</h3><p>Theoria compares your certified course records and competency evidence with each course’s configured prerequisites. Entrance examinations and instructor review remain separate gates where required.</p></div>'+
    '<div class="progression-grid student-progression">'+rows.map(({course,eval:e})=>'<article class="progression-course-card '+(e.ready?'ready':'locked')+'"><div class="progression-sequence">'+(e.ready?'✓':'◇')+'</div><div><span>'+esc(course.discipline||"Course")+'</span><h3>'+esc(course.code+" — "+course.title)+'</h3><p>'+esc(prerequisiteSummary(course))+'</p>'+(e.checks.length?'<div class="readiness-checks">'+e.checks.map(x=>'<div class="'+(x.ok===true?'ok':x.ok===false?'missing':'pending')+'"><span>'+(x.ok===true?'✓':x.ok===false?'!':'•')+'</span><div><strong>'+esc(x.label)+'</strong><small>'+esc(x.detail)+' • '+esc(x.value)+'</small></div></div>').join("")+'</div>':'<div class="notice">No prerequisite evidence is required for this course.</div>')+'</div><span class="badge '+(e.ready?'live':'gold')+'">'+(e.ready?'Ready / Open':'Requirements Pending')+'</span></article>').join("")+'</div>';
}

/* -------------------- STUDENT ACADEMIC PROFILE -------------------- */

async function renderAcademicProfile(){
  const el=$("#academicProfileContent"),s=state();if(!el||!s?.user)return;
  const profile=s.profile||{};
  if(s.role==="instructor"){
    el.innerHTML='<div class="academic-banner"><div class="kicker">Academic Identity</div><h3>'+esc(profile.displayName||s.user.displayName||"Instructor")+'</h3><p>Your instructor account manages teaching sections, assessment design, course progression, and academic records.</p></div><div class="panel"><div class="panel-head"><div class="panel-title">Instructor Profile</div></div><div class="panel-body"><div class="detail-list"><div><span>Email</span><strong>'+esc(s.user.email||"—")+'</strong></div><div><span>Role</span><strong>'+(s.isSystemOwner?'System Owner / Instructor':'Instructor')+'</strong></div><div><span>Teaching Sections</span><strong>'+esc((s.sections||[]).filter(x=>x.status!=="Archived").length)+'</strong></div></div></div></div>';
    return;
  }

  const evidence=await loadOwnAcademicEvidence();
  let persistentAccess={},entranceAttempts=[],standingRows=[];
  try{
    const accessSnap=await getDoc(doc(db,"academicAccess",s.user.uid));
    if(accessSnap.exists())persistentAccess=accessSnap.data();
  }catch(_){}
  try{
    const entranceSnap=await getDocs(collection(db,"users",s.user.uid,"entranceAttempts"));
    entranceAttempts=entranceSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>toMillis(b.updatedAt||b.createdAt)-toMillis(a.updatedAt||a.createdAt));
  }catch(_){}
  for(const section of (s.sections||[]).filter(x=>x.status!=="Archived")){
    try{
      const member=await getDoc(doc(db,"sections",section.id,"members",s.user.uid));
      if(member.exists()){
        const data=member.data();
        standingRows.push({
          sectionId:section.id,courseCode:section.courseCode||data.courseCode||"Course",
          courseTitle:section.courseTitle||"",standing:data.academicStanding||"Good Standing",
          note:data.academicStandingNote||""
        });
      }
    }catch(_){}
  }
  const defaults=persistentAccess.accommodations||profile.defaultAccommodations||{};
  const completed=evidence.records.filter(r=>r.status==="Certified"&&r.recordType!=="Withdrawal"&&r.enrollmentOutcome!=="Withdrawn");
  const withdrawn=evidence.records.filter(r=>r.status==="Certified"&&(r.recordType==="Withdrawal"||r.enrollmentOutcome==="Withdrawn"));
  const comps=new Map();
  evidence.mastery.forEach(m=>safeArray(m.competencies).forEach(c=>{
    const key=String(c.code||"").toUpperCase();
    if(!key)return;
    if(!comps.has(key)||Number(c.percent||0)>Number(comps.get(key).percent||0))comps.set(key,c);
  }));

  el.innerHTML='<div class="academic-banner"><div class="kicker">Student Academic Profile</div><h3>'+esc(profile.displayName||s.user.displayName||"Student")+'</h3><p>Completed courses, competency evidence, current enrollment, entrance examinations, and default assessment-access preferences in one academic profile.</p></div>'+
    '<div class="student-profile-summary"><div><span>Current Sections</span><strong>'+esc((s.sections||[]).filter(x=>x.status!=="Archived").length)+'</strong></div><div><span>Completed Courses</span><strong>'+completed.length+'</strong></div><div><span>Certified Withdrawals</span><strong>'+withdrawn.length+'</strong></div><div><span>Competencies Evidenced</span><strong>'+comps.size+'</strong></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Completed Courses</div></div><div class="panel-body">'+(completed.length?completed.map(r=>'<div class="profile-record-row"><div><strong>'+esc(r.courseCode+" — "+r.courseTitle)+'</strong><span>'+esc(r.term||"")+'</span></div><b>'+esc(r.letterGrade||"—")+' • '+esc(r.finalPercent??"—")+'%</b></div>').join(""):'<div class="empty-mini">No completed course records yet.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Strongest Competency Evidence</div></div><div class="panel-body">'+([...comps.values()].length?[...comps.values()].sort((a,b)=>Number(b.percent||0)-Number(a.percent||0)).slice(0,8).map(c=>'<div class="profile-record-row"><div><strong>'+esc(c.code||"Competency")+'</strong><span>'+esc(c.name||"")+'</span></div><b>'+esc(c.percent??"—")+'%</b></div>').join(""):'<div class="empty-mini">No competency evidence yet.</div>')+'</div></div></div>'+
    (standingRows.length?'<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Current Academic Standing</div><div class="panel-subtitle">Administrative standing is recorded by your instructor and remains separate from your numerical grade.</div></div></div><div class="panel-body">'+standingRows.map(row=>'<div class="profile-record-row"><div><strong>'+esc(row.courseCode+" — "+row.courseTitle)+'</strong><span>'+esc(row.note||"Current active section")+'</span></div><b class="'+(row.standing==="Academic Warning"?"status-danger":"")+'">'+esc(row.standing)+'</b></div>').join("")+'</div></div>':'')+
    (withdrawn.length?'<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Certified Withdrawal Records</div><div class="panel-subtitle">These preserve the instructor-certified grade at withdrawal but do not count as completed-course prerequisites.</div></div></div><div class="panel-body">'+withdrawn.map(r=>'<div class="profile-record-row"><div><strong>'+esc(r.courseCode+" — "+r.courseTitle)+'</strong><span>'+esc(r.term||"")+' • Assessments waived'+(Number(r.gradeAdjustmentPoints||0)!==0?' • Adjustment '+(Number(r.gradeAdjustmentPoints)>0?'+':'')+esc(r.gradeAdjustmentPoints)+' pts':'')+'</span></div><b>'+esc(r.letterGrade||"—")+' • '+esc(r.finalPercent??"—")+'%</b></div>').join("")+'</div></div>':'')+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div class="panel-title">Entrance Examination History</div></div><div class="panel-body">'+(entranceAttempts.length?entranceAttempts.map(x=>{const label=x.status==="passed"?"Eligible":x.status==="failed"?"Not Eligible":x.status==="submitted"?"Awaiting Evaluation":x.status==="in_progress"?"Entrance In Progress":"Entrance Required";return '<div class="profile-record-row"><div><strong>'+esc((x.courseCode||"Course")+' — '+(x.assessmentTitle||"Entrance Examination"))+'</strong><span>'+esc(x.sectionName||"")+' • Required '+esc(x.passPercent||70)+'%</span></div><b class="'+(x.status==="passed"?'status-success':x.status==="failed"?'status-danger':'')+'">'+esc(label)+(x.percent!==null&&x.percent!==undefined?' • '+esc(x.percent)+'%':'')+'</b></div>';}).join(""):'<div class="empty-mini">No entrance examination attempts recorded.</div>')+'</div></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Persistent Assessment Access</div><div class="panel-subtitle">Institutional access settings follow you into new sections. Instructors can still authorize a section-specific override.</div></div><span class="badge '+(persistentAccess.accommodations?'live':'')+'">'+(persistentAccess.accommodations?'Profile Active':'Standard Access')+'</span></div><div class="panel-body"><div class="detail-list"><div><span>Time Multiplier</span><strong>'+esc(defaults.timeMultiplier||1)+'×</strong></div><div><span>Breaks</span><strong>'+(defaults.breaks?'Permitted':'Standard policy')+'</strong></div><div><span>Calculator</span><strong>'+(defaults.calculator?'Permitted':'Standard policy')+'</strong></div><div><span>Large Text</span><strong>'+(defaults.largeText?'Enabled':'Standard')+'</strong></div><div><span>Reduced Distractions</span><strong>'+(defaults.reducedDistractions?'Enabled':'Standard')+'</strong></div></div>'+(persistentAccess.notes?'<div class="notice" style="margin-top:12px">'+esc(persistentAccess.notes)+'</div>':'')+'<div class="fineprint" style="margin-top:12px">Persistent access settings are managed by authorized instructors rather than self-assigned by students.</div></div></div>';
}

/* -------------------- SECTION OPERATIONS / LIFECYCLE -------------------- */

async function archiveSection(sectionId){
  const s=state(),section=s.sections.find(x=>x.id===sectionId)||currentSection();if(!section)return;
  if(!canOwnSection(section))return toast("Only the section owner can archive this section.");
  if(!confirm("Archive "+(section.sectionName||section.courseTitle)+"? It will become read-only for normal teaching and disappear from active-section counts."))return;
  try{
    const batch=writeBatch(db);
    batch.update(doc(db,"sections",section.id),{status:"Archived",joinOpen:false,archivedAt:serverTimestamp(),updatedAt:serverTimestamp()});
    if(section.joinCode)batch.update(doc(db,"joinCodes",section.joinCode),{active:false,updatedAt:serverTimestamp()});
    await batch.commit();
    await logSectionEvent(section.id,"section_archived","section",section.id,{sectionName:section.sectionName||""});
    Object.assign(section,{status:"Archived",joinOpen:false});
    await core().loadWorkspace();
    core().setPage("sections");
    toast("Section archived.");
  }catch(error){toast(error.message||"Unable to archive the section.");}
}

async function restoreSection(sectionId){
  const s=state(),section=s.sections.find(x=>x.id===sectionId)||currentSection();if(!section)return;
  if(!canOwnSection(section))return toast("Only the section owner can restore this section.");
  try{
    await updateDoc(doc(db,"sections",section.id),{status:"Active",updatedAt:serverTimestamp()});
    await logSectionEvent(section.id,"section_restored","section",section.id,{});
    await core().loadWorkspace();toast("Section restored.");
  }catch(error){toast(error.message||"Unable to restore the section.");}
}

async function enrollmentHistoryModal(sectionId){
  const section=currentSection();if(!section||section.id!==sectionId)return;
  let rows=[];
  try{
    const snap=await getDocs(collection(db,"sections",sectionId,"enrollmentHistory"));
    rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>toMillis(b.createdAt)-toMillis(a.createdAt));
  }catch(_){}
  const latestByStudent=new Map();
  rows.forEach(r=>{if(r.studentId&&!latestByStudent.has(r.studentId))latestByStudent.set(r.studentId,r);});
  modal({
    eyebrow:"Enrollment Lifecycle",
    title:"Enrollment History",
    wide:true,
    body:rows.length?'<div class="audit-timeline">'+rows.map(r=>'<div class="audit-event"><div class="audit-event-mark">'+(r.status==="Removed"?"×":r.status==="Completed"?"✓":r.status==="Reinstated"?"↻":"•")+'</div><div><strong>'+esc(r.studentName||"Student")+' — '+esc(r.status||"Status")+'</strong><span>'+esc(r.reason||"")+'</span><small>'+esc(r.actorName||"System")+(r.withdrawalCertified?' • Certified '+esc(r.letterGrade||"—")+' ('+esc(r.finalPercent??"—")+'%)':'')+'</small>'+(latestByStudent.get(r.studentId)?.id===r.id&&["Removed","Withdrawn"].includes(r.status)?'<button class="secondary-btn small-btn" style="margin-top:7px" data-phase5-action="reinstate-student" data-section="'+sectionId+'" data-student="'+esc(r.studentId)+'">Reinstate Student</button>':'')+'</div></div>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">E</div><h3>No enrollment history yet.</h3><p>Withdrawals, removals, reinstatements, and completions will appear here.</p></div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

async function reinstateStudent(sectionId,studentId){
  const section=currentSection();if(!section||section.id!==sectionId||!canOwnSection(section))return;
  try{
    const historySnap=await getDocs(collection(db,"sections",sectionId,"enrollmentHistory"));
    const history=historySnap.docs.map(d=>({id:d.id,...d.data()}))
      .filter(x=>x.studentId===studentId)
      .sort((a,b)=>toMillis(b.createdAt)-toMillis(a.createdAt));
    const prior=history[0];
    if(!prior)return toast("No prior enrollment history was found.");

    let accommodations={timeMultiplier:1,breaks:false,calculator:false,largeText:false,reducedDistractions:false,notes:""};
    try{
      const access=await getDoc(doc(db,"academicAccess",studentId));
      if(access.exists())accommodations={...accommodations,...(access.data().accommodations||{})};
    }catch(_){}

    const batch=writeBatch(db);
    batch.set(doc(db,"sections",sectionId,"members",studentId),{
      userId:studentId,
      displayName:prior.studentName||"Student",
      email:prior.studentEmail||"",
      role:"student",
      status:"enrolled",
      accommodations,
      useProfileDefaults:true,
      reinstatedAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    },{merge:true});
    batch.set(doc(db,"users",studentId,"enrollments",sectionId),{
      sectionId,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
      sectionName:section.sectionName,term:section.term,joinCode:section.joinCode||"",status:"Enrolled",
      reinstatedAt:serverTimestamp(),updatedAt:serverTimestamp()
    },{merge:true});
    const eventRef=doc(collection(db,"sections",sectionId,"enrollmentHistory"));
    batch.set(eventRef,{
      studentId,studentName:prior.studentName||"Student",studentEmail:prior.studentEmail||"",
      status:"Reinstated",reason:"Reinstated by instructor",actorId:state().user.uid,
      actorName:state().profile?.displayName||state().user.displayName||"Instructor",createdAt:serverTimestamp()
    });
    await batch.commit();
    await logSectionEvent(sectionId,"enrollment_reinstated","student",studentId,{});
    closeModal();
    await core().reloadCurrentSection("students");
    toast((prior.studentName||"Student")+" was reinstated.");
  }catch(error){toast(error.message||"Unable to reinstate the student.");}
}

async function setEnrollmentLifecycle(studentId,status){
  const section=currentSection(),s=state();if(!section||!s?.sectionData)return;
  if(!canOwnSection(section))return toast("Only the section owner can change enrollment lifecycle status.");
  const student=s.sectionData.members.find(x=>x.id===studentId);if(!student)return;
  const reason=prompt("Reason for "+status.toLowerCase()+"?")||"";
  try{
    if(status==="Completed"){
      const batch=writeBatch(db);
      batch.update(doc(db,"sections",section.id,"members",studentId),{status:"completed",completedAt:serverTimestamp(),updatedAt:serverTimestamp()});
      batch.set(doc(db,"users",studentId,"enrollments",section.id),{
        sectionId:section.id,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
        sectionName:section.sectionName,term:section.term,status:"Completed",completedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      await batch.commit();
    }else{
      const batch=writeBatch(db);
      batch.delete(doc(db,"sections",section.id,"members",studentId));
      batch.set(doc(db,"users",studentId,"enrollments",section.id),{
        sectionId:section.id,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
        sectionName:section.sectionName,term:section.term,status,endedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      await batch.commit();
    }
    await addDoc(collection(db,"sections",section.id,"enrollmentHistory"),{
      studentId,studentName:student.displayName||"Student",studentEmail:student.email||"",
      status,reason,actorId:s.user.uid,actorName:s.profile?.displayName||s.user.displayName||"Instructor",
      createdAt:serverTimestamp()
    });
    await logSectionEvent(section.id,"enrollment_"+status.toLowerCase(),"student",studentId,{reason});
    await core().reloadCurrentSection("students");
    toast((student.displayName||"Student")+" marked "+status.toLowerCase()+".");
  }catch(error){toast(error.message||"Unable to update enrollment status.");}
}

async function gradeHistoryModal(sectionId){
  let rows=[];
  try{
    const snap=await getDocs(collection(db,"sections",sectionId,"auditLog"));
    rows=snap.docs.map(d=>({id:d.id,...d.data()}))
      .filter(row=>["grade_changed","grade_created","bulk_grade_changed","spreadsheet_grades_pasted","rubric_grade_changed","rubric_grade_created","shared_group_grade_applied","assessment_result_updated","grading_period_finalized","grading_period_reopened"].includes(row.action))
      .sort((a,b)=>toMillis(b.createdAt)-toMillis(a.createdAt));
  }catch(error){return toast("Unable to load grade history.");}
  modal({
    eyebrow:"Gradebook Audit",
    title:"Grade Change History",
    wide:true,
    body:rows.length?'<div class="audit-timeline grade-history-timeline">'+rows.map(row=>{
      const d=row.details||{};
      const score=(d.priorScore!==undefined||d.newScore!==undefined)?'<span>'+esc(d.priorScore??"—")+' → '+esc(d.newScore??"—")+'</span>':d.percent!==undefined?'<span>'+esc(d.percent)+'%</span>':d.score!==undefined?'<span>'+esc(d.score)+'</span>':'';
      return '<div class="audit-event"><div class="audit-event-mark">G</div><div><strong>'+esc(String(row.action||"grade event").replace(/_/g," "))+'</strong><span>'+esc(d.assignmentTitle||d.assessmentTitle||d.period||"")+(d.reason?' • '+esc(d.reason):'')+'</span>'+score+'<small>'+esc(row.actorName||"System")+' • '+esc(row.createdAt?.toDate?.()?.toLocaleString?.()||"")+'</small></div></div>';
    }).join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">G</div><h3>No grade changes recorded.</h3><p>Grade overrides, rubric changes, shared group grades, assessment results, and grading-period finalization will appear here.</p></div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

async function auditLogModal(sectionId){
  let rows=[];
  try{
    const snap=await getDocs(collection(db,"sections",sectionId,"auditLog"));
    rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>toMillis(b.createdAt)-toMillis(a.createdAt)).slice(0,150);
  }catch(error){return toast("Unable to load the audit log.");}
  modal({
    eyebrow:"Academic Audit",
    title:"Section Audit Log",
    wide:true,
    body:rows.length?'<div class="audit-timeline">'+rows.map(r=>'<div class="audit-event"><div class="audit-event-mark">•</div><div><strong>'+esc(String(r.action||"event").replace(/_/g," "))+'</strong><span>'+esc(r.targetType||"")+(r.details?.reason?' • '+esc(r.details.reason):'')+'</span><small>'+esc(r.actorName||"System")+'</small></div></div>').join("")+'</div>':'<div class="empty-mini">No audit events have been recorded yet.</div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

/* -------------------- STAFF ROLES -------------------- */

async function ensureDirectoryEntry(){
  const s=state();if(!s?.user)return;
  try{
    await setDoc(doc(db,"directory",s.user.uid),{
      uid:s.user.uid,
      displayName:s.profile?.displayName||s.user.displayName||"Theoria User",
      email:s.user.email||"",
      role:s.role,
      updatedAt:serverTimestamp()
    },{merge:true});
  }catch(_){}
}

async function staffManagementModal(sectionId){
  const section=currentSection();if(!section||section.id!==sectionId)return;
  if(!canOwnSection(section))return toast("Only the section owner can manage section staff.");
  let staff=[];
  try{
    const snap=await getDocs(collection(db,"sections",sectionId,"staff"));
    staff=snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(_){}

  const m=modal({
    eyebrow:"Section Permissions",
    title:"Staff & Academic Roles",
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">Granular Academic Roles</div><h3>'+esc(section.sectionName||section.courseTitle)+'</h3><p>Course Coordinators can manage most academic work, Teaching Assistants can manage coursework and support grading, and Graders can evaluate student work without receiving section-administration powers.</p></div>'+
      '<div class="panel"><div class="panel-head"><div class="panel-title">Current Staff</div></div><div class="panel-body" id="sectionStaffList">'+(staff.length?staff.map(x=>'<div class="staff-role-row"><div><strong>'+esc(x.displayName||x.email||x.id)+'</strong><span>'+esc(x.email||"")+'</span></div><span class="badge">'+esc(ROLE_LABELS[x.role]||x.role)+'</span><button class="text-btn danger-text" data-phase5-action="remove-staff" data-section="'+sectionId+'" data-user="'+x.id+'">Remove</button></div>').join(""):'<div class="empty-mini">No additional staff assigned.</div>')+'</div></div>'+
      '<form id="addStaffForm" class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">Add Staff Member</div></div><div class="panel-body"><div class="compact-field-grid"><div class="field"><label>Instructor Email</label><input name="email" type="email" required placeholder="instructor@example.com"></div><div class="field"><label>Role</label><select name="role"><option value="coordinator">Course Coordinator</option><option value="teaching_assistant">Teaching Assistant</option><option value="grader">Grader</option></select></div></div><button class="primary-btn" type="submit">Add Section Staff</button></div></form>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });

  m.querySelector("#addStaffForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),email=String(fd.get("email")).trim().toLowerCase(),role=String(fd.get("role"));
    try{
      const qSnap=await getDocs(query(collection(db,"directory"),where("email","==",email)));
      const userDoc=qSnap.docs.find(d=>d.data().role==="instructor");
      if(!userDoc)return toast("No instructor account with that email is available in the Theoria directory.");
      if(userDoc.id===section.ownerId)return toast("The section owner already has full access.");
      const user=userDoc.data(),batch=writeBatch(db);
      batch.set(doc(db,"sections",sectionId,"staff",userDoc.id),{
        userId:userDoc.id,displayName:user.displayName||email,email,role,addedBy:state().user.uid,addedAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      batch.set(doc(db,"users",userDoc.id,"staffSections",sectionId),{
        sectionId,ownerId:section.ownerId,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
        sectionName:section.sectionName,term:section.term,role,addedAt:serverTimestamp()
      });
      await batch.commit();
      await logSectionEvent(sectionId,"staff_added","user",userDoc.id,{role,email});
      closeModal();toast("Section staff added.");await staffManagementModal(sectionId);
    }catch(error){toast(error.message||"Unable to add section staff.");}
  };
}

async function removeStaff(sectionId,userId){
  const section=currentSection();if(!section||!canOwnSection(section))return;
  if(!confirm("Remove this staff member from the section?"))return;
  try{
    const batch=writeBatch(db);
    batch.delete(doc(db,"sections",sectionId,"staff",userId));
    batch.delete(doc(db,"users",userId,"staffSections",sectionId));
    await batch.commit();
    await logSectionEvent(sectionId,"staff_removed","user",userId,{});
    closeModal();toast("Section staff removed.");await staffManagementModal(sectionId);
  }catch(error){toast(error.message||"Unable to remove section staff.");}
}

/* -------------------- INSTRUCTOR APPROVALS -------------------- */

async function studentApprovalsModal(studentId){
  const student=state()?.sectionData?.members?.find(x=>x.id===studentId);
  if(!student)return;
  const courses=(state()?.courses||[]).filter(c=>c.prerequisitePolicy?.instructorApproval===true);
  const statuses=[];
  for(const course of courses){
    const approval=await courseApproval(course.id,studentId);
    statuses.push({course,approval});
  }
  modal({
    eyebrow:"Academic Progression Approval",
    title:student.displayName||"Student",
    wide:true,
    body:courses.length?'<div class="approval-course-list">'+statuses.map(({course,approval})=>'<div class="approval-course-row"><div><span>'+esc(course.discipline||"Course")+'</span><strong>'+esc(course.code+" — "+course.title)+'</strong><small>'+esc(prerequisiteSummary(course))+'</small></div>'+(approval?.approved===true?'<span class="badge live">Approved</span>':'<button class="primary-btn small-btn" data-phase5-action="approve-progression" data-course="'+course.id+'" data-student="'+studentId+'">Approve Readiness</button>')+'</div>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">↗</div><h3>No courses require manual approval.</h3><p>Enable Instructor Approval in a course progression policy to use this gate.</p></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function approveProgression(courseId,studentId){
  const course=courseById(courseId);if(!course||!isInstructor())return;
  try{
    await setDoc(doc(db,"courses",courseId,"approvals",studentId),{
      approved:true,studentId,approvedBy:state().user.uid,approvedByName:state().profile?.displayName||"Instructor",approvedAt:serverTimestamp(),updatedAt:serverTimestamp()
    },{merge:true});
    toast("Academic progression approval recorded.");
  }catch(error){toast(error.message||"Unable to record approval.");}
}

/* -------------------- ASSESSMENT ANALYTICS / BLUEPRINT INTELLIGENCE -------------------- */

function correlation(xs,ys){
  if(xs.length<3||xs.length!==ys.length)return null;
  const mx=xs.reduce((a,b)=>a+b,0)/xs.length,my=ys.reduce((a,b)=>a+b,0)/ys.length;
  let num=0,dx=0,dy=0;
  for(let i=0;i<xs.length;i++){const a=xs[i]-mx,b=ys[i]-my;num+=a*b;dx+=a*a;dy+=b*b;}
  return dx&&dy?Math.round((num/Math.sqrt(dx*dy))*100)/100:null;
}

async function renderAssessmentAnalytics(detail){
  const root=$("#phase5AssessmentAnalytics");if(!root||!detail)return;
  const a=detail.assessment,questions=detail.questions||[],results=detail.results||[],subs=detail.submissions||[];
  if(!a.sectionId){root.innerHTML='<div class="empty-state compact-empty"><div class="empty-symbol">A</div><h3>Analytics begin after assignment.</h3><p>Assign this template to a section to collect response and performance evidence.</p></div>';return;}

  const resultByStudent=new Map(results.filter(r=>r.complete===true).map(r=>[r.studentId,r]));
  const rows=questions.map(q=>{
    const points=Number(q.points||0),scores=[],totals=[],answers=new Map();
    for(const sub of subs){
      const res=resultByStudent.get(sub.studentId),grade=res?.grading?.[q.id];
      if(grade?.score!==undefined&&grade?.score!==null){
        scores.push(Number(grade.score||0));
        totals.push(Number(res.attemptPercent??res.percent??0));
      }
      const answer=sub.answers?.[q.id];
      if(answer!==undefined){
        const key=Array.isArray(answer)?answer.join(", "):String(answer);
        answers.set(key,(answers.get(key)||0)+1);
      }
    }
    const avgScore=scores.length?scores.reduce((x,y)=>x+y,0)/scores.length:null;
    const difficulty=avgScore!==null&&points?pct(avgScore,points):null;
    const discrimination=scores.length>=3?correlation(scores.map(x=>points?x/points*100:0),totals):null;
    return {q,attempts:scores.length,avgScore,difficulty,discrimination,answers};
  });

  const flagged=rows.filter(r=>(r.difficulty!==null&&(r.difficulty<30||r.difficulty>95))||(r.discrimination!==null&&r.discrimination<0));
  const assessmentAvg=results.filter(r=>r.complete===true).length
    ? Math.round(results.filter(r=>r.complete===true).reduce((n,r)=>n+Number(r.percent||0),0)/results.filter(r=>r.complete===true).length*10)/10
    : null;

  const actualByUnit=new Map(),unitLabels=new Map(),totalPoints=questions.reduce((n,q)=>n+Number(q.points||0),0);
  questions.forEach(q=>{
    const key=q.unitId||q.unitTitle||"Unmapped";
    actualByUnit.set(key,(actualByUnit.get(key)||0)+Number(q.points||0));
    unitLabels.set(key,q.unitTitle||"Unmapped / No Unit");
  });
  const blueprintExpected=new Map(safeArray(a.contentBlueprint).map(x=>[x.id,Number(x.weight||0)]));
  const blueprintLabels=new Map(safeArray(a.contentBlueprint).map(x=>[x.id,x.label||x.id]));
  const coverage=[...actualByUnit.entries()].map(([id,pts])=>{
    const actual=totalPoints?Math.round(pts/totalPoints*1000)/10:0;
    const expected=blueprintExpected.get(id);
    return {id,label:unitLabels.get(id)||blueprintLabels.get(id)||id,actual,expected,delta:expected===undefined?null:Math.round((actual-expected)*10)/10};
  });
  const mismatches=coverage.filter(x=>x.delta!==null&&Math.abs(x.delta)>=10);

  const unitPerformance=new Map(),topicPerformance=new Map(),competencyPerformance=new Map();
  for(const result of results.filter(r=>r.complete===true)){
    const grading=result.grading||{};
    for(const q of questions){
      const score=grading[q.id]?.score;
      if(score===undefined||score===null)continue;
      const max=Number(q.points||0);
      const unitKey=q.unitId||q.unitTitle||"Unmapped";
      const unit=unitPerformance.get(unitKey)||{label:q.unitTitle||"Unmapped / No Unit",earned:0,max:0,evidence:0};
      unit.earned+=Number(score||0);unit.max+=max;unit.evidence++;unitPerformance.set(unitKey,unit);
      const topicKey=q.topicId||q.topicNumber||q.topicTitle||"Unmapped";
      const topic=topicPerformance.get(topicKey)||{label:(q.topicNumber?q.topicNumber+" — ":"")+(q.topicTitle||"Unmapped / No Topic"),earned:0,max:0,evidence:0};
      topic.earned+=Number(score||0);topic.max+=max;topic.evidence++;topicPerformance.set(topicKey,topic);
      for(const code of safeArray(q.competencyCodes)){
        const key=String(code||"").trim().toUpperCase();if(!key)continue;
        const comp=competencyPerformance.get(key)||{label:key,earned:0,max:0,evidence:0};
        comp.earned+=Number(score||0);comp.max+=max;comp.evidence++;competencyPerformance.set(key,comp);
      }
    }
  }
  const unitRows=[...unitPerformance.values()].map(x=>({...x,percent:x.max?Math.round(x.earned/x.max*1000)/10:null})).sort((x,y)=>String(x.label).localeCompare(String(y.label)));
  const topicRows=[...topicPerformance.values()].map(x=>({...x,percent:x.max?Math.round(x.earned/x.max*1000)/10:null})).sort((x,y)=>String(x.label).localeCompare(String(y.label),undefined,{numeric:true}));
  const competencyRows=[...competencyPerformance.values()].map(x=>({...x,percent:x.max?Math.round(x.earned/x.max*1000)/10:null})).sort((x,y)=>String(x.label).localeCompare(String(y.label)));

  root.innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Completed Results</div><div class="summary-value">'+results.filter(r=>r.complete===true).length+'</div></div><div class="summary-block"><div class="summary-label">Assessment Avg</div><div class="summary-value">'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</div></div><div class="summary-block"><div class="summary-label">Questions</div><div class="summary-value">'+questions.length+'</div></div><div class="summary-block"><div class="summary-label">Items to Review</div><div class="summary-value">'+flagged.length+'</div></div></div>'+
    '<div class="page-actions analytics-actions"><button class="secondary-btn" data-classroom-action="recommended-practice" data-id="'+a.id+'">Assign Recommended Practice</button></div>'+
    (mismatches.length?'<div class="notice danger-notice"><strong>Blueprint coverage needs review.</strong><p>'+mismatches.map(x=>esc(x.label)+' is '+(x.delta>0?Math.abs(x.delta)+' points above':Math.abs(x.delta)+' points below')+' its intended content weight').join(" • ")+'</p></div>':'<div class="notice"><strong>Blueprint coverage check complete.</strong><p>No unit with an explicit target differs from its intended weight by 10 percentage points or more.</p></div>')+
    '<div class="content-skills-grid">'+
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Performance by Unit</div><div class="panel-subtitle">Scored evidence across completed candidates.</div></div></div><div class="panel-body">'+(unitRows.length?unitRows.map(x=>'<div class="blueprint-row"><span>'+esc(x.label)+' <small>'+x.evidence+' scored response'+(x.evidence===1?"":"s")+'</small></span><strong>'+esc(x.percent)+'%</strong></div>').join(""):'<div class="empty-mini">No scored unit evidence yet.</div>')+'</div></div>'+
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Performance by Topic</div><div class="panel-subtitle">Topic-level results aligned to the Course Guide.</div></div></div><div class="panel-body">'+(topicRows.length?topicRows.map(x=>'<div class="blueprint-row '+(x.percent<70?"needs-practice":"")+'"><span>'+esc(x.label)+' <small>'+x.evidence+' evidence point'+(x.evidence===1?"":"s")+'</small></span><strong>'+esc(x.percent)+'%</strong></div>').join(""):'<div class="empty-mini">No topic-mapped scored evidence yet.</div>')+'</div></div>'+
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Performance by Competency</div><div class="panel-subtitle">Questions with multiple competency tags contribute evidence to each tagged competency.</div></div></div><div class="panel-body">'+(competencyRows.length?competencyRows.map(x=>'<div class="blueprint-row '+(x.percent<70?"needs-practice":"")+'"><span>'+esc(x.label)+' <small>'+x.evidence+' evidence point'+(x.evidence===1?"":"s")+'</small></span><strong>'+esc(x.percent)+'%</strong></div>').join(""):'<div class="empty-mini">No competency-tagged scored evidence yet.</div>')+'</div></div>'+
    '</div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Question Performance</div><div class="panel-subtitle">Difficulty, discrimination, and response distributions help identify items that may need revision.</div></div></div><div class="panel-body" style="padding:0"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Question</th><th>Attempts</th><th>Difficulty</th><th>Discrimination</th><th>Response Pattern</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr class="'+(((r.difficulty!==null&&(r.difficulty<30||r.difficulty>95))||(r.discrimination!==null&&r.discrimination<0))?'analytics-flag':'')+'"><td><strong>Q'+(i+1)+'</strong><span class="grade-sub">'+esc(r.q.type||"Question")+' • '+esc((r.q.prompt||"").slice(0,90))+'</span></td><td>'+r.attempts+'</td><td>'+(r.difficulty===null?"—":r.difficulty+"%")+'</td><td>'+(r.discrimination===null?"—":r.discrimination)+'</td><td>'+([...(r.answers||new Map()).entries()].length?[...r.answers.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>'<span class="analytics-answer">'+esc(k||"(blank)")+': '+v+'</span>').join(" "):"—")+'</td></tr>').join("")+'</tbody></table></div></div></div>';
}

/* -------------------- DASHBOARD INTELLIGENCE -------------------- */

async function renderInstructorAttention(){
  const el=$("#homeAttention"),s=state();if(!el||s?.role!=="instructor")return;
  let grading=0,entrance=0,unmapped=0,archived=0,missingPathways=0,readyToCertify=0,upcoming=0,appeals=0,withdrawalRequests=0;
  const now=Date.now(),soon=now+7*86400000;
  for(const section of s.sections||[]){
    if(section.status==="Archived"){archived++;continue;}
    try{
      const [members,pathways,records,appealSnap,refs,withdrawalSnap]=await Promise.all([
        getDocs(collection(db,"sections",section.id,"members")),
        getDocs(collection(db,"sections",section.id,"gradingPathways")),
        getDocs(collection(db,"sections",section.id,"academicRecords")),
        getDocs(collection(db,"sections",section.id,"appeals")),
        getDocs(collection(db,"sections",section.id,"assessmentRefs")),
        getDocs(collection(db,"sections",section.id,"withdrawalRequests"))
      ]);
      const pathwayIds=new Set(pathways.docs.map(d=>d.id)),recordMap=new Map(records.docs.map(d=>[d.id,d.data()]));
      missingPathways+=members.docs.filter(d=>!pathwayIds.has(d.id)).length;
      readyToCertify+=members.docs.filter(d=>pathwayIds.has(d.id)&&recordMap.get(d.id)?.status!=="Certified").length;
      appeals+=appealSnap.docs.filter(d=>["Pending","Under Review"].includes(d.data().status)).length;
      withdrawalRequests+=withdrawalSnap.docs.filter(d=>d.data().status==="Pending").length;
      upcoming+=refs.docs.filter(d=>{const data=d.data(),t=data.opensAt?.toMillis?.();return t&&t>=now&&t<=soon;}).length;
    }catch(_){}
    try{
      const assessments=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
      for(const aDoc of assessments.docs){
        const a=aDoc.data();
        const subs=await getDocs(collection(db,"assessments",aDoc.id,"submissions"));
        const results=await getDocs(collection(db,"assessments",aDoc.id,"results"));
        const complete=new Set(results.docs.filter(d=>d.data().complete===true).map(d=>d.id));
        grading+=subs.docs.filter(d=>["submitted","graded"].includes(d.data().status)&&!complete.has(d.id)).length;
        if(a.entranceExam)entrance+=subs.docs.filter(d=>d.data().status==="submitted"&&!complete.has(d.id)).length;
        unmapped+=Number(a.competencyBlueprintUnmappedPoints||0)>0?1:0;
      }
    }catch(_){}
  }
  el.innerHTML='<div class="instructor-action-inbox"><div class="page-head compact-head"><div><div class="panel-title">Instructor Action Inbox</div><p class="page-subtitle">Academic work that needs attention across your active sections.</p></div></div><div class="attention-list">'+
    '<div class="attention-item"><div class="attention-number">'+grading+'</div><div class="attention-copy"><strong>Submissions needing evaluation</strong><span>'+(grading?"Open Assessments or a section Gradebook to continue grading.":"No submitted assessments are waiting for evaluation.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+entrance+'</div><div class="attention-copy"><strong>Entrance candidates awaiting evaluation</strong><span>'+(entrance?"These candidates cannot complete enrollment until their entrance results are evaluated.":"No entrance candidates are currently waiting on grading.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+missingPathways+'</div><div class="attention-copy"><strong>Students missing grading pathways</strong><span>'+(missingPathways?"These students need an Examination or Composite pathway selection.":"Every current student has selected a grading pathway.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+readyToCertify+'</div><div class="attention-copy"><strong>Certification review queue</strong><span>'+(readyToCertify?"Review Records to identify students whose components are complete and certify final grades.":"No uncertified pathway students are in the review queue.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+appeals+'</div><div class="attention-copy"><strong>Open grade appeals</strong><span>'+(appeals?"Resolve appeals before final certification when applicable.":"No unresolved grade appeals.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+withdrawalRequests+'</div><div class="attention-copy"><strong>Pending withdrawal requests</strong><span>'+(withdrawalRequests?"Open Academic Operations in the relevant section to review and certify requests.":"No student withdrawal requests are waiting for review.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+upcoming+'</div><div class="attention-copy"><strong>Assessments opening this week</strong><span>'+(upcoming?"Review schedules, security, and accommodations before administration.":"No scheduled assessment opens in the next seven days.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+unmapped+'</div><div class="attention-copy"><strong>Assessments with unmapped competency evidence</strong><span>'+(unmapped?"Review Question Bank competency tags to strengthen blueprint coverage.":"Current assessment questions are mapped to competency evidence.")+'</span></div></div>'+
    (archived?'<div class="attention-item"><div class="attention-number">'+archived+'</div><div class="attention-copy"><strong>Archived sections</strong><span>Historical teaching spaces remain available from Sections.</span></div></div>':'')+
  '</div></div>';
}


/* -------------------- WITHDRAWAL REQUESTS + ACADEMIC STANDING -------------------- */

async function withdrawalRequestModal(sectionId){
  const s=state(),section=s?.currentSection;if(!s?.user||s.role!=="student"||!section||section.id!==sectionId)return;
  let existing=null;
  try{
    const snap=await getDoc(doc(db,"sections",sectionId,"withdrawalRequests",s.user.uid));
    if(snap.exists())existing={id:snap.id,...snap.data()};
  }catch(_){}
  if(existing?.status==="Pending"){
    const m=modal({
      eyebrow:"Enrollment Withdrawal",
      title:"Pending Withdrawal Request",
      body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>Your request is awaiting instructor review.</h3><p>Withdrawing does not erase this course from your academic history. If approved, the instructor will complete the withdrawal-grade certification process and the course will remain visible on your transcript as Withdrawn.</p></div><div class="notice"><strong>Your submitted reason</strong><p>'+esc(existing.reason||"")+'</p></div>',
      footer:'<button class="secondary-btn" data-close-modal>Close</button><button class="danger-btn" id="cancelWithdrawalRequest">Cancel Request</button>'
    });
    m.querySelector("#cancelWithdrawalRequest").onclick=async()=>{
      try{
        await updateDoc(doc(db,"sections",sectionId,"withdrawalRequests",s.user.uid),{status:"Cancelled",cancelledAt:serverTimestamp(),updatedAt:serverTimestamp()});
        closeModal();toast("Withdrawal request cancelled.");await core().reloadCurrentSection("overview");
      }catch(error){toast(error.message||"Unable to cancel the withdrawal request.");}
    };
    return;
  }
  if(existing&&["Certified","Approved"].includes(existing.status))return toast("This withdrawal request has already been resolved.");
  const m=modal({
    eyebrow:"Enrollment Withdrawal",
    title:"Request Withdrawal — "+(section.courseCode||section.courseTitle||"Course"),
    wide:true,
    body:'<form id="withdrawalRequestForm"><div class="academic-banner"><div class="kicker">Student Request</div><h3>Request instructor review before ending enrollment.</h3><p>The request does not immediately remove you from the section. If approved, your instructor will certify your withdrawal record. The withdrawn course remains on your transcript and does not count as completed-course prerequisite credit.</p></div><div class="field"><label>Reason for Withdrawal</label><textarea name="reason" rows="7" required placeholder="Explain why you are requesting withdrawal from this course.">'+esc(existing?.reason||"")+'</textarea></div><label class="checkbox-line"><input type="checkbox" name="ack" required> I understand that an approved withdrawal remains part of my academic history.</label><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" type="submit">Submit Withdrawal Request</button></div></form>'
  });
  m.querySelector("#withdrawalRequestForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),reason=String(fd.get("reason")||"").trim();if(!reason)return;
    try{
      await setDoc(doc(db,"sections",sectionId,"withdrawalRequests",s.user.uid),{
        studentId:s.user.uid,studentName:s.profile?.displayName||s.user.displayName||"Student",studentEmail:s.user.email||"",
        sectionId,courseId:section.courseId||"",courseCode:section.courseCode||"",courseTitle:section.courseTitle||"",
        sectionName:section.sectionName||"",term:section.term||"",reason,status:"Pending",
        requestedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      closeModal();toast("Withdrawal request submitted for instructor review.");await core().reloadCurrentSection("overview");
    }catch(error){toast(error.message||"Unable to submit the withdrawal request.");}
  };
}

async function withdrawalRequestsModal(sectionId){
  const section=currentSection();if(!section||section.id!==sectionId||!canOwnSection(section))return;
  let rows=[];
  try{
    const snap=await getDocs(collection(db,"sections",sectionId,"withdrawalRequests"));
    rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>toMillis(b.requestedAt)-toMillis(a.requestedAt));
  }catch(error){return toast("Unable to load withdrawal requests.");}
  const pending=rows.filter(x=>x.status==="Pending");
  modal({
    eyebrow:"Enrollment Lifecycle",
    title:"Withdrawal Requests",
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+pending.length+' pending request'+(pending.length===1?"":"s")+'</h3><p>Approval routes through formal withdrawal-grade certification. Denial preserves the request and instructor rationale in the request record.</p></div>'+
      (rows.length?'<div class="withdrawal-request-list">'+rows.map(row=>'<article class="withdrawal-request-card"><div><div class="card-kicker">'+esc(row.status||"Pending")+'</div><h3>'+esc(row.studentName||"Student")+'</h3><p>'+esc(row.reason||"")+'</p><small>'+esc(row.studentEmail||"")+'</small></div><div class="withdrawal-request-actions">'+(row.status==="Pending"?'<button class="primary-btn small-btn" data-phase5-action="approve-withdrawal-request" data-id="'+row.id+'">Approve & Certify</button><button class="secondary-btn small-btn" data-phase5-action="deny-withdrawal-request" data-id="'+row.id+'">Deny</button>':'<span class="badge '+(row.status==="Certified"?"live":row.status==="Denied"?"closed":"")+'">'+esc(row.status)+'</span>')+'</div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">W</div><h3>No withdrawal requests.</h3><p>Student requests will appear here for formal review.</p></div>'),
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function approveWithdrawalRequest(sectionId,requestId){
  let request=null;
  try{const snap=await getDoc(doc(db,"sections",sectionId,"withdrawalRequests",requestId));if(snap.exists())request={id:snap.id,...snap.data()};}catch(_){}
  if(!request||request.status!=="Pending")return toast("This request is no longer pending.");
  closeModal();
  return window.TheoriaPhase4?.withdrawalCertificationModal?.(sectionId,request.studentId||requestId,{
    requestId:request.id,requestReason:request.reason||"Student-requested withdrawal"
  });
}
async function denyWithdrawalRequest(sectionId,requestId){
  const reason=prompt("Reason for denying this withdrawal request?")?.trim();if(!reason)return;
  try{
    await updateDoc(doc(db,"sections",sectionId,"withdrawalRequests",requestId),{
      status:"Denied",denialReason:reason,resolvedAt:serverTimestamp(),resolvedBy:state().user.uid,updatedAt:serverTimestamp()
    });
    await logSectionEvent(sectionId,"withdrawal_request_denied","student",requestId,{reason});
    closeModal();toast("Withdrawal request denied.");await withdrawalRequestsModal(sectionId);
  }catch(error){toast(error.message||"Unable to deny the withdrawal request.");}
}

async function academicStandingModal(studentId){
  const section=currentSection(),student=state()?.sectionData?.members?.find(x=>x.id===studentId);
  if(!section||!student||!canOwnSection(section))return;
  const standing=student.academicStanding||"Good Standing";
  const m=modal({
    eyebrow:"Academic Standing",
    title:student.displayName||"Student",
    body:'<form id="academicStandingForm"><div class="field"><label>Standing</label><select name="standing"><option>Good Standing</option><option>Academic Warning</option><option>Incomplete</option></select></div><div class="field"><label>Administrative Note</label><textarea name="note" placeholder="Optional context preserved in the audit log.">'+esc(student.academicStandingNote||"")+'</textarea></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Standing</button></div></form>'
  });
  m.querySelector('[name="standing"]').value=standing;
  m.querySelector("#academicStandingForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),next=String(fd.get("standing")),note=String(fd.get("note")||"").trim();
    try{
      await updateDoc(doc(db,"sections",section.id,"members",studentId),{academicStanding:next,academicStandingNote:note,academicStandingUpdatedAt:serverTimestamp(),updatedAt:serverTimestamp()});
      await logSectionEvent(section.id,"academic_standing_updated","student",studentId,{prior:standing,newStanding:next,note});
      closeModal();await core().reloadCurrentSection("students");toast("Academic standing updated.");
    }catch(error){toast(error.message||"Unable to update academic standing.");}
  };
}

/* -------------------- SECTION UI ENHANCEMENT -------------------- */

async function sectionStaffRole(sectionId){
  const s=state();if(!s?.user)return null;
  if(currentSection()?.ownerId===s.user.uid)return "owner";
  try{const snap=await getDoc(doc(db,"sections",sectionId,"staff",s.user.uid));return snap.exists()?snap.data().role:null;}catch(_){return null;}
}

async function enhanceSection(section,tab){
  if(!section)return;
  const s=state();
  if(s?.role==="student"){
    if(tab==="overview"&&section.status!=="Archived"){
      const hero=$("#sectionDetail .detail-hero .detail-top .inline-actions");
      if(hero&&!hero.querySelector('[data-phase5-action="request-withdrawal"]')){
        let pending=false;
        try{const snap=await getDoc(doc(db,"sections",section.id,"withdrawalRequests",s.user.uid));pending=snap.exists()&&snap.data().status==="Pending";}catch(_){}
        hero.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-phase5-action="request-withdrawal" data-section="'+section.id+'">'+(pending?'Withdrawal Pending':'Request Withdrawal')+'</button>');
      }
    }
    return;
  }
  if(!isInstructor())return;
  const hero=$("#sectionDetail .detail-hero .detail-top .inline-actions");
  if(hero&&!hero.querySelector("[data-phase5-action]")){
    const role=await sectionStaffRole(section.id);
    if(role==="owner"){
      hero.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-phase5-action="section-operations" data-section="'+section.id+'">Academic Operations</button>');
    }else if(role){
      hero.insertAdjacentHTML("beforeend",'<span class="badge">'+esc(ROLE_LABELS[role]||role)+'</span>');
    }
  }
  if(section.status==="Archived"){
    $("#sectionDetail")?.classList.add("archived-section-view");
    $("#sectionDetail")?.querySelectorAll("[data-action],[data-phase3-action],[data-phase4-action]").forEach(button=>{
      const action=button.dataset.action||button.dataset.phase3Action||button.dataset.phase4Action||"";
      const allowed=new Set(["section-tab","back-sections","open-assessment","assessment-tab","record-audit","record-history","portfolio","print-record","student-assessment-details","student-assessment-results","receipt","gradebook-jump"]);
      if(!allowed.has(action))button.classList.add("hidden");
    });
    const hero=$("#sectionDetail .detail-hero");
    if(hero&&!hero.querySelector(".archived-readonly-banner"))hero.insertAdjacentHTML("afterend",'<div class="notice archived-readonly-banner"><strong>Archived section — read only.</strong><span>Academic records, assessments, grades, and history are preserved. Restore the section from Academic Operations to resume teaching changes.</span></div>');
  }
  if(tab==="students"){
    const table=$("#sectionTabBody .data-table tbody");
    if(table&&canOwnSection(section)){
      [...table.querySelectorAll("tr")].forEach((tr,index)=>{
        const student=state().sectionData?.members?.[index];if(!student)return;
        const cell=tr.lastElementChild;
        if(cell&&!cell.querySelector("[data-phase5-action]")){
          cell.insertAdjacentHTML("beforeend",' <button class="text-btn" data-phase5-action="lifecycle-menu" data-student="'+student.id+'">Lifecycle</button>');
        }
      });
    }
  }
}

function sectionOperationsModal(sectionId){
  const section=currentSection();if(!section||section.id!==sectionId)return;
  const archived=section.status==="Archived";
  modal({
    eyebrow:"Academic Operations",
    title:section.sectionName||section.courseTitle,
    wide:true,
    body:'<div class="operations-grid">'+
      '<button class="operation-card" data-phase5-action="staff-management" data-section="'+sectionId+'"><span>01</span><strong>Staff & Permissions</strong><small>Coordinator, Teaching Assistant, and Grader roles.</small></button>'+
      '<button class="operation-card" data-phase5-action="enrollment-history" data-section="'+sectionId+'"><span>02</span><strong>Enrollment Lifecycle</strong><small>Review removals, withdrawals, reinstatements, and completions.</small></button>'+
      '<button class="operation-card" data-phase5-action="audit-log" data-section="'+sectionId+'"><span>03</span><strong>Academic Audit Log</strong><small>Review important administrative and academic changes.</small></button>'+
      '<button class="operation-card" data-phase5-action="grade-history" data-section="'+sectionId+'"><span>04</span><strong>Grade Change History</strong><small>Audit grade overrides, assessment results, rubric changes, and grading-period locks.</small></button>'+
      '<button class="operation-card" data-phase5-action="withdrawal-requests" data-section="'+sectionId+'"><span>05</span><strong>Withdrawal Requests</strong><small>Review student requests and route approvals through formal grade certification.</small></button>'+
      '<button class="operation-card '+(archived?'':'danger-operation')+'" data-phase5-action="'+(archived?'restore-section':'archive-section')+'" data-section="'+sectionId+'"><span>06</span><strong>'+(archived?'Restore Section':'Archive Section')+'</strong><small>'+(archived?'Return this section to active teaching.':'Preserve records while removing the section from active teaching.')+'</small></button>'+
    '</div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

function lifecycleMenu(studentId){
  const student=state()?.sectionData?.members?.find(x=>x.id===studentId);if(!student)return;
  modal({
    eyebrow:"Enrollment Lifecycle",
    title:student.displayName||"Student",
    body:'<div class="operations-grid compact-operations"><button class="operation-card" data-phase5-action="academic-standing" data-student="'+studentId+'"><span>A</span><strong>Academic Standing</strong><small>Record Good Standing, Academic Warning, or Incomplete with an audited note.</small></button><button class="operation-card" data-phase5-action="student-approvals" data-student="'+studentId+'"><span>↗</span><strong>Course Readiness Approval</strong><small>Grant manual instructor approval for progression-gated courses.</small></button><button class="operation-card" data-phase5-action="set-lifecycle" data-student="'+studentId+'" data-status="Completed"><span>✓</span><strong>Mark Completed</strong><small>Preserve section access and mark course participation complete.</small></button><button class="operation-card danger-operation" data-phase5-action="withdraw-certify" data-student="'+studentId+'"><span>W</span><strong>Withdraw & Certify</strong><small>Waive unfinished assessments, certify a coursework-based final grade, decide whether an adjustment is permitted, then close enrollment.</small></button><button class="operation-card danger-operation" data-phase5-action="set-lifecycle" data-student="'+studentId+'" data-status="Removed"><span>×</span><strong>Remove</strong><small>Remove active access while preserving academic evidence and history.</small></button></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button>'
  });
}

/* -------------------- COURSE UI ENHANCEMENT -------------------- */

function enhanceCourse(course){
  const c=course||state()?.currentCourse;if(!c||!isInstructor())return;
  const actions=$("#courseDetail .detail-hero .inline-actions, #courseDetail .detail-top .inline-actions");
  if(actions&&!actions.querySelector('[data-phase5-action="manage-prerequisites"]')&&(state().isSystemOwner||core().canManageCourse(c))){
    actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-phase5-action="manage-prerequisites" data-course="'+c.id+'">Progression</button>');
  }
  if(actions&&!actions.querySelector('[data-phase5-action="course-staff"]')&&(state().isSystemOwner||c.ownerId===state().user.uid)){
    actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-phase5-action="course-staff" data-course="'+c.id+'">Course Staff</button>');
  }
  if(actions&&c.courseStaffRole==="coordinator"&&!actions.querySelector(".course-coordinator-badge")){
    actions.insertAdjacentHTML("beforeend",'<span class="badge live course-coordinator-badge">Course Coordinator</span>');
  }
}

async function courseStaffManagementModal(courseId){
  const course=courseById(courseId);if(!course)return;
  const s=state();
  if(!(s.isSystemOwner||course.ownerId===s.user.uid))return toast("Only the System Owner or course owner can manage Course Coordinators.");
  let staff=[];
  try{
    const snap=await getDocs(collection(db,"courses",courseId,"staff"));
    staff=snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(_){}

  const m=modal({
    eyebrow:"Course Governance",
    title:"Course Coordinators — "+(course.code||course.title),
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">Master Course Role</div><h3>'+esc(course.code+" — "+course.title)+'</h3><p>Course Coordinators can maintain the framework, competencies, Question Bank, course metadata, and progression policy without receiving System Owner catalog-governance powers.</p></div>'+
      '<div class="panel"><div class="panel-head"><div class="panel-title">Current Course Coordinators</div></div><div class="panel-body">'+(staff.length?staff.map(x=>'<div class="staff-role-row"><div><strong>'+esc(x.displayName||x.email||x.id)+'</strong><span>'+esc(x.email||"")+'</span></div><span class="badge live">Course Coordinator</span><button class="text-btn danger-text" data-phase5-action="remove-course-staff" data-course="'+courseId+'" data-user="'+x.id+'">Remove</button></div>').join(""):'<div class="empty-mini">No Course Coordinators assigned.</div>')+'</div></div>'+
      '<form id="addCourseStaffForm" class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">Add Course Coordinator</div></div><div class="panel-body"><div class="field"><label>Instructor Email</label><input name="email" type="email" required placeholder="instructor@example.com"></div><button class="primary-btn" type="submit">Add Course Coordinator</button></div></form>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });

  m.querySelector("#addCourseStaffForm").onsubmit=async e=>{
    e.preventDefault();const email=String(new FormData(e.currentTarget).get("email")||"").trim().toLowerCase();
    try{
      const qSnap=await getDocs(query(collection(db,"directory"),where("email","==",email)));
      const userDoc=qSnap.docs.find(d=>d.data().role==="instructor");
      if(!userDoc)return toast("No instructor account with that email is available in the Theoria directory.");
      if(userDoc.id===course.ownerId)return toast("The course owner already has full course access.");
      const user=userDoc.data();
      await setDoc(doc(db,"courses",courseId,"staff",userDoc.id),{
        userId:userDoc.id,displayName:user.displayName||email,email,role:"coordinator",
        addedBy:s.user.uid,addedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      await logCourseEvent(courseId,"course_coordinator_added","user",userDoc.id,{email});
      closeModal();toast("Course Coordinator added.");await courseStaffManagementModal(courseId);
    }catch(error){toast(error.message||"Unable to add the Course Coordinator.");}
  };
}

async function removeCourseStaff(courseId,userId){
  const course=courseById(courseId),s=state();if(!course||!(s.isSystemOwner||course.ownerId===s.user.uid))return;
  if(!confirm("Remove this Course Coordinator?"))return;
  try{
    await deleteDoc(doc(db,"courses",courseId,"staff",userId));
    await logCourseEvent(courseId,"course_coordinator_removed","user",userId,{});
    closeModal();toast("Course Coordinator removed.");await courseStaffManagementModal(courseId);
  }catch(error){toast(error.message||"Unable to remove the Course Coordinator.");}
}

/* -------------------- EVENT WIRING -------------------- */

async function onReady(){
  await ensureDirectoryEntry();
  renderInstructorAttention();
  if($("#page-progression")?.classList.contains("active"))renderProgression();
  if($("#page-academic-profile")?.classList.contains("active"))renderAcademicProfile();
}

window.addEventListener("theoria:ready",onReady);
window.addEventListener("theoria:page",e=>{
  if(e.detail.page==="home")renderInstructorAttention();
  if(e.detail.page==="progression")renderProgression();
  if(e.detail.page==="academic-profile")renderAcademicProfile();
});

document.addEventListener("click",e=>{
  const s=state(),section=s?.currentSection;
  if(!section)return;
  const actionEl=e.target.closest("[data-action],[data-phase3-action],[data-phase4-action],[data-phase5-action]");
  if(!actionEl)return;
  const action=actionEl.dataset.action||actionEl.dataset.phase3Action||actionEl.dataset.phase4Action||actionEl.dataset.phase5Action||"";
  const safeActions=new Set([
    "section-tab","back-sections","open-section","gradebook-jump","student-assessment-details","student-assessment-results",
    "assessment-tab","open-assessment","back-assessments","receipt","print-record","record-history","mastery-student",
    "open-mastery-section","mastery-back","reports-back","audit-log","enrollment-history","restore-section","section-operations"
  ]);
  if(section.status==="Archived"&&!safeActions.has(action)){
    e.preventDefault();e.stopImmediatePropagation();toast("Archived sections are read-only. Restore the section before making academic changes.");return;
  }

  const role=section.staffRole&&section.staffRole!=="owner"?section.staffRole:"owner";
  if(role==="grader"){
    const allowed=new Set([
      ...safeActions,"grade-candidate","auto-score","horizontal-grade","open-gradebook-assessment","set-grade",
      "record-audit","open-section-resource"
    ]);
    if(!allowed.has(action)){
      e.preventDefault();e.stopImmediatePropagation();toast("Your Grader role does not include this section-administration action.");return;
    }
  }
  if(role==="teaching_assistant"){
    const blocked=new Set(["edit-section","delete-section","archive-section","staff-management","manage-prerequisites","certify-record","mark-incomplete","review-appeal","portfolio"]);
    if(blocked.has(action)){
      e.preventDefault();e.stopImmediatePropagation();toast("Your Teaching Assistant role does not include this administrative action.");return;
    }
  }
},true);

document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-phase5-action]");if(!b)return;
  const a=b.dataset.phase5Action;
  if(a==="manage-prerequisites")return prerequisiteModal(b.dataset.course);
  if(a==="course-staff")return courseStaffManagementModal(b.dataset.course);
  if(a==="remove-course-staff")return removeCourseStaff(b.dataset.course,b.dataset.user);
  if(a==="section-operations")return sectionOperationsModal(b.dataset.section);
  if(a==="request-withdrawal")return withdrawalRequestModal(b.dataset.section);
  if(a==="withdrawal-requests"){closeModal();return withdrawalRequestsModal(b.dataset.section);}
  if(a==="approve-withdrawal-request")return approveWithdrawalRequest(state()?.currentSection?.id,b.dataset.id);
  if(a==="deny-withdrawal-request")return denyWithdrawalRequest(state()?.currentSection?.id,b.dataset.id);
  if(a==="academic-standing"){closeModal();return academicStandingModal(b.dataset.student);}
  if(a==="archive-section"){closeModal();return archiveSection(b.dataset.section);}
  if(a==="restore-section"){closeModal();return restoreSection(b.dataset.section);}
  if(a==="staff-management"){closeModal();return staffManagementModal(b.dataset.section);}
  if(a==="remove-staff")return removeStaff(b.dataset.section,b.dataset.user);
  if(a==="enrollment-history"){closeModal();return enrollmentHistoryModal(b.dataset.section);}
  if(a==="reinstate-student"){closeModal();return reinstateStudent(b.dataset.section,b.dataset.student);}
  if(a==="audit-log"){closeModal();return auditLogModal(b.dataset.section);}
  if(a==="grade-history"){closeModal();return gradeHistoryModal(b.dataset.section);}
  if(a==="lifecycle-menu")return lifecycleMenu(b.dataset.student);
  if(a==="withdraw-certify"){closeModal();const sectionId=state()?.currentSection?.id;if(!sectionId)return toast("Open the section before certifying a withdrawal.");return window.TheoriaPhase4?.withdrawalCertificationModal?.(sectionId,b.dataset.student);}
  if(a==="set-lifecycle"){closeModal();return setEnrollmentLifecycle(b.dataset.student,b.dataset.status);}
  if(a==="student-approvals"){closeModal();return studentApprovalsModal(b.dataset.student);}
  if(a==="approve-progression"){closeModal();await approveProgression(b.dataset.course,b.dataset.student);return studentApprovalsModal(b.dataset.student);}
});

window.TheoriaPhase5={
  renderProgression,
  renderAcademicProfile,
  renderAssessmentAnalytics,
  enhanceSection,
  enhanceCourse,
  logSectionEvent,
  logCourseEvent,
  renderInstructorAttention,
  evaluateEnrollmentEligibility
};

if(window.TheoriaCore)onReady();
