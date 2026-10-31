import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mapConcurrent} from "../modules/performance.js";

test("bounded requests resolve in original input order",async()=>{
  let active=0,peak=0;
  const data=Array.from({length:24},(_,i)=>i);
  const result=await mapConcurrent(data,5,async v=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,3+(v%5)));
    active--;return v*2;
  });
  assert.deepEqual(result,data.map(x=>x*2));
  assert.ok(peak>1,"Requests should run concurrently");
  assert.ok(peak<=5,"Never exceed concurrency bound");
});

test("handles empty inputs, a single request, and propagates errors",async()=>{
  assert.deepEqual(await mapConcurrent([],6,async x=>x),[]);
  assert.deepEqual(await mapConcurrent(["course"],6,async x=>x),["course"]);
  await assert.rejects(mapConcurrent([1,2,3],2,async v=>{
    if(v===2)throw new Error("firestore failure");return v;
  }),/firestore failure/);
});

test("critical UI data loads no longer await every document serially",()=>{
  // Concrete regression targets for the Firestore loading paths.
  const source=readFileSync(new URL("../app.js",import.meta.url),"utf8");
  assert.ok(source.includes("mapConcurrent(staffSectionSnap.docs,6"));
  assert.ok(source.includes("mapConcurrent(active,6"));
  assert.ok(source.includes("mapConcurrent(unitsSnap.docs,6"));
  assert.ok(source.includes("mapConcurrent(assignments,6"));
  assert.ok(source.includes("Promise.all([\n    getDoc(doc(db,\"courses\",section.courseId))"));
});

test("costly academic notification sweep is only scheduled on Communications",()=>{
  const code=readFileSync(new URL("../phase6.js",import.meta.url),"utf8");
  assert.ok(code.includes('if(!document.querySelector("#page-communications.active"))return;'));
  assert.ok(code.includes('if(e.detail?.page==="communications")scheduleAcademicWorkflowChecks();'));
  assert.equal(code.includes("await runAcademicWorkflowChecks();"),false);
});

test("Question Bank, assessments, planner and progression use bounded parallel reads",()=>{
  const phase3=readFileSync(new URL("../phase3.js",import.meta.url),"utf8");
  const phase5=readFileSync(new URL("../phase5.js",import.meta.url),"utf8");
  const productivity=readFileSync(new URL("../modules/productivity.js",import.meta.url),"utf8");
  assert.ok(phase3.includes("mapConcurrent(s.courses,6"));
  assert.ok(phase3.includes("mapConcurrent(s.courses,3"));
  assert.ok(phase3.includes("mapConcurrent(P3.assessments,5"));
  assert.ok(phase5.includes("mapConcurrent([...sectionsById.values()],6"));
  assert.ok(phase5.includes("mapConcurrent((s.courses||[]).filter"));
  assert.ok(productivity.includes("mapConcurrent((s.sections||[]).filter"));
});
