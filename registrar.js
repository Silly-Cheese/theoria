import {db,auth,collection,doc,getDocs,getDoc,addDoc,setDoc,updateDoc,serverTimestamp,query,where} from "./firebase.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $=id=>document.getElementById(id);
let current=null,me=null,records=[],reqs=[],offerings=[],policies=[],attendance=[],guardianLinks=[],members=[],studentLabels=new Map(),readFailures=[];
const roleAdmin=()=>current && me && (current.ownerUid===me.uid||window.TheoriaSchoolAdmin?.canAdmin?.(current.id));
async function read(name){try{const s=await getDocs(collection(db,"institutions",current.id,name));return s.docs.map(d=>({id:d.id,...d.data()}));}catch(error){console.error("Institution "+current.id+" / "+name,error);readFailures.push({name,message:error.message||String(error)});return [];}}
async function refresh(){if(!current||!me)return;const id=current.id;readFailures=[];const result=await Promise.all(["studentRecords","requests","offerings","graduationPolicies","attendance","guardianLinks","members"].map(read));if(id!==current?.id)return;[records,reqs,offerings,policies,attendance,guardianLinks,members]=result;
 const ids=[...new Set([...members.map(x=>x.studentUid),...reqs.map(x=>x.studentUid),...records.map(x=>x.studentUid)].filter(Boolean))];
 studentLabels=new Map();await Promise.all(ids.map(async uid=>{try{const snap=await getDoc(doc(db,"directory",uid));if(snap.exists())studentLabels.set(uid,snap.data().displayName||snap.data().name||snap.data().email||uid);}catch(error){console.warn("Directory label unavailable",error);}}));draw();}
