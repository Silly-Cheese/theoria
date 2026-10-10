import {auth,db,onAuthStateChanged,collection,doc,addDoc,getDocs,getDoc,query,where,serverTimestamp,updateDoc,setDoc,Timestamp} from "./firebase.js";

// Institutional workspace: deliberately separate from independent educator courses.
const $=s=>document.querySelector(s);
const escapeHTML=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeDate=v=>v?new Date(v+"T00:00:00").getTime():NaN;
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
let currentUser=null, institutions=[], activeId="", busy=false, onboardingShownFor="", managedInstitutionIds=new Set(),profileRole="student",memberships=new Map(),enrollmentRequests=new Map(),profileName="",placements=new Map();
function notice(msg){const el=$("#institutionNotice");if(el){el.textContent=msg;el.hidden=false;} }
function validName(s){return String(s||"").trim().slice(0,100);}
function isManager(inst){return !!inst&&(inst.ownerUid===currentUser?.uid||managedInstitutionIds.has(inst.id));}
async function refresh(){
 if(!currentUser)return;
 const profile=await getDoc(doc(db,"users",currentUser.uid));profileRole=profile.data()?.role||"student";profileName=String(profile.data()?.displayName||currentUser.displayName||"Student").slice(0,100);
 const [mine,all]=await Promise.all([
  getDocs(query(collection(db,"institutions"),where("ownerUid","==",currentUser.uid))),
  getDocs(query(collection(db,"institutions"),where("status","==","active")))
 ]);
 const map=new Map();
 [...mine.docs,...all.docs].forEach(d=>map.set(d.id,{id:d.id,...d.data()}));
 institutions=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
 managedInstitutionIds=new Set();memberships=new Map();enrollmentRequests=new Map();placements=new Map();
 await Promise.all(institutions.map(async i=>{try{const m=await getDoc(doc(db,"institutions",i.id,"members",currentUser.uid));if(m.exists()){memberships.set(i.id,m.data());if(profileRole==="student"&&profileName.length>=2&&(!m.data().studentName||["Student","Student name unavailable","Unknown"].includes(m.data().studentName))){try{await updateDoc(doc(db,"institutions",i.id,"members",currentUser.uid),{studentName:profileName});memberships.set(i.id,{...m.data(),studentName:profileName});}catch(error){console.warn("Membership display-name update unavailable",error);}}}}catch(err){console.warn(err);}}));
 if(profileRole==="student")await Promise.all(institutions.map(async i=>{try{const s=await getDocs(query(collection(db,"institutions",i.id,"requests"),where("studentUid","==",currentUser.uid)));s.docs.forEach(d=>enrollmentRequests.set(i.id+"_"+d.data().offeringId,d.data()));}catch(error){console.warn("Unable to retrieve registration requests",error);}}));
 if(profileRole==="student")await Promise.all(institutions.map(async i=>{try{const s=await getDocs(query(collection(db,"institutions",i.id,"placements"),where("studentUid","==",currentUser.uid)));s.docs.forEach(d=>placements.set(i.id+"_"+d.data().offeringId,d.data()));}catch(error){console.warn("Unable to retrieve placements",error);}}));
 await Promise.all(institutions.filter(i=>i.ownerUid!==currentUser.uid).map(async i=>{try{const m=await getDoc(doc(db,"institutions",i.id,"staff",currentUser.uid));if(m.exists()&&["principal","assistant_principal","district_admin","registrar"].includes(m.data().role))managedInstitutionIds.add(i.id);}catch(e){/* No membership */}}));
 if(!institutions.find(i=>i.id===activeId))activeId=institutions.find(i=>isManager(i))?.id||institutions.find(i=>i.kind==="school")?.id||institutions[0]?.id||"";
 await render();
 const joinNotice=$("#studentSchoolNotice");
 if(joinNotice)joinNotice.remove();
 if(profileRole==="student"&&![...memberships.values()].some(m=>m.status==="active")){
  const home=$("#page-home");
  if(home){const banner=document.createElement("div");banner.id="studentSchoolNotice";banner.className="institution-notice";banner.innerHTML='<strong>Connect with your school</strong><p>To register for school courses, select your school and request membership. You can continue existing independent coursework while the school reviews your request.</p><button type="button" class="primary-btn" id="findSchoolBtn">Find my school</button>';
  home.insertBefore(banner,home.firstChild);
  banner.querySelector("button").onclick=()=>document.querySelector('[data-page="institutions"]')?.click();
  }
 }
}
function shell(){
 return '<div class="page-head"><div><div class="eyebrow">Theoria Institutions</div><h1 class="page-title">Schools & Districts</h1><p class="page-subtitle">Create academic institutions, publish school catalogs, and manage defined course-registration windows. Independent courses remain unchanged.</p></div></div>'+
 '<div id="institutionNotice" class="institution-notice" role="status" hidden></div><div class="institution-grid">'+
 '<div class="panel"><div class="panel-head"><div class="panel-title">Institutions</div></div><div class="panel-body"><div id="institutionList"></div></div></div>'+
 '<div class="panel"><div class="panel-head"><div class="panel-title">Institution workspace</div></div><div class="panel-body"><div id="institutionWorkspace"></div></div></div></div>';
}
function institutionOptions(){return institutions.filter(i=>i.kind==="district"&&isManager(i)).map(i=>'<option value="'+escapeHTML(i.id)+'">'+escapeHTML(i.name)+'</option>').join("");}
async function render(){
 const root=$("#institutionWorkspace"),list=$("#institutionList");if(!root||!list)return;
 list.innerHTML=(profileRole==="instructor"?'<div class="institution-actions"><button class="primary-btn" data-inst-action="new">Create school or district</button></div>':'')+
  (institutions.length?institutions.map(i=>'<button class="institution-list-item '+(activeId===i.id?'selected':'')+'" data-inst-select="'+escapeHTML(i.id)+'"><strong>'+escapeHTML(i.name)+'</strong><small>'+escapeHTML(i.kind==="district"?"School district":"School / institution")+(i.verified?" · Verified":" · Unverified")+(isManager(i)?" · Managed by you":"")+'</small></button>').join(""):'<p class="page-subtitle">No available schools or districts have been published yet.</p>');
 const inst=institutions.find(i=>i.id===activeId);
 if(!inst){root.innerHTML='<div class="institution-empty"><h3>Find your school</h3><p>When your school appears here, request membership before registering for its courses.</p></div>';return;}
 root.innerHTML='<div class="institution-heading"><div><div class="eyebrow">'+escapeHTML(inst.kind==="district"?"District workspace":"School course catalog")+'</div><h2>'+escapeHTML(inst.name)+'</h2><p class="page-subtitle">'+escapeHTML(inst.description||"Academic programs and registration")+'</p></div>'+(isManager(inst)?'<button class="secondary-btn small-btn" data-inst-action="new-offering">Publish offering</button>':'')+'</div>'+
 (inst.parentDistrictId?'<p class="fineprint">Part of a school district</p>':'')+
 (profileRole==="student"?'<div class="institution-member-status" id="institutionMemberStatus"></div>':'')+'<div id="institutionOfferings" aria-live="polite">Loading course catalog…</div><div id="schoolManagementArea"></div>';
 const membership=memberships.get(inst.id);const statusEl=$("#institutionMemberStatus");if(statusEl)statusEl.innerHTML=membership?'<p class="page-subtitle">School membership: <strong>'+escapeHTML(membership.status)+'</strong></p>' :'<p class="page-subtitle">You have not joined this '+(inst.kind==="district"?'district':'school')+' yet.</p><button class="primary-btn" data-inst-join="'+escapeHTML(inst.id)+'">Request to join '+(inst.kind==="district"?'district':'school')+'</button>';
 try{
  const snap=await getDocs(query(collection(db,"institutions",inst.id,"offerings"),where("published","==",true)));
  let own=[];
  if(isManager(inst)){const managers=await getDocs(collection(db,"institutions",inst.id,"offerings"));own=managers.docs.map(d=>({id:d.id,...d.data()}));}
  else own=snap.docs.map(d=>({id:d.id,...d.data()}));
  own.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||"")));
  $("#institutionOfferings").innerHTML=own.length?own.map(o=>{
   const now=today(),open=o.published&&o.openDate<=now&&now<=o.closeDate;
   return '<article class="institution-offering"><div class="institution-offering-top"><div><div class="eyebrow">'+escapeHTML(o.code||"COURSE")+'</div><h3>'+escapeHTML(o.title)+'</h3></div><span class="badge '+(open?'live':'')+'">'+(open?"Registration open":o.published?"Registration closed":"Draft")+'</span></div><p>'+escapeHTML(o.description||"Institutional course offering")+'</p><p class="fineprint">Term: '+escapeHTML(o.term||"To be arranged")+' · '+escapeHTML(o.openDate||"—")+' to '+escapeHTML(o.closeDate||"—")+'</p>'+
   (profileRole==="student"&&membership?.status==="active"&&!isManager(inst)?(placements.get(inst.id+"_"+o.id)?.sectionReference?'<a class="primary-btn small-btn" href="./index.html?join='+encodeURIComponent(placements.get(inst.id+"_"+o.id).sectionReference)+'">Join assigned section</a>':enrollmentRequests.get(inst.id+"_"+o.id)?'<span class="badge">'+escapeHTML("Request "+enrollmentRequests.get(inst.id+"_"+o.id).status)+'</span>':open?'<button class="primary-btn small-btn" data-inst-request="'+escapeHTML(o.id)+'">Request enrollment</button>':'<span class="fineprint">Enrollment unavailable</span>'):isManager(inst)?'<button class="secondary-btn small-btn" data-inst-requests="'+escapeHTML(o.id)+'">Review requests</button>':'')+'</article>';
  }).join(""):'<p class="page-subtitle">No published offerings yet. Administrators can create the school catalog here.</p>';
 }catch(e){console.error(e);$("#institutionOfferings").textContent="Unable to load offerings. Check access and Firestore rules.";}
 window.TheoriaSchoolAdmin?.mount(inst,currentUser);
}

