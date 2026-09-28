import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, Timestamp, serverTimestamp
} from "./firebase.js";

const p3 = {
  booted:false,
  items:[],
  assessments:[],
  currentAssessment:null,
  assessmentData:null,
  exam:null,
  timer:null,
  autosave:null
};

const core = () => window.TheoriaCore;
const state = () => core()?.getState();
const $ = s => document.querySelector(s);
const esc = v => core()?.esc(v) ?? String(v ?? "");
const toast = m => core()?.showToast(m);

function dt(value){
  if(!value) return "Not scheduled";
  const d = value.toDate ? value.toDate() : new Date(value);
  if(Number.isNaN(d.getTime())) return "Not scheduled";
  return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}).format(d);
}

function localValue(value){
  if(!value) return "";
  const d=value.toDate?value.toDate():new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  const pad=n=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes());
}

function toTimestamp(value){
  if(!value) return null;
  const d=new Date(value);
  return Number.isNaN(d.getTime())?null:Timestamp.fromDate(d);
}

function parseWeighted(text){
  return String(text||"").split("\n").map(x=>x.trim()).filter(Boolean).map((line,index)=>{
    const parts=line.split("|");
    return {id:"w"+(index+1),label:(parts[0]||"").trim(),weight:Number(parts[1]||0)};
  }).filter(x=>x.label);
}

function parseRubric(text){
  return String(text||"").split("\n").map(x=>x.trim()).filter(Boolean).map((line,index)=>{
    const parts=line.split("|");
    return {id:"r"+(index+1),criterion:(parts[0]||"").trim(),points:Number(parts[1]||0)};
  }).filter(x=>x.criterion);
}

function rubricText(rubric){
  return (rubric||[]).map(x=>x.criterion+" | "+x.points).join("\n");
}

function blueprintText(rows){
  return (rows||[]).map(x=>x.label+" | "+x.weight).join("\n");
}

function weightTotal(rows){
  return (rows||[]).reduce((sum,x)=>sum+Number(x.weight||0),0);
}

function defaultParts(type){
  if(type==="Comprehensive Final Examination"){
    return [
      {id:"foundations",title:"Foundational Knowledge",weight:20},
      {id:"exegesis",title:"Scripture & Exegesis",weight:20},
      {id:"sources",title:"Primary Source Analysis",weight:15},
      {id:"argument",title:"Argument Analysis",weight:15},
      {id:"responses",title:"Short Theological Responses",weight:10},
      {id:"essay",title:"Comprehensive Essay",weight:20}
    ];
  }
  if(type==="Semester I Examination"){
    return [
      {id:"foundations",title:"Foundational Knowledge",weight:25},
      {id:"exegesis",title:"Scripture & Exegesis",weight:20},
      {id:"sources",title:"Primary Source Analysis",weight:15},
      {id:"argument",title:"Argument Analysis",weight:15},
      {id:"essay",title:"Theological Synthesis Essay",weight:25}
    ];
  }
  if(type==="Oral Examination") return [{id:"oral",title:"Oral Examination",weight:100}];
  if(type==="Disputation") return [{id:"disputation",title:"Thesis & Defense",weight:100}];
  return [{id:"main",title:"Main Assessment",weight:100}];
}

function isObjective(type){
  return type==="Multiple Choice" || type==="Multiple Select";
}

function candidateNumber(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="C-";
  for(let i=0;i<6;i++) out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function normalizeAnswer(value,type){
  if(type==="Multiple Select"){
    const arr=Array.isArray(value)?value:String(value||"").split(",");
    return arr.map(x=>String(x).trim().toUpperCase()).filter(Boolean).sort();
  }
  return String(value??"").trim().toUpperCase();
}

function answersEqual(a,b,type){
  const aa=normalizeAnswer(a,type),bb=normalizeAnswer(b,type);
  if(Array.isArray(aa)) return aa.length===bb.length && aa.every((x,i)=>x===bb[i]);
  return aa===bb;
}

async function getCourseFramework(courseId){
  const unitSnap=await getDocs(collection(db,"courses",courseId,"units"));
  const compSnap=await getDocs(collection(db,"courses",courseId,"competencies"));
  const units=unitSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  for(const unit of units){
    const topics=await getDocs(collection(db,"courses",courseId,"units",unit.id,"topics"));
    unit.topics=topics.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  }
  return {units,competencies:compSnap.docs.map(d=>({id:d.id,...d.data()}))};
}

async function loadItems(){
  const s=state();
  if(!s || s.role!=="instructor") return [];
  const items=[];
  for(const course of s.courses){
    const snap=await getDocs(collection(db,"courses",course.id,"items"));
    snap.docs.forEach(d=>items.push({id:d.id,courseId:course.id,courseCode:course.code,courseTitle:course.title,...d.data()}));
  }
  p3.items=items.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||"")) || String(a.prompt||"").localeCompare(String(b.prompt||"")));
  return p3.items;
}

async function loadAssessments(){
  const s=state();
  if(!s) return [];
  const list=[];
  if(s.role==="instructor"){
    const snap=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
    snap.docs.forEach(d=>list.push({id:d.id,...d.data()}));
  }else{
    for(const section of s.sections){
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
      for(const ref of refs.docs){
        try{
          const a=await getDoc(doc(db,"assessments",ref.id));
          if(a.exists()) list.push({id:a.id,...a.data()});
        }catch(e){}
      }
    }
  }
  p3.assessments=list.sort((a,b)=>{
    const ad=a.opensAt?.toMillis?.()||0,bd=b.opensAt?.toMillis?.()||0;
    return bd-ad || String(a.title||"").localeCompare(String(b.title||""));
  });
  return p3.assessments;
}

function itemCard(item){
  return '<article class="assessment-item-card">'+
    '<div class="item-card-head"><div><div class="card-kicker">'+esc(item.courseCode||"COURSE")+' • '+esc(item.type||"Item")+'</div><h3>'+esc((item.prompt||"Untitled item").slice(0,130))+(String(item.prompt||"").length>130?"…":"")+'</h3></div><span class="badge">'+esc(item.difficulty||"Moderate")+'</span></div>'+
    '<div class="item-tags"><span>'+esc(item.topicNumber||"Unassigned topic")+'</span><span>'+esc(item.cognitiveLevel||"Application")+'</span><span>'+esc(item.pointsDefault||1)+' pts</span>'+(item.competencyCodes||[]).map(c=>'<span>'+esc(c)+'</span>').join("")+'</div>'+
    '<div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="edit-item" data-id="'+item.id+'" data-course="'+item.courseId+'">Edit</button></div>'+
  '</article>';
}

async function renderItemBank(){
  const el=$("#itemBankContent");
  if(!el || state()?.role!=="instructor") return;
  el.innerHTML='<div class="empty-mini">Loading item bank…</div>';
  await loadItems();
  const courses=state().courses;
  if(!courses.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">I</div><h3>Create a course first.</h3><p>Item Bank questions are owned by a course so they can inherit topics and academic competencies.</p></div>';
    return;
  }
  const courseOptions='<option value="">All courses</option>'+courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("");
  const typeOptions=["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"].map(x=>'<option>'+x+'</option>').join("");
  el.innerHTML='<div class="assessment-toolbar"><div class="filter-row"><select id="itemCourseFilter">'+courseOptions+'</select><select id="itemTypeFilter"><option value="">All item types</option>'+typeOptions+'</select><input id="itemSearch" placeholder="Search prompt, topic, competency, or tag"></div><div class="toolbar-stat"><strong>'+p3.items.length+'</strong><span> reusable items</span></div></div><div id="itemBankList" class="assessment-item-grid"></div>';
  const render=()=>{
    const course=$("#itemCourseFilter").value,type=$("#itemTypeFilter").value,q=$("#itemSearch").value.trim().toLowerCase();
    const list=p3.items.filter(x=>(!course||x.courseId===course)&&(!type||x.type===type)&&(!q||[x.prompt,x.topicTitle,x.topicNumber,(x.competencyCodes||[]).join(" "),(x.tags||[]).join(" ")].join(" ").toLowerCase().includes(q)));
    $("#itemBankList").innerHTML=list.length?list.map(itemCard).join(""):'<div class="empty-state"><div class="empty-symbol">I</div><h3>No matching items.</h3><p>Adjust the filters or create a new theological assessment item.</p></div>';
  };
  ["itemCourseFilter","itemTypeFilter","itemSearch"].forEach(id=>$("#"+id)?.addEventListener(id==="itemSearch"?"input":"change",render));
  render();
}

