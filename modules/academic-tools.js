import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();
const pct=(n,d)=>d?Math.round(Number(n||0)/Number(d||0)*1000)/10:null;
const fmt=v=>core()?.formatDate?.(v)||"—";
const activeSections=()=>state()?.sections?.filter(s=>s.status!=="Archived")||[];
const ownedSections=()=>activeSections().filter(s=>s.ownerId===state()?.user?.uid||["owner","coordinator","teaching_assistant","grader"].includes(s.staffRole));
const currentSection=()=>state()?.currentSection||ownedSections()[0]||null;

async function loadSectionBundle(section){
  if(!section)return null;
  const [members,assignments,grades,mastery,flags,narratives,groups,extensions,attendance]=await Promise.all([
    getDocs(collection(db,"sections",section.id,"members")),
    getDocs(collection(db,"sections",section.id,"assignments")),
    getDocs(collection(db,"sections",section.id,"grades")),
    getDocs(collection(db,"sections",section.id,"mastery")),
    getDocs(collection(db,"sections",section.id,"flags")),
    getDocs(collection(db,"sections",section.id,"narratives")),
    getDocs(collection(db,"sections",section.id,"groups")),
    getDocs(collection(db,"sections",section.id,"extensions")),
    getDocs(collection(db,"sections",section.id,"attendance"))
  ]);
  return {
    section,
    members:members.docs.map(d=>({id:d.id,...d.data()})),
    assignments:assignments.docs.map(d=>({id:d.id,...d.data()})),
    grades:grades.docs.map(d=>({id:d.id,...d.data()})),
    mastery:mastery.docs.map(d=>({id:d.id,...d.data()})),
    flags:flags.docs.map(d=>({id:d.id,...d.data()})),
    narratives:narratives.docs.map(d=>({id:d.id,...d.data()})),
    groups:groups.docs.map(d=>({id:d.id,...d.data()})),
    extensions:extensions.docs.map(d=>({id:d.id,...d.data()})),
    attendance:attendance.docs.map(d=>({id:d.id,...d.data()}))
  };
}

function sectionPicker(selected){
  return '<div class="field tool-section-picker"><label>Teaching Section</label><select id="academicToolsSection">'+ownedSections().map(s=>'<option value="'+s.id+'" '+(s.id===selected?.id?'selected':'')+'>'+esc((s.courseCode||"Course")+" — "+(s.sectionName||s.courseTitle||"Section"))+'</option>').join("")+'</select></div>';
}

let selectedSectionId="";
function pickSection(){return ownedSections().find(s=>s.id===selectedSectionId)||currentSection();}

async function loadRubrics(courseId){
  if(!courseId)return [];
  try{
    const snap=await getDocs(collection(db,"courses",courseId,"rubrics"));
    return snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.title||"").localeCompare(String(b.title||"")));
  }catch(_){return [];}
}

async function renderTeachingTools(){
  const el=$("#teachingToolsContent"),s=state();if(!el||s?.role!=="instructor")return;
  const sections=ownedSections();
  if(!sections.length){el.innerHTML='<div class="empty-state"><div class="empty-symbol">T</div><h3>No teaching sections.</h3><p>Create or receive access to a section before using teaching tools.</p></div>';return;}
  const section=pickSection()||sections[0];selectedSectionId=section.id;
  el.innerHTML=sectionPicker(section)+'<div class="tool-tabs"><button class="tab-btn active" data-academic-tool="rubrics">Rubrics</button><button class="tab-btn" data-academic-tool="attendance">Attendance</button><button class="tab-btn" data-academic-tool="groups">Groups</button><button class="tab-btn" data-academic-tool="extensions">Extensions</button><button class="tab-btn" data-academic-tool="flags">Academic Flags</button><button class="tab-btn" data-academic-tool="narratives">Narratives</button><button class="tab-btn" data-academic-tool="bulk">Bulk Operations</button></div><div id="academicToolBody"></div>';
  $("#academicToolsSection").onchange=e=>{selectedSectionId=e.target.value;renderTeachingTools();};
  renderTool("rubrics");
}

async function renderTool(name){
  document.querySelectorAll("[data-academic-tool]").forEach(b=>b.classList.toggle("active",b.dataset.academicTool===name));
  const section=pickSection(),box=$("#academicToolBody");if(!section||!box)return;
  box.innerHTML='<div class="empty-mini">Loading…</div>';
  if(name==="rubrics")return renderRubrics(section,box);
  const bundle=await loadSectionBundle(section);
  if(name==="attendance")return renderAttendance(bundle,box);
  if(name==="groups")return renderGroups(bundle,box);
  if(name==="extensions")return renderExtensions(bundle,box);
  if(name==="flags")return renderFlags(bundle,box);
  if(name==="narratives")return renderNarratives(bundle,box);
  if(name==="bulk")return renderBulk(bundle,box);
}

