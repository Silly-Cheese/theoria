import {
  db, doc, getDoc, setDoc, addDoc, updateDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp, Timestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();
const p5=()=>window.TheoriaPhase5;

async function docs(path){try{const s=await getDocs(collection(db,...path));return s.docs.map(d=>({id:d.id,...d.data()}));}catch(_){return [];}}
function safe(v){return Array.isArray(v)?v:[];}
function serialize(value){
  if(value===null||value===undefined)return value;
  if(value?.toDate)return value.toDate().toISOString();
  if(Array.isArray(value))return value.map(serialize);
  if(typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,serialize(v)]));
  return value;
}
function download(filename,text,type="application/json"){
  const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function randomCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="THR-";for(let i=0;i<5;i++)out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}
async function uniqueJoinCode(){
  for(let i=0;i<20;i++){const code=randomCode(),snap=await getDoc(doc(db,"joinCodes",code));if(!snap.exists())return code;}
  return "THR-"+Date.now().toString(36).slice(-5).toUpperCase();
}

/* -------------------- SYSTEM OWNER CONTROL CENTER -------------------- */

async function systemMetrics(){
  const [courses,sections,assessments,users]=await Promise.all([
    docs(["courses"]),docs(["sections"]),docs(["assessments"]),docs(["users"])
  ]);
  let questionCount=0,unitCount=0,competencyCount=0;
  for(const course of courses){
    const [items,units,competencies]=await Promise.all([
      docs(["courses",course.id,"items"]),docs(["courses",course.id,"units"]),docs(["courses",course.id,"competencies"])
    ]);
    questionCount+=items.length;unitCount+=units.length;competencyCount+=competencies.length;
  }
  return {courses,sections,assessments,users,questionCount,unitCount,competencyCount};
}

async function renderAdminCenter(){
  const el=$("#adminCenterContent"),s=state();if(!el)return;
  if(!s?.isSystemOwner){el.innerHTML='<div class="empty-state"><div class="empty-symbol">Θ</div><h3>System Owner access required.</h3><p>This workspace manages the shared Theoria platform.</p></div>';return;}
  el.innerHTML='<div class="empty-mini">Loading system control center…</div>';
  const m=await systemMetrics(),configSnap=await getDoc(doc(db,"system","platform")).catch(()=>null),config=configSnap?.exists?.()?configSnap.data():{};
  const activeSections=m.sections.filter(x=>x.status!=="Archived"),publishedCourses=m.courses.filter(x=>x.catalogPublished===true);
  el.innerHTML='<div class="academic-banner"><div class="kicker">System Owner Control Center</div><h3>Theoria Platform Administration</h3><p>Catalog health, data integrity, feature controls, diagnostics, migration tools, and academic-package management.</p></div>'+
    '<div class="admin-metric-grid"><div><span>Catalog Courses</span><strong>'+m.courses.length+'</strong><small>'+publishedCourses.length+' published</small></div><div><span>Teaching Sections</span><strong>'+m.sections.length+'</strong><small>'+activeSections.length+' active</small></div><div><span>Users</span><strong>'+m.users.length+'</strong><small>'+m.users.filter(x=>x.role==="instructor").length+' instructors</small></div><div><span>Assessments</span><strong>'+m.assessments.length+'</strong><small>'+m.assessments.filter(x=>x.sectionId).length+' assigned</small></div><div><span>Question Bank</span><strong>'+m.questionCount+'</strong><small>master questions</small></div><div><span>Framework Units</span><strong>'+m.unitCount+'</strong><small>'+m.competencyCount+' competencies</small></div></div>'+
    '<div class="operations-grid admin-operations"><button class="operation-card" data-admin-action="integrity-scan"><span>01</span><strong>Data Integrity Scanner</strong><small>Find orphaned references, legacy records, and incomplete mappings.</small></button><button class="operation-card" data-admin-action="diagnostics"><span>02</span><strong>System Health & Diagnostics</strong><small>Verify essential Firestore reads and subsystem availability.</small></button><button class="operation-card" data-admin-action="feature-flags"><span>03</span><strong>Feature Flags</strong><small>Control major platform systems without removing code.</small></button><button class="operation-card" data-admin-action="migration-tools"><span>04</span><strong>Migration Tools</strong><small>Normalize legacy questions, assignments, and sections.</small></button><button class="operation-card" data-admin-action="import-export"><span>05</span><strong>Import / Export Center</strong><small>Course packages, catalog backup, grade and roster exports.</small></button><button class="operation-card" data-admin-action="system-announcement"><span>06</span><strong>System Announcement</strong><small>Publish platform-wide academic or maintenance notices.</small></button></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Platform Configuration</div><div class="panel-subtitle">Current administrative configuration snapshot.</div></div></div><div class="panel-body"><div class="detail-list"><div><span>Configuration Version</span><strong>'+esc(config.version||1)+'</strong></div><div><span>Last Migration</span><strong>'+esc(config.lastMigrationLabel||"Not recorded")+'</strong></div><div><span>Maintenance Mode</span><strong>'+(config.features?.maintenanceMode?"Enabled":"Disabled")+'</strong></div></div></div></div>';
}