async function openItemModal(existing){
  const s=state();
  if(!s?.courses?.length) return toast("Create a course framework before creating assessment items.");
  const courseId=existing?.courseId || s.courses[0].id;
  const framework=await getCourseFramework(courseId);
  const courses=s.courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("");
  const types=["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"];
  const modal=core().openModal({
    eyebrow:"Item Bank",
    title:existing?"Edit Assessment Item":"Create Assessment Item",
    wide:true,
    body:'<form id="p3ItemForm"><div class="form-grid">'+
      '<div class="field"><label>Course</label><select name="courseId" id="p3ItemCourse" '+(existing?'disabled':'')+'>'+courses+'</select></div>'+
      '<div class="field"><label>Item Type</label><select name="type">'+types.map(x=>'<option>'+x+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Difficulty</label><select name="difficulty"><option>Foundational</option><option>Moderate</option><option>Advanced</option></select></div>'+
      '<div class="field"><label>Cognitive Level</label><select name="cognitiveLevel"><option>Recall</option><option>Understanding</option><option>Application</option><option>Analysis</option><option>Evaluation</option><option>Synthesis</option></select></div>'+
      '<div class="field"><label>Unit</label><select name="unitId" id="p3ItemUnit"></select></div>'+
      '<div class="field"><label>Topic</label><select name="topicId" id="p3ItemTopic"></select></div>'+
      '<div class="field"><label>Default Points</label><input name="pointsDefault" type="number" min="0" step="0.5" value="'+esc(existing?.pointsDefault??1)+'"></div>'+
      '<div class="field"><label>Tags</label><input name="tags" placeholder="christology, primary-source, final" value="'+esc((existing?.tags||[]).join(", "))+'"></div>'+
      '<div class="field span-2"><label>Source / Stimulus Title</label><input name="sourceTitle" value="'+esc(existing?.sourceTitle||"")+'" placeholder="Athanasius, On the Incarnation §8"></div>'+
      '<div class="field span-2"><label>Source / Stimulus Text</label><textarea name="stimulus" placeholder="Paste the passage, quotation, argument, or source text here. This Firestore-only build intentionally does not use file uploads.">'+esc(existing?.stimulus||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Prompt</label><textarea name="prompt" required>'+esc(existing?.prompt||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Answer Options</label><textarea name="options" placeholder="One option per line. Labels A, B, C… are assigned automatically.">'+esc((existing?.options||[]).map(x=>x.text||x).join("\n"))+'</textarea></div>'+
      '<div class="field"><label>Correct Answer(s)</label><input name="correctAnswer" value="'+esc(Array.isArray(existing?.correctAnswer)?existing.correctAnswer.join(", "):(existing?.correctAnswer||""))+'" placeholder="B or A, C"></div>'+
      '<div class="field"><label>Source Set / Group</label><input name="sourceSet" value="'+esc(existing?.sourceSet||"")+'" placeholder="Nicene Controversy Set"></div>'+
      '<div class="field span-2"><label>Answer Explanation / Instructor Key</label><textarea name="explanation">'+esc(existing?.explanation||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Rubric Criteria</label><textarea name="rubric" placeholder="Thesis clarity | 4\nBiblical support | 8\nHistorical understanding | 6">'+esc(rubricText(existing?.rubric))+'</textarea></div>'+
      '<div class="field span-2"><label>Academic Competencies</label><div id="p3Competencies" class="competency-picker"></div></div>'+
    '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Item</button></div></form>'
  });
  const form=modal.querySelector("#p3ItemForm");
  form.courseId.value=courseId;
  form.type.value=existing?.type||"Multiple Choice";
  form.difficulty.value=existing?.difficulty||"Moderate";
  form.cognitiveLevel.value=existing?.cognitiveLevel||"Application";

  let currentFramework=framework;
  const populateFramework=async(cid)=>{
    currentFramework=await getCourseFramework(cid);
    const unitSel=modal.querySelector("#p3ItemUnit");
    unitSel.innerHTML='<option value="">Unassigned</option>'+currentFramework.units.map(u=>'<option value="'+u.id+'">'+esc("Unit "+(u.order||"")+" — "+u.title)+'</option>').join("");
    unitSel.value=existing?.unitId||"";
    const fillTopics=()=>{
      const unit=currentFramework.units.find(u=>u.id===unitSel.value);
      const topicSel=modal.querySelector("#p3ItemTopic");
      topicSel.innerHTML='<option value="">Unassigned</option>'+((unit?.topics||[]).map(t=>'<option value="'+t.id+'">'+esc((t.number||"")+" — "+t.title)+'</option>').join(""));
      topicSel.value=existing?.topicId||"";
    };
    unitSel.onchange=fillTopics; fillTopics();
    modal.querySelector("#p3Competencies").innerHTML=currentFramework.competencies.length?currentFramework.competencies.map(c=>'<label class="checkbox-line"><input type="checkbox" name="competency" value="'+c.id+'" data-code="'+esc(c.code)+'" '+((existing?.competencyIds||[]).includes(c.id)?'checked':'')+'> '+esc(c.code+" — "+c.name)+'</label>').join(""):'<div class="empty-mini">No competencies have been created in this course.</div>';
  };
  if(!existing) modal.querySelector("#p3ItemCourse").addEventListener("change",e=>populateFramework(e.target.value));
  await populateFramework(courseId);

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const cid=existing?.courseId||String(fd.get("courseId"));
    const course=s.courses.find(c=>c.id===cid);
    const unit=currentFramework.units.find(u=>u.id===String(fd.get("unitId")));
    const topic=unit?.topics?.find(t=>t.id===String(fd.get("topicId")));
    const type=String(fd.get("type"));
    const opts=String(fd.get("options")||"").split("\n").map(x=>x.trim()).filter(Boolean).map((text,i)=>({id:String.fromCharCode(65+i),text}));
    const selected=Array.from(form.querySelectorAll('input[name="competency"]:checked'));
    let correct=String(fd.get("correctAnswer")||"").trim();
    if(type==="Multiple Select") correct=correct.split(",").map(x=>x.trim().toUpperCase()).filter(Boolean).sort();
    else correct=correct.toUpperCase();
    const data={
      ownerId:s.user.uid,
      courseId:cid,
      type,
      difficulty:String(fd.get("difficulty")),
      cognitiveLevel:String(fd.get("cognitiveLevel")),
      unitId:unit?.id||"",
      unitTitle:unit?.title||"",
      topicId:topic?.id||"",
      topicTitle:topic?.title||"",
      topicNumber:topic?.number||"",
      competencyIds:selected.map(x=>x.value),
      competencyCodes:selected.map(x=>x.dataset.code),
      pointsDefault:Number(fd.get("pointsDefault")||1),
      tags:String(fd.get("tags")||"").split(",").map(x=>x.trim()).filter(Boolean),
      sourceTitle:String(fd.get("sourceTitle")||"").trim(),
      sourceSet:String(fd.get("sourceSet")||"").trim(),
      stimulus:String(fd.get("stimulus")||"").trim(),
      prompt:String(fd.get("prompt")||"").trim(),
      options:opts,
      correctAnswer:correct,
      explanation:String(fd.get("explanation")||"").trim(),
      rubric:parseRubric(fd.get("rubric")),
      updatedAt:serverTimestamp()
    };
    try{
      if(existing) await updateDoc(doc(db,"courses",cid,"items",existing.id),data);
      else await addDoc(collection(db,"courses",cid,"items"),{...data,createdAt:serverTimestamp()});
      core().closeModal(); await renderItemBank(); toast(existing?"Item updated.":"Assessment item created.");
    }catch(error){toast(error.message||"Unable to save item.");}
  });
}

function availabilityLabel(a){
  const now=Date.now();
  const open=a.opensAt?.toMillis?.()||0;
  const close=a.closesAt?.toMillis?.()||0;
  if(a.status==="Draft") return "Draft";
  if(a.status==="Closed") return "Closed";
  if(open && now<open) return "Scheduled";
  if(close && now>close) return "Window Ended";
  return "Open";
}

async function renderAssessments(){
  const el=$("#assessmentsContent");
  if(!el) return;
  el.innerHTML='<div class="empty-mini">Loading assessments…</div>';
  await loadAssessments();
  const s=state();
  if(!p3.assessments.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">A</div><h3>No assessments yet.</h3><p>'+(s.role==="instructor"?"Create an academic exercise, unit evaluation, semester examination, comprehensive final, oral examination, or disputation.":"Published assessments from your sections will appear here.")+'</p>'+(s.role==="instructor"?'<button class="primary-btn" data-phase3-action="create-assessment">Create Assessment</button>':'')+'</div>';
    return;
  }
  if(s.role==="instructor"){
    el.innerHTML='<div class="assessment-grid">'+p3.assessments.map(a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type||"Assessment")+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p><div class="assessment-card-stats"><span><strong>'+esc(a.questionCount||0)+'</strong> items</span><span><strong>'+esc(a.totalPoints||0)+'</strong> points</span><span>'+esc(availabilityLabel(a))+'</span></div><div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button></div></article>').join("")+'</div>';
  }else{
    const cards=[];
    for(const a of p3.assessments){
      let submission=null,result=null;
      try{const x=await getDoc(doc(db,"assessments",a.id,"submissions",s.user.uid));if(x.exists())submission={id:x.id,...x.data()};}catch(e){}
      try{const x=await getDoc(doc(db,"assessments",a.id,"results",s.user.uid));if(x.exists())result={id:x.id,...x.data()};}catch(e){}
      const avail=availabilityLabel(a);
      let action="";
      if(submission?.status==="submitted" || submission?.status==="graded") action='<button class="secondary-btn small-btn" data-phase3-action="view-receipt" data-id="'+a.id+'">Submission Receipt</button>';
      else if(avail==="Open") action='<button class="primary-btn small-btn" data-phase3-action="start-assessment" data-id="'+a.id+'">'+(submission?"Resume":"Begin")+'</button>';
      else action='<span class="badge">'+esc(avail)+'</span>';
      cards.push('<article class="assessment-card"><div class="assessment-type">'+esc(a.type||"Assessment")+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p><div class="assessment-card-stats"><span>'+esc(a.durationMinutes||0)+' min</span><span>'+esc(a.totalPoints||0)+' pts</span><span>'+esc(dt(a.closesAt))+'</span></div>'+(result?'<div class="released-result"><strong>'+esc(result.percent??"—")+'%</strong><span>Released result</span></div>':'')+'<div class="card-actions">'+action+'</div></article>');
    }
    el.innerHTML='<div class="assessment-grid">'+cards.join("")+'</div>';
  }
}

async function openAssessmentModal(existing){
  const s=state();
  if(!s?.sections?.length) return toast("Create a teaching section before creating an assessment.");
  const sectionOptions=s.sections.map(x=>'<option value="'+x.id+'">'+esc(x.courseCode+" — "+x.sectionName+" • "+x.term)+'</option>').join("");
  const types=["Academic Exercise","Unit Evaluation","Semester I Examination","Comprehensive Final Examination","Oral Examination","Disputation"];
  const modal=core().openModal({
    eyebrow:"Assessment Builder",
    title:existing?"Edit Assessment":"Create Assessment",
    wide:true,
    body:'<form id="p3AssessmentForm"><div class="form-grid">'+
      '<div class="field span-2"><label>Section</label><select name="sectionId" '+(existing?'disabled':'')+'>'+sectionOptions+'</select></div>'+
      '<div class="field span-2"><label>Assessment Title</label><input name="title" value="'+esc(existing?.title||"")+'" required></div>'+
      '<div class="field"><label>Assessment Type</label><select name="type">'+types.map(x=>'<option>'+x+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Duration (minutes)</label><input type="number" name="durationMinutes" min="0" value="'+esc(existing?.durationMinutes??60)+'"></div>'+
      '<div class="field"><label>Opens</label><input type="datetime-local" name="opensAt" value="'+esc(localValue(existing?.opensAt))+'"></div>'+
      '<div class="field"><label>Closes</label><input type="datetime-local" name="closesAt" value="'+esc(localValue(existing?.closesAt))+'"></div>'+
      '<div class="field span-2"><label>Instructions</label><textarea name="instructions">'+esc(existing?.instructions||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Content Blueprint</label><textarea name="contentBlueprint" placeholder="Unit I — Foundations | 20\nUnit II — Philosophy | 25">'+esc(blueprintText(existing?.contentBlueprint))+'</textarea><div class="fineprint">Use one line per target: label | percentage.</div></div>'+
      '<div class="field span-2"><label>Competency Blueprint</label><textarea name="competencyBlueprint" placeholder="Biblical Exegesis | 25\nTheological Synthesis | 25">'+esc(blueprintText(existing?.competencyBlueprint))+'</textarea></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="anonymousGrading" '+(existing?.anonymousGrading!==false?'checked':'')+'> Anonymous candidate-number grading</label></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="backtracking" '+(existing?.backtracking!==false?'checked':'')+'> Allow question backtracking</label></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="randomizeQuestions" '+(existing?.randomizeQuestions?'checked':'')+'> Randomize question order</label></div>'+
      '<div class="field"><label>Feedback</label><select name="feedbackPolicy"><option value="manual">Instructor releases results manually</option><option value="score_only">Release score only when instructor chooses</option></select></div>'+
    '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(existing?"Save Assessment":"Create Draft")+'</button></div></form>'
  });
  const form=modal.querySelector("#p3AssessmentForm");
  form.sectionId.value=existing?.sectionId||s.sections[0].id;
  form.type.value=existing?.type||"Unit Evaluation";
  form.feedbackPolicy.value=existing?.feedbackPolicy||"manual";
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const section=existing? s.sections.find(x=>x.id===existing.sectionId) || state().currentSection : s.sections.find(x=>x.id===String(fd.get("sectionId")));
    const type=String(fd.get("type"));
    const contentBlueprint=parseWeighted(fd.get("contentBlueprint"));
    const competencyBlueprint=parseWeighted(fd.get("competencyBlueprint"));
    if(contentBlueprint.length && weightTotal(contentBlueprint)!==100) return toast("Content blueprint weights must total 100%.");
    if(competencyBlueprint.length && weightTotal(competencyBlueprint)!==100) return toast("Competency blueprint weights must total 100%.");
    const data={
      ownerId:s.user.uid,
      sectionId:section.id,
      sectionName:section.sectionName,
      courseId:section.courseId,
      courseCode:section.courseCode,
      courseTitle:section.courseTitle,
      title:String(fd.get("title")).trim(),
      type,
      mode:type==="Oral Examination"?"oral":type==="Disputation"?"disputation":"written",
      status:existing?.status||"Draft",
      instructions:String(fd.get("instructions")||"").trim(),
      opensAt:toTimestamp(fd.get("opensAt")),
      closesAt:toTimestamp(fd.get("closesAt")),
      durationMinutes:Number(fd.get("durationMinutes")||0),
      anonymousGrading:form.elements.anonymousGrading.checked,
      backtracking:form.elements.backtracking.checked,
      randomizeQuestions:form.elements.randomizeQuestions.checked,
      feedbackPolicy:String(fd.get("feedbackPolicy")),
      contentBlueprint,
      competencyBlueprint,
      parts:existing?.parts?.length?existing.parts:defaultParts(type),
      totalPoints:existing?.totalPoints||0,
      questionCount:existing?.questionCount||0,
      updatedAt:serverTimestamp()
    };
    try{
      let id=existing?.id;
      if(existing) await updateDoc(doc(db,"assessments",id),data);
      else{
        const ref=await addDoc(collection(db,"assessments"),{...data,createdAt:serverTimestamp()});
        id=ref.id;
      }
      core().closeModal(); await loadAssessments(); await openAssessment(id); toast(existing?"Assessment updated.":"Assessment draft created.");
    }catch(error){toast(error.message||"Unable to save assessment.");}
  });
}

async function loadAssessmentDetail(id){
  const snap=await getDoc(doc(db,"assessments",id));
  if(!snap.exists()) throw new Error("Assessment not found.");
  const a={id:snap.id,...snap.data()};
  const questionsSnap=await getDocs(collection(db,"assessments",id,"questions"));
  const questions=questionsSnap.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>Number(x.order||99)-Number(y.order||99));
  let keys=[],submissions=[],results=[],members=[];
  if(state().role==="instructor"){
    const keySnap=await getDocs(collection(db,"assessments",id,"keys"));
    keys=keySnap.docs.map(d=>({id:d.id,...d.data()}));
    const subSnap=await getDocs(collection(db,"assessments",id,"submissions"));
    submissions=subSnap.docs.map(d=>({id:d.id,...d.data()}));
    const resultSnap=await getDocs(collection(db,"assessments",id,"results"));
    results=resultSnap.docs.map(d=>({id:d.id,...d.data()}));
    const memberSnap=await getDocs(collection(db,"sections",a.sectionId,"members"));
    members=memberSnap.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>String(x.displayName||"").localeCompare(String(y.displayName||"")));
  }
  return {assessment:a,questions,keys,submissions,results,members};
}