async function renderRubrics(section,box){
  const rubrics=await loadRubrics(section.courseId);
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Reusable Rubric Library</div><p class="page-subtitle">Criterion-level scoring structures shared across assignments in '+esc(section.courseCode||"this course")+'.</p></div><button class="primary-btn small-btn" data-academic-action="new-rubric" data-course="'+section.courseId+'">Create Rubric</button></div>'+
    (rubrics.length?'<div class="rubric-grid">'+rubrics.map(r=>'<article class="academic-card"><div class="card-kicker">Rubric • '+esc(r.criteria?.length||0)+' criteria</div><h3>'+esc(r.title||"Rubric")+'</h3><p>'+esc(r.description||"")+'</p><div class="item-tags">'+(r.criteria||[]).slice(0,5).map(c=>'<span>'+esc(c.name)+' • '+esc(c.points)+' pts</span>').join("")+'</div><div class="card-actions"><button class="secondary-btn small-btn" data-academic-action="edit-rubric" data-course="'+section.courseId+'" data-id="'+r.id+'">Edit</button></div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">R</div><h3>No reusable rubrics yet.</h3><p>Create one to use consistent criterion-level grading across assignments.</p></div>');
}

async function rubricModal(courseId,rubricId=""){
  const rubrics=await loadRubrics(courseId),existing=rubrics.find(r=>r.id===rubricId),criteria=existing?.criteria?.length?existing.criteria:[{name:"Academic Quality",description:"",points:10}];
  const m=modal({
    eyebrow:"Rubric Library",
    title:existing?"Edit Rubric":"Create Rubric",
    wide:true,
    body:'<form id="rubricForm"><div class="field"><label>Rubric Title</label><input name="title" value="'+esc(existing?.title||"")+'" required></div><div class="field"><label>Description</label><textarea name="description">'+esc(existing?.description||"")+'</textarea></div><div class="structured-builder"><div class="structured-builder-head"><div><strong>Criteria</strong><span>Each criterion carries its own maximum points.</span></div><button type="button" class="secondary-btn small-btn" id="addRubricCriterion">+ Criterion</button></div><div id="rubricCriteria" class="structured-list"></div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Rubric</button></div></form>'
  });
  const box=m.querySelector("#rubricCriteria");
  const add=row=>{
    const div=document.createElement("div");div.className="structured-row rubric-criterion-row";
    div.innerHTML='<div class="structured-index">◇</div><input class="structured-input criterion-name" placeholder="Criterion" value="'+esc(row.name||"")+'"><input class="structured-input criterion-desc" placeholder="What is evaluated?" value="'+esc(row.description||"")+'"><div class="input-with-suffix mini"><input class="criterion-points" type="number" min="0" step="0.5" value="'+esc(row.points??10)+'"><span>pts</span></div><button type="button" class="row-remove">×</button>';
    div.querySelector(".row-remove").onclick=()=>div.remove();box.appendChild(div);
  };
  criteria.forEach(add);m.querySelector("#addRubricCriterion").onclick=()=>add({});
  m.querySelector("#rubricForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),rows=[...box.querySelectorAll(".rubric-criterion-row")].map((r,i)=>({order:i+1,name:r.querySelector(".criterion-name").value.trim(),description:r.querySelector(".criterion-desc").value.trim(),points:Number(r.querySelector(".criterion-points").value||0)})).filter(x=>x.name);
    if(!rows.length)return toast("Add at least one rubric criterion.");
    const data={title:String(fd.get("title")).trim(),description:String(fd.get("description")||"").trim(),criteria:rows,totalPoints:rows.reduce((n,x)=>n+x.points,0),updatedAt:serverTimestamp(),updatedBy:state().user.uid};
    try{
      if(existing)await updateDoc(doc(db,"courses",courseId,"rubrics",existing.id),data);
      else await addDoc(collection(db,"courses",courseId,"rubrics"),{...data,createdAt:serverTimestamp()});
      closeModal();toast("Rubric saved.");renderTool("rubrics");
    }catch(error){toast(error.message||"Unable to save rubric.");}
  };
}

function attendanceStatuses(){return ["Present","Absent","Tardy","Excused","Remote"];}

function renderAttendance(bundle,box){
  const today=new Date().toISOString().slice(0,10),map=new Map(bundle.attendance.map(x=>[x.date+"_"+x.studentId,x]));
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Attendance</div><p class="page-subtitle">Record daily attendance without mixing it into academic grades.</p></div><div class="field inline-date-field"><label>Date</label><input id="attendanceDate" type="date" value="'+today+'"></div></div><div id="attendanceRoster"></div>';
  const draw=date=>{
    $("#attendanceRoster").innerHTML=bundle.members.length?'<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>'+bundle.members.map(m=>{const row=map.get(date+"_"+m.id)||{};return '<tr><td><strong>'+esc(m.displayName||"Student")+'</strong></td><td><select class="attendance-status" data-student="'+m.id+'">'+attendanceStatuses().map(s=>'<option '+(s===(row.status||"Present")?'selected':'')+'>'+s+'</option>').join("")+'</select></td><td><input class="table-input attendance-note" data-student="'+m.id+'" value="'+esc(row.note||"")+'" placeholder="Optional note"></td><td><button class="text-btn" data-academic-action="save-attendance" data-student="'+m.id+'" data-date="'+date+'">Save</button></td></tr>';}).join("")+'</tbody></table></div>':'<div class="empty-mini">No students are enrolled.</div>';
  };
  draw(today);$("#attendanceDate").onchange=e=>draw(e.target.value);
}

async function saveAttendance(button){
  const section=pickSection(),studentId=button.dataset.student,date=button.dataset.date,row=button.closest("tr");
  try{
    await setDoc(doc(db,"sections",section.id,"attendance",date+"_"+studentId),{
      studentId,date,status:row.querySelector(".attendance-status").value,note:row.querySelector(".attendance-note").value.trim(),
      recordedBy:state().user.uid,updatedAt:serverTimestamp()
    },{merge:true});
    toast("Attendance saved.");
  }catch(error){toast(error.message||"Unable to save attendance.");}
}

function renderGroups(bundle,box){
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Student Groups</div><p class="page-subtitle">Seminar, project, discussion, or randomly generated student groups.</p></div><button class="primary-btn small-btn" data-academic-action="new-group">Create Group</button></div>'+
    (bundle.groups.length?'<div class="group-grid">'+bundle.groups.map(g=>'<article class="academic-card"><div class="card-kicker">'+esc(g.type||"Group")+'</div><h3>'+esc(g.name||"Group")+'</h3><p>'+esc((g.memberNames||[]).join(", ")||"No members")+'</p><div class="card-actions"><button class="text-btn danger-text" data-academic-action="delete-group" data-id="'+g.id+'">Delete</button></div></article>').join("")+'</div>':'<div class="empty-mini">No student groups created.</div>');
}

async function groupModal(){
  const bundle=await loadSectionBundle(pickSection());if(!bundle)return;
  const m=modal({
    eyebrow:"Student Groups",
    title:"Create Group",
    body:'<form id="groupForm"><div class="field"><label>Group Name</label><input name="name" required></div><div class="field"><label>Type</label><select name="type"><option>Seminar Group</option><option>Project Team</option><option>Discussion Group</option><option>Study Group</option></select></div><div class="field"><label>Members</label><div class="checklist">'+bundle.members.map(x=>'<label><input type="checkbox" name="member" value="'+x.id+'"> '+esc(x.displayName||"Student")+'</label>').join("")+'</div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Create Group</button></div></form>'
  });
  m.querySelector("#groupForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),ids=fd.getAll("member"),members=bundle.members.filter(x=>ids.includes(x.id));
    try{
      await addDoc(collection(db,"sections",bundle.section.id,"groups"),{name:String(fd.get("name")).trim(),type:String(fd.get("type")),memberIds:ids,memberNames:members.map(x=>x.displayName||"Student"),createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      closeModal();renderTool("groups");toast("Student group created.");
    }catch(error){toast(error.message||"Unable to create group.");}
  };
}

function renderExtensions(bundle,box){
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Individual Extensions</div><p class="page-subtitle">Adjust a deadline for one student without changing the assignment for everyone.</p></div><button class="primary-btn small-btn" data-academic-action="new-extension">Grant Extension</button></div>'+
    (bundle.extensions.length?'<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Assignment</th><th>Extended Due Date</th><th>Reason</th></tr></thead><tbody>'+bundle.extensions.map(x=>'<tr><td>'+esc(x.studentName||x.studentId)+'</td><td>'+esc(x.assignmentTitle||x.assignmentId)+'</td><td>'+esc(x.dueDate||"—")+'</td><td>'+esc(x.reason||"")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty-mini">No individual extensions.</div>');
}

async function extensionModal(){
  const b=await loadSectionBundle(pickSection());if(!b)return;
  const m=modal({eyebrow:"Deadline Exception",title:"Grant Individual Extension",body:'<form id="extensionForm"><div class="field"><label>Student</label><select name="studentId">'+b.members.map(x=>'<option value="'+x.id+'">'+esc(x.displayName||"Student")+'</option>').join("")+'</select></div><div class="field"><label>Assignment</label><select name="assignmentId">'+b.assignments.filter(x=>x.status!=="Draft").map(x=>'<option value="'+x.id+'">'+esc(x.title||"Assignment")+'</option>').join("")+'</select></div><div class="field"><label>Extended Due Date</label><input name="dueDate" type="date" required></div><div class="field"><label>Reason</label><textarea name="reason"></textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Grant Extension</button></div></form>'});
  m.querySelector("#extensionForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sid=String(fd.get("studentId")),aid=String(fd.get("assignmentId")),student=b.members.find(x=>x.id===sid),assignment=b.assignments.find(x=>x.id===aid);
    try{
      await setDoc(doc(db,"sections",b.section.id,"extensions",aid+"_"+sid),{studentId:sid,studentName:student?.displayName||"Student",assignmentId:aid,assignmentTitle:assignment?.title||"Assignment",dueDate:String(fd.get("dueDate")),reason:String(fd.get("reason")||"").trim(),grantedBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});
      closeModal();renderTool("extensions");toast("Extension granted.");
    }catch(error){toast(error.message||"Unable to grant extension.");}
  };
}

function renderFlags(bundle,box){
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Academic Flags</div><p class="page-subtitle">Advising and academic-attention markers with resolution history.</p></div><button class="primary-btn small-btn" data-academic-action="new-flag">Add Flag</button></div>'+
    (bundle.flags.length?'<div class="flag-list">'+bundle.flags.map(f=>'<article class="flag-row '+(f.resolved?'resolved':'')+'"><div><span>'+esc(f.type||"Academic Flag")+'</span><strong>'+esc(f.studentName||"Student")+'</strong><p>'+esc(f.note||"")+'</p></div><span class="badge '+(f.resolved?'':'gold')+'">'+(f.resolved?'Resolved':'Active')+'</span>'+(f.resolved?'':'<button class="text-btn" data-academic-action="resolve-flag" data-id="'+f.id+'">Resolve</button>')+'</article>').join("")+'</div>':'<div class="empty-mini">No academic flags.</div>');
}

async function flagModal(){
  const b=await loadSectionBundle(pickSection());if(!b)return;
  const m=modal({eyebrow:"Academic Advising",title:"Add Academic Flag",body:'<form id="flagForm"><div class="field"><label>Student</label><select name="studentId">'+b.members.map(x=>'<option value="'+x.id+'">'+esc(x.displayName||"Student")+'</option>').join("")+'</select></div><div class="field"><label>Flag</label><select name="type"><option>Needs Advising</option><option>Missing Major Assessment</option><option>Prerequisite Concern</option><option>Academic Improvement</option><option>Outstanding Performance</option><option>Instructor Follow-Up</option></select></div><div class="field"><label>Note</label><textarea name="note" required></textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Add Flag</button></div></form>'});
  m.querySelector("#flagForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sid=String(fd.get("studentId")),student=b.members.find(x=>x.id===sid);
    try{await addDoc(collection(db,"sections",b.section.id,"flags"),{studentId:sid,studentName:student?.displayName||"Student",type:String(fd.get("type")),note:String(fd.get("note")).trim(),resolved:false,createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});closeModal();renderTool("flags");toast("Academic flag added.");}catch(error){toast(error.message||"Unable to add flag.");}
  };
}

function renderNarratives(bundle,box){
  box.innerHTML='<div class="page-head compact-head"><div><div class="panel-title">Narrative Evaluations</div><p class="page-subtitle">Term and final instructor commentary that can accompany academic records.</p></div></div><div class="narrative-list">'+bundle.members.map(m=>{const n=bundle.narratives.find(x=>x.id===m.id);return '<article class="academic-card"><div class="card-kicker">'+esc(m.displayName||"Student")+'</div><h3>'+esc(n?.title||"No narrative yet")+'</h3><p>'+esc(n?.body||"Add strengths, growth, recommendations, or final commentary.")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-academic-action="edit-narrative" data-student="'+m.id+'">Edit Narrative</button></div></article>';}).join("")+'</div>';
}

async function narrativeModal(studentId){
  const b=await loadSectionBundle(pickSection()),student=b.members.find(x=>x.id===studentId),existing=b.narratives.find(x=>x.id===studentId);if(!student)return;
  const m=modal({eyebrow:"Narrative Evaluation",title:student.displayName||"Student",body:'<form id="narrativeForm"><div class="field"><label>Evaluation Title</label><input name="title" value="'+esc(existing?.title||"Instructor Narrative Evaluation")+'"></div><div class="field"><label>Narrative</label><textarea name="body" rows="8" required>'+esc(existing?.body||"")+'</textarea></div><label class="policy-card"><input type="checkbox" name="includeOnRecord" '+(existing?.includeOnRecord?'checked':'')+'><div><strong>Include with final academic record</strong><span>Make this narrative visible in the student record view.</span></div></label><div class="modal-foot" style="margin:24px -24px -24px"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Narrative</button></div></form>'});
  m.querySelector("#narrativeForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);try{await setDoc(doc(db,"sections",b.section.id,"narratives",studentId),{studentId,studentName:student.displayName||"Student",title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),includeOnRecord:e.currentTarget.elements.includeOnRecord.checked,updatedBy:state().user.uid,updatedAt:serverTimestamp()},{merge:true});closeModal();renderTool("narratives");toast("Narrative saved.");}catch(error){toast(error.message||"Unable to save narrative.");}};
}

function renderBulk(bundle,box){
  box.innerHTML='<div class="academic-banner"><div class="kicker">Bulk Academic Operations</div><h3>Make repetitive section changes safely.</h3><p>Bulk grade-status changes, extensions, publishing, and student operations are scoped to this teaching section.</p></div><div class="operations-grid">'+
    '<button class="operation-card" data-academic-action="bulk-grade-status"><span>01</span><strong>Bulk Grade Status</strong><small>Mark an assignment Missing or Excused for multiple students.</small></button>'+
    '<button class="operation-card" data-academic-action="bulk-extension"><span>02</span><strong>Bulk Extension</strong><small>Give multiple students the same assignment extension.</small></button>'+
    '<button class="operation-card" data-academic-action="bulk-publish"><span>03</span><strong>Bulk Publish Coursework</strong><small>Publish selected draft assignments.</small></button>'+
    '<button class="operation-card" data-academic-action="bulk-complete"><span>04</span><strong>Bulk Completion Status</strong><small>Mark selected students completed in the enrollment lifecycle.</small></button>'+
  '</div>';
}

async function bulkModal(kind){
  const b=await loadSectionBundle(pickSection());if(!b)return;
  if(kind==="bulk-grade-status"){
    const m=modal({eyebrow:"Bulk Operation",title:"Bulk Grade Status",wide:true,body:'<form id="bulkGradeStatus"><div class="field"><label>Assignment</label><select name="assignmentId">'+b.assignments.map(a=>'<option value="'+a.id+'">'+esc(a.title)+'</option>').join("")+'</select></div><div class="field"><label>Status</label><select name="status"><option>Missing</option><option>Excused</option></select></div><div class="field"><label>Students</label><div class="checklist">'+b.members.map(s=>'<label><input type="checkbox" name="student" value="'+s.id+'"> '+esc(s.displayName||"Student")+'</label>').join("")+'</div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn">Apply</button></div></form>'});
    m.querySelector("#bulkGradeStatus").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),aid=String(fd.get("assignmentId")),status=String(fd.get("status")),assignment=b.assignments.find(a=>a.id===aid),ids=fd.getAll("student");try{const batch=writeBatch(db);ids.forEach(sid=>batch.set(doc(db,"sections",b.section.id,"grades",aid+"_"+sid),{assignmentId:aid,assignmentTitle:assignment?.title||"Assignment",studentId:sid,studentName:b.members.find(x=>x.id===sid)?.displayName||"Student",score:status==="Missing"?0:null,maxPoints:Number(assignment?.points||0),gradeStatus:status,updatedAt:serverTimestamp()},{merge:true}));await batch.commit();closeModal();toast("Bulk grade status applied.");}catch(error){toast(error.message||"Bulk update failed.");}};
  }
  if(kind==="bulk-extension"){
    const m=modal({eyebrow:"Bulk Operation",title:"Bulk Extension",body:'<form id="bulkExtension"><div class="field"><label>Assignment</label><select name="assignmentId">'+b.assignments.map(a=>'<option value="'+a.id+'">'+esc(a.title)+'</option>').join("")+'</select></div><div class="field"><label>Extended Due Date</label><input type="date" name="dueDate" required></div><div class="field"><label>Students</label><div class="checklist">'+b.members.map(s=>'<label><input type="checkbox" name="student" value="'+s.id+'"> '+esc(s.displayName||"Student")+'</label>').join("")+'</div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn">Apply</button></div></form>'});m.querySelector("#bulkExtension").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget),aid=String(fd.get("assignmentId")),assignment=b.assignments.find(a=>a.id===aid),ids=fd.getAll("student");try{const batch=writeBatch(db);ids.forEach(sid=>batch.set(doc(db,"sections",b.section.id,"extensions",aid+"_"+sid),{assignmentId:aid,assignmentTitle:assignment?.title||"Assignment",studentId:sid,studentName:b.members.find(x=>x.id===sid)?.displayName||"Student",dueDate:String(fd.get("dueDate")),reason:"Bulk instructor extension",updatedAt:serverTimestamp()},{merge:true}));await batch.commit();closeModal();toast("Bulk extension applied.");}catch(error){toast(error.message||"Bulk extension failed.");}};
  }
  if(kind==="bulk-publish"){
    const drafts=b.assignments.filter(a=>a.status==="Draft");if(!drafts.length)return toast("There are no draft assignments.");
    const m=modal({eyebrow:"Bulk Operation",title:"Publish Coursework",body:'<form id="bulkPublish"><div class="checklist">'+drafts.map(a=>'<label><input type="checkbox" name="assignment" value="'+a.id+'"> '+esc(a.title||"Assignment")+'</label>').join("")+'</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn">Publish Selected</button></div></form>'});m.querySelector("#bulkPublish").onsubmit=async e=>{e.preventDefault();const ids=new FormData(e.currentTarget).getAll("assignment");try{for(const id of ids)await updateDoc(doc(db,"sections",b.section.id,"assignments",id),{status:"Published",updatedAt:serverTimestamp()});closeModal();renderTool("bulk");toast("Assignments published.");}catch(error){toast(error.message||"Bulk publish failed.");}};
  }
}

async function renderInsights(){
  const el=$("#insightsContent"),s=state();if(!el||!s?.user)return;
  if(s.role==="student")return renderStudentStudyPlan(el);
  const sections=ownedSections();if(!sections.length){el.innerHTML='<div class="empty-mini">No teaching sections available.</div>';return;}
  const section=currentSection()||sections[0],bundle=await loadSectionBundle(section);
  const competencyCodes=new Set();bundle.mastery.forEach(m=>(m.competencies||[]).forEach(c=>competencyCodes.add(c.code)));
  const codes=[...competencyCodes];
  const rows=bundle.members.map(member=>{
    const m=bundle.mastery.find(x=>x.id===member.id),map=new Map((m?.competencies||[]).map(c=>[c.code,c.percent]));
    return {member,map,overall:m?.overallPercent};
  });
  const flags=bundle.flags.filter(x=>!x.resolved).length;
  const avg=rows.filter(r=>r.overall!==null&&r.overall!==undefined).length?Math.round(rows.filter(r=>r.overall!==null&&r.overall!==undefined).reduce((n,r)=>n+Number(r.overall),0)/rows.filter(r=>r.overall!==null&&r.overall!==undefined).length*10)/10:null;
  el.innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Students</div><div class="summary-value">'+bundle.members.length+'</div></div><div class="summary-block"><div class="summary-label">Avg Mastery</div><div class="summary-value">'+(avg===null?"—":avg+"%")+'</div></div><div class="summary-block"><div class="summary-label">Competencies</div><div class="summary-value">'+codes.length+'</div></div><div class="summary-block"><div class="summary-label">Active Flags</div><div class="summary-value">'+flags+'</div></div></div>'+
    '<div class="panel"><div class="panel-head"><div><div class="panel-title">Competency Heatmap</div><div class="panel-subtitle">'+esc(section.courseCode||"Course")+' • students × competency evidence</div></div></div><div class="panel-body heatmap-wrap">'+(codes.length?'<table class="heatmap-table"><thead><tr><th>Student</th>'+codes.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'+rows.map(r=>'<tr><td><button class="text-btn" data-academic-action="student-profile" data-student="'+r.member.id+'">'+esc(r.member.displayName||"Student")+'</button></td>'+codes.map(c=>{const v=r.map.get(c);return '<td><span class="heatmap-cell '+(v===undefined?'none':v>=85?'strong':v>=70?'developing':'weak')+'">'+(v===undefined?"—":esc(v)+"%")+'</span></td>';}).join("")+'</tr>').join("")+'</tbody></table>':'<div class="empty-mini">Recalculate Mastery to populate the competency heatmap.</div>')+'</div></div>';
}

async function renderStudentStudyPlan(el){
  const s=state(),recommendations=[];
  for(const section of activeSections()){
    try{
      const [assignments,grades,mastery]=await Promise.all([
        getDocs(collection(db,"sections",section.id,"assignments")),
        getDocs(collection(db,"sections",section.id,"grades")),
        getDoc(doc(db,"sections",section.id,"mastery",s.user.uid))
      ]);
      const gradeMap=new Map(grades.docs.filter(d=>d.data().studentId===s.user.uid).map(d=>[d.data().assignmentId,d.data()]));
      assignments.docs.map(d=>({id:d.id,...d.data()})).filter(a=>a.status!=="Draft").forEach(a=>{
        const g=gradeMap.get(a.id);if(!g)recommendations.push({priority:2,title:"Complete "+a.title,detail:(section.courseCode||"Course")+" • ungraded coursework",type:"Coursework"});
        else if(a.points&&Number(g.score||0)/Number(a.points)<.7)recommendations.push({priority:1,title:"Review "+a.title,detail:(section.courseCode||"Course")+" • "+pct(g.score,a.points)+"%",type:"Performance"});
      });
      if(mastery.exists())(mastery.data().competencies||[]).filter(c=>Number(c.percent||0)<70).forEach(c=>recommendations.push({priority:0,title:"Strengthen "+(c.code||"competency"),detail:(section.courseCode||"Course")+" • "+(c.name||"")+" • "+c.percent+"% mastery",type:"Competency"}));
    }catch(_){}
  }
  recommendations.sort((a,b)=>a.priority-b.priority);
  el.innerHTML='<div class="academic-banner"><div class="kicker">What Should I Work On?</div><h3>Academic study plan</h3><p>Theoria uses your existing coursework and mastery evidence to surface priorities. These are study suggestions, not changes to your grade or academic standing.</p></div>'+
    (recommendations.length?'<div class="study-plan-list">'+recommendations.slice(0,20).map((r,i)=>'<article class="study-plan-row"><div class="study-rank">'+String(i+1).padStart(2,"0")+'</div><div><span>'+esc(r.type)+'</span><strong>'+esc(r.title)+'</strong><p>'+esc(r.detail)+'</p></div></article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">✓</div><h3>No urgent study priorities detected.</h3><p>Keep up with upcoming work and continue building competency evidence.</p></div>');
}

async function studentProfileModal(studentId){
  const section=currentSection()||pickSection(),bundle=await loadSectionBundle(section),student=bundle?.members.find(x=>x.id===studentId);if(!student)return toast("Student not found.");
  const grades=bundle.grades.filter(x=>x.studentId===studentId),mastery=bundle.mastery.find(x=>x.id===studentId),flags=bundle.flags.filter(x=>x.studentId===studentId&&!x.resolved),narrative=bundle.narratives.find(x=>x.id===studentId);
  modal({eyebrow:"Student Academic Profile",title:student.displayName||"Student",wide:true,body:'<div class="student-profile-summary"><div><span>Coursework Grades</span><strong>'+grades.length+'</strong></div><div><span>Overall Mastery</span><strong>'+(mastery?.overallPercent??"—")+(mastery?.overallPercent!==undefined?"%":"")+'</strong></div><div><span>Active Flags</span><strong>'+flags.length+'</strong></div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Competencies</div></div><div class="panel-body">'+((mastery?.competencies||[]).length?(mastery.competencies||[]).map(c=>'<div class="profile-record-row"><div><strong>'+esc(c.code||"Competency")+'</strong><span>'+esc(c.name||"")+'</span></div><b>'+esc(c.percent??"—")+'%</b></div>').join(""):'<div class="empty-mini">No mastery evidence yet.</div>')+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Academic Flags</div></div><div class="panel-body">'+(flags.length?flags.map(f=>'<div class="profile-record-row"><div><strong>'+esc(f.type)+'</strong><span>'+esc(f.note||"")+'</span></div></div>').join(""):'<div class="empty-mini">No active flags.</div>')+'</div></div></div>'+(narrative?'<div class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">'+esc(narrative.title||"Narrative Evaluation")+'</div></div><div class="panel-body"><p>'+esc(narrative.body||"")+'</p></div></div>':'')});
}

async function transcriptModal(){
  const s=state(),records=[];
  try{
    const enroll=await getDocs(collection(db,"users",s.user.uid,"enrollments"));
    for(const e of enroll.docs){
      try{const r=await getDoc(doc(db,"sections",e.id,"academicRecords",s.user.uid));if(r.exists()&&r.data().status==="Certified")records.push(r.data());}catch(_){}
    }
  }catch(_){}
  modal({eyebrow:"Theoria Transcript",title:s.profile?.displayName||s.user.displayName||"Student",wide:true,body:'<article class="formal-record transcript-record"><div class="record-seal">Θ</div><div class="record-heading"><div class="eyebrow">Theoria Multi-Course Academic Record</div><h2>'+esc(s.profile?.displayName||s.user.displayName||"Student")+'</h2><p>'+esc(s.user.email||"")+'</p></div>'+(records.length?'<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Course</th><th>Term</th><th>Grade</th><th>Final</th><th>Mastery</th></tr></thead><tbody>'+records.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""))).map(r=>'<tr><td><strong>'+esc(r.courseCode||"")+'</strong><span class="grade-sub">'+esc(r.courseTitle||"")+'</span></td><td>'+esc(r.term||"")+'</td><td>'+esc(r.letterGrade||"—")+'</td><td>'+esc(r.finalPercent??"—")+'%</td><td>'+(r.masteryPercent===null||r.masteryPercent===undefined?"—":esc(r.masteryPercent)+"%")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty-mini">No certified courses are available yet.</div>')+'<div class="record-footer"><p>This Theoria transcript reflects certified records created inside the platform and does not independently establish external accreditation.</p><button class="secondary-btn" onclick="window.print()">Print Transcript</button></div></article>'});
}

function enhanceSection(section,tab){
  if(state()?.role!=="instructor")return;
  if(tab==="students"){
    document.querySelectorAll("#sectionTabBody table tbody tr").forEach((tr,index)=>{
      const student=state().sectionData?.members?.[index],cell=tr.lastElementChild;if(!student||!cell||cell.querySelector('[data-academic-action="student-profile"]'))return;
      cell.insertAdjacentHTML("beforeend",' <button class="text-btn" data-academic-action="student-profile" data-student="'+student.id+'">Profile</button>');
    });
  }
}

window.addEventListener("theoria:page",e=>{
  if(e.detail.page==="teaching-tools")renderTeachingTools();
  if(e.detail.page==="insights")renderInsights();
});
window.addEventListener("theoria:ready",()=>{
  const profile=$("#academicProfileContent");if(profile&&!$("#transcriptQuickBtn")&&state()?.role==="student"){
    document.querySelector("#page-academic-profile .page-head")?.insertAdjacentHTML("beforeend",'<button id="transcriptQuickBtn" class="secondary-btn" data-academic-action="transcript">Transcript</button>');
  }
});

document.addEventListener("click",async e=>{
  const tab=e.target.closest("[data-academic-tool]");if(tab)return renderTool(tab.dataset.academicTool);
  const b=e.target.closest("[data-academic-action]");if(!b)return;
  const a=b.dataset.academicAction;
  if(a==="new-rubric")return rubricModal(b.dataset.course);
  if(a==="edit-rubric")return rubricModal(b.dataset.course,b.dataset.id);
  if(a==="save-attendance")return saveAttendance(b);
  if(a==="new-group")return groupModal();
  if(a==="delete-group"){if(confirm("Delete this group?")){await deleteDoc(doc(db,"sections",pickSection().id,"groups",b.dataset.id));renderTool("groups");}return;}
  if(a==="new-extension")return extensionModal();
  if(a==="new-flag")return flagModal();
  if(a==="resolve-flag"){await updateDoc(doc(db,"sections",pickSection().id,"flags",b.dataset.id),{resolved:true,resolvedAt:serverTimestamp(),resolvedBy:state().user.uid});renderTool("flags");return;}
  if(a==="edit-narrative")return narrativeModal(b.dataset.student);
  if(a.startsWith("bulk-"))return bulkModal(a);
  if(a==="student-profile")return studentProfileModal(b.dataset.student);
  if(a==="transcript")return transcriptModal();
});

window.TheoriaAcademicTools={renderTeachingTools,renderInsights,enhanceSection,studentProfileModal,transcriptModal,loadRubrics};
