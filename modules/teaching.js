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

async function rubricRows(sectionId=section()?.id){
  const sec=await ensureSection(sectionId);return sec?.courseId?docs(["courses",sec.courseId,"rubrics"]):[];
}

function rubricTotal(rubric){return safe(rubric.criteria).reduce((n,c)=>n+Number(c.points||0),0);}

async function rubricLibraryModal(sectionId=section()?.id){
  const sec=await ensureSection(sectionId);if(!sec)return;
  const rubrics=await rubricRows(sectionId),course=state()?.courses?.find(x=>x.id===sec.courseId)||sectionData()?.course;
  const canEdit=!!course&&core().canManageCourse(course);
  const m=modal({
    eyebrow:"Advanced Rubric Grading",
    title:"Rubric Library",
    wide:true,
    body:'<div class="page-head compact-head"><div><div class="panel-title">'+esc((course?.code||sec.courseCode||"Course")+" Rubric Library")+'</div><p class="page-subtitle">Reusable course-level criterion grading. Official catalog rubrics are managed by the course owner/System Owner and can be attached to section assignments.</p></div>'+(canEdit?'<button class="primary-btn small-btn" data-teaching-action="new-rubric" data-section="'+sectionId+'">Create Rubric</button>':'')+'</div>'+
      (rubrics.length?'<div class="rubric-library-grid">'+rubrics.map(r=>'<article class="rubric-library-card"><div class="card-kicker">'+safe(r.criteria).length+' criteria • '+rubricTotal(r)+' pts</div><h3>'+esc(r.title||"Rubric")+'</h3><p>'+esc(r.description||"")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-teaching-action="rubric-analytics" data-section="'+sectionId+'" data-id="'+r.id+'">Analytics</button><button class="secondary-btn small-btn" data-teaching-action="attach-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Attach to Assignment</button><button class="secondary-btn small-btn" data-teaching-action="edit-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Edit</button><button class="text-btn danger-text" data-teaching-action="delete-rubric" data-section="'+sectionId+'" data-id="'+r.id+'">Delete</button></div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">R</div><h3>No rubrics yet.</h3><p>Create a reusable analytic rubric for written work, research, exegesis, argumentation, or seminar preparation.</p></div>'),
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

async function rubricEditor(sectionId,rubricId=""){
  const sec=await ensureSection(sectionId),course=state()?.courses?.find(x=>x.id===sec?.courseId)||sectionData()?.course;
  if(!sec||!course||!core().canManageCourse(course))return toast("Only the course owner/System Owner can edit the official rubric library.");
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
      if(existing)await updateDoc(doc(db,"courses",sec.courseId,"rubrics",existing.id),data);
      else await addDoc(collection(db,"courses",sec.courseId,"rubrics"),{...data,createdAt:serverTimestamp(),createdBy:state().user.uid});
      await p5()?.logCourseEvent?.(sec.courseId,existing?"rubric_updated":"rubric_created","rubric",existing?.id||"",{title:data.title,totalPoints:data.totalPoints});
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
      await updateDoc(doc(db,"sections",sectionId,"assignments",id),{rubricId:rubric.id,rubricTitle:rubric.title,rubricSnapshot:safe(rubric.criteria).map(x=>({...x})),updatedAt:serverTimestamp()});
      await p5()?.logSectionEvent?.(sectionId,"rubric_attached","assignment",id,{rubricId:rubric.id,rubricTitle:rubric.title});
      closeModal();toast("Rubric attached to assignment.");await core().reloadCurrentSection("assignments");
    }catch(error){toast(error.message||"Unable to attach rubric.");}
  };
}

async function rubricAnalyticsModal(sectionId,rubricId){
  const sec=await ensureSection(sectionId);if(!sec)return;
  const rubricSnap=await getDoc(doc(db,"courses",sec.courseId,"rubrics",rubricId));if(!rubricSnap.exists())return toast("Rubric not found.");
  const rubric={id:rubricSnap.id,...rubricSnap.data()},criteria=safe(rubric.criteria),grades=(await docs(["sections",sectionId,"grades"])).filter(g=>g.rubricId===rubricId);
  const rows=criteria.map((criterion,index)=>{
    let earned=0,possible=0,count=0;
    for(const grade of grades){
      const rs=grade.rubricScores;
      let scoreRow=null;
      if(Array.isArray(rs))scoreRow=rs.find(x=>Number(x.index)===index||x.name===criterion.name);
      else if(rs&&typeof rs==="object")scoreRow=rs[criterion.id]||Object.values(rs).find(x=>x.criterion===criterion.name||x.name===criterion.name);
      if(scoreRow&&scoreRow.score!==undefined){
        const max=Number(scoreRow.maxPoints??criterion.points??0);
        earned+=Number(scoreRow.score||0);possible+=max;count++;
      }
    }
    return {criterion,count,percent:possible?Math.round((earned/possible)*1000)/10:null,avg:count?Math.round((earned/count)*100)/100:null};
  });
  modal({
    eyebrow:"Rubric Analytics",
    title:rubric.title||"Rubric",
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">'+grades.length+' graded submission'+(grades.length===1?"":"s")+'</div><h3>Criterion performance across this section.</h3><p>Use this view to identify where the class is consistently strong or where instruction and feedback may need reinforcement.</p></div>'+
      (grades.length?'<div class="rubric-analytics-grid">'+rows.map(row=>'<div class="rubric-analytics-row '+(row.percent!==null&&row.percent<70?"needs-attention":"")+'"><div><strong>'+esc(row.criterion.name||"Criterion")+'</strong><span>'+esc(row.criterion.description||"")+'</span></div><div><b>'+(row.percent===null?"—":row.percent+"%")+'</b><small>'+row.count+' scored • avg '+(row.avg===null?"—":row.avg)+' / '+esc(row.criterion.points||0)+'</small></div></div>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">R</div><h3>No rubric evidence yet.</h3><p>Grade an assignment with this rubric to begin criterion analytics.</p></div>'),
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

async function openRubricGrade(assignment,student,existing){
  const sec=section();if(!sec||!assignment?.rubricId)return false;
  const rubricSnap=safe(assignment.rubricSnapshot);
  let rubric={id:assignment.rubricId,title:assignment.rubricTitle||"Rubric",criteria:rubricSnap};
  if(!rubric.criteria.length){
    const rub=await getDoc(doc(db,"courses",sec.courseId,"rubrics",assignment.rubricId));
    if(!rub.exists())return false;
    rubric={id:rub.id,...rub.data()};
  }
  const criteria=safe(rubric.criteria),prior=existing?.rubricScores||{};
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
    body:'<form id="attendanceForm"><div class="compact-field-grid"><div class="field"><label>Date</label><input id="attendanceDate" type="date" value="'+today+'"></div><div class="field"><label>Session</label><input name="sessionTitle" placeholder="Class meeting, seminar, review…"></div></div><div id="attendanceSummary" class="attendance-summary"></div><div id="attendanceRoster" class="attendance-roster"></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Attendance</button></div></form>'
  });
  const roster=m.querySelector("#attendanceRoster"),dateInputEl=m.querySelector("#attendanceDate");
  const render=async()=>{
    const date=dateInputEl.value||today,existing=await docs(["sections",sectionId,"attendance"]),map=new Map(existing.filter(x=>x.date===date).map(x=>[x.studentId,x]));
    roster.innerHTML=members.length?members.map(student=>{const row=map.get(student.id);return '<div class="attendance-row"><div><strong>'+esc(student.displayName||"Student")+'</strong><span>'+esc(student.email||"")+'</span></div><select data-attendance-student="'+student.id+'"><option>Present</option><option>Absent</option><option>Tardy</option><option>Excused</option><option>Remote</option></select><input data-attendance-note="'+student.id+'" placeholder="Note" value="'+esc(row?.note||"")+'"></div>';}).join(""):'<div class="empty-mini">No students enrolled.</div>';
    members.forEach(student=>{const row=map.get(student.id),select=roster.querySelector('[data-attendance-student="'+student.id+'"]');if(select)select.value=row?.status||"Present";});
    const summary=m.querySelector("#attendanceSummary"),allRows=existing,counts={Present:0,Absent:0,Tardy:0,Excused:0,Remote:0};
    allRows.forEach(x=>{if(counts[x.status]!==undefined)counts[x.status]++;});
    const meetings=[...new Set(allRows.map(x=>x.date).filter(Boolean))].length,attendanceRate=(counts.Present+counts.Remote+counts.Tardy+counts.Absent)>0?Math.round((counts.Present+counts.Remote+counts.Tardy)/(counts.Present+counts.Remote+counts.Tardy+counts.Absent)*1000)/10:null;
    if(summary)summary.innerHTML='<div><span>Recorded Meetings</span><strong>'+meetings+'</strong></div><div><span>Present / Remote</span><strong>'+(counts.Present+counts.Remote)+'</strong></div><div><span>Tardy</span><strong>'+counts.Tardy+'</strong></div><div><span>Attendance Rate</span><strong>'+(attendanceRate===null?"—":attendanceRate+"%")+'</strong></div>';
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
  const members=sectionData()?.members||[],groups=await docs(["sections",sectionId,"groups"]),groupAssignments=await docs(["sections",sectionId,"groupAssignments"]);
  const groupAssignmentMap=new Map();
  groupAssignments.forEach(row=>{if(!groupAssignmentMap.has(row.groupId))groupAssignmentMap.set(row.groupId,[]);groupAssignmentMap.get(row.groupId).push(row);});
  const m=modal({
    eyebrow:"Student Groups",
    title:"Seminar, Project & Group Coursework",
    wide:true,
    body:'<div class="page-head compact-head"><div><div class="panel-title">Groups</div><p class="page-subtitle">Create student teams, attach existing coursework, and choose shared or individual grading.</p></div><button class="primary-btn small-btn" data-teaching-action="new-group" data-section="'+sectionId+'">Create Group</button></div>'+
      (groups.length?'<div class="group-grid">'+groups.map(g=>{
        const work=groupAssignmentMap.get(g.id)||[];
        return '<article class="group-card"><div class="card-kicker">'+safe(g.memberIds).length+' members • '+work.length+' group assignment'+(work.length===1?"":"s")+'</div><h3>'+esc(g.name||"Group")+'</h3><p>'+esc(g.purpose||"")+'</p><div class="item-tags">'+safe(g.memberIds).map(id=>'<span>'+esc(members.find(x=>x.id===id)?.displayName||id)+'</span>').join("")+'</div>'+
          (work.length?'<div class="group-work-list">'+work.map(row=>'<div class="group-work-row"><div><strong>'+esc(row.assignmentTitle||"Assignment")+'</strong><span>'+esc(row.gradingMode||"Individual")+' grading</span></div>'+(row.gradingMode==="Shared"?'<button class="text-btn" data-teaching-action="grade-group-work" data-section="'+sectionId+'" data-id="'+row.id+'">Grade Group</button>':'<span class="badge">Use Gradebook</span>')+'</div>').join("")+'</div>':'')+
          '<div class="card-actions"><button class="secondary-btn small-btn" data-teaching-action="assign-group-work" data-section="'+sectionId+'" data-group="'+g.id+'">Assign Group Work</button><button class="secondary-btn small-btn" data-teaching-action="edit-group" data-section="'+sectionId+'" data-id="'+g.id+'">Edit</button><button class="text-btn danger-text" data-teaching-action="delete-group" data-section="'+sectionId+'" data-id="'+g.id+'">Delete</button></div></article>';
      }).join("")+'</div>':'<div class="empty-mini">No groups created.</div>'),
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

async function groupAssignmentModal(sectionId,groupId){
  const groups=await docs(["sections",sectionId,"groups"]),group=groups.find(x=>x.id===groupId),assignments=(sectionData()?.assignments||[]).filter(a=>a.status!=="Draft");
  if(!group)return toast("Group not found.");
  if(!assignments.length)return toast("Publish at least one assignment before attaching group work.");
  const m=modal({
    eyebrow:"Group Coursework",
    title:"Assign Work — "+(group.name||"Group"),
    body:'<form id="groupAssignmentForm"><div class="field"><label>Coursework</label><select name="assignmentId">'+assignments.map(a=>'<option value="'+a.id+'">'+esc(a.title||"Assignment")+' • '+esc(a.points||0)+' pts</option>').join("")+'</select></div><div class="field"><label>Grading Model</label><select name="gradingMode"><option>Shared</option><option>Individual</option></select></div><div class="notice"><strong>Shared:</strong> one score/comment is copied to every current group member. <strong>Individual:</strong> the grouping is recorded, but each student is graded independently in the normal Gradebook.</div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Attach Group Work</button></div></form>'
  });
  m.querySelector("#groupAssignmentForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),assignmentId=String(fd.get("assignmentId")),assignment=assignments.find(a=>a.id===assignmentId),gradingMode=String(fd.get("gradingMode")||"Individual");
    try{
      await setDoc(doc(db,"sections",sectionId,"groupAssignments",groupId+"_"+assignmentId),{
        groupId,groupName:group.name||"Group",memberIds:safe(group.memberIds),assignmentId,assignmentTitle:assignment?.title||"Assignment",
        gradingMode,createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      await p5()?.logSectionEvent?.(sectionId,"group_assignment_created","group",groupId,{assignmentId,gradingMode});
      closeModal();toast("Group work attached.");await groupsModal(sectionId);
    }catch(error){toast(error.message||"Unable to attach group work.");}
  };
}

async function gradeGroupWork(sectionId,groupAssignmentId){
  const [groupAssignments,groups]=await Promise.all([docs(["sections",sectionId,"groupAssignments"]),docs(["sections",sectionId,"groups"])]);
  const row=groupAssignments.find(x=>x.id===groupAssignmentId);if(!row)return toast("Group assignment not found.");
  const group=groups.find(x=>x.id===row.groupId);if(!group)return toast("Group not found.");
  const assignment=(sectionData()?.assignments||[]).find(a=>a.id===row.assignmentId);if(!assignment)return toast("Assignment not found.");
  if(row.gradingMode!=="Shared")return toast("This group assignment uses individual grading. Grade students from the normal Gradebook.");
  const members=safe(group.memberIds).map(memberById).filter(Boolean);
  if(!members.length)return toast("This group has no enrolled members.");
  const m=modal({
    eyebrow:"Shared Group Grade",
    title:(group.name||"Group")+" — "+(assignment.title||"Assignment"),
    body:'<form id="sharedGroupGradeForm"><div class="notice">This score will be written as an individual grade record for each current group member, with a shared-group audit marker. You can still override an individual student later with a reason.</div><div class="field"><label>Score</label><div class="input-with-suffix"><input name="score" type="number" min="0" max="'+esc(assignment.points||0)+'" step="0.1" required><span>/ '+esc(assignment.points||0)+'</span></div></div><div class="field"><label>Group Feedback</label><textarea name="comment"></textarea></div><div class="item-tags">'+members.map(m=>'<span>'+esc(m.displayName||"Student")+'</span>').join("")+'</div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Apply Shared Grade</button></div></form>'
  });
  m.querySelector("#sharedGroupGradeForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),score=Number(fd.get("score")||0),comment=String(fd.get("comment")||"").trim();
    if(score>Number(assignment.points||0))return toast("The shared score cannot exceed the assignment point value.");
    try{
      const batch=writeBatch(db);
      members.forEach(student=>batch.set(doc(db,"sections",sectionId,"grades",assignment.id+"_"+student.id),{
        assignmentId:assignment.id,assignmentTitle:assignment.title||"Assignment",studentId:student.id,studentName:student.displayName||"Student",
        score,maxPoints:Number(assignment.points||0),gradeStatus:"Normal",comment,groupGrade:true,groupId:group.id,groupName:group.name||"Group",
        groupAssignmentId,updatedAt:serverTimestamp()
      },{merge:true}));
      batch.update(doc(db,"sections",sectionId,"groupAssignments",groupAssignmentId),{lastSharedScore:score,lastGradedAt:serverTimestamp(),updatedAt:serverTimestamp()});
      await batch.commit();
      await p5()?.logSectionEvent?.(sectionId,"shared_group_grade_applied","group",group.id,{assignmentId:assignment.id,score,memberIds:members.map(x=>x.id)});
      closeModal();toast("Shared group grade applied to "+members.length+" student"+(members.length===1?"":"s")+".");await core().reloadCurrentSection("gradebook");
    }catch(error){toast(error.message||"Unable to apply the shared group grade.");}
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
    docs(["sections",sec.id,"flags"]),
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
      '<div class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Narrative Evaluation</div><div class="panel-subtitle">Term-level academic commentary separate from numerical grades.</div></div></div><div class="panel-body"><form id="narrativeForm"><div class="field"><label>Strengths</label><textarea name="strengths">'+esc(narrative?.strengths||"")+'</textarea></div><div class="field"><label>Growth / Recommendations</label><textarea name="recommendations">'+esc(narrative?.recommendations||"")+'</textarea></div><label class="checkbox-line"><input type="checkbox" name="includeOnRecord" '+(narrative?.includeOnRecord?'checked':'')+'> Include on student academic record</label><button class="primary-btn" type="submit">Save Narrative Evaluation</button></form></div></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
  m.querySelector("#narrativeForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{
      await setDoc(doc(db,"sections",sec.id,"narratives",studentId),{studentId,studentName:student.displayName||"Student",strengths:String(fd.get("strengths")||"").trim(),recommendations:String(fd.get("recommendations")||"").trim(),includeOnRecord:e.currentTarget.elements.includeOnRecord.checked,updatedBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});
      await p5()?.logSectionEvent?.(sec.id,"narrative_evaluation_updated","student",studentId,{includeOnRecord:e.currentTarget.elements.includeOnRecord.checked});
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
    try{await addDoc(collection(db,"sections",section().id,"flags"),{studentId,studentName:student.displayName||"Student",type:String(fd.get("type")),note:String(fd.get("note")).trim(),status:"Active",createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});await p5()?.logSectionEvent?.(section().id,"student_flag_created","student",studentId,{type:String(fd.get("type"))});closeModal();toast("Academic flag created.");await studentProfileModal(studentId);}catch(error){toast(error.message||"Unable to create flag.");}
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
  const [assignments,grades,assessmentGrades,attendance,flags]=await Promise.all([
    docs(["sections",selected.id,"assignments"]),docs(["sections",selected.id,"grades"]),docs(["sections",selected.id,"assessmentGrades"]),
    docs(["sections",selected.id,"attendance"]),docs(["sections",selected.id,"flags"])
  ]);
  const published=assignments.filter(a=>a.status!=="Draft"),now=new Date();
  const pastDue=published.filter(a=>a.dueDate&&new Date(a.dueDate+"T23:59:59")<now);
  const gradeMap=new Map(grades.map(g=>[g.assignmentId+"_"+g.studentId,g]));
  let missingWork=0;
  data.members.forEach(student=>pastDue.forEach(a=>{const g=gradeMap.get(a.id+"_"+student.id);if(!g||g.gradeStatus==="Missing")missingWork++;}));
  const gradedCoursework=grades.filter(g=>g.gradeStatus!=="Excused"&&g.score!==null&&g.score!==undefined&&Number(g.maxPoints||0)>0);
  const courseworkAvg=gradedCoursework.length?Math.round(gradedCoursework.reduce((n,g)=>n+(Number(g.score||0)/Number(g.maxPoints||1)*100),0)/gradedCoursework.length*10)/10:null;
  const assessed=assessmentGrades.filter(g=>g.percent!==null&&g.percent!==undefined);
  const assessmentAvg=assessed.length?Math.round(assessed.reduce((n,g)=>n+Number(g.percent||0),0)/assessed.length*10)/10:null;
  const attendanceRows=attendance.filter(x=>["Present","Remote","Absent","Tardy","Excused"].includes(x.status));
  const attended=attendanceRows.filter(x=>["Present","Remote","Tardy"].includes(x.status)).length;
  const attendanceRate=attendanceRows.length?Math.round(attended/attendanceRows.length*1000)/10:null;
  const activeFlags=flags.filter(x=>x.status!=="Resolved").length;
  const studentSummary=data.members.map(student=>{
    const cg=gradedCoursework.filter(g=>g.studentId===student.id),ag=assessed.filter(g=>g.studentId===student.id);
    const courseAvg=cg.length?Math.round(cg.reduce((n,g)=>n+(Number(g.score||0)/Number(g.maxPoints||1)*100),0)/cg.length*10)/10:null;
    const assessAvg=ag.length?Math.round(ag.reduce((n,g)=>n+Number(g.percent||0),0)/ag.length*10)/10:null;
    const missing=pastDue.filter(a=>{const g=gradeMap.get(a.id+"_"+student.id);return !g||g.gradeStatus==="Missing";}).length;
    return {student,courseAvg,assessAvg,missing};
  }).sort((a,b)=>Number(a.courseAvg??999)-Number(b.courseAvg??999));

  el.innerHTML='<div class="insights-toolbar"><div class="field"><label>Section</label><select id="insightsSectionSelect">'+sections.map(x=>'<option value="'+x.id+'" '+(x.id===selected.id?'selected':'')+'>'+esc((x.courseCode||"Course")+" — "+(x.sectionName||x.courseTitle))+'</option>').join("")+'</select></div><button class="secondary-btn" data-teaching-action="section-tools" data-section="'+selected.id+'">Teaching Tools</button></div>'+
    '<div class="academic-banner"><div class="kicker">Instructor Analytics</div><h3>'+esc(selected.courseCode||"Course")+' — '+esc(selected.sectionName||selected.courseTitle)+'</h3><p>Class performance, completion, attendance, academic flags, and competency evidence in one teaching dashboard.</p></div>'+
    '<div class="insight-metric-grid"><div><span>Coursework Avg</span><strong>'+(courseworkAvg===null?"—":courseworkAvg+"%")+'</strong></div><div><span>Assessment Avg</span><strong>'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</strong></div><div><span>Past-Due Missing</span><strong>'+missingWork+'</strong></div><div><span>Attendance</span><strong>'+(attendanceRate===null?"—":attendanceRate+"%")+'</strong></div><div><span>Active Flags</span><strong>'+activeFlags+'</strong></div></div>'+
    '<div class="grid-2" style="margin-top:16px"><div class="panel"><div class="panel-head"><div><div class="panel-title">Student Performance Snapshot</div><div class="panel-subtitle">Current graded coursework and formal-assessment averages.</div></div></div><div class="panel-body">'+(studentSummary.length?studentSummary.map(row=>'<button class="student-insight-row" data-teaching-action="student-profile" data-student="'+row.student.id+'"><div><strong>'+esc(row.student.displayName||"Student")+'</strong><span>'+row.missing+' past-due missing item'+(row.missing===1?"":"s")+'</span></div><div><b>'+(row.courseAvg===null?"—":row.courseAvg+"%")+'</b><small>coursework</small></div><div><b>'+(row.assessAvg===null?"—":row.assessAvg+"%")+'</b><small>assessments</small></div></button>').join(""):'<div class="empty-mini">No students enrolled.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div><div class="panel-title">Teaching Attention</div><div class="panel-subtitle">Signals that may merit instructor review.</div></div></div><div class="panel-body"><div class="detail-list"><div><span>Students with missing work</span><strong>'+studentSummary.filter(x=>x.missing>0).length+'</strong></div><div><span>Students below 70% coursework avg</span><strong>'+studentSummary.filter(x=>x.courseAvg!==null&&x.courseAvg<70).length+'</strong></div><div><span>Competencies below 70% class evidence</span><strong>'+compCodes.filter(code=>{const vals=data.rows.map(r=>safe(r.competencies).find(c=>c.code===code)?.percent).filter(v=>v!==undefined);return vals.length&&vals.reduce((n,v)=>n+Number(v),0)/vals.length<70;}).length+'</strong></div><div><span>Active academic flags</span><strong>'+activeFlags+'</strong></div></div></div></div></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Competency Heatmap</div><div class="panel-subtitle">Students × competencies based on current evidence.</div></div></div><div class="panel-body">'+
    (data.members.length&&compCodes.length?'<div class="heatmap-wrap"><table class="heatmap-table"><thead><tr><th>Student</th>'+compCodes.map(code=>'<th>'+esc(code)+'</th>').join("")+'</tr></thead><tbody>'+data.members.map(student=>{const mastery=masteryMap.get(student.id),byCode=new Map(safe(mastery?.competencies).map(c=>[c.code,c]));return '<tr><td><button class="text-btn" data-teaching-action="student-profile" data-student="'+student.id+'">'+esc(student.displayName||"Student")+'</button></td>'+compCodes.map(code=>{const v=byCode.get(code)?.percent;const cls=v===undefined?"none":v>=85?"high":v>=70?"mid":"low";return '<td class="heat '+cls+'">'+(v===undefined?"—":esc(v)+"%")+'</td>';}).join("")+'</tr>';}).join("")+'</tbody></table></div>':'<div class="empty-mini">Mastery evidence or course competencies are not available yet.</div>')+'</div></div>';
  const sel=$("#insightsSectionSelect");if(sel)sel.onchange=()=>{sessionStorage.setItem("theoria-insights-section",sel.value);renderInsights();};
}

/* -------------------- ASSESSMENT SECURITY -------------------- */

async function hashCode(value){
  const bytes=new TextEncoder().encode(String(value||""));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function assessmentSecurityModal(assessmentId){
  if(window.TheoriaPhase3?.openAssessment)return window.TheoriaPhase3.openAssessment(assessmentId,"security");
}

async function renderAssessmentSecurity(detail){
  const root=$("#phase6AssessmentSecurity");if(!root||!detail?.assessment)return;
  const a=detail.assessment,p=a.securityPolicy||{};
  root.innerHTML='<form id="phase6SecurityForm" class="academic-form">'+
    '<div class="academic-banner"><div class="kicker">Assessment Security Center</div><h3>Attempt & Session Policy</h3><p>Use proportionate academic-integrity controls without invasive device surveillance. Security events are recorded in the existing attempt event log.</p></div>'+
    '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Attempt Controls</h3><p>Control entry timing, retakes, and acknowledgement.</p></div></div><div class="compact-field-grid"><div class="field"><label>Maximum Attempts</label><input name="maxAttempts" type="number" min="1" max="10" value="'+esc(p.maxAttempts||1)+'"></div><div class="field"><label>Late Entry</label><select name="lateEntryPolicy"><option value="allow">Allow while assessment is open</option><option value="deny-after-start">Deny after opening grace period</option></select></div><div class="field"><label>Late Entry Grace</label><div class="input-with-suffix"><input name="lateEntryGraceMinutes" type="number" min="0" max="1440" value="'+esc(p.lateEntryGraceMinutes||0)+'"><span>min</span></div></div></div><label class="policy-card"><input type="checkbox" name="honorAcknowledgement" '+(p.honorAcknowledgement?'checked':'')+'><div><strong>Academic Integrity Acknowledgement</strong><span>Require the student to affirm the instructor’s integrity expectations before the attempt begins.</span></div></label></section>'+
    '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Session Expectations</h3><p>Configure browser-session signals that Theoria may record for instructor review.</p></div></div><div class="policy-grid"><label class="policy-card"><input type="checkbox" name="fullscreenExpectation" '+(p.fullscreenExpectation?'checked':'')+'><div><strong>Fullscreen Expected</strong><span>Tell students fullscreen is expected and permit fullscreen-change logging.</span></div></label><label class="policy-card"><input type="checkbox" name="logFocusLoss" '+(p.logFocusLoss!==false?'checked':'')+'><div><strong>Log Focus Changes</strong><span>Record focus/visibility changes as attempt events.</span></div></label><label class="policy-card"><input type="checkbox" name="blockPaste" '+(p.blockPaste?'checked':'')+'><div><strong>Block Paste</strong><span>Prevent paste into assessment response fields.</span></div></label><label class="policy-card"><input type="checkbox" name="logCopy" '+(p.logCopy!==false?'checked':'')+'><div><strong>Log Copy Events</strong><span>Record copy actions during the assessment session.</span></div></label></div></section>'+
    '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Access Code</h3><p>Optionally require a code before the official attempt begins.</p></div></div><label class="policy-card"><input type="checkbox" name="accessCodeConfigured" '+(p.accessCodeConfigured?'checked':'')+'><div><strong>Require Access Code</strong><span>The stored value is hashed; instructors can replace it but cannot read the previous code.</span></div></label><div class="field" style="margin-top:12px"><label>'+(p.accessCodeConfigured?'Replace Access Code (leave blank to keep current)':'Access Code')+'</label><input name="accessCode" type="password" autocomplete="new-password"></div></section>'+
    '<div class="modal-foot form-sticky-foot"><button class="primary-btn" type="submit">Save Security Policy</button></div></form>';
  const form=root.querySelector("#phase6SecurityForm");form.elements.lateEntryPolicy.value=p.lateEntryPolicy||"allow";
  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(form),code=String(fd.get("accessCode")||"").trim(),configured=form.elements.accessCodeConfigured.checked;
    const policy={
      maxAttempts:Math.max(1,Math.floor(Number(fd.get("maxAttempts")||1))),
      lateEntryPolicy:String(fd.get("lateEntryPolicy")||"allow"),
      lateEntryGraceMinutes:Math.max(0,Number(fd.get("lateEntryGraceMinutes")||0)),
      honorAcknowledgement:form.elements.honorAcknowledgement.checked,
      fullscreenExpectation:form.elements.fullscreenExpectation.checked,
      logFocusLoss:form.elements.logFocusLoss.checked,
      blockPaste:form.elements.blockPaste.checked,
      logCopy:form.elements.logCopy.checked,
      accessCodeConfigured:configured,
      accessCodeHash:configured?(code?await hashCode(code):(p.accessCodeHash||"")):"",
      updatedAt:serverTimestamp()
    };
    if(configured&&!policy.accessCodeHash)return toast("Enter an access code.");
    try{
      await updateDoc(doc(db,"assessments",a.id),{securityPolicy:policy,updatedAt:serverTimestamp()});
      if(a.sectionId)await p5()?.logSectionEvent?.(a.sectionId,"assessment_security_updated","assessment",a.id,{maxAttempts:policy.maxAttempts,lateEntryPolicy:policy.lateEntryPolicy,fullscreenExpectation:policy.fullscreenExpectation,accessCodeConfigured:policy.accessCodeConfigured});
      Object.assign(a,{securityPolicy:policy});toast("Assessment security policy saved.");
    }catch(error){toast(error.message||"Unable to save the security policy.");}
  };

  if(a.sectionId){
    const signalPanel=document.createElement("section");
    signalPanel.className="form-section security-signal-panel";
    signalPanel.innerHTML='<div class="form-section-head"><div><span>04</span><h3>Session Signal Summary</h3><p>Browser-session events are context for instructor review, not automatic evidence of misconduct.</p></div></div><div id="securitySignalBody"><div class="empty-mini">Loading attempt signals…</div></div>';
    root.appendChild(signalPanel);
    const body=signalPanel.querySelector("#securitySignalBody"),rows=[];
    const memberMap=new Map(safe(detail.members).map(m=>[m.id,m]));
    for(const submission of safe(detail.submissions)){
      try{
        const eventSnap=await getDocs(collection(db,"assessments",a.id,"submissions",submission.studentId,"events"));
        const events=eventSnap.docs.map(d=>d.data()),counts={focus:0,copy:0,paste:0,fullscreen:0,other:0};
        events.forEach(ev=>{
          const type=String(ev.type||"").toLowerCase();
          if(type.includes("focus")||type.includes("blur")||type.includes("visibility"))counts.focus++;
          else if(type.includes("copy"))counts.copy++;
          else if(type.includes("paste"))counts.paste++;
          else if(type.includes("fullscreen"))counts.fullscreen++;
          else counts.other++;
        });
        rows.push({studentId:submission.studentId,name:memberMap.get(submission.studentId)?.displayName||submission.candidateNumber||"Candidate",events:events.length,...counts});
      }catch(_){}
    }
    body.innerHTML=rows.length?'<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Candidate</th><th>Total Events</th><th>Focus / Visibility</th><th>Copy</th><th>Paste</th><th>Fullscreen</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><strong>'+esc(row.name)+'</strong></td><td>'+row.events+'</td><td>'+row.focus+'</td><td>'+row.copy+'</td><td>'+row.paste+'</td><td>'+row.fullscreen+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty-mini">No session events have been recorded for this assessment.</div>';
  }
}

async function preflightSecurity(assessment){
  const p=assessment?.securityPolicy||{},uid=state()?.user?.uid;if(!uid)return false;
  const now=Date.now(),opens=assessment.opensAt?.toMillis?.()||0;
  if(p.lateEntryPolicy==="deny-after-start"&&opens){
    const grace=Math.max(0,Number(p.lateEntryGraceMinutes||0))*60000;
    if(now>opens+grace){toast("Late entry is not permitted for this assessment.");return false;}
  }
  if(p.maxAttempts){
    try{
      const counter=await getDoc(doc(db,"assessments",assessment.id,"attemptCounters",uid));
      const used=counter.exists()?Number(counter.data().count||0):0;
      if(used>=Math.max(1,Number(p.maxAttempts||1))){toast("The maximum number of attempts has been reached.");return false;}
    }catch(_){}
  }
  if(p.accessCodeConfigured){
    const entered=prompt("Enter the assessment access code:");
    if(entered===null)return false;
    const hash=await hashCode(String(entered).trim());
    if(!hash||hash!==p.accessCodeHash){toast("The assessment access code is incorrect.");return false;}
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
  document.addEventListener("fullscreenchange",()=>{const current=window.TheoriaPhase3?.getCurrent?.();if(current&&$("#page-exam")?.classList.contains("active"))logExamSecurityEvent("fullscreen_change",{fullscreen:!!document.fullscreenElement});});
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

async function renderBlueprintDesigner(detail){
  const root=$("#phase6BlueprintDesigner");if(!root||!detail?.assessment)return;
  const a=detail.assessment,questions=detail.questions||[],total=questions.reduce((n,q)=>n+Number(q.points||0),0),targets=a.blueprintDesign||{};
  const unitMap=new Map(),cogMap=new Map(),compMap=new Map();
  questions.forEach(q=>{
    const pts=Number(q.points||0),unit=q.unitTitle||q.unitId||"Unmapped",cog=q.cognitiveLevel||"Unspecified";
    unitMap.set(unit,(unitMap.get(unit)||0)+pts);cogMap.set(cog,(cogMap.get(cog)||0)+pts);
    const comps=safe(q.competencyCodes);if(comps.length){const share=pts/comps.length;comps.forEach(code=>compMap.set(code,(compMap.get(code)||0)+share));}
  });
  const actual=(map,key)=>total?Math.round(((map.get(key)||0)/total)*1000)/10:0;
  const row=(kind,key,map,targetSet)=>{
    const now=actual(map,key),target=targetSet?.[key]??now,delta=Math.round((now-Number(target||0))*10)/10;
    return '<div class="blueprint-intelligence-row '+(Math.abs(delta)>=10?'mismatch':'')+'"><div><strong>'+esc(key)+'</strong><span>Actual '+now+'%'+(Math.abs(delta)>=10?' • '+(delta>0?"+":"")+delta+' pts from target':'')+'</span></div><div class="input-with-suffix mini"><input type="number" step="0.1" min="0" max="100" data-blueprint-kind="'+kind+'" data-blueprint-key="'+esc(key)+'" value="'+esc(target)+'"><span>%</span></div></div>';
  };
  root.innerHTML='<form id="phase6BlueprintForm" class="academic-form"><div class="academic-banner"><div class="kicker">Assessment Blueprint Designer</div><h3>Actual coverage vs. intended coverage.</h3><p>Targets are advisory. Theoria highlights mismatches but never silently rewrites your questions.</p></div>'+
    '<div class="grid-2"><section class="form-section"><div class="panel-title">Unit Coverage</div><div class="blueprint-intelligence-list">'+[...unitMap.keys()].map(k=>row("units",k,unitMap,targets.units)).join("")+'</div></section><section class="form-section"><div class="panel-title">Cognitive Levels</div><div class="blueprint-intelligence-list">'+[...cogMap.keys()].map(k=>row("cognitiveLevels",k,cogMap,targets.cognitiveLevels)).join("")+'</div></section></div>'+
    '<section class="form-section"><div class="panel-title">Competency Coverage</div><div class="blueprint-intelligence-list">'+([...compMap.keys()].length?[...compMap.keys()].map(k=>row("competencies",k,compMap,targets.competencies)).join(""):'<div class="empty-mini">No competency-tagged assessment questions.</div>')+'</div></section>'+
    '<div class="modal-foot form-sticky-foot"><button class="primary-btn" type="submit">Save Blueprint Targets</button></div></form>';
  root.querySelector("#phase6BlueprintForm").onsubmit=async e=>{
    e.preventDefault();const out={units:{},cognitiveLevels:{},competencies:{}};
    root.querySelectorAll("[data-blueprint-kind]").forEach(input=>out[input.dataset.blueprintKind][input.dataset.blueprintKey]=Number(input.value||0));
    try{await updateDoc(doc(db,"assessments",a.id),{blueprintDesign:{...out,updatedAt:serverTimestamp()},updatedAt:serverTimestamp()});a.blueprintDesign=out;toast("Blueprint targets saved.");renderBlueprintDesigner(detail);}catch(error){toast(error.message||"Unable to save blueprint targets.");}
  };
}

async function blueprintDesigner(assessmentId){
  if(window.TheoriaPhase3?.openAssessment)return window.TheoriaPhase3.openAssessment(assessmentId,"blueprint");
}


async function renderTeachingToolsPage(){
  const el=$("#teachingToolsContent"),s=state();if(!el)return;
  if(s?.role!=="instructor"){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">T</div><h3>Instructor workspace.</h3><p>Teaching Tools are available to instructors and delegated academic staff.</p></div>';
    return;
  }
  const sections=(s.sections||[]).filter(sec=>sec.status!=="Archived");
  el.innerHTML='<div class="academic-banner"><div class="kicker">Instructor Operations</div><h3>Teaching tools across your active sections.</h3><p>Rubrics, attendance, deadline extensions, student groups, academic flags, narrative evaluations, student profiles, and bulk operations are organized by section.</p></div>'+
    (sections.length?'<div class="teaching-tools-section-grid">'+sections.map(sec=>'<article class="academic-card"><div class="card-kicker">'+esc(sec.courseCode||"Course")+' • '+esc(sec.term||"")+'</div><h3>'+esc(sec.sectionName||sec.courseTitle||"Section")+'</h3><p>'+esc(sec.courseTitle||"")+(sec.staffRole&&sec.staffRole!=="owner"?' • '+esc(String(sec.staffRole).replace(/_/g," ")):'')+'</p><div class="card-actions"><button class="primary-btn small-btn" data-teaching-action="open-section-tools" data-section="'+sec.id+'">Open Teaching Tools</button><button class="secondary-btn small-btn" data-teaching-action="open-section" data-section="'+sec.id+'">Open Section</button></div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">T</div><h3>No active teaching sections.</h3><p>Create or restore a section to use instructor tools.</p></div>');
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
  window.addEventListener("theoria:page",e=>{if(e.detail.page==="insights")renderInsights();if(e.detail.page==="teaching-tools")renderTeachingToolsPage();});
  document.addEventListener("click",async e=>{
    const b=e.target.closest("[data-teaching-action]");if(!b)return;
    const a=b.dataset.teachingAction,sid=b.dataset.section||section()?.id;
    if(a==="section-tools")return sectionToolsModal(sid);
    if(a==="open-section-tools"){await core().openSection(sid,"overview");return sectionToolsModal(sid);}
    if(a==="rubrics"){closeModal();return rubricLibraryModal(sid);}
    if(a==="new-rubric"){closeModal();return rubricEditor(sid);}
    if(a==="edit-rubric"){closeModal();return rubricEditor(sid,b.dataset.id);}
    if(a==="delete-rubric"){if(confirm("Delete this reusable rubric? Assignments already graded with it keep their stored rubric evidence.")){const sec=await ensureSection(sid);if(!sec)return;await deleteDoc(doc(db,"courses",sec.courseId,"rubrics",b.dataset.id));closeModal();toast("Rubric deleted.");return rubricLibraryModal(sid);}return;}
    if(a==="rubric-analytics"){closeModal();return rubricAnalyticsModal(sid,b.dataset.id);}
    if(a==="attach-rubric"){closeModal();return attachRubric(sid,b.dataset.id);}
    if(a==="attendance"){closeModal();return attendanceModal(sid);}
    if(a==="extensions"){closeModal();return extensionsModal(sid);}
    if(a==="delete-extension"){await deleteDoc(doc(db,"sections",sid,"extensions",b.dataset.id));closeModal();toast("Extension removed.");return extensionsModal(sid);}
    if(a==="groups"){closeModal();return groupsModal(sid);}
    if(a==="new-group"){closeModal();return groupEditor(sid);}
    if(a==="edit-group"){closeModal();return groupEditor(sid,b.dataset.id);}
    if(a==="assign-group-work"){closeModal();return groupAssignmentModal(sid,b.dataset.group);}
    if(a==="grade-group-work"){closeModal();return gradeGroupWork(sid,b.dataset.id);}
    if(a==="delete-group"){if(confirm("Delete this student group?")){await deleteDoc(doc(db,"sections",sid,"groups",b.dataset.id));closeModal();return groupsModal(sid);}return;}
    if(a==="student-directory"){closeModal();return studentDirectory();}
    if(a==="student-profile"){closeModal();return studentProfileModal(b.dataset.student);}
    if(a==="new-flag"){closeModal();return newFlagModal(b.dataset.student);}
    if(a==="resolve-flag"){await updateDoc(doc(db,"sections",section().id,"flags",b.dataset.id),{status:"Resolved",resolvedAt:serverTimestamp(),resolvedBy:state().user.uid,updatedAt:serverTimestamp()});closeModal();toast("Flag resolved.");return studentProfileModal(b.dataset.student);}
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
    renderInsights,renderTeachingToolsPage,sectionToolsModal,rubricLibraryModal,openRubricGrade,
    assessmentSecurityModal,preflightSecurity,renderAssessmentSecurity,hashCode,
    questionQualityModal,blueprintDesigner,renderBlueprintDesigner,
    studentProfileModal
  };
}
