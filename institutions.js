import {auth,db,onAuthStateChanged,collection,doc,addDoc,getDocs,getDoc,query,where,serverTimestamp,updateDoc,setDoc,Timestamp} from "./firebase.js";

// Institutional workspace: deliberately separate from independent educator courses.
const $=s=>document.querySelector(s);
const escapeHTML=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeDate=v=>v?new Date(v+"T00:00:00").getTime():NaN;
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
let currentUser=null, institutions=[], activeId="", busy=false, onboardingShownFor="";
function notice(msg){const el=$("#institutionNotice");if(el){el.textContent=msg;el.hidden=false;} }
function validName(s){return String(s||"").trim().slice(0,100);}
function isManager(inst){return inst?.ownerUid===currentUser?.uid;}
async function refresh(){
 if(!currentUser)return;
 const [mine,all]=await Promise.all([
  getDocs(query(collection(db,"institutions"),where("ownerUid","==",currentUser.uid))),
  getDocs(query(collection(db,"institutions"),where("status","==","active")))
 ]);
 const map=new Map();
 [...mine.docs,...all.docs].forEach(d=>map.set(d.id,{id:d.id,...d.data()}));
 institutions=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name));
 if(!institutions.find(i=>i.id===activeId))activeId=institutions.find(i=>isManager(i))?.id||institutions[0]?.id||"";
 await render();
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
 list.innerHTML='<div class="institution-actions"><button class="primary-btn" data-inst-action="new">Create school or district</button></div>'+
  (institutions.length?institutions.map(i=>'<button class="institution-list-item '+(activeId===i.id?'selected':'')+'" data-inst-select="'+escapeHTML(i.id)+'"><strong>'+escapeHTML(i.name)+'</strong><small>'+escapeHTML(i.kind==="district"?"School district":"School / institution")+(i.verified?" · Verified":" · Unverified")+(isManager(i)?" · Managed by you":"")+'</small></button>').join(""):'<p class="page-subtitle">No published institutions yet. Establish the first school or district.</p>');
 const inst=institutions.find(i=>i.id===activeId);
 if(!inst){root.innerHTML='<div class="institution-empty"><h3>Build an academic community</h3><p>Create an institution to organize courses, publish enrollment dates, and accept student requests.</p></div>';return;}
 root.innerHTML='<div class="institution-heading"><div><div class="eyebrow">'+escapeHTML(inst.kind==="district"?"District workspace":"School course catalog")+'</div><h2>'+escapeHTML(inst.name)+'</h2><p class="page-subtitle">'+escapeHTML(inst.description||"Academic programs and registration")+'</p></div>'+(isManager(inst)?'<button class="secondary-btn small-btn" data-inst-action="new-offering">Publish offering</button>':'')+'</div>'+
 (inst.parentDistrictId?'<p class="fineprint">Part of a school district</p>':'')+
 '<div id="institutionOfferings" aria-live="polite">Loading course catalog…</div><div id="schoolManagementArea"></div>';
 try{
  const snap=await getDocs(query(collection(db,"institutions",inst.id,"offerings"),where("published","==",true)));
  let own=[];
  if(isManager(inst)){const managers=await getDocs(collection(db,"institutions",inst.id,"offerings"));own=managers.docs.map(d=>({id:d.id,...d.data()}));}
  else own=snap.docs.map(d=>({id:d.id,...d.data()}));
  own.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||"")));
  $("#institutionOfferings").innerHTML=own.length?own.map(o=>{
   const now=today(),open=o.published&&o.openDate<=now&&now<=o.closeDate;
   return '<article class="institution-offering"><div class="institution-offering-top"><div><div class="eyebrow">'+escapeHTML(o.code||"COURSE")+'</div><h3>'+escapeHTML(o.title)+'</h3></div><span class="badge '+(open?'live':'')+'">'+(open?"Registration open":o.published?"Registration closed":"Draft")+'</span></div><p>'+escapeHTML(o.description||"Institutional course offering")+'</p><p class="fineprint">Term: '+escapeHTML(o.term||"To be arranged")+' · '+escapeHTML(o.openDate||"—")+' to '+escapeHTML(o.closeDate||"—")+'</p>'+
   (open&&!isManager(inst)?'<button class="primary-btn small-btn" data-inst-request="'+escapeHTML(o.id)+'">Request enrollment</button>':isManager(inst)?'<button class="secondary-btn small-btn" data-inst-requests="'+escapeHTML(o.id)+'">Review requests</button>':'')+'</article>';
  }).join(""):'<p class="page-subtitle">No published offerings yet. Administrators can create the school catalog here.</p>';
 }catch(e){console.error(e);$("#institutionOfferings").textContent="Unable to load offerings. Check access and Firestore rules.";}
 window.TheoriaSchoolAdmin?.mount(inst,currentUser);
}

