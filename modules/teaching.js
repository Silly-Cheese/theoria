import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp, Timestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();
const p5=()=>window.TheoriaPhase5;

function section(){return state()?.currentSection||null;}
function sectionData(){return state()?.sectionData||null;}
function isInstructor(){return state()?.role==="instructor";}
function dateText(value){
  if(!value)return "—";
  const d=value?.toDate?value.toDate():new Date(value);
  return Number.isNaN(d.getTime())?"—":d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"});
}
function dateInput(value){
  if(!value)return "";
  const d=value?.toDate?value.toDate():new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  return d.toISOString().slice(0,10);
}
function safe(v){return Array.isArray(v)?v:[];}
async function docs(path){
  try{const s=await getDocs(collection(db,...path));return s.docs.map(d=>({id:d.id,...d.data()}));}catch(_){return [];}
}
function memberById(id){return sectionData()?.members?.find(x=>x.id===id)||null;}
function assignmentById(id){return sectionData()?.assignments?.find(x=>x.id===id)||null;}

async function ensureSection(sectionId=section()?.id){
  if(!sectionId)return null;
  if(section()?.id===sectionId)return section();
  const s=await getDoc(doc(db,"sections",sectionId));
  return s.exists()?{id:s.id,...s.data()}:null;
}

/* -------------------- RUBRICS -------------------- */

async function rubricRows(sectionId=section()?.id){return sectionId?docs(["sections",sectionId,"rubrics"]):[];}

function rubricTotal(rubric){return safe(rubric.criteria).reduce((n,c)=>n+Number(c.points||0),0);}

