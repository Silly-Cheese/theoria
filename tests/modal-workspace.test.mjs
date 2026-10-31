import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseHTML} from "linkedom";
import {createAcademicModal,clearAcademicModal} from "../modules/ui-modal.js";

function setup(){
  const {document}=parseHTML('<html><body><main></main><div id="modalRoot"></div></body></html>');
  return {document,host:document.getElementById("modalRoot")};
}

test("progression dialog retains form, requirement list and add button",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{
    title:"Prerequisites — BIBL 01",wide:true,
    body:'<form id="prerequisiteForm"><div id="competencyReqRows"></div><button type="button" id="addCompetencyReq">Add requirement</button></form>'
  });
  assert.equal(dialog.classList.contains("wide"),true);
  assert.ok(dialog.querySelector("#prerequisiteForm"));
  assert.ok(dialog.querySelector("#competencyReqRows"));
  assert.ok(dialog.querySelector("#addCompetencyReq"));
  assert.equal(host.querySelectorAll(".modal").length,1);
});

test("all dialog shells exist even when provided content has mismatched closing tags",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{
    title:"Student Academic Record",
    body:'<form id="recordForm"><input name="name"></div></form></div></div>'
  });
  assert.ok(dialog);
  assert.equal(dialog.className,"modal");
  assert.ok(host.contains(dialog));
  assert.ok(dialog.querySelector(".modal-close"));
  assert.ok(dialog.querySelector(".modal-head"));
});

test("opening multiple dialogs replaces old content without losing modal host",()=>{
  const {host}=setup();
  createAcademicModal(host,{title:"First",body:'<form id="first"></form>'});
  const dialog=createAcademicModal(host,{title:"Second",body:'<form id="second"></form>',footer:'<button id="save">Save</button>'});
  assert.equal(host.querySelector("#first"),null);
  assert.ok(dialog.querySelector("#second"));
  assert.ok(dialog.querySelector("#save"));
  clearAcademicModal(host);
  assert.equal(host.childElementCount,0);
});

test("user-provided title is rendered as text, never executed as HTML",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{title:'<img src=x onerror=alert(1)>',eyebrow:'<script>alert(2)</script>'});
  assert.equal(dialog.querySelector("h2").textContent,'<img src=x onerror=alert(1)>');
  assert.equal(dialog.querySelector("img"),null);
  assert.equal(dialog.querySelector("script"),null);
});

test("missing modal host fails with actionable error",()=>{
  assert.throws(()=>createAcademicModal(null,{title:"Test"}),/modal host/);
});

test("the real Manage Prerequisites action mounts and wires its editable form",async()=>{
  const {document,host}=setup();
  const source=readFileSync(new URL("../phase5.js",import.meta.url),"utf8");
  const start=source.indexOf("async function prerequisiteModal(");
  const end=source.indexOf("\nasync function evaluateEnrollmentEligibility",start);
  assert.ok(start>=0&&end>start,"Expected progression editor source function");
  const {runInNewContext}=await import("node:vm");
  const course={id:"course-a",code:"BIBL 01",title:"Hermeneutics",
    prerequisitePolicy:{competencyRequirements:[{code:"EXE-01",minPercent:80}]}};
  const next={id:"course-b",code:"BIBL 02",title:"Old Testament Survey"};
  const opened=[];
  const context={
    state:()=>({isSystemOwner:true,courses:[course,next]}),
    courseById:id=>id==="course-a"?course:null,
    core:()=>({canManageCourse:()=>true}),
    safeArray:v=>Array.isArray(v)?v:[],
    esc:v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"),
    modal:args=>{const el=createAcademicModal(host,args);opened.push(el);return el},
    document,
    closeModal:()=>clearAcademicModal(host),
    toast:()=>{throw new Error("Progression action unexpectedly displayed error message");}
  };
  const action=runInNewContext("("+source.slice(start,end)+")",context);
  await action("course-a");
  assert.equal(opened.length,1);
  assert.ok(host.querySelector("#prerequisiteForm"));
  assert.equal(host.querySelectorAll(".progression-competency-row").length,1);
  const add=host.querySelector("#addCompetencyReq");
  assert.equal(typeof add.onclick,"function");
  add.onclick();
  assert.equal(host.querySelectorAll(".progression-competency-row").length,2);
});

test("prerequisite submission saves and audits even after event.currentTarget becomes null",async()=>{
  const {document,host}=setup();
  const source=readFileSync(new URL("../phase5.js",import.meta.url),"utf8");
  const start=source.indexOf("async function prerequisiteModal(");
  const end=source.indexOf("\\nasync function evaluateEnrollmentEligibility",start);
  assert.ok(start>=0&&end>start);
  const {runInNewContext}=await import("node:vm");
  const course={id:"course-a",code:"BIBL 01",title:"Hermeneutics",prerequisitePolicy:{}};
  const next={id:"course-b",code:"BIBL 02",title:"Old Testament Survey"};
  let submitted=null,saved=null,audit=null,rendered=false,success=false;
  class MockFormData{
    constructor(form){this.form=form;}
    get(name){
      const el=this.form.querySelector('[name="'+name+'"]');
      return !el?null:el.type==="checkbox"?(el.checked?(el.value||"on"):null):el.value;
    }
    getAll(name){
      return [...this.form.querySelectorAll('[name="'+name+'"]')]
        .filter(el=>!["checkbox","radio"].includes(el.type)||el.checked).map(el=>el.value);
    }
  }
  const env={
    state:()=>({isSystemOwner:true,courses:[course,next]}),
    courseById:id=>id==="course-a"?course:null,
    core:()=>({canManageCourse:()=>true}),
    safeArray:v=>Array.isArray(v)?v:[],
    esc:v=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"),
    modal:args=>createAcademicModal(host,args), document,
    closeModal:()=>clearAcademicModal(host),
    toast:message=>{if(message!=="Course progression policy saved.")throw new Error(message);success=true;},
    FormData:MockFormData,
    doc:(...args)=>args.join("/"),db:{},serverTimestamp:()=>({serverTime:true}),
    updateDoc:async(path,body)=>{saved=body;submitted.currentTarget=null;},
    logCourseEvent:async(...args)=>{audit=args;},
    renderProgression:()=>{rendered=true;}
  };
  const open=runInNewContext("("+source.slice(start,end)+")",env);
  await open("course-a");
  const form=host.querySelector("#prerequisiteForm");
  assert.ok(form);
  form.querySelector('[name="requiredCourse"]').checked=true;
  form.querySelector('[name="instructorApproval"]').checked=true;
  form.querySelector('[name="entranceExamRequired"]').checked=true;
  submitted={currentTarget:form,preventDefault(){}};
  await form.onsubmit(submitted);
  assert.equal(saved?.prerequisitePolicy?.requiredCourseIds[0],"course-b");
  assert.equal(saved?.prerequisitePolicy?.instructorApproval,true);
  assert.equal(saved?.entranceExamRequired,true);
  assert.equal(course.entranceExamRequired,true,"Local course state must update after the await");
  assert.ok(audit,"The course change must be audited after the await");
  assert.equal(audit[1],"progression_policy_updated");
  assert.equal(success,true);
  assert.equal(rendered,true);
});
