import {auth,db,onAuthStateChanged,createUserWithEmailAndPassword,updateProfile,doc,getDoc,getDocs,collection,query,where,setDoc,updateDoc,serverTimestamp} from "./firebase.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const invite=new URLSearchParams(location.search).get("parentInvite");
let activeUser=null;
const wrapper=document.createElement("div");wrapper.className="parent-setup-overlay hidden";wrapper.innerHTML='<div class="parent-setup-card" role="dialog" aria-modal="true"><div class="eyebrow">Theoria Family Access</div><h2>Parent & Guardian Portal</h2><p id="familyDescription">Sign in to view your family access.</p><div id="familyActions"></div><p id="familyError" role="status"></p><button class="secondary-btn" id="familyClose">Close</button></div>';document.body.appendChild(wrapper);
const actionBox=()=>document.getElementById("familyActions");
const error=t=>document.getElementById("familyError").textContent=t;
document.getElementById("familyClose").onclick=()=>wrapper.classList.add("hidden");
const invitationParts=invite&&/^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{8,128}$/.test(invite)?invite.split("."):null;
function newAccount(){
 actionBox().innerHTML='<form id="familySignUp" class="institution-form"><label>Full name<input name="name" maxlength="100" required></label><label>Email<input type="email" name="email" required></label><label>Password (at least 8 characters)<input type="password" name="password" minlength="8" required></label><button class="primary-btn">Create parent account</button></form>';
 document.getElementById("familySignUp").onsubmit=async event=>{event.preventDefault();const f=new FormData(event.currentTarget);try{const credential=await createUserWithEmailAndPassword(auth,String(f.get("email")).trim(),String(f.get("password")));await updateProfile(credential.user,{displayName:String(f.get("name")).trim()});await setDoc(doc(db,"users",credential.user.uid),{displayName:String(f.get("name")).trim(),email:credential.user.email,role:"parent",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});activeUser=credential.user;await show();}catch(e){error(e.message);}};
}
async function show(){
 wrapper.classList.remove("hidden");error("");
 if(!activeUser){
  document.getElementById("familyDescription").textContent="Create a parent account or sign in to accept your school invitation.";
  actionBox().innerHTML='<button class="primary-btn" id="familyCreate">Create account</button><button class="secondary-btn" id="familySignIn">Sign in</button>';
  document.getElementById("familyCreate").onclick=newAccount;
  document.getElementById("familySignIn").onclick=()=>{wrapper.classList.add("hidden");document.querySelector('[data-auth-tab="signin"]')?.click();};
  return;
 }
 if(!invitationParts)return dashboard();
 const [institutionId,invitationId]=invitationParts;
 try{
  const ref=doc(db,"institutions",institutionId,"guardianLinks",invitationId);
  const snap=await getDoc(ref);
  if(!snap.exists())return error("This invitation is not available to your account. Sign in with the email specified by your school.");
  const data=snap.data();
  document.getElementById("familyDescription").textContent="Family access request for "+(data.studentName||"the invited student")+".";
  if(data.status==="pending_verification"){
   actionBox().innerHTML='<form id="claimFamily" class="institution-form"><p>Enter the student’s full name exactly as provided to the school. The school must still approve your relationship before any records are shown.</p><label>Student full name<input required name="studentName" maxlength="100" autocomplete="off"></label><button class="primary-btn">Request access</button></form>';
   document.getElementById("claimFamily").onsubmit=async event=>{event.preventDefault();const name=String(new FormData(event.currentTarget).get("studentName")||"").trim();if(name!==String(data.studentName||"").trim())return error("The student name does not match the invitation.");try{
     const signedEmail=String(activeUser.email||"").trim().toLowerCase();
     const invitedEmail=String(data.guardianEmail||"").trim().toLowerCase();
     if(!signedEmail||signedEmail!==invitedEmail){error("This invitation is addressed to "+invitedEmail+". Sign in with that email address, or ask your school to send a new invitation.");return;}
     if(data.guardianUid&&data.guardianUid!==activeUser.uid){error("This invitation was already claimed by another account. Contact the school.");return;}
     await updateDoc(ref,{status:"awaiting_school_approval",guardianUid:activeUser.uid,claimedAt:serverTimestamp()});
     await show();
    }catch(e){
     console.error("Guardian invitation claim failed",e);
     error(e.code==="permission-denied"?"The school invitation is visible, but Firestore rejected the claim. Ask the site administrator to deploy the latest firestore.rules. If the rules are already deployed, confirm the invitation email exactly matches your signed-in account.":"Unable to request access: "+e.message);
    }};
   return;
  }
  actionBox().innerHTML='<p>'+esc(data.status==="awaiting_school_approval"?"Your request is awaiting school approval.":data.status==="approved"?"Your guardian access was approved.":"The school declined this request.")+'</p><a class="primary-btn" href="./parents.html">Open Family Portal</a>';
  
 }catch(e){error("Could not load invitation: "+e.message);}
}
async function dashboard(){
 document.getElementById("familyDescription").textContent="Approved student records and attendance";
 actionBox().innerHTML='<p>Loading approved student records…</p>';
 try{
  const schools=await getDocs(query(collection(db,"institutions"),where("status","==","active")));
  const access=[];
  for(const school of schools.docs){
   try{const snap=await getDocs(query(collection(db,"institutions",school.id,"guardianAccess"),where("guardianUid","==",activeUser.uid)));snap.docs.forEach(d=>access.push({school:school.data().name,institutionId:school.id,...d.data()}));}catch(e){console.warn("Guardian access not available",e);}
  }
  if(!access.length){actionBox().innerHTML='<p>No school-approved student access is available yet. Ask the school to approve your invitation.</p>';return;}
  const entries=[];
  for(const a of access){
   const section=['<h3>'+esc(a.school)+' · '+esc(a.studentName||"Student")+'</h3>'];
   for(const category of ["studentRecords","attendance"]){
    try{const snap=await getDocs(query(collection(db,"institutions",a.institutionId,category),where("studentUid","==",a.studentUid)));
     section.push('<h4>'+(category==="attendance"?"Attendance":"Academic records")+'</h4>');
     section.push(snap.empty?'<p>No records published.</p>':snap.docs.map(d=>{const v=d.data();return '<div class="school-entry"><strong>'+esc(v.courseTitle||v.offeringTitle||"Course")+'</strong><span>'+esc(category==="attendance"?(v.day||"")+" · "+(v.status||""):(v.finalGrade||"Pending")+" · "+(v.status||""))+'</span></div>';}).join(""));
    }catch(e){section.push('<p>Records unavailable: '+esc(e.message)+'</p>');}
   }entries.push('<section>'+section.join("")+'</section>');
  }
  actionBox().innerHTML='<div class="family-records">'+entries.join("")+'</div>';
 }catch(e){error("Could not load guardian dashboard: "+e.message);}
}
onAuthStateChanged(auth,user=>{activeUser=user;if(invitationParts)show();else if(user&&new URLSearchParams(location.search).has("guardianPortal"))show();});
window.TheoriaFamilyPortal={open:show};
