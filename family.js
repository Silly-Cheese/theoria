import {auth,db,onAuthStateChanged,createUserWithEmailAndPassword,signInWithEmailAndPassword,signOut,updateProfile,doc,getDoc,getDocs,setDoc,addDoc,collection,query,where,serverTimestamp} from "./firebase.js";
const $=s=>document.querySelector(s),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let user=null,access=[],selection=0,page="overview",reports={},errorText="";
const notice=msg=>$("#familyAuthMessage").textContent=msg;
$("#familyLoginTab").onclick=()=>switchTab(false);$("#familyCreateTab").onclick=()=>switchTab(true);
function switchTab(create){$("#familyLoginForm").classList.toggle("hidden",create);$("#familyCreateForm").classList.toggle("hidden",!create);$("#familyLoginTab").classList.toggle("selected",!create);$("#familyCreateTab").classList.toggle("selected",create);notice("");}
$("#familyLoginForm").onsubmit=async ev=>{ev.preventDefault();const f=new FormData(ev.currentTarget);try{await signInWithEmailAndPassword(auth,String(f.get("email")).trim(),String(f.get("password")));}catch(e){notice(e.message);}};
$("#familyCreateForm").onsubmit=async ev=>{ev.preventDefault();const f=new FormData(ev.currentTarget);try{const c=await createUserWithEmailAndPassword(auth,String(f.get("email")).trim(),String(f.get("password")));await updateProfile(c.user,{displayName:String(f.get("name")).trim()});await setDoc(doc(db,"users",c.user.uid),{displayName:String(f.get("name")).trim(),email:c.user.email,role:"parent",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}catch(e){notice(e.message);}};
$("#familySignOut").onclick=()=>signOut(auth);
document.addEventListener("click",event=>{const button=event.target.closest("[data-family-page]");if(button){page=button.dataset.familyPage;draw();}const student=event.target.closest("[data-family-student]");if(student){selection=Number(student.dataset.familyStudent);page="overview";draw();}});
async function load(){
 access=[];reports={};errorText="";
 try{
  const schools=await getDocs(query(collection(db,"institutions"),where("status","==","active")));
  await Promise.all(schools.docs.map(async school=>{try{const links=await getDocs(query(collection(db,"institutions",school.id,"guardianAccess"),where("guardianUid","==",user.uid)));links.forEach(d=>access.push({id:d.id,institutionId:school.id,institutionName:school.data().name,...d.data()}));}catch(error){console.warn("Family grants",error);}}));
  access.sort((a,b)=>String(a.studentName||"").localeCompare(String(b.studentName||"")));
  selection=0;
  await Promise.all(access.map(async a=>{const key=a.institutionId+"_"+a.studentUid;reports[key]={studentRecords:[],attendance:[],familyAlerts:[],familyRequests:[],issues:[]};await Promise.all(["studentRecords","attendance","familyAlerts","familyRequests"].map(async name=>{try{const snap=await getDocs(query(collection(db,"institutions",a.institutionId,name),where("studentUid","==",a.studentUid),...(name==="familyRequests"?[where("guardianUid","==",user.uid)]:[])));reports[key][name]=snap.docs.map(d=>({id:d.id,...d.data()}));}catch(e){reports[key].issues.push(name+": "+e.message);}}));}));
 }catch(e){errorText="Unable to load participating institutions: "+e.message;}
 draw();
}
function row(title,subtitle){return '<div class="family-record"><strong>'+esc(title)+'</strong><span>'+esc(subtitle)+'</span></div>';}
function draw(){
 $("#familyStudents").innerHTML=access.length?access.map((a,i)=>'<button class="family-student '+(selection===i?"selected":"")+'" data-family-student="'+i+'"><strong>'+esc(a.studentName||"Student")+'</strong><small>'+esc(a.institutionName)+'</small></button>').join(""):'<p class="family-note">No approved students yet. Ask your school to send an invitation and approve your request.</p>';
 document.querySelectorAll("[data-family-page]").forEach(b=>b.classList.toggle("selected",b.dataset.familyPage===page));
 const a=access[selection],target=$("#familyContent");
 if(!a){$("#familyStudentHeading").innerHTML='<h2>No active family access</h2>';target.innerHTML='<div class="family-empty">'+esc(errorText||"Once the school approves your invitation, the student will appear here.")+'</div>';return;}
 $("#familyStudentHeading").innerHTML='<div class="eyebrow">'+esc(a.institutionName)+'</div><h2>'+esc(a.studentName||"Student")+'</h2>';
 const data=reports[a.institutionId+"_"+a.studentUid]||{studentRecords:[],attendance:[],issues:[]};const records=data.studentRecords,att=data.attendance;
 if(page==="overview"){target.innerHTML='<div class="family-metrics"><div><strong>'+records.length+'</strong><span>Academic records</span></div><div><strong>'+att.length+'</strong><span>Attendance entries</span></div><div><strong>'+att.filter(x=>x.status==="absent").length+'</strong><span>Absences recorded</span></div></div><h3>Recent academic results</h3>'+(records.length?records.slice(0,5).map(r=>row(r.courseTitle||"Course",String(r.finalGrade||"Pending")+" · "+(r.status||""))).join(""):'<p>No academic results have been published by the institution.</p>');}
 if(page==="academics"){target.innerHTML='<h3>Academic records</h3>'+(records.length?records.map(r=>row(r.courseTitle||"Course",String(r.finalGrade||"Pending")+" · "+(r.status||"")+" · "+String(r.credits??"—")+" credits")).join(""):'<p>No records are available yet.</p>');}
 if(page==="attendance"){target.innerHTML='<h3>Attendance history</h3>'+(att.length?att.sort((a,b)=>String(b.day||"").localeCompare(String(a.day||""))).map(r=>row(r.offeringTitle||"Class",String(r.day||"")+" · "+String(r.status||""))).join(""):'<p>No attendance entries are available yet.</p>');}
 if(page==="requests"){target.innerHTML='<h3>Family access and school support</h3><p>This student is linked to your account through an approved school invitation. To correct records, request additional student access, or change guardian permissions, contact the institution directly.</p>'+row("Institution",a.institutionName)+row("Access","School approved")+'<div class="family-request-actions"><button class="primary-btn" data-parent-request="message">Message school</button> <button class="secondary-btn" data-parent-request="conference">Request conference</button> <button class="secondary-btn" data-parent-request="record_correction">Request record correction</button></div><h3>My requests</h3>'+(data.familyRequests.length?data.familyRequests.map(r=>row(r.subject,r.type+" · "+r.status)).join(""):'<p>No requests have been submitted.</p>')+'<p class="family-note">Theoria does not disclose instructor-only assessments or confidential support information through the family portal.</p>';}
 if(data.issues.length)target.innerHTML+='<p class="family-warning">Some records could not be loaded: '+esc(data.issues.join("; "))+'</p>';
}
document.addEventListener("click",async event=>{
 const trigger=event.target.closest("[data-parent-request]");if(!trigger||!user)return;
 const a=access[selection];if(!a)return;
 const kind=trigger.dataset.parentRequest;
 const values=await window.TheoriaDialog.form(kind==="conference"?"Request a conference":kind==="record_correction"?"Request a record correction":"Message the school",[{name:"subject",label:"Subject",maxLength:120},{name:"message",label:"Details",maxLength:1500,multiline:true}]);
 if(!values)return;
 const subject=values.subject?.trim(),message=values.message?.trim();
 if(!subject||!message)return;
 try{
  await addDoc(collection(db,"institutions",a.institutionId,"familyRequests"),{guardianUid:user.uid,studentUid:a.studentUid,type:kind,subject:subject.trim(),message:message.trim(),status:"pending",createdAt:serverTimestamp()});
  const key=a.institutionId+"_"+a.studentUid;
  reports[key].familyRequests.push({subject:subject.trim(),type:kind,status:"pending"});
  draw();window.TheoriaDialog.alert("Your request was submitted to the school.");
 }catch(error){window.TheoriaDialog.alert("Unable to submit: "+error.message);}
});
onAuthStateChanged(auth,async next=>{user=next;$("#familyAuth").classList.toggle("hidden",!!next);$("#familyDashboard").classList.toggle("hidden",!next);$("#familySignOut").classList.toggle("hidden",!next);$("#familyAccountName").textContent=next?.displayName||next?.email||"";if(next)await load();});