async function openAssessment(id,tab="overview"){
  try{
    p3.assessmentData=await loadAssessmentDetail(id);
    p3.currentAssessment=p3.assessmentData.assessment;
    renderAssessmentDetail(tab);
    core().setPage("assessment-detail",p3.currentAssessment.courseCode+" / "+p3.currentAssessment.title);
  }catch(error){toast(error.message||"Unable to open assessment.");}
}

function assessmentTabs(active){
  return '<div class="tabs">'+[["overview","Overview"],["items","Items"],["candidates","Candidates"],["grading","Grading"]].map(x=>'<button class="tab-btn '+(active===x[0]?'active':'')+'" data-phase3-action="assessment-tab" data-tab="'+x[0]+'">'+x[1]+'</button>').join("")+'</div>';
}

function renderAssessmentOverview(){
  const a=p3.currentAssessment;
  const contentTotal=weightTotal(a.contentBlueprint),compTotal=weightTotal(a.competencyBlueprint),partTotal=weightTotal(a.parts);
  const blueprint=(rows,title)=>'<div class="panel"><div class="panel-head"><div class="panel-title">'+title+'</div><span class="badge '+(weightTotal(rows)===100?'live':'gold')+'">'+weightTotal(rows)+'%</span></div><div class="panel-body">'+(rows?.length?rows.map(x=>'<div class="blueprint-row"><span>'+esc(x.label)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join(""):'<div class="empty-mini">No blueprint targets defined.</div>')+'</div></div>';
  return '<div class="section-summary"><div class="summary-block"><div class="summary-label">Status</div><div class="summary-value">'+esc(a.status)+'</div></div><div class="summary-block"><div class="summary-label">Items</div><div class="summary-value">'+esc(a.questionCount||0)+'</div></div><div class="summary-block"><div class="summary-label">Points</div><div class="summary-value">'+esc(a.totalPoints||0)+'</div></div><div class="summary-block"><div class="summary-label">Duration</div><div class="summary-value">'+esc(a.durationMinutes||0)+'m</div></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Administration</div></div><div class="panel-body"><div class="detail-list"><div><span>Opens</span><strong>'+esc(dt(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dt(a.closesAt))+'</strong></div><div><span>Anonymous grading</span><strong>'+(a.anonymousGrading!==false?"Enabled":"Disabled")+'</strong></div><div><span>Question backtracking</span><strong>'+(a.backtracking!==false?"Allowed":"Disabled")+'</strong></div></div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Examination Parts</div><span class="badge '+(partTotal===100?'live':'gold')+'">'+partTotal+'%</span></div><div class="panel-body">'+(a.parts||[]).map(x=>'<div class="blueprint-row"><span>'+esc(x.title)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join("")+'</div></div></div>'+
    '<div class="grid-2" style="margin-top:18px">'+blueprint(a.contentBlueprint,"Content Blueprint")+blueprint(a.competencyBlueprint,"Competency Blueprint")+'</div>'+
    ((contentTotal!==0&&contentTotal!==100)||(compTotal!==0&&compTotal!==100)||partTotal!==100?'<div class="notice" style="margin-top:18px">One or more blueprint groups do not total 100%. Correct them before publishing.</div>':'');
}

function renderAssessmentItems(){
  const a=p3.currentAssessment,q=p3.assessmentData.questions;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Assessment Assembly</div><p class="page-subtitle">Public question snapshots contain no answer key. Private keys remain instructor-only.</p></div><button class="primary-btn small-btn" data-phase3-action="add-assessment-items">Add from Item Bank</button></div>'+
    (q.length?'<div class="assessment-builder-list">'+q.map((x,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc((a.parts||[]).find(p=>p.id===x.partId)?.title||"Main")+' • '+esc(x.type)+'</div><h4>'+esc(x.prompt)+'</h4><div class="item-tags"><span>'+esc(x.points)+' pts</span><span>'+esc(x.topicNumber||"No topic")+'</span>'+(x.competencyCodes||[]).map(c=>'<span>'+esc(c)+'</span>').join("")+'</div></div><div class="inline-actions"><button class="text-btn" data-phase3-action="configure-assessment-item" data-id="'+x.id+'">Configure</button><button class="danger-btn" data-phase3-action="remove-assessment-item" data-id="'+x.id+'">Remove</button></div></div>').join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">I</div><h3>No items added yet.</h3><p>Select reusable questions from the Item Bank and assign them to examination sections.</p><button class="primary-btn" data-phase3-action="add-assessment-items">Add Items</button></div>');
}

function renderCandidates(){
  const d=p3.assessmentData,a=d.assessment;
  if(!d.members.length) return '<div class="empty-state"><div class="empty-symbol">C</div><h3>No enrolled candidates.</h3><p>Students must be enrolled in the section before examination records can be created.</p></div>';
  const subMap=new Map(d.submissions.map(x=>[x.studentId,x]));
  const resMap=new Map(d.results.map(x=>[x.studentId,x]));
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Release</th><th>Action</th></tr></thead><tbody>'+d.members.map(m=>{
    const sub=subMap.get(m.id),res=resMap.get(m.id);
    const name=a.anonymousGrading!==false?(sub?.candidateNumber||"Not assigned"):m.displayName;
    let action="";
    if(!sub && (a.mode==="oral"||a.mode==="disputation")) action='<button class="secondary-btn small-btn" data-phase3-action="create-oral-submission" data-student="'+m.id+'">Begin Evaluation</button>';
    else if(sub) action='<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>';
    return '<tr><td><strong>'+esc(name)+'</strong>'+(a.anonymousGrading!==false&&sub?'<span class="grade-sub">Identity hidden in grading views</span>':'')+'</td><td><span class="badge '+(sub?.status==="submitted"||sub?.status==="graded"?'gold':'')+'">'+esc(sub?.status||"Not started")+'</span></td><td>'+(res?'<strong>'+esc(res.percent)+'%</strong>':'—')+'</td><td>'+(res?'<button class="text-btn" data-phase3-action="toggle-result-release" data-student="'+m.id+'">'+(res.released?"Unrelease":"Release")+'</button>':'—')+'</td><td>'+action+'</td></tr>';
  }).join("")+'</tbody></table></div>';
}

function renderGrading(){
  const d=p3.assessmentData;
  const submitted=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded").length;
  const objective=d.questions.filter(x=>isObjective(x.type)).length;
  return '<div class="academic-banner"><div class="kicker">Secure Browser-Side Grading</div><h3>'+submitted+' submitted candidate'+(submitted===1?"":"s")+'</h3><p>Objective items are scored only in the instructor session because students never receive the answer-key collection.</p></div>'+
    '<div class="page-actions" style="margin-bottom:18px"><button class="primary-btn" data-phase3-action="auto-score-objective">Auto-score Objective Items</button></div>'+
    (d.questions.length?'<div class="assessment-builder-list">'+d.questions.map((q,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc(q.type)+'</div><h4>'+esc(q.prompt)+'</h4><div class="item-tags"><span>'+esc(q.points)+' pts</span>'+((q.competencyCodes||[]).map(c=>'<span>'+esc(c)+'</span>').join(""))+'</div></div><button class="secondary-btn small-btn" data-phase3-action="horizontal-grade" data-question="'+q.id+'">Grade Across Candidates</button></div>').join("")+'</div>':'<div class="empty-mini">Add assessment items before grading.</div>');
}

function renderAssessmentDetail(tab="overview"){
  const a=p3.currentAssessment;
  if(!a) return;
  let body=tab==="items"?renderAssessmentItems():tab==="candidates"?renderCandidates():tab==="grading"?renderGrading():renderAssessmentOverview();
  const statusAction=a.status==="Draft"?'<button class="primary-btn small-btn" data-phase3-action="publish-assessment">Publish</button>':a.status==="Published"?'<button class="secondary-btn small-btn" data-phase3-action="close-assessment">Close Assessment</button>':'<button class="secondary-btn small-btn" data-phase3-action="reopen-assessment">Reopen</button>';
  $("#assessmentDetail").innerHTML='<button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(a.courseCode||"Course")+' • '+esc(a.type)+'</div><h1 class="detail-title">'+esc(a.title)+'</h1><div class="detail-meta"><span>'+esc(a.sectionName||"")+'</span><span>'+esc(a.status)+'</span><span>'+esc(dt(a.opensAt))+'</span></div></div><div class="inline-actions"><button class="secondary-btn small-btn" data-phase3-action="edit-assessment">Edit</button>'+statusAction+'</div></div>'+(a.instructions?'<p class="page-subtitle" style="margin-top:16px">'+esc(a.instructions)+'</p>':'')+'</div>'+assessmentTabs(tab)+'<div>'+body+'</div>';
}

async function openAddItemsModal(){
  await loadItems();
  const a=p3.currentAssessment;
  const available=p3.items.filter(x=>x.courseId===a.courseId && !p3.assessmentData.questions.some(q=>q.itemId===x.id));
  if(!available.length) return toast("No unused Item Bank questions are available for this course.");
  const partOptions=(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("");
  const modal=core().openModal({
    eyebrow:"Assessment Assembly",
    title:"Add Items from Item Bank",
    wide:true,
    body:'<form id="p3AddItemsForm"><div class="field"><label>Place selected items in</label><select name="partId">'+partOptions+'</select></div><div class="item-select-list">'+available.map(x=>'<label class="item-select-row"><input type="checkbox" name="item" value="'+x.id+'"><div><strong>'+esc(x.type)+' • '+esc(x.topicNumber||"No topic")+'</strong><p>'+esc(x.prompt)+'</p><span>'+esc(x.pointsDefault||1)+' pts • '+esc(x.difficulty||"Moderate")+'</span></div></label>').join("")+'</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Add Selected Items</button></div></form>'
  });
  modal.querySelector("#p3AddItemsForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget),ids=fd.getAll("item");
    if(!ids.length) return toast("Select at least one item.");
    const partId=String(fd.get("partId"));
    const batch=writeBatch(db);
    let order=p3.assessmentData.questions.length,total=Number(a.totalPoints||0);
    for(const id of ids){
      const item=available.find(x=>x.id===id); if(!item) continue;
      const qref=doc(collection(db,"assessments",a.id,"questions"));
      order++; total+=Number(item.pointsDefault||1);
      batch.set(qref,{
        itemId:item.id,order,partId,type:item.type,prompt:item.prompt,stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",
        options:item.options||[],points:Number(item.pointsDefault||1),topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
        competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()
      });
      batch.set(doc(db,"assessments",a.id,"keys",qref.id),{
        itemId:item.id,correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()
      });
    }
    batch.update(doc(db,"assessments",a.id),{questionCount:order,totalPoints:total,updatedAt:serverTimestamp()});
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"items");toast("Items added to assessment.");}
    catch(error){toast(error.message||"Unable to add items.");}
  });
}

async function configureAssessmentItem(id){
  const q=p3.assessmentData.questions.find(x=>x.id===id); if(!q)return;
  const a=p3.currentAssessment;
  const modal=core().openModal({
    eyebrow:"Assessment Item",
    title:"Configure Item",
    body:'<form id="p3ConfigItem"><div class="field"><label>Examination Part</label><select name="partId">'+(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("")+'</select></div><div class="field"><label>Points</label><input type="number" min="0" step="0.5" name="points" value="'+esc(q.points)+'"></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save</button></div></form>'
  });
  const form=modal.querySelector("#p3ConfigItem");form.partId.value=q.partId||a.parts?.[0]?.id;
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form),newPoints=Number(fd.get("points")||0),delta=newPoints-Number(q.points||0);
    try{
      const batch=writeBatch(db);
      batch.update(doc(db,"assessments",a.id,"questions",q.id),{partId:String(fd.get("partId")),points:newPoints,updatedAt:serverTimestamp()});
      batch.update(doc(db,"assessments",a.id),{totalPoints:Number(a.totalPoints||0)+delta,updatedAt:serverTimestamp()});
      await batch.commit();core().closeModal();await openAssessment(a.id,"items");toast("Item configuration updated.");
    }catch(error){toast(error.message||"Unable to update item.");}
  });
}

