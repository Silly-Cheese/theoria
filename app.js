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
  sectionData: null
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
  $("#profileRole").textContent = instructor ? "Instructor" : "Student";
  $("#welcomeSubtitle").textContent = instructor
    ? "Manage your theological courses, sections, academic frameworks, and student records."
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
    const courseSnap = await getDocs(query(collection(db,"courses"),where("ownerId","==",state.user.uid)));
    state.courses = courseSnap.docs.map(d => ({id:d.id,...d.data()}));
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
  return '<article class="academic-card">'+
    '<div class="card-kicker">'+esc(course.code || "THEO")+' • '+esc(course.level || "Advanced")+'</div>'+
    '<h3>'+esc(course.title || "Untitled Course")+'</h3>'+
    '<p>'+esc(course.description || "No course description has been added yet.")+'</p>'+
    '<div class="card-meta"><span>'+esc(course.discipline || "Theology")+'</span><span>'+esc(course.status || "Active")+'</span></div>'+
    '<div class="card-actions"><button class="secondary-btn small-btn" data-action="open-course" data-id="'+course.id+'">Open Framework</button></div>'+
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
  const el = $("#coursesContent");
  if(!state.courses.length){
    el.innerHTML = '<div class="empty-state"><div class="empty-symbol">C</div><h3>No course frameworks yet.</h3><p>'+(state.role==="instructor"?"Create the reusable academic framework first. Sections will draw their units, topics, and competencies from it.":"Your enrolled course frameworks will appear here.")+'</p>'+(state.role==="instructor"?'<button class="primary-btn" data-action="create-course">Create Course</button>':'')+'</div>';
    return;
  }
  el.innerHTML = '<div class="academic-banner"><div class="kicker">Course Architecture</div><h3>Framework before assignments.</h3><p>Courses define the intellectual structure; sections are the actual teaching instances.</p></div><div class="card-grid">'+state.courses.map(courseCard).join("")+'</div>';
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

function openCourseModal(existing){
  const editing = !!existing;
  const modal = openModal({
    eyebrow:"Course Framework",
    title:editing?"Edit Course":"Create Course",
    body:'<form id="courseForm"><div class="form-grid">'+
      '<div class="field"><label>Course Code</label><input name="code" maxlength="16" placeholder="APOL 301" value="'+esc(existing?.code||"")+'" required></div>'+
      '<div class="field"><label>Academic Level</label><select name="level"><option>Advanced</option><option>Intermediate</option><option>Introductory</option><option>Graduate-style</option></select></div>'+
      '<div class="field span-2"><label>Course Title</label><input name="title" placeholder="Advanced Christian Apologetics" value="'+esc(existing?.title||"")+'" required></div>'+
      '<div class="field"><label>Discipline</label><input name="discipline" placeholder="Apologetics" value="'+esc(existing?.discipline||"")+'"></div>'+
      '<div class="field"><label>Status</label><select name="status"><option>Active</option><option>Draft</option><option>Archived</option></select></div>'+
      '<div class="field span-2"><label>Description</label><textarea name="description" placeholder="Describe the scope and academic purpose of this course.">'+esc(existing?.description||"")+'</textarea></div>'+
    '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(editing?"Save Changes":"Create Course")+'</button></div></form>'
  });
  const form=modal.querySelector("#courseForm");
  if(existing){
    form.level.value=existing.level||"Advanced";
    form.status.value=existing.status||"Active";
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
      updatedAt:serverTimestamp()
    };
    try{
      if(editing) await updateDoc(doc(db,"courses",existing.id),data);
      else await addDoc(collection(db,"courses"),{...data,ownerId:state.user.uid,createdAt:serverTimestamp()});
      closeModal();
      await loadWorkspace();
      showToast(editing?"Course updated.":"Course framework created.");
    }catch(error){ showToast(humanizeFirebaseError(error)); }
  });
}

