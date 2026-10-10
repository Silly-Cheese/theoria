import {db,auth,collection,doc,getDocs,getDoc,query,where,addDoc,setDoc,updateDoc,serverTimestamp} from "./firebase.js";
const e=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const roles=["principal","assistant_principal","district_admin","registrar","counselor","department_head","instructor","staff"];
let memberAdmin=false;
const canWrite=(inst,me)=>inst.ownerUid===me?.uid||memberAdmin;
let inst=null,user=null,terms=[],offerings=[],staff=[],requests=[],departments=[],invitations=[],members=[],activeTab="overview";
const html=(s)=>document.getElementById(s);
async function readSub(name){try{const s=await getDocs(collection(db,"institutions",inst.id,name));return s.docs.map(d=>({id:d.id,...d.data()}));}catch(x){console.warn("School workspace:",name,x);return [];}}
async function load(){if(!inst||!user)return;const saved=inst.id;const [t,o,s,r,d,i,m]=await Promise.all(["terms","offerings","staff","requests","departments","invitations","members"].map(readSub));if(inst?.id!==saved)return;[terms,offerings,staff,requests,departments,invitations,members]=[t,o,s,r,d,i,m];paint();window.TheoriaRegistrar?.mount(inst,user);window.TheoriaInstitutionSuite?.mount(inst,user);window.TheoriaCampus?.mount(inst,user);}
const actionButton=(label,act)=>'<button type="button" class="secondary-btn small-btn" data-school-action="'+act+'">'+label+'</button>';
const tabs=[["overview","Overview"],["terms","Academic years"],["departments","Departments"],["faculty","Faculty & roles"],["schedule","Schedules"],["registrar","Registrar"],["membership","Student membership"]];
function paint(){
 const root=html("schoolManagementArea");if(!root)return;
 if(!html("campusOperations")){const campus=document.createElement("div");campus.id="campusOperations";root.insertAdjacentElement("afterend",campus);}
 if(!html("theoriaExpansion")){const suite=document.createElement("div");suite.id="theoriaExpansion";root.insertAdjacentElement("afterend",suite);}
 if(!html("schoolRegistrarExpansion")){const extra=document.createElement("div");extra.id="schoolRegistrarExpansion";root.insertAdjacentElement("afterend",extra);}
 if(!canWrite(inst,user)){root.innerHTML='<div class="school-subtle">Institutional administration is restricted to authorized staff.</div>';return;}
 root.innerHTML='<section class="school-admin"><div class="school-admin-title"><div><div class="eyebrow">Academic administration</div><h2>School management center</h2><p>Organize academic years, departments, staff, class schedules and enrollment records.</p></div></div><div class="school-admin-tabs">'+tabs.map(([id,label])=>'<button class="'+(id===activeTab?'selected':'')+'" data-school-tab="'+id+'">'+label+'</button>').join("")+'</div><div id="schoolAdminBody">'+body()+'</div></section>';
}
function body(){
 if(activeTab==="overview")return '<div class="school-metrics">'+[[terms.length,"Academic terms"],[departments.length,"Departments"],[staff.length,"Staff assignments"],[offerings.length,"Course offerings"],[requests.filter(r=>r.status==="pending").length,"Pending requests"]].map(([n,label])=>'<div><strong>'+n+'</strong><span>'+label+'</span></div>').join("")+'</div><p class="school-subtle">Use the tabs to manage each administrative area. Registration approvals remain accessible from each course offering.</p>';
 if(activeTab==="terms")return '<div class="school-section-head"><h3>Academic years & grading terms</h3>'+actionButton("Add term","term")+'</div>'+listing(terms,t=>'<strong>'+e(t.title)+'</strong><span>'+e(t.startDate)+' — '+e(t.endDate)+'</span><span>'+e(t.gradingScheme||"Standard grading")+'</span>');
 if(activeTab==="departments")return '<div class="school-section-head"><h3>Departments & curriculum</h3>'+actionButton("Create department","department")+'</div>'+listing(departments,d=>'<strong>'+e(d.name)+'</strong><span>'+e(d.description)+'</span>');
 if(activeTab==="faculty")return '<div class="school-section-head"><h3>Administrative and teaching staff</h3>'+actionButton("Assign staff","staff")+'</div>'+listing(staff,s=>'<strong>'+e(s.displayName||s.email)+'</strong><span>'+e(s.email)+' · '+e(s.role.replaceAll("_"," "))+'</span>')+'<h4>Pending invitations</h4>'+listing(invitations.filter(i=>i.status==="pending"),i=>'<strong>'+e(i.email)+'</strong><span>'+e(i.role.replaceAll("_"," "))+' · Pending acceptance</span>')+'<p class="school-subtle">Staff receive access only after signing in and accepting their invitation.</p>';
 if(activeTab==="schedule")return '<div class="school-section-head"><h3>Class schedule & course offerings</h3>'+actionButton("Schedule a course","schedule")+'</div>'+listing(offerings,o=>'<strong>'+e(o.code||"COURSE")+' — '+e(o.title)+'</strong><span>'+e(o.term)+' · '+e(o.period||"Period not set")+' · '+e(o.room||"Room TBD")+'</span><span>Seats: '+e(o.capacity||"Unlimited")+' · '+e(o.instructorName||"Unassigned")+'</span>')+'<p class="school-subtle">Scheduling entries describe offerings; actual enrollment remains a separate approval step.</p>';
 if(activeTab==="membership")return '<div class="school-section-head"><h3>Student school membership requests</h3>'+actionButton("Refresh","refresh")+'</div>'+listing(members,m=>'<strong>'+e(m.studentName||requests.find(r=>r.studentUid===m.studentUid)?.studentName||'Student name unavailable')+'</strong><span>'+e(m.status)+'</span>'+(m.status==="pending"?'<div class="institution-actions"><button class="secondary-btn small-btn" data-school-member="'+e(m.id)+'" data-school-decision="active">Approve</button> <button class="secondary-btn small-btn" data-school-member="'+e(m.id)+'" data-school-decision="declined">Decline</button></div>':''));
 if(activeTab==="registrar")return '<div class="school-section-head"><h3>Enrollment request register</h3>'+actionButton("Refresh","refresh")+'</div>'+listing(requests,r=>'<strong>'+e(r.studentName||members.find(m=>m.studentUid===r.studentUid)?.studentName||'Student name unavailable')+'</strong><span>Offering: '+e(offerings.find(o=>o.id===r.offeringId)?.title||r.offeringId)+' · '+e(r.status)+'</span>')+'<p class="school-subtle">Approved requests are not automatically registered into a live classroom section. The registrar must complete roster assignment.</p>';
 return "";
}
function listing(items,format){return items.length?'<div class="school-list">'+items.map(i=>'<div class="school-entry">'+format(i)+'</div>').join("")+'</div>':'<div class="school-empty">Nothing has been added yet.</div>';}
function modal(title,inner,onSubmit){
 const root=html("modalRoot");root.innerHTML='<div class="modal-backdrop institution-modal-backdrop"><div class="modal institution-dialog" role="dialog" aria-modal="true"><div class="modal-header"><h2>'+e(title)+'</h2><button type="button" class="secondary-btn" id="schoolClose">Close</button></div><form id="schoolAdminForm" class="institution-form">'+inner+'<button class="primary-btn" type="submit">Save changes</button><p id="schoolFormError" role="alert"></p></form></div></div>';
 html("schoolClose").onclick=()=>root.innerHTML="";
 html("schoolAdminForm").onsubmit=async evt=>{evt.preventDefault();const btn=evt.currentTarget.querySelector("[type=submit]");btn.disabled=true;try{await onSubmit(new FormData(evt.currentTarget));root.innerHTML="";await load();}catch(err){html("schoolFormError").textContent=err.message||"Unable to save.";btn.disabled=false;}};
}
const inp=(key,title,type="text",required=true)=>'<label>'+e(title)+'<input name="'+key+'" type="'+type+'" '+(required?"required":"")+' maxlength="120"></label>';
const sel=(key,label,items)=>'<label>'+e(label)+'<select name="'+key+'">'+items.map(([value,text])=>'<option value="'+e(value)+'">'+e(text)+'</option>').join("")+'</select></label>';
function begin(action){
 if(action==="refresh"){load();return;}
 if(action==="term")modal("Add academic term",inp("title","Term name")+inp("startDate","First day","date")+inp("endDate","Last day","date")+sel("gradingScheme","Grading policy",[["standard","Standard"],["semester","Semester"],["quarter","Quarter"]]),async f=>{
  if(f.get("endDate")<f.get("startDate"))throw Error("End date must follow start date.");
  await addDoc(collection(db,"institutions",inst.id,"terms"),{title:f.get("title").trim(),startDate:f.get("startDate"),endDate:f.get("endDate"),gradingScheme:f.get("gradingScheme"),createdBy:user.uid,createdAt:serverTimestamp()});
 }); 
 if(action==="department")modal("Create academic department",inp("name","Department name")+ '<label>Description<textarea name="description" maxlength="500"></textarea></label>',async f=>addDoc(collection(db,"institutions",inst.id,"departments"),{name:f.get("name").trim(),description:f.get("description").trim(),createdBy:user.uid,createdAt:serverTimestamp()}));
 if(action==="staff")modal("Invite school staff",inp("email","Staff email","email")+sel("role","Assigned role",roles.map(r=>[r,r.replaceAll("_"," ")])),async f=>{
  const email=String(f.get("email")).toLowerCase().trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error("Enter a valid email address.");
  await setDoc(doc(db,"institutions",inst.id,"invitations",email),{email,role:f.get("role"),status:"pending",invitedBy:user.uid,invitedAt:serverTimestamp()});
 });
 if(action==="schedule")modal("Schedule course offering",sel("offeringId","Published course",offerings.map(o=>[o.id,(o.code||"")+" "+o.title]))+inp("period","Class period (e.g. 2nd period)", "text",false)+inp("room","Room / location","text",false)+inp("capacity","Maximum seats","number",false)+sel("staffUid","Assigned instructor", [["","Unassigned"],...staff.filter(s=>["instructor","department_head","principal"].includes(s.role)).map(s=>[s.uid,s.displayName||s.email])]),async f=>{
  const id=f.get("offeringId");if(!offerings.some(o=>o.id===id))throw Error("Choose an existing offering.");
  const cap=Number(f.get("capacity")||0);if(!Number.isInteger(cap)||cap<0||cap>10000)throw Error("Enter a valid seat capacity.");
  const member=staff.find(s=>s.uid===f.get("staffUid"));
  const period=String(f.get("period")||"").trim(),room=String(f.get("room")||"").trim();
  const conflicts=offerings.filter(o=>o.id!==id&&o.term===offerings.find(x=>x.id===id)?.term&&period&&o.period===period&&(room&&o.room===room||member&&o.instructorUid===member.uid));
  if(conflicts.length)throw Error("Schedule conflict: another course uses the same room or instructor during this period.");
  await updateDoc(doc(db,"institutions",inst.id,"offerings",id),{period:String(f.get("period")||"").slice(0,80),room:String(f.get("room")||"").slice(0,100),capacity:cap,instructorUid:member?.uid||"",instructorName:member?.displayName||"",scheduledBy:user.uid,scheduledAt:serverTimestamp()});
 });
}
document.addEventListener("click",async evt=>{
 const member=evt.target.closest("[data-school-member]");
 if(member){if(!canWrite(inst,user))return;try{
 await updateDoc(doc(db,"institutions",inst.id,"members",member.dataset.schoolMember),{status:member.dataset.schoolDecision,reviewedBy:user.uid,reviewedAt:serverTimestamp()});await load();
 }catch(error){window.TheoriaDialog.alert("Unable to review membership: "+error.message);}return;}
 const tab=evt.target.closest("[data-school-tab]");if(tab){activeTab=tab.dataset.schoolTab;paint();return;}
 const act=evt.target.closest("[data-school-action]");if(act)begin(act.dataset.schoolAction);
});
async function showInvitation(){
 const email=String(auth.currentUser?.email||"").trim().toLowerCase();
 if(!email||!inst)return;
 const ref=doc(db,"institutions",inst.id,"invitations",email);
 try{
  const snap=await getDoc(ref);
  if(!snap.exists()||snap.data().status!=="pending")return;
  const invitation=snap.data();
  const target=html("schoolManagementArea");
  if(!target)return;
  const bar=document.createElement("div");bar.className="institution-notice";
  bar.innerHTML='<strong>School staff invitation</strong><p>You have been invited to '+e(inst.name)+' as '+e(invitation.role.replaceAll("_"," "))+'.</p><button class="primary-btn small-btn">Accept staff role</button>';
  bar.querySelector("button").onclick=async()=>{try{
   await setDoc(doc(db,"institutions",inst.id,"staff",auth.currentUser.uid),{uid:auth.currentUser.uid,email,displayName:auth.currentUser.displayName||email,role:invitation.role,assignedBy:invitation.invitedBy,assignedAt:serverTimestamp()});
   await updateDoc(ref,{status:"accepted",acceptedBy:auth.currentUser.uid,acceptedAt:serverTimestamp()});
   bar.remove();window.TheoriaDialog.alert("Staff role accepted. Your institution administrator can now confirm access.");await load();
  }catch(error){window.TheoriaDialog.alert("Unable to accept invitation: "+error.message);}};
  target.prepend(bar);
 }catch(error){console.warn("Invitation check failed",error);}
}
window.TheoriaSchoolAdmin={canAdmin(id){return !!(inst&&inst.id===id&&canWrite(inst,user));},mount(nextInst,nextUser){inst=nextInst;user=nextUser;activeTab="overview";memberAdmin=false;const currentId=inst.id;(async()=>{try{const docSnap=await getDoc(doc(db,"institutions",currentId,"staff",user.uid));if(inst.id!==currentId)return;memberAdmin=docSnap.exists()&&["principal","assistant_principal","district_admin","registrar"].includes(docSnap.data().role);}catch(error){console.warn("Admin role lookup failed",error);}await load();await showInvitation();})().catch(console.error);}};