async function removeAssessmentItem(id){
  const q=p3.assessmentData.questions.find(x=>x.id===id);if(!q)return;
  if(!confirm("Remove this item from the assessment? The Item Bank copy will remain."))return;
  const a=p3.currentAssessment,batch=writeBatch(db);
  batch.delete(doc(db,"assessments",a.id,"questions",id));
  batch.delete(doc(db,"assessments",a.id,"keys",id));
  batch.update(doc(db,"assessments",a.id),{questionCount:Math.max(0,Number(a.questionCount||1)-1),totalPoints:Math.max(0,Number(a.totalPoints||0)-Number(q.points||0)),updatedAt:serverTimestamp()});
  try{await batch.commit();await openAssessment(a.id,"items");toast("Item removed.");}catch(error){toast(error.message||"Unable to remove item.");}
}

async function setAssessmentStatus(status){
  const a=p3.currentAssessment;
  if(status==="Published" && !p3.assessmentData.questions.length && !["Oral Examination","Disputation"].includes(a.type)) return toast("Add at least one item before publishing.");
  if(status==="Published" && weightTotal(a.parts)!==100) return toast("Examination parts must total 100% before publishing.");
  const batch=writeBatch(db);
  batch.update(doc(db,"assessments",a.id),{status,updatedAt:serverTimestamp()});
  if(status==="Draft") batch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
  else batch.set(doc(db,"sections",a.sectionId,"assessmentRefs",a.id),{assessmentId:a.id,title:a.title,type:a.type,status,opensAt:a.opensAt||null,closesAt:a.closesAt||null,durationMinutes:a.durationMinutes||0,updatedAt:serverTimestamp()},{merge:true});
  try{await batch.commit();await openAssessment(a.id,"overview");await renderAssessments();toast("Assessment status: "+status+".");}catch(error){toast(error.message||"Unable to update status.");}
}

