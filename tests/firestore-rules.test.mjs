import {readFileSync} from "node:fs";
import {before,after,test} from "node:test";
import {initializeTestEnvironment,assertFails,assertSucceeds} from "@firebase/rules-unit-testing";
import {doc,getDoc,setDoc,deleteDoc,updateDoc} from "firebase/firestore";

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

test("approved guardian requires a matching approved invitation and can be revoked",async()=>{
  await env.withSecurityRulesDisabled(async admin=>{
    const db=admin.firestore();
    await setDoc(doc(db,"institutions","school-a","guardianLinks","invite-a"),{
      guardianUid:"guardian-a",studentUid:"learner-a",guardianEmail:"parent@test.example",status:"approved"
    });
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
  await env.withSecurityRulesDisabled(async admin=>{
    await updateDoc(doc(admin.firestore(),"institutions","school-a","guardianLinks","invite-a"),{status:"revoked"});
  });
  await assertFails(getDoc(doc(guardian.firestore(),"institutions","school-a","studentRecords","record-a")));
});

test("completed exam results remain private until explicitly released",async()=>{
  await env.withSecurityRulesDisabled(async admin=>{
    const db=admin.firestore();
    await setDoc(doc(db,"assessments","exam-a"),{ownerId:"instructor-a",sectionId:""});
    await setDoc(doc(db,"assessments","exam-a","results","learner-a"),{
      studentId:"learner-a",complete:true,released:false,percent:95
    });
  });
  const student=env.authenticatedContext("learner-a");
  const teacher=env.authenticatedContext("instructor-a");
  const outsider=env.authenticatedContext("learner-b");
  const resultPath=["assessments","exam-a","results","learner-a"];
  await assertSucceeds(getDoc(doc(teacher.firestore(),...resultPath)));
  await assertFails(getDoc(doc(student.firestore(),...resultPath)));
  await env.withSecurityRulesDisabled(async admin=>{
    await updateDoc(doc(admin.firestore(),...resultPath),{released:true});
  });
  await assertSucceeds(getDoc(doc(student.firestore(),...resultPath)));
  await assertFails(getDoc(doc(outsider.firestore(),...resultPath)));
});

test("students cannot read unreleased assessment-grade summaries",async()=>{
  await env.withSecurityRulesDisabled(async admin=>{
    const db=admin.firestore();
    await setDoc(doc(db,"sections","section-a"),{ownerId:"instructor-a"});
    await setDoc(doc(db,"sections","section-a","members","learner-a"),{userId:"learner-a",role:"student"});
    await setDoc(doc(db,"sections","section-a","assessmentGrades","grade-a"),{
      studentId:"learner-a",assessmentId:"exam-a",percent:95,released:false
    });
  });
  const student=env.authenticatedContext("learner-a");
  const teacher=env.authenticatedContext("instructor-a");
  const path=["sections","section-a","assessmentGrades","grade-a"];
  await assertFails(getDoc(doc(student.firestore(),...path)));
  await assertSucceeds(getDoc(doc(teacher.firestore(),...path)));
  await env.withSecurityRulesDisabled(async admin=>{await updateDoc(doc(admin.firestore(),...path),{released:true});});
  await assertSucceeds(getDoc(doc(student.firestore(),...path)));
});

test("certified records and amendment history cannot be deleted by instructors",async()=>{
  await env.withSecurityRulesDisabled(async admin=>{
    const db=admin.firestore();
    await setDoc(doc(db,"sections","section-history"),{ownerId:"instructor-a"});
    await setDoc(doc(db,"sections","section-history","academicRecords","learner-a"),{status:"Certified",studentId:"learner-a",version:1});
    await setDoc(doc(db,"sections","section-history","recordHistory","event-a"),{studentId:"learner-a",version:1,action:"Certification"});
  });
  const teacher=env.authenticatedContext("instructor-a");
  await assertFails(deleteDoc(doc(teacher.firestore(),"sections","section-history","academicRecords","learner-a")));
  await assertFails(deleteDoc(doc(teacher.firestore(),"sections","section-history","recordHistory","event-a")));
});