async function finishDistrictOnboarding(profile,name,title){
 const districtName=validName(name),position=String(title||"district_administrator");
 if(districtName.length<3){alert("Please enter a district name.");return;}
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
  }catch(error){alert("Unable to save account setup: "+error.message);console.error(error);}
  finally{busy=false;}
 };
}

function openModal(title,formHTML){
 const r=$("#modalRoot");if(!r)return;
 r.innerHTML='<div class="modal-backdrop institution-modal-backdrop"><div class="modal institution-dialog" role="dialog" aria-modal="true" aria-label="'+escapeHTML(title)+'"><div class="modal-header"><h2>'+escapeHTML(title)+'</h2><button type="button" class="secondary-btn" id="closeInstitutionModal">Close</button></div>'+formHTML+'</div></div>';
 $("#closeInstitutionModal").onclick=()=>r.innerHTML="";
}
function createInstitution(){
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
function createOffering(){
 const inst=institutions.find(i=>i.id===activeId);if(!isManager(inst))return;
 openModal("Publish a course offering",'<form id="offeringForm" class="institution-form"><label>Course title<input name="title" required maxlength="120" placeholder="Introduction to Biology"></label><label>Course code<input name="code" maxlength="24" placeholder="BIOL 101"></label><label>Academic term<input name="term" maxlength="80" placeholder="Fall 2027"></label><label>Course description<textarea name="description" maxlength="1000"></textarea></label><div class="institution-date-pair"><label>Registration opens<input name="openDate" type="date" required></label><label>Registration closes<input name="closeDate" type="date" required></label></div><p class="fineprint">Enrollment requests require administrative review. This offering does not automatically create a teaching section.</p><button class="primary-btn" type="submit">Publish to catalog</button></form>');
 $("#offeringForm").onsubmit=async e=>{
  e.preventDefault();if(busy)return;const f=new FormData(e.currentTarget);
  const title=validName(f.get("title")),openDate=String(f.get("openDate")),closeDate=String(f.get("closeDate"));
  if(title.length<3||!Number.isFinite(safeDate(openDate))||safeDate(closeDate)<safeDate(openDate)){notice("Enter a title and a valid registration period.");return;}
  busy=true;try{await addDoc(collection(db,"institutions",activeId,"offerings"),{title,code:String(f.get("code")||"").slice(0,24),term:String(f.get("term")||"").slice(0,80),description:String(f.get("description")||"").slice(0,1000),openDate,closeDate,openAt:Timestamp.fromDate(new Date(openDate+"T00:00:00Z")),closeAt:Timestamp.fromDate(new Date(new Date(closeDate+"T00:00:00Z").getTime()+86400000)),published:true,createdBy:currentUser.uid,createdAt:serverTimestamp()});$("#modalRoot").innerHTML="";await render();notice("Course offering published.");}catch(error){notice("Unable to publish: "+error.message);}finally{busy=false;}
 };
}
async function requestOffering(offeringId){
 const inst=institutions.find(i=>i.id===activeId);if(!inst||!currentUser)return;
 if(!confirm("Submit an enrollment request to "+inst.name+"? This is not confirmed enrollment."))return;
 const reqRef=doc(db,"institutions",inst.id,"requests",offeringId+"_"+currentUser.uid);
 try{await setDoc(reqRef,{offeringId,studentUid:currentUser.uid,status:"pending",createdAt:serverTimestamp()});notice("Enrollment request submitted. An administrator must review it.");}
 catch(error){notice("Request could not be submitted: "+error.message);}
}
async function reviewRequests(offeringId){
 const inst=institutions.find(i=>i.id===activeId);if(!isManager(inst))return;
 const snap=await getDocs(query(collection(db,"institutions",inst.id,"requests"),where("offeringId","==",offeringId)));
 const arr=snap.docs.map(d=>({id:d.id,...d.data()}));
 openModal("Enrollment requests",'<div class="institution-request-list">'+(arr.length?arr.map(r=>'<div class="institution-request"><span>Student: '+escapeHTML(r.studentUid)+'</span><span>'+escapeHTML(r.status)+'</span>'+(r.status==="pending"?'<button class="secondary-btn small-btn" data-inst-decision="'+escapeHTML(r.id)+'" data-status="approved">Approve request</button><button class="secondary-btn small-btn" data-inst-decision="'+escapeHTML(r.id)+'" data-status="declined">Decline</button>':'')+'</div>').join(""):'<p>No requests for this offering.</p>')+'</div>');
}
document.addEventListener("click",async e=>{
 const select=e.target.closest("[data-inst-select]");if(select){activeId=select.dataset.instSelect;render();return;}
 const action=e.target.closest("[data-inst-action]");if(action){action.dataset.instAction==="new"?createInstitution():createOffering();return;}
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