function openSectionModal(existing){
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
  if(state.role==="instructor" && !course.ownerId){
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
  const instructor=state.role==="instructor" && c.ownerId===state.user.uid;
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
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(c.code||"Course")+'</div><h1 class="detail-title">'+esc(c.title)+'</h1><div class="detail-meta"><span>'+esc(c.discipline||"Theology")+'</span><span>'+esc(c.level||"Advanced")+'</span><span>'+esc(c.status||"Active")+'</span></div></div>'+(instructor?'<div class="inline-actions"><button class="secondary-btn small-btn" data-action="edit-course">Edit Course</button><button class="primary-btn small-btn" data-action="add-unit">Add Unit</button></div>':'')+'</div>'+(c.description?'<p class="page-subtitle" style="margin-top:16px">'+esc(c.description)+'</p>':'')+'</div>'+
    '<div class="framework-layout"><div><div class="panel-head" style="padding-left:0;border:0"><div class="panel-title">Course Framework</div></div><div class="unit-list">'+units+'</div></div>'+
    '<aside><div class="panel"><div class="panel-head"><div class="panel-title">Academic Competencies</div>'+(instructor?'<button class="panel-link" data-action="add-competency">+ Add</button>':'')+'</div><div class="panel-body"><div class="competency-list">'+competencies+'</div></div></div></aside></div>';
}

function openUnitModal(existing){
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
      if(state.role==="instructor" && !course?.ownerId){
        await updateDoc(doc(db,"courses",courseId),{ownerId:state.user.uid,updatedAt:serverTimestamp()});
        if(course) course.ownerId=state.user.uid;
      }
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
        if(g.exists() && g.data().released===true) assessmentGrades.push({id:g.id,...g.data()});
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
    resources:resourceSnap.docs.map(d=>({id:d.id,...d.data()})),
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
  const instructor=state.role==="instructor";
  const competencyPanel='<div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><div class="panel-title">Academic Competencies</div><div class="panel-subtitle">Reusable skills for topic mapping, question-bank tagging, and mastery analytics.</div></div>'+(instructor?'<button class="panel-link" data-action="add-section-competency">+ Create Competency</button>':'')+'</div><div class="panel-body">'+(fw.competencies?.length?'<div class="competency-chip-grid">'+fw.competencies.map(c=>'<div class="competency-chip"><strong>'+esc(c.code)+'</strong><span>'+esc(c.name)+'</span>'+(instructor?'<button class="text-btn" data-action="edit-section-competency" data-id="'+c.id+'">Edit</button>':'')+'</div>').join("")+'</div>':'<div class="empty-mini">No competencies have been defined yet.'+(instructor?' Create the first one here.':'')+'</div>')+'</div></div>';
  if(!fw.units.length) return competencyPanel+'<div class="empty-state"><div class="empty-symbol">U</div><h3>The course guide is not yet built.</h3><p>'+(instructor?"Add units and topics from the main Courses workspace.":"Your instructor has not added units and topics to this course framework.")+'</p></div>';
  return competencyPanel+'<div class="unit-list">'+fw.units.map((u,i)=>'<article class="unit-card"><div class="unit-head"><div><div class="unit-number">Unit '+esc(u.order||i+1)+'</div><h3>'+esc(u.title)+'</h3>'+(u.description?'<div class="topic-detail">'+esc(u.description)+'</div>':'')+'</div></div><div class="topic-list">'+((u.topics||[]).length?sortByOrder(u.topics).map(t=>'<div class="topic-row"><div class="topic-index">'+esc(t.number||"")+'</div><div><div class="topic-title">'+esc(t.title)+'</div>'+(t.learningObjective?'<div class="topic-detail"><strong>Learning Objective:</strong> '+esc(t.learningObjective)+'</div>':'')+(t.essentialKnowledge?'<div class="topic-detail"><strong>Essential Knowledge:</strong> '+esc(t.essentialKnowledge)+'</div>':'')+(t.competencyCodes?.length?'<div class="topic-detail"><strong>Competencies:</strong> '+esc(t.competencyCodes.join(", "))+'</div>':'')+'</div></div>').join(""):'<div class="empty-mini">No topics yet.</div>')+'</div></article>').join("")+'</div>';
}

function assignmentDueState(assignment){
  if(!assignment.dueDate)return {label:"No due date",late:false};
  const due=new Date(assignment.dueDate+"T23:59:59");
  const late=Date.now()>due.getTime();
  return {label:"Due "+formatDate(assignment.dueDate),late};
}

function renderAssignments(){
  const items=state.sectionData.assignments.filter(a=>state.role==="instructor" || a.status!=="Draft");
  const submissionMap=new Map((state.sectionData.assignmentSubmissions||[]).map(x=>[x.assignmentId,x]));
  const gradeMap=new Map((state.sectionData.grades||[]).map(g=>[g.assignmentId,g]));
  const list=items.length ? '<div class="assignment-list">'+items.map(a=>{
    const due=assignmentDueState(a),submission=submissionMap.get(a.id),grade=gradeMap.get(a.id);
    const studentStatus=grade?"Graded":submission?.status==="submitted"?"Submitted":submission?.status==="draft"?"Draft saved":due.late?"Late / Not submitted":"Not started";
    const statusClass=grade?"live":submission?.status==="submitted"?"live":submission?.status==="draft"?"gold":due.late?"danger":"";
    return '<div class="assignment-row coursework-card"><div><div class="card-kicker">'+esc(a.type||"Assignment")+
      (a.unitTitle?' • Unit '+esc(a.unitNumber||"")+': '+esc(a.unitTitle):'')+
      (a.topicNumber?' • Topic '+esc(a.topicNumber):'')+
      '</div><h4>'+esc(a.title)+'</h4>'+(a.description?'<p>'+esc(a.description)+'</p>':'')+
      (a.instructionSteps?.length?'<div class="assignment-step-preview">'+a.instructionSteps.slice(0,3).map((step,i)=>'<div><span>'+String(i+1).padStart(2,"0")+'</span>'+esc(step)+'</div>').join("")+(a.instructionSteps.length>3?'<small>+'+(a.instructionSteps.length-3)+' more step'+(a.instructionSteps.length-3===1?"":"s")+'</small>':'')+'</div>':'')+
      '<div class="assignment-meta"><span>'+esc(a.points||0)+' points</span><span class="'+(due.late&&!submission?"late-text":"")+'">'+esc(due.label)+'</span>'+(a.requirements?.length?'<span>'+a.requirements.length+' requirement'+(a.requirements.length===1?"":"s")+'</span>':'')+'<span>'+esc(a.submissionMode||"Text + Link")+'</span>'+(state.role==="instructor"?'<span class="badge '+(a.status==="Published"?'live':'gold')+'">'+esc(a.status||"Published")+'</span>':'<span class="badge '+statusClass+'">'+esc(studentStatus)+'</span>')+'</div>'+
      (grade&&state.role==="student"?'<div class="assignment-grade-preview"><strong>'+esc(grade.score)+' / '+esc(a.points||0)+'</strong>'+(grade.comment?'<span>'+esc(grade.comment)+'</span>':'')+'</div>':'')+
      '</div><div class="inline-actions">'+
      (state.role==="instructor"?'<button class="secondary-btn small-btn" data-action="assignment-submissions" data-id="'+a.id+'">Submissions</button><button class="text-btn" data-action="edit-assignment" data-id="'+a.id+'">Edit</button><button class="danger-btn small-btn" data-action="delete-assignment" data-id="'+a.id+'">Delete</button>':
        (a.submissionMode==="No Online Submission"?'<span class="badge">Instructor-managed</span>':'<button class="primary-btn small-btn" data-action="open-student-assignment" data-id="'+a.id+'">'+(submission?.status==="submitted"?(a.allowResubmission?"View / Revise":"View Submission"):(submission?.status==="draft"?"Continue Assignment":"Open Assignment"))+'</button>'))+
      '</div></div>';
  }).join("")+'</div>' : '<div class="empty-state"><div class="empty-symbol">A</div><h3>No assignments yet.</h3><p>'+(state.role==="instructor"?"Create coursework, readings, written responses, research milestones, or academic exercises.":"Nothing has been assigned in this section yet.")+'</p></div>';
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Coursework</div><p class="page-subtitle">'+(state.role==="instructor"?"Create, bulk-plan, collect, review, and grade student coursework.":"Open assignments here, save drafts, and submit your work directly in Theoria.")+'</p></div>'+(state.role==="instructor"?'<div class="inline-actions"><button class="secondary-btn small-btn" data-action="bulk-import-assignments">Bulk Import Unit</button><button class="primary-btn small-btn" data-action="create-assignment">Create Assignment</button></div>':'')+'</div>'+list;
}

function renderResources(){
  const items=state.sectionData.resources;
  const list=items.length?'<div class="resource-list">'+items.map(r=>
    '<div class="resource-row"><div><div class="card-kicker">'+esc(r.type||"Reading")+'</div><h4>'+esc(r.title)+'</h4>'+(r.citation?'<div class="resource-citation">'+esc(r.citation)+'</div>':'')+(r.notes?'<p>'+esc(r.notes)+'</p>':'')+'<div class="resource-meta">'+(r.url?'<a class="link" target="_blank" rel="noopener" href="'+esc(r.url)+'">Open Resource ↗</a>':'<span>No external link</span>')+'</div></div>'+(state.role==="instructor"?'<div class="inline-actions"><button class="text-btn" data-action="edit-resource" data-id="'+r.id+'">Edit</button></div>':'')+'</div>'
  ).join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">R</div><h3>No resources yet.</h3><p>'+(state.role==="instructor"?"Add primary sources, Scripture readings, articles, books, or research links.":"Your instructor has not added resources yet.")+'</p></div>';
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Readings & Resources</div></div>'+(state.role==="instructor"?'<button class="primary-btn small-btn" data-action="create-resource">Add Resource</button>':'')+'</div>'+list;
}

function renderStudents(){
  const members=state.sectionData.members;
  if(!members.length) return '<div class="empty-state"><div class="empty-symbol">S</div><h3>No students enrolled.</h3><p>Display the section join code and have students enroll.</p></div>';
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Email</th><th>Joined</th><th>Status</th><th>Assessment Access</th></tr></thead><tbody>'+members.map(m=>'<tr><td><strong>'+esc(m.displayName||"Student")+'</strong></td><td>'+esc(m.email||"—")+'</td><td>'+esc(formatDate(m.joinedAt))+'</td><td><span class="badge live">Enrolled</span></td><td><button class="text-btn" data-phase3-action="accommodations" data-student="'+m.id+'">Accommodations</button></td></tr>').join("")+'</tbody></table></div>';
}

function renderGradebook(){
  const students=state.sectionData.members;
  const assignments=state.sectionData.assignments.filter(a=>a.status!=="Draft");
  const assessments=(state.sectionData.assessmentRefs||[]).filter(a=>a.status!=="Draft");
  if(!students.length || (!assignments.length&&!assessments.length)) return '<div class="empty-state"><div class="empty-symbol">G</div><h3>Gradebook waiting for data.</h3><p>Enroll at least one student and publish an assignment or assessment.</p></div>';

  const gradeMap=new Map(state.sectionData.grades.map(g=>[g.assignmentId+"_"+g.studentId,g]));
  const assessmentGradeMap=new Map((state.sectionData.assessmentGrades||[]).map(g=>[g.assessmentId+"_"+g.studentId,g]));

  const header='<thead>'+
    '<tr class="gradebook-group-row"><th rowspan="2">Student</th>'+
      (assignments.length?'<th colspan="'+assignments.length+'" class="gradebook-group coursework-group">Coursework</th>':'')+
      (assessments.length?'<th colspan="'+assessments.length+'" class="gradebook-group assessment-group">Assessments</th>':'')+
      '<th rowspan="2">Coursework Avg</th><th rowspan="2">Assessment Avg</th>'+
    '</tr>'+
    '<tr>'+
      assignments.map(a=>'<th><span class="gradebook-kind">Assignment</span>'+esc(a.title)+'<span class="grade-sub">'+esc(a.points)+' pts</span></th>').join("")+
      assessments.map(a=>'<th class="assessment-grade-head"><span class="gradebook-kind assessment-kind">'+esc(a.assessmentType||a.type||"Assessment")+'</span>'+esc(a.title||"Assessment")+'<span class="grade-sub">'+(Number(a.totalPoints||0)?esc(a.totalPoints)+" pts":"Formal assessment")+'</span></th>').join("")+
    '</tr></thead>';

  const body=students.map(student=>{
    let courseworkEarned=0,courseworkPossible=0;
    const assignmentCells=assignments.map(a=>{
      const g=gradeMap.get(a.id+"_"+student.id);
      if(g&&g.score!==null&&g.score!==undefined){courseworkEarned+=Number(g.score);courseworkPossible+=Number(a.points||0);}
      return '<td class="score-cell" data-action="set-grade" data-assignment="'+a.id+'" data-student="'+student.id+'">'+(g?'<span class="grade-main">'+esc(g.score)+'</span><span class="grade-sub">/ '+esc(a.points)+'</span>':'—')+'</td>';
    }).join("");

    const assessmentPercents=[];
    const assessmentCells=assessments.map(a=>{
      const g=assessmentGradeMap.get(a.id+"_"+student.id);
      if(g&&g.percent!==null&&g.percent!==undefined)assessmentPercents.push(Number(g.percent));
      const score=(g&&g.score!==undefined&&g.score!==null)?esc(g.score):"";
      const max=(g&&g.maxScore!==undefined&&g.maxScore!==null)?esc(g.maxScore):esc(a.totalPoints||"");
      return '<td class="score-cell assessment-score-cell" data-action="open-gradebook-assessment" data-assessment="'+a.id+'" data-student="'+student.id+'">'+
        (g?'<span class="grade-main">'+(score&&max?score+" / "+max:esc(g.percent)+"%")+'</span><span class="grade-sub">'+esc(g.percent)+'%'+(g.released?' • released':' • private')+'</span>':'<span class="grade-pending">—<small>Not graded</small></span>')+
      '</td>';
    }).join("");

    const courseworkAvg=courseworkPossible?Math.round((courseworkEarned/courseworkPossible)*1000)/10:null;
    const assessmentAvg=assessmentPercents.length?Math.round((assessmentPercents.reduce((a,b)=>a+b,0)/assessmentPercents.length)*10)/10:null;
    return '<tr><td><strong>'+esc(student.displayName||"Student")+'</strong></td>'+assignmentCells+assessmentCells+
      '<td><strong>'+(courseworkAvg===null?"—":courseworkAvg+"%")+'</strong></td>'+
      '<td><strong>'+(assessmentAvg===null?"—":assessmentAvg+"%")+'</strong></td></tr>';
  }).join("");

  return '<div class="notice">Assignments and formal assessments now share the section gradebook. Coursework and assessment averages remain separate because the student’s final certified grade follows the selected grading pathway.</div>'+
    '<div class="gradebook-legend"><span><i class="legend-dot coursework-dot"></i> Coursework grades can be edited here</span><span><i class="legend-dot assessment-dot"></i> Assessment scores are graded in Assessments</span></div>'+
    '<div class="data-table-wrap gradebook-wrap"><table class="data-table gradebook-table">'+header+'<tbody>'+body+'</tbody></table></div>';
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
    body=(instructor?'<div class="join-display"><div><div class="eyebrow">Section Enrollment</div><div class="join-code">'+esc(s.joinCode||"No Code")+'</div><p>'+esc(s.joinOpen!==false?"Accepting students":"Enrollment is currently closed")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-action="copy-code" data-code="'+esc(s.joinCode||"")+'">Copy Code</button><button class="secondary-btn small-btn" data-action="show-code">Display Full Screen</button><button class="secondary-btn small-btn" data-action="regenerate-code">Regenerate</button><button class="secondary-btn small-btn" data-action="toggle-enrollment">'+(s.joinOpen!==false?"Close Enrollment":"Open Enrollment")+'</button></div></div><div class="qr-box"><img alt="Join QR code" src="https://quickchart.io/qr?size=180&text='+encodeURIComponent(location.origin+location.pathname+"?join="+s.joinCode)+'"></div></div>':'')+
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
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(s.courseCode||"Section")+' • '+esc(s.term||"")+'</div><h1 class="detail-title">'+esc(s.courseTitle||s.sectionName||"Section")+'</h1><div class="detail-meta"><span>'+esc(s.sectionName||("Section "+(s.sectionNumber||"")))+'</span><span>'+esc(s.instructorName||"")+'</span><span>'+esc(s.startDate?formatDate(s.startDate)+" – "+formatDate(s.endDate):s.format||"")+'</span></div></div>'+(instructor?'<button class="secondary-btn small-btn" data-action="edit-section">Edit Section</button>':'')+'</div></div>'+
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
      unitId:existing?.unitId||"",
      unitTitle:existing?.unitTitle||"",
      unitNumber:existing?.unitNumber||"",
      topicId:existing?.topicId||"",
      topicTitle:existing?.topicTitle||"",
      topicNumber:existing?.topicNumber||"",
      tags:existing?.tags||[],
      unitSequence:existing?.unitSequence||0,
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

function openResourceModal(existing){
  const modal=openModal({
    eyebrow:"Scholar Resource",
    title:existing?"Edit Resource":"Add Resource",
    wide:true,
    body:'<form id="resourceForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Resource Identity</h3><p>Add the source students should use and classify it clearly.</p></div></div>'+
        '<div class="field"><label>Resource Title</label><input class="title-input" name="title" value="'+esc(existing?.title||"")+'" placeholder="e.g. Augustine, Confessions Book VIII" required></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Type</label><select name="type"><option>Primary Source</option><option>Scripture Reading</option><option>Article</option><option>Book / Chapter</option><option>PDF Link</option><option>Lecture Notes</option><option>Research Link</option><option>Supplemental Resource</option></select></div><div class="field"><label>URL</label><input type="url" name="url" value="'+esc(existing?.url||"")+'" placeholder="https://"></div><div class="field"><label>Citation / Reference</label><input name="citation" value="'+esc(existing?.citation||"")+'" placeholder="Author, title, chapter, pages"></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Reading Note</h3><p>Give students a short reason for using this resource.</p></div></div>'+
        '<div class="field"><label>Student Note</label><textarea class="editor-compact" rows="2" name="notes" placeholder="What should students pay attention to while reading?">'+esc(existing?.notes||"")+'</textarea></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Resource</button></div></form>'
  });
  const form=modal.querySelector("#resourceForm");
  if(existing) form.type.value=existing.type||"Primary Source";
  const note=form.querySelector(".editor-compact");
  const grow=()=>{note.style.height="auto";note.style.height=Math.min(note.scrollHeight,180)+"px";};note.addEventListener("input",grow);grow();
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form);
    const data={title:String(fd.get("title")).trim(),type:String(fd.get("type")),url:String(fd.get("url")).trim(),citation:String(fd.get("citation")||"").trim(),notes:String(fd.get("notes")).trim(),updatedAt:serverTimestamp()};
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
      '<article class="library-card"><div class="library-card-top"><div><span>'+esc(r.type||"Resource")+'</span><h3>'+esc(r.title||"Untitled Resource")+'</h3></div><span class="library-course">'+esc(r.courseCode||"Course")+'</span></div>'+
      (r.citation?'<div class="library-citation">'+esc(r.citation)+'</div>':'')+
      (r.notes?'<p>'+esc(r.notes)+'</p>':'')+
      '<div class="library-card-foot"><div><strong>'+esc(r.sectionName)+'</strong><span>'+esc(r.term||"")+'</span></div>'+
      (r.url?'<a class="secondary-btn small-btn" href="'+esc(r.url)+'" target="_blank" rel="noopener noreferrer">Open Resource ↗</a>':'<button class="secondary-btn small-btn" data-action="open-section-resource" data-section="'+r.sectionId+'">Open Section</button>')+
      '</div></article>'
    ).join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">L</div><h3>No matching resources.</h3><p>'+(resources.length?"Adjust the Library filters or search terms.":"Resources assigned in your sections will appear here automatically.")+'</p></div>';
  };
  search.addEventListener("input",render);type.addEventListener("change",render);section.addEventListener("change",render);render();
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
    const modal=openModal({
      eyebrow:"Join a Section",
      title:section.courseTitle || "Theoria Section",
      body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||("Section "+section.sectionNumber))+'</h3><p>'+esc(section.term||"")+' • '+esc(section.instructorName||"Instructor")+' • '+esc(section.format||"")+'</p></div><p class="page-subtitle">You are requesting to join this section using <strong>'+esc(code)+'</strong>.</p>',
      footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="confirmJoinBtn">Join Section</button>'
    });
    modal.querySelector("#confirmJoinBtn").addEventListener("click",()=>joinSection(section,code));
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
    const credential=await createUserWithEmailAndPassword(auth,email,password);
    await updateProfile(credential.user,{displayName:name});
    const userRef=doc(db,"users",credential.user.uid);
    const profileBase={displayName:name,email,createdAt:serverTimestamp(),updatedAt:serverTimestamp()};
    if(state.role==="instructor"){
      const ownerRef=doc(db,"system","owner");
      const ownerSnap=await getDoc(ownerRef);
      if(!ownerSnap.exists()){
        const batch=writeBatch(db);
        batch.set(userRef,{...profileBase,role:"instructor",bootstrapOwner:true});
        batch.set(ownerRef,{uid:credential.user.uid,displayName:name,email,createdAt:serverTimestamp()});
        await batch.commit();
      }else{
        state.role="student";
        await setDoc(userRef,{...profileBase,role:"student"});
        showToast("An instructor owner already exists. This account was created as a student.");
      }
    }else{
      await setDoc(userRef,{...profileBase,role:"student"});
    }
  }catch(error){authError.textContent=humanizeFirebaseError(error);}
  finally{button.disabled=false;button.textContent="Create Theoria account";}
});

