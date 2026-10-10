import {readFileSync} from "node:fs";
import {before,after,test} from "node:test";
import {initializeTestEnvironment,assertFails,assertSucceeds} from "@firebase/rules-unit-testing";
import {doc,getDoc,setDoc} from "firebase/firestore";

let env;
before(async()=>{
 env=await initializeTestEnvironment({
   projectId:"demo-theoria",
   firestore:{rules:readFileSync(new URL("../firestore.rules",import.meta.url),"utf8")}
 });
 await env.clearFirestore();
});
after(async()=>{await env?.cleanup();});
test("students cannot create institutions",async()=>{
 const ctx=env.authenticatedContext("student1",{email:"student@example.test"});
 await env.withSecurityRulesDisabled(async admin=>{
   await setDoc(doc(admin.firestore(),"users","student1"),{role:"student",displayName:"Student"});
 });
 await assertFails(setDoc(doc(ctx.firestore(),"institutions","unauthorized"),{
   name:"Fake School",kind:"school",description:"",parentDistrictId:"",ownerUid:"student1",
   status:"active",verified:false,createdAt:new Date()
 }));
});
test("unrelated parents cannot read a student academic record",async()=>{
 await env.withSecurityRulesDisabled(async admin=>{
   const db=admin.firestore();
   await setDoc(doc(db,"institutions","school-a"),{name:"School A",kind:"school",status:"active",ownerUid:"owner-a"});
   await setDoc(doc(db,"institutions","school-a","studentRecords","record-a"),{
     studentUid:"learner-a",studentName:"Student",courseTitle:"Course",credits:1,
     finalGrade:"A",status:"certified",recordedBy:"owner-a"
   });
 });
 const unrelated=env.authenticatedContext("other-parent",{email:"other@parent.test"});
 await assertFails(getDoc(doc(unrelated.firestore(),"institutions","school-a","studentRecords","record-a")));
 const learner=env.authenticatedContext("learner-a",{email:"student@test.example"});
 await assertSucceeds(getDoc(doc(learner.firestore(),"institutions","school-a","studentRecords","record-a")));
});
test("an approved guardian grant is limited to a matching student",async()=>{
 await env.withSecurityRulesDisabled(async admin=>{
   const db=admin.firestore();
   await setDoc(doc(db,"institutions","school-a","guardianAccess","guardian-a_learner-a"),{
      guardianUid:"guardian-a",studentUid:"learner-a",studentName:"Student",inviteId:"invite-a"
   });
   await setDoc(doc(db,"institutions","school-a","studentRecords","record-b"),{
      studentUid:"learner-b",studentName:"Other",courseTitle:"Course",credits:1,
      finalGrade:"B",status:"certified",recordedBy:"owner-a"
   });
 });
 const guardian=env.authenticatedContext("guardian-a",{email:"parent@test.example"});
 await assertSucceeds(getDoc(doc(guardian.firestore(),"institutions","school-a","studentRecords","record-a")));
 await assertFails(getDoc(doc(guardian.firestore(),"institutions","school-a","studentRecords","record-b")));
});
