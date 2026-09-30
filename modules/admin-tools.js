import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();
const isOwner=()=>state()?.isSystemOwner===true;
const fmt=v=>core()?.formatDate?.(v)||"—";

function downloadJson(filename,data){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function getPlatformSettings(){
  try{const s=await getDoc(doc(db,"system","platform"));return s.exists()?s.data():{};}catch(_){return {};}
}

async function collectStats(){
  const [courses,sections,users,assessments]=await Promise.all([
    getDocs(collection(db,"courses")),getDocs(collection(db,"sections")),getDocs(collection(db,"users")),getDocs(collection(db,"assessments"))
  ]);
  let questions=0,activeSections=0,archived=0;
  for(const c of courses.docs){
    try{questions+=(await getDocs(collection(db,"courses",c.id,"items"))).size;}catch(_){}
  }
  sections.docs.forEach(s=>s.data().status==="Archived"?archived++:activeSections++);
  return {courses:courses.size,sections:sections.size,activeSections,archived,users:users.size,assessments:assessments.size,questions};
}

async function renderAdminCenter(){
  const el=$("#adminCenterContent");if(!el||!isOwner())return;
  el.innerHTML='<div class="empty-mini">Loading Theoria system controls…</div>';
  const [stats,settings]=await Promise.all([collectStats(),getPlatformSettings()]);
  el.innerHTML='<div class="academic-banner"><div class="kicker">System Owner Control Center</div><h3>Theoria Platform Administration</h3><p>Catalog health, academic data integrity, platform configuration, course lifecycle, imports, exports, and diagnostics.</p></div>'+
    '<div class="student-profile-summary admin-stat-row"><div><span>Catalog Courses</span><strong>'+stats.courses+'</strong></div><div><span>Active Sections</span><strong>'+stats.activeSections+'</strong></div><div><span>Users</span><strong>'+stats.users+'</strong></div><div><span>Question Bank</span><strong>'+stats.questions+'</strong></div><div><span>Assessments</span><strong>'+stats.assessments+'</strong></div><div><span>Archived Sections</span><strong>'+stats.archived+'</strong></div></div>'+
    '<div class="admin-tool-grid">'+
      '<button class="admin-tool-card" data-admin-action="integrity"><span>01</span><strong>Data Integrity Scanner</strong><small>Find broken section/course links, orphaned assessment references, invalid join codes, and missing framework mappings.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="catalog-map"><span>02</span><strong>Catalog Dependency Map</strong><small>Visualize prerequisite course relationships and entrance-examination gates.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="course-versioning"><span>03</span><strong>Course Versioning</strong><small>Snapshot official course frameworks before curriculum revisions.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="rollover"><span>04</span><strong>Section Rollover</strong><small>Create a new-term section while keeping curriculum, coursework, resources, and policies but no students.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="import-export"><span>05</span><strong>Import / Export Center</strong><small>Back up catalog courses, frameworks, Question Banks, and platform metadata as JSON.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="feature-flags"><span>06</span><strong>Feature Flags & Migrations</strong><small>Control new platform systems and record data-migration checkpoints.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="diagnostics"><span>07</span><strong>System Diagnostics</strong><small>Verify Firebase reads, current owner record, catalog accessibility, and browser connectivity.</small></button>'+
      '<button class="admin-tool-card" data-admin-action="system-announcement"><span>08</span><strong>System Announcement</strong><small>Publish a platform-wide notice visible to signed-in users.</small></button>'+
    '</div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div><div class="panel-title">Platform Configuration</div><div class="panel-subtitle">Current release and feature-control metadata.</div></div></div><div class="panel-body"><div class="detail-list"><div><span>Release Label</span><strong>'+esc(settings.releaseLabel||"Unversioned")+'</strong></div><div><span>Maintenance Mode</span><strong>'+(settings.maintenanceMode?"Enabled":"Off")+'</strong></div><div><span>Configured Flags</span><strong>'+Object.keys(settings.featureFlags||{}).length+'</strong></div><div><span>Last Migration</span><strong>'+esc(settings.lastMigration||"—")+'</strong></div></div></div></div>';
}

async function scanIntegrity(){
  const findings=[];
  const [courses,sections,assessments,joinCodes]=await Promise.all([
    getDocs(collection(db,"courses")),getDocs(collection(db,"sections")),getDocs(collection(db,"assessments")),getDocs(collection(db,"joinCodes"))
  ]);
  const courseIds=new Set(courses.docs.map(d=>d.id)),sectionIds=new Set(sections.docs.map(d=>d.id)),assessmentIds=new Set(assessments.docs.map(d=>d.id));
  const joinMap=new Map(joinCodes.docs.map(d=>[d.id,d.data()]));

  for(const section of sections.docs){
    const s=section.data();
    if(!courseIds.has(s.courseId))findings.push({severity:"critical",type:"Section",id:section.id,message:"References a missing course: "+String(s.courseId||"none")});
    if(s.joinCode&&!joinMap.has(s.joinCode))findings.push({severity:"warning",type:"Section",id:section.id,message:"Section joinCode has no joinCodes document."});
    if(s.joinCode&&joinMap.has(s.joinCode)&&joinMap.get(s.joinCode).sectionId!==section.id)findings.push({severity:"critical",type:"Join Code",id:s.joinCode,message:"Join code points to a different section."});
    try{
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
      refs.docs.forEach(r=>{if(!assessmentIds.has(r.id))findings.push({severity:"warning",type:"Assessment Ref",id:r.id,message:"Section contains an orphaned assessment reference."});});
    }catch(_){}
  }

  for(const jc of joinCodes.docs){
    if(!sectionIds.has(jc.data().sectionId))findings.push({severity:"warning",type:"Join Code",id:jc.id,message:"Points to a section that no longer exists."});
  }

  for(const course of courses.docs){
    try{
      const [units,competencies,items]=await Promise.all([
        getDocs(collection(db,"courses",course.id,"units")),
        getDocs(collection(db,"courses",course.id,"competencies")),
        getDocs(collection(db,"courses",course.id,"items"))
      ]);
      const unitIds=new Set(units.docs.map(d=>d.id)),compIds=new Set(competencies.docs.map(d=>d.id));
      for(const item of items.docs){
        const q=item.data();
        if(q.unitId&&!unitIds.has(q.unitId))findings.push({severity:"warning",type:"Question",id:item.id,message:(course.data().code||"Course")+" question maps to a missing unit."});
        (q.competencyIds||[]).forEach(id=>{if(id&&!compIds.has(id))findings.push({severity:"warning",type:"Question",id:item.id,message:(course.data().code||"Course")+" question maps to a missing competency."});});
      }
    }catch(_){}
  }

  return findings;
}

async function integrityModal(){
  const m=modal({eyebrow:"Data Integrity Scanner",title:"Scanning Theoria…",wide:true,body:'<div class="empty-mini">Checking courses, sections, Question Banks, join codes, and assessment references…</div>'});
  const findings=await scanIntegrity(),critical=findings.filter(x=>x.severity==="critical").length;
  m.querySelector(".modal-body").innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Findings</div><div class="summary-value">'+findings.length+'</div></div><div class="summary-block"><div class="summary-label">Critical</div><div class="summary-value">'+critical+'</div></div><div class="summary-block"><div class="summary-label">Warnings</div><div class="summary-value">'+(findings.length-critical)+'</div></div></div>'+
    (findings.length?'<div class="integrity-list">'+findings.map(f=>'<div class="integrity-row '+f.severity+'"><span>'+esc(f.severity)+'</span><div><strong>'+esc(f.type)+' • '+esc(f.id)+'</strong><p>'+esc(f.message)+'</p></div></div>').join("")+'</div>':'<div class="notice"><strong>No integrity problems detected.</strong><p>The catalog, sections, join codes, and sampled academic relationships are internally consistent.</p></div>');
}

async function catalogMapModal(){
  const courses=state().courses||[];
  const incoming=new Map();
  courses.forEach(c=>(c.prerequisitePolicy?.requiredCourseIds||[]).forEach(id=>incoming.set(id,(incoming.get(id)||0)+1)));
  modal({eyebrow:"Catalog Dependencies",title:"Course Progression Map",wide:true,body:'<div class="catalog-map">'+courses.map(c=>'<article class="dependency-node"><div><span>'+esc(c.discipline||"Course")+'</span><strong>'+esc(c.code+" — "+c.title)+'</strong></div><div class="dependency-links">'+((c.prerequisitePolicy?.requiredCourseIds||[]).length?(c.prerequisitePolicy.requiredCourseIds||[]).map(id=>{const x=courses.find(y=>y.id===id);return '<span>Requires '+esc(x?.code||"Unknown Course")+'</span>';}).join(""):'<span>Entry course</span>')+(c.entranceExamRequired?'<span class="gate">Entrance exam gate</span>':'')+(c.prerequisitePolicy?.instructorApproval?'<span class="gate">Instructor approval</span>':'')+'</div></article>').join("")+'</div>'});
}

async function coursePackage(course){
  const [units,competencies,items,rubrics]=await Promise.all([
    getDocs(collection(db,"courses",course.id,"units")),
    getDocs(collection(db,"courses",course.id,"competencies")),
    getDocs(collection(db,"courses",course.id,"items")),
    getDocs(collection(db,"courses",course.id,"rubrics"))
  ]);
  const unitRows=[];
  for(const unit of units.docs){
    const topics=await getDocs(collection(db,"courses",course.id,"units",unit.id,"topics"));
    unitRows.push({id:unit.id,...unit.data(),topics:topics.docs.map(d=>({id:d.id,...d.data()}))});
  }
  return {
    format:"theoria-course-package",
    version:1,
    exportedAt:new Date().toISOString(),
    course:{id:course.id,...course},
    framework:{competencies:competencies.docs.map(d=>({id:d.id,...d.data()})),units:unitRows},
    questions:items.docs.map(d=>({id:d.id,...d.data()})),
    rubrics:rubrics.docs.map(d=>({id:d.id,...d.data()}))
  };
}

async function importExportModal(){
  const courses=state().courses||[];
  const m=modal({eyebrow:"Import / Export Center",title:"Academic Data Portability",wide:true,body:'<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Export Course Package</div></div><div class="panel-body"><div class="field"><label>Course</label><select id="exportCourseSelect">'+courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select></div><button class="primary-btn" data-admin-action="export-course">Download Course JSON</button></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Import Course Package</div></div><div class="panel-body"><div class="field"><label>Theoria JSON Package</label><input id="importCourseFile" type="file" accept=".json,application/json"></div><div class="notice">Import creates a new Draft catalog course so existing courses are never overwritten silently.</div><button class="primary-btn" data-admin-action="import-course">Import as New Draft</button></div></div></div><div class="panel" style="margin-top:16px"><div class="panel-head"><div class="panel-title">Platform Metadata Backup</div></div><div class="panel-body"><button class="secondary-btn" data-admin-action="export-platform">Download Catalog Metadata</button></div></div>'});
  return m;
}

async function exportCourseFromModal(){
  const id=$("#exportCourseSelect")?.value,course=state().courses.find(c=>c.id===id);if(!course)return;
  const pkg=await coursePackage(course);downloadJson((course.code||"course").replace(/\s+/g,"_")+"_theoria.json",pkg);
}

async function importCourseFromModal(){
  const file=$("#importCourseFile")?.files?.[0];if(!file)return toast("Choose a Theoria JSON package.");
  try{
    const pkg=JSON.parse(await file.text());if(pkg.format!=="theoria-course-package")throw new Error("This is not a Theoria course package.");
    const source=pkg.course||{},ref=doc(collection(db,"courses"));
    await setDoc(ref,{
      code:String(source.code||"IMPORTED")+" COPY",title:String(source.title||"Imported Course"),discipline:String(source.discipline||""),
      level:String(source.level||"Advanced"),status:"Draft",description:String(source.description||""),
      catalogCourse:true,catalogManaged:true,catalogPublished:false,ownerId:state().user.uid,
      importedFromCourseId:source.id||"",importedAt:serverTimestamp(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    });
    for(const comp of pkg.framework?.competencies||[]){
      const id=comp.id||doc(collection(db,"courses",ref.id,"competencies")).id;
      const clean={...comp};delete clean.id;await setDoc(doc(db,"courses",ref.id,"competencies",id),clean);
    }
    for(const unit of pkg.framework?.units||[]){
      const unitId=unit.id||doc(collection(db,"courses",ref.id,"units")).id,clean={...unit};delete clean.id;delete clean.topics;
      await setDoc(doc(db,"courses",ref.id,"units",unitId),clean);
      for(const topic of unit.topics||[]){const tid=topic.id||doc(collection(db,"courses",ref.id,"units",unitId,"topics")).id,t={...topic};delete t.id;await setDoc(doc(db,"courses",ref.id,"units",unitId,"topics",tid),t);}
    }
    for(const q of pkg.questions||[]){const qid=q.id||doc(collection(db,"courses",ref.id,"items")).id,x={...q};delete x.id;x.courseId=ref.id;x.courseCode=String(source.code||"IMPORTED")+" COPY";await setDoc(doc(db,"courses",ref.id,"items",qid),x);}
    for(const rubric of pkg.rubrics||[]){const rid=rubric.id||doc(collection(db,"courses",ref.id,"rubrics")).id,x={...rubric};delete x.id;await setDoc(doc(db,"courses",ref.id,"rubrics",rid),x);}
    closeModal();toast("Course imported as a new Draft catalog course.");await core().loadWorkspace();renderAdminCenter();
  }catch(error){toast(error.message||"Unable to import course package.");}
}

async function versionCourseModal(){
  const courses=state().courses||[];
  const m=modal({eyebrow:"Curriculum Versioning",title:"Create Official Course Snapshot",body:'<form id="courseVersionForm"><div class="field"><label>Course</label><select name="courseId">'+courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select></div><div class="field"><label>Version Label</label><input name="versionLabel" required placeholder="2026.1"></div><div class="field"><label>Revision Note</label><textarea name="note" placeholder="Describe why this snapshot is being created."></textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn">Create Snapshot</button></div></form>'});
  m.querySelector("#courseVersionForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),course=state().courses.find(c=>c.id===String(fd.get("courseId")));if(!course)return;
    try{
      const pkg=await coursePackage(course),label=String(fd.get("versionLabel")).trim();
      const versionId=label.replace(/[^A-Za-z0-9_.-]/g,"_");
      const courseSnapshot={
        code:course.code||"",
        title:course.title||"",
        discipline:course.discipline||"",
        level:course.level||"",
        status:course.status||"",
        description:course.description||"",
        prerequisitePolicy:course.prerequisitePolicy||{},
        entranceExamRequired:course.entranceExamRequired===true
      };
      await setDoc(doc(db,"courses",course.id,"versions",versionId),{
        label,
        versionId,
        note:String(fd.get("note")||"").trim(),
        courseSnapshot,
        frameworkSnapshot:pkg.framework||{competencies:[],units:[]},
        questionCount:(pkg.questions||[]).length,
        rubricCount:(pkg.rubrics||[]).length,
        createdBy:state().user.uid,
        createdAt:serverTimestamp()
      });
      await updateDoc(doc(db,"courses",course.id),{currentVersion:label,currentVersionId:versionId,versionedAt:serverTimestamp(),updatedAt:serverTimestamp()});
      closeModal();toast("Course snapshot "+label+" created.");
    }catch(error){toast(error.message||"Unable to create course snapshot.");}
  };
}

async function generateJoinCode(){
  for(let i=0;i<15;i++){
    const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";let body="THR-";for(let j=0;j<5;j++)body+=chars[Math.floor(Math.random()*chars.length)];
    const x=await getDoc(doc(db,"joinCodes",body));if(!x.exists())return body;
  }
  throw new Error("Unable to generate a unique join code.");
}

async function rolloverModal(){
  const sections=state().sections.filter(s=>s.ownerId===state().user.uid);
  const m=modal({eyebrow:"Term Rollover",title:"Create Next-Term Section",body:'<form id="rolloverForm"><div class="field"><label>Source Section</label><select name="sectionId">'+sections.map(s=>'<option value="'+s.id+'">'+esc((s.courseCode||"Course")+" — "+(s.sectionName||s.courseTitle)+" • "+(s.term||""))+'</option>').join("")+'</select></div><div class="field"><label>New Term</label><input name="term" required placeholder="Spring 2027"></div><div class="field"><label>New Section Name</label><input name="sectionName" required placeholder="Section 01"></div><label class="policy-card"><input type="checkbox" name="copyAssignments" checked><div><strong>Copy assignments</strong><span>Coursework copies without submissions or grades.</span></div></label><label class="policy-card"><input type="checkbox" name="copyResources" checked><div><strong>Copy resources</strong><span>Carry readings and research links forward.</span></div></label><div class="modal-foot" style="margin:24px -24px -24px"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn">Create Rollover</button></div></form>'});
  m.querySelector("#rolloverForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),source=sections.find(s=>s.id===String(fd.get("sectionId")));if(!source)return;
    try{
      const code=await generateJoinCode(),ref=doc(collection(db,"sections"));
      const sourceDoc=await getDoc(doc(db,"sections",source.id)),data=sourceDoc.data();
      await setDoc(ref,{
        ...Object.fromEntries(Object.entries(data).filter(([k])=>!["joinCode","term","sectionName","createdAt","updatedAt","archivedAt","status"].includes(k))),
        ownerId:state().user.uid,joinCode:code,joinOpen:true,term:String(fd.get("term")).trim(),sectionName:String(fd.get("sectionName")).trim(),
        status:"Active",rolloverSourceSectionId:source.id,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      await setDoc(doc(db,"joinCodes",code),{sectionId:ref.id,ownerId:state().user.uid,active:true,createdAt:serverTimestamp()});
      const copyCollection=async name=>{
        const snap=await getDocs(collection(db,"sections",source.id,name));
        for(const d of snap.docs){const x={...d.data()};delete x.createdAt;delete x.updatedAt;await setDoc(doc(db,"sections",ref.id,name,d.id),{...x,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});}
      };
      if(e.currentTarget.elements.copyAssignments.checked)await copyCollection("assignments");
      if(e.currentTarget.elements.copyResources.checked)await copyCollection("resources");
      closeModal();toast("New-term section created with code "+code+".");await core().loadWorkspace();renderAdminCenter();
    }catch(error){toast(error.message||"Unable to roll over the section.");}
  };
}

async function featureFlagsModal(){
  const settings=await getPlatformSettings(),flags=settings.featureFlags||{};
  const definitions=[
    ["planner","Planner & Notifications"],["rubrics","Rubric Library"],["attendance","Attendance"],["groups","Student Groups"],
    ["assessmentSecurity","Assessment Security"],["questionQuality","Question Quality"],["courseVersioning","Course Versioning"],
    ["dataIntegrity","Data Integrity Scanner"],["academicAutomation","Academic Workflow Automation"]
  ];
  const m=modal({eyebrow:"Release Management",title:"Feature Flags & Migrations",wide:true,body:'<form id="featureFlagForm"><div class="policy-grid">'+definitions.map(([id,label])=>'<label class="policy-card"><input type="checkbox" name="'+id+'" '+(flags[id]!==false?'checked':'')+'><div><strong>'+esc(label)+'</strong><span>Enable this platform subsystem.</span></div></label>').join("")+'</div><div class="compact-field-grid" style="margin-top:16px"><div class="field"><label>Release Label</label><input name="releaseLabel" value="'+esc(settings.releaseLabel||"")+'" placeholder="2026.09"></div><div class="field"><label>Migration Checkpoint</label><input name="lastMigration" value="'+esc(settings.lastMigration||"")+'" placeholder="academic-intelligence-v1"></div></div><label class="policy-card"><input type="checkbox" name="maintenanceMode" '+(settings.maintenanceMode?'checked':'')+'><div><strong>Maintenance Mode</strong><span>Display a maintenance notice to signed-in users while preserving System Owner access.</span></div></label><div class="modal-foot" style="margin:24px -24px -24px"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn">Save Platform Configuration</button></div></form>'});
  m.querySelector("#featureFlagForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),featureFlags={};definitions.forEach(([id])=>featureFlags[id]=e.currentTarget.elements[id].checked);
    try{await setDoc(doc(db,"system","platform"),{featureFlags,releaseLabel:String(fd.get("releaseLabel")||"").trim(),lastMigration:String(fd.get("lastMigration")||"").trim(),maintenanceMode:e.currentTarget.elements.maintenanceMode.checked,updatedAt:serverTimestamp(),updatedBy:state().user.uid},{merge:true});closeModal();toast("Platform configuration saved.");renderAdminCenter();}catch(error){toast(error.message||"Unable to save platform configuration.");}
  };
}

async function diagnosticsModal(){
  const checks=[];
  checks.push({name:"Browser Online",ok:navigator.onLine,detail:navigator.onLine?"Network reported online":"Browser reports offline"});
  try{const owner=await getDoc(doc(db,"system","owner"));checks.push({name:"System Owner Record",ok:owner.exists()&&owner.data().uid===state().user.uid,detail:owner.exists()?String(owner.data().email||owner.data().uid):"Missing"});}catch(error){checks.push({name:"System Owner Record",ok:false,detail:error.message});}
  try{const c=await getDocs(collection(db,"courses"));checks.push({name:"Catalog Read",ok:true,detail:c.size+" courses readable"});}catch(error){checks.push({name:"Catalog Read",ok:false,detail:error.message});}
  try{const s=await getDocs(query(collection(db,"sections"),where("ownerId","==",state().user.uid)));checks.push({name:"Section Query",ok:true,detail:s.size+" owned sections"});}catch(error){checks.push({name:"Section Query",ok:false,detail:error.message});}
  try{const p=await getDoc(doc(db,"system","platform"));checks.push({name:"Platform Settings",ok:true,detail:p.exists()?"Configured":"Not yet configured"});}catch(error){checks.push({name:"Platform Settings",ok:false,detail:error.message});}
  modal({eyebrow:"System Diagnostics",title:"Theoria Health Check",body:'<div class="diagnostic-list">'+checks.map(c=>'<div class="diagnostic-row '+(c.ok?'ok':'fail')+'"><span>'+(c.ok?'✓':'!')+'</span><div><strong>'+esc(c.name)+'</strong><small>'+esc(c.detail)+'</small></div></div>').join("")+'</div>'});
}

function systemAnnouncementModal(){
  const m=modal({eyebrow:"Platform Communication",title:"System Announcement",body:'<form id="systemAnnouncementForm"><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Message</label><textarea name="body" required rows="5"></textarea></div><label class="policy-card"><input type="checkbox" name="critical"><div><strong>Critical notice</strong><span>Display with elevated emphasis.</span></div></label><div class="modal-foot" style="margin:24px -24px -24px"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn">Publish</button></div></form>'});
  m.querySelector("#systemAnnouncementForm").onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.currentTarget);try{await setDoc(doc(db,"system","announcement"),{title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),critical:e.currentTarget.elements.critical.checked,active:true,publishedAt:serverTimestamp(),publishedBy:state().user.uid});closeModal();toast("System announcement published.");}catch(error){toast(error.message||"Unable to publish announcement.");}};
}

async function exportPlatform(){
  const courses=state().courses.map(c=>({id:c.id,code:c.code,title:c.title,discipline:c.discipline,level:c.level,status:c.status,catalogPublished:c.catalogPublished,currentVersion:c.currentVersion||"",prerequisitePolicy:c.prerequisitePolicy||{},entranceExamRequired:!!c.entranceExamRequired}));
  const settings=await getPlatformSettings();
  downloadJson("theoria_platform_metadata_"+new Date().toISOString().slice(0,10)+".json",{format:"theoria-platform-metadata",exportedAt:new Date().toISOString(),courses,settings});
}

window.addEventListener("theoria:page",e=>{if(e.detail.page==="admin-center")renderAdminCenter();});
document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-admin-action]");if(!b)return;
  const a=b.dataset.adminAction;
  if(a==="integrity")return integrityModal();
  if(a==="catalog-map")return catalogMapModal();
  if(a==="course-versioning")return versionCourseModal();
  if(a==="rollover")return rolloverModal();
  if(a==="import-export")return importExportModal();
  if(a==="feature-flags")return featureFlagsModal();
  if(a==="diagnostics")return diagnosticsModal();
  if(a==="system-announcement")return systemAnnouncementModal();
  if(a==="export-course")return exportCourseFromModal();
  if(a==="import-course")return importCourseFromModal();
  if(a==="export-platform")return exportPlatform();
});

window.TheoriaAdminTools={renderAdminCenter,scanIntegrity,collectStats,getPlatformSettings};