async function finishDistrictOnboarding(profile,name,title){
 const districtName=validName(name),position=String(title||"district_administrator");
 if(districtName.length<3){window.TheoriaDialog.alert("Please enter a district name.");return;}
 const own=await getDocs(query(collection(db,"institutions"),where("ownerUid","==",currentUser.uid)));
 let district=own.docs.find(d=>d.data().kind==="district"&&d.data().name.toLowerCase()===districtName.toLowerCase());
 if(!district){
  district=await addDoc(collection(db,"institutions"),{name:districtName,kind:"district",parentDistrictId:"",description:"",ownerUid:currentUser.uid,status:"active",verified:false,createdAt:serverTimestamp()});
 }
 await updateDoc(doc(db,"users",currentUser.uid),{districtAdminOnboarding:"completed",districtAdminTitle:position,districtInstitutionId:district.id,updatedAt:serverTimestamp()});
 activeId=district.id;
 $("#modalRoot").innerHTML="";
 await refresh();
 notice("Your unverified district workspace is ready. Add schools and publish course registration periods.");
}
async function maybeOnboard(){
 if(!currentUser||onboardingShownFor===currentUser.uid)return;
 const snap=await getDoc(doc(db,"users",currentUser.uid));
 if(!snap.exists())return;
 const profile=snap.data();
 if(profile.role!=="instructor")return;
 if(profile.districtAdminOnboarding==="completed"||profile.districtAdminOnboarding==="declined")return;
 onboardingShownFor=currentUser.uid;
 const requested=profile.districtAdminOnboarding==="pending";
 openModal(requested?"Complete district administrator registration":"Institutional account setup",'<form id="districtSetupForm" class="institution-form"><p class="page-subtitle">'+(requested?"Finish establishing your district.":"Are you a superintendent or district administrator? You can create a district workspace now, or continue as an independent instructor.")+'</p><label>District administrator status<select id="districtSetupChoice"><option value="yes"'+(requested?' selected':'')+'>Yes, I administer a district</option><option value="no"'+(!requested?' selected':'')+'>No, continue as an instructor</option></select></label><div id="districtSetupDetails"><label>School district name<input id="districtSetupName" maxlength="100" placeholder="Full district name" value="'+escapeHTML(profile.districtSetupName||"")+'"></label><label>Your title<select id="districtSetupTitle"><option value="superintendent">Superintendent</option><option value="assistant_superintendent">Assistant Superintendent</option><option value="district_administrator">District Administrator</option></select></label></div><p class="fineprint">Institutional claims remain unverified until independently reviewed. You will not receive access to any existing district automatically.</p><button type="submit" class="primary-btn">Save account setup</button></form>');
 $("#districtSetupTitle").value=["superintendent","assistant_superintendent","district_administrator"].includes(profile.districtAdminTitle)?profile.districtAdminTitle:"district_administrator";
 const choice=$("#districtSetupChoice"),details=$("#districtSetupDetails"),name=$("#districtSetupName");
 const toggle=()=>{details.hidden=choice.value!=="yes";name.required=choice.value==="yes";};choice.onchange=toggle;toggle();
 $("#districtSetupForm").onsubmit=async e=>{
  e.preventDefault();if(busy)return;busy=true;
  try{
   if(choice.value==="yes")await finishDistrictOnboarding(profile,name.value,$("#districtSetupTitle").value);
   else{await updateDoc(doc(db,"users",currentUser.uid),{districtAdminOnboarding:"declined",updatedAt:serverTimestamp()});$("#modalRoot").innerHTML="";}
  }catch(error){window.TheoriaDialog.alert("Unable to save account setup: "+error.message);console.error(error);}
  finally{busy=false;}
 };
}

