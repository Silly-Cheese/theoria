import {auth,db,onAuthStateChanged,doc,getDoc} from "./firebase.js";
const $=s=>document.querySelector(s);
onAuthStateChanged(auth,async user=>{
 if(!user)return;
 try{
  const profile=await getDoc(doc(db,"users",user.uid));
  if(!profile.exists())return;
  const role=profile.data().role;
  if(role==="parent"&&!new URLSearchParams(location.search).has("parentInvite")){
   const url=new URL("./parents.html",location.href);
   location.replace(url.href);
   return;
  }
  if(role==="student"){
   document.querySelectorAll(".instructor-only").forEach(el=>el.classList.add("hidden"));
   const subtitle=$("#welcomeSubtitle");
   if(subtitle)subtitle.textContent="Your courses, school enrollment, academic progress, and upcoming work.";
  }else if(role==="instructor"){
   const subtitle=$("#welcomeSubtitle");
   if(subtitle)subtitle.textContent="Manage your teaching, academic catalog, sections, and institutional responsibilities.";
  }
 }catch(e){console.warn("Role-specific navigation could not be applied",e);}
});