async function renderSectionAssessments(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  let list=[];
  if(s.role==="instructor"){
    const snap=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
    list=snap.docs.map(d=>({id:d.id,...d.data()}));
  }else{
    const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
    for(const r of refs.docs){try{const x=await getDoc(doc(db,"assessments",r.id));if(x.exists())list.push({id:x.id,...x.data()});}catch(e){}}
  }
  el.innerHTML=list.length?'<div class="assessment-grid">'+list.map(a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(availabilityLabel(a))+' • '+esc(a.durationMinutes||0)+' minutes</p><div class="card-actions">'+(s.role==="instructor"?'<button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button>':availabilityLabel(a)==="Open"?'<button class="primary-btn small-btn" data-phase3-action="start-assessment" data-id="'+a.id+'">Open Assessment</button>':'<span class="badge">'+esc(availabilityLabel(a))+'</span>')+'</div></article>').join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">A</div><h3>No section assessments yet.</h3><p>'+(s.role==="instructor"?"Create one from the main Assessments workspace.":"Published examinations and evaluations will appear here.")+'</p></div>';
}

async function renderGradingPolicy(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const fresh=await getDoc(doc(db,"sections",section.id));const data=fresh.exists()?fresh.data():section;
  const p=data.gradingPolicy||{
    selectionOpen:true,selectionDeadline:null,
    examination:{semester:35,comprehensive:65},
    composite:{coursework:60,semester:15,comprehensive:25}
  };
  const paths=await getDocs(collection(db,"sections",section.id,"gradingPathways"));
  const selections=paths.docs.map(d=>({id:d.id,...d.data()}));
  el.innerHTML='<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Grading Pathway Policy</div></div><div class="panel-body"><form id="gradingPolicyForm"><div class="field"><label>Selection Deadline</label><input type="datetime-local" name="deadline" value="'+esc(localValue(p.selectionDeadline))+'"></div><label class="checkbox-line" style="margin-bottom:18px"><input type="checkbox" name="selectionOpen" '+(p.selectionOpen!==false?'checked':'')+'> Students may select/change pathways</label><div class="path-policy"><h4>Examination Pathway</h4><div class="form-grid"><div class="field"><label>Semester I Exam %</label><input type="number" name="examSemester" value="'+esc(p.examination?.semester??35)+'"></div><div class="field"><label>Comprehensive Final %</label><input type="number" name="examFinal" value="'+esc(p.examination?.comprehensive??65)+'"></div></div></div><div class="path-policy"><h4>Composite Pathway</h4><div class="form-grid"><div class="field"><label>Coursework %</label><input type="number" name="compCoursework" value="'+esc(p.composite?.coursework??60)+'"></div><div class="field"><label>Semester I Exam %</label><input type="number" name="compSemester" value="'+esc(p.composite?.semester??15)+'"></div><div class="field"><label>Comprehensive Final %</label><input type="number" name="compFinal" value="'+esc(p.composite?.comprehensive??25)+'"></div></div></div><button class="primary-btn" type="submit">Save Grading Policy</button></form></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Student Selections</div></div><div class="panel-body">'+(selections.length?selections.map(x=>'<div class="selection-row"><div><strong>'+esc(x.studentName||x.studentId)+'</strong><span>'+esc(x.pathway==="examination"?"Examination Pathway":"Composite Pathway")+'</span></div><span class="badge '+(x.pathway==="examination"?'gold':'live')+'">'+esc(x.pathway)+'</span></div>').join(""):'<div class="empty-mini">No students have selected a pathway yet.</div>')+'</div></div></div>';
  $("#gradingPolicyForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const exam={semester:Number(fd.get("examSemester")),comprehensive:Number(fd.get("examFinal"))};
    const composite={coursework:Number(fd.get("compCoursework")),semester:Number(fd.get("compSemester")),comprehensive:Number(fd.get("compFinal"))};
    if(exam.semester+exam.comprehensive!==100)return toast("Examination Pathway weights must total 100%.");
    if(composite.coursework+composite.semester+composite.comprehensive!==100)return toast("Composite Pathway weights must total 100%.");
    const policy={selectionOpen:e.currentTarget.elements.selectionOpen.checked,selectionDeadline:toTimestamp(fd.get("deadline")),examination:exam,composite,updatedAt:serverTimestamp()};
    try{await updateDoc(doc(db,"sections",section.id),{gradingPolicy:policy,updatedAt:serverTimestamp()});section.gradingPolicy=policy;toast("Grading pathway policy saved.");await renderGradingPolicy();}catch(error){toast(error.message||"Unable to save policy.");}
  });
}

