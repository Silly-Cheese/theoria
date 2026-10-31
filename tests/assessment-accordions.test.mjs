import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseHTML} from "linkedom";
import {
  preferenceKey,readCoursePreferences,courseExpanded,courseAccordionMarkup,
  courseNavigationToolbar,wireCourseNavigation
} from "../modules/assessment-accordions.js";

function store(){
  const map=new Map();
  return {getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),map};
}
function fixture(storage=store(),uid="instructor-1",role="instructor"){
  const {document}=parseHTML('<html><body><div id="assessmentsContent"></div></body></html>');
  const root=document.getElementById("assessmentsContent");
  const preferences=readCoursePreferences(storage,uid,role);
  const escapeHTML=value=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const courses=[{id:"apol-01",title:"APOL 01 — Advanced Christian Apologetics",count:11},
    {id:"theo-02",title:"THEO 02 — Systematic Theology II",count:8},
    {id:"bibl-01",title:"BIBL 01 — Hermeneutics",count:4}];
  root.innerHTML=courseNavigationToolbar(courses.length,"",escapeHTML)+courses.map((c,i)=>
    courseAccordionMarkup({
      key:c.id,title:c.title,description:"Course assessments",count:c.count,
      body:'<button class="primary-btn" data-phase3-action="open-assessment" data-id="'+c.id+'">Open Builder</button>',
      expanded:courseExpanded(preferences,c.id,i),escapeHTML
    })
  ).join("");
  wireCourseNavigation(root,{uid,role,storage});
  return {root,document,courses,storage,uid,role};
}
test("first course is expanded by default; remaining courses are collapsed",()=>{
  const f=fixture();
  const courses=[...f.root.querySelectorAll("[data-assessment-course]")];
  assert.equal(courses.length,3);
  assert.equal(courses[0].hasAttribute("open"),true);
  assert.equal(courses[1].hasAttribute("open"),false);
  assert.equal(courses[2].hasAttribute("open"),false);
  assert.equal(courses[0].querySelector(".assessment-course-count").textContent,"11 assessments");
  assert.ok(courses[0].querySelector('[data-phase3-action="open-assessment"]'));
});
test("Expand All and Collapse All persist independently for every course",()=>{
  const f=fixture();
  f.root.querySelector('[data-assessment-course-control="expand"]').click();
  assert.ok([...f.root.querySelectorAll("details")].every(d=>d.hasAttribute("open")));
  let prefs=readCoursePreferences(f.storage,f.uid,f.role);
  assert.equal(prefs["bibl-01"],true);
  f.root.querySelector('[data-assessment-course-control="collapse"]').click();
  assert.ok([...f.root.querySelectorAll("details")].every(d=>!d.hasAttribute("open")));
  prefs=readCoursePreferences(f.storage,f.uid,f.role);
  assert.equal(prefs["theo-02"],false);
  const rerender=fixture(f.storage,f.uid,f.role);
  assert.ok([...rerender.root.querySelectorAll("details")].every(d=>!d.hasAttribute("open")));
});
test("course expansion preferences remain separate per signed-in user and role",()=>{
  const storage=store();
  const first=fixture(storage,"teacher-a","instructor");
  first.root.querySelector('[data-assessment-course-control="collapse"]').click();
  assert.equal(courseExpanded(readCoursePreferences(storage,"teacher-a","instructor"),"apol-01",0),false);
  assert.equal(courseExpanded(readCoursePreferences(storage,"teacher-b","instructor"),"apol-01",0),true);
  assert.equal(courseExpanded(readCoursePreferences(storage,"teacher-a","student"),"apol-01",0),true);
  assert.notEqual(preferenceKey("teacher-a","instructor"),preferenceKey("teacher-a","student"));
});
test("search filters only course headings; assessment cards remain in the DOM",()=>{
  const f=fixture();
  const input=f.root.querySelector("#assessmentCourseSearch");
  input.value="systematic";
  input.dispatchEvent(new f.document.defaultView.Event("input",{bubbles:true}));
  const visible=[...f.root.querySelectorAll("details")].filter(d=>!d.hidden);
  assert.equal(visible.length,1);
  assert.equal(visible[0].dataset.assessmentCourse,"theo-02");
  assert.equal(f.root.querySelectorAll('[data-phase3-action="open-assessment"]').length,3);
  assert.match(f.root.querySelector("#assessmentCourseStatus").textContent,/1 of 3/);
  input.value="not-a-course";
  input.dispatchEvent(new f.document.defaultView.Event("input",{bubbles:true}));
  assert.ok(f.root.querySelector("#assessmentCourseEmpty"));
});
test("rendered headings are escaped, and storage failures do not crash navigation",()=>{
  const escapeHTML=value=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
  const markup=courseAccordionMarkup({key:"test",title:'<img src=x onerror=alert(1)>',body:"",count:2,expanded:false,escapeHTML});
  assert.ok(!markup.includes('<img src=x onerror=alert(1)>'));
  const broken={getItem:()=>{throw new Error("disabled");},setItem:()=>{throw new Error("disabled");}};
  const f=fixture(broken);
  f.root.querySelector('[data-assessment-course-control="collapse"]').click();
  assert.equal(f.root.querySelectorAll("details").length,3);
});
test("instructor and student Assessments pages share the course accordion",()=>{
  const code=readFileSync(new URL("../phase3.js",import.meta.url),"utf8");
  assert.ok(code.includes("courseAccordionMarkup({"));
  assert.ok(code.includes("wireCourseNavigation(el,{uid:userId,role:s.role,storage});"));
  assert.ok(code.includes("previousSearch"));
  assert.ok(code.includes("data-phase3-action=\"batch-assign-course\""));
  assert.ok(code.includes("data-phase3-action=\"student-assessment-details\""));
});