async function rubricLibraryModal(sectionId=section()?.id){
  const sec=await ensureSection(sectionId);if(!sec)return;
  const rubrics=await rubricRows(sectionId);
  const m=modal({
    eyebrow:"Advanced Rubric Grading",
    title:"Rubric Library",
    wide:true,
    body:'<div class="page-head compact-head"><div><div class="panel-title">'+esc(sec.sectionName||sec.courseTitle)+'</div><p class="page-subtitle">Reusable criterion-level grading with analytics-ready scoring.</p></div><button class="primary-btn small-btn" data-teaching-action="new-rubric" data-section="'+sectionId+'">Create Rubric</button></div>'+
      (rubrics.length?'<div class="rubric-library-grid">'+rubrics.map(r=>'<article class="rubric-library-card"><div class="card-kicker">'+safe(r.criteria).length+' criteria • '+rubricTotal(r)+' pts</div><h3>'+esc(r.title||"Rubric")+'</h3><p>'+esc(r.description||"")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-teaching-action="attach-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Attach to Assignment</button><button class="secondary-btn small-btn" data-teaching-action="edit-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Edit</button><button class="text-btn danger-text" data-teaching-action="delete-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Delete</button></div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">R</div><h3>No rubrics yet.</h3><p>Create a reusable analytic rubric for written work, research, exegesis, argumentation, or seminar preparation.</p></div>'),
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function rubricEditor(sectionId,rubricId=""){
  const existing=rubricId?(await rubricRows(sectionId)).find(x=>x.id===rubricId):null;
  const criteria=existing?.criteria?.length?existing.criteria:[{name:"Thesis / Claim",description:"Clear, defensible academic claim.",points:10},{name:"Evidence",description:"Relevant evidence and source use.",points:10}];
  const m=modal({
    eyebrow:"Rubric Design",
    title:existing?"Edit Rubric":"Create Rubric",
    wide:true,
    body:'<form id="rubricForm"><div class="field"><label>Rubric Title</label><input name="title" value="'+esc(existing?.title||"")+'" required></div><div class="field"><label>Description</label><textarea name="description">'+esc(existing?.description||"")+'</textarea></div><div class="structured-builder"><div class="structured-builder-head"><div><strong>Criteria</strong><span>Each criterion has a maximum point value and grading guidance.</span></div><button type="button" class="secondary-btn small-btn" id="addRubricCriterion">+ Criterion</button></div><div id="rubricCriteria" class="structured-list"></div></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Rubric</button></div></form>'
  });
  const box=m.querySelector("#rubricCriteria");
  const add=(row={})=>{
    const el=document.createElement("div");el.className="rubric-criterion-editor";
    el.innerHTML='<input class="rubric-name" placeholder="Criterion" value="'+esc(row.name||"")+'"><input class="rubric-description" placeholder="Grading guidance" value="'+esc(row.description||"")+'"><div class="input-with-suffix mini"><input class="rubric-points" type="number" min="0" step="0.5" value="'+esc(row.points??10)+'"><span>pts</span></div><button type="button" class="row-remove">×</button>';
    el.querySelector(".row-remove").onclick=()=>el.remove();box.appendChild(el);
  };
  criteria.forEach(add);m.querySelector("#addRubricCriterion").onclick=()=>add({points:10});
  m.querySelector("#rubricForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),rows=[...box.querySelectorAll(".rubric-criterion-editor")].map((row,i)=>({id:"c"+(i+1),name:row.querySelector(".rubric-name").value.trim(),description:row.querySelector(".rubric-description").value.trim(),points:Number(row.querySelector(".rubric-points").value||0)})).filter(x=>x.name&&x.points>0);
    if(!rows.length)return toast("Add at least one rubric criterion.");
    const data={title:String(fd.get("title")).trim(),description:String(fd.get("description")||"").trim(),criteria:rows,totalPoints:rows.reduce((n,x)=>n+x.points,0),updatedAt:serverTimestamp()};
    try{
      if(existing)await updateDoc(doc(db,"sections",sectionId,"rubrics",existing.id),data);
      else await addDoc(collection(db,"sections",sectionId,"rubrics"),{...data,createdAt:serverTimestamp(),createdBy:state().user.uid});
      await p5()?.logSectionEvent?.(sectionId,existing?"rubric_updated":"rubric_created","rubric",existing?.id||"",{title:data.title,totalPoints:data.totalPoints});
      closeModal();toast("Rubric saved.");await rubricLibraryModal(sectionId);
    }catch(error){toast(error.message||"Unable to save rubric.");}
  };
}

async function attachRubric(sectionId,rubricId){
  const rubrics=await rubricRows(sectionId),rubric=rubrics.find(x=>x.id===rubricId),assignments=sectionData()?.assignments||[];
  if(!rubric)return;
  const m=modal({
    eyebrow:"Rubric Assignment",
    title:"Attach "+rubric.title,
    body:'<form id="attachRubricForm"><div class="field"><label>Assignment</label><select name="assignmentId">'+assignments.map(a=>'<option value="'+a.id+'">'+esc(a.title)+'</option>').join("")+'</select></div><div class="notice">The assignment point value will remain unchanged. Rubric criterion scores are normalized to the assignment’s configured point value.</div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Attach Rubric</button></div></form>'
  });
  m.querySelector("#attachRubricForm").onsubmit=async e=>{
    e.preventDefault();const id=String(new FormData(e.currentTarget).get("assignmentId"));
    try{
      await updateDoc(doc(db,"sections",sectionId,"assignments",id),{rubricId:rubric.id,rubricTitle:rubric.title,updatedAt:serverTimestamp()});
      await p5()?.logSectionEvent?.(sectionId,"rubric_attached","assignment",id,{rubricId:rubric.id,rubricTitle:rubric.title});
      closeModal();toast("Rubric attached to assignment.");await core().reloadCurrentSection("assignments");
    }catch(error){toast(error.message||"Unable to attach rubric.");}
  };
}

async function openRubricGrade(assignment,student,existing){
  const sec=section();if(!sec||!assignment?.rubricId)return false;
  const rub=await getDoc(doc(db,"sections",sec.id,"rubrics",assignment.rubricId));
  if(!rub.exists())return false;
  const rubric={id:rub.id,...rub.data()},criteria=safe(rubric.criteria),prior=existing?.rubricScores||{};
  const m=modal({
    eyebrow:"Rubric Grading",
    title:(student?.displayName||"Student")+" — "+assignment.title,
    wide:true,
    body:'<form id="rubricGradeForm"><div class="academic-banner"><div class="kicker">'+esc(rubric.title||"Rubric")+'</div><h3>'+esc(assignment.title)+'</h3><p>Criterion-level evidence is preserved with the grade.</p></div><div class="rubric-grade-list">'+criteria.map(c=>'<div class="rubric-grade-row"><div><strong>'+esc(c.name)+'</strong><span>'+esc(c.description||"")+'</span></div><div class="field"><label>Score / '+esc(c.points)+'</label><input name="score_'+esc(c.id)+'" type="number" min="0" max="'+esc(c.points)+'" step="0.5" value="'+esc(prior[c.id]?.score??"")+'" required></div><div class="field"><label>Comment</label><input name="comment_'+esc(c.id)+'" value="'+esc(prior[c.id]?.comment||"")+'"></div></div>').join("")+'</div><div class="field"><label>Overall Comment</label><textarea name="comment">'+esc(existing?.comment||"")+'</textarea></div>'+(existing?'<div class="field"><label>Reason for Grade Change</label><textarea name="overrideReason" required></textarea></div>':'')+'<div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Rubric Grade</button></div></form>'
  });
  m.querySelector("#rubricGradeForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),rubricScores={};let earned=0,max=0;
    criteria.forEach(c=>{const score=Number(fd.get("score_"+c.id)||0);earned+=score;max+=Number(c.points||0);rubricScores[c.id]={score,comment:String(fd.get("comment_"+c.id)||"").trim(),criterion:c.name,max:Number(c.points||0)};});
    const normalized=max?Math.round((earned/max)*Number(assignment.points||0)*100)/100:0;
    try{
      await setDoc(doc(db,"sections",sec.id,"grades",assignment.id+"_"+student.id),{
        assignmentId:assignment.id,assignmentTitle:assignment.title,studentId:student.id,studentName:student.displayName||"Student",
        score:normalized,maxPoints:Number(assignment.points||0),gradeStatus:"Normal",comment:String(fd.get("comment")||"").trim(),
        rubricId:rubric.id,rubricTitle:rubric.title,rubricScores,rubricEarned:earned,rubricMax:max,
        overrideReason:String(fd.get("overrideReason")||"").trim(),updatedAt:serverTimestamp()
      },{merge:true});
      await p5()?.logSectionEvent?.(sec.id,existing?"rubric_grade_changed":"rubric_grade_created","student",student.id,{assignmentId:assignment.id,score:normalized,rubricId:rubric.id});
      closeModal();toast("Rubric grade saved.");await core().reloadCurrentSection("gradebook");
    }catch(error){toast(error.message||"Unable to save rubric grade.");}
  };
  return true;
}

/* -------------------- ATTENDANCE -------------------- */

async function attendanceModal(sectionId=section()?.id){
  const sec=await ensureSection(sectionId),members=sectionData()?.members||[];if(!sec)return;
  const today=new Date().toISOString().slice(0,10);
  const m=modal({
    eyebrow:"Attendance",
    title:sec.sectionName||sec.courseTitle,
    wide:true,
    body:'<form id="attendanceForm"><div class="compact-field-grid"><div class="field"><label>Date</label><input id="attendanceDate" type="date" value="'+today+'"></div><div class="field"><label>Session</label><input name="sessionTitle" placeholder="Class meeting, seminar, review…"></div></div><div id="attendanceRoster" class="attendance-roster"></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Attendance</button></div></form>'
  });
  const roster=m.querySelector("#attendanceRoster"),dateInputEl=m.querySelector("#attendanceDate");
  const render=async()=>{
    const date=dateInputEl.value||today,existing=await docs(["sections",sectionId,"attendance"]),map=new Map(existing.filter(x=>x.date===date).map(x=>[x.studentId,x]));
    roster.innerHTML=members.length?members.map(student=>{const row=map.get(student.id);return '<div class="attendance-row"><div><strong>'+esc(student.displayName||"Student")+'</strong><span>'+esc(student.email||"")+'</span></div><select data-attendance-student="'+student.id+'"><option>Present</option><option>Absent</option><option>Tardy</option><option>Excused</option><option>Remote</option></select><input data-attendance-note="'+student.id+'" placeholder="Note" value="'+esc(row?.note||"")+'"></div>';}).join(""):'<div class="empty-mini">No students enrolled.</div>';
    members.forEach(student=>{const row=map.get(student.id),select=roster.querySelector('[data-attendance-student="'+student.id+'"]');if(select)select.value=row?.status||"Present";});
  };
  dateInputEl.onchange=render;await render();
  m.querySelector("#attendanceForm").onsubmit=async e=>{
    e.preventDefault();const date=dateInputEl.value||today,batch=writeBatch(db),sessionTitle=String(new FormData(e.currentTarget).get("sessionTitle")||"");
    members.forEach(student=>{
      const status=roster.querySelector('[data-attendance-student="'+student.id+'"]')?.value||"Present",note=roster.querySelector('[data-attendance-note="'+student.id+'"]')?.value||"";
      batch.set(doc(db,"sections",sectionId,"attendance",date+"_"+student.id),{date,sessionTitle,studentId:student.id,studentName:student.displayName||"Student",status,note,updatedBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});
    });
    try{await batch.commit();await p5()?.logSectionEvent?.(sectionId,"attendance_saved","section",sectionId,{date,sessionTitle});closeModal();toast("Attendance saved.");}catch(error){toast(error.message||"Unable to save attendance.");}
  };
}

/* -------------------- EXTENSIONS -------------------- */

async function extensionsModal(sectionId=section()?.id){
  const sec=await ensureSection(sectionId),members=sectionData()?.members||[],assignments=sectionData()?.assignments||[];if(!sec)return;
  const extensions=await docs(["sections",sectionId,"extensions"]);
  const m=modal({
    eyebrow:"Deadline Management",
    title:"Extensions & Late Windows",
    wide:true,
    body:'<form id="extensionForm" class="panel"><div class="panel-head"><div class="panel-title">Grant Individual Extension</div></div><div class="panel-body"><div class="compact-field-grid"><div class="field"><label>Student</label><select name="studentId">'+members.map(x=>'<option value="'+x.id+'">'+esc(x.displayName||"Student")+'</option>').join("")+'</select></div><div class="field"><label>Assignment</label><select name="assignmentId">'+assignments.map(x=>'<option value="'+x.id+'">'+esc(x.title)+'</option>').join("")+'</select></div><div class="field"><label>Extended Due Date</label><input type="date" name="dueDate" required></div></div><div class="field"><label>Reason / Notes</label><input name="reason"></div><button class="primary-btn" type="submit">Grant Extension</button></div></form>'+
      '<div class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">Current Extensions</div></div><div class="panel-body">'+(extensions.length?extensions.map(x=>'<div class="extension-row"><div><strong>'+esc(x.studentName||x.studentId)+' — '+esc(x.assignmentTitle||x.assignmentId)+'</strong><span>Due '+esc(x.dueDate)+' • '+esc(x.reason||"")+'</span></div><button class="text-btn danger-text" data-teaching-action="delete-extension" data-section="'+sectionId+'" data-id="'+x.id+'">Remove</button></div>').join(""):'<div class="empty-mini">No individual extensions.</div>')+'</div></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
  m.querySelector("#extensionForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),studentId=String(fd.get("studentId")),assignmentId=String(fd.get("assignmentId")),student=members.find(x=>x.id===studentId),assignment=assignments.find(x=>x.id===assignmentId);
    try{
      await setDoc(doc(db,"sections",sectionId,"extensions",assignmentId+"_"+studentId),{studentId,studentName:student?.displayName||"Student",assignmentId,assignmentTitle:assignment?.title||"Assignment",dueDate:String(fd.get("dueDate")),reason:String(fd.get("reason")||"").trim(),createdBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});
      await p5()?.logSectionEvent?.(sectionId,"extension_granted","student",studentId,{assignmentId,dueDate:String(fd.get("dueDate"))});closeModal();toast("Extension granted.");await extensionsModal(sectionId);
    }catch(error){toast(error.message||"Unable to grant extension.");}
  };
}

/* -------------------- STUDENT GROUPS -------------------- */

async function groupsModal(sectionId=section()?.id){
  const members=sectionData()?.members||[],groups=await docs(["sections",sectionId,"groups"]);
  const m=modal({
    eyebrow:"Student Groups",
    title:"Seminar & Project Groups",
    wide:true,
    body:'<div class="page-head compact-head"><div><div class="panel-title">Groups</div><p class="page-subtitle">Create seminar, discussion, and project teams.</p></div><button class="primary-btn small-btn" data-teaching-action="new-group" data-section="'+sectionId+'">Create Group</button></div>'+
      (groups.length?'<div class="group-grid">'+groups.map(g=>'<article class="group-card"><div class="card-kicker">'+safe(g.memberIds).length+' members</div><h3>'+esc(g.name||"Group")+'</h3><p>'+esc(g.purpose||"")+'</p><div class="item-tags">'+safe(g.memberIds).map(id=>'<span>'+esc(members.find(x=>x.id===id)?.displayName||id)+'</span>').join("")+'</div><div class="card-actions"><button class="secondary-btn small-btn" data-teaching-action="edit-group" data-section="'+sectionId+'" data-id="'+g.id+'">Edit</button><button class="text-btn danger-text" data-teaching-action="delete-group" data-section="'+sectionId+'" data-id="'+g.id+'">Delete</button></div></article>').join("")+'</div>':'<div class="empty-mini">No groups created.</div>'),
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function groupEditor(sectionId,groupId=""){
  const members=sectionData()?.members||[],groups=await docs(["sections",sectionId,"groups"]),existing=groups.find(x=>x.id===groupId);
  const m=modal({
    eyebrow:"Student Groups",
    title:existing?"Edit Group":"Create Group",
    body:'<form id="groupForm"><div class="field"><label>Name</label><input name="name" value="'+esc(existing?.name||"")+'" required></div><div class="field"><label>Purpose</label><input name="purpose" value="'+esc(existing?.purpose||"")+'"></div><div class="field"><label>Members</label><div class="competency-list">'+members.map(x=>'<label class="checkbox-line"><input type="checkbox" name="member" value="'+x.id+'" '+(safe(existing?.memberIds).includes(x.id)?'checked':'')+'> '+esc(x.displayName||"Student")+'</label>').join("")+'</div></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Group</button></div></form>'
  });
  m.querySelector("#groupForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),data={name:String(fd.get("name")).trim(),purpose:String(fd.get("purpose")||"").trim(),memberIds:fd.getAll("member"),updatedAt:serverTimestamp()};
    try{if(existing)await updateDoc(doc(db,"sections",sectionId,"groups",existing.id),data);else await addDoc(collection(db,"sections",sectionId,"groups"),{...data,createdAt:serverTimestamp()});closeModal();toast("Group saved.");await groupsModal(sectionId);}catch(error){toast(error.message||"Unable to save group.");}
  };
}

/* -------------------- FLAGS + NARRATIVES + PROFILE DRAWER -------------------- */

async function studentProfileModal(studentId){
  const sec=section(),student=memberById(studentId);if(!sec||!student)return;
  const [grades,assessmentGrades,masterySnap,recordSnap,flags,narrativeSnap,attendance]=await Promise.all([
    docs(["sections",sec.id,"grades"]),
    docs(["sections",sec.id,"assessmentGrades"]),
    getDoc(doc(db,"sections",sec.id,"mastery",studentId)).catch(()=>null),
    getDoc(doc(db,"sections",sec.id,"academicRecords",studentId)).catch(()=>null),
    docs(["sections",sec.id,"studentFlags"]),
    getDoc(doc(db,"sections",sec.id,"narratives",studentId)).catch(()=>null),
    docs(["sections",sec.id,"attendance"])
  ]);
  const sg=grades.filter(x=>x.studentId===studentId),ag=assessmentGrades.filter(x=>x.studentId===studentId),mastery=masterySnap?.exists?.()?masterySnap.data():null,record=recordSnap?.exists?.()?recordSnap.data():null,narrative=narrativeSnap?.exists?.()?narrativeSnap.data():null,studentFlags=flags.filter(x=>x.studentId===studentId&&x.status!=="Resolved"),studentAttendance=attendance.filter(x=>x.studentId===studentId);
  const present=studentAttendance.filter(x=>["Present","Remote"].includes(x.status)).length,attendancePct=studentAttendance.length?Math.round(present/studentAttendance.length*1000)/10:null;
  const m=modal({
    eyebrow:"Student Academic Profile",
    title:student.displayName||"Student",
    wide:true,
    body:'<div class="student-profile-summary"><div><span>Coursework Grades</span><strong>'+sg.length+'</strong></div><div><span>Formal Assessments</span><strong>'+ag.length+'</strong></div><div><span>Mastery</span><strong>'+(mastery?.overallPercent??"—")+(mastery?.overallPercent!==undefined?"%":"")+'</strong></div><div><span>Attendance</span><strong>'+(attendancePct===null?"—":attendancePct+"%")+'</strong></div></div>'+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Academic Standing</div></div><div class="panel-body"><div class="detail-list"><div><span>Email</span><strong>'+esc(student.email||"—")+'</strong></div><div><span>Enrollment</span><strong>'+esc(student.status||"enrolled")+'</strong></div><div><span>Certified Record</span><strong>'+(record?esc(record.letterGrade+" • "+record.finalPercent+"%"):"Not certified")+'</strong></div></div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Academic Flags</div><button class="panel-link" data-teaching-action="new-flag" data-student="'+studentId+'">+ Flag</button></div><div class="panel-body">'+(studentFlags.length?studentFlags.map(f=>'<div class="flag-row"><div><strong>'+esc(f.type||"Academic Flag")+'</strong><span>'+esc(f.note||"")+'</span></div><button class="text-btn" data-teaching-action="resolve-flag" data-id="'+f.id+'" data-student="'+studentId+'">Resolve</button></div>').join(""):'<div class="empty-mini">No active academic flags.</div>')+'</div></div></div>'+
      '<div class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Narrative Evaluation</div><div class="panel-subtitle">Term-level academic commentary separate from numerical grades.</div></div></div><div class="panel-body"><form id="narrativeForm"><div class="field"><label>Strengths</label><textarea name="strengths">'+esc(narrative?.strengths||"")+'</textarea></div><div class="field"><label>Growth / Recommendations</label><textarea name="recommendations">'+esc(narrative?.recommendations||"")+'</textarea></div><label class="checkbox-line"><input type="checkbox" name="visibleToStudent" '+(narrative?.visibleToStudent?'checked':'')+'> Visible to student</label><button class="primary-btn" type="submit">Save Narrative Evaluation</button></form></div></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
  m.querySelector("#narrativeForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{
      await setDoc(doc(db,"sections",sec.id,"narratives",studentId),{studentId,studentName:student.displayName||"Student",strengths:String(fd.get("strengths")||"").trim(),recommendations:String(fd.get("recommendations")||"").trim(),visibleToStudent:e.currentTarget.elements.visibleToStudent.checked,updatedBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});
      await p5()?.logSectionEvent?.(sec.id,"narrative_evaluation_updated","student",studentId,{visibleToStudent:e.currentTarget.elements.visibleToStudent.checked});
      toast("Narrative evaluation saved.");
    }catch(error){toast(error.message||"Unable to save narrative evaluation.");}
  };
}

function newFlagModal(studentId){
  const student=memberById(studentId);if(!student)return;
  const m=modal({
    eyebrow:"Academic Flag",
    title:student.displayName||"Student",
    body:'<form id="flagForm"><div class="field"><label>Flag Type</label><select name="type"><option>Needs Advising</option><option>Missing Major Assessment</option><option>Prerequisite Concern</option><option>Attendance Concern</option><option>Academic Integrity Review</option><option>Outstanding Performance</option><option>Instructor Follow-Up</option></select></div><div class="field"><label>Note</label><textarea name="note" required></textarea></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Create Flag</button></div></form>'
  });
  m.querySelector("#flagForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{await addDoc(collection(db,"sections",section().id,"studentFlags"),{studentId,studentName:student.displayName||"Student",type:String(fd.get("type")),note:String(fd.get("note")).trim(),status:"Active",createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});await p5()?.logSectionEvent?.(section().id,"student_flag_created","student",studentId,{type:String(fd.get("type"))});closeModal();toast("Academic flag created.");await studentProfileModal(studentId);}catch(error){toast(error.message||"Unable to create flag.");}
  };
}

/* -------------------- BULK OPERATIONS -------------------- */

async function bulkOperationsModal(sectionId=section()?.id){
  const assignments=sectionData()?.assignments||[],members=sectionData()?.members||[];
  const m=modal({
    eyebrow:"Bulk Operations",
    title:"Section Bulk Actions",
    wide:true,
    body:'<div class="operations-grid"><button class="operation-card" data-teaching-action="bulk-publish" data-section="'+sectionId+'"><span>P</span><strong>Publish Draft Assignments</strong><small>Publish all current draft coursework.</small></button><button class="operation-card" data-teaching-action="bulk-missing" data-section="'+sectionId+'"><span>M</span><strong>Mark Missing Grades</strong><small>Create zero-point Missing entries for ungraded coursework.</small></button><button class="operation-card" data-teaching-action="bulk-extend" data-section="'+sectionId+'"><span>E</span><strong>Bulk Deadline Extension</strong><small>Grant one extension date to selected students for one assignment.</small></button><button class="operation-card" data-teaching-action="bulk-excuse" data-section="'+sectionId+'"><span>X</span><strong>Bulk Excuse</strong><small>Mark selected students Excused for an assignment.</small></button></div><div class="notice" style="margin-top:14px">'+assignments.length+' assignments • '+members.length+' students</div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function bulkStudentAction(kind,sectionId=section()?.id){
  const assignments=sectionData()?.assignments||[],members=sectionData()?.members||[];
  if(kind==="publish"){
    const drafts=assignments.filter(x=>x.status==="Draft");if(!drafts.length)return toast("No draft assignments.");
    const batch=writeBatch(db);drafts.forEach(a=>batch.update(doc(db,"sections",sectionId,"assignments",a.id),{status:"Published",updatedAt:serverTimestamp()}));
    await batch.commit();closeModal();toast(drafts.length+" assignments published.");await core().reloadCurrentSection("assignments");return;
  }
  const m=modal({
    eyebrow:"Bulk Gradebook Action",
    title:kind==="extend"?"Bulk Deadline Extension":kind==="excuse"?"Bulk Excuse Assignment":"Mark Missing Work",
    body:'<form id="bulkStudentForm"><div class="field"><label>Assignment</label><select name="assignmentId">'+assignments.map(a=>'<option value="'+a.id+'">'+esc(a.title)+'</option>').join("")+'</select></div>'+(kind==="extend"?'<div class="field"><label>Extended Due Date</label><input name="dueDate" type="date" required></div>':'')+'<div class="field"><label>Students</label><div class="competency-list">'+members.map(s=>'<label class="checkbox-line"><input type="checkbox" name="student" value="'+s.id+'"> '+esc(s.displayName||"Student")+'</label>').join("")+'</div></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Apply</button></div></form>'
  });
  m.querySelector("#bulkStudentForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),assignmentId=String(fd.get("assignmentId")),assignment=assignmentById(assignmentId),students=fd.getAll("student");if(!students.length)return toast("Select at least one student.");
    try{
      const batch=writeBatch(db);
      students.forEach(studentId=>{
        const student=memberById(studentId);
        if(kind==="extend")batch.set(doc(db,"sections",sectionId,"extensions",assignmentId+"_"+studentId),{assignmentId,assignmentTitle:assignment?.title||"Assignment",studentId,studentName:student?.displayName||"Student",dueDate:String(fd.get("dueDate")),reason:"Bulk extension",updatedAt:serverTimestamp()},{merge:true});
        else batch.set(doc(db,"sections",sectionId,"grades",assignmentId+"_"+studentId),{assignmentId,assignmentTitle:assignment?.title||"Assignment",studentId,studentName:student?.displayName||"Student",score:0,maxPoints:Number(assignment?.points||0),gradeStatus:kind==="excuse"?"Excused":"Missing",updatedAt:serverTimestamp()},{merge:true});
      });
      await batch.commit();closeModal();toast("Bulk action applied to "+students.length+" students.");await core().reloadCurrentSection(kind==="extend"?"assignments":"gradebook");
    }catch(error){toast(error.message||"Unable to apply bulk action.");}
  };
}

/* -------------------- COMPETENCY HEATMAP + STUDY PRIORITIES -------------------- */

async function heatmapData(sectionId){
  const sec=await ensureSection(sectionId),members=sectionData()?.members||await docs(["sections",sectionId,"members"]),courseId=sec?.courseId;
  if(!sec)return {members:[],competencies:[],rows:[]};
  const course=courseId?await getDoc(doc(db,"courses",courseId)):null;
  let comps=[];
  if(course?.exists?.())comps=await docs(["courses",courseId,"competencies"]);
  const mastery=await docs(["sections",sectionId,"mastery"]);
  return {members,competencies:comps,rows:mastery};
}
async function renderInsights(){
  const el=$("#insightsContent"),s=state();if(!el||!s?.user)return;
  if(s.role==="student"){
    const recs=[];
    for(const sec of (s.sections||[]).filter(x=>x.status!=="Archived")){
      const [masterySnap,assignments,grades]=await Promise.all([
        getDoc(doc(db,"sections",sec.id,"mastery",s.user.uid)).catch(()=>null),
        docs(["sections",sec.id,"assignments"]),
        docs(["sections",sec.id,"grades"])
      ]);
      const mastery=masterySnap?.exists?.()?masterySnap.data():null;
      safe(mastery?.competencies).filter(c=>Number(c.percent||0)<75).sort((a,b)=>Number(a.percent||0)-Number(b.percent||0)).slice(0,3).forEach(c=>recs.push({kind:"Competency",section:sec,title:(c.code||"")+" "+(c.name||""),detail:"Current mastery "+c.percent+"%"}));
      const ownGrades=new Set(grades.filter(g=>g.studentId===s.user.uid&&g.gradeStatus!=="Missing").map(g=>g.assignmentId));
      assignments.filter(a=>a.status!=="Draft"&&!ownGrades.has(a.id)&&a.dueDate&&new Date(a.dueDate+"T23:59:59")<new Date()).slice(0,3).forEach(a=>recs.push({kind:"Missing Work",section:sec,title:a.title,detail:"Past due • "+a.dueDate}));
    }
    el.innerHTML='<div class="academic-banner"><div class="kicker">What Should I Work On?</div><h3>Priorities based on your current Theoria evidence.</h3><p>These are study prompts and workflow reminders, not automatic academic judgments.</p></div>'+(recs.length?'<div class="priority-grid">'+recs.map(r=>'<article class="priority-card"><span>'+esc(r.kind)+'</span><h3>'+esc(r.title)+'</h3><p>'+esc(r.section.courseCode||"Course")+' • '+esc(r.detail)+'</p><button class="text-btn" data-teaching-action="open-section" data-section="'+r.section.id+'">Open Section</button></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">✓</div><h3>No urgent study priorities detected.</h3><p>Continue working through your assigned material and assessments.</p></div>');
    return;
  }
  const sections=(s.sections||[]).filter(x=>x.status!=="Archived"),selected=sections.find(x=>x.id===sessionStorage.getItem("theoria-insights-section"))||sections[0];
  if(!selected){el.innerHTML='<div class="empty-mini">No active sections.</div>';return;}
  sessionStorage.setItem("theoria-insights-section",selected.id);
  if(section()?.id!==selected.id){try{await core().openSection(selected.id,"overview");core().setPage("insights");}catch(_){}}
  const data=await heatmapData(selected.id),masteryMap=new Map(data.rows.map(x=>[x.id,x]));
  const compCodes=data.competencies.map(c=>c.code);
  el.innerHTML='<div class="insights-toolbar"><div class="field"><label>Section</label><select id="insightsSectionSelect">'+sections.map(x=>'<option value="'+x.id+'" '+(x.id===selected.id?'selected':'')+'>'+esc((x.courseCode||"Course")+" — "+(x.sectionName||x.courseTitle))+'</option>').join("")+'</select></div><button class="secondary-btn" data-teaching-action="section-tools" data-section="'+selected.id+'">Teaching Tools</button></div>'+
    '<div class="academic-banner"><div class="kicker">Competency Heatmap</div><h3>'+esc(selected.courseCode||"Course")+' — '+esc(selected.sectionName||selected.courseTitle)+'</h3><p>Students × competencies based on current evidence. Click a student for the full academic profile.</p></div>'+
    (data.members.length&&compCodes.length?'<div class="heatmap-wrap"><table class="heatmap-table"><thead><tr><th>Student</th>'+compCodes.map(code=>'<th>'+esc(code)+'</th>').join("")+'</tr></thead><tbody>'+data.members.map(student=>{const mastery=masteryMap.get(student.id),byCode=new Map(safe(mastery?.competencies).map(c=>[c.code,c]));return '<tr><td><button class="text-btn" data-teaching-action="student-profile" data-student="'+student.id+'">'+esc(student.displayName||"Student")+'</button></td>'+compCodes.map(code=>{const v=byCode.get(code)?.percent;const cls=v===undefined?"none":v>=85?"high":v>=70?"mid":"low";return '<td class="heat '+cls+'">'+(v===undefined?"—":esc(v)+"%")+'</td>';}).join("")+'</tr>';}).join("")+'</tbody></table></div>':'<div class="empty-mini">Mastery evidence or course competencies are not available yet.</div>');
  const sel=$("#insightsSectionSelect");if(sel)sel.onchange=()=>{sessionStorage.setItem("theoria-insights-section",sel.value);renderInsights();};
}

/* -------------------- ASSESSMENT SECURITY -------------------- */

async function assessmentSecurityModal(assessmentId){
  const snap=await getDoc(doc(db,"assessments",assessmentId));if(!snap.exists())return toast("Assessment not found.");
  const a={id:snap.id,...snap.data()},p=a.securityPolicy||{};
  const m=modal({
    eyebrow:"Assessment Security Center",
    title:a.title||"Assessment",
    wide:true,
    body:'<form id="securityForm"><div class="academic-banner"><div class="kicker">Attempt & Session Controls</div><h3>Security Policy</h3><p>These controls support academic integrity. They do not attempt invasive device surveillance.</p></div><div class="policy-grid"><label class="policy-card"><input type="checkbox" name="requireAccessCode" '+(p.requireAccessCode?'checked':'')+'><div><strong>Access Code</strong><span>Require an instructor-provided code before starting.</span></div></label><label class="policy-card"><input type="checkbox" name="blockPaste" '+(p.blockPaste?'checked':'')+'><div><strong>Block Paste</strong><span>Prevent paste inside written-response fields.</span></div></label><label class="policy-card"><input type="checkbox" name="logFocusLoss" '+(p.logFocusLoss!==false?'checked':'')+'><div><strong>Log Focus Changes</strong><span>Record visibility/focus changes in the attempt event log.</span></div></label><label class="policy-card"><input type="checkbox" name="lateEntryBlocked" '+(p.lateEntryBlocked?'checked':'')+'><div><strong>Block Late Entry</strong><span>Do not allow a new attempt to begin after the close time.</span></div></label></div><div class="compact-field-grid"><div class="field"><label>Access Code</label><input name="accessCode" value="'+esc(p.accessCode||"")+'"></div><div class="field"><label>Maximum Attempts</label><input name="maxAttempts" type="number" min="1" max="10" value="'+esc(p.maxAttempts||1)+'"></div></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Security Policy</button></div></form>'
  });
  m.querySelector("#securityForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),policy={requireAccessCode:e.currentTarget.elements.requireAccessCode.checked,accessCode:String(fd.get("accessCode")||"").trim(),blockPaste:e.currentTarget.elements.blockPaste.checked,logFocusLoss:e.currentTarget.elements.logFocusLoss.checked,lateEntryBlocked:e.currentTarget.elements.lateEntryBlocked.checked,maxAttempts:Math.max(1,Number(fd.get("maxAttempts")||1))};
    if(policy.requireAccessCode&&!policy.accessCode)return toast("Enter an access code or disable the access-code requirement.");
    try{await updateDoc(doc(db,"assessments",assessmentId),{securityPolicy:policy,updatedAt:serverTimestamp()});if(a.sectionId)await p5()?.logSectionEvent?.(a.sectionId,"assessment_security_updated","assessment",assessmentId,{...policy,accessCode:policy.requireAccessCode?"configured":""});closeModal();toast("Assessment security policy saved.");}catch(error){toast(error.message||"Unable to save security policy.");}
  };
}
async function preflightSecurity(assessment){
  const p=assessment?.securityPolicy||{},uid=state()?.user?.uid;if(!uid)return false;
  if(p.lateEntryBlocked&&assessment.closesAt){
    const close=assessment.closesAt.toDate?assessment.closesAt.toDate():new Date(assessment.closesAt);
    if(new Date()>close){toast("New attempts are blocked after this assessment closes.");return false;}
  }
  if(p.maxAttempts){
    try{
      const sub=await getDoc(doc(db,"assessments",assessment.id,"submissions",uid));
      if(sub.exists()&&Number(sub.data().attemptNumber||1)>Number(p.maxAttempts)){toast("The maximum number of attempts has been reached.");return false;}
    }catch(_){}
  }
  if(p.requireAccessCode){
    const entered=prompt("Enter the assessment access code:");
    if(entered===null)return false;
    if(String(entered).trim()!==String(p.accessCode||"")){toast("Incorrect assessment access code.");return false;}
  }
  return true;
}
async function logExamSecurityEvent(type,details={}){
  const p3=window.TheoriaPhase3,current=p3?.getCurrent?.(),exam=current&&$("#page-exam")?.classList.contains("active");
  if(!exam||state()?.role!=="student")return;
  const policy=current.securityPolicy||{};
  if(type==="focus_loss"&&policy.logFocusLoss===false)return;
  try{await addDoc(collection(db,"assessments",current.id,"submissions",state().user.uid,"events"),{studentId:state().user.uid,type,details,at:serverTimestamp()});}catch(_){}
}
function bindSecurityEvents(){
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")logExamSecurityEvent("focus_loss",{visibility:"hidden"});});
  window.addEventListener("blur",()=>logExamSecurityEvent("window_blur"));
  document.addEventListener("paste",e=>{
    const current=window.TheoriaPhase3?.getCurrent?.();if(!current||!$("#page-exam")?.classList.contains("active"))return;
    if(current.securityPolicy?.blockPaste){e.preventDefault();logExamSecurityEvent("paste_blocked");toast("Paste is disabled for this assessment.");}
  },true);
  document.addEventListener("copy",()=>{const current=window.TheoriaPhase3?.getCurrent?.();if(current&&$("#page-exam")?.classList.contains("active"))logExamSecurityEvent("copy_event");},true);
}

/* -------------------- QUESTION QUALITY -------------------- */

async function questionQualityModal(courseId,itemId){
  const snap=await getDoc(doc(db,"courses",courseId,"items",itemId));if(!snap.exists())return;
  const item={id:snap.id,...snap.data()},all=await docs(["courses",courseId,"items"]);
  const norm=v=>String(v||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
  const duplicates=all.filter(x=>x.id!==itemId&&norm(x.prompt)===norm(item.prompt));
  const m=modal({
    eyebrow:"Question Bank Quality",
    title:"Quality Review",
    wide:true,
    body:'<form id="qualityForm"><div class="academic-banner"><div class="kicker">Question Bank Quality System</div><h3>'+esc((item.prompt||"Question").slice(0,180))+'</h3><p>Review status, retirement, revision notes, and duplicate signals without deleting assessment history.</p></div><div class="compact-field-grid"><div class="field"><label>Workflow Status</label><select name="qualityStatus"><option>Draft</option><option>Review</option><option>Published</option><option>Retired</option></select></div><div class="field"><label>Quality Flag</label><select name="qualityFlag"><option value="">No flag</option><option>Needs Revision</option><option>Ambiguous</option><option>Difficulty Review</option><option>Answer Key Review</option><option>Duplicate Candidate</option></select></div></div><div class="field"><label>Revision / Review Notes</label><textarea name="reviewNotes">'+esc(item.reviewNotes||"")+'</textarea></div>'+(duplicates.length?'<div class="notice danger-notice"><strong>Potential duplicate detected.</strong><p>'+duplicates.length+' other Question Bank item'+(duplicates.length===1?"":"s")+' has the same normalized prompt.</p></div>':'<div class="notice">No exact duplicate prompt detected in this course.</div>')+'<div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Quality Review</button></div></form>'
  });
  const form=m.querySelector("#qualityForm");form.elements.qualityStatus.value=item.qualityStatus||"Published";form.elements.qualityFlag.value=item.qualityFlag||"";
  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{await updateDoc(doc(db,"courses",courseId,"items",itemId),{qualityStatus:String(fd.get("qualityStatus")),qualityFlag:String(fd.get("qualityFlag")),reviewNotes:String(fd.get("reviewNotes")||"").trim(),retired:String(fd.get("qualityStatus"))==="Retired",qualityReviewedAt:serverTimestamp(),qualityReviewedBy:state().user.uid,updatedAt:serverTimestamp()});await p5()?.logCourseEvent?.(courseId,"question_quality_reviewed","question",itemId,{status:String(fd.get("qualityStatus")),flag:String(fd.get("qualityFlag"))});closeModal();toast("Question quality review saved.");window.TheoriaPhase3?.renderItemBank?.();}catch(error){toast(error.message||"Unable to save quality review.");}
  };
}

/* -------------------- BLUEPRINT DESIGNER -------------------- */

async function blueprintDesigner(assessmentId){
  const aSnap=await getDoc(doc(db,"assessments",assessmentId));if(!aSnap.exists())return;
  const a={id:aSnap.id,...aSnap.data()},qSnap=await getDocs(collection(db,"assessments",assessmentId,"questions")),questions=qSnap.docs.map(d=>({id:d.id,...d.data()}));
  const byUnit=new Map(),byCog=new Map(),total=questions.reduce((n,q)=>n+Number(q.points||0),0);
  questions.forEach(q=>{const u=q.unitTitle||q.unitId||"Unmapped";byUnit.set(u,(byUnit.get(u)||0)+Number(q.points||0));const c=q.cognitiveLevel||"Unspecified";byCog.set(c,(byCog.get(c)||0)+Number(q.points||0));});
  const target=a.blueprintDesign||{};
  const m=modal({
    eyebrow:"Assessment Blueprint Designer",
    title:a.title||"Assessment",
    wide:true,
    body:'<form id="blueprintDesignForm"><div class="academic-banner"><div class="kicker">Blueprint Intelligence</div><h3>Actual vs. Intended Coverage</h3><p>Set optional targets. Theoria warns about large differences but does not automatically rewrite the assessment.</p></div><section class="form-section"><div class="panel-title">Unit Coverage</div><div class="blueprint-design-grid">'+[...byUnit.entries()].map(([name,pts])=>{const actual=total?Math.round(pts/total*1000)/10:0;return '<div class="blueprint-design-row"><div><strong>'+esc(name)+'</strong><span>Actual '+actual+'%</span></div><div class="input-with-suffix mini"><input name="unitTarget" data-unit="'+esc(name)+'" type="number" min="0" max="100" step="0.1" value="'+esc(target.units?.[name]??actual)+'"><span>%</span></div></div>';}).join("")+'</div></section><section class="form-section"><div class="panel-title">Cognitive-Level Coverage</div><div class="blueprint-design-grid">'+[...byCog.entries()].map(([name,pts])=>{const actual=total?Math.round(pts/total*1000)/10:0;return '<div class="blueprint-design-row"><div><strong>'+esc(name)+'</strong><span>Actual '+actual+'%</span></div><div class="input-with-suffix mini"><input name="cogTarget" data-cog="'+esc(name)+'" type="number" min="0" max="100" step="0.1" value="'+esc(target.cognitiveLevels?.[name]??actual)+'"><span>%</span></div></div>';}).join("")+'</div></section><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Blueprint Targets</button></div></form>'
  });
  m.querySelector("#blueprintDesignForm").onsubmit=async e=>{
    e.preventDefault();const units={},cognitiveLevels={};m.querySelectorAll("[data-unit]").forEach(x=>units[x.dataset.unit]=Number(x.value||0));m.querySelectorAll("[data-cog]").forEach(x=>cognitiveLevels[x.dataset.cog]=Number(x.value||0));
    try{await updateDoc(doc(db,"assessments",assessmentId),{blueprintDesign:{units,cognitiveLevels,updatedAt:serverTimestamp()},updatedAt:serverTimestamp()});closeModal();toast("Assessment blueprint targets saved.");}catch(error){toast(error.message||"Unable to save blueprint targets.");}
  };
}

/* -------------------- SECTION TOOLS -------------------- */

function sectionToolsModal(sectionId=section()?.id){
  modal({
    eyebrow:"Teaching Tools",
    title:section()?.sectionName||section()?.courseTitle||"Section",
    wide:true,
    body:'<div class="operations-grid teaching-tools-grid"><button class="operation-card" data-teaching-action="rubrics" data-section="'+sectionId+'"><span>R</span><strong>Rubrics</strong><small>Reusable criterion-level grading.</small></button><button class="operation-card" data-teaching-action="attendance" data-section="'+sectionId+'"><span>A</span><strong>Attendance</strong><small>Present, absent, tardy, excused, remote.</small></button><button class="operation-card" data-teaching-action="extensions" data-section="'+sectionId+'"><span>E</span><strong>Extensions</strong><small>Individual deadlines and late windows.</small></button><button class="operation-card" data-teaching-action="groups" data-section="'+sectionId+'"><span>G</span><strong>Student Groups</strong><small>Seminar, project, and discussion teams.</small></button><button class="operation-card" data-teaching-action="bulk-ops" data-section="'+sectionId+'"><span>B</span><strong>Bulk Operations</strong><small>Publish, excuse, mark missing, extend.</small></button><button class="operation-card" data-teaching-action="student-directory" data-section="'+sectionId+'"><span>S</span><strong>Student Profiles</strong><small>Flags, narratives, records, mastery.</small></button></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}
function studentDirectory(){
  const members=sectionData()?.members||[];
  modal({
    eyebrow:"Student Search",
    title:"Section Student Directory",
    wide:true,
    body:'<div class="field"><label>Search Students</label><input id="studentDirectorySearch" placeholder="Name or email"></div><div id="studentDirectoryRows" class="student-directory-list"></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
  const input=$("#studentDirectorySearch"),box=$("#studentDirectoryRows");
  const render=()=>{const q=input.value.toLowerCase();const rows=members.filter(x=>!q||(x.displayName+" "+x.email).toLowerCase().includes(q));box.innerHTML=rows.map(x=>'<button class="student-directory-row" data-teaching-action="student-profile" data-student="'+x.id+'"><div><strong>'+esc(x.displayName||"Student")+'</strong><span>'+esc(x.email||"")+'</span></div><span>Open Profile →</span></button>').join("")||'<div class="empty-mini">No matching students.</div>';};
  input.oninput=render;render();
}

/* -------------------- INIT / ACTIONS -------------------- */

function bind(){
  bindSecurityEvents();
  window.addEventListener("theoria:page",e=>{if(e.detail.page==="insights")renderInsights();});
  document.addEventListener("click",async e=>{
    const b=e.target.closest("[data-teaching-action]");if(!b)return;
    const a=b.dataset.teachingAction,sid=b.dataset.section||section()?.id;
    if(a==="section-tools")return sectionToolsModal(sid);
    if(a==="rubrics"){closeModal();return rubricLibraryModal(sid);}
    if(a==="new-rubric"){closeModal();return rubricEditor(sid);}
    if(a==="edit-rubric"){closeModal();return rubricEditor(sid,b.dataset.id);}
    if(a==="delete-rubric"){if(confirm("Delete this reusable rubric? Assignments already graded with it keep their stored rubric evidence.")){await deleteDoc(doc(db,"sections",sid,"rubrics",b.dataset.id));closeModal();toast("Rubric deleted.");return rubricLibraryModal(sid);}return;}
    if(a==="attach-rubric"){closeModal();return attachRubric(sid,b.dataset.id);}
    if(a==="attendance"){closeModal();return attendanceModal(sid);}
    if(a==="extensions"){closeModal();return extensionsModal(sid);}
    if(a==="delete-extension"){await deleteDoc(doc(db,"sections",sid,"extensions",b.dataset.id));closeModal();toast("Extension removed.");return extensionsModal(sid);}
    if(a==="groups"){closeModal();return groupsModal(sid);}
    if(a==="new-group"){closeModal();return groupEditor(sid);}
    if(a==="edit-group"){closeModal();return groupEditor(sid,b.dataset.id);}
    if(a==="delete-group"){if(confirm("Delete this student group?")){await deleteDoc(doc(db,"sections",sid,"groups",b.dataset.id));closeModal();return groupsModal(sid);}return;}
    if(a==="student-directory"){closeModal();return studentDirectory();}
    if(a==="student-profile"){closeModal();return studentProfileModal(b.dataset.student);}
    if(a==="new-flag"){closeModal();return newFlagModal(b.dataset.student);}
    if(a==="resolve-flag"){await updateDoc(doc(db,"sections",section().id,"studentFlags",b.dataset.id),{status:"Resolved",resolvedAt:serverTimestamp(),resolvedBy:state().user.uid,updatedAt:serverTimestamp()});closeModal();toast("Flag resolved.");return studentProfileModal(b.dataset.student);}
    if(a==="bulk-ops"){closeModal();return bulkOperationsModal(sid);}
    if(a==="bulk-publish"){return bulkStudentAction("publish",sid);}
    if(a==="bulk-missing"){closeModal();return bulkStudentAction("missing",sid);}
    if(a==="bulk-excuse"){closeModal();return bulkStudentAction("excuse",sid);}
    if(a==="bulk-extend"){closeModal();return bulkStudentAction("extend",sid);}
    if(a==="assessment-security")return assessmentSecurityModal(b.dataset.id);
    if(a==="question-quality")return questionQualityModal(b.dataset.course,b.dataset.id);
    if(a==="blueprint-designer")return blueprintDesigner(b.dataset.id);
    if(a==="open-section")return core().openSection(b.dataset.section);
  });
}

export function initTeaching(){
  bind();
  return {
    renderInsights,sectionToolsModal,rubricLibraryModal,openRubricGrade,
    assessmentSecurityModal,preflightSecurity,questionQualityModal,blueprintDesigner,
    studentProfileModal
  };
}
