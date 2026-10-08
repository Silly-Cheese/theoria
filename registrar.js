import {db,auth,collection,doc,getDocs,getDoc,addDoc,setDoc,updateDoc,serverTimestamp,query,where} from "./firebase.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $=id=>document.getElementById(id);
let current=null,me=null,records=[],reqs=[],offerings=[],policies=[],attendance=[],guardianLinks=[];
const roleAdmin=()=>current && me && (current.ownerUid===me.uid||window.TheoriaSchoolAdmin?.canAdmin?.(current.id));
async function read(name){try{const s=await getDocs(collection(db,"institutions",current.id,name));return s.docs.map(d=>({id:d.id,...d.data()}));}catch(e){console.warn(name,e);return [];}}
async function refresh(){if(!current||!me)return;const id=current.id;const result=await Promise.all(["studentRecords","requests","offerings","graduationPolicies","attendance","guardianLinks"].map(read));if(id!==current?.id)return;[records,reqs,offerings,policies,attendance,guardianLinks]=result;draw();}
const stat=(value,label)=>'<div><strong>'+esc(value)+'</strong><span>'+esc(label)+'</span></div>';
function draw(){
 const root=$("schoolRegistrarExpansion");if(!root)return;
 if(!roleAdmin()){root.innerHTML="";return;}
 root.innerHTML='<section class="school-admin"><div class="eyebrow">Student Services</div><h2>Registrar & Student Records</h2><p class="school-subtle">Record verified enrollments, grade certifications, attendance and graduation requirements. Approval alone never creates a section membership.</p><div class="school-metrics">'+stat(records.length,"Student records")+stat(reqs.filter(x=>x.status==="approved").length,"Approved requests")+stat(policies.length,"Graduation requirements")+stat(attendance.length,"Attendance entries")+'</div><div class="school-admin-tabs">'+["Enrollment","Records","Attendance","Graduation","Guardians"].map((x,i)=>'<button data-reg-tab="'+i+'" class="'+(tab===i?"selected":"")+'">'+x+'</button>').join("")+'</div><div id="schoolRegistrarBody">'+body()+'</div></section>';
}
let tab=0;
const action=(name,id)=>'<button class="secondary-btn small-btn" data-reg-action="'+id+'">'+name+'</button>';
const list=(arr,fn)=>arr.length?'<div class="school-list">'+arr.map(v=>'<div class="school-entry">'+fn(v)+'</div>').join("")+'</div>':'<p class="school-empty">No records in this category yet.</p>';
function body(){
 if(tab===0)return '<div class="school-section-head"><h3>Approved registration requests</h3>'+action("Refresh","refresh")+'</div>'+list(reqs.filter(r=>r.status==="approved"),r=>'<strong>'+esc(r.studentName||r.studentUid)+'</strong><span>'+esc(offerings.find(o=>o.id===r.offeringId)?.title||r.offeringId)+'</span>'+action("Finalize enrollment","finalize:"+r.id))+'<p class="school-subtle">The registrar confirms placement here; creating actual Theoria section membership requires the established classroom enrollment workflow.</p>';
 if(tab===1)return '<div class="school-section-head"><h3>Institutional academic records</h3>'+action("New record","record")+'</div>'+list(records,r=>'<strong>'+esc(r.studentName||r.studentUid)+'</strong><span>'+esc(r.courseTitle||"Course")+' · '+esc(r.finalGrade||"Pending")+' · '+esc(r.status)+'</span>')+'<p class="school-subtle">Records are separate from existing Theoria instructor-certified transcripts and do not overwrite them.</p>';
 if(tab===2)return '<div class="school-section-head"><h3>Class attendance</h3>'+action("Record attendance","attendance")+'</div>'+list(attendance,a=>'<strong>'+esc(a.studentName||a.studentUid)+'</strong><span>'+esc(a.day)+' · '+esc(a.status)+' · '+esc(a.offeringTitle)+'</span>');
 if(tab===3)return '<div class="school-section-head"><h3>Graduation requirements</h3>'+action("Add requirement","policy")+'</div>'+list(policies,p=>'<strong>'+esc(p.name)+'</strong><span>'+esc(p.requiredCredits)+' required credits · '+esc(p.description)+'</span>')+'<p class="school-subtle">Requirements are defined here; automatic graduation certification requires verified course-credit equivalency.</p>';
 return '<div class="school-section-head"><h3>Guardian access requests</h3>'+action("Record guardian link","guardian")+'</div>'+list(guardianLinks,g=>'<strong>'+esc(g.studentName||g.studentUid)+'</strong><span>'+esc(g.guardianEmail)+' · '+esc(g.status)+'</span>')+'<p class="school-subtle">Guardian requests are recorded for verification only. No student data is exposed to guardians by this workflow.</p>';
}
function modal(title,fields,save){
 const host=$("modalRoot");host.innerHTML='<div class="modal-backdrop institution-modal-backdrop"><div class="modal institution-dialog"><div class="modal-header"><h2>'+esc(title)+'</h2><button type="button" class="secondary-btn" id="regClose">Close</button></div><form id="regForm" class="institution-form">'+fields+'<button class="primary-btn" type="submit">Save</button><div id="regError" role="alert"></div></form></div></div>';
 $("regClose").onclick=()=>host.innerHTML="";
 $("regForm").onsubmit=async ev=>{ev.preventDefault();const button=ev.currentTarget.querySelector("[type=submit]");button.disabled=true;try{await save(new FormData(ev.currentTarget));host.innerHTML="";await refresh();}catch(err){$("regError").textContent=err.message;button.disabled=false;}};
}
const input=(id,title,type="text")=>'<label>'+esc(title)+'<input name="'+id+'" type="'+type+'" required></label>';
const options=(key,label,values)=>'<label>'+label+'<select name="'+key+'">'+values.map(([k,v])=>'<option value="'+esc(k)+'">'+esc(v)+'</option>').join("")+'</select></label>';
function handle(action){
 if(!roleAdmin())return;
 if(action==="refresh"){refresh();return;}
 if(action.startsWith("finalize:")){
  const r=reqs.find(x=>x.id===action.slice(9));if(!r)return;
  modal("Finalize institutional placement",'<p class="school-subtle">This confirms institutional placement only, not access to the teaching section.</p>'+input("sectionReference","Section ID or code")+input("studentName","Student name"),async f=>{
   if(r.status!=="approved")throw Error("Request must be approved.");
   await setDoc(doc(db,"institutions",current.id,"placements",r.id),{studentUid:r.studentUid,offeringId:r.offeringId,sectionReference:f.get("sectionReference").trim(),studentName:f.get("studentName").trim(),status:"placed",approvedRequestId:r.id,placedBy:me.uid,placedAt:serverTimestamp()});
  });return;
 }
 if(action==="record")modal("Create academic record",input("studentUid","Student's Theoria account UID")+input("studentName","Student name")+input("courseTitle","Course title")+input("credits","Credits","number")+input("finalGrade","Certified grade")+options("status","Record state",[["pending","Pending verification"],["certified","Certified by registrar"],["withdrawn","Withdrawn"]]),async f=>{
  if(!confirm("Are you authorized to enter or certify this academic result?"))throw Error("Authorization required.");
  await addDoc(collection(db,"institutions",current.id,"studentRecords"),{studentUid:f.get("studentUid").trim(),studentName:f.get("studentName").trim(),courseTitle:f.get("courseTitle").trim(),credits:Number(f.get("credits")),finalGrade:f.get("finalGrade").trim(),status:f.get("status"),recordedBy:me.uid,recordedAt:serverTimestamp()});
 });
 if(action==="attendance")modal("Record student attendance",input("studentUid","Student UID")+input("studentName","Student name")+input("offeringTitle","Course / section")+input("day","Class date","date")+options("status","Attendance status",[["present","Present"],["absent","Absent"],["late","Late"],["excused","Excused"]]),async f=>addDoc(collection(db,"institutions",current.id,"attendance"),{studentUid:f.get("studentUid").trim(),studentName:f.get("studentName").trim(),offeringTitle:f.get("offeringTitle").trim(),day:f.get("day"),status:f.get("status"),recordedBy:me.uid,recordedAt:serverTimestamp()}));
 if(action==="policy")modal("Add graduation requirement",input("name","Subject / requirement")+input("requiredCredits","Credits required","number")+input("description","Requirement notes"),async f=>addDoc(collection(db,"institutions",current.id,"graduationPolicies"),{name:f.get("name").trim(),requiredCredits:Number(f.get("requiredCredits")),description:f.get("description").trim(),createdBy:me.uid,createdAt:serverTimestamp()}));
 if(action==="guardian")modal("Record guardian verification request",input("studentUid","Student UID")+input("studentName","Student name")+input("guardianEmail","Guardian email","email"),async f=>addDoc(collection(db,"institutions",current.id,"guardianLinks"),{studentUid:f.get("studentUid").trim(),studentName:f.get("studentName").trim(),guardianEmail:f.get("guardianEmail").trim().toLowerCase(),status:"pending_verification",createdBy:me.uid,createdAt:serverTimestamp()}));
}
document.addEventListener("click",event=>{
 const t=event.target.closest("[data-reg-tab]");if(t){tab=Number(t.dataset.regTab);draw();return;}
 const a=event.target.closest("[data-reg-action]");if(a)handle(a.dataset.regAction);
});
window.TheoriaRegistrar={mount(institution,currentUser){current=institution;me=currentUser;tab=0;refresh().catch(console.error);}};