const studentName=uid=>studentLabels.get(uid)||members.find(m=>m.studentUid===uid)?.studentName||reqs.find(r=>r.studentUid===uid)?.studentName||uid;
const studentOptions=()=>[...new Set([...members.map(m=>m.studentUid),...reqs.map(r=>r.studentUid),...records.map(r=>r.studentUid)].filter(Boolean))].map(uid=>[uid,studentName(uid)]);
const stat=(value,label)=>'<div><strong>'+esc(value)+'</strong><span>'+esc(label)+'</span></div>';
function draw(){
 const root=$("schoolRegistrarExpansion");if(!root)return;
 if(!roleAdmin()){root.innerHTML="";return;}
 root.innerHTML='<section class="school-admin"><div class="eyebrow">Student Services</div><h2>Registrar & Student Records</h2><p class="school-subtle">Record verified enrollments, grade certifications, attendance and graduation requirements. Approval alone never creates a section membership.</p><div class="school-metrics">'+stat(records.length,"Student records")+stat(reqs.filter(x=>x.status==="pending").length+members.filter(x=>x.status==="pending").length,"Pending requests")+stat(policies.length,"Graduation requirements")+stat(attendance.length,"Attendance entries")+'</div>'+(readFailures.length?'<div class="institution-notice" role="alert"><strong>Some school records could not be loaded.</strong><p>'+readFailures.map(f=>esc(f.name)+': '+esc(f.message)).join('<br>')+'</p><p>Check deployed Firestore rules and your institution administrator role.</p></div>':'')+'<div class="school-admin-tabs">'+["Enrollment","Records","Attendance","Graduation","Guardians"].map((x,i)=>'<button data-reg-tab="'+i+'" class="'+(tab===i?"selected":"")+'">'+x+'</button>').join("")+'</div><div id="schoolRegistrarBody">'+body()+'</div></section>';
}
let tab=0;
const action=(name,id)=>'<button class="secondary-btn small-btn" data-reg-action="'+id+'">'+name+'</button>';
const list=(arr,fn)=>arr.length?'<div class="school-list">'+arr.map(v=>'<div class="school-entry">'+fn(v)+'</div>').join("")+'</div>':'<p class="school-empty">No records in this category yet.</p>';
function body(){
 if(tab===0)return '<div class="school-section-head"><h3>Pending school membership</h3>'+action("Refresh","refresh")+'</div>'+
 list(members.filter(m=>m.status==="pending"),m=>'<strong>'+esc(studentName(m.studentUid))+'</strong><span>Request to join '+esc(current.name||"this institution")+'</span>'+action("Approve student","member:active:"+m.id)+action("Decline","member:declined:"+m.id))+
 '<div class="school-section-head" style="margin-top:22px"><h3>Course registration requests</h3></div>'+
 list([...reqs].sort((a,b)=>({pending:0,approved:1,declined:2}[a.status]??3)-({pending:0,approved:1,declined:2}[b.status]??3)),r=>'<strong>'+esc(studentName(r.studentUid))+'</strong><span>'+esc(offerings.find(o=>o.id===r.offeringId)?.title||r.offeringId)+' · '+esc(r.status)+'</span>'+(r.status==="pending"?action("Approve","decision:approved:"+r.id)+action("Decline","decision:declined:"+r.id):r.status==="approved"?action("Finalize placement","finalize:"+r.id):''))+
 '<p class="school-subtle">First approve institution membership, then the student can request individual courses while registration is open. Approved course requests still require placement into an actual section.</p>';
 if(tab===1)return '<div class="school-section-head"><h3>Institutional academic records</h3>'+action("New record","record")+'</div>'+list(records,r=>'<strong>'+esc(r.studentName||r.studentUid)+'</strong><span>'+esc(r.courseTitle||"Course")+' · '+esc(r.finalGrade||"Pending")+' · '+esc(r.status)+'</span>')+'<p class="school-subtle">Records are separate from existing Theoria instructor-certified transcripts and do not overwrite them.</p>';
 if(tab===2)return '<div class="school-section-head"><h3>Class attendance</h3>'+action("Record attendance","attendance")+'</div>'+list(attendance,a=>'<strong>'+esc(a.studentName||a.studentUid)+'</strong><span>'+esc(a.day)+' · '+esc(a.status)+' · '+esc(a.offeringTitle)+'</span>');
 if(tab===3)return '<div class="school-section-head"><h3>Graduation requirements</h3>'+action("Add requirement","policy")+'</div>'+list(policies,p=>'<strong>'+esc(p.name)+'</strong><span>'+esc(p.requiredCredits)+' required credits · '+esc(p.description)+'</span>')+'<p class="school-subtle">Requirements are defined here; automatic graduation certification requires verified course-credit equivalency.</p>';
 return '<div class="school-section-head"><h3>Guardian access requests</h3>'+action("Record guardian link","guardian")+'</div>'+list(guardianLinks,g=>'<strong>'+esc(g.studentName||g.studentUid)+'</strong><span>'+esc(g.guardianEmail)+' · '+esc(g.status)+'</span>'+action('Copy setup link','copy-parent:'+g.id)+(g.status==='awaiting_school_approval'?action('Approve parent','approve-parent:'+g.id)+action('Decline','decline-parent:'+g.id):''))+'<p class="school-subtle">Guardian requests are recorded for verification only. No student data is exposed to guardians by this workflow.</p>';
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
 if(action.startsWith("approve-parent:")||action.startsWith("decline-parent:")){const approve=action.startsWith("approve-parent:"),id=action.slice(approve?15:15),link=guardianLinks.find(g=>g.id===id);if(!link||link.status!=="awaiting_school_approval")return;if(!confirm((approve?"Approve":"Decline")+" parent access for "+studentName(link.studentUid)+"?"))return;(async()=>{try{await updateDoc(doc(db,"institutions",current.id,"guardianLinks",id),{status:approve?"approved":"declined",reviewedBy:me.uid,reviewedAt:serverTimestamp()});if(approve){if(!link.guardianUid)throw Error("Parent has not claimed invitation.");await setDoc(doc(db,"institutions",current.id,"guardianAccess",link.guardianUid+"_"+link.studentUid),{guardianUid:link.guardianUid,studentUid:link.studentUid,studentName:link.studentName||"",inviteId:id,approvedBy:me.uid,approvedAt:serverTimestamp()});}await refresh();}catch(err){alert("Unable to finish guardian review: "+err.message);}})();return;}
 if(action.startsWith("copy-parent:")){const link=guardianLinks.find(g=>g.id===action.slice(12));if(!link)return;const url=new URL(location.href);url.search="";url.hash="";url.searchParams.set("parentInvite",current.id+"."+link.id);navigator.clipboard.writeText(url.toString()).then(()=>alert("Parent setup link copied. Send it only to the intended guardian.")).catch(()=>prompt("Copy parent setup link:",url.toString()));return;}
 if(action.startsWith("member:")){
  const parts=action.split(":"),status=parts[1],id=parts.slice(2).join(":");
  const membership=members.find(m=>m.id===id);
  if(!membership||membership.status!=="pending"||!["active","declined"].includes(status))return;
  if(!confirm((status==="active"?"Approve":"Decline")+" membership for "+studentName(membership.studentUid)+"?"))return;
  updateDoc(doc(db,"institutions",current.id,"members",id),{status,reviewedBy:me.uid,reviewedAt:serverTimestamp()}).then(refresh).catch(err=>alert("Unable to review school membership: "+err.message));
  return;
 }
 if(action.startsWith("decision:")){
  const parts=action.split(":"),status=parts[1],id=parts.slice(2).join(":");const r=reqs.find(x=>x.id===id);
  if(!r||r.status!=="pending"||!["approved","declined"].includes(status))return;
  if(!confirm((status==="approved"?"Approve":"Decline")+" "+studentName(r.studentUid)+"'s request?"))return;
  updateDoc(doc(db,"institutions",current.id,"requests",id),{status,reviewedBy:me.uid,reviewedAt:serverTimestamp()}).then(refresh).catch(err=>alert("Unable to review request: "+err.message));
  return;
 }
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
 if(action==="guardian"){
  const available=studentOptions();
  if(!available.length){alert("No students found in school membership or enrollment records. Students must request to join the institution first.");return;}
  modal("Invite parent or guardian",options("studentUid","Select student",available)+input("guardianEmail","Parent or guardian email","email"),async f=>{
    const uid=String(f.get("studentUid")||"");if(!available.some(([id])=>id===uid))throw Error("Choose a student from the list.");
    await addDoc(collection(db,"institutions",current.id,"guardianLinks"),{studentUid:uid,studentName:studentName(uid),guardianEmail:f.get("guardianEmail").trim().toLowerCase(),status:"pending_verification",createdBy:me.uid,createdAt:serverTimestamp()});
  });return;
 }
}
document.addEventListener("click",event=>{
 const t=event.target.closest("[data-reg-tab]");if(t){tab=Number(t.dataset.regTab);draw();return;}
 const a=event.target.closest("[data-reg-action]");if(a)handle(a.dataset.regAction);
});
window.TheoriaRegistrar={mount(institution,currentUser){current=institution;me=currentUser;tab=0;refresh().catch(console.error);}};