async function renderStudentPathway(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const fresh=await getDoc(doc(db,"sections",section.id));const sec=fresh.exists()?fresh.data():section;
  const p=sec.gradingPolicy;
  if(!p){el.innerHTML='<div class="empty-state"><div class="empty-symbol">G</div><h3>Grading pathway selection is not open yet.</h3><p>Your instructor has not published the course grading-pathway policy.</p></div>';return;}
  let selection=null;try{const x=await getDoc(doc(db,"sections",section.id,"gradingPathways",s.user.uid));if(x.exists())selection=x.data();}catch(e){}
  const deadline=p.selectionDeadline?.toDate?.();const open=p.selectionOpen!==false && (!deadline || deadline.getTime()>=Date.now());
  const exam=p.examination||{semester:35,comprehensive:65},comp=p.composite||{coursework:60,semester:15,comprehensive:25};
  el.innerHTML='<div class="academic-banner"><div class="kicker">Final Grade Method</div><h3>'+(selection?"Your current selection: "+(selection.pathway==="examination"?"Examination Pathway":"Composite Pathway"):"Choose how your final course grade will be calculated.")+'</h3><p>Coursework continues to be graded throughout the course under either pathway. Selection deadline: '+esc(dt(p.selectionDeadline))+'</p></div><div class="pathway-grid"><label class="pathway-card '+(selection?.pathway==="examination"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="examination" '+(selection?.pathway==="examination"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">A</div><div><h3>Examination Pathway</h3><p>Your certified final grade is based entirely on cumulative examination performance.</p><div class="formula-row"><span>Semester I Examination</span><strong>'+exam.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+exam.comprehensive+'%</strong></div><small>Coursework remains graded and visible as academic progress evidence.</small></div></label><label class="pathway-card '+(selection?.pathway==="composite"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="composite" '+(selection?.pathway==="composite"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">B</div><div><h3>Composite Pathway</h3><p>Your certified final grade reflects sustained coursework and cumulative examinations.</p><div class="formula-row"><span>Coursework</span><strong>'+comp.coursework+'%</strong></div><div class="formula-row"><span>Semester I Examination</span><strong>'+comp.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+comp.comprehensive+'%</strong></div></div></label></div>'+(open?'<div class="pathway-confirm"><label class="checkbox-line"><input id="pathwayAck" type="checkbox"> I understand that this choice controls how my final course grade will be calculated and may be changed only while the selection period remains open.</label><button class="primary-btn" data-phase3-action="save-pathway">Confirm Selection</button></div>':'<div class="notice">The pathway selection period is closed. Contact your instructor if an exceptional change is required.</div>');
}

async function savePathway(){
  const s=state(),section=s.currentSection;
  const choice=document.querySelector('input[name="pathwayChoice"]:checked')?.value;
  if(!choice)return toast("Choose a grading pathway.");
  if(!$("#pathwayAck")?.checked)return toast("Acknowledge the grading pathway policy before confirming.");
  try{
    await setDoc(doc(db,"sections",section.id,"gradingPathways",s.user.uid),{studentId:s.user.uid,studentName:s.profile.displayName||s.user.displayName||"Student",pathway:choice,acknowledgement:true,selectedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
    toast("Grading pathway confirmed.");await renderStudentPathway();
  }catch(error){toast(error.message||"The selection period may be closed.");}
}

async function openAccommodations(studentId){
  const s=state(),section=s.currentSection,member=s.sectionData?.members?.find(x=>x.id===studentId);if(!member)return;
  const a=member.accommodations||{};
  const modal=core().openModal({
    eyebrow:"Assessment Access",
    title:(member.displayName||"Student")+" — Accommodations",
    body:'<form id="accommodationForm"><div class="field"><label>Time Multiplier</label><select name="timeMultiplier"><option value="1">Standard time (1.0×)</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></div><label class="checkbox-line"><input type="checkbox" name="breaks" '+(a.breaks?'checked':'')+'> Breaks permitted</label><label class="checkbox-line"><input type="checkbox" name="calculator" '+(a.calculator?'checked':'')+'> Calculator permitted</label><label class="checkbox-line"><input type="checkbox" name="largeText" '+(a.largeText?'checked':'')+'> Large-text examination interface</label><label class="checkbox-line"><input type="checkbox" name="reducedDistractions" '+(a.reducedDistractions?'checked':'')+'> Reduced-distraction setting</label><div class="field" style="margin-top:16px"><label>Instructor Notes</label><textarea name="notes">'+esc(a.notes||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Accommodations</button></div></form>'
  });
  const form=modal.querySelector("#accommodationForm");form.timeMultiplier.value=String(a.timeMultiplier||1);
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form);
    const accommodations={timeMultiplier:Number(fd.get("timeMultiplier")||1),breaks:form.elements.breaks.checked,calculator:form.elements.calculator.checked,largeText:form.elements.largeText.checked,reducedDistractions:form.elements.reducedDistractions.checked,notes:String(fd.get("notes")||"").trim()};
    try{await updateDoc(doc(db,"sections",section.id,"members",studentId),{accommodations,updatedAt:serverTimestamp()});core().closeModal();await core().reloadCurrentSection("students");toast("Assessment accommodations saved.");}catch(error){toast(error.message||"Unable to save accommodations.");}
  });
}

async function startAssessment(id){
  const s=state();
  try{
    const snap=await getDoc(doc(db,"assessments",id));if(!snap.exists())return toast("Assessment not found.");
    const a={id:snap.id,...snap.data()};
    let subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));
    let submission=subSnap.exists()?{id:subSnap.id,...subSnap.data()}:null;
    if(submission && submission.status!=="in_progress") return showReceipt(id);
    const qSnap=await getDocs(collection(db,"assessments",id,"questions"));
    let questions=qSnap.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>Number(x.order||99)-Number(y.order||99));
    if(!questions.length && !["oral","disputation"].includes(a.mode)) return toast("This assessment does not contain any questions.");
    const memberSnap=await getDoc(doc(db,"sections",a.sectionId,"members",s.user.uid));
    const accommodations=memberSnap.exists()?(memberSnap.data().accommodations||{}):{};
    if(!submission){
      let order=questions.map(q=>q.id);
      if(a.randomizeQuestions) order=order.map(v=>({v,r:Math.random()})).sort((x,y)=>x.r-y.r).map(x=>x.v);
      await setDoc(doc(db,"assessments",id,"submissions",s.user.uid),{
        studentId:s.user.uid,candidateNumber:candidateNumber(),status:"in_progress",startedAt:serverTimestamp(),updatedAt:serverTimestamp(),
        answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:order,
        accommodationsApplied:{timeMultiplier:Number(accommodations.timeMultiplier||1),breaks:!!accommodations.breaks,calculator:!!accommodations.calculator,largeText:!!accommodations.largeText,reducedDistractions:!!accommodations.reducedDistractions}
      });
      subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));submission={id:subSnap.id,...subSnap.data()};
    }
    const order=submission.questionOrder||questions.map(q=>q.id);
    questions=order.map(id=>questions.find(q=>q.id===id)).filter(Boolean);
    launchExam(a,questions,submission);
  }catch(error){toast(error.message||"This assessment is not available right now.");}
}

function launchExam(assessment,questions,submission){
  clearInterval(p3.timer);p3.exam={assessment,questions,submission,index:Number(submission.currentIndex||0),answers:{...(submission.answers||{})},marked:[...(submission.marked||[])],saving:false};
  core().setPage("exam",assessment.title);
  const root=$("#examRoot");root.classList.toggle("large-text-exam",!!submission.accommodationsApplied?.largeText);
  renderExam();
  const started=submission.startedAt?.toMillis?.()||Date.now(),duration=Math.round(Number(assessment.durationMinutes||0)*Number(submission.accommodationsApplied?.timeMultiplier||1)*60);
  const tick=()=>{
    if(!p3.exam)return;
    const elapsed=Math.floor((Date.now()-started)/1000),remaining=Math.max(0,duration-elapsed);
    const t=$("#examTimer");if(t)t.textContent=duration?formatClock(remaining):"Untimed";
    if(duration && remaining<=0){clearInterval(p3.timer);submitExam(true);}
  };
  tick();p3.timer=setInterval(tick,1000);
  document.addEventListener("visibilitychange",examVisibilityHandler);
  window.addEventListener("beforeunload",examUnloadHandler);
}