async function integrityScan(){
  const m=await systemMetrics(),courseIds=new Set(m.courses.map(x=>x.id)),sectionIds=new Set(m.sections.map(x=>x.id)),findings=[];
  m.sections.forEach(sec=>{
    if(!courseIds.has(sec.courseId))findings.push({severity:"High",area:"Section",message:(sec.sectionName||sec.id)+" references a missing course.",id:sec.id});
    if(!sec.status)findings.push({severity:"Low",area:"Section",message:(sec.sectionName||sec.id)+" has no explicit lifecycle status.",id:sec.id});
    if(!sec.joinCode&&sec.status!=="Archived")findings.push({severity:"Medium",area:"Section",message:(sec.sectionName||sec.id)+" has no join code.",id:sec.id});
  });
  m.assessments.forEach(a=>{
    if(a.courseId&&!courseIds.has(a.courseId))findings.push({severity:"High",area:"Assessment",message:(a.title||a.id)+" references a missing course.",id:a.id});
    if(a.sectionId&&!sectionIds.has(a.sectionId))findings.push({severity:"High",area:"Assessment",message:(a.title||a.id)+" references a missing section.",id:a.id});
    if(a.competencyBlueprintAuto===true&&Number(a.competencyBlueprintUnmappedPoints||0)>0)findings.push({severity:"Medium",area:"Assessment",message:(a.title||a.id)+" has unmapped competency evidence.",id:a.id});
  });
  for(const course of m.courses){
    const [items,units]=await Promise.all([docs(["courses",course.id,"items"]),docs(["courses",course.id,"units"])]);
    const unitIds=new Set(units.map(x=>x.id));
    items.forEach(item=>{
      if(item.unitId&&!unitIds.has(item.unitId))findings.push({severity:"Medium",area:"Question Bank",message:(course.code||"Course")+" question references a missing unit.",id:item.id});
      if(!item.version)findings.push({severity:"Low",area:"Question Bank",message:(course.code||"Course")+" question is missing version metadata.",id:item.id});
      if(!item.qualityStatus)findings.push({severity:"Low",area:"Question Bank",message:(course.code||"Course")+" question has not entered the quality workflow.",id:item.id});
    });
  }
  const mModal=modal({
    eyebrow:"Data Integrity Scanner",
    title:"Scan Results",
    wide:true,
    body:'<div class="section-summary"><div class="summary-block"><div class="summary-label">Findings</div><div class="summary-value">'+findings.length+'</div></div><div class="summary-block"><div class="summary-label">High</div><div class="summary-value">'+findings.filter(x=>x.severity==="High").length+'</div></div><div class="summary-block"><div class="summary-label">Medium</div><div class="summary-value">'+findings.filter(x=>x.severity==="Medium").length+'</div></div><div class="summary-block"><div class="summary-label">Low</div><div class="summary-value">'+findings.filter(x=>x.severity==="Low").length+'</div></div></div>'+
      (findings.length?'<div class="integrity-findings">'+findings.map(f=>'<div class="integrity-row '+f.severity.toLowerCase()+'"><span>'+esc(f.severity)+'</span><div><strong>'+esc(f.area)+'</strong><p>'+esc(f.message)+'</p></div></div>').join("")+'</div>':'<div class="notice"><strong>No integrity issues detected by the current scanner.</strong><p>The scanner checked catalog references, section links, assessment links, Question Bank versions, and competency mapping indicators.</p></div>'),
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

async function diagnostics(){
  const checks=[];
  async function check(name,fn){
    const start=performance.now();try{const detail=await fn();checks.push({name,ok:true,ms:Math.round(performance.now()-start),detail});}catch(error){checks.push({name,ok:false,ms:Math.round(performance.now()-start),detail:error.message||"Failed"});}
  }
  await check("System owner record",async()=>{const s=await getDoc(doc(db,"system","owner"));return s.exists()?"Readable":"Missing";});
  await check("Course catalog",async()=>{const s=await getDocs(collection(db,"courses"));return s.size+" documents";});
  await check("Teaching sections",async()=>{const s=await getDocs(collection(db,"sections"));return s.size+" documents";});
  await check("Assessments",async()=>{const s=await getDocs(collection(db,"assessments"));return s.size+" documents";});
  await check("User directory",async()=>{const s=await getDocs(collection(db,"directory"));return s.size+" entries";});
  await check("System configuration write",async()=>{await setDoc(doc(db,"system","platform"),{lastCheckAt:serverTimestamp(),lastCheckBy:state().user.uid},{merge:true});return "Writable";});
  modal({
    eyebrow:"System Health",
    title:"Diagnostics",
    wide:true,
    body:'<div class="diagnostic-list">'+checks.map(c=>'<div class="diagnostic-row '+(c.ok?"ok":"fail")+'"><span>'+(c.ok?"✓":"!")+'</span><div><strong>'+esc(c.name)+'</strong><small>'+esc(c.detail)+' • '+c.ms+'ms</small></div></div>').join("")+'</div><div class="notice" style="margin-top:14px">Client diagnostics verify the application’s current authenticated access. They cannot prove whether a newer Firestore rules file in GitHub has already been deployed to Firebase.</div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

const FLAG_DEFS=[
  ["planner","Planner & Academic Calendar"],
  ["communications","Announcements & Notifications"],
  ["rubrics","Advanced Rubric Grading"],
  ["assessmentSecurity","Assessment Security Center"],
  ["attendance","Attendance"],
  ["studentGroups","Student Groups"],
  ["courseProgression","Course Progression"],
  ["analytics","Academic Intelligence"],
  ["questionQuality","Question Bank Quality Workflow"],
  ["maintenanceMode","Maintenance Mode"]
];
async function featureFlags(){
  const snap=await getDoc(doc(db,"system","platform")),config=snap.exists()?snap.data():{},features=config.features||{};
  const m=modal({
    eyebrow:"Platform Configuration",
    title:"Feature Flags",
    wide:true,
    body:'<form id="featureFlagForm"><div class="notice">Feature flags let the System Owner hide or stage major systems without deleting data or code.</div><div class="policy-grid" style="margin-top:14px">'+FLAG_DEFS.map(([id,label])=>'<label class="policy-card"><input type="checkbox" name="'+id+'" '+(features[id]!==false&&id!=="maintenanceMode"||features[id]===true&&id==="maintenanceMode"?'checked':'')+'><div><strong>'+esc(label)+'</strong><span>'+esc(id==="maintenanceMode"?"Use only during planned administrative work.":"Enabled by default unless explicitly disabled.")+'</span></div></label>').join("")+'</div><div class="modal-foot"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Feature Flags</button></div></form>'
  });
  m.querySelector("#featureFlagForm").onsubmit=async e=>{
    e.preventDefault();const featuresOut={};FLAG_DEFS.forEach(([id])=>featuresOut[id]=e.currentTarget.elements[id].checked);
    try{await setDoc(doc(db,"system","platform"),{features:featuresOut,version:Number(config.version||1)+1,updatedAt:serverTimestamp(),updatedBy:state().user.uid},{merge:true});closeModal();toast("Feature flags saved. Reload Theoria to apply all visibility changes.");}catch(error){toast(error.message||"Unable to save feature flags.");}
  };
}

async function migrationTools(){
  const m=modal({
    eyebrow:"Data Migration",
    title:"Legacy Normalization",
    body:'<div class="academic-banner"><div class="kicker">Safe Migration Tools</div><h3>Normalize legacy Theoria records.</h3><p>This migration fills missing metadata without deleting academic evidence.</p></div><div class="detail-list"><div><span>Question Bank</span><strong>version + qualityStatus</strong></div><div><span>Assignments</span><strong>gradingPeriod</strong></div><div><span>Sections</span><strong>status + lifecycle metadata</strong></div></div><div class="modal-foot"><button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="runSafeMigration">Run Safe Migration</button></div>'
  });
  m.querySelector("#runSafeMigration").onclick=async()=>{
    const button=m.querySelector("#runSafeMigration");button.disabled=true;button.textContent="Migrating…";let changed=0;
    try{
      const courses=await docs(["courses"]);
      for(const course of courses){
        const items=await docs(["courses",course.id,"items"]);
        for(let i=0;i<items.length;i+=350){
          const batch=writeBatch(db);
          items.slice(i,i+350).forEach(item=>{const patch={};if(!item.version)patch.version=1;if(!item.qualityStatus)patch.qualityStatus="Published";if(Object.keys(patch).length){patch.updatedAt=serverTimestamp();batch.update(doc(db,"courses",course.id,"items",item.id),patch);changed++;}});
          await batch.commit();
        }
      }
      const sections=await docs(["sections"]);
      for(const sec of sections){
        const patch={};if(!sec.status)patch.status="Active";if(Object.keys(patch).length){await updateDoc(doc(db,"sections",sec.id),{...patch,updatedAt:serverTimestamp()});changed++;}
        const assignments=await docs(["sections",sec.id,"assignments"]);
        for(let i=0;i<assignments.length;i+=350){
          const batch=writeBatch(db);
          assignments.slice(i,i+350).forEach(a=>{if(!a.gradingPeriod){batch.update(doc(db,"sections",sec.id,"assignments",a.id),{gradingPeriod:"Overall",updatedAt:serverTimestamp()});changed++;}});
          await batch.commit();
        }
      }
      await setDoc(doc(db,"system","platform"),{lastMigrationLabel:"Phase 6 legacy normalization",lastMigrationAt:serverTimestamp(),lastMigrationBy:state().user.uid},{merge:true});
      closeModal();toast(changed+" legacy record"+(changed===1?"":"s")+" normalized.");
    }catch(error){button.disabled=false;button.textContent="Run Safe Migration";toast(error.message||"Migration failed.");}
  };
}

async function systemAnnouncement(){
  const m=modal({
    eyebrow:"System Communication",
    title:"Publish System Announcement",
    body:'<form id="systemAnnouncementForm"><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Message</label><textarea name="body" rows="6" required></textarea></div><div class="compact-field-grid"><div class="field"><label>Severity</label><select name="severity"><option>Information</option><option>Academic Notice</option><option>Maintenance</option><option>Important</option></select></div><div class="field"><label>Expires</label><input type="date" name="expiresAt"></div></div><div class="modal-foot"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Publish</button></div></form>'
  });
  m.querySelector("#systemAnnouncementForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),raw=String(fd.get("expiresAt")||"");
    try{await setDoc(doc(db,"system","announcement"),{title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),severity:String(fd.get("severity")),expiresAt:raw?Timestamp.fromDate(new Date(raw+"T23:59:59")):null,createdAt:serverTimestamp(),createdBy:state().user.uid},{merge:true});closeModal();toast("System announcement published.");}catch(error){toast(error.message||"Unable to publish announcement.");}
  };
}

/* -------------------- COURSE PACKAGE IMPORT / EXPORT -------------------- */

async function coursePackage(courseId){
  const cSnap=await getDoc(doc(db,"courses",courseId));if(!cSnap.exists())throw new Error("Course not found.");
  const course={id:cSnap.id,...cSnap.data()},[competencies,units,items,rubrics]=await Promise.all([docs(["courses",courseId,"competencies"]),docs(["courses",courseId,"units"]),docs(["courses",courseId,"items"]),docs(["courses",courseId,"rubrics"])]);
  const unitRows=[];
  for(const unit of units)unitRows.push({...unit,topics:await docs(["courses",courseId,"units",unit.id,"topics"])});
  return {format:"theoria-course-package",version:2,exportedAt:new Date().toISOString(),course:serialize(course),competencies:serialize(competencies),units:serialize(unitRows),items:serialize(items),rubrics:serialize(rubrics)};
}
async function exportCoursePackage(courseId){
  try{const pkg=await coursePackage(courseId),safeName=String(pkg.course.code||"course").replace(/[^a-z0-9_-]+/gi,"-").toLowerCase();download(safeName+"-theoria-course.json",JSON.stringify(pkg,null,2));}catch(error){toast(error.message||"Unable to export course.");}
}
async function exportCatalog(){
  const packages=[];for(const course of await docs(["courses"]))packages.push(await coursePackage(course.id));
  download("theoria-catalog-backup.json",JSON.stringify({format:"theoria-catalog-backup",version:1,exportedAt:new Date().toISOString(),courses:packages},null,2));
}
async function importCoursePackageModal(){
  const m=modal({
    eyebrow:"Import Center",
    title:"Import Theoria Course Package",
    wide:true,
    body:'<form id="coursePackageImport"><div class="notice">Imports create a new catalog course. Existing course documents are not overwritten.</div><div class="field"><label>Course Package JSON</label><textarea name="json" rows="14" placeholder="{ ... }" required></textarea></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Validate & Import</button></div></form>'
  });
  m.querySelector("#coursePackageImport").onsubmit=async e=>{
    e.preventDefault();let pkg;try{pkg=JSON.parse(String(new FormData(e.currentTarget).get("json")||""));}catch{return toast("The pasted course package is not valid JSON.");}
    if(pkg?.format!=="theoria-course-package"||!pkg.course?.code||!pkg.course?.title)return toast("This is not a valid Theoria course package.");
    try{
      const ref=doc(collection(db,"courses")),courseData={...pkg.course};
      delete courseData.id;courseData.code=String(courseData.code)+" COPY";courseData.catalogPublished=false;courseData.ownerId=state().user.uid;courseData.createdAt=serverTimestamp();courseData.updatedAt=serverTimestamp();
      await setDoc(ref,courseData);
      const compIdMap=new Map(),unitIdMap=new Map();
      for(const comp of safe(pkg.competencies)){const cr=doc(collection(db,"courses",ref.id,"competencies"));compIdMap.set(comp.id,cr.id);const row={...comp};delete row.id;await setDoc(cr,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      for(const unit of safe(pkg.units)){const ur=doc(collection(db,"courses",ref.id,"units"));unitIdMap.set(unit.id,ur.id);const row={...unit};delete row.id;delete row.topics;await setDoc(ur,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});for(const topic of safe(unit.topics)){const tr=doc(collection(db,"courses",ref.id,"units",ur.id,"topics")),t={...topic};delete t.id;t.competencyIds=safe(t.competencyIds).map(id=>compIdMap.get(id)||id);await setDoc(tr,{...t,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}}
      for(const item of safe(pkg.items)){const ir=doc(collection(db,"courses",ref.id,"items")),row={...item};delete row.id;row.unitId=unitIdMap.get(row.unitId)||"";row.competencyIds=safe(row.competencyIds).map(id=>compIdMap.get(id)||id);await setDoc(ir,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      for(const rubric of safe(pkg.rubrics)){const rr=doc(collection(db,"courses",ref.id,"rubrics")),row={...rubric};delete row.id;await setDoc(rr,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      closeModal();toast("Course package imported as an unpublished catalog copy.");await core().loadWorkspace();core().setPage("courses");
    }catch(error){toast(error.message||"Unable to import the course package.");}
  };
}


function csvCell(value){
  const text=String(value??"");
  return /[",\n\r]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}
function csvFile(rows){return rows.map(row=>row.map(csvCell).join(",")).join("\r\n");}

async function exportSectionRoster(sectionId){
  try{
    const sectionSnap=await getDoc(doc(db,"sections",sectionId));if(!sectionSnap.exists())throw new Error("Section not found.");
    const section={id:sectionSnap.id,...sectionSnap.data()},members=await docs(["sections",sectionId,"members"]);
    const rows=[["Student ID","Name","Email","Status","Joined","Course","Section","Term"]].concat(members.map(m=>[
      m.id,m.displayName||"",m.email||"",m.status||"enrolled",serialize(m.joinedAt)||"",section.courseCode||"",section.sectionName||"",section.term||""
    ]));
    const name=((section.courseCode||"section")+"-"+(section.sectionName||"roster")).replace(/[^a-z0-9_-]+/gi,"-").toLowerCase();
    download(name+"-roster.csv",csvFile(rows),"text/csv");
  }catch(error){toast(error.message||"Unable to export roster.");}
}

async function exportSectionGradebook(sectionId){
  try{
    const sectionSnap=await getDoc(doc(db,"sections",sectionId));if(!sectionSnap.exists())throw new Error("Section not found.");
    const section={id:sectionSnap.id,...sectionSnap.data()};
    const [members,assignments,grades,assessmentRefs,assessmentGrades]=await Promise.all([
      docs(["sections",sectionId,"members"]),docs(["sections",sectionId,"assignments"]),docs(["sections",sectionId,"grades"]),
      docs(["sections",sectionId,"assessmentRefs"]),docs(["sections",sectionId,"assessmentGrades"])
    ]);
    const gradeMap=new Map(grades.map(g=>[g.assignmentId+"_"+g.studentId,g]));
    const assessmentMap=new Map(assessmentGrades.map(g=>[g.assessmentId+"_"+g.studentId,g]));
    const rows=[["Student ID","Name","Email",...assignments.map(a=>"Coursework: "+a.title),...assessmentRefs.map(a=>"Assessment: "+a.title)]];
    members.forEach(student=>rows.push([
      student.id,student.displayName||"",student.email||"",
      ...assignments.map(a=>{const g=gradeMap.get(a.id+"_"+student.id);return g?.gradeStatus==="Excused"?"Excused":g?.score??"";}),
      ...assessmentRefs.map(a=>assessmentMap.get(a.id+"_"+student.id)?.percent??"")
    ]));
    const name=((section.courseCode||"section")+"-"+(section.sectionName||"gradebook")).replace(/[^a-z0-9_-]+/gi,"-").toLowerCase();
    download(name+"-gradebook.csv",csvFile(rows),"text/csv");
  }catch(error){toast(error.message||"Unable to export gradebook.");}
}

async function exportAssessmentPackage(assessmentId){
  try{
    const snap=await getDoc(doc(db,"assessments",assessmentId));if(!snap.exists())throw new Error("Assessment not found.");
    const assessment={id:snap.id,...snap.data()},questions=await docs(["assessments",assessmentId,"questions"]);
    const pkg={format:"theoria-assessment-package",version:1,exportedAt:new Date().toISOString(),assessment:serialize(assessment),questions:serialize(questions)};
    const name=String(assessment.title||"assessment").replace(/[^a-z0-9_-]+/gi,"-").toLowerCase();
    download(name+"-theoria-assessment.json",JSON.stringify(pkg,null,2));
  }catch(error){toast(error.message||"Unable to export assessment.");}
}

async function exportAcademicConfigurationBackup(){
  try{
    const packages=[];for(const course of await docs(["courses"]))packages.push(await coursePackage(course.id));
    const sections=serialize(await docs(["sections"])),assessments=serialize(await docs(["assessments"]));
    const platform=await getDoc(doc(db,"system","platform"));
    download("theoria-academic-configuration-backup-"+new Date().toISOString().slice(0,10)+".json",JSON.stringify({
      format:"theoria-academic-configuration-backup",version:1,exportedAt:new Date().toISOString(),courses:packages,sections,assessments,
      platform:platform.exists()?serialize(platform.data()):{}
    },null,2));
  }catch(error){toast(error.message||"Unable to export academic configuration backup.");}
}

async function importExportCenter(){
  const courses=state()?.courses||[],sections=(state()?.sections||[]).filter(section=>section.ownerId===state()?.user?.uid),assessments=(await docs(["assessments"])).filter(a=>a.ownerId===state()?.user?.uid);
  modal({
    eyebrow:"Data Portability",
    title:"Import / Export Center",
    wide:true,
    body:'<div class="operations-grid"><button class="operation-card" data-admin-action="export-catalog"><span>↓</span><strong>Export Catalog Backup</strong><small>JSON package containing every catalog course, framework, rubric, and Question Bank.</small></button><button class="operation-card" data-admin-action="import-course"><span>↑</span><strong>Import Course Package</strong><small>Create a new unpublished catalog course from a Theoria package.</small></button><button class="operation-card" data-admin-action="export-academic-config"><span>◎</span><strong>Academic Configuration Backup</strong><small>Courses, section configuration, assessment metadata, and platform settings without student submissions.</small></button></div>'+
    '<div class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">Individual Course Packages</div></div><div class="panel-body">'+courses.map(course=>'<div class="export-course-row"><div><strong>'+esc(course.code+" — "+course.title)+'</strong><span>'+esc(course.discipline||"")+'</span></div><button class="secondary-btn small-btn" data-admin-action="export-course" data-course="'+course.id+'">Export JSON</button></div>').join("")+'</div></div>'+
    '<div class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Section CSV Exports</div><div class="panel-subtitle">Portable roster and Gradebook files for sections you own.</div></div></div><div class="panel-body">'+(sections.length?sections.map(section=>'<div class="export-course-row"><div><strong>'+esc((section.courseCode||"Course")+" — "+(section.sectionName||section.courseTitle||"Section"))+'</strong><span>'+esc(section.term||"")+'</span></div><div class="inline-actions"><button class="secondary-btn small-btn" data-admin-action="export-roster" data-section="'+section.id+'">Roster CSV</button><button class="secondary-btn small-btn" data-admin-action="export-gradebook" data-section="'+section.id+'">Gradebook CSV</button></div></div>').join(""):'<div class="empty-mini">No owned sections are available for export.</div>')+'</div></div>'+
    '<div class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Assessment Packages</div><div class="panel-subtitle">Portable snapshots of assessment structure and questions. Student submissions are not included.</div></div></div><div class="panel-body">'+(assessments.length?assessments.slice(0,100).map(a=>'<div class="export-course-row"><div><strong>'+esc(a.title||"Assessment")+'</strong><span>'+esc((a.courseCode||"Course")+(a.sectionName?" • "+a.sectionName:" • Template"))+'</span></div><button class="secondary-btn small-btn" data-admin-action="export-assessment" data-assessment="'+a.id+'">Export JSON</button></div>').join(""):'<div class="empty-mini">No assessments are available for export.</div>')+'</div></div>',
    footer:'<button class="primary-btn" data-close-modal>Done</button>'
  });
}

/* -------------------- COURSE VERSIONING -------------------- */

async function courseVersionModal(courseId){
  const course=state()?.courses?.find(x=>x.id===courseId)||null;if(!course)return;
  const m=modal({
    eyebrow:"Course Versioning",
    title:"Create New Version",
    wide:true,
    body:'<form id="courseVersionForm"><div class="academic-banner"><div class="kicker">'+esc(course.code)+'</div><h3>'+esc(course.title)+'</h3><p>The current catalog course remains unchanged for historical sections. A new catalog course is created with cloned framework and Question Bank data.</p></div><div class="compact-field-grid"><div class="field"><label>New Catalog Code</label><input name="code" value="'+esc(course.code+"-"+new Date().getFullYear())+'" required></div><div class="field"><label>Version Label</label><input name="versionLabel" value="'+esc(String(course.versionLabel||"v1")+" → v2")+'" required></div></div><div class="field"><label>Version Notes</label><textarea name="notes" placeholder="Describe curriculum changes planned for this version."></textarea></div><div class="modal-foot"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Create Course Version</button></div></form>'
  });
  m.querySelector("#courseVersionForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),pkg=await coursePackage(courseId);
    try{
      const ref=doc(collection(db,"courses")),data={...pkg.course};delete data.id;
      Object.assign(data,{code:String(fd.get("code")).trim(),versionLabel:String(fd.get("versionLabel")).trim(),versionNotes:String(fd.get("notes")||"").trim(),supersedesCourseId:courseId,catalogPublished:false,ownerId:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      await setDoc(ref,data);
      const compMap=new Map(),unitMap=new Map();
      for(const comp of pkg.competencies){const cr=doc(collection(db,"courses",ref.id,"competencies"));compMap.set(comp.id,cr.id);const row={...comp};delete row.id;await setDoc(cr,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      for(const unit of pkg.units){const ur=doc(collection(db,"courses",ref.id,"units"));unitMap.set(unit.id,ur.id);const row={...unit};delete row.id;delete row.topics;await setDoc(ur,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});for(const topic of safe(unit.topics)){const tr=doc(collection(db,"courses",ref.id,"units",ur.id,"topics")),t={...topic};delete t.id;t.competencyIds=safe(t.competencyIds).map(id=>compMap.get(id)||id);await setDoc(tr,{...t,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}}
      for(const item of pkg.items){const ir=doc(collection(db,"courses",ref.id,"items")),row={...item};delete row.id;row.unitId=unitMap.get(row.unitId)||"";row.competencyIds=safe(row.competencyIds).map(id=>compMap.get(id)||id);await setDoc(ir,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      for(const rubric of safe(pkg.rubrics)){const rr=doc(collection(db,"courses",ref.id,"rubrics")),row={...rubric};delete row.id;await setDoc(rr,{...row,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      await p5()?.logCourseEvent?.(courseId,"course_version_created","course",ref.id,{newCode:data.code,versionLabel:data.versionLabel});
      closeModal();toast("New course version created as an unpublished catalog course.");await core().loadWorkspace();core().setPage("courses");
    }catch(error){toast(error.message||"Unable to create course version.");}
  };
}

/* -------------------- SECTION ROLLOVER -------------------- */

async function rolloverSection(sectionId){
  const source=state()?.sections?.find(x=>x.id===sectionId)||null;if(!source)return;
  const m=modal({
    eyebrow:"Term Rollover",
    title:"Copy Section to New Term",
    body:'<form id="rolloverForm"><div class="academic-banner"><div class="kicker">'+esc(source.courseCode||"Course")+'</div><h3>'+esc(source.sectionName||source.courseTitle)+'</h3><p>Assignments, resources, and grading policy are copied. The course-level rubric library and reusable assessment templates remain available automatically. Students, grades, attendance, submissions, and academic records are not copied.</p></div><div class="compact-field-grid"><div class="field"><label>New Section Name</label><input name="sectionName" value="'+esc((source.sectionName||"Section")+" — New Term")+'" required></div><div class="field"><label>Term</label><input name="term" placeholder="Spring 2027" required></div></div><div class="compact-field-grid"><div class="field"><label>Start Date</label><input name="startDate" type="date"></div><div class="field"><label>End Date</label><input name="endDate" type="date"></div></div><div class="modal-foot"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Create Rolled-Over Section</button></div></form>'
  });
  m.querySelector("#rolloverForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),joinCode=await uniqueJoinCode(),ref=doc(collection(db,"sections"));
    try{
      const sectionData={...source};["id","archivedAt","entranceAssessmentId","entranceExamTitle","entranceConfiguredAt","entranceTemplateSourceId"].forEach(k=>delete sectionData[k]);
      if(sectionData.gradingPolicy){
        const periods=sectionData.gradingPolicy.gradingPeriods?.length?sectionData.gradingPolicy.gradingPeriods:["Overall"],gradingPeriodSettings={};
        periods.forEach(period=>gradingPeriodSettings[period]={locked:false,finalizedAt:null,finalizedBy:"",reopenedAt:null,reopenedBy:""});
        sectionData.gradingPolicy={...sectionData.gradingPolicy,selectionOpen:true,selectionDeadline:null,gradingPeriodSettings};
      }
      Object.assign(sectionData,{ownerId:state().user.uid,instructorName:state().profile?.displayName||state().user.displayName||source.instructorName,sectionName:String(fd.get("sectionName")).trim(),term:String(fd.get("term")).trim(),startDate:String(fd.get("startDate")||""),endDate:String(fd.get("endDate")||""),joinCode,joinOpen:false,status:"Active",createdAt:serverTimestamp(),updatedAt:serverTimestamp(),rolledOverFrom:source.id});
      await setDoc(ref,sectionData);
      await setDoc(doc(db,"joinCodes",joinCode),{sectionId:ref.id,active:false,courseId:source.courseId,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      for(const name of ["assignments","resources"]){
        const rows=await docs(["sections",source.id,name]);
        for(let i=0;i<rows.length;i+=350){
          const batch=writeBatch(db);rows.slice(i,i+350).forEach(row=>{const rr=doc(collection(db,"sections",ref.id,name)),copy={...row};delete copy.id;if(name==="assignments"){copy.status="Draft";copy.dueDate="";}batch.set(rr,{...copy,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});});await batch.commit();
        }
      }
      await p5()?.logSectionEvent?.(source.id,"section_rolled_over","section",ref.id,{newTerm:sectionData.term,newSectionName:sectionData.sectionName});
      closeModal();toast("New-term section created with enrollment closed.");await core().loadWorkspace();core().openSection(ref.id);
    }catch(error){toast(error.message||"Unable to roll over section.");}
  };
}

/* -------------------- PROGRAM MAP -------------------- */

async function renderProgramMap(){
  const el=$("#programMapContent");if(!el)return;
  const courses=(state()?.courses||[]).filter(c=>c.catalogPublished!==false||state()?.isSystemOwner),byId=new Map(courses.map(c=>[c.id,c]));
  const disciplines=[...new Set(courses.map(c=>c.discipline||"General"))].sort();
  el.innerHTML='<div class="academic-banner"><div class="kicker">Catalog Dependencies</div><h3>Theoria Program Map</h3><p>Course sequences based on prerequisite courses, competency gates, entrance examinations, and instructor approval.</p></div>'+
    disciplines.map(d=>'<section class="program-discipline"><div class="panel-title">'+esc(d)+'</div><div class="program-map-grid">'+courses.filter(c=>(c.discipline||"General")===d).map(c=>{const p=c.prerequisitePolicy||{},req=safe(p.requiredCourseIds).map(id=>byId.get(id)).filter(Boolean);return '<article class="program-course-node"><div class="card-kicker">'+esc(c.code||"Course")+'</div><h3>'+esc(c.title||"Untitled")+'</h3>'+(req.length?'<div class="program-prereqs"><span>Requires</span>'+req.map(r=>'<b>'+esc(r.code||r.title)+'</b>').join("")+'</div>':'<div class="program-prereqs open"><span>Entry course / no course prerequisite</span></div>')+'<div class="item-tags">'+(c.entranceExamRequired?'<span>Entrance Exam</span>':'')+(safe(p.competencyRequirements).length?'<span>'+p.competencyRequirements.length+' Competency Gates</span>':'')+(p.instructorApproval?'<span>Instructor Approval</span>':'')+'</div>'+(state()?.isSystemOwner?'<div class="card-actions"><button class="text-btn" data-admin-action="version-course" data-course="'+c.id+'">New Version</button></div>':'')+'</article>';}).join("")+'</div></section>').join("");
}

/* -------------------- TRANSCRIPT -------------------- */

async function transcriptData(userId=state()?.user?.uid){
  const rows=[];
  try{
    const enroll=await getDocs(collection(db,"users",userId,"enrollments"));
    for(const e of enroll.docs){
      try{
        const rec=await getDoc(doc(db,"sections",e.id,"academicRecords",userId));
        if(rec.exists()&&rec.data().status==="Certified")rows.push({sectionId:e.id,...rec.data()});
      }catch(_){}
    }
  }catch(_){}
  return rows.sort((a,b)=>String(a.term||"").localeCompare(String(b.term||""))||String(a.courseCode||"").localeCompare(String(b.courseCode||"")));
}
async function renderTranscript(){
  const el=$("#transcriptContent");if(!el)return;
  if(state()?.role!=="student"){el.innerHTML='<div class="empty-state"><div class="empty-symbol">T</div><h3>Student transcript workspace.</h3><p>Instructor academic records remain available from Reports and student profile drawers.</p></div>';return;}
  const rows=await transcriptData(),name=state().profile?.displayName||state().user.displayName||"Student",recognitions=[];
  try{
    const enroll=await getDocs(collection(db,"users",state().user.uid,"enrollments"));
    for(const e of enroll.docs){
      try{
        const rs=await getDocs(query(collection(db,"sections",e.id,"recognitions"),where("studentId","==",state().user.uid)));
        rs.docs.forEach(d=>recognitions.push({id:d.id,sectionId:e.id,...d.data()}));
      }catch(_){}
    }
  }catch(_){}
  recognitions.sort((a,b)=>String(a.term||"").localeCompare(String(b.term||""))||String(a.title||"").localeCompare(String(b.title||"")));
  el.innerHTML='<article class="transcript-sheet" id="theoriaTranscript"><div class="record-seal">Θ</div><div class="transcript-head"><div class="eyebrow">Theoria Multi-Course Academic Record</div><h1>'+esc(name)+'</h1><p>'+esc(state().user.email||"")+'</p></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Course</th><th>Term</th><th>Version</th><th>Final Grade</th><th>Mastery</th><th>Pathway</th><th>Status</th></tr></thead><tbody>'+rows.map(r=>'<tr><td><strong>'+esc(r.courseCode||"")+'</strong><span class="grade-sub">'+esc(r.courseTitle||"")+'</span></td><td>'+esc(r.term||"—")+'</td><td>'+esc(r.courseVersion||"—")+'</td><td><strong>'+esc(r.letterGrade||"—")+'</strong> • '+esc(r.finalPercent??"—")+'%</td><td>'+(r.masteryPercent===null||r.masteryPercent===undefined?"—":esc(r.masteryPercent)+"%")+'</td><td>'+esc(r.pathway==="examination"?"Examination":"Composite")+'</td><td><span class="badge live">'+esc(r.status||"Certified")+'</span></td></tr>').join("")+'</tbody></table></div>'+
    (recognitions.length?'<div class="transcript-recognitions"><div class="panel-title">Honors & Academic Recognition</div>'+recognitions.map(r=>'<div class="profile-record-row"><div><strong>'+esc(r.title||"Recognition")+'</strong><span>'+esc(r.description||"")+'</span></div><b>'+esc(r.term||"")+'</b></div>').join("")+'</div>':'')+
    '<div class="record-footer"><p>This record documents academic work within Theoria and does not independently establish outside accreditation.</p><button class="primary-btn" onclick="window.print()">Print Transcript</button></div></article>';
}

/* -------------------- EVENT WIRING -------------------- */

function bind(){
  window.addEventListener("theoria:page",e=>{
    if(e.detail.page==="admin-center")renderAdminCenter();
    if(e.detail.page==="program-map")renderProgramMap();
    if(e.detail.page==="transcript")renderTranscript();
  });
  document.addEventListener("click",async e=>{
    const b=e.target.closest("[data-admin-action]");if(!b)return;
    const a=b.dataset.adminAction;
    if(a==="integrity-scan")return integrityScan();
    if(a==="diagnostics")return diagnostics();
    if(a==="feature-flags")return featureFlags();
    if(a==="migration-tools")return migrationTools();
    if(a==="system-announcement")return systemAnnouncement();
    if(a==="import-export")return importExportCenter();
    if(a==="export-catalog")return exportCatalog();
    if(a==="export-course")return exportCoursePackage(b.dataset.course);
    if(a==="export-roster")return exportSectionRoster(b.dataset.section);
    if(a==="export-gradebook")return exportSectionGradebook(b.dataset.section);
    if(a==="export-assessment")return exportAssessmentPackage(b.dataset.assessment);
    if(a==="export-academic-config")return exportAcademicConfigurationBackup();
    if(a==="import-course"){closeModal();return importCoursePackageModal();}
    if(a==="version-course")return courseVersionModal(b.dataset.course);
    if(a==="rollover-section")return rolloverSection(b.dataset.section);
  });
}

export function initAdmin(){
  bind();
  return {renderAdminCenter,renderProgramMap,renderTranscript,courseVersionModal,rolloverSection,integrityScan,diagnostics};
}
