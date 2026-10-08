import {auth,db,onAuthStateChanged,createUserWithEmailAndPassword,updateProfile,sendEmailVerification,reload,doc,getDoc,setDoc,updateDoc,serverTimestamp} from "./firebase.js";
const escape=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const invitation=new URLSearchParams(location.search).get("parentInvite");
if(invitation&&/^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{8,128}$/.test(invitation)){
 const [institutionId,invitationId]=invitation.split(".");
 let user=null;
 const parentBox=document.createElement("div");parentBox.className="parent-setup-overlay hidden";parentBox.innerHTML='<div class="parent-setup-card" role="dialog" aria-modal="true" aria-labelledby="parentHeading"><div class="eyebrow">Theoria Family Access</div><h2 id="parentHeading">Parent portal setup</h2><p id="parentDetails">Sign in or create your parent account to accept an invitation.</p><div id="parentActions"></div><p id="parentMessage" role="status"></p><button class="secondary-btn" id="parentDismiss">Close</button></div>';document.body.appendChild(parentBox);
 const message=v=>document.getElementById("parentMessage").textContent=v;
 document.getElementById("parentDismiss").onclick=()=>parentBox.classList.add("hidden");
 async function display(){
  parentBox.classList.remove("hidden");const actions=document.getElementById("parentActions");actions.innerHTML="";
  if(!user){actions.innerHTML='<p>Already have a Theoria account? Sign in using the form behind this window, then return here.</p><button class="primary-btn" id="parentCreate">Create parent account</button><button class="secondary-btn" id="parentSignin">Sign in</button>';
   document.getElementById("parentSignin").onclick=()=>{parentBox.classList.add("hidden");document.querySelector('[data-auth-tab="signin"]')?.click();};
   document.getElementById("parentCreate").onclick=()=>createParent(actions);return;
  }
  const ref=doc(db,"institutions",institutionId,"guardianLinks",invitationId);
  if(!user.emailVerified){actions.innerHTML='<p>Verify your email address to view the invitation.</p><button class="secondary-btn" id="sendVerification">Send verification email</button><button class="primary-btn" id="checkVerification">I verified my email</button>';document.getElementById("sendVerification").onclick=async()=>{try{await sendEmailVerification(user);message("Verification email sent.");}catch(err){message(err.message);}};document.getElementById("checkVerification").onclick=async()=>{try{await reload(user);await user.getIdToken(true);if(!user.emailVerified)return message("Email is not verified yet.");await display();}catch(err){message(err.message);}};return;}
  try{
   const snap=await getDoc(ref);
   if(!snap.exists()){message("Invitation not found, or it is intended for another email address.");return;}
   const data=snap.data();
   document.getElementById("parentDetails").textContent="Invitation to connect with "+(data.studentName||"a student")+" at this institution.";
   if(data.status==="pending_verification"){
    actions.innerHTML='<p>Your email is verified. Claim this invitation for school review.</p><button class="primary-btn" id="claimParentInvitation">Request parent access</button>';document.getElementById("claimParentInvitation").onclick=async()=>{try{await updateDoc(ref,{status:"awaiting_school_approval",guardianUid:user.uid,claimedAt:serverTimestamp()});await display();}catch(error){message(error.message);}};return;
   }
   actions.innerHTML='<p>'+escape(data.status==="awaiting_school_approval"?"Your account is linked to the invitation. The school must approve family access.":data.status==="approved"?"Your parent portal access has been approved.":"This invitation is no longer available.")+'</p>';
  }catch(error){message("Unable to open invitation: "+error.message);}
 }
 function createParent(actions){
  actions.innerHTML='<form id="parentSignup" class="institution-form"><label>Full name<input name="name" maxlength="100" required></label><label>Email address<input name="email" type="email" required></label><label>Password (at least 8 characters)<input name="password" type="password" minlength="8" required></label><button class="primary-btn" type="submit">Create parent account</button></form>';
  document.getElementById("parentSignup").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,details=new FormData(form),btn=form.querySelector("button");btn.disabled=true;try{const result=await createUserWithEmailAndPassword(auth,String(details.get("email")).trim(),String(details.get("password")));await updateProfile(result.user,{displayName:String(details.get("name")).trim()});await setDoc(doc(db,"users",result.user.uid),{displayName:String(details.get("name")).trim(),email:result.user.email,role:"parent",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});await sendEmailVerification(result.user);user=result.user;await display();message("Account created. Check your email for a verification link.");}catch(error){message("Unable to create parent account: "+error.message);}finally{btn.disabled=false;}};
 }
 onAuthStateChanged(auth,async next=>{user=next;if(next){await display();}else{parentBox.classList.remove("hidden");await display();}});
}