function formatClock(sec){
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return (h?h+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}

function examVisibilityHandler(){
  if(!p3.exam || document.visibilityState!=="hidden")return;
  logExamEvent("visibility_hidden");
}

function examUnloadHandler(e){
  if(!p3.exam)return;
  e.preventDefault();e.returnValue="";
}

async function logExamEvent(type){
  try{
    const ex=p3.exam,s=state();
    await addDoc(collection(db,"assessments",ex.assessment.id,"submissions",s.user.uid,"events"),{studentId:s.user.uid,type,at:serverTimestamp()});
  }catch(e){}
}

function renderExam(){
  const ex=p3.exam;if(!ex)return;
  const a=ex.assessment,q=ex.questions[ex.index],root=$("#examRoot");
  if(!q){root.innerHTML='<div class="empty-state"><h3>No question available.</h3></div>';return;}
  const marked=ex.marked.includes(q.id),answer=ex.answers[q.id];
  const navigator=ex.questions.map((x,i)=>'<button class="exam-nav-item '+(i===ex.index?'active':'')+' '+(ex.answers[x.id]!==undefined&&String(ex.answers[x.id]).length?'answered':'')+' '+(ex.marked.includes(x.id)?'marked':'')+'" data-phase3-action="exam-jump" data-index="'+i+'">'+(i+1)+'</button>').join("");
  let response="";
  if(q.type==="Multiple Choice") response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(answer===o.id?'selected':'')+'"><input type="radio" name="examAnswer" value="'+esc(o.id)+'" '+(answer===o.id?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';
  else if(q.type==="Multiple Select"){const arr=Array.isArray(answer)?answer:[];response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(arr.includes(o.id)?'selected':'')+'"><input type="checkbox" name="examAnswerMulti" value="'+esc(o.id)+'" '+(arr.includes(o.id)?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';}
  else response='<textarea id="writtenExamAnswer" class="exam-response" placeholder="Enter your response here…">'+esc(answer||"")+'</textarea>';
  root.innerHTML='<div class="exam-shell"><header class="exam-header"><div><div class="exam-brand">Θ THEORIA</div><div class="exam-title">'+esc(a.title)+'</div></div><div class="exam-candidate">Candidate <strong>'+esc(ex.submission.candidateNumber)+'</strong></div><div id="examTimer" class="exam-timer">--:--</div></header><div class="exam-body"><aside class="exam-sidebar"><div class="exam-progress">Question '+(ex.index+1)+' of '+ex.questions.length+'</div><div class="exam-navigator">'+navigator+'</div><div class="exam-legend"><span>● Answered</span><span>◆ Marked</span></div>'+(ex.submission.accommodationsApplied?.calculator?'<button class="secondary-btn small-btn full-btn" data-phase3-action="calculator">Calculator</button>':'')+'<button class="danger-btn full-btn" data-phase3-action="submit-exam">Submit Assessment</button></aside><main class="exam-question"><div class="exam-question-meta"><span>'+esc((a.parts||[]).find(p=>p.id===q.partId)?.title||"Assessment")+'</span><span>'+esc(q.points)+' points</span></div>'+(q.sourceTitle?'<div class="source-title">'+esc(q.sourceTitle)+'</div>':'')+(q.stimulus?'<div class="exam-stimulus">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<h2>'+esc(q.prompt)+'</h2>'+response+'<div class="exam-controls"><button class="secondary-btn" data-phase3-action="mark-question">'+(marked?"Unmark":"Mark for Review")+'</button><div><button class="secondary-btn" data-phase3-action="exam-prev" '+(ex.index===0?'disabled':'')+'>Previous</button><button class="primary-btn" data-phase3-action="exam-next">'+(ex.index===ex.questions.length-1?"Review":"Next")+'</button></div></div></main></div></div>';
  bindExamInputs();
}

function bindExamInputs(){
  const ex=p3.exam,q=ex.questions[ex.index];if(!q)return;
  document.querySelectorAll('input[name="examAnswer"]').forEach(x=>x.addEventListener("change",()=>{ex.answers[q.id]=x.value;scheduleExamSave();renderExam();}));
  document.querySelectorAll('input[name="examAnswerMulti"]').forEach(x=>x.addEventListener("change",()=>{ex.answers[q.id]=Array.from(document.querySelectorAll('input[name="examAnswerMulti"]:checked')).map(c=>c.value);scheduleExamSave();renderExam();}));
  const text=$("#writtenExamAnswer");if(text)text.addEventListener("input",()=>{ex.answers[q.id]=text.value;scheduleExamSave();});
}

function scheduleExamSave(){
  clearTimeout(p3.autosave);p3.autosave=setTimeout(saveExamProgress,500);
}

async function saveExamProgress(){
  const ex=p3.exam;if(!ex)return;
  try{await updateDoc(doc(db,"assessments",ex.assessment.id,"submissions",state().user.uid),{answers:ex.answers,marked:ex.marked,currentIndex:ex.index,updatedAt:serverTimestamp()});}catch(e){}
}

async function submitExam(auto=false){
  const ex=p3.exam;if(!ex)return;
  if(!auto && !confirm("Submit this assessment? You will not be able to change your responses afterward."))return;
  await saveExamProgress();
  try{
    await updateDoc(doc(db,"assessments",ex.assessment.id,"submissions",state().user.uid),{answers:ex.answers,marked:ex.marked,currentIndex:ex.index,status:"submitted",submittedAt:serverTimestamp(),updatedAt:serverTimestamp()});
    clearInterval(p3.timer);document.removeEventListener("visibilitychange",examVisibilityHandler);window.removeEventListener("beforeunload",examUnloadHandler);
    const id=ex.assessment.id;p3.exam=null;showReceipt(id,auto);
  }catch(error){toast(error.message||"Unable to submit assessment.");}
}

async function showReceipt(id,auto=false){
  try{
    const a=await getDoc(doc(db,"assessments",id));const sub=await getDoc(doc(db,"assessments",id,"submissions",state().user.uid));
    let result=null;try{const r=await getDoc(doc(db,"assessments",id,"results",state().user.uid));if(r.exists())result=r.data();}catch(e){}
    const assessment=a.exists()?a.data():{},submission=sub.exists()?sub.data():{};
    core().setPage("exam",assessment.title||"Submission Receipt");
    $("#examRoot").innerHTML='<div class="receipt-shell"><div class="receipt-mark">Θ</div><div class="eyebrow">Examination Receipt</div><h1>'+esc(assessment.title||"Assessment")+'</h1><p>Your response has been recorded'+(auto?" automatically when time expired":"")+'.</p><div class="receipt-grid"><div><span>Candidate Number</span><strong>'+esc(submission.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>'+esc(submission.status||"submitted")+'</strong></div><div><span>Submitted</span><strong>'+esc(dt(submission.submittedAt))+'</strong></div><div><span>Result</span><strong>'+(result?esc(result.percent)+"%":"Awaiting evaluation")+'</strong></div></div><button class="primary-btn" data-phase3-action="back-assessments">Return to Assessments</button></div>';
  }catch(error){toast("Unable to load submission receipt.");}
}

function openCalculator(){
  const modal=core().openModal({eyebrow:"Assessment Tool",title:"Calculator",body:'<div class="field"><label>Expression</label><input id="calcExpr" placeholder="(12 * 4) / 3"></div><div id="calcResult" class="calculator-result">0</div><button id="calcRun" class="primary-btn">Calculate</button>'});
  modal.querySelector("#calcRun").addEventListener("click",()=>{
    const expr=modal.querySelector("#calcExpr").value;
    if(!/^[0-9+\-*/(). %]+$/.test(expr))return modal.querySelector("#calcResult").textContent="Invalid expression";
    try{modal.querySelector("#calcResult").textContent=String(Function('"use strict";return ('+expr+')')());}catch(e){modal.querySelector("#calcResult").textContent="Invalid expression";}
  });
}

async function createOralSubmission(studentId){
  const a=p3.currentAssessment;
  try{
    await setDoc(doc(db,"assessments",a.id,"submissions",studentId),{studentId,candidateNumber:candidateNumber(),status:"submitted",startedAt:serverTimestamp(),submittedAt:serverTimestamp(),updatedAt:serverTimestamp(),answers:{},marked:[],currentIndex:0,elapsedSeconds:0,accommodationsApplied:{}},{merge:true});
    await openAssessment(a.id,"candidates");toast("Candidate evaluation record created.");
  }catch(error){toast(error.message||"Unable to create evaluation.");}
}

function objectiveScore(question,key,answer){
  return answersEqual(answer,key?.correctAnswer,question.type)?Number(question.points||0):0;
}

async function gradeCandidate(studentId){
  const d=p3.assessmentData,a=d.assessment,sub=d.submissions.find(x=>x.studentId===studentId);if(!sub)return;
  const existing=d.results.find(x=>x.studentId===studentId);
  const keyMap=new Map(d.keys.map(x=>[x.id,x]));
  const grading=existing?.grading||{};
  const modal=core().openModal({
    eyebrow:"Candidate Evaluation",
    title:(a.anonymousGrading!==false?sub.candidateNumber:(d.members.find(x=>x.id===studentId)?.displayName||"Candidate")),
    wide:true,
    body:'<form id="candidateGradeForm"><div class="grading-stack">'+d.questions.map((q,i)=>{
      const key=keyMap.get(q.id),obj=isObjective(q.type),current=grading[q.id]?.score;
      const suggested=obj?objectiveScore(q,key,sub.answers?.[q.id]):(current??"");
      return '<section class="grading-question"><div class="grading-question-head"><span>Question '+(i+1)+' • '+esc(q.type)+'</span><strong>'+esc(q.points)+' pts</strong></div><h4>'+esc(q.prompt)+'</h4>'+(q.stimulus?'<div class="grading-source">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<div class="candidate-response"><span>Candidate response</span><p>'+esc(Array.isArray(sub.answers?.[q.id])?sub.answers[q.id].join(", "):(sub.answers?.[q.id]||"(No written response recorded)"))+'</p></div>'+(obj?'<div class="answer-key"><span>Answer key</span><strong>'+esc(Array.isArray(key?.correctAnswer)?key.correctAnswer.join(", "):(key?.correctAnswer||"—"))+'</strong></div>':'')+((key?.rubric||[]).length?'<div class="rubric-display">'+key.rubric.map(r=>'<div><span>'+esc(r.criterion)+'</span><strong>'+esc(r.points)+' pts</strong></div>').join("")+'</div>':'')+'<div class="form-grid"><div class="field"><label>Score</label><input type="number" min="0" max="'+esc(q.points)+'" step="0.5" name="score_'+q.id+'" value="'+esc(suggested)+'" required></div><div class="field"><label>Feedback</label><input name="comment_'+q.id+'" value="'+esc(grading[q.id]?.comment||"")+'"></div></div></section>';
    }).join("")+'</div><div class="field"><label>Overall Instructor Comment</label><textarea name="overallComment">'+esc(existing?.overallComment||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Evaluation</button></div></form>'
  });
  modal.querySelector("#candidateGradeForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),newGrading={};let total=0;const partRaw={};
    d.questions.forEach(q=>{const score=Number(fd.get("score_"+q.id)||0);newGrading[q.id]={score,comment:String(fd.get("comment_"+q.id)||"").trim()};total+=score;partRaw[q.partId]=(partRaw[q.partId]||0)+score;});
    const max=Number(a.totalPoints||d.questions.reduce((n,q)=>n+Number(q.points||0),0)),percent=max?Math.round(total/max*1000)/10:0;
    const partScores={};(a.parts||[]).forEach(part=>{const qs=d.questions.filter(q=>q.partId===part.id),pm=qs.reduce((n,q)=>n+Number(q.points||0),0);partScores[part.id]={title:part.title,score:partRaw[part.id]||0,max:pm,percent:pm?Math.round((partRaw[part.id]||0)/pm*1000)/10:0};});
    const released=existing?.released||false;
    const batch=writeBatch(db);
    batch.set(doc(db,"assessments",a.id,"results",studentId),{studentId,candidateNumber:sub.candidateNumber,totalScore:total,maxScore:max,percent,grading:newGrading,partScores,overallComment:String(fd.get("overallComment")||"").trim(),released,gradedAt:serverTimestamp(),gradedBy:state().user.uid},{merge:true});
    batch.update(doc(db,"assessments",a.id,"submissions",studentId),{status:"graded",updatedAt:serverTimestamp()});
    batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+studentId),{assessmentId:a.id,assessmentTitle:a.title,assessmentType:a.type,studentId,score:total,maxScore:max,percent,released,updatedAt:serverTimestamp()},{merge:true});
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"candidates");toast("Candidate evaluation saved.");}catch(error){toast(error.message||"Unable to save evaluation.");}
  });
}

async function toggleResultRelease(studentId){
  const d=p3.assessmentData,a=d.assessment,r=d.results.find(x=>x.studentId===studentId);if(!r)return;
  const released=!r.released,batch=writeBatch(db);
  batch.update(doc(db,"assessments",a.id,"results",studentId),{released,updatedAt:serverTimestamp()});
  batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+studentId),{released,updatedAt:serverTimestamp()},{merge:true});
  try{await batch.commit();await openAssessment(a.id,"candidates");toast(released?"Result released to student.":"Result returned to private status.");}catch(error){toast(error.message||"Unable to update release.");}
}

async function autoScoreObjective(){
  const d=p3.assessmentData,a=d.assessment,keyMap=new Map(d.keys.map(x=>[x.id,x])),resultMap=new Map(d.results.map(x=>[x.studentId,x]));
  const objective=d.questions.filter(q=>isObjective(q.type));if(!objective.length)return toast("This assessment has no objective items.");
  const submissions=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded");if(!submissions.length)return toast("No submitted candidates to score.");
  for(const sub of submissions){
    const existing=resultMap.get(sub.studentId),grading={...(existing?.grading||{})};
    objective.forEach(q=>grading[q.id]={score:objectiveScore(q,keyMap.get(q.id),sub.answers?.[q.id]),comment:grading[q.id]?.comment||""});
    const total=Object.values(grading).reduce((n,x)=>n+Number(x.score||0),0),max=Number(a.totalPoints||0),complete=Object.keys(grading).length===d.questions.length;
    await setDoc(doc(db,"assessments",a.id,"results",sub.studentId),{studentId:sub.studentId,candidateNumber:sub.candidateNumber,totalScore:total,maxScore:max,percent:max?Math.round(total/max*1000)/10:0,grading,released:existing?.released||false,complete,gradedAt:serverTimestamp(),gradedBy:state().user.uid},{merge:true});
  }
  await openAssessment(a.id,"grading");toast("Objective items scored securely in the instructor session.");
}

async function horizontalGrade(questionId){
  const d=p3.assessmentData,a=d.assessment,q=d.questions.find(x=>x.id===questionId),key=d.keys.find(x=>x.id===questionId);if(!q)return;
  const submissions=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded");
  if(!submissions.length)return toast("No submitted candidates.");
  const resultMap=new Map(d.results.map(x=>[x.studentId,x]));
  const modal=core().openModal({
    eyebrow:"Horizontal Grading",
    title:"Grade Question "+(d.questions.findIndex(x=>x.id===q.id)+1)+" Across Candidates",
    wide:true,
    body:'<form id="horizontalGradeForm"><div class="notice">'+esc(q.prompt)+'</div><div class="horizontal-grade-list">'+submissions.map(sub=>{const r=resultMap.get(sub.studentId),score=r?.grading?.[q.id]?.score;return '<div class="horizontal-grade-row"><div><strong>'+esc(a.anonymousGrading!==false?sub.candidateNumber:(d.members.find(m=>m.id===sub.studentId)?.displayName||sub.studentId))+'</strong><p>'+esc(Array.isArray(sub.answers?.[q.id])?sub.answers[q.id].join(", "):(sub.answers?.[q.id]||"(No response)"))+'</p></div><div class="field"><label>Score / '+esc(q.points)+'</label><input type="number" min="0" max="'+esc(q.points)+'" step="0.5" name="score_'+sub.studentId+'" value="'+esc(score??(isObjective(q.type)?objectiveScore(q,key,sub.answers?.[q.id]):""))+'" required></div></div>';}).join("")+'</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Horizontal Grades</button></div></form>'
  });
  modal.querySelector("#horizontalGradeForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    for(const sub of submissions){
      const existing=resultMap.get(sub.studentId),grading={...(existing?.grading||{})};grading[q.id]={score:Number(fd.get("score_"+sub.studentId)||0),comment:grading[q.id]?.comment||""};
      const total=Object.values(grading).reduce((n,x)=>n+Number(x.score||0),0),max=Number(a.totalPoints||0),complete=Object.keys(grading).length===d.questions.length;
      await setDoc(doc(db,"assessments",a.id,"results",sub.studentId),{studentId:sub.studentId,candidateNumber:sub.candidateNumber,totalScore:total,maxScore:max,percent:max?Math.round(total/max*1000)/10:0,grading,released:existing?.released||false,complete,gradedAt:serverTimestamp(),gradedBy:state().user.uid},{merge:true});
    }
    core().closeModal();await openAssessment(a.id,"grading");toast("Horizontal grading saved.");
  });
}

