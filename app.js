import {
  auth, db, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp
} from "./firebase.js";

const state = {
  role: "student",
  user: null,
  profile: null,
  courses: [],
  sections: [],
  currentCourse: null,
  courseFramework: null,
  currentSection: null,
  sectionData: null,
  isSystemOwner: false
};

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const authShell = $("#authShell");
const appShell = $("#appShell");
const authError = $("#authError");
const signInForm = $("#signInForm");
const registerForm = $("#registerForm");
const sidebar = $("#sidebar");
const toast = $("#toast");
const modalRoot = $("#modalRoot");

function esc(value){
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function showToast(message){
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function humanizeFirebaseError(error){
  const code = error && error.code ? error.code : "";
  const map = {
    "auth/invalid-credential":"The email or password is incorrect.",
    "auth/email-already-in-use":"An account already exists with this email.",
    "auth/weak-password":"Choose a stronger password with at least six characters.",
    "auth/invalid-email":"Enter a valid email address.",
    "auth/too-many-requests":"Too many attempts were made. Please try again later.",
    "permission-denied":"You do not have permission to perform that action."
  };
  return map[code] || (error && error.message) || "Something went wrong. Please try again.";
}

function formatDate(value){
  if(!value) return "Not set";
  const d = value.toDate ? value.toDate() : new Date(value + (String(value).length === 10 ? "T12:00:00" : ""));
  if(Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric"}).format(d);
}

function sortByOrder(items){
  return [...items].sort((a,b) => {
    const ao = Number(a.order ?? 999);
    const bo = Number(b.order ?? 999);
    if(ao !== bo) return ao-bo;
    return String(a.title || a.name || "").localeCompare(String(b.title || b.name || ""));
  });
}

function openModal({title, eyebrow="Theoria", body="", wide=false, footer=""}){
  modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal'+(wide?' wide':'')+'"><div class="modal-head"><div><div class="eyebrow">'+esc(eyebrow)+'</div><h2>'+esc(title)+'</h2></div><button class="modal-close" data-close-modal aria-label="Close">×</button></div><div class="modal-body">'+body+'</div>'+(footer?'<div class="modal-foot">'+footer+'</div>':'')+'</div></div>';
  return modalRoot.querySelector(".modal");
}

function closeModal(){
  modalRoot.innerHTML = "";
}

function switchAuthTab(tab){
  const register = tab === "register";
  $$(".auth-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.authTab === tab));
  signInForm.classList.toggle("hidden", register);
  registerForm.classList.toggle("hidden", !register);
  $("#authHeading").textContent = register ? "Begin your studies." : "Welcome back.";
  $("#authIntro").textContent = register
    ? "Create an account for your Theoria academic environment."
    : "Sign in to continue to your sections, academic work, and progress.";
  authError.textContent = "";
}

async function loadProfile(user){
  for(let attempt=0; attempt<6; attempt++){
    const snap = await getDoc(doc(db,"users",user.uid));
    if(snap.exists()) return snap.data();
    await new Promise(resolve => setTimeout(resolve,200));
  }
  return {
    displayName:user.displayName || (user.email ? user.email.split("@")[0] : "Theoria User"),
    email:user.email,
    role:"student"
  };
}

function applyRole(role){
  const instructor = role === "instructor";
  $$(".instructor-only").forEach(el => el.classList.toggle("hidden", !instructor));
  $$(".student-only").forEach(el => el.classList.toggle("hidden", instructor));
  $("#profileRole").textContent = instructor ? (state.isSystemOwner ? "System Owner · Instructor" : "Instructor") : "Student";
  $("#welcomeSubtitle").textContent = instructor
    ? (state.isSystemOwner
        ? "Author the Theoria course catalog and teach from the same official frameworks and Question Banks."
        : "Teach from official Theoria catalog courses, build assessments, and manage your sections.")
    : "Your theological studies, sections, academic work, and progress in one place.";
}

function renderUser(user,profile){
  const name = (profile && profile.displayName) || user.displayName || (user.email ? user.email.split("@")[0] : "Theoria User");
  const first = name.trim().split(/\s+/)[0];
  $("#profileName").textContent = name;
  $("#profileAvatar").textContent = (name.trim()[0] || "T").toUpperCase();
  $("#welcomeTitle").textContent = "Welcome, " + first + ".";
  state.role = profile && profile.role === "instructor" ? "instructor" : "student";
  applyRole(state.role);
}

function canManageCourse(course){
  if(!course||state.role!=="instructor"||!state.user)return false;
  if(state.isSystemOwner)return true;
  return course.catalogCourse!==true && course.ownerId===state.user.uid;
}

function isOfficialCatalogCourse(course){
  return !!course?.catalogCourse;
}

function applyOwnerUI(){
  Array.from(document.querySelectorAll(".owner-only")).forEach(el=>el.classList.toggle("hidden",!state.isSystemOwner));
}

function setPage(page,label){
  $$(".page").forEach(el => el.classList.toggle("active", el.id === "page-" + page));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const active = document.querySelector('.nav-item[data-page="' + page + '"]');
  $("#breadcrumbCurrent").textContent = label || (active ? active.textContent.trim() : page.charAt(0).toUpperCase()+page.slice(1));
  sidebar.classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
  window.dispatchEvent(new CustomEvent("theoria:page",{detail:{page,label:label||null}}));
  if(page==="library") renderScholarLibrary().catch(error=>{
    console.error("Unable to load Library:",error);
    showToast("The Library could not be loaded.");
  });
}

async function loadWorkspace(){
  if(!state.user) return;

  if(state.role === "instructor"){
    let courses=[];
    if(state.isSystemOwner){
      const snap=await getDocs(collection(db,"courses"));
      courses=snap.docs.map(d=>({id:d.id,...d.data()}));

      // Migrate the owner's existing active course frameworks into the official catalog model.
      for(const course of courses){
        if(course.ownerId===state.user.uid && course.catalogCourse===undefined){
          const catalogPublished=course.status!=="Draft"&&course.status!=="Archived";
          try{
            await updateDoc(doc(db,"courses",course.id),{
              catalogCourse:true,
              catalogPublished,
              catalogManaged:true,
              catalogUpdatedAt:serverTimestamp(),
              updatedAt:serverTimestamp()
            });
            course.catalogCourse=true;
            course.catalogPublished=catalogPublished;
            course.catalogManaged=true;
          }catch(error){
            console.warn("Unable to migrate course into Theoria catalog:",course.id,error);
          }
        }
      }
    }else{
      const [catalogSnap,ownedSnap]=await Promise.all([
        getDocs(query(collection(db,"courses"),where("catalogPublished","==",true))),
        getDocs(query(collection(db,"courses"),where("ownerId","==",state.user.uid)))
      ]);
      const byId=new Map();
      catalogSnap.docs.forEach(d=>byId.set(d.id,{id:d.id,...d.data()}));
      ownedSnap.docs.forEach(d=>byId.set(d.id,{id:d.id,...d.data()}));
      courses=[...byId.values()];
    }
    state.courses=courses;

    const sectionSnap = await getDocs(query(collection(db,"sections"),where("ownerId","==",state.user.uid)));
    state.sections = sectionSnap.docs.map(d => ({id:d.id,...d.data()}));
  }else{
    const enrollmentSnap = await getDocs(collection(db,"users",state.user.uid,"enrollments"));
    const sections = [];
    for(const enrollDoc of enrollmentSnap.docs){
      const s = await getDoc(doc(db,"sections",enrollDoc.id));
      if(s.exists()) sections.push({id:s.id,...s.data()});
    }
    state.sections = sections;
    const uniqueCourseIds = [...new Set(sections.map(s => s.courseId).filter(Boolean))];
    const courses = [];
    for(const id of uniqueCourseIds){
      const c = await getDoc(doc(db,"courses",id));
      if(c.exists()) courses.push({id:c.id,...c.data()});
    }
    state.courses = courses;
  }

  state.courses.sort((a,b)=>String(a.code||"").localeCompare(String(b.code||"")));
  state.sections.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||"")));
  applyOwnerUI();
  renderHome();
  renderCourses();
  renderSections();
}

function sectionCard(section){
  const live = section.joinOpen !== false;
  return '<article class="academic-card">'+
    '<div class="card-kicker">'+esc(section.courseCode || "THEO")+' • '+esc(section.term || "Academic Term")+'</div>'+
    '<h3>'+esc(section.courseTitle || section.sectionName || "Untitled Section")+'</h3>'+
    '<p>'+esc(section.sectionName || ("Section "+(section.sectionNumber||"001")))+'</p>'+
    '<div class="card-meta"><span>'+esc(section.format || "Course")+'</span><span>'+esc(section.sectionNumber ? "Section "+section.sectionNumber : "Section")+'</span>'+(state.role==="instructor"?'<span class="badge '+(live?'live':'closed')+'">'+(live?'Enrollment Open':'Enrollment Closed')+'</span>':'')+'</div>'+
    '<div class="card-actions"><button class="secondary-btn small-btn" data-action="open-section" data-id="'+section.id+'">Open Section</button>'+(state.role==="instructor"?'<button class="text-btn" data-action="copy-code" data-code="'+esc(section.joinCode||"")+'">'+esc(section.joinCode||"No Code")+'</button>':'')+'</div>'+
  '</article>';
}

function courseCard(course){
  const official=isOfficialCatalogCourse(course);
  const manager=canManageCourse(course);
  return '<article class="academic-card catalog-course-card">'+
    '<div class="card-kicker">'+esc(course.code || "THEO")+' • '+esc(course.level || "Advanced")+'</div>'+
    '<div class="catalog-course-title-row"><h3>'+esc(course.title || "Untitled Course")+'</h3>'+(official?'<span class="badge '+(course.catalogPublished?'live':'gold')+'">'+(course.catalogPublished?'Official Catalog':'Catalog Draft')+'</span>':'<span class="badge">Custom</span>')+'</div>'+
    '<p>'+esc(course.description || "No course description has been added yet.")+'</p>'+
    '<div class="card-meta"><span>'+esc(course.discipline || "Theology")+'</span><span>'+esc(course.status || "Active")+'</span>'+(official?'<span>Master framework + Question Bank</span>':'')+(course.entranceExamRequired?'<span class="badge gold">Entrance Exam Required</span>':'')+'</div>'+
    '<div class="card-actions"><button class="secondary-btn small-btn" data-action="open-course" data-id="'+course.id+'">'+(manager?'Manage Course':'View Course')+'</button>'+
      (state.role==="instructor"&&(course.catalogPublished!==false||manager)?'<button class="primary-btn small-btn" data-action="create-section-course" data-id="'+course.id+'">Create Section</button>':'')+
    '</div>'+
  '</article>';
}

function renderHome(){
  const sectionCount=state.sections.length;
  const courseCount=state.courses.length;
  const openEnrollmentCount=state.sections.filter(s=>s.joinOpen!==false).length;
  const academicTerms=[...new Set(state.sections.map(s=>String(s.term||"").trim()).filter(Boolean))];
  const disciplines=[...new Set(state.courses.map(c=>String(c.discipline||"").trim()).filter(Boolean))];

  $("#homeStats").innerHTML = state.role === "instructor"
    ? '<div class="stat"><div class="stat-label">Teaching Sections</div><div class="stat-value">'+sectionCount+'</div><div class="stat-note">Owned sections</div></div>'+
      '<div class="stat"><div class="stat-label">Course Frameworks</div><div class="stat-value">'+courseCount+'</div><div class="stat-note">Reusable curricula</div></div>'+
      '<div class="stat"><div class="stat-label">Enrollment Open</div><div class="stat-value">'+openEnrollmentCount+'</div><div class="stat-note">Sections accepting join codes</div></div>'+
      '<div class="stat"><div class="stat-label">Academic Terms</div><div class="stat-value">'+academicTerms.length+'</div><div class="stat-note">Represented in your sections</div></div>'
    : '<div class="stat"><div class="stat-label">Enrolled Sections</div><div class="stat-value">'+sectionCount+'</div><div class="stat-note">Current teaching spaces</div></div>'+
      '<div class="stat"><div class="stat-label">Course Frameworks</div><div class="stat-value">'+courseCount+'</div><div class="stat-note">Available through enrollment</div></div>'+
      '<div class="stat"><div class="stat-label">Academic Terms</div><div class="stat-value">'+academicTerms.length+'</div><div class="stat-note">Represented in your sections</div></div>'+
      '<div class="stat"><div class="stat-label">Disciplines</div><div class="stat-value">'+disciplines.length+'</div><div class="stat-note">Areas of theological study</div></div>';

  $("#homeSections").innerHTML = state.sections.length
    ? '<div class="card-grid">'+state.sections.slice(0,3).map(sectionCard).join("")+'</div>'
    : '<div class="empty-state"><div class="empty-symbol">Θ</div><h3>No active sections yet.</h3><p>'+(state.role==="instructor"?"Create a course framework, then create a teaching section from it.":"Join a section with the code provided by your instructor.")+'</p>'+(state.role==="student"?'<button class="primary-btn" data-go="sections">Join a Section</button>':'<button class="primary-btn" data-action="create-section">Create Section</button>')+'</div>';

  const thirdNumber=state.role==="instructor"?openEnrollmentCount:academicTerms.length;
  const thirdTitle=state.role==="instructor"?"Sections accepting enrollment":"Academic terms";
  const thirdCopy=state.role==="instructor"
    ? (openEnrollmentCount?"These sections currently accept student join codes.":"No sections currently accept new enrollment.")
    : (academicTerms.length?"Your current sections span "+academicTerms.length+" academic term"+(academicTerms.length===1?"":"s")+".":"No academic term data is available yet.");

  $("#homeAttention").innerHTML = '<div class="attention-list">'+
    '<div class="attention-item"><div class="attention-number">'+sectionCount+'</div><div class="attention-copy"><strong>'+(state.role==="instructor"?"Teaching sections":"Current sections")+'</strong><span>'+(sectionCount?"Open a section to review its framework, work, assessments, and records.":"No sections are currently connected to this account.")+'</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+courseCount+'</div><div class="attention-copy"><strong>Course frameworks</strong><span>Units, topics, objectives, essential knowledge, and competencies currently available to this account.</span></div></div>'+
    '<div class="attention-item"><div class="attention-number">'+thirdNumber+'</div><div class="attention-copy"><strong>'+thirdTitle+'</strong><span>'+thirdCopy+'</span></div></div>'+
  '</div>';
}

function renderCourses(){
  const el=$("#coursesContent");
  if(!state.courses.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">C</div><h3>No courses are available yet.</h3><p>'+(state.isSystemOwner?"Create the first official Theoria catalog course.":"The system owner has not published a Theoria course yet.")+'</p>'+(state.isSystemOwner?'<button class="primary-btn" data-action="create-course">Create Catalog Course</button>':'')+'</div>';
    return;
  }

  const official=state.courses.filter(c=>c.catalogCourse&& (state.isSystemOwner||c.catalogPublished));
  const custom=state.courses.filter(c=>!c.catalogCourse);

  el.innerHTML=
    '<div class="academic-banner catalog-banner"><div class="kicker">Theoria Course Catalog</div><h3>Courses are built once, then taught in sections.</h3><p>Official courses include a system-managed Course Framework and master Question Bank. Instructors create teaching sections from the catalog instead of rebuilding curriculum.</p></div>'+
    (official.length?'<section class="catalog-course-section"><div class="page-head compact-head"><div><div class="panel-title">Official Theoria Courses</div><p class="page-subtitle">'+official.length+' centrally managed course'+(official.length===1?"":"s")+'.</p></div>'+(state.isSystemOwner?'<div class="inline-actions"><button class="secondary-btn small-btn" data-action="bulk-create-courses">Bulk Add with AI</button><button class="primary-btn small-btn" data-action="create-course">Create Catalog Course</button></div>':'')+'</div><div class="card-grid">'+official.map(courseCard).join("")+'</div></section>':'')+
    (custom.length?'<section class="catalog-course-section custom-course-section"><div class="page-head compact-head"><div><div class="panel-title">Custom / Legacy Courses</div><p class="page-subtitle">Instructor-owned courses outside the official catalog.</p></div></div><div class="card-grid">'+custom.map(courseCard).join("")+'</div></section>':'');
}

function renderSections(){
  const el = $("#sectionsContent");
  if(!state.sections.length){
    el.innerHTML = '<div class="empty-state"><div class="empty-symbol">S</div><h3>No '+(state.role==="instructor"?"teaching":"enrolled")+' sections yet.</h3><p>'+(state.role==="instructor"?"Create a section from one of your course frameworks. Theoria will issue a join code automatically.":"Use the join code above to enter a section.")+'</p>'+(state.role==="instructor"?'<button class="primary-btn" data-action="create-section">Create Section</button>':'')+'</div>';
    return;
  }
  el.innerHTML = '<div class="card-grid">'+state.sections.map(sectionCard).join("")+'</div>';
}

async function generateJoinCode(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for(let attempt=0; attempt<12; attempt++){
    let suffix="";
    for(let i=0;i<5;i++) suffix += chars[Math.floor(Math.random()*chars.length)];
    const code="THR-"+suffix;
    const existing=await getDoc(doc(db,"joinCodes",code));
    if(!existing.exists()) return code;
  }
  throw new Error("Unable to generate a unique join code.");
}


function bulkCourseCreatorPrompt(requestText=""){
  const existingCodes=state.courses.map(c=>String(c.code||"").trim().toUpperCase()).filter(Boolean);
  const request=String(requestText||"").trim();
  return [
    "Create a batch of official Theoria catalog courses.",
    "",
    request?"COURSE CREATION REQUEST: "+request:"COURSE CREATION REQUEST: Build a coherent set of academically rigorous courses suitable for the Theoria catalog.",
    "",
    "Return ONLY valid JSON. Do not use Markdown fences, commentary, headings, or explanatory prose.",
    "Return one object with a single courses array.",
    "",
    "Use this structure:",
    "{",
    '  "courses": [',
    "    {",
    '      "code": "APOL 01",',
    '      "title": "Advanced Christian Apologetics",',
    '      "discipline": "Apologetics",',
    '      "level": "Advanced",',
    '      "status": "Draft",',
    '      "description": "A concise catalog description.",',
    '      "catalogPublished": false,',
    '      "framework": {',
    '        "competencies": [',
    '          {"code":"ARG-1","name":"Argument Analysis","description":"Evaluate arguments with precision.","order":1}',
    "        ],",
    '        "units": [',
    "          {",
    '            "order": 1,',
    '            "title": "Foundations",',
    '            "description": "Unit scope and purpose.",',
    '            "topics": [',
    '              {"number":"1.1","title":"Core Questions","learningObjective":"Analyze the central questions of the field.","essentialKnowledge":"Key concepts, terms, sources, and debates.","competencyCodes":["ARG-1"],"order":1}',
    "            ]",
    "          }",
    "        ]",
    "      }",
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Every course must have a unique, concise course code and a clear academic title.",
    '- level must be one of: "Introductory", "Intermediate", "Advanced", "Graduate-style".',
    '- status must be one of: "Draft", "Active", "Archived". Use Draft unless I explicitly ask for another status.',
    "- catalogPublished should normally be false so the System Owner can review the course before publishing it.",
    "- Include a complete framework for each course unless my request explicitly asks for course shells only.",
    "- Framework competencies must use unique stable codes within each course.",
    "- Unit order values must be unique positive integers within each course.",
    "- Topic numbers must be unique within each course and normally follow the unit pattern 1.1, 1.2, 2.1, and so on.",
    "- learningObjective should describe what students should understand, analyze, evaluate, synthesize, or defend.",
    "- essentialKnowledge should identify the concrete knowledge students are expected to retain.",
    "- competencyCodes on topics may reference competencies created in that same course framework.",
    "- Do not use any existing course code listed below.",
    "",
    "EXISTING THEORIA COURSE CODES:",
    ...(existingCodes.length?existingCodes:["None yet."])
  ].join("\n");
}

function stripBulkCourseJsonFence(text){
  let value=String(text||"").trim();
  value=value.replace(/^\s*\`\`\`(?:json)?\s*/i,"").replace(/\s*\`\`\`\s*$/,"").trim();
  const firstArray=value.indexOf("["),firstObject=value.indexOf("{");
  if(firstArray>=0&&(firstObject<0||firstArray<firstObject)){
    const last=value.lastIndexOf("]");
    if(last>firstArray)return value.slice(firstArray,last+1);
  }
  if(firstObject>=0){
    const last=value.lastIndexOf("}");
    if(last>firstObject)return value.slice(firstObject,last+1);
  }
  return value;
}

function normalizeBulkCourseImport(payload){
  const rawCourses=Array.isArray(payload)?payload:(Array.isArray(payload?.courses)?payload.courses:[]);
  const existingCodes=new Set(state.courses.map(c=>String(c.code||"").trim().toUpperCase()).filter(Boolean));
  const seenCodes=new Set();
  const allowedLevels=new Set(["Introductory","Intermediate","Advanced","Graduate-style"]);
  const allowedStatuses=new Set(["Draft","Active","Archived"]);
  const rows=[];

  if(!rawCourses.length){
    return {errors:["The JSON must contain at least one course."],rows:[],summary:{newCourses:0,skippedCourses:0,invalid:1,units:0,topics:0,competencies:0}};
  }

  rawCourses.forEach((raw,index)=>{
    const errors=[],warnings=[];
    if(!raw||typeof raw!=="object"||Array.isArray(raw)){
      rows.push({index,status:"invalid",errors:["Course "+(index+1)+" is not an object."],warnings,data:null,framework:null});
      return;
    }

    const code=String(raw.code||"").trim().toUpperCase();
    const title=String(raw.title||"").trim();
    if(!code)errors.push("Course code is required.");
    if(!title)errors.push("Course title is required.");
    if(code&&seenCodes.has(code))errors.push("Duplicate course code in this import: "+code);
    if(code)seenCodes.add(code);

    let level=String(raw.level||"Advanced").trim();
    if(!allowedLevels.has(level)){
      warnings.push('Unknown academic level "'+level+'"; defaulted to Advanced.');
      level="Advanced";
    }

    let status=String(raw.status||"Draft").trim();
    if(!allowedStatuses.has(status)){
      warnings.push('Unknown status "'+status+'"; defaulted to Draft.');
      status="Draft";
    }

    const existing=code&&existingCodes.has(code);
    if(existing)warnings.push("Course "+code+" already exists and will be skipped.");

    const frameworkPayload=(raw.framework&&typeof raw.framework==="object"&&!Array.isArray(raw.framework))
      ? raw.framework
      : {competencies:Array.isArray(raw.competencies)?raw.competencies:[],units:Array.isArray(raw.units)?raw.units:[]};
    const hasFramework=(Array.isArray(frameworkPayload.competencies)&&frameworkPayload.competencies.length)
      ||(Array.isArray(frameworkPayload.units)&&frameworkPayload.units.length);
    const framework=hasFramework?normalizeFrameworkImport(frameworkPayload,{competencies:[],units:[]}):null;
    if(framework?.summary?.invalid>0)errors.push("Course Framework contains "+framework.summary.invalid+" invalid record"+(framework.summary.invalid===1?"":"s")+".");
    if(!hasFramework)warnings.push("No framework supplied; this will create a course shell only.");

    const catalogPublished=raw.catalogPublished===true&&status!=="Draft";
    if(raw.catalogPublished===true&&status==="Draft")warnings.push("Draft courses cannot be auto-published; catalogPublished was set to false.");

    rows.push({
      index,
      status:errors.length?"invalid":existing?"skip":"new",
      errors,warnings,existing,
      data:errors.length?null:{
        code,title,
        discipline:String(raw.discipline||"Theology").trim()||"Theology",
        level,status,
        description:String(raw.description||"").trim(),
        catalogPublished
      },
      framework
    });
  });

  const errors=rows.flatMap(r=>r.errors);
  return {
    errors,
    rows,
    summary:{
      newCourses:rows.filter(r=>r.status==="new").length,
      skippedCourses:rows.filter(r=>r.status==="skip").length,
      invalid:rows.filter(r=>r.status==="invalid").length,
      competencies:rows.filter(r=>r.status==="new").reduce((n,r)=>n+(r.framework?.summary?.newCompetencies||0),0),
      units:rows.filter(r=>r.status==="new").reduce((n,r)=>n+(r.framework?.summary?.newUnits||0),0),
      topics:rows.filter(r=>r.status==="new").reduce((n,r)=>n+(r.framework?.summary?.newTopics||0),0)
    }
  };
}

async function writeNewCourseFramework(courseId,normalized){
  if(!normalized)return {competencies:0,units:0,topics:0};
  const newCompetencies=normalized.competencies.filter(r=>r.status==="new");
  const newUnits=normalized.units.filter(r=>r.status==="new");
  const newTopics=normalized.units.flatMap(unit=>(unit.topics||[]).filter(topic=>topic.status==="new").map(topic=>({unit,topic})));

  const compRefByCode=new Map();
  for(const row of newCompetencies){
    compRefByCode.set(row.data.code,doc(collection(db,"courses",courseId,"competencies")));
  }

  const unitRefByOrder=new Map();
  for(const row of newUnits){
    unitRefByOrder.set(Number(row.data.order),doc(collection(db,"courses",courseId,"units")));
  }

  const operations=[];
  for(const row of newCompetencies){
    const ref=compRefByCode.get(row.data.code);
    operations.push(batch=>batch.set(ref,{
      code:row.data.code,name:row.data.name,description:row.data.description,order:row.data.order,
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    }));
  }

  for(const row of newUnits){
    const ref=unitRefByOrder.get(Number(row.data.order));
    operations.push(batch=>batch.set(ref,{
      order:row.data.order,title:row.data.title,description:row.data.description,
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    }));
  }

  for(const pair of newTopics){
    const unitRef=unitRefByOrder.get(Number(pair.unit.data?.order));
    if(!unitRef)throw new Error("Unable to resolve Unit "+(pair.unit.data?.order||"?")+" for "+pair.topic.data.number+".");
    const competencyIds=[],competencyCodes=[];
    for(const code of pair.topic.data.competencyCodes||[]){
      const ref=compRefByCode.get(code);
      if(ref){competencyIds.push(ref.id);competencyCodes.push(code);}
    }
    const topicRef=doc(collection(db,"courses",courseId,"units",unitRef.id,"topics"));
    operations.push(batch=>batch.set(topicRef,{
      number:pair.topic.data.number,title:pair.topic.data.title,
      learningObjective:pair.topic.data.learningObjective,
      essentialKnowledge:pair.topic.data.essentialKnowledge,
      competencyIds,competencyCodes,order:pair.topic.data.order,
      createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    }));
  }

  for(let offset=0;offset<operations.length;offset+=400){
    const batch=writeBatch(db);
    operations.slice(offset,offset+400).forEach(apply=>apply(batch));
    await batch.commit();
  }

  return {competencies:newCompetencies.length,units:newUnits.length,topics:newTopics.length};
}

function bulkCreateCoursesModal(){
  if(!state.isSystemOwner)return showToast("Only the Theoria system owner can bulk-create catalog courses.");
  let normalized=null;

  const modal=openModal({
    eyebrow:"Theoria Catalog Authoring",
    title:"Bulk Add Courses with AI",
    wide:true,
    body:'<div class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Tell AI What to Build</h3><p>Describe the catalog courses you want. Theoria will generate a structured ChatGPT prompt that includes the required JSON schema and your existing course codes.</p></div></div>'+
        '<div class="field"><label>Course Set Request</label><textarea id="bulkCourseRequest" class="editor-compact" rows="4" placeholder="Example: Create 8 upper-level theology courses covering biblical studies, church history, apologetics, philosophy of religion, and hermeneutics. Include complete frameworks."></textarea></div>'+
        '<div class="bulk-import-prompt-row"><div><strong>Generate the courses in ChatGPT</strong><span>Copy this prompt, give it to ChatGPT, then paste the returned JSON below.</span></div><button type="button" class="secondary-btn" id="copyBulkCoursePrompt">Copy AI Course Creator Prompt</button></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Add Course JSON</h3><p>Paste the AI response or upload a JSON file. Existing course codes are skipped instead of overwritten.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>JSON File</label><input id="bulkCourseFile" type="file" accept=".json,application/json"></div><div class="field"><label>Import Mode</label><div class="static-field">Safe create — existing course codes are never overwritten</div></div></div>'+
        '<div class="field"><label>Paste Courses</label><textarea id="bulkCourseJson" class="bulk-json-editor" spellcheck="false" placeholder=\'{"courses":[{"code":"APOL 01","title":"Advanced Christian Apologetics",...}]}\'></textarea></div>'+
        '<button type="button" class="primary-btn" id="previewBulkCourses">Validate & Preview</button>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Import Preview</h3><p>Review every course and its framework totals before anything is written to Firestore.</p></div><div id="bulkCourseSummary"></div></div><div id="bulkCourseResults"><div class="empty-mini">Paste or upload course JSON, then validate it.</div></div></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="importBulkCourses" disabled>Create Courses</button></div>'+
    '</div>'
  });

  const requestBox=modal.querySelector("#bulkCourseRequest");
  const textarea=modal.querySelector("#bulkCourseJson");
  const fileInput=modal.querySelector("#bulkCourseFile");
  const summary=modal.querySelector("#bulkCourseSummary");
  const results=modal.querySelector("#bulkCourseResults");
  const importButton=modal.querySelector("#importBulkCourses");

  const resetPreview=()=>{
    normalized=null;summary.innerHTML="";
    results.innerHTML='<div class="empty-mini">Validate the current course JSON before importing.</div>';
    importButton.disabled=true;importButton.textContent="Create Courses";
  };

  modal.querySelector("#copyBulkCoursePrompt").addEventListener("click",async()=>{
    const prompt=bulkCourseCreatorPrompt(requestBox.value);
    try{
      await navigator.clipboard.writeText(prompt);
      showToast("AI Course Creator prompt copied.");
    }catch(_){
      showToast("Clipboard access was unavailable. Try again from a secure browser tab.");
    }
  });

  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{textarea.value=await file.text();resetPreview();}catch(_){showToast("The JSON file could not be read.");}
  });
  textarea.addEventListener("input",resetPreview);

  modal.querySelector("#previewBulkCourses").addEventListener("click",()=>{
    let payload;
    try{
      payload=JSON.parse(stripBulkCourseJsonFence(textarea.value));
    }catch(error){
      normalized=null;
      summary.innerHTML='<span class="badge danger">Invalid JSON</span>';
      results.innerHTML='<div class="notice danger-notice">'+esc(error.message||"The course data is not valid JSON.")+'</div>';
      importButton.disabled=true;
      return;
    }

    normalized=normalizeBulkCourseImport(payload);
    const s=normalized.summary;
    summary.innerHTML='<div class="bulk-preview-counts">'+
      '<span><strong>'+s.newCourses+'</strong> new courses</span>'+
      '<span><strong>'+s.units+'</strong> units</span>'+
      '<span><strong>'+s.topics+'</strong> topics</span>'+
      '<span><strong>'+s.competencies+'</strong> competencies</span>'+
      '<span><strong>'+s.skippedCourses+'</strong> skipped</span>'+
      '<span><strong>'+s.invalid+'</strong> invalid</span>'+
      '</div>';

    results.innerHTML='<div class="bulk-preview-list">'+normalized.rows.map(row=>{
      const d=row.data||{};
      const fs=row.framework?.summary;
      const statusText=row.status==="new"?"Create course":row.status==="skip"?"Already exists — skip":"Invalid";
      return '<div class="bulk-preview-row '+(row.status==="invalid"?'invalid':row.status==="skip"?'warning':'valid')+'">'+
        '<div class="bulk-preview-number">'+esc(String(row.index+1).padStart(2,"0"))+'</div><div>'+
        '<strong>'+esc(d.code||"Invalid course")+(d.title?' — '+esc(d.title):'')+'</strong>'+
        '<span>'+statusText+(d.level?' • '+esc(d.level):'')+(d.catalogPublished?' • Publish to catalog':' • Catalog draft')+'</span>'+
        (fs?'<div class="bulk-course-framework-line">'+fs.newUnits+' units • '+fs.newTopics+' topics • '+fs.newCompetencies+' competencies</div>':'<div class="bulk-course-framework-line">Course shell only</div>')+
        (row.errors.length?'<div class="bulk-messages errors">'+row.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
        (row.warnings.length?'<div class="bulk-messages warnings">'+row.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
        '</div></div>';
    }).join("")+'</div>';

    importButton.disabled=!s.newCourses||s.invalid>0;
    importButton.textContent=s.invalid>0?"Fix Invalid Courses":"Create "+s.newCourses+" Course"+(s.newCourses===1?"":"s");
  });

  importButton.addEventListener("click",async()=>{
    if(!normalized)return;
    const s=normalized.summary;
    if(s.invalid>0)return showToast("Fix invalid courses before importing.");
    const rows=normalized.rows.filter(r=>r.status==="new");
    if(!rows.length)return showToast("There are no new courses to create.");

    importButton.disabled=true;importButton.textContent="Creating Courses…";
    let created=0,frameworks=0;
    const failures=[],frameworkFailures=[];

    for(const row of rows){
      const courseRef=doc(collection(db,"courses"));
      let courseCreated=false;
      try{
        await setDoc(courseRef,{
          ...row.data,
          catalogCourse:true,
          catalogManaged:true,
          ownerId:state.user.uid,
          catalogUpdatedAt:serverTimestamp(),
          createdAt:serverTimestamp(),
          updatedAt:serverTimestamp()
        });
        courseCreated=true;
        created++;
        if(row.framework){
          try{
            await writeNewCourseFramework(courseRef.id,row.framework);
            frameworks++;
          }catch(error){
            console.error("Framework creation failed for",row.data?.code,error);
            frameworkFailures.push((row.data?.code||"Course")+" — course created, but its framework needs attention: "+humanizeFirebaseError(error));
          }
        }
      }catch(error){
        console.error("Bulk course creation failed for",row.data?.code,error);
        if(!courseCreated)failures.push((row.data?.code||"Course")+" — "+humanizeFirebaseError(error));
      }
    }

    await loadWorkspace();
    if(!failures.length&&!frameworkFailures.length){
      closeModal();
      showToast("Created "+created+" catalog course"+(created===1?"":"s")+(frameworks?" with "+frameworks+" framework"+(frameworks===1?"":"s"):"")+".");
    }else{
      // Revalidate against the refreshed catalog so already-created codes become
      // safe skips. This prevents accidental duplicates on a second attempt.
      modal.querySelector("#previewBulkCourses").click();
      const messages=[
        ...failures.map(x=>"Not created: "+x),
        ...frameworkFailures
      ];
      results.insertAdjacentHTML("afterbegin",'<div class="notice danger-notice"><strong>Bulk creation completed with issues.</strong><p>Re-run the remaining course JSON after reviewing the messages below. Courses whose shells were created are now protected from duplication; incomplete frameworks can be finished with Bulk Import Framework.</p><div class="bulk-messages errors">'+messages.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div></div>');
      showToast(created+" course"+(created===1?"":"s")+" created; "+messages.length+" item"+(messages.length===1?"":"s")+" need attention.");
    }
  });
}

function openCourseModal(existing){
  const editing=!!existing;
  if(!editing&&!state.isSystemOwner)return showToast("Only the Theoria system owner can create official catalog courses.");
  if(editing&&!canManageCourse(existing))return showToast("This official course is managed by the Theoria system owner.");
  const modal = openModal({
    eyebrow:"Course Framework",
    title:editing?"Edit Course":"Create Course",
    body:'<form id="courseForm"><div class="form-grid">'+
      '<div class="field"><label>Course Code</label><input name="code" maxlength="16" placeholder="APOL 301" value="'+esc(existing?.code||"")+'" required></div>'+
      '<div class="field"><label>Academic Level</label><select name="level"><option>Advanced</option><option>Intermediate</option><option>Introductory</option><option>Graduate-style</option></select></div>'+
      '<div class="field span-2"><label>Course Title</label><input name="title" placeholder="Advanced Christian Apologetics" value="'+esc(existing?.title||"")+'" required></div>'+
      '<div class="field"><label>Discipline</label><input name="discipline" placeholder="Apologetics" value="'+esc(existing?.discipline||"")+'"></div>'+
      '<div class="field"><label>Status</label><select name="status"><option>Active</option><option>Draft</option><option>Archived</option></select></div>'+
      (state.isSystemOwner?'<div class="field"><label>Catalog Visibility</label><select name="catalogPublished"><option value="false">Catalog Draft — Owner Only</option><option value="true">Published to Instructors</option></select></div>':'')+
      '<div class="field span-2"><label>Description</label><textarea name="description" placeholder="Describe the scope and academic purpose of this course.">'+esc(existing?.description||"")+'</textarea></div>'+
      (state.isSystemOwner?'<div class="field span-2"><label class="policy-card"><input type="checkbox" name="entranceExamRequired" '+(existing?.entranceExamRequired?'checked':'')+'><div><strong>Require an Entrance Examination</strong><span>Every section of this course must use an instructor-configured entrance assessment before a student can enroll.</span></div></label></div>':'')+
    '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(editing?"Save Changes":"Create Course")+'</button></div></form>'
  });
  const form=modal.querySelector("#courseForm");
  if(existing){
    form.level.value=existing.level||"Advanced";
    form.status.value=existing.status||"Active";
    if(form.elements.catalogPublished)form.elements.catalogPublished.value=String(existing.catalogPublished===true);
  }else if(form.elements.catalogPublished){
    form.elements.catalogPublished.value="false";
  }
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const data={
      code:String(fd.get("code")).trim().toUpperCase(),
      title:String(fd.get("title")).trim(),
      level:String(fd.get("level")),
      discipline:String(fd.get("discipline")).trim()||"Theology",
      status:String(fd.get("status")),
      description:String(fd.get("description")).trim(),
      ...(state.isSystemOwner?{
        catalogCourse:true,
        catalogManaged:true,
        catalogPublished:String(fd.get("catalogPublished"))==="true",
        entranceExamRequired:form.elements.entranceExamRequired?.checked===true,
        catalogUpdatedAt:serverTimestamp()
      }:{}),
      updatedAt:serverTimestamp()
    };
    try{
      if(editing) await updateDoc(doc(db,"courses",existing.id),data);
      else await addDoc(collection(db,"courses"),{...data,ownerId:state.user.uid,createdAt:serverTimestamp()});
      closeModal();
      await loadWorkspace();
      showToast(editing?"Course updated.":"Catalog course created. Build its framework and Question Bank, then publish it when ready.");
    }catch(error){ showToast(humanizeFirebaseError(error)); }
  });
}

function openSectionModal(existing,preferredCourseId=""){
  if(!state.courses.length){
    showToast("Create a course framework before creating a section.");
    setPage("courses");
    return;
  }
  const editing=!!existing;
  const courseOptions=state.courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("");
  const modal=openModal({
    eyebrow:"Teaching Section",
    title:editing?"Edit Section":"Create Section",
    body:'<form id="sectionForm"><div class="form-grid">'+
      '<div class="field span-2"><label>Course</label><select name="courseId" '+(editing?'disabled':'')+'>'+courseOptions+'</select></div>'+
      '<div class="field"><label>Section Number</label><input name="sectionNumber" placeholder="001" value="'+esc(existing?.sectionNumber||"001")+'" required></div>'+
      '<div class="field"><label>Academic Term</label><input name="term" placeholder="Fall 2026" value="'+esc(existing?.term||"")+'" required></div>'+
      '<div class="field span-2"><label>Section Name</label><input name="sectionName" placeholder="Advanced Christian Apologetics — Section 001" value="'+esc(existing?.sectionName||"")+'"></div>'+
      '<div class="field"><label>Format</label><select name="format"><option>In Person</option><option>Online</option><option>Hybrid</option><option>Self-Paced</option></select></div>'+
      '<div class="field"><label>Enrollment</label><select name="joinOpen"><option value="true">Join Code — Open</option><option value="false">Enrollment Closed</option></select></div>'+
      '<div class="field"><label>Start Date</label><input type="date" name="startDate" value="'+esc(existing?.startDate||"")+'"></div>'+
      '<div class="field"><label>End Date</label><input type="date" name="endDate" value="'+esc(existing?.endDate||"")+'"></div>'+
    '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(editing?"Save Changes":"Create Section")+'</button></div></form>'
  });
  const form=modal.querySelector("#sectionForm");
  if(existing){
    form.courseId.value=existing.courseId;
    form.format.value=existing.format||"In Person";
    form.joinOpen.value=String(existing.joinOpen!==false);
  }else if(preferredCourseId&&state.courses.some(c=>c.id===preferredCourseId)){
    form.courseId.value=preferredCourseId;
  }
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    try{
      if(editing){
        const data={
          sectionNumber:String(fd.get("sectionNumber")).trim(),
          term:String(fd.get("term")).trim(),
          sectionName:String(fd.get("sectionName")).trim() || existing.courseTitle+" — Section "+String(fd.get("sectionNumber")).trim(),
          format:String(fd.get("format")),
          joinOpen:String(fd.get("joinOpen"))==="true",
          startDate:String(fd.get("startDate")||""),
          endDate:String(fd.get("endDate")||""),
          updatedAt:serverTimestamp()
        };
        await updateDoc(doc(db,"sections",existing.id),data);
        if(existing.joinCode) await updateDoc(doc(db,"joinCodes",existing.joinCode),{active:data.joinOpen,updatedAt:serverTimestamp()});
      }else{
        const course=state.courses.find(c=>c.id===String(fd.get("courseId")));
        const code=await generateJoinCode();
        const sectionRef=doc(collection(db,"sections"));
        const sectionNumber=String(fd.get("sectionNumber")).trim();
        const joinOpen=String(fd.get("joinOpen"))==="true";
        const sectionData={
          ownerId:state.user.uid,
          instructorName:state.profile.displayName || state.user.displayName || "Instructor",
          courseId:course.id,
          courseTitle:course.title,
          courseCode:course.code,
          sectionNumber,
          term:String(fd.get("term")).trim(),
          sectionName:String(fd.get("sectionName")).trim() || course.title+" — Section "+sectionNumber,
          format:String(fd.get("format")),
          joinCode:code,
          joinOpen,
          entranceExamRequired:course.entranceExamRequired===true,
          entranceAssessmentId:"",
          entranceExamTitle:"",
          entrancePassPercent:70,
          startDate:String(fd.get("startDate")||""),
          endDate:String(fd.get("endDate")||""),
          createdAt:serverTimestamp(),
          updatedAt:serverTimestamp()
        };
        const batch=writeBatch(db);
        batch.set(sectionRef,sectionData);
        batch.set(doc(db,"joinCodes",code),{sectionId:sectionRef.id,active:joinOpen,createdAt:serverTimestamp()});
        await batch.commit();
      }
      closeModal();
      await loadWorkspace();
      showToast(editing?"Section updated.":"Section created and join code issued.");
    }catch(error){ showToast(humanizeFirebaseError(error)); }
  });
}

async function loadCourseFramework(courseId){
  const unitsSnap=await getDocs(collection(db,"courses",courseId,"units"));
  const units=unitsSnap.docs.map(d=>({id:d.id,...d.data()}));
  const competenciesSnap=await getDocs(collection(db,"courses",courseId,"competencies"));
  const competencies=competenciesSnap.docs.map(d=>({id:d.id,...d.data()}));
  for(const unit of units){
    const topicSnap=await getDocs(collection(db,"courses",courseId,"units",unit.id,"topics"));
    unit.topics=topicSnap.docs.map(d=>({id:d.id,...d.data()}));
  }
  return {units:sortByOrder(units),competencies:sortByOrder(competencies)};
}

async function openCourse(courseId){
  let course=state.courses.find(c=>c.id===courseId);
  if(!course){
    const snap=await getDoc(doc(db,"courses",courseId));
    if(!snap.exists()) return showToast("Course not found.");
    course={id:snap.id,...snap.data()};
  }
  if(state.isSystemOwner && !course.ownerId){
    try{
      await updateDoc(doc(db,"courses",courseId),{ownerId:state.user.uid,updatedAt:serverTimestamp()});
      course={...course,ownerId:state.user.uid};
      const idx=state.courses.findIndex(c=>c.id===courseId);
      if(idx>=0) state.courses[idx]=course;
      showToast("Legacy course ownership linked to your instructor account.");
    }catch(error){
      console.warn("Unable to claim legacy course ownership:",error);
    }
  }
  state.currentCourse=course;
  state.courseFramework=await loadCourseFramework(courseId);
  renderCourseDetail();
  setPage("course-detail",course.code || "Course");
}

function renderCourseDetail(){
  const c=state.currentCourse;
  const fw=state.courseFramework || {units:[],competencies:[]};
  const instructor=canManageCourse(c);
  const units=fw.units.length ? fw.units.map((u,index)=>{
    const topics=(u.topics||[]).length ? sortByOrder(u.topics).map((t,ti)=>
      '<div class="topic-row"><div class="topic-index">'+esc(t.number || ((u.order||index+1)+"."+(ti+1)))+'</div><div><div class="topic-title">'+esc(t.title)+'</div>'+
      (t.learningObjective?'<div class="topic-detail"><strong>Objective:</strong> '+esc(t.learningObjective)+'</div>':'')+
      (t.essentialKnowledge?'<div class="topic-detail"><strong>Essential Knowledge:</strong> '+esc(t.essentialKnowledge)+'</div>':'')+
      (t.competencyCodes?.length?'<div class="topic-detail"><strong>Competencies:</strong> '+esc(t.competencyCodes.join(", "))+'</div>':'')+
      '</div>'+(instructor?'<div class="inline-actions"><button class="text-btn" data-action="edit-topic" data-unit="'+u.id+'" data-id="'+t.id+'">Edit</button></div>':'')+'</div>'
    ).join("") : '<div class="empty-mini">No topics have been added to this unit.</div>';
    return '<article class="unit-card"><div class="unit-head"><div><div class="unit-number">Unit '+esc(u.order || index+1)+'</div><h3>'+esc(u.title)+'</h3>'+(u.description?'<div class="topic-detail">'+esc(u.description)+'</div>':'')+'</div>'+(instructor?'<div class="inline-actions"><button class="text-btn" data-action="add-topic" data-unit="'+u.id+'">+ Topic</button><button class="text-btn" data-action="edit-unit" data-id="'+u.id+'">Edit</button></div>':'')+'</div><div class="topic-list">'+topics+'</div></article>';
  }).join("") : '<div class="empty-state"><div class="empty-symbol">U</div><h3>No units yet.</h3><p>Build the course framework by adding the first unit.</p>'+(instructor?'<button class="primary-btn" data-action="add-unit">Add Unit</button>':'')+'</div>';

  const competencies=fw.competencies.length ? fw.competencies.map(x=>
    '<div class="competency-item"><div class="competency-code">'+esc(x.code)+'</div><div class="competency-name">'+esc(x.name)+'</div><div class="competency-desc">'+esc(x.description||"")+'</div>'+(instructor?'<button class="text-btn" data-action="edit-competency" data-id="'+x.id+'">Edit</button>':'')+'</div>'
  ).join("") : '<div class="empty-mini">No academic competencies yet.</div>';

  $("#courseDetail").innerHTML =
    '<button class="text-btn" data-action="back-courses">← Courses</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(c.code||"Course")+(c.catalogCourse?' • THEORIA CATALOG':'')+'</div><h1 class="detail-title">'+esc(c.title)+'</h1><div class="detail-meta"><span>'+esc(c.discipline||"Theology")+'</span><span>'+esc(c.level||"Advanced")+'</span><span>'+esc(c.status||"Active")+'</span>'+(c.catalogCourse?'<span class="badge '+(c.catalogPublished?'live':'gold')+'">'+(c.catalogPublished?'Published Catalog':'Catalog Draft')+'</span>':'')+'</div></div>'+(instructor?'<div class="inline-actions"><button class="secondary-btn small-btn" data-action="edit-course">Edit Course</button><button class="secondary-btn small-btn" data-action="bulk-import-framework" data-course="'+c.id+'">Bulk Import Framework</button><button class="primary-btn small-btn" data-action="add-unit">Add Unit</button></div>':'')+'</div>'+(c.description?'<p class="page-subtitle" style="margin-top:16px">'+esc(c.description)+'</p>':'')+'</div>'+
    '<div class="framework-layout"><div><div class="panel-head" style="padding-left:0;border:0"><div class="panel-title">Course Framework</div></div><div class="unit-list">'+units+'</div></div>'+
    '<aside><div class="panel"><div class="panel-head"><div class="panel-title">Academic Competencies</div>'+(instructor?'<button class="panel-link" data-action="add-competency">+ Add</button>':'')+'</div><div class="panel-body"><div class="competency-list">'+competencies+'</div></div></div></aside></div>';
}


function stripFrameworkJsonFence(text){
  let value=String(text||"").trim();
  value=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const firstObject=value.indexOf("{"),lastObject=value.lastIndexOf("}");
  if(firstObject>=0&&lastObject>firstObject)return value.slice(firstObject,lastObject+1);
  return value;
}

function frameworkPromptForCourse(course,framework){
  const existingCompetencies=(framework.competencies||[]).map(c=>c.code+" — "+c.name);
  const existingUnits=(framework.units||[]).map(unit=>{
    const topicText=(unit.topics||[]).map(t=>(t.number||"")+" — "+t.title).join("; ");
    return "Unit "+(unit.order||"")+" — "+unit.title+(topicText?" | Existing topics: "+topicText:"");
  });

  return [
    "Create or extend a complete Course Framework for Theoria.",
    "",
    "Course: "+(course.code||"")+" — "+(course.title||""),
    "Discipline: "+(course.discipline||"Theology"),
    "Academic Level: "+(course.level||"Advanced"),
    course.description?"Course Description: "+course.description:"",
    "",
    "Return ONLY valid JSON. Do not use Markdown fences, commentary, headings, or explanatory prose.",
    "Return one JSON object. The object may contain a competencies array, a units array, or both.",
    "",
    "Use this structure:",
    "{",
    '  "competencies": [',
    '    {',
    '      "code": "EXE-1",',
    '      "name": "Biblical Exegesis",',
    '      "description": "What successful performance demonstrates.",',
    '      "order": 1',
    "    }",
    "  ],",
    '  "units": [',
    "    {",
    '      "order": 1,',
    '      "title": "Foundations of Rational Faith",',
    '      "description": "Unit scope and purpose.",',
    '      "topics": [',
    "        {",
    '          "number": "1.1",',
    '          "title": "Faith and Reason",',
    '          "learningObjective": "What students should understand, analyze, or evaluate.",',
    '          "essentialKnowledge": "The core knowledge students should retain.",',
    '          "competencyCodes": ["EXE-1", "ARG-2"],',
    '          "order": 1',
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Build a coherent advanced theological course framework, not a loose outline.",
    "- Competency codes must be concise, stable, and unique.",
    "- Unit order numbers must be unique positive integers.",
    "- Topic numbers should follow the unit, such as 1.1, 1.2, 2.1.",
    "- Topic numbers must be unique across the course.",
    "- learningObjective should state what the student should be able to understand, analyze, evaluate, synthesize, or defend.",
    "- essentialKnowledge should identify concrete theological, biblical, historical, hermeneutical, or philosophical knowledge.",
    "- competencyCodes on topics may reference competencies you create in this same JSON OR existing competency codes listed below.",
    "- Do not recreate existing units/topics/competencies unless the course genuinely needs additional entries.",
    "- Theoria will safely merge this import and skip existing matching entries rather than overwrite them.",
    "",
    "EXISTING COMPETENCIES:",
    ...(existingCompetencies.length?existingCompetencies:["None yet."]),
    "",
    "EXISTING COURSE FRAMEWORK:",
    ...(existingUnits.length?existingUnits:["No units or topics exist yet."])
  ].filter(Boolean).join("\n");
}

function normalizeFrameworkImport(payload,framework){
  const errors=[],warnings=[];
  if(!payload||typeof payload!=="object"||Array.isArray(payload)){
    return {errors:["Framework import must be one JSON object."],warnings:[],competencies:[],units:[],summary:{newCompetencies:0,newUnits:0,newTopics:0,reusedCompetencies:0,reusedUnits:0,skippedTopics:0}};
  }

  const existingCompByCode=new Map((framework.competencies||[]).map(c=>[String(c.code||"").trim().toUpperCase(),c]));
  const existingUnitByOrder=new Map((framework.units||[]).map(u=>[Number(u.order),u]));
  const existingTopicByNumber=new Map();
  for(const unit of framework.units||[]){
    for(const topic of unit.topics||[]){
      const num=String(topic.number||"").trim().toLowerCase();
      if(num)existingTopicByNumber.set(num,{...topic,unitId:unit.id,unitOrder:unit.order,unitTitle:unit.title});
    }
  }

  const rawCompetencies=Array.isArray(payload.competencies)?payload.competencies:[];
  const rawUnits=Array.isArray(payload.units)?payload.units:[];
  if(!rawCompetencies.length&&!rawUnits.length)errors.push("The JSON must contain at least one competency or unit.");

  const seenCompCodes=new Set();
  const normalizedCompetencies=[];
  rawCompetencies.forEach((raw,index)=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw)){
      normalizedCompetencies.push({index,errors:["Competency is not an object."],warnings:[],data:null,status:"invalid"});return;
    }
    const rowErrors=[],rowWarnings=[];
    const code=String(raw.code||"").trim().toUpperCase();
    const name=String(raw.name||"").trim();
    if(!code)rowErrors.push("Competency code is required.");
    if(!name)rowErrors.push("Competency name is required.");
    if(code&&seenCompCodes.has(code))rowErrors.push("Duplicate competency code in import: "+code);
    if(code)seenCompCodes.add(code);

    const orderRaw=Number(raw.order??index+1);
    const order=Number.isFinite(orderRaw)&&orderRaw>0?orderRaw:index+1;
    if(!Number.isFinite(orderRaw)||orderRaw<=0)rowWarnings.push("Competency order defaulted to "+(index+1)+".");

    const existing=code?existingCompByCode.get(code):null;
    if(existing)rowWarnings.push("Competency "+code+" already exists and will be reused.");

    normalizedCompetencies.push({
      index,errors:rowErrors,warnings:rowWarnings,status:rowErrors.length?"invalid":existing?"reuse":"new",
      existing,
      data:rowErrors.length?null:{code,name,description:String(raw.description||"").trim(),order}
    });
  });

  const importedCompCodes=new Set(normalizedCompetencies.filter(r=>r.data).map(r=>r.data.code));
  const allowedCompCodes=new Set([...existingCompByCode.keys(),...importedCompCodes]);

  const seenUnitOrders=new Set();
  const seenTopicNumbers=new Set();
  const normalizedUnits=[];

  rawUnits.forEach((raw,index)=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw)){
      normalizedUnits.push({index,errors:["Unit is not an object."],warnings:[],data:null,status:"invalid",topics:[]});return;
    }
    const rowErrors=[],rowWarnings=[];
    const orderRaw=Number(raw.order??index+1);
    const order=Number.isFinite(orderRaw)&&Number.isInteger(orderRaw)&&orderRaw>0?orderRaw:null;
    const title=String(raw.title||"").trim();
    if(!order)rowErrors.push("Unit order must be a positive integer.");
    if(!title)rowErrors.push("Unit title is required.");
    if(order&&seenUnitOrders.has(order))rowErrors.push("Duplicate unit order in import: "+order);
    if(order)seenUnitOrders.add(order);

    const existing=order?existingUnitByOrder.get(order):null;
    if(existing){
      rowWarnings.push("Unit "+order+" already exists and will be reused.");
      if(title&&String(existing.title||"").trim().toLowerCase()!==title.toLowerCase()){
        rowWarnings.push("Imported title differs from the existing Unit "+order+" title; the existing unit will not be renamed.");
      }
    }

    const topics=[];
    const rawTopics=Array.isArray(raw.topics)?raw.topics:[];
    rawTopics.forEach((topicRaw,topicIndex)=>{
      if(!topicRaw||typeof topicRaw!=="object"||Array.isArray(topicRaw)){
        topics.push({index:topicIndex,errors:["Topic is not an object."],warnings:[],data:null,status:"invalid"});return;
      }
      const tErrors=[],tWarnings=[];
      const number=String(topicRaw.number||"").trim();
      const tTitle=String(topicRaw.title||"").trim();
      if(!number)tErrors.push("Topic number is required.");
      if(!tTitle)tErrors.push("Topic title is required.");
      const numberKey=number.toLowerCase();
      if(number&&seenTopicNumbers.has(numberKey))tErrors.push("Duplicate topic number in import: "+number);
      if(number)seenTopicNumbers.add(numberKey);

      const expectedPrefix=order?String(order)+".":"";
      if(number&&order&&!number.startsWith(expectedPrefix))tWarnings.push("Topic number "+number+" does not begin with Unit "+order+".");

      const existingTopic=number?existingTopicByNumber.get(numberKey):null;
      if(existingTopic)tWarnings.push("Topic "+number+" already exists and will be skipped.");

      let competencyCodes=Array.isArray(topicRaw.competencyCodes)?topicRaw.competencyCodes:String(topicRaw.competencyCodes||"").split(",");
      competencyCodes=[...new Set(competencyCodes.map(x=>String(x).trim().toUpperCase()).filter(Boolean))];
      const unknownCodes=competencyCodes.filter(code=>!allowedCompCodes.has(code));
      if(unknownCodes.length)tWarnings.push("Unknown competency codes will be ignored: "+unknownCodes.join(", "));
      competencyCodes=competencyCodes.filter(code=>allowedCompCodes.has(code));

      const topicOrderRaw=Number(topicRaw.order??String(number).split(".").pop()??topicIndex+1);
      const topicOrder=Number.isFinite(topicOrderRaw)&&topicOrderRaw>0?topicOrderRaw:topicIndex+1;

      topics.push({
        index:topicIndex,errors:tErrors,warnings:tWarnings,status:tErrors.length?"invalid":existingTopic?"skip":"new",
        existing:existingTopic,
        data:tErrors.length?null:{
          number,tTitle,
          title:tTitle,
          learningObjective:String(topicRaw.learningObjective||topicRaw.objective||"").trim(),
          essentialKnowledge:String(topicRaw.essentialKnowledge||"").trim(),
          competencyCodes,
          order:topicOrder
        }
      });
    });

    normalizedUnits.push({
      index,errors:rowErrors,warnings:rowWarnings,status:rowErrors.length?"invalid":existing?"reuse":"new",
      existing,
      data:rowErrors.length?null:{order,title,description:String(raw.description||"").trim()},
      topics
    });
  });

  const allRows=[
    ...normalizedCompetencies,
    ...normalizedUnits,
    ...normalizedUnits.flatMap(u=>u.topics||[])
  ];
  allRows.forEach(r=>{errors.push(...r.errors);warnings.push(...r.warnings);});

  const summary={
    newCompetencies:normalizedCompetencies.filter(r=>r.status==="new").length,
    reusedCompetencies:normalizedCompetencies.filter(r=>r.status==="reuse").length,
    newUnits:normalizedUnits.filter(r=>r.status==="new").length,
    reusedUnits:normalizedUnits.filter(r=>r.status==="reuse").length,
    newTopics:normalizedUnits.flatMap(u=>u.topics||[]).filter(r=>r.status==="new").length,
    skippedTopics:normalizedUnits.flatMap(u=>u.topics||[]).filter(r=>r.status==="skip").length,
    invalid:allRows.filter(r=>r.status==="invalid").length
  };

  return {errors,warnings,competencies:normalizedCompetencies,units:normalizedUnits,summary};
}

async function bulkImportFrameworkModal(courseId=state.currentCourse?.id||state.currentSection?.courseId){
  if(state.role!=="instructor"||!courseId)return;
  const course=state.courses.find(c=>c.id===courseId)||state.currentCourse||state.sectionData?.course;
  if(!course)return showToast("Course not found.");
  if(!canManageCourse(course))return showToast("Official Theoria course frameworks are managed by the system owner.");

  let framework=await loadCourseFramework(courseId);
  let normalized=null;

  const modal=openModal({
    eyebrow:"Course Architecture",
    title:"Bulk Import Framework",
    wide:true,
    body:'<div class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Framework Context</h3><p>Import competencies, units, and topics together. Existing matching entries are safely reused or skipped.</p></div></div>'+
        '<div class="framework-import-summary"><div><span>Course</span><strong>'+esc(course.code||"")+' — '+esc(course.title||"")+'</strong></div><div><span>Existing Units</span><strong>'+framework.units.length+'</strong></div><div><span>Existing Topics</span><strong>'+framework.units.reduce((n,u)=>n+(u.topics?.length||0),0)+'</strong></div><div><span>Competencies</span><strong>'+framework.competencies.length+'</strong></div></div>'+
        '<div class="bulk-import-prompt-row"><div><strong>Generate or extend the framework in ChatGPT</strong><span>The prompt includes the current course and tells ChatGPT how to avoid recreating existing structure.</span></div><button type="button" class="secondary-btn" id="copyFrameworkPrompt">Copy ChatGPT Framework Prompt</button></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Add Framework JSON</h3><p>Paste the complete JSON response once or upload a .json file. You may import only competencies, only units/topics, or all three together.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>JSON File</label><input id="bulkFrameworkFile" type="file" accept=".json,application/json"></div><div class="field"><label>Merge Mode</label><div class="static-field">Safe merge — existing entries are never overwritten</div></div></div>'+
        '<div class="field"><label>Paste Course Framework</label><textarea id="bulkFrameworkJson" class="bulk-json-editor" spellcheck="false" placeholder="Paste the complete JSON framework here"></textarea></div>'+
        '<button type="button" class="primary-btn" id="previewBulkFramework">Validate & Preview</button>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Import Preview</h3><p>Review new, reused, skipped, and invalid framework records before writing anything.</p></div><div id="bulkFrameworkSummary"></div></div><div id="bulkFrameworkResults"><div class="empty-mini">Paste or upload a framework, then validate it.</div></div></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="importBulkFramework" disabled>Import Framework</button></div>'+
    '</div>'
  });

  const textarea=modal.querySelector("#bulkFrameworkJson");
  const fileInput=modal.querySelector("#bulkFrameworkFile");
  const summary=modal.querySelector("#bulkFrameworkSummary");
  const results=modal.querySelector("#bulkFrameworkResults");
  const importButton=modal.querySelector("#importBulkFramework");

  const resetPreview=()=>{
    normalized=null;summary.innerHTML="";
    results.innerHTML='<div class="empty-mini">Validate the current framework JSON before importing.</div>';
    importButton.disabled=true;importButton.textContent="Import Framework";
  };

  modal.querySelector("#copyFrameworkPrompt").addEventListener("click",async()=>{
    const prompt=frameworkPromptForCourse(course,framework);
    try{
      await navigator.clipboard.writeText(prompt);
      showToast("Course Framework prompt copied for ChatGPT.");
    }catch(_){
      textarea.value=prompt;
      showToast("Clipboard access was unavailable, so the prompt was placed in the editor.");
    }
  });

  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{textarea.value=await file.text();resetPreview();}catch(_){showToast("The JSON file could not be read.");}
  });

  modal.querySelector("#previewBulkFramework").addEventListener("click",()=>{
    let payload;
    try{
      payload=JSON.parse(stripFrameworkJsonFence(textarea.value));
    }catch(error){
      normalized=null;
      summary.innerHTML='<span class="badge danger">Invalid JSON</span>';
      results.innerHTML='<div class="notice danger-notice">'+esc(error.message||"The Course Framework is not valid JSON.")+'</div>';
      importButton.disabled=true;return;
    }

    normalized=normalizeFrameworkImport(payload,framework);
    const s=normalized.summary;
    summary.innerHTML='<div class="bulk-preview-counts">'+
      '<span><strong>'+s.newUnits+'</strong> new units</span>'+
      '<span><strong>'+s.newTopics+'</strong> new topics</span>'+
      '<span><strong>'+s.newCompetencies+'</strong> new competencies</span>'+
      '<span><strong>'+s.invalid+'</strong> invalid</span>'+
      '</div>';

    const competencyRows=normalized.competencies.length
      ? '<div class="framework-preview-group"><div class="framework-preview-group-title">Competencies</div>'+normalized.competencies.map(row=>
          '<div class="bulk-preview-row '+(row.status==="invalid"?'invalid':row.status==="reuse"?'warning':'valid')+'"><div class="bulk-preview-number">C</div><div><strong>'+esc(row.data?.code||"Invalid competency")+(row.data?.name?' — '+esc(row.data.name):'')+'</strong><span>'+(row.status==="new"?"Create new competency":row.status==="reuse"?"Reuse existing competency":"Invalid")+'</span>'+
          (row.errors.length?'<div class="bulk-messages errors">'+row.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
          (row.warnings.length?'<div class="bulk-messages warnings">'+row.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
          '</div></div>'
        ).join("")+'</div>'
      : '';

    const unitRows=normalized.units.length
      ? '<div class="framework-preview-group"><div class="framework-preview-group-title">Units & Topics</div>'+normalized.units.map(unit=>{
          const unitRow='<div class="bulk-preview-row '+(unit.status==="invalid"?'invalid':unit.status==="reuse"?'warning':'valid')+'"><div class="bulk-preview-number">U'+esc(unit.data?.order||"?")+'</div><div><strong>'+esc(unit.data?.title||"Invalid unit")+'</strong><span>'+(unit.status==="new"?"Create new unit":unit.status==="reuse"?"Reuse existing unit":"Invalid")+'</span>'+
            (unit.errors.length?'<div class="bulk-messages errors">'+unit.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
            (unit.warnings.length?'<div class="bulk-messages warnings">'+unit.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
            '</div></div>';
          const topicRows=(unit.topics||[]).map(topic=>
            '<div class="bulk-preview-row framework-topic-row '+(topic.status==="invalid"?'invalid':topic.status==="skip"?'warning':'valid')+'"><div class="bulk-preview-number">T</div><div><strong>'+esc(topic.data?.number||"Invalid")+' — '+esc(topic.data?.title||"Topic")+'</strong><span>'+(topic.status==="new"?"Create topic":topic.status==="skip"?"Already exists — skip":"Invalid")+(topic.data?.competencyCodes?.length?' • '+esc(topic.data.competencyCodes.join(", ")):'')+'</span>'+
            (topic.errors.length?'<div class="bulk-messages errors">'+topic.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
            (topic.warnings.length?'<div class="bulk-messages warnings">'+topic.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
            '</div></div>'
          ).join("");
          return unitRow+topicRows;
        }).join("")+'</div>'
      : '';

    results.innerHTML=(competencyRows+unitRows)||'<div class="empty-mini">No framework records were found.</div>';

    const creatable=s.newCompetencies+s.newUnits+s.newTopics;
    importButton.disabled=!creatable||s.invalid>0;
    importButton.textContent=s.invalid>0?"Fix Invalid Records":"Import "+creatable+" New Record"+(creatable===1?"":"s");
  });

  importButton.addEventListener("click",async()=>{
    if(!normalized)return;
    const s=normalized.summary;
    if(s.invalid>0)return showToast("Fix invalid framework records before importing.");

    const newCompetencies=normalized.competencies.filter(r=>r.status==="new");
    const newUnits=normalized.units.filter(r=>r.status==="new");
    const newTopics=normalized.units.flatMap(unit=>(unit.topics||[]).filter(topic=>topic.status==="new").map(topic=>({unit,topic})));
    if(!newCompetencies.length&&!newUnits.length&&!newTopics.length)return showToast("Nothing new to import.");

    importButton.disabled=true;importButton.textContent="Importing…";

    try{
      const compRefByCode=new Map((framework.competencies||[]).map(c=>[String(c.code||"").trim().toUpperCase(),doc(db,"courses",courseId,"competencies",c.id)]));
      for(const row of newCompetencies){
        compRefByCode.set(row.data.code,doc(collection(db,"courses",courseId,"competencies")));
      }

      const unitRefByOrder=new Map((framework.units||[]).map(u=>[Number(u.order),doc(db,"courses",courseId,"units",u.id)]));
      for(const row of newUnits){
        unitRefByOrder.set(Number(row.data.order),doc(collection(db,"courses",courseId,"units")));
      }

      const operations=[];

      for(const row of newCompetencies){
        const ref=compRefByCode.get(row.data.code);
        operations.push(batch=>batch.set(ref,{
          code:row.data.code,name:row.data.name,description:row.data.description,order:row.data.order,
          createdAt:serverTimestamp(),updatedAt:serverTimestamp()
        }));
      }

      for(const row of newUnits){
        const ref=unitRefByOrder.get(Number(row.data.order));
        operations.push(batch=>batch.set(ref,{
          order:row.data.order,title:row.data.title,description:row.data.description,
          createdAt:serverTimestamp(),updatedAt:serverTimestamp()
        }));
      }

      for(const pair of newTopics){
        const unitOrder=Number(pair.unit.data?.order||pair.unit.existing?.order);
        const unitRef=unitRefByOrder.get(unitOrder);
        if(!unitRef)throw new Error("Unable to resolve Unit "+unitOrder+" for topic "+pair.topic.data.number+".");

        const competencyIds=[];
        const competencyCodes=[];
        for(const code of pair.topic.data.competencyCodes||[]){
          const ref=compRefByCode.get(code);
          if(ref){competencyIds.push(ref.id);competencyCodes.push(code);}
        }

        const topicRef=doc(collection(db,"courses",courseId,"units",unitRef.id,"topics"));
        operations.push(batch=>batch.set(topicRef,{
          number:pair.topic.data.number,title:pair.topic.data.title,
          learningObjective:pair.topic.data.learningObjective,
          essentialKnowledge:pair.topic.data.essentialKnowledge,
          competencyIds,competencyCodes,order:pair.topic.data.order,
          createdAt:serverTimestamp(),updatedAt:serverTimestamp()
        }));
      }

      for(let offset=0;offset<operations.length;offset+=400){
        const batch=writeBatch(db);
        operations.slice(offset,offset+400).forEach(apply=>apply(batch));
        await batch.commit();
      }

      closeModal();
      framework=await loadCourseFramework(courseId);

      if(state.currentSection?.courseId===courseId&&$("#page-section-detail")?.classList.contains("active")){
        state.sectionData=await loadSectionData(state.currentSection);
        renderSectionDetail("framework");
      }else{
        state.currentCourse=course;
        state.courseFramework=framework;
        renderCourseDetail();
      }

      showToast("Framework imported: "+s.newUnits+" unit"+(s.newUnits===1?"":"s")+", "+s.newTopics+" topic"+(s.newTopics===1?"":"s")+", "+s.newCompetencies+" competenc"+(s.newCompetencies===1?"y":"ies")+".");
    }catch(error){
      importButton.disabled=false;
      importButton.textContent="Import Framework";
      showToast(humanizeFirebaseError(error));
    }
  });
}

function openUnitModal(existing){
  if(!canManageCourse(state.currentCourse))return showToast("Only the Theoria system owner can edit this official Course Framework.");
  const modal=openModal({
    eyebrow:"Course Framework",
    title:existing?"Edit Unit":"Add Unit",
    body:'<form id="unitForm"><div class="form-grid"><div class="field"><label>Unit Number</label><input type="number" min="1" name="order" value="'+esc(existing?.order || ((state.courseFramework?.units?.length||0)+1))+'" required></div><div class="field span-2"><label>Unit Title</label><input name="title" value="'+esc(existing?.title||"")+'" placeholder="Foundations of Apologetic Method" required></div><div class="field span-2"><label>Description</label><textarea name="description">'+esc(existing?.description||"")+'</textarea></div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Unit</button></div></form>'
  });
  modal.querySelector("#unitForm").addEventListener("submit",async e=>{
    e.preventDefault(); const fd=new FormData(e.currentTarget);
    const data={order:Number(fd.get("order")),title:String(fd.get("title")).trim(),description:String(fd.get("description")).trim(),updatedAt:serverTimestamp()};
    try{
      if(existing) await updateDoc(doc(db,"courses",state.currentCourse.id,"units",existing.id),data);
      else await addDoc(collection(db,"courses",state.currentCourse.id,"units"),{...data,createdAt:serverTimestamp()});
      closeModal(); state.courseFramework=await loadCourseFramework(state.currentCourse.id); renderCourseDetail(); showToast("Unit saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

function openCompetencyModal(existing,courseId=state.currentCourse?.id || state.currentSection?.courseId){
  if(!courseId) return showToast("Open a course or section before creating competencies.");
  const course=state.courses.find(c=>c.id===courseId) || state.sectionData?.course || state.currentCourse;
  if(!canManageCourse(course))return showToast("Only the Theoria system owner can edit official catalog competencies.");
  const modal=openModal({
    eyebrow:"Academic Competency",
    title:existing?"Edit Competency":"Create Competency",
    wide:true,
    body:'<form id="competencyForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Competency Identity</h3><p>Define a reusable academic skill students demonstrate across topics and assessments.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Code</label><input name="code" value="'+esc(existing?.code||"")+'" placeholder="ARG-3" required></div><div class="field"><label>Name</label><input name="name" value="'+esc(existing?.name||"")+'" placeholder="Argument Analysis" required></div></div>'+
        '<div class="field"><label>Description</label><textarea class="editor-compact" rows="3" name="description" placeholder="What does successful performance in this competency demonstrate?">'+esc(existing?.description||"")+'</textarea></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Competency</button></div></form>'
  });
  const form=modal.querySelector("#competencyForm");
  const area=form.querySelector(".editor-compact");
  const grow=()=>{area.style.height="auto";area.style.height=Math.min(area.scrollHeight,180)+"px";};area.addEventListener("input",grow);grow();

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const data={
      code:String(fd.get("code")).trim().toUpperCase(),
      name:String(fd.get("name")).trim(),
      description:String(fd.get("description")).trim(),
      updatedAt:serverTimestamp()
    };
    try{
      if(existing) await updateDoc(doc(db,"courses",courseId,"competencies",existing.id),data);
      else await addDoc(collection(db,"courses",courseId,"competencies"),{...data,createdAt:serverTimestamp()});
      closeModal();
      if(state.currentSection?.courseId===courseId && $("#page-section-detail")?.classList.contains("active")){
        state.sectionData=await loadSectionData(state.currentSection);
        renderSectionDetail("framework");
      }else{
        state.currentCourse=course;
        state.courseFramework=await loadCourseFramework(courseId);
        renderCourseDetail();
      }
      showToast("Competency saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

function openTopicModal(unitId,existing){
  if(!canManageCourse(state.currentCourse))return showToast("Only the Theoria system owner can edit topics in this official course.");
  const unit=state.courseFramework.units.find(u=>u.id===unitId);
  const checks=(state.courseFramework.competencies||[]).map(c=>'<label class="checkbox-line"><input type="checkbox" name="competencies" value="'+c.id+'" data-code="'+esc(c.code)+'" '+(existing?.competencyIds?.includes(c.id)?'checked':'')+'> '+esc(c.code+" — "+c.name)+'</label>').join("");
  const next=(unit?.topics?.length||0)+1;
  const modal=openModal({
    eyebrow:"Course Topic",
    title:existing?"Edit Topic":"Add Topic",
    wide:true,
    body:'<form id="topicForm"><div class="form-grid"><div class="field"><label>Topic Number</label><input name="number" value="'+esc(existing?.number || ((unit?.order||1)+"."+next))+'" required></div><div class="field"><label>Topic Title</label><input name="title" value="'+esc(existing?.title||"")+'" required></div><div class="field span-2"><label>Learning Objective</label><textarea name="learningObjective" placeholder="What should the student be able to understand or evaluate?">'+esc(existing?.learningObjective||"")+'</textarea></div><div class="field span-2"><label>Essential Knowledge</label><textarea name="essentialKnowledge" placeholder="What core knowledge should the student retain?">'+esc(existing?.essentialKnowledge||"")+'</textarea></div><div class="field span-2"><label>Academic Competencies</label><div class="competency-list">'+(checks||'<div class="notice">Create competencies first if you want to tag this topic.</div>')+'</div></div></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Topic</button></div></form>'
  });
  modal.querySelector("#topicForm").addEventListener("submit",async e=>{
    e.preventDefault(); const fd=new FormData(e.currentTarget);
    const selected=Array.from(e.currentTarget.querySelectorAll('input[name="competencies"]:checked'));
    const data={
      number:String(fd.get("number")).trim(),
      title:String(fd.get("title")).trim(),
      learningObjective:String(fd.get("learningObjective")).trim(),
      essentialKnowledge:String(fd.get("essentialKnowledge")).trim(),
      competencyIds:selected.map(x=>x.value),
      competencyCodes:selected.map(x=>x.dataset.code),
      order:Number(String(fd.get("number")).split(".").pop()) || next,
      updatedAt:serverTimestamp()
    };
    try{
      if(existing) await updateDoc(doc(db,"courses",state.currentCourse.id,"units",unitId,"topics",existing.id),data);
      else await addDoc(collection(db,"courses",state.currentCourse.id,"units",unitId,"topics"),{...data,createdAt:serverTimestamp()});
      closeModal(); state.courseFramework=await loadCourseFramework(state.currentCourse.id); renderCourseDetail(); showToast("Topic saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

async function loadSectionData(section){
  const courseSnap=await getDoc(doc(db,"courses",section.courseId));
  const course=courseSnap.exists()?{id:courseSnap.id,...courseSnap.data()}:null;
  const framework=course?await loadCourseFramework(course.id):{units:[],competencies:[]};
  const assignmentSnap=state.role==="instructor"
    ? await getDocs(collection(db,"sections",section.id,"assignments"))
    : await getDocs(query(collection(db,"sections",section.id,"assignments"),where("status","==","Published")));
  const resourceSnap=await getDocs(collection(db,"sections",section.id,"resources"));
  const assessmentRefSnap=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
  let assessmentRefs=assessmentRefSnap.docs.map(d=>({id:d.id,...d.data()}));

  let members=[];
  let grades=[];
  let assessmentGrades=[];
  if(state.role==="instructor"){
    const [memberSnap,gradeSnap,assessmentGradeSnap]=await Promise.all([
      getDocs(collection(db,"sections",section.id,"members")),
      getDocs(collection(db,"sections",section.id,"grades")),
      getDocs(collection(db,"sections",section.id,"assessmentGrades"))
    ]);
    members=memberSnap.docs.map(d=>({id:d.id,...d.data()}));
    grades=gradeSnap.docs.map(d=>({id:d.id,...d.data()}));
    assessmentGrades=assessmentGradeSnap.docs.map(d=>({id:d.id,...d.data()}));

    // Hydrate older assessmentRefs that predate points/type metadata.
    for(const ref of assessmentRefs){
      if(ref.totalPoints!==undefined && ref.totalPoints!==null && ref.assessmentType)continue;
      try{
        const a=await getDoc(doc(db,"assessments",ref.id));
        if(a.exists()){
          const data=a.data();
          ref.totalPoints=Number(data.totalPoints||0);
          ref.assessmentType=data.type||ref.type||"Assessment";
          ref.title=data.title||ref.title||"Assessment";
          ref.status=data.status||ref.status||"Published";
        }
      }catch(_){}
    }
  }else{
    const memberSnap=await getDoc(doc(db,"sections",section.id,"members",state.user.uid));
    if(memberSnap.exists()) members=[{id:memberSnap.id,...memberSnap.data()}];
    const gradeSnap=await getDocs(query(collection(db,"sections",section.id,"grades"),where("studentId","==",state.user.uid)));
    grades=gradeSnap.docs.map(d=>({id:d.id,...d.data()}));

    // Student assessment-grade rules require direct reads and released=true.
    for(const ref of assessmentRefs){
      try{
        const g=await getDoc(doc(db,"sections",section.id,"assessmentGrades",ref.id+"_"+state.user.uid));
        if(g.exists()) assessmentGrades.push({id:g.id,...g.data()});
      }catch(_){}
    }
  }

  assessmentRefs=assessmentRefs
    .filter(x=>x.status!=="Draft")
    .sort((a,b)=>{
      const at=a.opensAt?.toMillis?.()||0,bt=b.opensAt?.toMillis?.()||0;
      return at-bt || String(a.title||"").localeCompare(String(b.title||""));
    });

  const assignments=assignmentSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
    const ad=String(a.dueDate||""),bd=String(b.dueDate||"");
    if(ad&&bd&&ad!==bd)return ad.localeCompare(bd);
    if(ad&&!bd)return -1;
    if(!ad&&bd)return 1;
    const ao=Number(a.unitSequence||9999),bo=Number(b.unitSequence||9999);
    return ao-bo||String(a.title||"").localeCompare(String(b.title||""));
  });
  let assignmentSubmissions=[];
  if(state.role==="student"){
    for(const assignment of assignments){
      try{
        const sub=await getDoc(doc(db,"sections",section.id,"assignments",assignment.id,"submissions",state.user.uid));
        if(sub.exists()) assignmentSubmissions.push({id:sub.id,assignmentId:assignment.id,...sub.data()});
      }catch(_){}
    }
  }

  return {
    course, framework, assignments,
    resources:resourceSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
      const au=Number(a.unitNumber||9999),bu=Number(b.unitNumber||9999);
      const as=Number(a.unitSequence||9999),bs=Number(b.unitSequence||9999);
      return au-bu||as-bs||String(a.title||"").localeCompare(String(b.title||""));
    }),
    members:members.sort((a,b)=>String(a.displayName||"").localeCompare(String(b.displayName||""))),
    grades, assignmentSubmissions, assessmentRefs, assessmentGrades
  };
}

async function openSection(sectionId,tab="overview"){
  let section=state.sections.find(s=>s.id===sectionId);
  if(!section){
    const snap=await getDoc(doc(db,"sections",sectionId));
    if(!snap.exists()) return showToast("Section not found.");
    section={id:snap.id,...snap.data()};
  }
  state.currentSection=section;
  state.sectionData=await loadSectionData(section);
  renderSectionDetail(tab);
  setPage("section-detail",section.courseCode || "Section");
}

function sectionTabs(active){
  const instructor=state.role==="instructor";
  const tabs=instructor
    ? [["overview","Overview"],["framework","Course Guide"],["assignments","Assignments"],["resources","Resources"],["examinations","Assessments"],["students","Students"],["gradebook","Gradebook"],["grading","Grading Policy"],["analytics","Analytics"],["records","Records"]]
    : [["overview","Overview"],["framework","Course Guide"],["assignments","Assignments"],["resources","Resources"],["examinations","Assessments"],["grades","Grades"],["pathway","Grading Pathway"],["progress","Progress"],["record","Academic Record"]];
  return '<div class="tabs">'+tabs.map(([id,label])=>'<button class="tab-btn '+(active===id?'active':'')+'" data-action="section-tab" data-tab="'+id+'">'+label+'</button>').join("")+'</div>';
}

function renderFrameworkReadOnly(){
  const fw=state.sectionData.framework;
  const instructor=canManageCourse(state.sectionData.course);
  const competencyPanel='<div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><div class="panel-title">Academic Competencies</div><div class="panel-subtitle">Reusable skills for topic mapping, question-bank tagging, and mastery analytics.</div></div>'+(instructor?'<div class="inline-actions"><button class="panel-link" data-action="bulk-import-framework" data-course="'+state.currentSection.courseId+'">Bulk Import Framework</button><button class="panel-link" data-action="add-section-competency">+ Create Competency</button></div>':'')+'</div><div class="panel-body">'+(fw.competencies?.length?'<div class="competency-chip-grid">'+fw.competencies.map(c=>'<div class="competency-chip"><strong>'+esc(c.code)+'</strong><span>'+esc(c.name)+'</span>'+(instructor?'<button class="text-btn" data-action="edit-section-competency" data-id="'+c.id+'">Edit</button>':'')+'</div>').join("")+'</div>':'<div class="empty-mini">No competencies have been defined yet.'+(instructor?' Create the first one here.':'')+'</div>')+'</div></div>';
  if(!fw.units.length) return competencyPanel+'<div class="empty-state"><div class="empty-symbol">U</div><h3>The course guide is not yet built.</h3><p>'+(instructor?"Add units and topics from the main Courses workspace.":"Your instructor has not added units and topics to this course framework.")+'</p></div>';
  return competencyPanel+'<div class="unit-list">'+fw.units.map((u,i)=>'<article class="unit-card"><div class="unit-head"><div><div class="unit-number">Unit '+esc(u.order||i+1)+'</div><h3>'+esc(u.title)+'</h3>'+(u.description?'<div class="topic-detail">'+esc(u.description)+'</div>':'')+'</div></div><div class="topic-list">'+((u.topics||[]).length?sortByOrder(u.topics).map(t=>'<div class="topic-row"><div class="topic-index">'+esc(t.number||"")+'</div><div><div class="topic-title">'+esc(t.title)+'</div>'+(t.learningObjective?'<div class="topic-detail"><strong>Learning Objective:</strong> '+esc(t.learningObjective)+'</div>':'')+(t.essentialKnowledge?'<div class="topic-detail"><strong>Essential Knowledge:</strong> '+esc(t.essentialKnowledge)+'</div>':'')+(t.competencyCodes?.length?'<div class="topic-detail"><strong>Competencies:</strong> '+esc(t.competencyCodes.join(", "))+'</div>':'')+'</div></div>').join(""):'<div class="empty-mini">No topics yet.</div>')+'</div></article>').join("")+'</div>';
}

const SORT_STOP_WORDS=new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","from","by","at","as","is","are","was","were","be","been","being",
  "this","that","these","those","it","its","their","his","her","our","your","into","through","about","than","then","what","which","who",
  "how","why","when","where","students","student","should","will","can","could","would","may","understand","analyze","evaluate","explain"
]);

function frameworkSortTokens(value){
  return String(value||"")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g," ")
    .split(/\s+/)
    .map(x=>x.replace(/^-+|-+$/g,""))
    .filter(x=>x.length>2&&!SORT_STOP_WORDS.has(x));
}

function resolveFrameworkPlacement(record,framework){
  const units=framework?.units||[];
  if(record?.unitId){
    const unit=units.find(u=>u.id===record.unitId);
    if(unit){
      const topic=record.topicId?(unit.topics||[]).find(t=>t.id===record.topicId):null;
      return {unit,topic:topic||null,source:"stored"};
    }
  }
  const topicNumber=String(record?.topicNumber||"").trim().toLowerCase();
  if(topicNumber){
    for(const unit of units){
      const topic=(unit.topics||[]).find(t=>String(t.number||"").trim().toLowerCase()===topicNumber);
      if(topic)return {unit,topic,source:"topic-number"};
    }
    const prefix=Number(topicNumber.split(".")[0]);
    const unit=units.find(u=>Number(u.order)===prefix);
    if(unit)return {unit,topic:null,source:"topic-prefix"};
  }
  if(record?.unitNumber){
    const unit=units.find(u=>Number(u.order)===Number(record.unitNumber));
    if(unit)return {unit,topic:null,source:"unit-number"};
  }
  return {unit:null,topic:null,source:"none"};
}

function suggestFrameworkPlacement(record,framework){
  const exact=resolveFrameworkPlacement(record,framework);
  if(exact.topic)return {...exact,score:1,confidence:"Exact"};
  const units=framework?.units||[];
  const recordText=[
    record?.title,record?.prompt,record?.description,record?.stimulus,record?.sourceTitle,record?.citation,record?.notes,record?.url,
    ...(record?.instructionSteps||[]),...(record?.requirements||[]),...(record?.tags||[]),
    ...(record?.competencyCodes||[])
  ].filter(Boolean).join(" ");
  const tokens=new Set(frameworkSortTokens(recordText));
  const recordComps=new Set((record?.competencyCodes||[]).map(x=>String(x).trim().toUpperCase()));
  let best={unit:exact.unit||null,topic:null,score:exact.unit?0.22:0,confidence:exact.unit?"Medium":"Low"};

  for(const unit of units){
    const unitTokens=new Set(frameworkSortTokens([unit.title,unit.description].filter(Boolean).join(" ")));
    let unitHits=0;
    unitTokens.forEach(t=>{if(tokens.has(t))unitHits++;});
    const unitBase=unitTokens.size?Math.min(.22,(unitHits/unitTokens.size)*.22):0;

    for(const topic of unit.topics||[]){
      const titleTokens=new Set(frameworkSortTokens(topic.title));
      const bodyTokens=new Set(frameworkSortTokens([topic.learningObjective,topic.essentialKnowledge].filter(Boolean).join(" ")));
      let titleHits=0,bodyHits=0;
      titleTokens.forEach(t=>{if(tokens.has(t))titleHits++;});
      bodyTokens.forEach(t=>{if(tokens.has(t))bodyHits++;});
      const titleScore=titleTokens.size?Math.min(.48,(titleHits/titleTokens.size)*.48):0;
      const bodyScore=bodyTokens.size?Math.min(.22,(bodyHits/Math.max(4,Math.min(bodyTokens.size,18)))*.22):0;
      const topicComps=new Set((topic.competencyCodes||[]).map(x=>String(x).trim().toUpperCase()));
      let compHits=0;topicComps.forEach(code=>{if(recordComps.has(code))compHits++;});
      const compScore=Math.min(.18,compHits*.06);
      const phrase=String(topic.title||"").trim().toLowerCase();
      const phraseScore=phrase&&recordText.toLowerCase().includes(phrase)?.28:0;
      const score=Math.min(1,unitBase+titleScore+bodyScore+compScore+phraseScore);
      if(score>best.score)best={unit,topic,score,confidence:score>=.55?"High":score>=.3?"Medium":"Low"};
    }
  }
  return best;
}

function frameworkPlacementOptions(framework,selectedValue=""){
  let html='<option value="" '+(!selectedValue?'selected':'')+'>Unsorted / leave unchanged</option>';
  for(const unit of framework?.units||[]){
    const unitValue="unit:"+unit.id;
    html+='<optgroup label="Unit '+esc(unit.order||"")+' — '+esc(unit.title||"Unit")+'">';
    html+='<option value="'+unitValue+'" '+(selectedValue===unitValue?'selected':'')+'>Unit '+esc(unit.order||"")+' — General / no topic</option>';
    for(const topic of unit.topics||[]){
      const value="topic:"+unit.id+":"+topic.id;
      html+='<option value="'+value+'" '+(selectedValue===value?'selected':'')+'>'+esc(topic.number||"")+' — '+esc(topic.title||"Topic")+'</option>';
    }
    html+='</optgroup>';
  }
  return html;
}

function placementDataFromValue(value,framework){
  const parts=String(value||"").split(":");
  if(parts[0]==="unit"){
    const unit=(framework?.units||[]).find(u=>u.id===parts[1]);
    return unit?{unitId:unit.id,unitTitle:unit.title||"",unitNumber:Number(unit.order||0),topicId:"",topicTitle:"",topicNumber:""}:null;
  }
  if(parts[0]==="topic"){
    const unit=(framework?.units||[]).find(u=>u.id===parts[1]);
    const topic=(unit?.topics||[]).find(t=>t.id===parts[2]);
    return unit&&topic?{unitId:unit.id,unitTitle:unit.title||"",unitNumber:Number(unit.order||0),topicId:topic.id,topicTitle:topic.title||"",topicNumber:topic.number||""}:null;
  }
  return null;
}

function unitFolderGroups(items,framework){
  const groups=[];
  for(const unit of framework?.units||[]){
    const members=items.filter(item=>resolveFrameworkPlacement(item,framework).unit?.id===unit.id);
    if(members.length)groups.push({id:unit.id,unit,label:"Unit "+(unit.order||"")+" — "+(unit.title||"Unit"),items:members});
  }
  const unsorted=items.filter(item=>!resolveFrameworkPlacement(item,framework).unit);
  if(unsorted.length)groups.push({id:"unsorted",unit:null,label:"Unsorted",items:unsorted});
  return groups;
}

function assignmentDueState(assignment){
  if(!assignment.dueDate)return {label:"No due date",late:false};
  const due=new Date(assignment.dueDate+"T23:59:59");
  const late=Date.now()>due.getTime();
  return {label:"Due "+formatDate(assignment.dueDate),late};
}

function renderAssignments(){
  const items=state.sectionData.assignments.filter(a=>state.role==="instructor" || a.status!=="Draft");
  const framework=state.sectionData.framework||{units:[]};
  const submissionMap=new Map((state.sectionData.assignmentSubmissions||[]).map(x=>[x.assignmentId,x]));
  const gradeMap=new Map((state.sectionData.grades||[]).map(g=>[g.assignmentId,g]));

  const card=a=>{
    const due=assignmentDueState(a),submission=submissionMap.get(a.id),grade=gradeMap.get(a.id);
    const studentStatus=grade?"Graded":submission?.status==="submitted"?"Submitted":submission?.status==="draft"?"Draft saved":due.late?"Late / Not submitted":"Not started";
    const statusClass=grade?"live":submission?.status==="submitted"?"live":submission?.status==="draft"?"gold":due.late?"danger":"";
    return '<div class="assignment-row coursework-card"><div><div class="card-kicker">'+esc(a.type||"Assignment")+
      (a.topicNumber?' • Topic '+esc(a.topicNumber):'')+
      '</div><h4>'+esc(a.title)+'</h4>'+(a.description?'<p>'+esc(a.description)+'</p>':'')+
      (a.instructionSteps?.length?'<div class="assignment-step-preview">'+a.instructionSteps.slice(0,3).map((step,i)=>'<div><span>'+String(i+1).padStart(2,"0")+'</span>'+esc(step)+'</div>').join("")+(a.instructionSteps.length>3?'<small>+'+(a.instructionSteps.length-3)+' more step'+(a.instructionSteps.length-3===1?"":"s")+'</small>':'')+'</div>':'')+
      '<div class="assignment-meta"><span>'+esc(a.points||0)+' points</span><span class="'+(due.late&&!submission?"late-text":"")+'">'+esc(due.label)+'</span>'+(a.requirements?.length?'<span>'+a.requirements.length+' requirement'+(a.requirements.length===1?"":"s")+'</span>':'')+'<span>'+esc(a.submissionMode||"Text + Link")+'</span>'+(state.role==="instructor"?'<span class="badge '+(a.status==="Published"?'live':'gold')+'">'+esc(a.status||"Published")+'</span>':'<span class="badge '+statusClass+'">'+esc(studentStatus)+'</span>')+'</div>'+
      (grade&&state.role==="student"?'<div class="assignment-grade-preview"><strong>'+esc(grade.score)+' / '+esc(a.points||0)+'</strong>'+(grade.comment?'<span>'+esc(grade.comment)+'</span>':'')+'</div>':'')+
      '</div><div class="inline-actions">'+
      (state.role==="instructor"?'<button class="secondary-btn small-btn" data-action="assignment-submissions" data-id="'+a.id+'">Submissions</button><button class="text-btn" data-action="edit-assignment" data-id="'+a.id+'">Edit</button><button class="danger-btn small-btn" data-action="delete-assignment" data-id="'+a.id+'">Delete</button>':
        (a.submissionMode==="No Online Submission"?'<span class="badge">Instructor-managed</span>':'<button class="primary-btn small-btn" data-action="open-student-assignment" data-id="'+a.id+'">'+(submission?.status==="submitted"?(a.allowResubmission?"View / Revise":"View Submission"):(submission?.status==="draft"?"Continue Assignment":"Open Assignment"))+'</button>'))+
      '</div></div>';
  };

  const groups=unitFolderGroups(items,framework);
  const list=groups.length
    ? '<div class="unit-folder-stack">'+groups.map((group,index)=>
        '<details class="unit-folder '+(group.id==="unsorted"?'unsorted-folder':'')+'" '+(index===0||group.id==="unsorted"?'open':'')+'>'+
          '<summary><div class="unit-folder-icon">'+(group.id==="unsorted"?'?':esc(group.unit?.order||"U"))+'</div><div><strong>'+esc(group.label)+'</strong><span>'+group.items.length+' assignment'+(group.items.length===1?"":"s")+'</span></div><div class="unit-folder-chevron">⌄</div></summary>'+
          '<div class="unit-folder-body assignment-list">'+group.items.map(card).join("")+'</div>'+
        '</details>'
      ).join("")+'</div>'
    : '<div class="empty-state"><div class="empty-symbol">A</div><h3>No assignments yet.</h3><p>'+(state.role==="instructor"?"Create coursework, readings, written responses, research milestones, or academic exercises.":"Nothing has been assigned in this section yet.")+'</p></div>';

  const unsortedCount=items.filter(item=>!item.unitId||!framework.units.some(u=>u.id===item.unitId)).length;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Coursework</div><p class="page-subtitle">'+(state.role==="instructor"?"Assignments are organized into course-unit folders.":"Your coursework is organized by course unit.")+'</p></div>'+
    (state.role==="instructor"?'<div class="inline-actions">'+
      (items.length?'<button class="secondary-btn small-btn" data-action="auto-sort-assignments">Auto-Sort'+(unsortedCount?' ('+unsortedCount+')':'')+'</button>':'')+
      '<button class="secondary-btn small-btn" data-action="bulk-import-assignments">Bulk Import Unit</button><button class="primary-btn small-btn" data-action="create-assignment">Create Assignment</button></div>':'')+
    '</div>'+list;
}

async function autoSortAssignmentsModal(){
  if(state.role!=="instructor"||!state.currentSection||!state.sectionData)return;
  const framework=state.sectionData.framework||{units:[]};
  if(!framework.units.length)return showToast("Create course units and topics before using Auto-Sort.");

  const candidates=state.sectionData.assignments.filter(item=>!item.unitId||!framework.units.some(u=>u.id===item.unitId));
  if(!candidates.length)return showToast("Every assignment is already placed in a unit folder.");

  const suggestions=candidates.map(item=>({item,suggestion:suggestFrameworkPlacement(item,framework)}));
  const modal=openModal({
    eyebrow:"Coursework Organization",
    title:"Auto-Sort Assignments",
    wide:true,
    body:'<div class="auto-sort-intro"><div><strong>'+candidates.length+' unsorted assignment'+(candidates.length===1?"":"s")+'</strong><span>Theoria matched legacy work against topic numbers, titles, objectives, essential knowledge, tags, directions, and requirements. Review every suggestion before applying it.</span></div><div class="auto-sort-legend"><span class="confidence exact">Exact</span><span class="confidence high">High</span><span class="confidence medium">Medium</span><span class="confidence low">Low</span></div></div>'+
      '<div class="auto-sort-list">'+suggestions.map(({item,suggestion})=>{
        const confident=suggestion.confidence!=="Low"&&suggestion.unit;
        const selected=confident?(suggestion.topic?"topic:"+suggestion.unit.id+":"+suggestion.topic.id:"unit:"+suggestion.unit.id):"";
        const percent=Math.round(Number(suggestion.score||0)*100);
        return '<div class="auto-sort-row"><div class="auto-sort-copy"><span>'+esc(item.type||"Assignment")+'</span><strong>'+esc(item.title||"Untitled Assignment")+'</strong><small>'+(item.description?esc(item.description.slice(0,120)):"No description")+'</small></div>'+
          '<div class="auto-sort-confidence"><span class="confidence '+String(suggestion.confidence||"Low").toLowerCase()+'">'+esc(suggestion.confidence||"Low")+'</span><small>'+percent+'% match</small></div>'+
          '<div class="field auto-sort-select"><label>Place in</label><select data-auto-sort-assignment="'+item.id+'">'+frameworkPlacementOptions(framework,selected)+'</select></div></div>';
      }).join("")+'</div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="applyAssignmentAutoSort">Apply Selected Placements</button>'
  });

  modal.querySelector("#applyAssignmentAutoSort").onclick=async()=>{
    const selections=[...modal.querySelectorAll("[data-auto-sort-assignment]")].map(select=>({
      id:select.dataset.autoSortAssignment,
      placement:placementDataFromValue(select.value,framework)
    })).filter(x=>x.placement);
    if(!selections.length)return showToast("Choose at least one Unit or Topic placement.");

    const button=modal.querySelector("#applyAssignmentAutoSort");
    button.disabled=true;button.textContent="Sorting…";
    try{
      for(let offset=0;offset<selections.length;offset+=400){
        const batch=writeBatch(db);
        selections.slice(offset,offset+400).forEach(row=>{
          const topicOrder=framework.units.find(u=>u.id===row.placement.unitId)?.topics?.find(t=>t.id===row.placement.topicId)?.order||0;
          batch.update(doc(db,"sections",state.currentSection.id,"assignments",row.id),{
            ...row.placement,
            unitSequence:Number(topicOrder||0),
            autoSortedAt:serverTimestamp(),
            updatedAt:serverTimestamp()
          });
        });
        await batch.commit();
      }
      closeModal();
      state.sectionData=await loadSectionData(state.currentSection);
      renderSectionDetail("assignments");
      showToast(selections.length+" assignment"+(selections.length===1?"":"s")+" sorted into unit folders.");
    }catch(error){
      button.disabled=false;button.textContent="Apply Selected Placements";
      showToast(humanizeFirebaseError(error));
    }
  };
}

function renderResources(){
  const items=state.sectionData.resources;
  const framework=state.sectionData.framework||{units:[]};

  const card=r=>
    '<div class="resource-row"><div><div class="card-kicker">'+esc(r.type||"Reading")+
      (r.topicNumber?' • Topic '+esc(r.topicNumber):'')+
      '</div><h4>'+esc(r.title)+'</h4>'+
      (r.citation?'<div class="resource-citation">'+esc(r.citation)+'</div>':'')+
      (r.notes?'<p>'+esc(r.notes)+'</p>':'')+
      '<div class="resource-meta">'+(r.url?'<a class="link" target="_blank" rel="noopener" href="'+esc(r.url)+'">Open Resource ↗</a>':'<span>No external link</span>')+'</div></div>'+
      (state.role==="instructor"?'<div class="inline-actions"><button class="text-btn" data-action="edit-resource" data-id="'+r.id+'">Edit</button><button class="danger-btn small-btn" data-action="delete-resource" data-id="'+r.id+'">Delete</button></div>':'')+
    '</div>';

  const groups=unitFolderGroups(items,framework);
  const list=groups.length
    ? '<div class="unit-folder-stack resource-folder-stack">'+groups.map((group,index)=>
        '<details class="unit-folder resource-unit-folder '+(group.id==="unsorted"?'unsorted-folder':'')+'" '+(index===0||group.id==="unsorted"?'open':'')+'>'+
          '<summary><div class="unit-folder-icon">'+(group.id==="unsorted"?'?':esc(group.unit?.order||"U"))+'</div><div><strong>'+esc(group.label)+'</strong><span>'+group.items.length+' resource'+(group.items.length===1?"":"s")+'</span></div><div class="unit-folder-chevron">⌄</div></summary>'+
          '<div class="unit-folder-body resource-list">'+group.items.map(card).join("")+'</div>'+
        '</details>'
      ).join("")+'</div>'
    : '<div class="empty-state"><div class="empty-symbol">R</div><h3>No resources yet.</h3><p>'+(state.role==="instructor"?"Add primary sources, Scripture readings, articles, books, or research links.":"Your instructor has not added resources yet.")+'</p></div>';

  const unsortedCount=items.filter(item=>!item.unitId||!framework.units.some(u=>u.id===item.unitId)).length;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Readings & Resources</div><p class="page-subtitle">'+
    (state.role==="instructor"?"Resources are organized into course-unit folders.":"Your readings and scholarly resources are organized by course unit.")+
    '</p></div>'+
    (state.role==="instructor"?'<div class="inline-actions">'+
      (items.length?'<button class="secondary-btn small-btn" data-action="auto-sort-resources">Auto-Sort'+(unsortedCount?' ('+unsortedCount+')':'')+'</button>':'')+
      '<button class="secondary-btn small-btn" data-action="bulk-import-resources">Bulk Import Unit Resources</button><button class="primary-btn small-btn" data-action="create-resource">Add Resource</button></div>':'')+
    '</div>'+list;
}

async function autoSortResourcesModal(){
  if(state.role!=="instructor"||!state.currentSection||!state.sectionData)return;
  const framework=state.sectionData.framework||{units:[]};
  if(!framework.units.length)return showToast("Create course units and topics before using Auto-Sort.");

  const candidates=state.sectionData.resources.filter(item=>!item.unitId||!framework.units.some(u=>u.id===item.unitId));
  if(!candidates.length)return showToast("Every resource is already placed in a unit folder.");

  const suggestions=candidates.map(item=>({item,suggestion:suggestFrameworkPlacement(item,framework)}));
  const modal=openModal({
    eyebrow:"Resource Organization",
    title:"Auto-Sort Resources",
    wide:true,
    body:'<div class="auto-sort-intro"><div><strong>'+candidates.length+' unsorted resource'+(candidates.length===1?"":"s")+'</strong><span>Theoria compares titles, citations, notes, URLs, tags, topic numbers, unit/topic titles, learning objectives, and essential knowledge. Review every suggestion before applying it.</span></div><div class="auto-sort-legend"><span class="confidence exact">Exact</span><span class="confidence high">High</span><span class="confidence medium">Medium</span><span class="confidence low">Low</span></div></div>'+
      '<div class="auto-sort-list">'+suggestions.map(({item,suggestion})=>{
        const confident=suggestion.confidence!=="Low"&&suggestion.unit;
        const selected=confident?(suggestion.topic?"topic:"+suggestion.unit.id+":"+suggestion.topic.id:"unit:"+suggestion.unit.id):"";
        const percent=Math.round(Number(suggestion.score||0)*100);
        return '<div class="auto-sort-row"><div class="auto-sort-copy"><span>'+esc(item.type||"Resource")+'</span><strong>'+esc(item.title||"Untitled Resource")+'</strong><small>'+esc([item.citation,item.notes].filter(Boolean).join(" • ").slice(0,150)||"No citation or notes")+'</small></div>'+
          '<div class="auto-sort-confidence"><span class="confidence '+String(suggestion.confidence||"Low").toLowerCase()+'">'+esc(suggestion.confidence||"Low")+'</span><small>'+percent+'% match</small></div>'+
          '<div class="field auto-sort-select"><label>Place in</label><select data-auto-sort-resource="'+item.id+'">'+frameworkPlacementOptions(framework,selected)+'</select></div></div>';
      }).join("")+'</div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="applyResourceAutoSort">Apply Selected Placements</button>'
  });

  modal.querySelector("#applyResourceAutoSort").onclick=async()=>{
    const selections=[...modal.querySelectorAll("[data-auto-sort-resource]")].map(select=>({
      id:select.dataset.autoSortResource,
      placement:placementDataFromValue(select.value,framework)
    })).filter(x=>x.placement);
    if(!selections.length)return showToast("Choose at least one Unit or Topic placement.");

    const button=modal.querySelector("#applyResourceAutoSort");
    button.disabled=true;button.textContent="Sorting…";
    try{
      for(let offset=0;offset<selections.length;offset+=400){
        const batch=writeBatch(db);
        selections.slice(offset,offset+400).forEach(row=>{
          const topicOrder=framework.units.find(u=>u.id===row.placement.unitId)?.topics?.find(t=>t.id===row.placement.topicId)?.order||0;
          batch.update(doc(db,"sections",state.currentSection.id,"resources",row.id),{
            ...row.placement,
            unitSequence:Number(topicOrder||0),
            autoSortedAt:serverTimestamp(),
            updatedAt:serverTimestamp()
          });
        });
        await batch.commit();
      }
      closeModal();
      state.sectionData=await loadSectionData(state.currentSection);
      renderSectionDetail("resources");
      showToast(selections.length+" resource"+(selections.length===1?"":"s")+" sorted into unit folders.");
    }catch(error){
      button.disabled=false;button.textContent="Apply Selected Placements";
      showToast(humanizeFirebaseError(error));
    }
  };
}

function renderStudents(){
  const members=state.sectionData.members;
  if(!members.length) return '<div class="empty-state"><div class="empty-symbol">S</div><h3>No students enrolled.</h3><p>Display the section join code and have students enroll.</p></div>';
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Email</th><th>Joined</th><th>Status</th><th>Assessment Access</th><th>Actions</th></tr></thead><tbody>'+members.map(m=>'<tr><td><strong>'+esc(m.displayName||"Student")+'</strong></td><td>'+esc(m.email||"—")+'</td><td>'+esc(formatDate(m.joinedAt))+'</td><td><span class="badge live">Enrolled</span></td><td><button class="text-btn" data-phase3-action="accommodations" data-student="'+m.id+'">Accommodations</button></td><td><button class="danger-btn small-btn" data-action="remove-section-student" data-student="'+m.id+'">Remove</button></td></tr>').join("")+'</tbody></table></div>';
}

function renderGradebook(){
  const students=state.sectionData.members;
  const framework=state.sectionData.framework||{units:[]};
  const rawAssignments=state.sectionData.assignments.filter(a=>a.status!=="Draft");
  const assessments=(state.sectionData.assessmentRefs||[]).filter(a=>a.status!=="Draft");
  if(!students.length || (!rawAssignments.length&&!assessments.length)) return '<div class="empty-state"><div class="empty-symbol">G</div><h3>Gradebook waiting for data.</h3><p>Enroll at least one student and publish an assignment or assessment.</p></div>';

  const gradeMap=new Map(state.sectionData.grades.map(g=>[g.assignmentId+"_"+g.studentId,g]));
  const assessmentGradeMap=new Map((state.sectionData.assessmentGrades||[]).map(g=>[g.assessmentId+"_"+g.studentId,g]));

  const assignmentGroups=unitFolderGroups(rawAssignments,framework);
  const assignments=assignmentGroups.flatMap(group=>group.items);
  const assignmentGroupMap=new Map();
  assignmentGroups.forEach(group=>group.items.forEach((item,index)=>assignmentGroupMap.set(item.id,{group,index})));

  const studentCourseworkAverages=[];
  const studentAssessmentAverages=[];
  let completedGradeCells=0;
  const totalGradeCells=students.length*(assignments.length+assessments.length);

  const unitJumpButtons=assignmentGroups.map(group=>
    '<button class="gradebook-jump" data-action="gradebook-jump" data-target="unit-'+esc(group.id)+'">'+
      '<span>'+(group.id==="unsorted"?"?":"U"+esc(group.unit?.order||""))+'</span>'+esc(group.id==="unsorted"?"Unsorted":group.unit?.title||group.label)+
      '<small>'+group.items.length+'</small></button>'
  ).join("");

  const assignmentGroupHeaders=assignmentGroups.map(group=>
    '<th colspan="'+group.items.length+'" class="gradebook-unit-group '+(group.id==="unsorted"?'unsorted':'')+'" data-gradebook-group="'+esc(group.id)+'">'+
      '<span>'+(group.id==="unsorted"?"Unsorted Coursework":"Unit "+esc(group.unit?.order||"")+' — '+esc(group.unit?.title||"Unit"))+'</span>'+
      '<small>'+group.items.length+' item'+(group.items.length===1?"":"s")+'</small></th>'
  ).join("");

  const assignmentHeaders=assignments.map(a=>{
    const meta=assignmentGroupMap.get(a.id);
    const isStart=meta?.index===0;
    return '<th class="gradebook-item-head '+(isStart?'unit-start':'')+'" '+(isStart?'data-gradebook-anchor="unit-'+esc(meta.group.id)+'"':'')+' title="'+esc(a.title||"Assignment")+'">'+
      '<span class="gradebook-kind">'+esc(a.type||"Assignment")+'</span>'+
      '<span class="gradebook-item-title">'+esc(a.title||"Assignment")+'</span>'+
      '<span class="gradebook-item-meta">'+esc(a.points||0)+' pts'+(a.topicNumber?' • '+esc(a.topicNumber):'')+'</span></th>';
  }).join("");

  const assessmentHeaders=assessments.map((a,index)=>
    '<th class="gradebook-item-head assessment-grade-head '+(index===0?'assessment-start':'')+'" '+(index===0?'data-gradebook-anchor="assessments"':'')+' title="'+esc(a.title||"Assessment")+'">'+
      '<span class="gradebook-kind assessment-kind">'+esc(a.assessmentType||a.type||"Assessment")+'</span>'+
      '<span class="gradebook-item-title">'+esc(a.title||"Assessment")+'</span>'+
      '<span class="gradebook-item-meta">'+(Number(a.totalPoints||0)?esc(a.totalPoints)+" pts":"Formal assessment")+'</span></th>'
  ).join("");

  const header='<thead>'+
    '<tr class="gradebook-category-row"><th class="student-sticky gradebook-student-head" rowspan="3">Student</th>'+
      (assignments.length?'<th colspan="'+assignments.length+'" class="gradebook-category coursework-category">Coursework</th>':'')+
      (assessments.length?'<th colspan="'+assessments.length+'" class="gradebook-category assessment-category">Formal Assessments</th>':'')+
      '<th class="avg-sticky coursework-avg-col" rowspan="3">Coursework<br>Avg</th><th class="avg-sticky assessment-avg-col" rowspan="3">Assessment<br>Avg</th></tr>'+
    '<tr class="gradebook-group-row">'+assignmentGroupHeaders+(assessments.length?'<th colspan="'+assessments.length+'" class="gradebook-unit-group assessment-group">Assessments</th>':'')+'</tr>'+
    '<tr>'+assignmentHeaders+assessmentHeaders+'</tr>'+
    '</thead>';

  const body=students.map(student=>{
    let courseworkEarned=0,courseworkPossible=0,courseworkGraded=0;
    const assignmentCells=assignments.map(a=>{
      const g=gradeMap.get(a.id+"_"+student.id);
      const hasGrade=g&&g.score!==null&&g.score!==undefined;
      if(hasGrade){
        courseworkEarned+=Number(g.score);courseworkPossible+=Number(a.points||0);courseworkGraded++;completedGradeCells++;
      }
      const pct=hasGrade&&Number(a.points||0)>0?Math.round((Number(g.score)/Number(a.points))*1000)/10:null;
      return '<td class="score-cell coursework-score-cell '+(hasGrade?'has-grade':'no-grade')+'" data-action="set-grade" data-assignment="'+a.id+'" data-student="'+student.id+'">'+
        (hasGrade?'<span class="grade-main">'+esc(g.score)+'</span><span class="grade-sub">/ '+esc(a.points)+'</span><span class="grade-cell-percent">'+pct+'%</span>':'<span class="grade-empty">—<small>No grade</small></span>')+
      '</td>';
    }).join("");

    const assessmentPercents=[];
    let assessmentGraded=0;
    const assessmentCells=assessments.map(a=>{
      const g=assessmentGradeMap.get(a.id+"_"+student.id);
      const hasGrade=g&&g.percent!==null&&g.percent!==undefined;
      if(hasGrade){assessmentPercents.push(Number(g.percent));assessmentGraded++;completedGradeCells++;}
      const score=(g&&g.score!==undefined&&g.score!==null)?esc(g.score):"";
      const max=(g&&g.maxScore!==undefined&&g.maxScore!==null)?esc(g.maxScore):esc(a.totalPoints||"");
      return '<td class="score-cell assessment-score-cell '+(hasGrade?'has-grade':'no-grade')+'" data-action="open-gradebook-assessment" data-assessment="'+a.id+'" data-student="'+student.id+'">'+
        (hasGrade?'<span class="grade-main">'+(score&&max?score+" / "+max:esc(g.percent)+"%")+'</span><span class="grade-cell-percent">'+esc(g.percent)+'%</span><span class="grade-sub">'+(g.released?'Released':'Private')+'</span>':'<span class="grade-empty">—<small>Not graded</small></span>')+
      '</td>';
    }).join("");

    const courseworkAvg=courseworkPossible?Math.round((courseworkEarned/courseworkPossible)*1000)/10:null;
    const assessmentAvg=assessmentPercents.length?Math.round((assessmentPercents.reduce((a,b)=>a+b,0)/assessmentPercents.length)*10)/10:null;
    if(courseworkAvg!==null)studentCourseworkAverages.push(courseworkAvg);
    if(assessmentAvg!==null)studentAssessmentAverages.push(assessmentAvg);

    return '<tr><td class="student-sticky gradebook-student-cell"><strong>'+esc(student.displayName||"Student")+'</strong>'+
      '<span>'+courseworkGraded+'/'+assignments.length+' coursework'+(assessments.length?' • '+assessmentGraded+'/'+assessments.length+' assessments':'')+'</span></td>'+
      assignmentCells+assessmentCells+
      '<td class="avg-sticky coursework-avg-col gradebook-average '+(courseworkAvg===null?'empty':'')+'"><strong>'+(courseworkAvg===null?"—":courseworkAvg+"%")+'</strong><span>'+courseworkGraded+' graded</span></td>'+
      '<td class="avg-sticky assessment-avg-col gradebook-average '+(assessmentAvg===null?'empty':'')+'"><strong>'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</strong><span>'+assessmentGraded+' graded</span></td></tr>';
  }).join("");

  const assignmentClassCells=assignments.map(a=>{
    const grades=students.map(student=>gradeMap.get(a.id+"_"+student.id)).filter(g=>g&&g.score!==null&&g.score!==undefined);
    const avg=grades.length?grades.reduce((n,g)=>n+Number(g.score||0),0)/grades.length:null;
    const pct=avg!==null&&Number(a.points||0)>0?Math.round((avg/Number(a.points))*1000)/10:null;
    return '<td class="class-average-cell">'+(avg===null?'—':'<strong>'+Math.round(avg*10)/10+'</strong><span>/ '+esc(a.points)+'</span><small>'+pct+'%</small>')+'</td>';
  }).join("");

  const assessmentClassCells=assessments.map(a=>{
    const grades=students.map(student=>assessmentGradeMap.get(a.id+"_"+student.id)).filter(g=>g&&g.percent!==null&&g.percent!==undefined);
    const pct=grades.length?Math.round((grades.reduce((n,g)=>n+Number(g.percent||0),0)/grades.length)*10)/10:null;
    return '<td class="class-average-cell assessment-class-average">'+(pct===null?'—':'<strong>'+pct+'%</strong><small>'+grades.length+' graded</small>')+'</td>';
  }).join("");

  const classCourseworkAvg=studentCourseworkAverages.length?Math.round((studentCourseworkAverages.reduce((a,b)=>a+b,0)/studentCourseworkAverages.length)*10)/10:null;
  const classAssessmentAvg=studentAssessmentAverages.length?Math.round((studentAssessmentAverages.reduce((a,b)=>a+b,0)/studentAssessmentAverages.length)*10)/10:null;
  const completion=totalGradeCells?Math.round((completedGradeCells/totalGradeCells)*100):0;

  const footer='<tfoot><tr><td class="student-sticky gradebook-class-label"><strong>Class Average</strong><span>'+students.length+' student'+(students.length===1?"":"s")+'</span></td>'+
    assignmentClassCells+assessmentClassCells+
    '<td class="avg-sticky coursework-avg-col gradebook-average class-summary"><strong>'+(classCourseworkAvg===null?'—':classCourseworkAvg+'%')+'</strong><span>Class</span></td>'+
    '<td class="avg-sticky assessment-avg-col gradebook-average class-summary"><strong>'+(classAssessmentAvg===null?'—':classAssessmentAvg+'%')+'</strong><span>Class</span></td></tr></tfoot>';

  const summary='<div class="gradebook-summary-strip">'+
    '<div><span>Students</span><strong>'+students.length+'</strong></div>'+
    '<div><span>Coursework</span><strong>'+assignments.length+'</strong></div>'+
    '<div><span>Assessments</span><strong>'+assessments.length+'</strong></div>'+
    '<div><span>Grading Complete</span><strong>'+completion+'%</strong></div>'+
    '<div><span>Class Coursework</span><strong>'+(classCourseworkAvg===null?'—':classCourseworkAvg+'%')+'</strong></div>'+
    '<div><span>Class Assessment</span><strong>'+(classAssessmentAvg===null?'—':classAssessmentAvg+'%')+'</strong></div>'+
  '</div>';

  const nav='<div class="gradebook-toolbar"><div class="gradebook-jumps"><span>Jump to</span>'+unitJumpButtons+
    (assessments.length?'<button class="gradebook-jump assessment-jump" data-action="gradebook-jump" data-target="assessments"><span>✓</span>Assessments<small>'+assessments.length+'</small></button>':'')+
    '</div><div class="gradebook-help">Student names and averages stay pinned while you scroll.</div></div>';

  return summary+
    '<div class="notice gradebook-notice">Coursework and formal assessments share this gradebook, but their averages remain separate because the certified final grade follows each student’s grading pathway.</div>'+
    nav+
    '<div class="gradebook-legend"><span><i class="legend-dot coursework-dot"></i> Click coursework cells to grade</span><span><i class="legend-dot assessment-dot"></i> Assessment cells open formal grading</span><span><i class="legend-dot empty-dot"></i> No grade recorded</span></div>'+
    '<div class="data-table-wrap gradebook-wrap"><table class="data-table gradebook-table">'+header+'<tbody>'+body+'</tbody>'+footer+'</table></div>';
}

function renderStudentGrades(){
  const assignments=state.sectionData.assignments.filter(a=>a.status!=="Draft");
  const assessments=(state.sectionData.assessmentRefs||[]).filter(a=>a.status!=="Draft");
  const gradeMap=new Map(state.sectionData.grades.map(g=>[g.assignmentId,g]));
  const assessmentGradeMap=new Map((state.sectionData.assessmentGrades||[]).map(g=>[g.assessmentId,g]));

  let courseworkEarned=0,courseworkPossible=0;
  const assignmentRows=assignments.map(a=>{
    const g=gradeMap.get(a.id);
    if(g){courseworkEarned+=Number(g.score||0);courseworkPossible+=Number(a.points||0);}
    return '<tr><td><strong>'+esc(a.title)+'</strong><span class="grade-sub">'+esc(a.type||"Assignment")+'</span></td><td><span class="badge">Coursework</span></td><td>'+esc(a.points||0)+'</td><td>'+(g?esc(g.score):"—")+'</td><td>'+(g&&a.points?Math.round((Number(g.score)/Number(a.points))*1000)/10+"%":"—")+'</td></tr>';
  }).join("");

  const assessmentPercents=[];
  const assessmentRows=assessments.map(a=>{
    const g=assessmentGradeMap.get(a.id);
    if(g&&g.percent!==null&&g.percent!==undefined)assessmentPercents.push(Number(g.percent));
    return '<tr class="assessment-grade-row"><td><strong>'+esc(a.title||"Assessment")+'</strong><span class="grade-sub">'+esc(a.assessmentType||a.type||"Formal Assessment")+'</span></td><td><span class="badge assessment-badge">Assessment</span></td><td>'+(g?esc(g.maxScore??a.totalPoints??"—"):esc(a.totalPoints||"—"))+'</td><td>'+(g?esc(g.score??"—"):"—")+'</td><td>'+(g?'<strong>'+esc(g.percent)+'%</strong>':'<span class="grade-pending">Awaiting grade</span>')+'</td></tr>';
  }).join("");

  const courseworkAvg=courseworkPossible?Math.round((courseworkEarned/courseworkPossible)*1000)/10:null;
  const assessmentAvg=assessmentPercents.length?Math.round((assessmentPercents.reduce((a,b)=>a+b,0)/assessmentPercents.length)*10)/10:null;

  return '<div class="student-grade-summary"><div><span>Coursework Average</span><strong>'+(courseworkAvg===null?"—":courseworkAvg+"%")+'</strong></div><div><span>Assessment Average</span><strong>'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</strong></div></div>'+
    '<div class="academic-banner"><div class="kicker">Academic Progress</div><h3>Coursework and formal assessments are recorded separately.</h3><p>Your final certified grade is calculated later using the grading pathway you selected, not by simply averaging these two numbers together.</p></div>'+
    '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Academic Work</th><th>Category</th><th>Possible</th><th>Score</th><th>Percent</th></tr></thead><tbody>'+assignmentRows+assessmentRows+'</tbody></table></div>';
}

function renderSectionDetail(tab="overview"){
  const s=state.currentSection;
  const d=state.sectionData;
  const instructor=state.role==="instructor";
  let body="";
  if(tab==="overview"){
    const entranceRequired=d.course?.entranceExamRequired===true||s.entranceExamRequired===true;
    const entranceConfigured=!!s.entranceAssessmentId;
    body=(instructor?'<div class="join-display"><div><div class="eyebrow">Section Enrollment</div><div class="join-code">'+esc(s.joinCode||"No Code")+'</div><p>'+esc(s.joinOpen!==false?(entranceRequired?(entranceConfigured?"Entrance examination required before enrollment":"Enrollment waiting for entrance-exam setup"):"Accepting students"):"Enrollment is currently closed")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-action="copy-code" data-code="'+esc(s.joinCode||"")+'">Copy Code</button><button class="secondary-btn small-btn" data-action="show-code">Display Full Screen</button><button class="secondary-btn small-btn" data-action="regenerate-code">Regenerate</button><button class="secondary-btn small-btn" data-action="toggle-enrollment">'+(s.joinOpen!==false?"Close Enrollment":"Open Enrollment")+'</button></div></div><div class="qr-box"><img alt="Join QR code" src="https://quickchart.io/qr?size=180&text='+encodeURIComponent(location.origin+location.pathname+"?join="+s.joinCode)+'"></div></div>':'')+
      (entranceRequired?'<div class="panel entrance-exam-panel" style="margin-bottom:18px"><div class="panel-head"><div><div class="panel-title">Entrance Examination</div><div class="panel-subtitle">'+(entranceConfigured?'Students must pass this assessment before enrollment.':'This course mandates an entrance exam. Configure one before students can enroll.')+'</div></div><span class="badge '+(entranceConfigured?'live':'gold')+'">'+(entranceConfigured?'Configured':'Required')+'</span></div><div class="panel-body">'+(entranceConfigured?'<div class="detail-list"><div><span>Assessment</span><strong>'+esc(s.entranceExamTitle||"Entrance Examination")+'</strong></div><div><span>Passing Score</span><strong>'+esc(s.entrancePassPercent||70)+'%</strong></div></div><div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+esc(s.entranceAssessmentId)+'">Open Entrance Exam</button><button class="secondary-btn small-btn" data-phase3-action="configure-entrance-exam" data-section="'+esc(s.id)+'">Change Exam</button></div>':'<div class="empty-mini">Create an assessment template from the Question Bank, then choose it as this section’s entrance examination.</div><div class="card-actions"><button class="primary-btn small-btn" data-phase3-action="configure-entrance-exam" data-section="'+esc(s.id)+'">Configure Entrance Exam</button></div>')+'</div></div>':'')+
      '<div class="section-summary"><div class="summary-block"><div class="summary-label">Course</div><div class="summary-value">'+esc(s.courseCode||"—")+'</div></div><div class="summary-block"><div class="summary-label">Term</div><div class="summary-value">'+esc(s.term||"—")+'</div></div><div class="summary-block"><div class="summary-label">'+(instructor?"Students":"Instructor")+'</div><div class="summary-value">'+esc(instructor?d.members.length:(s.instructorName||"—"))+'</div></div><div class="summary-block"><div class="summary-label">Format</div><div class="summary-value">'+esc(s.format||"—")+'</div></div></div>'+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Current Course Framework</div></div><div class="panel-body"><strong style="font-family:Libre Baskerville,serif;font-size:18px;font-weight:400">'+esc(s.courseTitle||"Course")+'</strong><p class="page-subtitle" style="margin-top:7px">'+esc(d.course?.description||"Open the Course Guide to review units and topics.")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-action="section-tab" data-tab="framework">Open Course Guide</button></div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Academic Work</div></div><div class="panel-body"><div class="attention-list"><div class="attention-item"><div class="attention-number">'+d.assignments.filter(a=>a.status!=="Draft").length+'</div><div class="attention-copy"><strong>Published assignments</strong><span>Coursework currently visible to students.</span></div></div><div class="attention-item"><div class="attention-number">'+d.resources.length+'</div><div class="attention-copy"><strong>Resources</strong><span>Readings and scholarly materials.</span></div></div></div></div></div></div>';
  }else if(tab==="framework") body=renderFrameworkReadOnly();
  else if(tab==="assignments") body=renderAssignments();
  else if(tab==="resources") body=renderResources();
  else if(tab==="students") body=renderStudents();
  else if(tab==="gradebook") body=renderGradebook();
  else if(tab==="grades") body=renderStudentGrades();
  else if(["examinations","grading","pathway"].includes(tab)) body='<div id="phase3SectionTab"><div class="empty-mini">Loading assessment workspace…</div></div>';
  else if(["analytics","records","progress","record"].includes(tab)) body='<div id="phase4SectionTab"><div class="empty-mini">Loading academic analytics…</div></div>';

  $("#sectionDetail").innerHTML =
    '<button class="text-btn" data-action="back-sections">← Sections</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(s.courseCode||"Section")+' • '+esc(s.term||"")+'</div><h1 class="detail-title">'+esc(s.courseTitle||s.sectionName||"Section")+'</h1><div class="detail-meta"><span>'+esc(s.sectionName||("Section "+(s.sectionNumber||"")))+'</span><span>'+esc(s.instructorName||"")+'</span><span>'+esc(s.startDate?formatDate(s.startDate)+" – "+formatDate(s.endDate):s.format||"")+'</span></div></div>'+(instructor?'<div class="inline-actions"><button class="secondary-btn small-btn" data-action="edit-section">Edit Section</button><button class="danger-btn small-btn" data-action="delete-section">Delete Section</button></div>':'')+'</div></div>'+
    sectionTabs(tab)+'<div id="sectionTabBody">'+body+'</div>';
  if(["examinations","grading","pathway"].includes(tab) && window.TheoriaPhase3?.renderSectionTab){
    window.TheoriaPhase3.renderSectionTab(tab);
  }
  if(["analytics","records","progress","record"].includes(tab) && window.TheoriaPhase4?.renderSectionTab){
    window.TheoriaPhase4.renderSectionTab(tab);
  }
}


function stripAssignmentJsonFence(text){
  let value=String(text||"").trim();
  value=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const firstArray=value.indexOf("["),lastArray=value.lastIndexOf("]");
  const firstObject=value.indexOf("{"),lastObject=value.lastIndexOf("}");
  if(firstArray>=0&&lastArray>firstArray)return value.slice(firstArray,lastArray+1);
  if(firstObject>=0&&lastObject>firstObject)return value.slice(firstObject,lastObject+1);
  return value;
}

function addDaysToIsoDate(dateString,days){
  if(!dateString)return "";
  const date=new Date(dateString+"T12:00:00");
  if(Number.isNaN(date.getTime()))return "";
  date.setDate(date.getDate()+Number(days||0));
  const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0");
  return y+"-"+m+"-"+d;
}

function bulkAssignmentPrompt(section,course,unit){
  const topics=(unit?.topics||[]).map(topic=>{
    const pieces=[
      (topic.number||topic.id)+" — "+topic.title,
      topic.learningObjective?"Objective: "+topic.learningObjective:"",
      topic.essentialKnowledge?"Essential knowledge: "+topic.essentialKnowledge:"",
      topic.competencyCodes?.length?"Competencies: "+topic.competencyCodes.join(", "):""
    ].filter(Boolean);
    return pieces.join(" | ");
  });

  return [
    "Create a complete unit assignment set for Theoria.",
    "",
    "Course: "+(course?.code||"")+" — "+(course?.title||""),
    "Section: "+(section?.sectionName||""),
    "Unit: "+(unit?.order||"")+" — "+(unit?.title||""),
    unit?.description?"Unit description: "+unit.description:"",
    "",
    "Return ONLY valid JSON. Do not use Markdown fences, commentary, headings, or explanatory prose.",
    "Return either a JSON array of assignment objects or an object with a single \"assignments\" array.",
    "",
    "Each assignment object may use:",
    "{",
    '  "title": "assignment title",',
    '  "type": "Academic Exercise | Written Response | Research Assignment | Reading Response | Exegetical Exercise | Primary Source Analysis | Argument Analysis | Seminar Preparation | Assignment",',
    '  "description": "one-sentence student-facing overview",',
    '  "instructionSteps": ["step one", "step two"],',
    '  "requirements": ["requirement one", "requirement two"],',
    '  "points": 100,',
    '  "topicNumber": "1.1",',
    '  "dueDate": "YYYY-MM-DD",',
    '  "dueOffsetDays": 7,',
    '  "status": "Draft | Published",',
    '  "submissionMode": "Text + Link | Text Response | Link / Document | Completion Confirmation | No Online Submission",',
    '  "allowResubmission": false,',
    '  "tags": ["essay", "primary-source"],',
    '  "order": 1',
    "}",
    "",
    "Rules:",
    "- Design a coherent sequence of coursework for the entire unit, not isolated random assignments.",
    "- Use only topic numbers from the selected unit below.",
    "- Use instructionSteps for ordered student directions and requirements for deliverables/rules.",
    "- Use either dueDate OR dueOffsetDays. dueOffsetDays means days after the unit start date that I will choose in Theoria.",
    "- Keep assignment types and submission modes exactly within the allowed values.",
    "- Set reasonable point values and order the assignments pedagogically.",
    "- Do not create a formal examination unless I explicitly ask; formal exams belong in Theoria Assessments.",
    "",
    "UNIT TOPICS:",
    ...(topics.length?topics:["No topics are currently defined for this unit. Leave topicNumber empty."])
  ].filter(Boolean).join("\n");
}

function normalizeBulkAssignment(raw,index,unit,unitStartDate,defaults,existingTitles){
  const errors=[],warnings=[];
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return {index,errors:["Assignment is not a JSON object."],warnings:[],data:null};

  const allowedTypes=["Academic Exercise","Written Response","Research Assignment","Reading Response","Exegetical Exercise","Primary Source Analysis","Argument Analysis","Seminar Preparation","Assignment"];
  const typeAliases={
    "essay":"Written Response",
    "research":"Research Assignment",
    "reading":"Reading Response",
    "exegesis":"Exegetical Exercise",
    "primary source":"Primary Source Analysis",
    "argument":"Argument Analysis",
    "seminar":"Seminar Preparation"
  };
  let type=String(raw.type||"Assignment").trim();
  if(!allowedTypes.includes(type))type=typeAliases[type.toLowerCase()]||type;
  if(!allowedTypes.includes(type)){warnings.push("Unknown assignment type defaulted to Assignment.");type="Assignment";}

  const title=String(raw.title||raw.name||"").trim();
  if(!title)errors.push("Assignment title is required.");
  if(title&&existingTitles.has(title.toLowerCase()))warnings.push("An assignment with this title already exists in the section.");

  const pointsRaw=Number(raw.points??100);
  const points=Number.isFinite(pointsRaw)&&pointsRaw>=0?pointsRaw:100;
  if(!Number.isFinite(pointsRaw)||pointsRaw<0)warnings.push("Points defaulted to 100.");

  const allowedStatuses=["Draft","Published"];
  const status=allowedStatuses.includes(String(raw.status||""))?String(raw.status):defaults.status;
  if(raw.status&&!allowedStatuses.includes(String(raw.status)))warnings.push("Status defaulted to "+defaults.status+".");

  const allowedSubmissionModes=["Text + Link","Text Response","Link / Document","Completion Confirmation","No Online Submission"];
  const submissionMode=allowedSubmissionModes.includes(String(raw.submissionMode||""))?String(raw.submissionMode):defaults.submissionMode;
  if(raw.submissionMode&&!allowedSubmissionModes.includes(String(raw.submissionMode)))warnings.push("Submission mode defaulted to "+defaults.submissionMode+".");

  const instructionSteps=(Array.isArray(raw.instructionSteps)?raw.instructionSteps:(Array.isArray(raw.instructions)?raw.instructions:[])).map(x=>String(x).trim()).filter(Boolean);
  const requirements=(Array.isArray(raw.requirements)?raw.requirements:[]).map(x=>String(x).trim()).filter(Boolean);
  const tags=(Array.isArray(raw.tags)?raw.tags:String(raw.tags||"").split(",")).map(x=>String(x).trim()).filter(Boolean);

  const topicNumber=String(raw.topicNumber||raw.topic||"").trim();
  const topic=topicNumber?(unit?.topics||[]).find(t=>String(t.number||"").trim().toLowerCase()===topicNumber.toLowerCase()):null;
  if(topicNumber&&!topic)warnings.push("Topic "+topicNumber+" was not found in the selected unit and will be left unassigned.");

  let dueDate=String(raw.dueDate||"").trim();
  if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)){warnings.push("Invalid dueDate ignored.");dueDate="";}
  const dueOffsetRaw=raw.dueOffsetDays;
  const dueOffsetDays=dueOffsetRaw===undefined||dueOffsetRaw===null||dueOffsetRaw===""?null:Number(dueOffsetRaw);
  if(!dueDate&&dueOffsetDays!==null){
    if(!Number.isFinite(dueOffsetDays))warnings.push("Invalid dueOffsetDays ignored.");
    else if(!unitStartDate)warnings.push("dueOffsetDays was provided, but no Unit Start Date is set; due date will be blank.");
    else dueDate=addDaysToIsoDate(unitStartDate,dueOffsetDays);
  }

  const orderRaw=Number(raw.order??index+1);
  const unitSequence=Number.isFinite(orderRaw)?orderRaw:index+1;

  return {
    index,errors,warnings,
    data:{
      title,type,points,dueDate,status,
      description:String(raw.description||raw.overview||"").trim(),
      instructionSteps,requirements,
      submissionMode,
      allowResubmission:raw.allowResubmission===undefined?defaults.allowResubmission:!!raw.allowResubmission,
      tags,
      unitId:unit?.id||"",
      unitTitle:unit?.title||"",
      unitNumber:unit?.order||"",
      topicId:topic?.id||"",
      topicTitle:topic?.title||"",
      topicNumber:topic?.number||"",
      unitSequence
    }
  };
}

async function bulkImportAssignmentsModal(){
  if(state.role!=="instructor"||!state.currentSection||!state.sectionData)return;
  const section=state.currentSection,course=state.sectionData.course,framework=state.sectionData.framework;
  if(!framework?.units?.length)return showToast("Create at least one course unit before bulk-importing unit assignments.");

  let selectedUnit=framework.units[0];
  let parsedRows=[];
  const existingTitles=new Set((state.sectionData.assignments||[]).map(a=>String(a.title||"").trim().toLowerCase()).filter(Boolean));

  const modal=openModal({
    eyebrow:"Unit Coursework",
    title:"Bulk Import Assignments",
    wide:true,
    body:'<div class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Unit & Defaults</h3><p>Select the unit and scheduling defaults for the assignment set.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Unit</label><select id="bulkAssignmentUnit">'+framework.units.map(u=>'<option value="'+u.id+'">Unit '+esc(u.order||"")+' — '+esc(u.title)+'</option>').join("")+'</select></div>'+
        '<div class="field"><label>Unit Start Date</label><input id="bulkAssignmentStart" type="date"></div>'+
        '<div class="field"><label>Default Status</label><select id="bulkAssignmentStatus"><option>Draft</option><option>Published</option></select></div></div>'+
        '<div class="compact-field-grid" style="margin-top:12px"><div class="field"><label>Default Submission</label><select id="bulkAssignmentSubmission"><option>Text + Link</option><option>Text Response</option><option>Link / Document</option><option>Completion Confirmation</option><option>No Online Submission</option></select></div>'+
        '<div class="field"><label class="checkbox-line submission-setting"><input type="checkbox" id="bulkAssignmentResubmit"> Allow resubmission by default</label></div></div>'+
        '<div class="bulk-import-prompt-row"><div><strong>Generate the whole unit in ChatGPT</strong><span>The prompt includes this unit’s actual topics, objectives, and allowed Theoria assignment fields.</span></div><button type="button" class="secondary-btn" id="copyAssignmentPrompt">Copy ChatGPT Unit Prompt</button></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Add Assignment Set</h3><p>Paste the complete JSON response once or upload a .json file.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>JSON File</label><input id="bulkAssignmentFile" type="file" accept=".json,application/json"></div><div class="field"><label>Expected Format</label><div class="static-field">JSON array or {"assignments":[...]}</div></div></div>'+
        '<div class="field"><label>Paste Complete Unit Assignment Set</label><textarea id="bulkAssignmentJson" class="bulk-json-editor" spellcheck="false" placeholder="Paste the complete JSON assignment set here"></textarea></div>'+
        '<button type="button" class="primary-btn" id="previewBulkAssignments">Validate & Preview</button>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Import Preview</h3><p>Review titles, dates, points, topics, and warnings before saving anything.</p></div><div id="bulkAssignmentSummary"></div></div><div id="bulkAssignmentResults"><div class="empty-mini">Paste or upload an assignment set, then validate it.</div></div></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="importBulkAssignments" disabled>Import Assignments</button></div>'+
    '</div>'
  });

  const unitSelect=modal.querySelector("#bulkAssignmentUnit");
  const startInput=modal.querySelector("#bulkAssignmentStart");
  const statusSelect=modal.querySelector("#bulkAssignmentStatus");
  const submissionSelect=modal.querySelector("#bulkAssignmentSubmission");
  const resubmitInput=modal.querySelector("#bulkAssignmentResubmit");
  const textarea=modal.querySelector("#bulkAssignmentJson");
  const fileInput=modal.querySelector("#bulkAssignmentFile");
  const summary=modal.querySelector("#bulkAssignmentSummary");
  const results=modal.querySelector("#bulkAssignmentResults");
  const importButton=modal.querySelector("#importBulkAssignments");

  const defaults=()=>({
    status:statusSelect.value||"Draft",
    submissionMode:submissionSelect.value||"Text + Link",
    allowResubmission:resubmitInput.checked
  });
  const resetPreview=()=>{
    parsedRows=[];
    summary.innerHTML="";
    results.innerHTML='<div class="empty-mini">Validate the current assignment set before importing.</div>';
    importButton.disabled=true;
    importButton.textContent="Import Assignments";
  };

  unitSelect.addEventListener("change",()=>{selectedUnit=framework.units.find(u=>u.id===unitSelect.value)||framework.units[0];resetPreview();});
  [startInput,statusSelect,submissionSelect,resubmitInput].forEach(input=>input.addEventListener("change",resetPreview));

  modal.querySelector("#copyAssignmentPrompt").addEventListener("click",async()=>{
    const prompt=bulkAssignmentPrompt(section,course,selectedUnit);
    try{
      await navigator.clipboard.writeText(prompt);
      showToast("Unit assignment prompt copied for ChatGPT.");
    }catch(_){
      textarea.value=prompt;
      showToast("Clipboard access was unavailable, so the prompt was placed in the editor.");
    }
  });

  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{textarea.value=await file.text();resetPreview();}catch(_){showToast("The JSON file could not be read.");}
  });

  modal.querySelector("#previewBulkAssignments").addEventListener("click",()=>{
    let payload;
    try{
      const parsed=JSON.parse(stripAssignmentJsonFence(textarea.value));
      payload=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.assignments)?parsed.assignments:null);
      if(!payload)throw new Error("Expected a JSON array or an object with an assignments array.");
    }catch(error){
      parsedRows=[];
      summary.innerHTML='<span class="badge danger">Invalid JSON</span>';
      results.innerHTML='<div class="notice danger-notice">'+esc(error.message||"The assignment set is not valid JSON.")+'</div>';
      importButton.disabled=true;
      return;
    }

    parsedRows=payload.map((row,index)=>normalizeBulkAssignment(row,index,selectedUnit,startInput.value,defaults(),existingTitles));
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    const invalid=parsedRows.filter(row=>row.errors.length);
    const warnings=parsedRows.filter(row=>row.warnings.length);
    const totalPoints=valid.reduce((n,row)=>n+Number(row.data.points||0),0);

    summary.innerHTML='<div class="bulk-preview-counts"><span><strong>'+valid.length+'</strong> valid</span><span><strong>'+invalid.length+'</strong> invalid</span><span><strong>'+warnings.length+'</strong> warnings</span><span><strong>'+totalPoints+'</strong> total pts</span></div>';
    results.innerHTML=parsedRows.length?'<div class="bulk-preview-list">'+parsedRows.map(row=>
      '<div class="bulk-preview-row '+(row.errors.length?'invalid':row.warnings.length?'warning':'valid')+'"><div class="bulk-preview-number">'+(row.index+1)+'</div><div><strong>'+esc(row.data?.title||"Invalid assignment")+'</strong><span>'+esc(row.data?.type||"")+(row.data?.topicNumber?' • Topic '+esc(row.data.topicNumber):'')+(row.data?.dueDate?' • Due '+esc(row.data.dueDate):'')+(row.data?' • '+esc(row.data.points)+' pts':'')+'</span>'+
      (row.errors.length?'<div class="bulk-messages errors">'+row.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
      (row.warnings.length?'<div class="bulk-messages warnings">'+row.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
      '</div></div>'
    ).join("")+'</div>':'<div class="empty-mini">No assignments were found in the JSON.</div>';

    importButton.disabled=!valid.length;
    importButton.textContent=valid.length?"Import "+valid.length+" Assignment"+(valid.length===1?"":"s"):"Import Assignments";
  });

  importButton.addEventListener("click",async()=>{
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    if(!valid.length)return;
    importButton.disabled=true;importButton.textContent="Importing…";
    try{
      for(let offset=0;offset<valid.length;offset+=400){
        const batch=writeBatch(db);
        valid.slice(offset,offset+400).forEach(row=>{
          const ref=doc(collection(db,"sections",section.id,"assignments"));
          batch.set(ref,{
            ...row.data,
            importedInBulk:true,
            createdAt:serverTimestamp(),
            updatedAt:serverTimestamp()
          });
        });
        await batch.commit();
      }
      closeModal();
      state.sectionData=await loadSectionData(section);
      renderSectionDetail("assignments");
      const skipped=parsedRows.length-valid.length;
      showToast(valid.length+" assignment"+(valid.length===1?"":"s")+" imported for "+selectedUnit.title+(skipped?" • "+skipped+" invalid skipped":"")+".");
    }catch(error){
      importButton.disabled=false;
      importButton.textContent="Import "+valid.length+" Assignment"+(valid.length===1?"":"s");
      showToast(humanizeFirebaseError(error));
    }
  });
}

function openAssignmentModal(existing){
  const types=["Academic Exercise","Written Response","Research Assignment","Reading Response","Exegetical Exercise","Primary Source Analysis","Argument Analysis","Seminar Preparation","Assignment"];
  const steps=Array.isArray(existing?.instructionSteps)&&existing.instructionSteps.length ? existing.instructionSteps : [""];
  const requirements=Array.isArray(existing?.requirements)&&existing.requirements.length ? existing.requirements : [];
  const typeTiles=types.map((type,index)=>'<label class="type-tile '+((existing?.type||"Assignment")===type?'selected':'')+'"><input type="radio" name="type" value="'+esc(type)+'" '+((existing?.type||"Assignment")===type?'checked':'')+'><span class="type-tile-mark">'+String(index+1).padStart(2,"0")+'</span><span>'+esc(type)+'</span></label>').join("");

  const modal=openModal({
    eyebrow:"Section Coursework",
    title:existing?"Edit Assignment":"Create Assignment",
    wide:true,
    body:'<form id="assignmentForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Assignment Identity</h3><p>Name the work and choose its academic purpose.</p></div></div>'+
        '<div class="field"><label>Assignment Title</label><input class="title-input" name="title" value="'+esc(existing?.title||"")+'" placeholder="e.g. Nicene Creed Primary Source Analysis" required></div>'+
        '<div class="field"><label>Assignment Type</label><div class="type-tile-grid">'+typeTiles+'</div></div>'+
        '<div class="compact-field-grid" style="margin-top:12px"><div class="field"><label>Unit Folder</label><select name="unitId" id="assignmentUnit"></select></div><div class="field"><label>Topic</label><select name="topicId" id="assignmentTopic"></select></div><div class="field"><label>Organization</label><div class="static-field">Used for student and instructor unit folders</div></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Scoring & Schedule</h3><p>Set the practical details without leaving the page.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Points</label><div class="input-with-suffix"><input type="number" min="0" step="0.1" name="points" value="'+esc(existing?.points??100)+'" required><span>pts</span></div></div>'+
        '<div class="field"><label>Due Date</label><input type="date" name="dueDate" value="'+esc(existing?.dueDate||"")+'"></div>'+
        '<div class="field"><label>Status</label><select name="status"><option>Published</option><option>Draft</option></select></div></div>'+
        '<div class="compact-field-grid" style="margin-top:12px"><div class="field"><label>Student Submission</label><select name="submissionMode"><option>Text + Link</option><option>Text Response</option><option>Link / Document</option><option>Completion Confirmation</option><option>No Online Submission</option></select></div><div class="field"><label class="checkbox-line submission-setting"><input type="checkbox" name="allowResubmission" '+(existing?.allowResubmission?'checked':'')+'> Allow students to revise after submitting</label></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Student Directions</h3><p>Build clear instructions one step at a time instead of writing one giant block.</p></div></div>'+
        '<div class="field"><label>Short Overview</label><input name="description" value="'+esc(existing?.description||"")+'" placeholder="One sentence describing what students are doing."></div>'+
        '<div class="structured-builder"><div class="structured-builder-head"><div><strong>Instruction Steps</strong><span>Students see these in order.</span></div><button type="button" class="secondary-btn small-btn" id="addAssignmentStep">+ Add Step</button></div><div id="assignmentSteps" class="structured-list"></div></div>'+
        '<div class="structured-builder"><div class="structured-builder-head"><div><strong>Requirements</strong><span>Optional deliverables, format rules, or source requirements.</span></div><button type="button" class="secondary-btn small-btn" id="addAssignmentRequirement">+ Add Requirement</button></div><div id="assignmentRequirements" class="structured-list"></div></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Assignment</button></div></form>'
  });

  const form=modal.querySelector("#assignmentForm");
  form.status.value=existing?.status||"Published";
  form.submissionMode.value=existing?.submissionMode||"Text + Link";

  const assignmentFramework=state.sectionData?.framework||{units:[]};
  const assignmentUnit=form.querySelector("#assignmentUnit"),assignmentTopic=form.querySelector("#assignmentTopic");
  assignmentUnit.innerHTML='<option value="">Unsorted / no unit</option>'+assignmentFramework.units.map(u=>'<option value="'+u.id+'">'+esc("Unit "+(u.order||"")+" — "+u.title)+'</option>').join("");
  assignmentUnit.value=existing?.unitId||"";
  const fillAssignmentTopics=()=>{
    const unit=assignmentFramework.units.find(u=>u.id===assignmentUnit.value);
    assignmentTopic.innerHTML='<option value="">No specific topic</option>'+((unit?.topics||[]).map(t=>'<option value="'+t.id+'">'+esc((t.number||"")+" — "+t.title)+'</option>').join(""));
    assignmentTopic.value=(existing?.topicId&&unit?.topics?.some(t=>t.id===existing.topicId))?existing.topicId:"";
  };
  assignmentUnit.addEventListener("change",fillAssignmentTopics);
  fillAssignmentTopics();

  const renderRow=(container,value,index,kind)=>{
    const row=document.createElement("div");
    row.className="structured-row";
    row.dataset.kind=kind;
    row.innerHTML='<div class="structured-index">'+String(index+1).padStart(2,"0")+'</div><input class="structured-input" value="'+esc(value||"")+'" placeholder="'+(kind==="step"?"Explain what the student should do…":"e.g. Cite at least two primary sources")+'"><button type="button" class="row-remove" aria-label="Remove">×</button>';
    row.querySelector(".row-remove").addEventListener("click",()=>{row.remove();renumber(container);});
    container.appendChild(row);
  };
  const renumber=container=>[...container.querySelectorAll(".structured-row")].forEach((row,i)=>row.querySelector(".structured-index").textContent=String(i+1).padStart(2,"0"));
  const stepBox=modal.querySelector("#assignmentSteps"),reqBox=modal.querySelector("#assignmentRequirements");
  steps.forEach((x,i)=>renderRow(stepBox,x,i,"step"));
  requirements.forEach((x,i)=>renderRow(reqBox,x,i,"requirement"));
  modal.querySelector("#addAssignmentStep").addEventListener("click",()=>renderRow(stepBox,"",stepBox.children.length,"step"));
  modal.querySelector("#addAssignmentRequirement").addEventListener("click",()=>renderRow(reqBox,"",reqBox.children.length,"requirement"));
  modal.querySelectorAll('.type-tile input').forEach(input=>input.addEventListener("change",()=>modal.querySelectorAll(".type-tile").forEach(tile=>tile.classList.toggle("selected",tile.contains(input)&&input.checked))));

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const instructionSteps=[...stepBox.querySelectorAll(".structured-input")].map(x=>x.value.trim()).filter(Boolean);
    const requirements=[...reqBox.querySelectorAll(".structured-input")].map(x=>x.value.trim()).filter(Boolean);
    const selectedUnit=assignmentFramework.units.find(u=>u.id===String(fd.get("unitId")||""));
    const selectedTopic=(selectedUnit?.topics||[]).find(t=>t.id===String(fd.get("topicId")||""));
    const data={
      title:String(fd.get("title")).trim(),
      type:String(fd.get("type")||"Assignment"),
      points:Number(fd.get("points")),
      dueDate:String(fd.get("dueDate")||""),
      status:String(fd.get("status")),
      description:String(fd.get("description")||"").trim(),
      instructionSteps,
      requirements,
      submissionMode:String(fd.get("submissionMode")||"Text + Link"),
      allowResubmission:form.elements.allowResubmission.checked,
      unitId:selectedUnit?.id||"",
      unitTitle:selectedUnit?.title||"",
      unitNumber:Number(selectedUnit?.order||0),
      topicId:selectedTopic?.id||"",
      topicTitle:selectedTopic?.title||"",
      topicNumber:selectedTopic?.number||"",
      tags:existing?.tags||[],
      unitSequence:Number(selectedTopic?.order||existing?.unitSequence||0),
      updatedAt:serverTimestamp()
    };
    try{
      if(existing) await updateDoc(doc(db,"sections",state.currentSection.id,"assignments",existing.id),data);
      else await addDoc(collection(db,"sections",state.currentSection.id,"assignments"),{...data,createdAt:serverTimestamp()});
      closeModal(); state.sectionData=await loadSectionData(state.currentSection);renderSectionDetail("assignments");showToast("Assignment saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

async function deleteRefsInBatches(refs){
  for(let i=0;i<refs.length;i+=400){
    const batch=writeBatch(db);
    refs.slice(i,i+400).forEach(ref=>batch.delete(ref));
    await batch.commit();
  }
}

async function deleteAssignment(assignmentId){
  const section=state.currentSection;
  const assignment=state.sectionData.assignments.find(x=>x.id===assignmentId);
  if(!section||!assignment)return showToast("Assignment not found.");

  try{
    const [submissionSnap,gradeSnap,appealSnap,portfolioSnap]=await Promise.all([
      getDocs(collection(db,"sections",section.id,"assignments",assignmentId,"submissions")),
      getDocs(collection(db,"sections",section.id,"grades")),
      getDocs(collection(db,"sections",section.id,"appeals")),
      getDocs(collection(db,"sections",section.id,"portfolios"))
    ]);

    const gradeDocs=gradeSnap.docs.filter(d=>d.data().assignmentId===assignmentId);
    const unresolvedAppeals=appealSnap.docs.filter(d=>{
      const a=d.data();
      return a.targetType==="Coursework"&&a.targetId===assignmentId&&![ "Resolved","Denied","Withdrawn" ].includes(a.status);
    });

    if(unresolvedAppeals.length){
      return showToast("Resolve the open grade appeal"+(unresolvedAppeals.length===1?"":"s")+" for this assignment before deleting it.");
    }

    const submissions=submissionSnap.docs;
    const hasAcademicData=submissions.length>0||gradeDocs.length>0;
    const modal=openModal({
      eyebrow:"Delete Assignment",
      title:assignment.title,
      body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>This permanently removes the assignment from this section.</strong><p>Student submission records and gradebook entries tied to this assignment will also be removed. Existing certified academic-record history is not rewritten.</p></div></div>'+
        '<div class="detail-list" style="margin-top:16px"><div><span>Submissions / Drafts</span><strong>'+submissions.length+'</strong></div><div><span>Gradebook Entries</span><strong>'+gradeDocs.length+'</strong></div><div><span>Portfolio Records Checked</span><strong>'+portfolioSnap.docs.length+'</strong></div></div>'+
        (hasAcademicData?'<div class="notice danger-notice" style="margin-top:16px">This assignment contains student academic data. Type <strong>DELETE</strong> to confirm permanent removal.</div><div class="field" style="margin-top:14px"><label>Confirmation</label><input id="deleteAssignmentConfirm" autocomplete="off" placeholder="Type DELETE"></div>':'<div class="notice" style="margin-top:16px">No student submission or grade data is attached to this assignment.</div>'),
      footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteAssignment" '+(hasAcademicData?'disabled':'')+'>Delete Assignment</button>'
    });

    const button=modal.querySelector("#confirmDeleteAssignment"),input=modal.querySelector("#deleteAssignmentConfirm");
    if(input)input.addEventListener("input",()=>button.disabled=input.value.trim()!=="DELETE");
    button.onclick=async()=>{
      button.disabled=true;button.textContent="Deleting…";
      try{
        await deleteRefsInBatches([...submissions.map(d=>d.ref),...gradeDocs.map(d=>d.ref)]);

        // Remove stale featured-work references while preserving the rest of each portfolio.
        for(const p of portfolioSnap.docs){
          const data=p.data(),works=Array.isArray(data.featuredWorks)?data.featuredWorks:[];
          if(works.some(w=>w.type==="Coursework"&&w.id===assignmentId)){
            await updateDoc(p.ref,{
              featuredWorks:works.filter(w=>!(w.type==="Coursework"&&w.id===assignmentId)),
              updatedAt:serverTimestamp()
            });
          }
        }

        await deleteDoc(doc(db,"sections",section.id,"assignments",assignmentId));
        closeModal();
        window.TheoriaPhase4?.invalidate?.(section.id);
        state.sectionData=await loadSectionData(section);
        renderSectionDetail("assignments");
        showToast("Assignment deleted.");
      }catch(error){
        button.disabled=false;button.textContent="Delete Assignment";
        showToast(humanizeFirebaseError(error));
      }
    };
  }catch(error){showToast(humanizeFirebaseError(error));}
}

async function openStudentAssignmentModal(assignmentId){
  const assignment=state.sectionData.assignments.find(x=>x.id===assignmentId);
  if(!assignment)return showToast("Assignment not found.");
  const mode=assignment.submissionMode||"Text + Link";
  let submission=(state.sectionData.assignmentSubmissions||[]).find(x=>x.assignmentId===assignmentId)||null;
  if(!submission){
    try{
      const snap=await getDoc(doc(db,"sections",state.currentSection.id,"assignments",assignmentId,"submissions",state.user.uid));
      if(snap.exists())submission={id:snap.id,assignmentId,...snap.data()};
    }catch(_){}
  }
  const locked=submission?.status==="submitted"&&!assignment.allowResubmission;
  const due=assignmentDueState(assignment);
  const showText=["Text + Link","Text Response"].includes(mode),showLink=["Text + Link","Link / Document"].includes(mode),completion=mode==="Completion Confirmation";
  const modal=openModal({
    eyebrow:"Coursework",
    title:assignment.title,
    wide:true,
    body:'<div class="student-assignment-layout"><div class="assignment-brief">'+
      '<div class="assignment-brief-head"><div><span>'+esc(assignment.type||"Assignment")+'</span><h3>'+esc(assignment.title)+'</h3></div><div class="assignment-brief-points"><strong>'+esc(assignment.points||0)+'</strong><span>points</span></div></div>'+
      (assignment.description?'<p class="assignment-overview">'+esc(assignment.description)+'</p>':'')+
      '<div class="assignment-brief-meta"><div><span>Due</span><strong class="'+(due.late?'late-text':'')+'">'+esc(formatDate(assignment.dueDate))+'</strong></div><div><span>Submission</span><strong>'+esc(mode)+'</strong></div><div><span>Status</span><strong>'+esc(submission?.status==="submitted"?"Submitted":submission?.status==="draft"?"Draft saved":"Not started")+'</strong></div></div>'+
      (assignment.instructionSteps?.length?'<div class="assignment-full-steps"><div class="eyebrow">Instructions</div>'+assignment.instructionSteps.map((step,i)=>'<div class="assignment-full-step"><span>'+String(i+1).padStart(2,"0")+'</span><p>'+esc(step)+'</p></div>').join("")+'</div>':'')+
      (assignment.requirements?.length?'<div class="assignment-requirements"><div class="eyebrow">Requirements</div>'+assignment.requirements.map(req=>'<div>✓ '+esc(req)+'</div>').join("")+'</div>':'')+
      '</div><div class="assignment-response-panel">'+
      '<div class="panel-title">'+(locked?"Submitted Work":"Your Submission")+'</div><p class="page-subtitle">'+(locked?"This submission is locked because revision after submission is disabled.":"Your work is saved to this section in Firestore.")+'</p>'+
      '<form id="studentAssignmentForm">'+
      (showText?'<div class="field"><label>Written Response</label><textarea class="assignment-response-editor" name="responseText" placeholder="Write your response here…" '+(locked?'disabled':'')+'>'+esc(submission?.responseText||"")+'</textarea></div>':'')+
      (showLink?'<div class="field"><label>Document / Research Link</label><input type="url" name="responseUrl" value="'+esc(submission?.responseUrl||"")+'" placeholder="https://" '+(locked?'disabled':'')+'></div>':'')+
      (completion?'<label class="completion-confirmation"><input type="checkbox" name="completionAck" '+(submission?.status==="submitted"?'checked':'')+' '+(locked?'disabled':'')+'><div><strong>I completed this assignment.</strong><span>Check this box and submit to record completion.</span></div></label>':'')+
      (submission?.submittedAt?'<div class="submission-timestamp">Submitted '+esc(formatDate(submission.submittedAt))+'</div>':'')+
      (!locked?'<div class="assignment-submit-actions">'+(!completion?'<button type="button" class="secondary-btn" id="saveAssignmentDraft">Save Draft</button>':'')+'<button type="submit" class="primary-btn">'+(submission?.status==="submitted"?"Resubmit Assignment":"Submit Assignment")+'</button></div>':'')+
      '</form></div></div>'
  });
  if(locked)return;
  const form=modal.querySelector("#studentAssignmentForm");
  const save=async status=>{
    const fd=new FormData(form),responseText=String(fd.get("responseText")||"").trim(),responseUrl=String(fd.get("responseUrl")||"").trim();
    if(status==="submitted"){
      if(showText&&!responseText&&mode==="Text Response")return showToast("Enter your written response before submitting.");
      if(showLink&&!responseUrl&&mode==="Link / Document")return showToast("Add the document or research link before submitting.");
      if(mode==="Text + Link"&&!responseText&&!responseUrl)return showToast("Enter a response or provide a document link before submitting.");
      if(completion&&!form.elements.completionAck.checked)return showToast("Confirm that you completed the assignment.");
      if(!confirm("Submit this assignment?"+(assignment.allowResubmission?" You may revise it later.":" You will not be able to revise it afterward.")))return;
    }
    const ref=doc(db,"sections",state.currentSection.id,"assignments",assignmentId,"submissions",state.user.uid);
    const existingSnap=await getDoc(ref);
    const data={
      studentId:state.user.uid,
      studentName:state.profile.displayName||state.user.displayName||"Student",
      responseText,responseUrl,status,
      updatedAt:serverTimestamp(),
      submittedAt:status==="submitted"?serverTimestamp():null
    };
    if(!existingSnap.exists())data.createdAt=serverTimestamp();
    try{
      await setDoc(ref,data,{merge:true});
      closeModal();state.sectionData=await loadSectionData(state.currentSection);renderSectionDetail("assignments");
      showToast(status==="submitted"?"Assignment submitted.":"Draft saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  };
  modal.querySelector("#saveAssignmentDraft")?.addEventListener("click",()=>save("draft"));
  form.addEventListener("submit",e=>{e.preventDefault();save("submitted");});
}

async function openAssignmentSubmissionsModal(assignmentId){
  const assignment=state.sectionData.assignments.find(x=>x.id===assignmentId);
  if(!assignment)return;
  try{
    const snap=await getDocs(collection(db,"sections",state.currentSection.id,"assignments",assignmentId,"submissions"));
    const submissions=snap.docs.map(d=>({id:d.id,...d.data()}));
    const map=new Map(submissions.map(x=>[x.studentId,x]));
    const modal=openModal({
      eyebrow:"Assignment Submissions",
      title:assignment.title,
      wide:true,
      body:'<div class="submission-summary-strip"><div><strong>'+submissions.filter(x=>x.status==="submitted").length+'</strong><span>Submitted</span></div><div><strong>'+submissions.filter(x=>x.status==="draft").length+'</strong><span>Drafts</span></div><div><strong>'+state.sectionData.members.length+'</strong><span>Students</span></div></div>'+
        '<div class="submission-roster">'+state.sectionData.members.map(student=>{const sub=map.get(student.id),grade=state.sectionData.grades.find(g=>g.assignmentId===assignmentId&&g.studentId===student.id);return '<div class="submission-roster-row"><div><strong>'+esc(student.displayName||"Student")+'</strong><span>'+esc(sub?.status==="submitted"?"Submitted":sub?.status==="draft"?"Draft in progress":"Not submitted")+(sub?.submittedAt?" • "+formatDate(sub.submittedAt):"")+'</span></div><div class="inline-actions">'+(grade?'<span class="badge live">'+esc(grade.score)+' / '+esc(assignment.points||0)+'</span>':'')+(sub?'<button class="secondary-btn small-btn" data-action="review-assignment-submission" data-assignment="'+assignmentId+'" data-student="'+student.id+'">Review</button>':'<span class="badge">No work</span>')+'</div></div>';}).join("")+'</div>'
    });
  }catch(error){showToast(humanizeFirebaseError(error));}
}

async function openAssignmentSubmissionReview(assignmentId,studentId){
  const assignment=state.sectionData.assignments.find(x=>x.id===assignmentId);
  const student=state.sectionData.members.find(x=>x.id===studentId);
  if(!assignment||!student)return;
  try{
    const snap=await getDoc(doc(db,"sections",state.currentSection.id,"assignments",assignmentId,"submissions",studentId));
    if(!snap.exists())return showToast("No submission was found.");
    const sub=snap.data(),grade=state.sectionData.grades.find(g=>g.assignmentId===assignmentId&&g.studentId===studentId);
    const modal=openModal({
      eyebrow:"Review Submission",
      title:(student.displayName||"Student")+" — "+assignment.title,
      wide:true,
      body:'<div class="review-submission-layout"><div class="review-work"><div class="submission-status-line"><span class="badge '+(sub.status==="submitted"?"live":"gold")+'">'+esc(sub.status)+'</span>'+(sub.submittedAt?'<span>Submitted '+esc(formatDate(sub.submittedAt))+'</span>':'')+'</div>'+
        (sub.responseText?'<div class="submitted-response"><div class="eyebrow">Written Response</div><p>'+esc(sub.responseText).replace(/\n/g,"<br>")+'</p></div>':'<div class="empty-mini">No written response.</div>')+
        (sub.responseUrl?'<a class="submission-link" href="'+esc(sub.responseUrl)+'" target="_blank" rel="noopener">Open submitted document / link ↗</a>':'')+
        '</div><div class="review-grade-panel"><div class="panel-title">Grade Submission</div><form id="submissionGradeForm"><div class="field"><label>Score / '+esc(assignment.points||0)+'</label><input type="number" min="0" max="'+esc(assignment.points||0)+'" step="0.1" name="score" value="'+esc(grade?.score??"")+'" required></div><div class="field"><label>Instructor Feedback</label><textarea class="editor-compact" rows="4" name="comment">'+esc(grade?.comment||"")+'</textarea></div><button class="primary-btn full-btn" type="submit">Save Grade & Feedback</button></form></div></div>'
    });
    modal.querySelector("#submissionGradeForm").addEventListener("submit",async e=>{
      e.preventDefault();const fd=new FormData(e.currentTarget),score=Number(fd.get("score"));
      try{
        await setDoc(doc(db,"sections",state.currentSection.id,"grades",assignmentId+"_"+studentId),{
          assignmentId,studentId,studentName:student.displayName||"Student",assignmentTitle:assignment.title,
          score,maxPoints:Number(assignment.points||0),comment:String(fd.get("comment")||"").trim(),updatedAt:serverTimestamp()
        },{merge:true});
        closeModal();state.sectionData=await loadSectionData(state.currentSection);renderSectionDetail("assignments");showToast("Grade and feedback saved.");
      }catch(error){showToast(humanizeFirebaseError(error));}
    });
  }catch(error){showToast(humanizeFirebaseError(error));}
}

function stripResourceJsonFence(text){
  let value=String(text||"").trim();
  value=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const firstArray=value.indexOf("["),lastArray=value.lastIndexOf("]");
  const firstObject=value.indexOf("{"),lastObject=value.lastIndexOf("}");
  if(firstArray>=0&&lastArray>firstArray)return value.slice(firstArray,lastArray+1);
  if(firstObject>=0&&lastObject>firstObject)return value.slice(firstObject,lastObject+1);
  return value;
}

function bulkResourcePrompt(section,course,unit){
  const topics=(unit?.topics||[]).map(topic=>{
    const pieces=[
      (topic.number||topic.id)+" — "+topic.title,
      topic.learningObjective?"Objective: "+topic.learningObjective:"",
      topic.essentialKnowledge?"Essential knowledge: "+topic.essentialKnowledge:"",
      topic.competencyCodes?.length?"Competencies: "+topic.competencyCodes.join(", "):""
    ].filter(Boolean);
    return pieces.join(" | ");
  });

  return [
    "Create a complete unit resource set for Theoria.",
    "",
    "Course: "+(course?.code||"")+" — "+(course?.title||""),
    "Section: "+(section?.sectionName||""),
    "Unit: "+(unit?.order||"")+" — "+(unit?.title||""),
    unit?.description?"Unit description: "+unit.description:"",
    "",
    "Return ONLY valid JSON. Do not use Markdown fences, commentary, headings, or explanatory prose.",
    "Return either a JSON array of resource objects or an object with a single \"resources\" array.",
    "",
    "Each resource object may use:",
    "{",
    '  "title": "resource title",',
    '  "type": "Primary Source | Scripture Reading | Article | Book / Chapter | PDF Link | Lecture Notes | Research Link | Supplemental Resource",',
    '  "url": "https://example.com/optional",',
    '  "citation": "author, title, chapter/pages, Scripture reference, or formal citation",',
    '  "notes": "short student-facing note explaining what to read or pay attention to",',
    '  "topicNumber": "1.1",',
    '  "tags": ["primary-source", "trinity"],',
    '  "order": 1',
    "}",
    "",
    "Rules:",
    "- Build a coherent scholarly resource set for the whole unit, not a random link dump.",
    "- Use only topic numbers from the selected unit below.",
    "- Prefer primary sources, Scripture, reputable scholarship, and directly relevant research materials.",
    "- A URL is optional when the citation/reference is sufficient, such as a book chapter or Scripture passage.",
    "- Do not invent URLs. If you are not certain of an exact URL, leave url empty.",
    "- notes should tell the student what to read, why it matters, or what to focus on.",
    "- Order the resources pedagogically.",
    "",
    "UNIT TOPICS:",
    ...(topics.length?topics:["No topics are currently defined for this unit. Leave topicNumber empty."])
  ].filter(Boolean).join("\n");
}

function validResourceUrl(value){
  const raw=String(value||"").trim();
  if(!raw)return true;
  try{
    const u=new URL(raw);
    return u.protocol==="https:"||u.protocol==="http:";
  }catch(_){return false;}
}

function normalizeBulkResource(raw,index,unit,existingKeys){
  const errors=[],warnings=[];
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return {index,errors:["Resource is not a JSON object."],warnings:[],data:null};

  const allowedTypes=["Primary Source","Scripture Reading","Article","Book / Chapter","PDF Link","Lecture Notes","Research Link","Supplemental Resource"];
  const aliases={
    "book":"Book / Chapter","chapter":"Book / Chapter","pdf":"PDF Link","scripture":"Scripture Reading",
    "primary":"Primary Source","research":"Research Link","supplemental":"Supplemental Resource","notes":"Lecture Notes"
  };
  let type=String(raw.type||"Supplemental Resource").trim();
  if(!allowedTypes.includes(type))type=aliases[type.toLowerCase()]||type;
  if(!allowedTypes.includes(type)){warnings.push("Unknown resource type defaulted to Supplemental Resource.");type="Supplemental Resource";}

  const title=String(raw.title||raw.name||"").trim();
  if(!title)errors.push("Resource title is required.");

  const url=String(raw.url||raw.link||"").trim();
  if(url&&!validResourceUrl(url))errors.push("URL must be a valid http:// or https:// address.");

  const citation=String(raw.citation||raw.reference||"").trim();
  const notes=String(raw.notes||raw.note||raw.description||"").trim();
  if(!url&&!citation)warnings.push("No URL or citation/reference was provided.");

  const duplicateKey=(title+"|"+citation).toLowerCase();
  if(title&&existingKeys.has(duplicateKey))warnings.push("A matching resource title/citation already exists in this section.");

  const topicNumber=String(raw.topicNumber||raw.topic||"").trim();
  const topic=topicNumber?(unit?.topics||[]).find(t=>String(t.number||"").trim().toLowerCase()===topicNumber.toLowerCase()):null;
  if(topicNumber&&!topic)warnings.push("Topic "+topicNumber+" was not found in the selected unit and will be left unassigned.");

  const tags=(Array.isArray(raw.tags)?raw.tags:String(raw.tags||"").split(",")).map(x=>String(x).trim()).filter(Boolean);
  const orderRaw=Number(raw.order??index+1);
  const unitSequence=Number.isFinite(orderRaw)?orderRaw:index+1;

  return {
    index,errors,warnings,
    data:{
      title,type,url,citation,notes,tags,
      unitId:unit?.id||"",
      unitTitle:unit?.title||"",
      unitNumber:unit?.order||"",
      topicId:topic?.id||"",
      topicTitle:topic?.title||"",
      topicNumber:topic?.number||"",
      unitSequence
    }
  };
}

async function bulkImportResourcesModal(){
  if(state.role!=="instructor"||!state.currentSection||!state.sectionData)return;
  const section=state.currentSection,course=state.sectionData.course,framework=state.sectionData.framework;
  if(!framework?.units?.length)return showToast("Create at least one course unit before bulk-importing unit resources.");

  let selectedUnit=framework.units[0];
  let parsedRows=[];
  const existingKeys=new Set((state.sectionData.resources||[]).map(r=>(String(r.title||"")+"|"+String(r.citation||"")).toLowerCase()));

  const modal=openModal({
    eyebrow:"Unit Resources",
    title:"Bulk Import Resources",
    wide:true,
    body:'<div class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Select Unit</h3><p>Theoria will map imported topic numbers to this unit.</p></div></div>'+
        '<div class="field"><label>Unit</label><select id="bulkResourceUnit">'+framework.units.map(u=>'<option value="'+u.id+'">Unit '+esc(u.order||"")+' — '+esc(u.title)+'</option>').join("")+'</select></div>'+
        '<div class="bulk-import-prompt-row"><div><strong>Generate the whole unit resource set in ChatGPT</strong><span>The prompt includes the unit’s real topics and tells ChatGPT not to invent URLs.</span></div><button type="button" class="secondary-btn" id="copyResourcePrompt">Copy ChatGPT Resource Prompt</button></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Add Resource Set</h3><p>Paste one complete JSON response or upload a .json file.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>JSON File</label><input id="bulkResourceFile" type="file" accept=".json,application/json"></div><div class="field"><label>Expected Format</label><div class="static-field">JSON array or {"resources":[...]}</div></div></div>'+
        '<div class="field"><label>Paste Complete Unit Resource Set</label><textarea id="bulkResourceJson" class="bulk-json-editor" spellcheck="false" placeholder="Paste the complete JSON resource set here"></textarea></div>'+
        '<button type="button" class="primary-btn" id="previewBulkResources">Validate & Preview</button>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Import Preview</h3><p>Review titles, citations, URLs, topic mapping, and warnings before saving.</p></div><div id="bulkResourceSummary"></div></div><div id="bulkResourceResults"><div class="empty-mini">Paste or upload a resource set, then validate it.</div></div></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="importBulkResources" disabled>Import Resources</button></div>'+
    '</div>'
  });

  const unitSelect=modal.querySelector("#bulkResourceUnit");
  const textarea=modal.querySelector("#bulkResourceJson");
  const fileInput=modal.querySelector("#bulkResourceFile");
  const summary=modal.querySelector("#bulkResourceSummary");
  const results=modal.querySelector("#bulkResourceResults");
  const importButton=modal.querySelector("#importBulkResources");

  const resetPreview=()=>{
    parsedRows=[];summary.innerHTML="";
    results.innerHTML='<div class="empty-mini">Validate the current resource set before importing.</div>';
    importButton.disabled=true;importButton.textContent="Import Resources";
  };

  unitSelect.addEventListener("change",()=>{
    selectedUnit=framework.units.find(u=>u.id===unitSelect.value)||framework.units[0];
    resetPreview();
  });

  modal.querySelector("#copyResourcePrompt").addEventListener("click",async()=>{
    const prompt=bulkResourcePrompt(section,course,selectedUnit);
    try{
      await navigator.clipboard.writeText(prompt);
      showToast("Unit resource prompt copied for ChatGPT.");
    }catch(_){
      textarea.value=prompt;
      showToast("Clipboard access was unavailable, so the prompt was placed in the editor.");
    }
  });

  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{textarea.value=await file.text();resetPreview();}catch(_){showToast("The JSON file could not be read.");}
  });

  modal.querySelector("#previewBulkResources").addEventListener("click",()=>{
    let payload;
    try{
      const parsed=JSON.parse(stripResourceJsonFence(textarea.value));
      payload=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.resources)?parsed.resources:null);
      if(!payload)throw new Error("Expected a JSON array or an object with a resources array.");
    }catch(error){
      parsedRows=[];
      summary.innerHTML='<span class="badge danger">Invalid JSON</span>';
      results.innerHTML='<div class="notice danger-notice">'+esc(error.message||"The resource set is not valid JSON.")+'</div>';
      importButton.disabled=true;return;
    }

    parsedRows=payload.map((row,index)=>normalizeBulkResource(row,index,selectedUnit,existingKeys));
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    const invalid=parsedRows.filter(row=>row.errors.length);
    const warnings=parsedRows.filter(row=>row.warnings.length);
    const linked=valid.filter(row=>row.data.url).length;

    summary.innerHTML='<div class="bulk-preview-counts"><span><strong>'+valid.length+'</strong> valid</span><span><strong>'+invalid.length+'</strong> invalid</span><span><strong>'+warnings.length+'</strong> warnings</span><span><strong>'+linked+'</strong> linked</span></div>';

    results.innerHTML=parsedRows.length?'<div class="bulk-preview-list">'+parsedRows.map(row=>
      '<div class="bulk-preview-row '+(row.errors.length?'invalid':row.warnings.length?'warning':'valid')+'"><div class="bulk-preview-number">'+(row.index+1)+'</div><div><strong>'+esc(row.data?.title||"Invalid resource")+'</strong><span>'+esc(row.data?.type||"")+(row.data?.topicNumber?' • Topic '+esc(row.data.topicNumber):'')+(row.data?.citation?' • '+esc(row.data.citation):'')+'</span>'+
      (row.errors.length?'<div class="bulk-messages errors">'+row.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
      (row.warnings.length?'<div class="bulk-messages warnings">'+row.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
      '</div></div>'
    ).join("")+'</div>':'<div class="empty-mini">No resources were found in the JSON.</div>';

    importButton.disabled=!valid.length;
    importButton.textContent=valid.length?"Import "+valid.length+" Resource"+(valid.length===1?"":"s"):"Import Resources";
  });

  importButton.addEventListener("click",async()=>{
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    if(!valid.length)return;
    importButton.disabled=true;importButton.textContent="Importing…";
    try{
      for(let offset=0;offset<valid.length;offset+=400){
        const batch=writeBatch(db);
        valid.slice(offset,offset+400).forEach(row=>{
          const ref=doc(collection(db,"sections",section.id,"resources"));
          batch.set(ref,{...row.data,importedInBulk:true,createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
        });
        await batch.commit();
      }
      closeModal();
      state.sectionData=await loadSectionData(section);
      renderSectionDetail("resources");
      if($("#page-library")?.classList.contains("active"))await renderScholarLibrary();
      const skipped=parsedRows.length-valid.length;
      showToast(valid.length+" resource"+(valid.length===1?"":"s")+" imported for "+selectedUnit.title+(skipped?" • "+skipped+" invalid skipped":"")+".");
    }catch(error){
      importButton.disabled=false;
      importButton.textContent="Import "+valid.length+" Resource"+(valid.length===1?"":"s");
      showToast(humanizeFirebaseError(error));
    }
  });
}

async function deleteResource(resourceId){
  const section=state.currentSection;
  const resource=state.sectionData.resources.find(x=>x.id===resourceId);
  if(!section||!resource)return showToast("Resource not found.");

  const modal=openModal({
    eyebrow:"Delete Resource",
    title:resource.title,
    body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>This removes the resource from this section and the Scholar Library.</strong><p>No assignment, assessment, grade, or student submission records are deleted.</p></div></div>'+
      '<div class="question-delete-preview"><span>'+esc(resource.type||"Resource")+'</span><strong>'+esc(resource.title||"Untitled Resource")+'</strong><small>'+esc(resource.citation||resource.url||"No citation or external link")+'</small></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteResource">Delete Resource</button>'
  });

  modal.querySelector("#confirmDeleteResource").onclick=async()=>{
    try{
      await deleteDoc(doc(db,"sections",section.id,"resources",resourceId));
      closeModal();
      state.sectionData=await loadSectionData(section);
      renderSectionDetail("resources");
      showToast("Resource deleted.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  };
}

function openResourceModal(existing){
  const modal=openModal({
    eyebrow:"Scholar Resource",
    title:existing?"Edit Resource":"Add Resource",
    wide:true,
    body:'<form id="resourceForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Resource Identity</h3><p>Add the source students should use and classify it clearly.</p></div></div>'+
        '<div class="field"><label>Resource Title</label><input class="title-input" name="title" value="'+esc(existing?.title||"")+'" placeholder="e.g. Augustine, Confessions Book VIII" required></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Type</label><select name="type"><option>Primary Source</option><option>Scripture Reading</option><option>Article</option><option>Book / Chapter</option><option>PDF Link</option><option>Lecture Notes</option><option>Research Link</option><option>Supplemental Resource</option></select></div><div class="field"><label>URL</label><input type="url" name="url" value="'+esc(existing?.url||"")+'" placeholder="https://"></div><div class="field"><label>Citation / Reference</label><input name="citation" value="'+esc(existing?.citation||"")+'" placeholder="Author, title, chapter, pages"></div></div>'+
        '<div class="compact-field-grid" style="margin-top:12px"><div class="field"><label>Unit Folder</label><select name="unitId" id="resourceUnit"></select></div><div class="field"><label>Topic</label><select name="topicId" id="resourceTopic"></select></div><div class="field"><label>Organization</label><div class="static-field">Controls section and student resource folders</div></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Reading Note</h3><p>Give students a short reason for using this resource.</p></div></div>'+
        '<div class="field"><label>Student Note</label><textarea class="editor-compact" rows="2" name="notes" placeholder="What should students pay attention to while reading?">'+esc(existing?.notes||"")+'</textarea></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Resource</button></div></form>'
  });
  const form=modal.querySelector("#resourceForm");
  if(existing) form.type.value=existing.type||"Primary Source";

  const resourceFramework=state.sectionData?.framework||{units:[]};
  const resourceUnit=form.querySelector("#resourceUnit"),resourceTopic=form.querySelector("#resourceTopic");
  resourceUnit.innerHTML='<option value="">Unsorted / no unit</option>'+resourceFramework.units.map(u=>'<option value="'+u.id+'">'+esc("Unit "+(u.order||"")+" — "+u.title)+'</option>').join("");
  resourceUnit.value=existing?.unitId||"";
  const fillResourceTopics=()=>{
    const unit=resourceFramework.units.find(u=>u.id===resourceUnit.value);
    resourceTopic.innerHTML='<option value="">No specific topic</option>'+((unit?.topics||[]).map(t=>'<option value="'+t.id+'">'+esc((t.number||"")+" — "+t.title)+'</option>').join(""));
    resourceTopic.value=(existing?.topicId&&unit?.topics?.some(t=>t.id===existing.topicId))?existing.topicId:"";
  };
  resourceUnit.addEventListener("change",fillResourceTopics);
  fillResourceTopics();

  const note=form.querySelector(".editor-compact");
  const grow=()=>{note.style.height="auto";note.style.height=Math.min(note.scrollHeight,180)+"px";};note.addEventListener("input",grow);grow();
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form);
    const url=String(fd.get("url")).trim();
    if(url&&!validResourceUrl(url))return showToast("Enter a valid http:// or https:// resource URL.");
    const selectedUnit=resourceFramework.units.find(u=>u.id===String(fd.get("unitId")||""));
    const selectedTopic=(selectedUnit?.topics||[]).find(t=>t.id===String(fd.get("topicId")||""));
    const data={
      title:String(fd.get("title")).trim(),type:String(fd.get("type")),url,
      citation:String(fd.get("citation")||"").trim(),notes:String(fd.get("notes")).trim(),
      unitId:selectedUnit?.id||"",unitTitle:selectedUnit?.title||"",unitNumber:Number(selectedUnit?.order||0),
      topicId:selectedTopic?.id||"",topicTitle:selectedTopic?.title||"",topicNumber:selectedTopic?.number||"",
      tags:existing?.tags||[],unitSequence:Number(selectedTopic?.order||existing?.unitSequence||0),
      updatedAt:serverTimestamp()
    };
    try{
      if(existing) await updateDoc(doc(db,"sections",state.currentSection.id,"resources",existing.id),data);
      else await addDoc(collection(db,"sections",state.currentSection.id,"resources"),{...data,createdAt:serverTimestamp()});
      closeModal();state.sectionData=await loadSectionData(state.currentSection);renderSectionDetail("resources");showToast("Resource saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

function openGradeModal(assignmentId,studentId){
  const a=state.sectionData.assignments.find(x=>x.id===assignmentId);
  const s=state.sectionData.members.find(x=>x.id===studentId);
  const existing=state.sectionData.grades.find(g=>g.assignmentId===assignmentId&&g.studentId===studentId);
  const modal=openModal({
    eyebrow:"Gradebook",
    title:(s?.displayName||"Student")+" — "+(a?.title||"Assignment"),
    body:'<form id="gradeForm"><div class="notice">Possible points: <strong>'+esc(a?.points||0)+'</strong></div><div class="field"><label>Score</label><input type="number" min="0" step="0.1" name="score" value="'+esc(existing?.score??"")+'" required></div><div class="field"><label>Instructor Comment</label><textarea class="editor-compact" rows="2" name="comment" placeholder="Optional concise feedback">'+esc(existing?.comment||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Grade</button></div></form>'
  });
  modal.querySelector("#gradeForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);const score=Number(fd.get("score"));
    try{
      await setDoc(doc(db,"sections",state.currentSection.id,"grades",assignmentId+"_"+studentId),{
        assignmentId,studentId,studentName:s?.displayName||"Student",assignmentTitle:a?.title||"Assignment",
        score,maxPoints:Number(a?.points||0),comment:String(fd.get("comment")).trim(),updatedAt:serverTimestamp()
      },{merge:true});
      closeModal();state.sectionData=await loadSectionData(state.currentSection);renderSectionDetail("gradebook");showToast("Grade saved.");
    }catch(error){showToast(humanizeFirebaseError(error));}
  });
}

async function deleteLibraryResource(sectionId,resourceId){
  try{
    const snap=await getDoc(doc(db,"sections",sectionId,"resources",resourceId));
    if(!snap.exists())return showToast("Resource not found.");
    const resource={id:snap.id,...snap.data()};
    const modal=openModal({
      eyebrow:"Delete Resource",
      title:resource.title||"Resource",
      body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>This removes the resource from its section and the Scholar Library.</strong><p>No assignments, assessments, grades, or student submissions are deleted.</p></div></div>'+
        '<div class="question-delete-preview"><span>'+esc(resource.type||"Resource")+'</span><strong>'+esc(resource.title||"Untitled Resource")+'</strong><small>'+esc(resource.citation||resource.url||"No citation or external link")+'</small></div>',
      footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteLibraryResource">Delete Resource</button>'
    });
    modal.querySelector("#confirmDeleteLibraryResource").onclick=async()=>{
      try{
        await deleteDoc(doc(db,"sections",sectionId,"resources",resourceId));
        closeModal();
        if(state.currentSection?.id===sectionId){
          state.sectionData=await loadSectionData(state.currentSection);
        }
        await renderScholarLibrary();
        showToast("Resource deleted.");
      }catch(error){showToast(humanizeFirebaseError(error));}
    };
  }catch(error){showToast(humanizeFirebaseError(error));}
}

async function renderScholarLibrary(){
  const el=$("#libraryContent");
  if(!el||!state.user)return;
  el.innerHTML='<div class="library-loading"><div class="empty-symbol">L</div><h3>Loading scholarly resources…</h3></div>';

  const resources=[];
  for(const section of state.sections){
    try{
      const snap=await getDocs(collection(db,"sections",section.id,"resources"));
      snap.docs.forEach(d=>resources.push({
        id:d.id,
        sectionId:section.id,
        sectionName:section.sectionName||section.courseTitle||"Section",
        courseCode:section.courseCode||"",
        courseTitle:section.courseTitle||"",
        term:section.term||"",
        ...d.data()
      }));
    }catch(error){
      console.warn("Unable to load resources for section",section.id,error);
    }
  }

  resources.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""))||String(a.title||"").localeCompare(String(b.title||"")));
  const types=[...new Set(resources.map(r=>r.type).filter(Boolean))].sort();
  const sections=[...new Map(resources.map(r=>[r.sectionId,{id:r.sectionId,label:(r.courseCode?r.courseCode+" • ":"")+r.sectionName}])).values()];

  el.innerHTML=
    '<div class="library-toolbar"><div class="field"><label>Search Library</label><input id="librarySearch" placeholder="Search title, citation, notes, course, or type"></div>'+
      '<div class="field"><label>Resource Type</label><select id="libraryType"><option value="">All resource types</option>'+types.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Section</label><select id="librarySection"><option value="">All sections</option>'+sections.map(s=>'<option value="'+s.id+'">'+esc(s.label)+'</option>').join("")+'</select></div></div>'+
    '<div class="library-summary"><div><strong>'+resources.length+'</strong><span>Resources</span></div><div><strong>'+sections.length+'</strong><span>Sections</span></div><div><strong>'+types.length+'</strong><span>Resource Types</span></div></div>'+
    '<div id="libraryResults"></div>';

  const search=$("#librarySearch"),type=$("#libraryType"),section=$("#librarySection"),results=$("#libraryResults");
  const render=()=>{
    const q=search.value.trim().toLowerCase(),t=type.value,sid=section.value;
    const list=resources.filter(r=>
      (!t||r.type===t) &&
      (!sid||r.sectionId===sid) &&
      (!q||[r.title,r.type,r.citation,r.notes,r.courseCode,r.courseTitle,r.sectionName].join(" ").toLowerCase().includes(q))
    );
    results.innerHTML=list.length?'<div class="library-grid">'+list.map(r=>
      '<article class="library-card"><div class="library-card-top"><div><span>'+esc(r.type||"Resource")+
      (r.unitTitle?' • Unit '+esc(r.unitNumber||"")+': '+esc(r.unitTitle):'')+
      (r.topicNumber?' • Topic '+esc(r.topicNumber):'')+
      '</span><h3>'+esc(r.title||"Untitled Resource")+'</h3></div><span class="library-course">'+esc(r.courseCode||"Course")+'</span></div>'+
      (r.citation?'<div class="library-citation">'+esc(r.citation)+'</div>':'')+
      (r.notes?'<p>'+esc(r.notes)+'</p>':'')+
      '<div class="library-card-foot"><div><strong>'+esc(r.sectionName)+'</strong><span>'+esc(r.term||"")+'</span></div><div class="inline-actions">'+
      (r.url?'<a class="secondary-btn small-btn" href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer">Open Resource ↗</a>':'<button class="secondary-btn small-btn" data-action="open-section-resource" data-section="'+r.sectionId+'">Open Section</button>')+
      (state.role==="instructor"?'<button class="danger-btn small-btn" data-action="delete-library-resource" data-section="'+r.sectionId+'" data-id="'+r.id+'">Delete</button>':'')+
      '</div></div></article>'
    ).join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">L</div><h3>No matching resources.</h3><p>'+(resources.length?"Adjust the Library filters or search terms.":"Resources assigned in your sections will appear here automatically.")+'</p></div>';
  };
  search.addEventListener("input",render);type.addEventListener("change",render);section.addEventListener("change",render);render();
}


async function removeStudentFromSection(studentId){
  const section=state.currentSection;
  const student=state.sectionData?.members?.find(x=>x.id===studentId);
  if(state.role!=="instructor"||!section||!student)return;
  const modal=openModal({
    eyebrow:"Enrollment Management",
    title:"Remove Student",
    body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>Remove '+esc(student.displayName||"this student")+' from this section?</strong><p>The student will immediately lose section access. Existing grades, submissions, assessment attempts, and academic records will be preserved for the instructor.</p></div></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmRemoveStudent">Remove Student</button>'
  });
  modal.querySelector("#confirmRemoveStudent").onclick=async()=>{
    const btn=modal.querySelector("#confirmRemoveStudent");btn.disabled=true;btn.textContent="Removing…";
    try{
      const batch=writeBatch(db);
      batch.delete(doc(db,"sections",section.id,"members",studentId));
      batch.delete(doc(db,"users",studentId,"enrollments",section.id));
      batch.delete(doc(db,"sections",section.id,"entranceCandidates",studentId));
      await batch.commit();
      closeModal();
      state.sectionData=await loadSectionData(section);
      renderSectionDetail("students");
      showToast((student.displayName||"Student")+" was removed from the section.");
    }catch(error){
      btn.disabled=false;btn.textContent="Remove Student";
      showToast(humanizeFirebaseError(error));
    }
  };
}

async function deleteCollectionDocuments(collectionRef){
  const snap=await getDocs(collectionRef);
  for(let offset=0;offset<snap.docs.length;offset+=400){
    const batch=writeBatch(db);
    snap.docs.slice(offset,offset+400).forEach(d=>batch.delete(d.ref));
    await batch.commit();
  }
  return snap.docs;
}

async function deleteAssessmentTree(assessmentId){
  const submissionSnap=await getDocs(collection(db,"assessments",assessmentId,"submissions"));
  for(const sub of submissionSnap.docs){
    await deleteCollectionDocuments(collection(db,"assessments",assessmentId,"submissions",sub.id,"events"));
  }
  await deleteCollectionDocuments(collection(db,"assessments",assessmentId,"questions"));
  await deleteCollectionDocuments(collection(db,"assessments",assessmentId,"keys"));
  await deleteCollectionDocuments(collection(db,"assessments",assessmentId,"results"));
  await deleteCollectionDocuments(collection(db,"assessments",assessmentId,"submissions"));
  await deleteDoc(doc(db,"assessments",assessmentId));
}

async function deleteSectionCompletely(){
  const section=state.currentSection;
  if(state.role!=="instructor"||!section)return;
  const members=state.sectionData?.members||[];
  const modal=openModal({
    eyebrow:"Section Administration",
    title:"Delete Section",
    wide:true,
    body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>This permanently deletes the teaching section.</strong><p>Assignments, resources, section assessments, gradebook rows, academic records, entrance-exam candidates, and enrollment links tied to this section will be removed. This does not delete the master course or its Question Bank.</p></div></div>'+
      '<div class="delete-impact-grid"><div><span>Section</span><strong>'+esc(section.sectionName||section.courseTitle||"Section")+'</strong></div><div><span>Students</span><strong>'+members.length+'</strong></div><div><span>Assignments</span><strong>'+esc(state.sectionData?.assignments?.length||0)+'</strong></div><div><span>Assessments</span><strong>'+esc(state.sectionData?.assessmentRefs?.length||0)+'</strong></div></div>'+
      '<div class="field" style="margin-top:16px"><label>Type DELETE to confirm</label><input id="deleteSectionConfirmText" autocomplete="off" placeholder="DELETE"></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteSection" disabled>Delete Section Permanently</button>'
  });
  const input=modal.querySelector("#deleteSectionConfirmText"),button=modal.querySelector("#confirmDeleteSection");
  input.oninput=()=>button.disabled=input.value.trim().toUpperCase()!=="DELETE";
  button.onclick=async()=>{
    button.disabled=true;button.textContent="Deleting Section…";
    try{
      // Remove each student's personal enrollment pointer while the section
      // still exists so section-owner authorization remains valid.
      for(let offset=0;offset<members.length;offset+=350){
        const batch=writeBatch(db);
        members.slice(offset,offset+350).forEach(member=>{
          batch.delete(doc(db,"users",member.id,"enrollments",section.id));
          batch.delete(doc(db,"sections",section.id,"members",member.id));
        });
        await batch.commit();
      }

      // Assignments have nested student submissions, so clear those first.
      const assignments=await getDocs(collection(db,"sections",section.id,"assignments"));
      for(const assignment of assignments.docs){
        await deleteCollectionDocuments(collection(db,"sections",section.id,"assignments",assignment.id,"submissions"));
      }
      await deleteCollectionDocuments(collection(db,"sections",section.id,"assignments"));

      const simpleCollections=[
        "resources","grades","assessmentRefs","gradingPathways","assessmentGrades",
        "mastery","academicRecords","portfolios","appeals","recordHistory","entranceCandidates"
      ];
      for(const name of simpleCollections)await deleteCollectionDocuments(collection(db,"sections",section.id,name));

      // Remove every assigned assessment owned by this instructor, including
      // the special entrance examination which is intentionally not published
      // into the normal section assessmentRefs collection.
      const assignedAssessments=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
      for(const assessment of assignedAssessments.docs)await deleteAssessmentTree(assessment.id);

      if(section.joinCode){
        try{await deleteDoc(doc(db,"joinCodes",section.joinCode));}catch(_){}
      }
      await deleteDoc(doc(db,"sections",section.id));

      closeModal();
      state.currentSection=null;state.sectionData=null;
      await loadWorkspace();
      setPage("sections");
      showToast("Section deleted.");
    }catch(error){
      console.error("Unable to delete section:",error);
      button.disabled=false;button.textContent="Delete Section Permanently";
      showToast(humanizeFirebaseError(error));
    }
  };
}

async function beginEntranceExam(section,joinCode){
  if(!section?.entranceAssessmentId)return showToast("The instructor has not configured the entrance examination yet.");
  try{
    const candidateRef=doc(db,"sections",section.id,"entranceCandidates",state.user.uid);
    const existingCandidate=await getDoc(candidateRef);
    if(!existingCandidate.exists()){
      await setDoc(candidateRef,{
        userId:state.user.uid,
        displayName:state.profile?.displayName||state.user.displayName||"Student",
        email:state.user.email||"",
        status:"pending",
        joinCode,
        assessmentId:section.entranceAssessmentId,
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });
    }
    closeModal();
    if(window.TheoriaPhase3?.startEntranceExam){
      await window.TheoriaPhase3.startEntranceExam(section.entranceAssessmentId);
    }else{
      showToast("The entrance examination workspace is still loading. Try again in a moment.");
    }
  }catch(error){showToast(humanizeFirebaseError(error));}
}


async function previewJoin(code){
  code=String(code||"").trim().toUpperCase();
  if(!code) return showToast("Enter a join code.");
  try{
    const codeSnap=await getDoc(doc(db,"joinCodes",code));
    if(!codeSnap.exists() || codeSnap.data().active===false) return showToast("That join code is not active.");
    const sectionSnap=await getDoc(doc(db,"sections",codeSnap.data().sectionId));
    if(!sectionSnap.exists()) return showToast("The section could not be found.");
    const section={id:sectionSnap.id,...sectionSnap.data()};
    if(section.joinOpen===false) return showToast("Enrollment for this section is closed.");

    const courseSnap=await getDoc(doc(db,"courses",section.courseId));
    const course=courseSnap.exists()?courseSnap.data():{};
    const entranceRequired=course.entranceExamRequired===true||section.entranceExamRequired===true;

    if(!entranceRequired){
      const modal=openModal({
        eyebrow:"Join a Section",
        title:section.courseTitle || "Theoria Section",
        body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||("Section "+section.sectionNumber))+'</h3><p>'+esc(section.term||"")+' • '+esc(section.instructorName||"Instructor")+' • '+esc(section.format||"")+'</p></div><p class="page-subtitle">You are requesting to join this section using <strong>'+esc(code)+'</strong>.</p>',
        footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="confirmJoinBtn">Join Section</button>'
      });
      modal.querySelector("#confirmJoinBtn").addEventListener("click",()=>joinSection(section,code));
      return;
    }

    const passPercent=Number(section.entrancePassPercent||70);
    if(!section.entranceAssessmentId){
      openModal({
        eyebrow:"Entrance Examination Required",
        title:section.courseTitle || "Theoria Section",
        body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||("Section "+section.sectionNumber))+'</h3><p>'+esc(section.term||"")+' • '+esc(section.instructorName||"Instructor")+'</p></div><div class="notice danger-notice"><strong>Enrollment is not available yet.</strong><p>This course requires an entrance examination, but the instructor has not configured the section exam.</p></div>',
        footer:'<button class="primary-btn" data-close-modal>Close</button>'
      });
      return;
    }

    let submission=null,result=null;
    try{
      const subSnap=await getDoc(doc(db,"assessments",section.entranceAssessmentId,"submissions",state.user.uid));
      if(subSnap.exists())submission=subSnap.data();
    }catch(_){}
    try{
      const resultSnap=await getDoc(doc(db,"assessments",section.entranceAssessmentId,"results",state.user.uid));
      if(resultSnap.exists())result=resultSnap.data();
    }catch(_){}

    if(result?.complete===true && Number(result.percent||0)>=passPercent){
      const modal=openModal({
        eyebrow:"Entrance Requirement Complete",
        title:"You may enroll",
        body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||("Section "+section.sectionNumber))+'</h3><p>'+esc(section.term||"")+' • '+esc(section.instructorName||"Instructor")+'</p></div><div class="notice"><strong>Entrance examination passed: '+esc(result.percent)+'%</strong><p>The required passing score is '+esc(passPercent)+'%. You may now join this section.</p></div>',
        footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="confirmJoinBtn">Enroll in Section</button>'
      });
      modal.querySelector("#confirmJoinBtn").addEventListener("click",()=>joinSection(section,code));
      return;
    }

    if(result?.complete===true){
      openModal({
        eyebrow:"Entrance Examination Result",
        title:"Enrollment requirement not met",
        body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.entranceExamTitle||"Entrance Examination")+'</h3></div><div class="notice danger-notice"><strong>Score: '+esc(result.percent)+'% • Required: '+esc(passPercent)+'%</strong><p>This attempt does not meet the enrollment requirement. Contact the instructor if a retake should be authorized.</p></div>',
        footer:'<button class="primary-btn" data-close-modal>Close</button>'
      });
      return;
    }

    if(submission?.status==="submitted"||submission?.status==="graded"){
      openModal({
        eyebrow:"Entrance Examination",
        title:"Awaiting evaluation",
        body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.entranceExamTitle||"Entrance Examination")+'</h3></div><div class="notice"><strong>Your entrance examination has been submitted.</strong><p>Enrollment will become available after the instructor completes the evaluation and you meet the '+esc(passPercent)+'% passing requirement.</p></div>',
        footer:'<button class="primary-btn" data-close-modal>Close</button>'
      });
      return;
    }

    const isResume=submission?.status==="in_progress";
    const modal=openModal({
      eyebrow:"Entrance Examination Required",
      title:section.courseTitle || "Theoria Section",
      body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||("Section "+section.sectionNumber))+'</h3><p>'+esc(section.term||"")+' • '+esc(section.instructorName||"Instructor")+'</p></div><div class="notice"><strong>'+esc(section.entranceExamTitle||"Entrance Examination")+'</strong><p>You must earn at least '+esc(passPercent)+'% on the instructor-created entrance examination before enrollment is permitted.</p></div>',
      footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="beginEntranceExamBtn">'+(isResume?"Resume Entrance Examination":"Begin Entrance Examination")+'</button>'
    });
    modal.querySelector("#beginEntranceExamBtn").onclick=()=>beginEntranceExam(section,code);
  }catch(error){showToast(humanizeFirebaseError(error));}
}

async function joinSection(section,code){
  try{
    const batch=writeBatch(db);
    batch.set(doc(db,"sections",section.id,"members",state.user.uid),{
      userId:state.user.uid,
      displayName:state.profile.displayName || state.user.displayName || "Student",
      email:state.user.email,
      role:"student",
      joinedAt:serverTimestamp(),
      status:"enrolled",
      accommodations:{
        timeMultiplier:1,
        breaks:false,
        calculator:false,
        largeText:false,
        reducedDistractions:false,
        notes:""
      }
    });
    batch.set(doc(db,"users",state.user.uid,"enrollments",section.id),{
      sectionId:section.id,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
      sectionName:section.sectionName,term:section.term,joinCode:code,joinedAt:serverTimestamp()
    });
    await batch.commit();
    closeModal();await loadWorkspace();showToast("You joined "+section.courseTitle+".");await openSection(section.id);
  }catch(error){showToast(humanizeFirebaseError(error));}
}

async function regenerateJoinCode(){
  const s=state.currentSection;
  try{
    const newCode=await generateJoinCode();
    const batch=writeBatch(db);
    if(s.joinCode) batch.delete(doc(db,"joinCodes",s.joinCode));
    batch.set(doc(db,"joinCodes",newCode),{sectionId:s.id,active:s.joinOpen!==false,createdAt:serverTimestamp()});
    batch.update(doc(db,"sections",s.id),{joinCode:newCode,updatedAt:serverTimestamp()});
    await batch.commit();
    s.joinCode=newCode;
    const i=state.sections.findIndex(x=>x.id===s.id);if(i>=0)state.sections[i]={...state.sections[i],joinCode:newCode};
    renderSectionDetail("overview");showToast("New join code issued.");
  }catch(error){showToast(humanizeFirebaseError(error));}
}

function showJoinDisplay(){
  const s=state.currentSection;
  const url=location.origin+location.pathname+"?join="+s.joinCode;
  openModal({
    eyebrow:"Section Enrollment",
    title:s.courseTitle || "Theoria Section",
    wide:true,
    body:'<div class="join-display" style="margin:0;min-height:360px"><div><div class="eyebrow">Join this section</div><div class="join-code" style="font-size:46px">'+esc(s.joinCode)+'</div><p style="font-size:13px">'+esc(s.courseCode||"")+' • '+esc(s.sectionName||"")+' • '+esc(s.instructorName||"")+'</p><p style="margin-top:16px">'+esc(url)+'</p></div><div class="qr-box" style="width:220px;height:220px"><img alt="Join QR code" src="https://quickchart.io/qr?size=300&text='+encodeURIComponent(url)+'"></div></div>'
  });
}

async function toggleEnrollment(){
  const s=state.currentSection;const open=!(s.joinOpen!==false);
  try{
    await updateDoc(doc(db,"sections",s.id),{joinOpen:open,updatedAt:serverTimestamp()});
    if(s.joinCode) await updateDoc(doc(db,"joinCodes",s.joinCode),{active:open,updatedAt:serverTimestamp()});
    s.joinOpen=open;const i=state.sections.findIndex(x=>x.id===s.id);if(i>=0)state.sections[i]={...state.sections[i],joinOpen:open};
    renderSectionDetail("overview");renderSections();showToast(open?"Enrollment opened.":"Enrollment closed.");
  }catch(error){showToast(humanizeFirebaseError(error));}
}

$$(".auth-tab").forEach(btn=>btn.addEventListener("click",()=>switchAuthTab(btn.dataset.authTab)));
$$(".role-option").forEach(btn=>btn.addEventListener("click",()=>{
  state.role=btn.dataset.role;
  $$(".role-option").forEach(option=>option.classList.toggle("selected",option===btn));
}));

signInForm.addEventListener("submit",async event=>{
  event.preventDefault();authError.textContent="";
  const button=signInForm.querySelector("button[type=submit]");button.disabled=true;button.textContent="Signing in…";
  try{await signInWithEmailAndPassword(auth,$("#signInEmail").value.trim(),$("#signInPassword").value);}
  catch(error){authError.textContent=humanizeFirebaseError(error);}
  finally{button.disabled=false;button.textContent="Sign in to Theoria";}
});

registerForm.addEventListener("submit",async event=>{
  event.preventDefault();authError.textContent="";
  const name=$("#registerName").value.trim(),email=$("#registerEmail").value.trim(),password=$("#registerPassword").value;
  const button=registerForm.querySelector("button[type=submit]");button.disabled=true;button.textContent="Creating account…";
  try{
    const requestedRole=state.role==="instructor"?"instructor":"student";
    const credential=await createUserWithEmailAndPassword(auth,email,password);
    await updateProfile(credential.user,{displayName:name});
    await setDoc(doc(db,"users",credential.user.uid),{
      displayName:name,
      email,
      role:requestedRole,
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
  }catch(error){authError.textContent=humanizeFirebaseError(error);}
  finally{button.disabled=false;button.textContent="Create Theoria account";}
});

$("#signOutBtn").addEventListener("click",async()=>{await signOut(auth);showToast("Signed out of Theoria.");});
$("#mobileMenuBtn").addEventListener("click",()=>sidebar.classList.toggle("open"));
$$(".nav-item").forEach(btn=>btn.addEventListener("click",()=>setPage(btn.dataset.page)));
$("#quickJoinBtn").addEventListener("click",()=>{setPage("sections");setTimeout(()=>$("#joinCodeInput")?.focus(),50);});
$("#quickCreateBtn").addEventListener("click",()=>openSectionModal());
$("#bulkCreateCoursesBtn")?.addEventListener("click",()=>bulkCreateCoursesModal());
$("#createCourseBtn").addEventListener("click",()=>openCourseModal());
$("#createSectionBtn").addEventListener("click",()=>openSectionModal());
$("#homeCreateSection").addEventListener("click",()=>openSectionModal());
$("#joinCodeBtn").addEventListener("click",()=>previewJoin($("#joinCodeInput").value));
$("#joinCodeInput").addEventListener("input",e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,"");});
$("#joinCodeInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();previewJoin(e.target.value);}});

window.TheoriaCore = {
  getState:()=>state,
  setPage,
  showToast,
  openModal,
  closeModal,
  esc,
  formatDate,
  loadWorkspace,
  openSection,
  loadSectionData,
  renderSectionDetail,
  suggestFrameworkPlacement,
  frameworkPlacementOptions,
  placementDataFromValue,
  resolveFrameworkPlacement,
  unitFolderGroups,
  canManageCourse,
  isOfficialCatalogCourse,
  previewJoin,
  joinSection,
  reloadCurrentSection:async(tab="overview")=>{
    if(!state.currentSection) return;
    state.sectionData=await loadSectionData(state.currentSection);
    renderSectionDetail(tab);
  }
};

document.addEventListener("click",async event=>{
  const close=event.target.closest("[data-close-modal]");
  if(close){closeModal();return;}
  const go=event.target.closest("[data-go]");
  if(go){setPage(go.dataset.go);return;}
  const btn=event.target.closest("[data-action]");
  if(!btn)return;
  const action=btn.dataset.action;
  if(action==="bulk-create-courses") return bulkCreateCoursesModal();
  if(action==="create-course") return openCourseModal();
  if(action==="create-section") return openSectionModal();
  if(action==="create-section-course") return openSectionModal(null,btn.dataset.id);
  if(action==="open-course") return openCourse(btn.dataset.id);
  if(action==="open-section") return openSection(btn.dataset.id);
  if(action==="back-courses") return setPage("courses");
  if(action==="back-sections") return setPage("sections");
  if(action==="edit-course") return openCourseModal(state.currentCourse);
  if(action==="add-unit") return openUnitModal();
  if(action==="bulk-import-framework") return bulkImportFrameworkModal(btn.dataset.course||state.currentCourse?.id||state.currentSection?.courseId);
  if(action==="edit-unit") return openUnitModal(state.courseFramework.units.find(x=>x.id===btn.dataset.id));
  if(action==="add-competency") return openCompetencyModal();
  if(action==="edit-competency") return openCompetencyModal(state.courseFramework.competencies.find(x=>x.id===btn.dataset.id));
  if(action==="add-section-competency") return openCompetencyModal(null,state.currentSection?.courseId);
  if(action==="edit-section-competency") return openCompetencyModal(state.sectionData?.framework?.competencies?.find(x=>x.id===btn.dataset.id),state.currentSection?.courseId);
  if(action==="add-topic") return openTopicModal(btn.dataset.unit);
  if(action==="edit-topic"){
    const unit=state.courseFramework.units.find(x=>x.id===btn.dataset.unit);
    return openTopicModal(btn.dataset.unit,unit?.topics?.find(x=>x.id===btn.dataset.id));
  }
  if(action==="edit-section") return openSectionModal(state.currentSection);
  if(action==="remove-section-student") return removeStudentFromSection(btn.dataset.student);
  if(action==="delete-section") return deleteSectionCompletely();
  if(action==="section-tab") return renderSectionDetail(btn.dataset.tab);
  if(action==="create-assignment") return openAssignmentModal();
  if(action==="bulk-import-assignments") return bulkImportAssignmentsModal();
  if(action==="auto-sort-assignments") return autoSortAssignmentsModal();
  if(action==="edit-assignment") return openAssignmentModal(state.sectionData.assignments.find(x=>x.id===btn.dataset.id));
  if(action==="delete-assignment") return deleteAssignment(btn.dataset.id);
  if(action==="open-student-assignment") return openStudentAssignmentModal(btn.dataset.id);
  if(action==="assignment-submissions") return openAssignmentSubmissionsModal(btn.dataset.id);
  if(action==="review-assignment-submission") return openAssignmentSubmissionReview(btn.dataset.assignment,btn.dataset.student);
  if(action==="create-resource") return openResourceModal();
  if(action==="bulk-import-resources") return bulkImportResourcesModal();
  if(action==="auto-sort-resources") return autoSortResourcesModal();
  if(action==="delete-resource") return deleteResource(btn.dataset.id);
  if(action==="open-section-resource") return openSection(btn.dataset.section,"resources");
  if(action==="delete-library-resource") return deleteLibraryResource(btn.dataset.section,btn.dataset.id);
  if(action==="edit-resource") return openResourceModal(state.sectionData.resources.find(x=>x.id===btn.dataset.id));
  if(action==="set-grade") return openGradeModal(btn.dataset.assignment,btn.dataset.student);
  if(action==="gradebook-jump"){
    const wrap=document.querySelector(".gradebook-wrap");
    const target=document.querySelector('[data-gradebook-anchor="'+btn.dataset.target+'"]');
    if(wrap&&target){
      const left=Math.max(0,target.offsetLeft-190);
      wrap.scrollTo({left,behavior:"smooth"});
    }
    return;
  }
  if(action==="open-gradebook-assessment"){
    if(window.TheoriaPhase3?.openAssessment) return window.TheoriaPhase3.openAssessment(btn.dataset.assessment,"candidates");
    showToast("Open this assessment from the Assessments tab to review formal grading.");
    return;
  }
  if(action==="copy-code"){
    if(!btn.dataset.code)return;
    try{await navigator.clipboard.writeText(btn.dataset.code);showToast("Join code copied.");}
    catch{showToast("Join code: "+btn.dataset.code);}
    return;
  }
  if(action==="show-code") return showJoinDisplay();
  if(action==="regenerate-code"){
    if(confirm("Regenerate this join code? The previous code will immediately stop working.")) return regenerateJoinCode();
    return;
  }
  if(action==="toggle-enrollment") return toggleEnrollment();
});

modalRoot.addEventListener("click",e=>{if(e.target.classList.contains("modal-backdrop"))closeModal();});

onAuthStateChanged(auth,async user=>{
  state.user=user;
  if(!user){
    state.profile=null;state.courses=[];state.sections=[];state.currentCourse=null;state.currentSection=null;state.isSystemOwner=false;
    authShell.classList.remove("hidden");appShell.classList.add("hidden");closeModal();return;
  }
  try{
    state.profile=await loadProfile(user);
    const ownerSnap=await getDoc(doc(db,"system","owner"));
    state.isSystemOwner=ownerSnap.exists()
      && ownerSnap.data().uid===user.uid
      && ownerSnap.data().confirmed===true;
  }catch(error){
    console.error("Unable to load Theoria profile:",error);
    state.profile={displayName:user.displayName||"Theoria User",email:user.email,role:"student"};
    state.isSystemOwner=false;
  }
  renderUser(user,state.profile);
  applyOwnerUI();
  authShell.classList.add("hidden");appShell.classList.remove("hidden");


  try{
    await loadWorkspace();
    setPage("home");
    window.dispatchEvent(new CustomEvent("theoria:ready"));
    const joinParam=new URLSearchParams(location.search).get("join");
    if(joinParam && state.role==="student") setTimeout(()=>previewJoin(joinParam),200);
  }catch(error){console.error(error);showToast("Theoria loaded, but some academic data could not be retrieved.");}
});
