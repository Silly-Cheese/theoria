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
    const records=evidence.records.filter(r=>r.courseId===requiredId&&r.status==="Certified");
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

  m.querySelector("#prerequisiteForm").onsubmit=async e=>{
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
      instructorApproval:e.currentTarget.elements.instructorApproval.checked,
      updatedAt:serverTimestamp()
    };
    try{
      await updateDoc(doc(db,"courses",course.id),{
        prerequisitePolicy,
        entranceExamRequired:e.currentTarget.elements.entranceExamRequired.checked,
        updatedAt:serverTimestamp()
      });
      Object.assign(course,{prerequisitePolicy,entranceExamRequired:e.currentTarget.elements.entranceExamRequired.checked});
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
  let persistentAccess={},entranceAttempts=[];
  try{
    const accessSnap=await getDoc(doc(db,"academicAccess",s.user.uid));
    if(accessSnap.exists())persistentAccess=accessSnap.data();
  }catch(_){}
  try{
    const entranceSnap=await getDocs(collection(db,"users",s.user.uid,"entranceAttempts"));
    entranceAttempts=entranceSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>toMillis(b.updatedAt||b.createdAt)-toMillis(a.updatedAt||a.createdAt));
  }catch(_){}
  const defaults=persistentAccess.accommodations||profile.defaultAccommodations||{};
  const completed=evidence.records.filter(r=>r.status==="Certified");
  const comps=new Map();
  evidence.mastery.forEach(m=>safeArray(m.competencies).forEach(c=>{
    const key=String(c.code||"").toUpperCase();
    if(!key)return;
    if(!comps.has(key)||Number(c.percent||0)>Number(comps.get(key).percent||0))comps.set(key,c);
  }));

  el.innerHTML='<div class="academic-banner"><div class="kicker">Student Academic Profile</div><h3>'+esc(profile.displayName||s.user.displayName||"Student")+'</h3><p>Completed courses, competency evidence, current enrollment, entrance examinations, and default assessment-access preferences in one academic profile.</p></div>'+
    '<div class="student-profile-summary"><div><span>Current Sections</span><strong>'+esc((s.sections||[]).filter(x=>x.status!=="Archived").length)+'</strong></div><div><span>Certified Courses</span><strong>'+completed.length+'</strong></div><div><span>Competencies Evidenced</span><strong>'+comps.size+'</strong></div><div><span>Entrance Exams</span><strong>'+entranceAttempts.length+'</strong></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Completed Courses</div></div><div class="panel-body">'+(completed.length?completed.map(r=>'<div class="profile-record-row"><div><strong>'+esc(r.courseCode+" — "+r.courseTitle)+'</strong><span>'+esc(r.term||"")+'</span></div><b>'+esc(r.letterGrade||"—")+' • '+esc(r.finalPercent??"—")+'%</b></div>').join(""):'<div class="empty-mini">No certified course records yet.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Strongest Competency Evidence</div></div><div class="panel-body">'+([...comps.values()].length?[...comps.values()].sort((a,b)=>Number(b.percent||0)-Number(a.percent||0)).slice(0,8).map(c=>'<div class="profile-record-row"><div><strong>'+esc(c.code||"Competency")+'</strong><span>'+esc(c.name||"")+'</span></div><b>'+esc(c.percent??"—")+'%</b></div>').join(""):'<div class="empty-mini">No competency evidence yet.</div>')+'</div></div></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div class="panel-title">Entrance Examination History</div></div><div class="panel-body">'+(entranceAttempts.length?entranceAttempts.map(x=>'<div class="profile-record-row"><div><strong>'+esc((x.courseCode||"Course")+' — '+(x.assessmentTitle||"Entrance Examination"))+'</strong><span>'+esc(x.sectionName||"")+' • Required '+esc(x.passPercent||70)+'%</span></div><b class="'+(x.status==="passed"?'status-success':x.status==="failed"?'status-danger':'')+'">'+esc(String(x.status||"pending").replace(/_/g," "))+(x.percent!==null&&x.percent!==undefined?' • '+esc(x.percent)+'%':'')+'</b></div>').join(""):'<div class="empty-mini">No entrance examination attempts recorded.</div>')+'</div></div>'+
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
  modal({
    eyebrow:"Enrollment Lifecycle",
    title:"Enrollment History",
    wide:true,
    body:rows.length?'<div class="audit-timeline">'+rows.map(r=>'<div class="audit-event"><div class="audit-event-mark">'+(r.status==="Removed"?"×":r.status==="Completed"?"✓":"•")+'</div><div><strong>'+esc(r.studentName||"Student")+' — '+esc(r.status||"Status")+'</strong><span>'+esc(r.reason||"")+'</span><small>'+esc(r.actorName||"System")+'</small></div></div>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">E</div><h3>No enrollment history yet.</h3><p>Withdrawals, removals, reinstatements, and completions will appear here.</p></div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

async function setEnrollmentLifecycle(studentId,status){
  const section=currentSection(),s=state();if(!section||!s?.sectionData)return;
  if(!canOwnSection(section))return toast("Only the section owner can change enrollment lifecycle status.");
  const student=s.sectionData.members.find(x=>x.id===studentId);if(!student)return;
  const reason=prompt("Reason for "+status.toLowerCase()+"?")||"";
  try{
    if(status==="Completed"){
      await updateDoc(doc(db,"sections",section.id,"members",studentId),{status:"completed",completedAt:serverTimestamp(),updatedAt:serverTimestamp()});
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
        totals.push(Number(res.percent||0));
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

  const actualByUnit=new Map(),totalPoints=questions.reduce((n,q)=>n+Number(q.points||0),0);
  questions.forEach(q=>{
    const key=q.unitId||q.unitTitle||"Unmapped";
    actualByUnit.set(key,(actualByUnit.get(key)||0)+Number(q.points||0));
  });
  const blueprintExpected=new Map(safeArray(a.contentBlueprint).map(x=>[x.id,Number(x.weight||0)]));
  const coverage=[...actualByUnit.entries()].map(([id,pts])=>{
    const actual=totalPoints?Math.round(pts/totalPoints*1000)/10:0;
    const expected=blueprintExpected.get(id);
    return {id,actual,expected,delta:expected===undefined?null:Math.round((actual-expected)*10)/10};
  });
  const mismatches=coverage.filter(x=>x.delta!==null&&Math.abs(x.delta)>=10);

  root.innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Completed Results</div><div class="summary-value">'+results.filter(r=>r.complete===true).length+'</div></div><div class="summary-block"><div class="summary-label">Assessment Avg</div><div class="summary-value">'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</div></div><div class="summary-block"><div class="summary-label">Questions</div><div class="summary-value">'+questions.length+'</div></div><div class="summary-block"><div class="summary-label">Items to Review</div><div class="summary-value">'+flagged.length+'</div></div></div>'+
    (mismatches.length?'<div class="notice danger-notice"><strong>Blueprint coverage needs review.</strong><p>'+mismatches.map(x=>'A unit differs from its intended content weight by '+Math.abs(x.delta)+' points').join(" • ")+'</p></div>':'<div class="notice"><strong>Blueprint coverage check complete.</strong><p>No unit with an explicit target differs from its intended weight by 10 percentage points or more.</p></div>')+
    '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Question</th><th>Attempts</th><th>Difficulty</th><th>Discrimination</th><th>Response Pattern</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr class="'+(((r.difficulty!==null&&(r.difficulty<30||r.difficulty>95))||(r.discrimination!==null&&r.discrimination<0))?'analytics-flag':'')+'"><td><strong>Q'+(i+1)+'</strong><span class="grade-sub">'+esc(r.q.type||"Question")+' • '+esc((r.q.prompt||"").slice(0,90))+'</span></td><td>'+r.attempts+'</td><td>'+(r.difficulty===null?"—":r.difficulty+"%")+'</td><td>'+(r.discrimination===null?"—":r.discrimination)+'</td><td>'+([...(r.answers||new Map()).entries()].length?[...r.answers.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>'<span class="analytics-answer">'+esc(k||"(blank)")+': '+v+'</span>').join(" "):"—")+'</td></tr>').join("")+'</tbody></table></div>';
}

/* -------------------- DASHBOARD INTELLIGENCE -------------------- */

async function renderInstructorAttention(){
  const el=$("#homeAttention"),s=state();if(!el||s?.role!=="instructor")return;
  let grading=0,entrance=0,unmapped=0,archived=0;
  for(const section of s.sections||[]){
    if(section.status==="Archived"){archived++;continue;}
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
  el.innerHTML='<div class="attention-list">'+
    '<div class="attention-item"><div class="attention-number">'+grading+'</div><div class="attention-copy"><strong>Submissions needing evaluation</strong><span>'+ (grading?"Open Assessments or a section Gradebook to continue grading.":"No submitted assessments are waiting for evaluation.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+entrance+'</div><div class="attention-copy"><strong>Entrance examinations awaiting evaluation</strong><span>'+ (entrance?"These candidates cannot complete enrollment until their entrance results are evaluated.":"No entrance candidates are currently waiting on grading.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+unmapped+'</div><div class="attention-copy"><strong>Assessments with unmapped competency evidence</strong><span>'+ (unmapped?"Review Question Bank competency tags to strengthen blueprint coverage.":"Current assessment questions are mapped to competency evidence.")+'</span></div></div>'+
    (archived?'<div class="attention-item"><div class="attention-number">'+archived+'</div><div class="attention-copy"><strong>Archived sections</strong><span>Historical teaching spaces remain available from Sections.</span></div></div>':'')+
  '</div>';
}

/* -------------------- SECTION UI ENHANCEMENT -------------------- */

async function sectionStaffRole(sectionId){
  const s=state();if(!s?.user)return null;
  if(currentSection()?.ownerId===s.user.uid)return "owner";
  try{const snap=await getDoc(doc(db,"sections",sectionId,"staff",s.user.uid));return snap.exists()?snap.data().role:null;}catch(_){return null;}
}

async function enhanceSection(section,tab){
  if(!section||!isInstructor())return;
  const hero=$("#sectionDetail .detail-hero .detail-top .inline-actions");
  if(hero&&!hero.querySelector("[data-phase5-action]")){
    const role=await sectionStaffRole(section.id);
    if(role==="owner"){
      hero.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-phase5-action="section-operations" data-section="'+section.id+'">Academic Operations</button>');
    }else if(role){
      hero.insertAdjacentHTML("beforeend",'<span class="badge">'+esc(ROLE_LABELS[role]||role)+'</span>');
    }
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
      '<button class="operation-card '+(archived?'':'danger-operation')+'" data-phase5-action="'+(archived?'restore-section':'archive-section')+'" data-section="'+sectionId+'"><span>04</span><strong>'+(archived?'Restore Section':'Archive Section')+'</strong><small>'+(archived?'Return this section to active teaching.':'Preserve records while removing the section from active teaching.')+'</small></button>'+
    '</div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

function lifecycleMenu(studentId){
  const student=state()?.sectionData?.members?.find(x=>x.id===studentId);if(!student)return;
  modal({
    eyebrow:"Enrollment Lifecycle",
    title:student.displayName||"Student",
    body:'<div class="operations-grid compact-operations"><button class="operation-card" data-phase5-action="student-approvals" data-student="'+studentId+'"><span>↗</span><strong>Course Readiness Approval</strong><small>Grant manual instructor approval for progression-gated courses.</small></button><button class="operation-card" data-phase5-action="set-lifecycle" data-student="'+studentId+'" data-status="Completed"><span>✓</span><strong>Mark Completed</strong><small>Preserve section access and mark course participation complete.</small></button><button class="operation-card danger-operation" data-phase5-action="set-lifecycle" data-student="'+studentId+'" data-status="Withdrawn"><span>W</span><strong>Withdraw</strong><small>Remove active access and preserve an enrollment-history record.</small></button><button class="operation-card danger-operation" data-phase5-action="set-lifecycle" data-student="'+studentId+'" data-status="Removed"><span>×</span><strong>Remove</strong><small>Remove active access while preserving academic evidence and history.</small></button></div>',
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
      "record-audit","portfolio","open-section-resource"
    ]);
    if(!allowed.has(action)){
      e.preventDefault();e.stopImmediatePropagation();toast("Your Grader role does not include this section-administration action.");return;
    }
  }
  if(role==="teaching_assistant"){
    const blocked=new Set(["edit-section","delete-section","archive-section","staff-management","manage-prerequisites","certify-record","review-appeal"]);
    if(blocked.has(action)){
      e.preventDefault();e.stopImmediatePropagation();toast("Your Teaching Assistant role does not include this administrative action.");return;
    }
  }
},true);

document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-phase5-action]");if(!b)return;
  const a=b.dataset.phase5Action;
  if(a==="manage-prerequisites")return prerequisiteModal(b.dataset.course);
  if(a==="section-operations")return sectionOperationsModal(b.dataset.section);
  if(a==="archive-section"){closeModal();return archiveSection(b.dataset.section);}
  if(a==="restore-section"){closeModal();return restoreSection(b.dataset.section);}
  if(a==="staff-management"){closeModal();return staffManagementModal(b.dataset.section);}
  if(a==="remove-staff")return removeStaff(b.dataset.section,b.dataset.user);
  if(a==="enrollment-history"){closeModal();return enrollmentHistoryModal(b.dataset.section);}
  if(a==="audit-log"){closeModal();return auditLogModal(b.dataset.section);}
  if(a==="lifecycle-menu")return lifecycleMenu(b.dataset.student);
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