function openModal(title,formHTML){
 const r=$("#modalRoot");if(!r)return;
 r.innerHTML='<div class="modal-backdrop institution-modal-backdrop"><div class="modal institution-dialog" role="dialog" aria-modal="true" aria-label="'+escapeHTML(title)+'"><div class="modal-header"><h2>'+escapeHTML(title)+'</h2><button type="button" class="secondary-btn" id="closeInstitutionModal">Close</button></div>'+formHTML+'</div></div>';
 $("#closeInstitutionModal").onclick=()=>r.innerHTML="";
}
function createInstitution(){
 if(profileRole!=="instructor"||!currentUser)return notice("Only instructors and institution administrators can create schools.");
 openModal("Create an academic institution",'<form id="institutionForm" class="institution-form"><label>Institution name<input name="name" required maxlength="100" placeholder="North Valley High School"></label><label>Institution type<select name="kind"><option value="school">School / college / seminary</option><option value="district">School district</option></select></label><label>Parent district (optional)<select name="parentDistrictId"><option value="">Independent institution</option>'+institutionOptions()+'</select></label><label>Description<textarea name="description" maxlength="750" placeholder="Describe academic programs and the school community"></textarea></label><p class="fineprint">Creating an institution does not verify affiliation, accreditation, or legal authority.</p><button class="primary-btn" type="submit">Create institution</button></form>');
 $("#institutionForm").onsubmit=async e=>{
  e.preventDefault();if(busy)return;
  const f=new FormData(e.currentTarget),name=validName(f.get("name")),kind=String(f.get("kind")),parentDistrictId=String(f.get("parentDistrictId")||"");
  if(name.length<3||!["school","district"].includes(kind)||kind==="district"&&parentDistrictId){notice("Review the institution details.");return;}
  if(parentDistrictId&&!institutions.some(i=>i.id===parentDistrictId&&i.kind==="district"&&isManager(i))){notice("You may only add schools to districts you manage.");return;}
  busy=true;
  try{const d=await addDoc(collection(db,"institutions"),{name,kind,parentDistrictId,description:String(f.get("description")||"").slice(0,750),ownerUid:currentUser.uid,status:"active",verified:false,createdAt:serverTimestamp()});activeId=d.id;$("#modalRoot").innerHTML="";await refresh();notice("Institution created. Publish offerings to begin registration.");}
  catch(error){console.error(error);notice("Institution creation failed: "+error.message);}finally{busy=false;}
 };
}
async function createOffering(){
 const inst=institutions.find(i=>i.id===activeId);if(!isManager(inst)||profileRole!=="instructor")return;
 let catalog=[];
 try{const snap=await getDocs(collection(db,"courses"));catalog=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.catalogCourse===true&&x.catalogPublished===true&&x.status!=="Archived");}
 catch(error){return notice("Unable to load official Theoria courses: "+error.message);}
 if(!catalog.length)return notice("No published Theoria courses are available for selection.");
 const options=catalog.map(x=>'<option value="'+escapeHTML(x.id)+'">'+escapeHTML((x.code||"")+" — "+(x.title||"Untitled"))+'</option>').join("");
 openModal("Publish a Theoria course offering",'<form class="institution-form" id="offeringForm"><label>Choose a Theoria catalog course<select name="courseId" required>'+options+'</select></label><label>Academic term<input name="term" maxlength="80" required placeholder="Fall 2027"></label><div class="institution-date-pair"><label>Registration opens<input name="openDate" type="date" required></label><label>Registration closes<input name="closeDate" type="date" required></label></div><p class="fineprint">Only officially published Theoria catalog courses can be offered by a school.</p><button class="primary-btn" type="submit">Publish to catalog</button></form>');
 $("#offeringForm").onsubmit=async ev=>{
 ev.preventDefault();if(busy)return;const data=new FormData(ev.currentTarget),course=catalog.find(x=>x.id===data.get("courseId"));
 const openDate=String(data.get("openDate")),closeDate=String(data.get("closeDate"));
 if(!course||!Number.isFinite(safeDate(openDate))||safeDate(closeDate)<safeDate(openDate))return notice("Select an official course and a valid registration period.");
 busy=true;try{
 await addDoc(collection(db,"institutions",activeId,"offerings"),{courseId:course.id,title:course.title,code:course.code||"",term:String(data.get("term")||"").slice(0,80),description:String(course.description||"").slice(0,1000),openDate,closeDate,openAt:Timestamp.fromDate(new Date(openDate+"T00:00:00Z")),closeAt:Timestamp.fromDate(new Date(new Date(closeDate+"T00:00:00Z").getTime()+86400000)),published:true,createdBy:currentUser.uid,createdAt:serverTimestamp()});
 $("#modalRoot").innerHTML="";await render();notice("Official Theoria course offering published.");
 }catch(error){notice("Unable to publish: "+error.message);}finally{busy=false;}
 };
}
async function requestMembership(instId){
 if(profileRole!=="student")return;
 const target=institutions.find(i=>i.id===instId);if(!target||!["school","district"].includes(target.kind))return;
 try{await setDoc(doc(db,"institutions",instId,"members",currentUser.uid),{studentUid:currentUser.uid,studentName:profileName,status:"pending",requestedAt:serverTimestamp()});await refresh();notice("Membership request submitted. School administration must approve it.");}
 catch(error){notice("Could not request membership: "+error.message);}
}
async function requestOffering(offeringId){
 const inst=institutions.find(i=>i.id===activeId);if(!inst||!currentUser||profileRole!=="student"||memberships.get(inst.id)?.status!=="active")return notice("Join the school before requesting courses.");
 if(!await window.TheoriaDialog.confirm("Submit an enrollment request to "+inst.name+"? This is not confirmed enrollment."))return;
 const reqRef=doc(db,"institutions",inst.id,"requests",offeringId+"_"+currentUser.uid);
 try{await setDoc(reqRef,{offeringId,studentUid:currentUser.uid,studentName:profileName,status:"pending",createdAt:serverTimestamp()});await refresh();notice("Enrollment request submitted. An administrator must review it.");}
 catch(error){notice("Request could not be submitted: "+error.message);}
}
async function reviewRequests(offeringId){
 const inst=institutions.find(i=>i.id===activeId);if(!isManager(inst))return;
 const snap=await getDocs(query(collection(db,"institutions",inst.id,"requests"),where("offeringId","==",offeringId)));
 const arr=snap.docs.map(d=>({id:d.id,...d.data()}));
 openModal("Enrollment requests",'<div class="institution-request-list">'+(arr.length?arr.map(r=>'<div class="institution-request"><span>Student: '+escapeHTML(r.studentName||'Student name unavailable')+'</span><span>'+escapeHTML(r.status)+'</span>'+(r.status==="pending"?'<button class="secondary-btn small-btn" data-inst-decision="'+escapeHTML(r.id)+'" data-status="approved">Approve request</button><button class="secondary-btn small-btn" data-inst-decision="'+escapeHTML(r.id)+'" data-status="declined">Decline</button>':'')+'</div>').join(""):'<p>No requests for this offering.</p>')+'</div>');
}
document.addEventListener("click",async e=>{
 const join=e.target.closest("[data-inst-join]");if(join){await requestMembership(join.dataset.instJoin);return;}
 const select=e.target.closest("[data-inst-select]");if(select){activeId=select.dataset.instSelect;render();return;}
 const action=e.target.closest("[data-inst-action]");if(action){if(action.dataset.instAction==="new")createInstitution();else await createOffering();return;}
 const req=e.target.closest("[data-inst-request]");if(req){await requestOffering(req.dataset.instRequest);return;}
 const see=e.target.closest("[data-inst-requests]");if(see){await reviewRequests(see.dataset.instRequests);return;}
 const decision=e.target.closest("[data-inst-decision]");if(decision){
  const inst=institutions.find(i=>i.id===activeId);if(!isManager(inst))return;
  try{await updateDoc(doc(db,"institutions",inst.id,"requests",decision.dataset.instDecision),{status:decision.dataset.status,reviewedBy:currentUser.uid,reviewedAt:serverTimestamp()});await reviewRequests((await getDoc(doc(db,"institutions",inst.id,"requests",decision.dataset.instDecision))).data().offeringId);}catch(error){notice("Review failed: "+error.message);}
 }
});
onAuthStateChanged(auth,user=>{currentUser=user;if(!user){institutions=[];activeId="";onboardingShownFor="";return;}const root=$("#institutionWorkspace");if(root)refresh().catch(console.error);});
window.addEventListener("theoria:ready",()=>{maybeOnboard().catch(console.error);});
window.addEventListener("theoria:page",e=>{if(e.detail.page==="institutions"&&currentUser)refresh().catch(error=>notice(error.message));});
const page=$("#page-institutions");if(page)page.innerHTML=shell();