$("#signOutBtn").addEventListener("click",async()=>{await signOut(auth);showToast("Signed out of Theoria.");});
$("#mobileMenuBtn").addEventListener("click",()=>sidebar.classList.toggle("open"));
$$(".nav-item").forEach(btn=>btn.addEventListener("click",()=>setPage(btn.dataset.page)));
$("#quickJoinBtn").addEventListener("click",()=>{setPage("sections");setTimeout(()=>$("#joinCodeInput")?.focus(),50);});
$("#quickCreateBtn").addEventListener("click",()=>openSectionModal());
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
  if(action==="create-course") return openCourseModal();
  if(action==="create-section") return openSectionModal();
  if(action==="open-course") return openCourse(btn.dataset.id);
  if(action==="open-section") return openSection(btn.dataset.id);
  if(action==="back-courses") return setPage("courses");
  if(action==="back-sections") return setPage("sections");
  if(action==="edit-course") return openCourseModal(state.currentCourse);
  if(action==="add-unit") return openUnitModal();
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
  if(action==="section-tab") return renderSectionDetail(btn.dataset.tab);
  if(action==="create-assignment") return openAssignmentModal();
  if(action==="bulk-import-assignments") return bulkImportAssignmentsModal();
  if(action==="edit-assignment") return openAssignmentModal(state.sectionData.assignments.find(x=>x.id===btn.dataset.id));
  if(action==="delete-assignment") return deleteAssignment(btn.dataset.id);
  if(action==="open-student-assignment") return openStudentAssignmentModal(btn.dataset.id);
  if(action==="assignment-submissions") return openAssignmentSubmissionsModal(btn.dataset.id);
  if(action==="review-assignment-submission") return openAssignmentSubmissionReview(btn.dataset.assignment,btn.dataset.student);
  if(action==="create-resource") return openResourceModal();
  if(action==="open-section-resource") return openSection(btn.dataset.section,"resources");
  if(action==="edit-resource") return openResourceModal(state.sectionData.resources.find(x=>x.id===btn.dataset.id));
  if(action==="set-grade") return openGradeModal(btn.dataset.assignment,btn.dataset.student);
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
    state.profile=null;state.courses=[];state.sections=[];state.currentCourse=null;state.currentSection=null;
    authShell.classList.remove("hidden");appShell.classList.add("hidden");closeModal();return;
  }
  try{
    state.profile=await loadProfile(user);
    if(state.profile.role==="instructor"){
      const ownerRef=doc(db,"system","owner");
      const ownerSnap=await getDoc(ownerRef);
      if(!ownerSnap.exists()){
        await setDoc(ownerRef,{uid:user.uid,displayName:state.profile.displayName||user.displayName||"Instructor",email:user.email,createdAt:serverTimestamp()});
      }
    }
  }
  catch(error){console.error("Unable to load Theoria profile:",error);state.profile={displayName:user.displayName||"Theoria User",email:user.email,role:"student"};}
  renderUser(user,state.profile);
  authShell.classList.add("hidden");appShell.classList.remove("hidden");
  try{
    await loadWorkspace();
    setPage("home");
    window.dispatchEvent(new CustomEvent("theoria:ready"));
    const joinParam=new URLSearchParams(location.search).get("join");
    if(joinParam && state.role==="student") setTimeout(()=>previewJoin(joinParam),200);
  }catch(error){console.error(error);showToast("Theoria loaded, but some academic data could not be retrieved.");}
});