async function renderSectionTab(tab){
  if(tab==="examinations") return renderSectionAssessments();
  if(tab==="grading") return renderGradingPolicy();
  if(tab==="pathway") return renderStudentPathway();
}

function bindStaticButtons(){
  if(p3.booted)return;p3.booted=true;
  $("#createItemBtn")?.addEventListener("click",()=>openItemModal());
  $("#createAssessmentBtn")?.addEventListener("click",()=>openAssessmentModal());
}

async function onReady(){
  bindStaticButtons();
  if($("#page-itembank")?.classList.contains("active")) await renderItemBank();
  if($("#page-assessments")?.classList.contains("active")) await renderAssessments();
}

window.addEventListener("theoria:ready",onReady);
window.addEventListener("theoria:page",async e=>{
  if(e.detail.page==="itembank") await renderItemBank();
  if(e.detail.page==="assessments") await renderAssessments();
});

document.addEventListener("click",async e=>{
  const btn=e.target.closest("[data-phase3-action]");if(!btn)return;
  const a=btn.dataset.phase3Action;
  if(a==="create-assessment")return openAssessmentModal();
  if(a==="edit-item"){const item=p3.items.find(x=>x.id===btn.dataset.id&&x.courseId===btn.dataset.course);return openItemModal(item);}
  if(a==="open-assessment")return openAssessment(btn.dataset.id);
  if(a==="back-assessments"){clearInterval(p3.timer);p3.exam=null;core().setPage("assessments");return renderAssessments();}
  if(a==="assessment-tab")return renderAssessmentDetail(btn.dataset.tab);
  if(a==="edit-assessment")return openAssessmentModal(p3.currentAssessment);
  if(a==="add-assessment-items")return openAddItemsModal();
  if(a==="configure-assessment-item")return configureAssessmentItem(btn.dataset.id);
  if(a==="remove-assessment-item")return removeAssessmentItem(btn.dataset.id);
  if(a==="publish-assessment")return setAssessmentStatus("Published");
  if(a==="close-assessment")return setAssessmentStatus("Closed");
  if(a==="reopen-assessment")return setAssessmentStatus("Published");
  if(a==="start-assessment")return startAssessment(btn.dataset.id);
  if(a==="view-receipt")return showReceipt(btn.dataset.id);
  if(a==="save-pathway")return savePathway();
  if(a==="accommodations")return openAccommodations(btn.dataset.student);
  if(a==="create-oral-submission")return createOralSubmission(btn.dataset.student);
  if(a==="grade-candidate")return gradeCandidate(btn.dataset.student);
  if(a==="toggle-result-release")return toggleResultRelease(btn.dataset.student);
  if(a==="auto-score-objective")return autoScoreObjective();
  if(a==="horizontal-grade")return horizontalGrade(btn.dataset.question);
  if(a==="exam-jump"){if(p3.exam && (p3.exam.assessment.backtracking!==false || Number(btn.dataset.index)>p3.exam.index)){p3.exam.index=Number(btn.dataset.index);scheduleExamSave();renderExam();}return;}
  if(a==="exam-prev"){if(p3.exam&&p3.exam.index>0&&p3.exam.assessment.backtracking!==false){p3.exam.index--;scheduleExamSave();renderExam();}return;}
  if(a==="exam-next"){if(!p3.exam)return;if(p3.exam.index<p3.exam.questions.length-1)p3.exam.index++;else p3.exam.index=0;scheduleExamSave();renderExam();return;}
  if(a==="mark-question"){if(!p3.exam)return;const id=p3.exam.questions[p3.exam.index].id;p3.exam.marked=p3.exam.marked.includes(id)?p3.exam.marked.filter(x=>x!==id):[...p3.exam.marked,id];scheduleExamSave();renderExam();return;}
  if(a==="submit-exam")return submitExam(false);
  if(a==="calculator")return openCalculator();
});

window.TheoriaPhase3={renderSectionTab,renderAssessments,renderItemBank};

if(window.TheoriaCore) onReady();
