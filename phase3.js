import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch, Timestamp, serverTimestamp
} from "./firebase.js";

const P3 = {
  ready:false,
  items:[],
  assessments:[],
  current:null,
  detail:null,
  exam:null,
  timer:null,
  saveTimer:null
};

const core=()=>window.TheoriaCore;
const state=()=>core()?.getState();
const $=s=>document.querySelector(s);
const esc=v=>core()?.esc(v) ?? String(v ?? "");
const toast=m=>core()?.showToast(m);

function dateText(value){
  if(!value)return "Not scheduled";
  const d=value.toDate?value.toDate():new Date(value);
  if(Number.isNaN(d.getTime()))return "Not scheduled";
  return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}).format(d);
}

function localDateTime(value){
  if(!value)return "";
  const d=value.toDate?value.toDate():new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  const z=n=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate())+"T"+z(d.getHours())+":"+z(d.getMinutes());
}

function timestampFrom(value){
  if(!value)return null;
  const d=new Date(value);
  return Number.isNaN(d.getTime())?null:Timestamp.fromDate(d);
}

function linesToWeights(text){
  return String(text||"").split("\n").map(x=>x.trim()).filter(Boolean).map((line,i)=>{
    const [label,weight]=line.split("|");
    return {id:"w"+(i+1),label:(label||"").trim(),weight:Number(weight||0)};
  }).filter(x=>x.label);
}

function weightsToText(rows){
  return (rows||[]).map(x=>x.label+" | "+x.weight).join("\n");
}

function linesToRubric(text){
  return String(text||"").split("\n").map(x=>x.trim()).filter(Boolean).map((line,i)=>{
    const [criterion,points]=line.split("|");
    return {id:"r"+(i+1),criterion:(criterion||"").trim(),points:Number(points||0)};
  }).filter(x=>x.criterion);
}

function rubricToText(rows){
  return (rows||[]).map(x=>x.criterion+" | "+x.points).join("\n");
}

function totalWeight(rows){
  return (rows||[]).reduce((n,x)=>n+Number(x.weight||0),0);
}

function defaultParts(type){
  if(type==="Comprehensive Final Examination")return [
    {id:"knowledge",title:"Foundational Knowledge",weight:20},
    {id:"exegesis",title:"Scripture & Exegesis",weight:20},
    {id:"sources",title:"Primary Source Analysis",weight:15},
    {id:"argument",title:"Argument Analysis",weight:15},
    {id:"responses",title:"Short Theological Responses",weight:10},
    {id:"essay",title:"Comprehensive Essay",weight:20}
  ];
  if(type==="Semester I Examination")return [
    {id:"knowledge",title:"Foundational Knowledge",weight:25},
    {id:"exegesis",title:"Scripture & Exegesis",weight:20},
    {id:"sources",title:"Primary Source Analysis",weight:15},
    {id:"argument",title:"Argument Analysis",weight:15},
    {id:"essay",title:"Theological Synthesis Essay",weight:25}
  ];
  if(type==="Oral Examination")return [{id:"oral",title:"Oral Examination",weight:100}];
  if(type==="Disputation")return [{id:"disputation",title:"Disputation",weight:100}];
  return [{id:"main",title:"Main Assessment",weight:100}];
}

function objective(type){
  return type==="Multiple Choice"||type==="Multiple Select";
}

function normalizeAnswer(value,type){
  if(type==="Multiple Select"){
    return (Array.isArray(value)?value:String(value||"").split(","))
      .map(x=>String(x).trim().toUpperCase()).filter(Boolean).sort();
  }
  return String(value??"").trim().toUpperCase();
}

function answerMatches(a,b,type){
  const aa=normalizeAnswer(a,type),bb=normalizeAnswer(b,type);
  if(Array.isArray(aa))return aa.length===bb.length&&aa.every((x,i)=>x===bb[i]);
  return aa===bb;
}

function newCandidateNumber(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="C-";
  for(let i=0;i<6;i++)out+=chars[Math.floor(Math.random()*chars.length)];
  return out;
}

async function framework(courseId){
  const [unitsSnap,compSnap]=await Promise.all([
    getDocs(collection(db,"courses",courseId,"units")),
    getDocs(collection(db,"courses",courseId,"competencies"))
  ]);
  const units=unitsSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  for(const u of units){
    const t=await getDocs(collection(db,"courses",courseId,"units",u.id,"topics"));
    u.topics=t.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  }
  return {units,competencies:compSnap.docs.map(d=>({id:d.id,...d.data()}))};
}

/* -------------------- ITEM BANK -------------------- */

async function loadItems(){
  const s=state();
  if(!s||s.role!=="instructor")return [];
  const all=[];
  for(const c of s.courses){
    const snap=await getDocs(collection(db,"courses",c.id,"items"));
    snap.docs.forEach(d=>all.push({id:d.id,courseId:c.id,courseCode:c.code,courseTitle:c.title,...d.data()}));
  }
  P3.items=all.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""))||String(a.prompt||"").localeCompare(String(b.prompt||"")));
  return P3.items;
}

function itemCard(item){
  return '<article class="assessment-item-card">'+
    '<div class="item-card-head"><div><div class="card-kicker">'+esc(item.courseCode||"COURSE")+' • '+esc(item.type||"Item")+'</div>'+
    '<h3>'+esc((item.prompt||"Untitled item").slice(0,150))+(String(item.prompt||"").length>150?"…":"")+'</h3></div>'+
    '<span class="badge">'+esc(item.difficulty||"Moderate")+'</span></div>'+
    '<div class="item-tags"><span>'+esc(item.topicNumber||"No topic")+'</span><span>'+esc(item.cognitiveLevel||"Application")+'</span><span>'+esc(item.pointsDefault||1)+' pts</span>'+
    (item.competencyCodes||[]).map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>'+
    '<div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="edit-item" data-course="'+item.courseId+'" data-id="'+item.id+'">Edit</button></div></article>';
}

async function renderItemBank(){
  const el=$("#itemBankContent");
  if(!el||state()?.role!=="instructor")return;
  await loadItems();
  if(!state().courses.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">I</div><h3>Create a course first.</h3><p>The Item Bank belongs to reusable course frameworks.</p></div>';
    return;
  }
  el.innerHTML='<div class="assessment-toolbar"><div class="filter-row">'+
    '<select id="itemCourseFilter"><option value="">All courses</option>'+state().courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select>'+
    '<select id="itemTypeFilter"><option value="">All types</option>'+["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"].map(x=>'<option>'+x+'</option>').join("")+'</select>'+
    '<input id="itemSearch" placeholder="Search prompt, topic, competency, or tag"></div><div class="toolbar-stat"><strong>'+P3.items.length+'</strong><span> reusable items</span></div></div>'+
    '<div id="itemBankList" class="assessment-item-grid"></div>';
  const filter=()=>{
    const c=$("#itemCourseFilter").value,t=$("#itemTypeFilter").value,q=$("#itemSearch").value.trim().toLowerCase();
    const list=P3.items.filter(x=>(!c||x.courseId===c)&&(!t||x.type===t)&&(!q||[x.prompt,x.topicTitle,x.topicNumber,(x.competencyCodes||[]).join(" "),(x.tags||[]).join(" ")].join(" ").toLowerCase().includes(q)));
    $("#itemBankList").innerHTML=list.length?list.map(itemCard).join(""):'<div class="empty-state"><div class="empty-symbol">I</div><h3>No matching items.</h3><p>Create a new item or adjust the filters.</p></div>';
  };
  $("#itemCourseFilter").addEventListener("change",filter);
  $("#itemTypeFilter").addEventListener("change",filter);
  $("#itemSearch").addEventListener("input",filter);
  filter();
}

async function itemModal(existing){
  const s=state();
  if(!s?.courses?.length)return toast("Create a course before creating assessment items.");
  let courseId=existing?.courseId||s.courses[0].id;
  let fw=await framework(courseId);
  const types=["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"];
  const modal=core().openModal({
    eyebrow:"Item Bank",
    title:existing?"Edit Assessment Item":"Create Assessment Item",
    wide:true,
    body:'<form id="itemForm"><div class="form-grid">'+
      '<div class="field"><label>Course</label><select name="courseId" id="itemCourse" '+(existing?'disabled':'')+'>'+s.courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Item Type</label><select name="type">'+types.map(x=>'<option>'+x+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Difficulty</label><select name="difficulty"><option>Foundational</option><option>Moderate</option><option>Advanced</option></select></div>'+
      '<div class="field"><label>Cognitive Level</label><select name="cognitiveLevel"><option>Recall</option><option>Understanding</option><option>Application</option><option>Analysis</option><option>Evaluation</option><option>Synthesis</option></select></div>'+
      '<div class="field"><label>Unit</label><select name="unitId" id="itemUnit"></select></div>'+
      '<div class="field"><label>Topic</label><select name="topicId" id="itemTopic"></select></div>'+
      '<div class="field"><label>Default Points</label><input name="pointsDefault" type="number" min="0" step="0.5" value="'+esc(existing?.pointsDefault??1)+'"></div>'+
      '<div class="field"><label>Tags</label><input name="tags" value="'+esc((existing?.tags||[]).join(", "))+'" placeholder="christology, final, primary-source"></div>'+
      '<div class="field span-2"><label>Source / Stimulus Title</label><input name="sourceTitle" value="'+esc(existing?.sourceTitle||"")+'" placeholder="Athanasius, On the Incarnation §8"></div>'+
      '<div class="field span-2"><label>Source / Stimulus Text</label><textarea name="stimulus" placeholder="Paste text directly or cite/link it in a section resource. Theoria uses Firestore only; no file upload service is required.">'+esc(existing?.stimulus||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Prompt</label><textarea name="prompt" required>'+esc(existing?.prompt||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Answer Options</label><textarea name="options" placeholder="One option per line">'+esc((existing?.options||[]).map(x=>x.text||x).join("\n"))+'</textarea></div>'+
      '<div class="field"><label>Correct Answer(s)</label><input name="correctAnswer" value="'+esc(Array.isArray(existing?.correctAnswer)?existing.correctAnswer.join(", "):(existing?.correctAnswer||""))+'" placeholder="B or A, C"></div>'+
      '<div class="field"><label>Source Set / Group</label><input name="sourceSet" value="'+esc(existing?.sourceSet||"")+'"></div>'+
      '<div class="field span-2"><label>Instructor Explanation / Key</label><textarea name="explanation">'+esc(existing?.explanation||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Rubric Criteria</label><textarea name="rubric" placeholder="Thesis clarity | 4\nBiblical support | 8">'+esc(rubricToText(existing?.rubric))+'</textarea></div>'+
      '<div class="field span-2"><label>Academic Competencies</label><div id="itemCompetencies" class="competency-picker"></div></div>'+
      '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Item</button></div></form>'
  });
  const form=modal.querySelector("#itemForm");
  form.courseId.value=courseId;
  form.type.value=existing?.type||"Multiple Choice";
  form.difficulty.value=existing?.difficulty||"Moderate";
  form.cognitiveLevel.value=existing?.cognitiveLevel||"Application";

  const populate=async(id)=>{
    courseId=id;
    fw=await framework(id);
    const unit=form.querySelector("#itemUnit"),topic=form.querySelector("#itemTopic");
    unit.innerHTML='<option value="">Unassigned</option>'+fw.units.map(u=>'<option value="'+u.id+'">'+esc("Unit "+(u.order||"")+" — "+u.title)+'</option>').join("");
    unit.value=existing?.unitId||"";
    const fillTopics=()=>{
      const u=fw.units.find(x=>x.id===unit.value);
      topic.innerHTML='<option value="">Unassigned</option>'+((u?.topics||[]).map(t=>'<option value="'+t.id+'">'+esc((t.number||"")+" — "+t.title)+'</option>').join(""));
      topic.value=existing?.topicId||"";
    };
    unit.onchange=fillTopics;fillTopics();
    form.querySelector("#itemCompetencies").innerHTML=fw.competencies.length?fw.competencies.map(c=>'<label class="checkbox-line"><input type="checkbox" name="competency" value="'+c.id+'" data-code="'+esc(c.code)+'" '+((existing?.competencyIds||[]).includes(c.id)?'checked':'')+'> '+esc(c.code+" — "+c.name)+'</label>').join(""):'<div class="empty-mini">No competencies created for this course.</div>';
  };
  if(!existing)form.querySelector("#itemCourse").addEventListener("change",e=>populate(e.target.value));
  await populate(courseId);

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form),cid=existing?.courseId||String(fd.get("courseId"));
    const unit=fw.units.find(x=>x.id===String(fd.get("unitId"))),topic=unit?.topics?.find(x=>x.id===String(fd.get("topicId")));
    const type=String(fd.get("type"));
    const options=String(fd.get("options")||"").split("\n").map(x=>x.trim()).filter(Boolean).map((text,i)=>({id:String.fromCharCode(65+i),text}));
    const selected=[...form.querySelectorAll('input[name="competency"]:checked')];
    let correct=String(fd.get("correctAnswer")||"").trim();
    correct=type==="Multiple Select"?correct.split(",").map(x=>x.trim().toUpperCase()).filter(Boolean).sort():correct.toUpperCase();
    const data={
      ownerId:s.user.uid,courseId:cid,type,
      difficulty:String(fd.get("difficulty")),cognitiveLevel:String(fd.get("cognitiveLevel")),
      unitId:unit?.id||"",unitTitle:unit?.title||"",topicId:topic?.id||"",topicTitle:topic?.title||"",topicNumber:topic?.number||"",
      competencyIds:selected.map(x=>x.value),competencyCodes:selected.map(x=>x.dataset.code),
      pointsDefault:Number(fd.get("pointsDefault")||1),tags:String(fd.get("tags")||"").split(",").map(x=>x.trim()).filter(Boolean),
      sourceTitle:String(fd.get("sourceTitle")||"").trim(),sourceSet:String(fd.get("sourceSet")||"").trim(),stimulus:String(fd.get("stimulus")||"").trim(),
      prompt:String(fd.get("prompt")||"").trim(),options,correctAnswer:correct,explanation:String(fd.get("explanation")||"").trim(),
      rubric:linesToRubric(fd.get("rubric")),updatedAt:serverTimestamp()
    };
    try{
      if(existing)await updateDoc(doc(db,"courses",cid,"items",existing.id),data);
      else await addDoc(collection(db,"courses",cid,"items"),{...data,createdAt:serverTimestamp()});
      core().closeModal();await renderItemBank();toast(existing?"Item updated.":"Item created.");
    }catch(err){toast(err.message||"Unable to save item.");}
  });
}

/* -------------------- ASSESSMENTS -------------------- */

function availability(a){
  const now=Date.now(),open=a.opensAt?.toMillis?.()||0,close=a.closesAt?.toMillis?.()||0;
  if(a.status==="Draft")return "Draft";
  if(a.status==="Closed")return "Closed";
  if(open&&now<open)return "Scheduled";
  if(close&&now>close)return "Window Ended";
  return "Open";
}

async function loadAssessments(){
  const s=state();if(!s)return [];
  const list=[];
  if(s.role==="instructor"){
    const snap=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
    snap.docs.forEach(d=>list.push({id:d.id,...d.data()}));
  }else{
    for(const section of s.sections){
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
      for(const r of refs.docs){
        try{const a=await getDoc(doc(db,"assessments",r.id));if(a.exists())list.push({id:a.id,...a.data()});}catch(_){}
      }
    }
  }
  P3.assessments=list.sort((a,b)=>(b.opensAt?.toMillis?.()||0)-(a.opensAt?.toMillis?.()||0));
  return P3.assessments;
}

async function renderAssessments(){
  const el=$("#assessmentsContent");if(!el)return;
  await loadAssessments();
  const s=state();
  if(!P3.assessments.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">A</div><h3>No assessments yet.</h3><p>'+(s.role==="instructor"?"Create a unit evaluation, semester examination, comprehensive final, oral examination, or disputation.":"Published assessments from your sections will appear here.")+'</p>'+(s.role==="instructor"?'<button class="primary-btn" data-phase3-action="new-assessment">Create Assessment</button>':'')+'</div>';
    return;
  }
  if(s.role==="instructor"){
    el.innerHTML='<div class="assessment-grid">'+P3.assessments.map(a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p><div class="assessment-card-stats"><span><strong>'+esc(a.questionCount||0)+'</strong> items</span><span><strong>'+esc(a.totalPoints||0)+'</strong> points</span><span>'+esc(availability(a))+'</span></div><div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button></div></article>').join("")+'</div>';
    return;
  }
  const cards=[];
  for(const a of P3.assessments){
    let sub=null,result=null;
    try{const x=await getDoc(doc(db,"assessments",a.id,"submissions",s.user.uid));if(x.exists())sub=x.data();}catch(_){}
    try{const x=await getDoc(doc(db,"assessments",a.id,"results",s.user.uid));if(x.exists())result=x.data();}catch(_){}
    const status=availability(a);
    let action='<span class="badge">'+esc(status)+'</span>';
    if(a.mode==="oral"||a.mode==="disputation")action='<span class="badge gold">Instructor administered</span>';
    else if(sub?.status==="submitted"||sub?.status==="graded")action='<button class="secondary-btn small-btn" data-phase3-action="receipt" data-id="'+a.id+'">Submission Receipt</button>';
    else if(status==="Open")action='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">'+(sub?"Resume":"Begin")+'</button>';
    cards.push('<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p><div class="assessment-card-stats"><span>'+esc(a.durationMinutes||0)+' min</span><span>'+esc(a.totalPoints||0)+' pts</span><span>'+esc(status)+'</span></div>'+(result?'<div class="released-result"><strong>'+esc(result.percent)+'%</strong><span>Released result</span></div>':'')+'<div class="card-actions">'+action+'</div></article>');
  }
  el.innerHTML='<div class="assessment-grid">'+cards.join("")+'</div>';
}

async function assessmentModal(existing){
  const s=state();if(!s?.sections?.length)return toast("Create a section before creating an assessment.");
  const types=["Academic Exercise","Unit Evaluation","Semester I Examination","Comprehensive Final Examination","Oral Examination","Disputation"];
  const modal=core().openModal({
    eyebrow:"Assessment Builder",
    title:existing?"Edit Assessment":"Create Assessment",
    wide:true,
    body:'<form id="assessmentForm"><div class="form-grid">'+
      '<div class="field span-2"><label>Section</label><select name="sectionId" '+(existing?'disabled':'')+'>'+s.sections.map(x=>'<option value="'+x.id+'">'+esc(x.courseCode+" — "+x.sectionName+" • "+x.term)+'</option>').join("")+'</select></div>'+
      '<div class="field span-2"><label>Title</label><input name="title" value="'+esc(existing?.title||"")+'" required></div>'+
      '<div class="field"><label>Type</label><select name="type">'+types.map(x=>'<option>'+x+'</option>').join("")+'</select></div>'+
      '<div class="field"><label>Duration (minutes)</label><input name="durationMinutes" type="number" min="0" value="'+esc(existing?.durationMinutes??60)+'"></div>'+
      '<div class="field"><label>Opens</label><input name="opensAt" type="datetime-local" value="'+esc(localDateTime(existing?.opensAt))+'"></div>'+
      '<div class="field"><label>Closes</label><input name="closesAt" type="datetime-local" value="'+esc(localDateTime(existing?.closesAt))+'"></div>'+
      '<div class="field span-2"><label>Instructions</label><textarea name="instructions">'+esc(existing?.instructions||"")+'</textarea></div>'+
      '<div class="field span-2"><label>Content Blueprint</label><textarea name="contentBlueprint" placeholder="Unit I — Foundations | 20\nUnit II — Historical Development | 20">'+esc(weightsToText(existing?.contentBlueprint))+'</textarea></div>'+
      '<div class="field span-2"><label>Competency Blueprint</label><textarea name="competencyBlueprint" placeholder="Biblical Exegesis | 25\nTheological Synthesis | 25">'+esc(weightsToText(existing?.competencyBlueprint))+'</textarea></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="anonymousGrading" '+(existing?.anonymousGrading!==false?'checked':'')+'> Anonymous candidate grading</label></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="backtracking" '+(existing?.backtracking!==false?'checked':'')+'> Allow backtracking</label></div>'+
      '<div class="field"><label class="checkbox-line"><input type="checkbox" name="randomizeQuestions" '+(existing?.randomizeQuestions?'checked':'')+'> Randomize question order</label></div>'+
      '<div class="field"><label>Result Release</label><select name="feedbackPolicy"><option value="manual">Instructor releases results manually</option><option value="score_only">Score only when released</option></select></div>'+
      '</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(existing?"Save Assessment":"Create Draft")+'</button></div></form>'
  });
  const form=modal.querySelector("#assessmentForm");
  form.sectionId.value=existing?.sectionId||s.sections[0].id;
  form.type.value=existing?.type||"Unit Evaluation";
  form.feedbackPolicy.value=existing?.feedbackPolicy||"manual";

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const section=existing?(s.sections.find(x=>x.id===existing.sectionId)||s.currentSection):s.sections.find(x=>x.id===String(fd.get("sectionId")));
    const type=String(fd.get("type")),contentBlueprint=linesToWeights(fd.get("contentBlueprint")),competencyBlueprint=linesToWeights(fd.get("competencyBlueprint"));
    if(contentBlueprint.length&&totalWeight(contentBlueprint)!==100)return toast("Content blueprint must total 100%.");
    if(competencyBlueprint.length&&totalWeight(competencyBlueprint)!==100)return toast("Competency blueprint must total 100%.");
    const data={
      ownerId:s.user.uid,sectionId:section.id,sectionName:section.sectionName,courseId:section.courseId,courseCode:section.courseCode,courseTitle:section.courseTitle,
      title:String(fd.get("title")).trim(),type,mode:type==="Oral Examination"?"oral":type==="Disputation"?"disputation":"written",
      status:existing?.status||"Draft",durationMinutes:Number(fd.get("durationMinutes")||0),
      opensAt:timestampFrom(fd.get("opensAt")),closesAt:timestampFrom(fd.get("closesAt")),
      instructions:String(fd.get("instructions")||"").trim(),anonymousGrading:form.elements.anonymousGrading.checked,
      backtracking:form.elements.backtracking.checked,randomizeQuestions:form.elements.randomizeQuestions.checked,
      feedbackPolicy:String(fd.get("feedbackPolicy")),contentBlueprint,competencyBlueprint,
      parts:existing?.parts?.length?existing.parts:defaultParts(type),questionIds:existing?.questionIds||[],
      questionCount:Number(existing?.questionCount||0),totalPoints:Number(existing?.totalPoints||0),updatedAt:serverTimestamp()
    };
    try{
      let id=existing?.id;
      if(existing)await updateDoc(doc(db,"assessments",id),data);
      else{id=(await addDoc(collection(db,"assessments"),{...data,createdAt:serverTimestamp()})).id;}
      core().closeModal();await openAssessment(id);toast(existing?"Assessment updated.":"Assessment draft created.");
    }catch(err){toast(err.message||"Unable to save assessment.");}
  });
}

async function loadAssessment(id){
  const a=await getDoc(doc(db,"assessments",id));
  if(!a.exists())throw new Error("Assessment not found.");
  const assessment={id:a.id,...a.data()};
  const q=await getDocs(collection(db,"assessments",id,"questions"));
  const questions=q.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>Number(x.order||99)-Number(y.order||99));
  let keys=[],submissions=[],results=[],members=[];
  if(state().role==="instructor"){
    const [k,s,r,m]=await Promise.all([
      getDocs(collection(db,"assessments",id,"keys")),
      getDocs(collection(db,"assessments",id,"submissions")),
      getDocs(collection(db,"assessments",id,"results")),
      getDocs(collection(db,"sections",assessment.sectionId,"members"))
    ]);
    keys=k.docs.map(d=>({id:d.id,...d.data()}));
    submissions=s.docs.map(d=>({id:d.id,...d.data()}));
    results=r.docs.map(d=>({id:d.id,...d.data()}));
    members=m.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>String(x.displayName||"").localeCompare(String(y.displayName||"")));
  }
  return {assessment,questions,keys,submissions,results,members};
}

async function openAssessment(id,tab="overview"){
  try{
    P3.detail=await loadAssessment(id);
    P3.current=P3.detail.assessment;
    renderAssessment(tab);
    core().setPage("assessment-detail",P3.current.courseCode+" / "+P3.current.title);
  }catch(err){toast(err.message||"Unable to open assessment.");}
}

function assessmentTabs(active){
  return '<div class="tabs">'+[["overview","Overview"],["items","Items"],["candidates","Candidates"],["grading","Grading"]].map(([id,label])=>'<button class="tab-btn '+(active===id?'active':'')+'" data-phase3-action="assessment-tab" data-tab="'+id+'">'+label+'</button>').join("")+'</div>';
}

function blueprintPanel(title,rows){
  return '<div class="panel"><div class="panel-head"><div class="panel-title">'+title+'</div><span class="badge '+(totalWeight(rows)===100?'live':'gold')+'">'+totalWeight(rows)+'%</span></div><div class="panel-body">'+((rows||[]).length?rows.map(x=>'<div class="blueprint-row"><span>'+esc(x.label)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join(""):'<div class="empty-mini">No blueprint targets defined.</div>')+'</div></div>';
}

function overviewView(){
  const a=P3.current;
  return '<div class="section-summary"><div class="summary-block"><div class="summary-label">Status</div><div class="summary-value">'+esc(a.status)+'</div></div><div class="summary-block"><div class="summary-label">Items</div><div class="summary-value">'+esc(a.questionCount||0)+'</div></div><div class="summary-block"><div class="summary-label">Points</div><div class="summary-value">'+esc(a.totalPoints||0)+'</div></div><div class="summary-block"><div class="summary-label">Duration</div><div class="summary-value">'+esc(a.durationMinutes||0)+'m</div></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Administration</div></div><div class="panel-body"><div class="detail-list"><div><span>Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Anonymous grading</span><strong>'+(a.anonymousGrading!==false?"Enabled":"Disabled")+'</strong></div><div><span>Backtracking</span><strong>'+(a.backtracking!==false?"Allowed":"Restricted")+'</strong></div></div></div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Examination Parts</div><span class="badge '+(totalWeight(a.parts)===100?'live':'gold')+'">'+totalWeight(a.parts)+'%</span></div><div class="panel-body">'+(a.parts||[]).map(x=>'<div class="blueprint-row"><span>'+esc(x.title)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join("")+'</div></div></div>'+
    '<div class="grid-2" style="margin-top:18px">'+blueprintPanel("Content Blueprint",a.contentBlueprint)+blueprintPanel("Competency Blueprint",a.competencyBlueprint)+'</div>';
}

function itemsView(){
  const a=P3.current,q=P3.detail.questions;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Assessment Assembly</div><p class="page-subtitle">Students never receive answer-key documents.</p></div><button class="primary-btn small-btn" data-phase3-action="add-items">Add from Item Bank</button></div>'+
    (q.length?'<div class="assessment-builder-list">'+q.map((x,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc((a.parts||[]).find(p=>p.id===x.partId)?.title||"Main")+' • '+esc(x.type)+'</div><h4>'+esc(x.prompt)+'</h4><div class="item-tags"><span>'+esc(x.points)+' pts</span><span>'+esc(x.topicNumber||"No topic")+'</span>'+(x.competencyCodes||[]).map(c=>'<span>'+esc(c)+'</span>').join("")+'</div></div><div class="inline-actions"><button class="text-btn" data-phase3-action="configure-item" data-id="'+x.id+'">Configure</button><button class="danger-btn" data-phase3-action="remove-item" data-id="'+x.id+'">Remove</button></div></div>').join("")+'</div>':
    '<div class="empty-state"><div class="empty-symbol">I</div><h3>No assessment items yet.</h3><p>Add reusable items from the course Item Bank.</p><button class="primary-btn" data-phase3-action="add-items">Add Items</button></div>');
}

function candidatesView(){
  const d=P3.detail,a=d.assessment,subMap=new Map(d.submissions.map(x=>[x.studentId,x])),resMap=new Map(d.results.map(x=>[x.studentId,x]));
  if(!d.members.length)return '<div class="empty-state"><div class="empty-symbol">C</div><h3>No enrolled candidates.</h3></div>';
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Release</th><th>Action</th></tr></thead><tbody>'+d.members.map(m=>{
    const sub=subMap.get(m.id),res=resMap.get(m.id),name=a.anonymousGrading!==false?(sub?.candidateNumber||"Not assigned"):m.displayName;
    let action="—";
    if(!sub&&(a.mode==="oral"||a.mode==="disputation"))action='<button class="secondary-btn small-btn" data-phase3-action="create-evaluation" data-student="'+m.id+'">Begin Evaluation</button>';
    else if(sub)action='<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>';
    const release=res?(res.complete===false?'<span class="badge gold">Incomplete</span>':'<button class="text-btn" data-phase3-action="toggle-release" data-student="'+m.id+'">'+(res.released?"Unrelease":"Release")+'</button>'):"—";
    return '<tr><td><strong>'+esc(name)+'</strong></td><td><span class="badge">'+esc(sub?.status||"Not started")+'</span></td><td>'+(res?'<strong>'+esc(res.percent)+'%</strong>':'—')+'</td><td>'+release+'</td><td>'+action+'</td></tr>';
  }).join("")+'</tbody></table></div>';
}

function gradingView(){
  const d=P3.detail;
  return '<div class="academic-banner"><div class="kicker">Grading Workspace</div><h3>'+d.submissions.filter(x=>x.status==="submitted"||x.status==="graded").length+' submitted candidates</h3><p>Objective items can be scored in the instructor session; written work can be graded horizontally or candidate-by-candidate.</p></div>'+
    '<div class="page-actions" style="margin-bottom:18px"><button class="primary-btn" data-phase3-action="auto-score">Auto-score Objective Items</button></div>'+
    (d.questions.length?'<div class="assessment-builder-list">'+d.questions.map((q,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc(q.type)+'</div><h4>'+esc(q.prompt)+'</h4><div class="item-tags"><span>'+esc(q.points)+' pts</span>'+(q.competencyCodes||[]).map(c=>'<span>'+esc(c)+'</span>').join("")+'</div></div><button class="secondary-btn small-btn" data-phase3-action="horizontal-grade" data-question="'+q.id+'">Grade Across Candidates</button></div>').join("")+'</div>':'<div class="empty-mini">Add items before grading.</div>');
}

function renderAssessment(tab="overview"){
  const a=P3.current;if(!a)return;
  const body=tab==="items"?itemsView():tab==="candidates"?candidatesView():tab==="grading"?gradingView():overviewView();
  const statusButton=a.status==="Draft"?'<button class="primary-btn small-btn" data-phase3-action="publish">Publish</button>':a.status==="Published"?'<button class="secondary-btn small-btn" data-phase3-action="close">Close</button>':'<button class="secondary-btn small-btn" data-phase3-action="reopen">Reopen</button>';
  $("#assessmentDetail").innerHTML='<button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(a.courseCode)+' • '+esc(a.type)+'</div><h1 class="detail-title">'+esc(a.title)+'</h1><div class="detail-meta"><span>'+esc(a.sectionName)+'</span><span>'+esc(a.status)+'</span><span>'+esc(dateText(a.opensAt))+'</span></div></div><div class="inline-actions"><button class="secondary-btn small-btn" data-phase3-action="edit-assessment">Edit</button>'+statusButton+'</div></div>'+(a.instructions?'<p class="page-subtitle" style="margin-top:16px">'+esc(a.instructions)+'</p>':'')+'</div>'+
    assessmentTabs(tab)+'<div>'+body+'</div>';
}

async function addItemsModal(){
  await loadItems();
  const a=P3.current,available=P3.items.filter(x=>x.courseId===a.courseId&&!P3.detail.questions.some(q=>q.itemId===x.id));
  if(!available.length)return toast("No unused Item Bank items are available for this course.");
  const modal=core().openModal({
    eyebrow:"Assessment Assembly",
    title:"Add Items from Item Bank",
    wide:true,
    body:'<form id="addItemsForm"><div class="field"><label>Examination Part</label><select name="partId">'+(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("")+'</select></div>'+
      '<div class="item-select-list">'+available.map(x=>'<label class="item-select-row"><input type="checkbox" name="item" value="'+x.id+'"><div><strong>'+esc(x.type)+' • '+esc(x.topicNumber||"No topic")+'</strong><p>'+esc(x.prompt)+'</p><span>'+esc(x.pointsDefault||1)+' pts • '+esc(x.difficulty||"Moderate")+'</span></div></label>').join("")+'</div>'+
      '<div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Add Selected Items</button></div></form>'
  });
  modal.querySelector("#addItemsForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget),ids=fd.getAll("item");if(!ids.length)return toast("Select at least one item.");
    const batch=writeBatch(db),questionIds=P3.detail.questions.map(q=>q.id);let order=P3.detail.questions.length,total=Number(a.totalPoints||0);
    for(const id of ids){
      const item=available.find(x=>x.id===id);if(!item)continue;
      const ref=doc(collection(db,"assessments",a.id,"questions"));order++;questionIds.push(ref.id);total+=Number(item.pointsDefault||1);
      batch.set(ref,{itemId:item.id,order,partId:String(fd.get("partId")),type:item.type,prompt:item.prompt,stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points:Number(item.pointsDefault||1),topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()});
      batch.set(doc(db,"assessments",a.id,"keys",ref.id),{itemId:item.id,correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()});
    }
    batch.update(doc(db,"assessments",a.id),{questionIds,questionCount:order,totalPoints:total,updatedAt:serverTimestamp()});
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"items");toast("Items added.");}catch(err){toast(err.message||"Unable to add items.");}
  });
}

function configureItemModal(id){
  const q=P3.detail.questions.find(x=>x.id===id),a=P3.current;if(!q)return;
  const modal=core().openModal({
    eyebrow:"Assessment Item",
    title:"Configure Item",
    body:'<form id="configureItemForm"><div class="field"><label>Examination Part</label><select name="partId">'+(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("")+'</select></div><div class="field"><label>Points</label><input name="points" type="number" min="0" step="0.5" value="'+esc(q.points)+'"></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save</button></div></form>'
  });
  const form=modal.querySelector("#configureItemForm");form.partId.value=q.partId||a.parts?.[0]?.id;
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form),points=Number(fd.get("points")||0),delta=points-Number(q.points||0),batch=writeBatch(db);
    batch.update(doc(db,"assessments",a.id,"questions",id),{partId:String(fd.get("partId")),points,updatedAt:serverTimestamp()});
    batch.update(doc(db,"assessments",a.id),{totalPoints:Number(a.totalPoints||0)+delta,updatedAt:serverTimestamp()});
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"items");}catch(err){toast(err.message||"Unable to configure item.");}
  });
}

async function removeItem(id){
  const q=P3.detail.questions.find(x=>x.id===id),a=P3.current;if(!q)return;
  if(!confirm("Remove this item from the assessment? The Item Bank copy remains."))return;
  const batch=writeBatch(db);
  batch.delete(doc(db,"assessments",a.id,"questions",id));
  batch.delete(doc(db,"assessments",a.id,"keys",id));
  batch.update(doc(db,"assessments",a.id),{questionIds:P3.detail.questions.filter(x=>x.id!==id).map(x=>x.id),questionCount:Math.max(0,Number(a.questionCount||1)-1),totalPoints:Math.max(0,Number(a.totalPoints||0)-Number(q.points||0)),updatedAt:serverTimestamp()});
  try{await batch.commit();await openAssessment(a.id,"items");}catch(err){toast(err.message||"Unable to remove item.");}
}

async function setStatus(status){
  const a=P3.current;
  if(status==="Published"&&!P3.detail.questions.length)return toast("Add at least one item or evaluation prompt before publishing.");
  if(status==="Published"&&totalWeight(a.parts)!==100)return toast("Examination parts must total 100%.");
  const batch=writeBatch(db);
  batch.update(doc(db,"assessments",a.id),{status,questionIds:P3.detail.questions.map(q=>q.id),updatedAt:serverTimestamp()});
  if(status==="Draft")batch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
  else batch.set(doc(db,"sections",a.sectionId,"assessmentRefs",a.id),{assessmentId:a.id,title:a.title,type:a.type,status,opensAt:a.opensAt||null,closesAt:a.closesAt||null,durationMinutes:a.durationMinutes||0,updatedAt:serverTimestamp()},{merge:true});
  try{await batch.commit();await openAssessment(a.id);await renderAssessments();toast("Assessment "+status.toLowerCase()+".");}catch(err){toast(err.message||"Unable to update assessment.");}
}

/* -------------------- SECTION ASSESSMENTS / PATHWAYS -------------------- */

async function renderSectionAssessments(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!s||!section||!el)return;
  let list=[];
  if(s.role==="instructor"){
    const snap=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
    list=snap.docs.map(d=>({id:d.id,...d.data()}));
  }else{
    const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
    for(const r of refs.docs){try{const a=await getDoc(doc(db,"assessments",r.id));if(a.exists())list.push({id:a.id,...a.data()});}catch(_){}}
  }
  el.innerHTML=list.length?'<div class="assessment-grid">'+list.map(a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(availability(a))+' • '+esc(a.durationMinutes||0)+' minutes</p><div class="card-actions">'+(s.role==="instructor"?'<button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button>':(a.mode==="oral"||a.mode==="disputation")?'<span class="badge gold">Instructor administered</span>':availability(a)==="Open"?'<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">Open Assessment</button>':'<span class="badge">'+esc(availability(a))+'</span>')+'</div></article>').join("")+'</div>':'<div class="empty-state"><div class="empty-symbol">A</div><h3>No section assessments yet.</h3></div>';
}

async function renderGradingPolicy(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const secSnap=await getDoc(doc(db,"sections",section.id)),sec=secSnap.exists()?secSnap.data():section;
  const policy=sec.gradingPolicy||{selectionOpen:true,selectionDeadline:null,examination:{semester:35,comprehensive:65},composite:{coursework:60,semester:15,comprehensive:25}};
  const pathSnap=await getDocs(collection(db,"sections",section.id,"gradingPathways"));
  const selections=pathSnap.docs.map(d=>({id:d.id,...d.data()}));
  el.innerHTML='<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Grading Pathway Policy</div></div><div class="panel-body"><form id="gradingPolicyForm">'+
    '<div class="field"><label>Selection Deadline</label><input name="deadline" type="datetime-local" value="'+esc(localDateTime(policy.selectionDeadline))+'"></div>'+
    '<label class="checkbox-line" style="margin-bottom:16px"><input type="checkbox" name="selectionOpen" '+(policy.selectionOpen!==false?'checked':'')+'> Students may select/change pathways</label>'+
    '<div class="path-policy"><h4>Examination Pathway</h4><div class="form-grid"><div class="field"><label>Semester I Exam %</label><input name="examSemester" type="number" value="'+esc(policy.examination?.semester??35)+'"></div><div class="field"><label>Comprehensive Final %</label><input name="examFinal" type="number" value="'+esc(policy.examination?.comprehensive??65)+'"></div></div></div>'+
    '<div class="path-policy"><h4>Composite Pathway</h4><div class="form-grid"><div class="field"><label>Coursework %</label><input name="compCoursework" type="number" value="'+esc(policy.composite?.coursework??60)+'"></div><div class="field"><label>Semester I Exam %</label><input name="compSemester" type="number" value="'+esc(policy.composite?.semester??15)+'"></div><div class="field"><label>Comprehensive Final %</label><input name="compFinal" type="number" value="'+esc(policy.composite?.comprehensive??25)+'"></div></div></div>'+
    '<button class="primary-btn" type="submit">Save Grading Policy</button></form></div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Student Selections</div></div><div class="panel-body">'+(selections.length?selections.map(x=>'<div class="selection-row"><div><strong>'+esc(x.studentName||x.studentId)+'</strong><span>'+esc(x.pathway==="examination"?"Examination Pathway":"Composite Pathway")+'</span></div><span class="badge '+(x.pathway==="examination"?'gold':'live')+'">'+esc(x.pathway)+'</span></div>').join(""):'<div class="empty-mini">No selections yet.</div>')+'</div></div></div>';
  $("#gradingPolicyForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const examination={semester:Number(fd.get("examSemester")),comprehensive:Number(fd.get("examFinal"))};
    const composite={coursework:Number(fd.get("compCoursework")),semester:Number(fd.get("compSemester")),comprehensive:Number(fd.get("compFinal"))};
    if(examination.semester+examination.comprehensive!==100)return toast("Examination Pathway must total 100%.");
    if(composite.coursework+composite.semester+composite.comprehensive!==100)return toast("Composite Pathway must total 100%.");
    const gradingPolicy={selectionOpen:e.currentTarget.elements.selectionOpen.checked,selectionDeadline:timestampFrom(fd.get("deadline")),examination,composite,updatedAt:serverTimestamp()};
    try{await updateDoc(doc(db,"sections",section.id),{gradingPolicy,updatedAt:serverTimestamp()});section.gradingPolicy=gradingPolicy;toast("Grading policy saved.");await renderGradingPolicy();}catch(err){toast(err.message||"Unable to save grading policy.");}
  });
}

async function renderStudentPathway(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const secSnap=await getDoc(doc(db,"sections",section.id)),sec=secSnap.exists()?secSnap.data():section,policy=sec.gradingPolicy;
  if(!policy){el.innerHTML='<div class="empty-state"><div class="empty-symbol">G</div><h3>Pathway selection is not open yet.</h3></div>';return;}
  let selection=null;try{const x=await getDoc(doc(db,"sections",section.id,"gradingPathways",s.user.uid));if(x.exists())selection=x.data();}catch(_){}
  const deadline=policy.selectionDeadline?.toDate?.(),open=policy.selectionOpen!==false&&(!deadline||deadline.getTime()>=Date.now()),ex=policy.examination||{semester:35,comprehensive:65},co=policy.composite||{coursework:60,semester:15,comprehensive:25};
  el.innerHTML='<div class="academic-banner"><div class="kicker">Final Grade Method</div><h3>'+(selection?"Current selection: "+(selection.pathway==="examination"?"Examination Pathway":"Composite Pathway"):"Choose your grading pathway")+'</h3><p>Coursework remains graded throughout the course. Selection deadline: '+esc(dateText(policy.selectionDeadline))+'</p></div>'+
    '<div class="pathway-grid"><label class="pathway-card '+(selection?.pathway==="examination"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="examination" '+(selection?.pathway==="examination"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">A</div><div><h3>Examination Pathway</h3><p>Final standing is determined entirely by cumulative examination performance.</p><div class="formula-row"><span>Semester I Examination</span><strong>'+ex.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+ex.comprehensive+'%</strong></div></div></label>'+
    '<label class="pathway-card '+(selection?.pathway==="composite"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="composite" '+(selection?.pathway==="composite"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">B</div><div><h3>Composite Pathway</h3><p>Final standing combines sustained coursework and cumulative examinations.</p><div class="formula-row"><span>Coursework</span><strong>'+co.coursework+'%</strong></div><div class="formula-row"><span>Semester I Examination</span><strong>'+co.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+co.comprehensive+'%</strong></div></div></label></div>'+
    (open?'<div class="pathway-confirm"><label class="checkbox-line"><input id="pathwayAck" type="checkbox"> I understand this choice controls how my certified final grade will be calculated.</label><button class="primary-btn" data-phase3-action="save-pathway">Confirm Selection</button></div>':'<div class="notice">The selection period is closed.</div>');
}

async function savePathway(){
  const s=state(),section=s.currentSection,choice=document.querySelector('input[name="pathwayChoice"]:checked')?.value;
  if(!choice)return toast("Choose a grading pathway.");
  if(!$("#pathwayAck")?.checked)return toast("Acknowledge the policy before confirming.");
  try{await setDoc(doc(db,"sections",section.id,"gradingPathways",s.user.uid),{studentId:s.user.uid,studentName:s.profile.displayName||s.user.displayName||"Student",pathway:choice,acknowledgement:true,selectedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});toast("Grading pathway confirmed.");await renderStudentPathway();}catch(err){toast(err.message||"The selection period may be closed.");}
}

function accommodationsModal(studentId){
  const s=state(),section=s.currentSection,member=s.sectionData?.members?.find(x=>x.id===studentId);if(!member)return;
  const a=member.accommodations||{};
  const modal=core().openModal({
    eyebrow:"Assessment Access",
    title:(member.displayName||"Student")+" — Accommodations",
    body:'<form id="accommodationForm"><div class="field"><label>Time Multiplier</label><select name="timeMultiplier"><option value="1">Standard (1.0×)</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2.0×</option></select></div>'+
      '<label class="checkbox-line"><input name="breaks" type="checkbox" '+(a.breaks?'checked':'')+'> Breaks permitted</label>'+
      '<label class="checkbox-line"><input name="calculator" type="checkbox" '+(a.calculator?'checked':'')+'> Calculator permitted</label>'+
      '<label class="checkbox-line"><input name="largeText" type="checkbox" '+(a.largeText?'checked':'')+'> Large-text interface</label>'+
      '<label class="checkbox-line"><input name="reducedDistractions" type="checkbox" '+(a.reducedDistractions?'checked':'')+'> Reduced-distraction setting</label>'+
      '<div class="field" style="margin-top:16px"><label>Accommodation Notes (visible to student)</label><textarea name="notes">'+esc(a.notes||"")+'</textarea></div>'+
      '<div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Accommodations</button></div></form>'
  });
  const form=modal.querySelector("#accommodationForm");form.timeMultiplier.value=String(a.timeMultiplier||1);
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form),accommodations={timeMultiplier:Number(fd.get("timeMultiplier")||1),breaks:form.elements.breaks.checked,calculator:form.elements.calculator.checked,largeText:form.elements.largeText.checked,reducedDistractions:form.elements.reducedDistractions.checked,notes:String(fd.get("notes")||"").trim()};
    try{await updateDoc(doc(db,"sections",section.id,"members",studentId),{accommodations,updatedAt:serverTimestamp()});core().closeModal();await core().reloadCurrentSection("students");toast("Accommodations saved.");}catch(err){toast(err.message||"Unable to save accommodations.");}
  });
}

/* -------------------- EXAM RUNTIME -------------------- */

async function startExam(id,confirmed=false){
  const s=state();
  try{
    const snap=await getDoc(doc(db,"assessments",id));if(!snap.exists())return toast("Assessment not found.");
    const a={id:snap.id,...snap.data()};
    if(a.mode==="oral"||a.mode==="disputation")return toast("This evaluation is instructor administered.");
    let subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid)),sub=subSnap.exists()?{id:subSnap.id,...subSnap.data()}:null;
    if(sub&&sub.status!=="in_progress")return receipt(id);

    const memberSnap=await getDoc(doc(db,"sections",a.sectionId,"members",s.user.uid));
    const acc=memberSnap.exists()?(memberSnap.data().accommodations||{}):{};
    if(!sub&&!confirmed){
      const minutes=Math.round(Number(a.durationMinutes||0)*Number(acc.timeMultiplier||1));
      const modal=core().openModal({
        eyebrow:"Formal Assessment",
        title:a.title,
        wide:true,
        body:'<div class="exam-preflight"><div class="preflight-warning"><strong>Before you begin</strong><p>Beginning creates your official candidate record and starts the examination timer. Refreshing the browser does not create a new attempt.</p></div>'+
          '<div class="detail-list"><div><span>Assessment</span><strong>'+esc(a.type)+'</strong></div><div><span>Time Allowed</span><strong>'+(minutes?minutes+" minutes":"Untimed")+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Backtracking</span><strong>'+(a.backtracking!==false?"Permitted":"Restricted")+'</strong></div><div><span>Grading</span><strong>'+(a.anonymousGrading!==false?"Anonymous candidate number":"Named")+'</strong></div></div>'+
          (a.instructions?'<div class="preflight-instructions"><div class="eyebrow">Instructor Instructions</div><p>'+esc(a.instructions).replace(/\n/g,"<br>")+'</p></div>':'')+
          '<div class="accommodation-summary"><div class="eyebrow">Assessment Access</div><span>'+esc(acc.timeMultiplier||1)+'× time</span>'+(acc.breaks?'<span>Breaks permitted</span>':'')+(acc.calculator?'<span>Calculator permitted</span>':'')+(acc.largeText?'<span>Large text</span>':'')+'</div>'+
          '<label class="checkbox-line preflight-ack"><input id="examAck" type="checkbox"> I have read the instructions and understand that beginning starts my official attempt.</label></div>',
        footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="beginExamBtn" disabled>Begin Assessment</button>'
      });
      const ack=modal.querySelector("#examAck"),begin=modal.querySelector("#beginExamBtn");ack.onchange=()=>begin.disabled=!ack.checked;begin.onclick=()=>{core().closeModal();startExam(id,true);};return;
    }

    if(!sub){
      let order=[...(a.questionIds||[])];if(!order.length)return toast("This assessment has no published questions.");
      if(a.randomizeQuestions)order=order.map(v=>({v,r:Math.random()})).sort((x,y)=>x.r-y.r).map(x=>x.v);
      await setDoc(doc(db,"assessments",id,"submissions",s.user.uid),{
        studentId:s.user.uid,candidateNumber:newCandidateNumber(),status:"in_progress",
        startedAt:serverTimestamp(),acknowledgedAt:serverTimestamp(),updatedAt:serverTimestamp(),
        answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:order,
        accommodationsApplied:{timeMultiplier:Number(acc.timeMultiplier||1),breaks:!!acc.breaks,calculator:!!acc.calculator,largeText:!!acc.largeText,reducedDistractions:!!acc.reducedDistractions}
      });
      subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));sub={id:subSnap.id,...subSnap.data()};
    }

    const qSnap=await getDocs(collection(db,"assessments",id,"questions"));
    const all=qSnap.docs.map(d=>({id:d.id,...d.data()})),order=sub.questionOrder||all.map(q=>q.id),questions=order.map(qid=>all.find(q=>q.id===qid)).filter(Boolean);
    if(!questions.length)return toast("No examination questions are available.");
    launchExam(a,questions,sub);
  }catch(err){toast(err.message||"This assessment is not available.");}
}

function launchExam(assessment,questions,submission){
  clearInterval(P3.timer);
  P3.exam={assessment,questions,submission,index:Number(submission.currentIndex||0),answers:{...(submission.answers||{})},marked:[...(submission.marked||[])]};
  core().setPage("exam",assessment.title);
  $("#examRoot").classList.toggle("large-text-exam",!!submission.accommodationsApplied?.largeText);
  renderExam();
  const start=submission.startedAt?.toMillis?.()||Date.now(),duration=Math.round(Number(assessment.durationMinutes||0)*Number(submission.accommodationsApplied?.timeMultiplier||1)*60);
  const tick=()=>{
    if(!P3.exam)return;
    const elapsed=Math.floor((Date.now()-start)/1000),remaining=Math.max(0,duration-elapsed),el=$("#examTimer");
    if(el)el.textContent=duration?clock(remaining):"Untimed";
    if(duration&&remaining<=0){clearInterval(P3.timer);submitExam(true);}
  };
  tick();P3.timer=setInterval(tick,1000);
  document.addEventListener("visibilitychange",visibilityEvent);
  window.addEventListener("beforeunload",unloadEvent);
}

function clock(sec){
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return (h?h+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}

function visibilityEvent(){
  if(P3.exam&&document.visibilityState==="hidden")logEvent("visibility_hidden");
}
function unloadEvent(e){
  if(!P3.exam)return;e.preventDefault();e.returnValue="";
}
async function logEvent(type){
  try{await addDoc(collection(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid,"events"),{studentId:state().user.uid,type,at:serverTimestamp()});}catch(_){}
}

function renderExam(){
  const ex=P3.exam;if(!ex)return;
  const a=ex.assessment,q=ex.questions[ex.index],answer=ex.answers[q.id],marked=ex.marked.includes(q.id);
  const nav=ex.questions.map((x,i)=>'<button class="exam-nav-item '+(i===ex.index?'active':'')+' '+(ex.answers[x.id]!==undefined&&String(ex.answers[x.id]).length?'answered':'')+' '+(ex.marked.includes(x.id)?'marked':'')+'" data-phase3-action="exam-jump" data-index="'+i+'">'+(i+1)+'</button>').join("");
  let response="";
  if(q.type==="Multiple Choice")response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(answer===o.id?'selected':'')+'"><input type="radio" name="examAnswer" value="'+esc(o.id)+'" '+(answer===o.id?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';
  else if(q.type==="Multiple Select"){const arr=Array.isArray(answer)?answer:[];response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(arr.includes(o.id)?'selected':'')+'"><input type="checkbox" name="examMulti" value="'+esc(o.id)+'" '+(arr.includes(o.id)?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';}
  else response='<textarea id="examWritten" class="exam-response" placeholder="Enter your response here…">'+esc(answer||"")+'</textarea>';

  $("#examRoot").innerHTML='<div class="exam-shell"><header class="exam-header"><div><div class="exam-brand">Θ THEORIA</div><div class="exam-title">'+esc(a.title)+'</div></div><div class="exam-candidate">Candidate <strong>'+esc(ex.submission.candidateNumber)+'</strong></div><div id="examTimer" class="exam-timer">--:--</div></header>'+
    '<div class="exam-body"><aside class="exam-sidebar"><div class="exam-progress">Question '+(ex.index+1)+' of '+ex.questions.length+'</div><div class="exam-navigator">'+nav+'</div><div class="exam-legend"><span>● Answered</span><span>◆ Marked</span></div>'+(ex.submission.accommodationsApplied?.calculator?'<button class="secondary-btn small-btn full-btn" data-phase3-action="calculator">Calculator</button>':'')+'<button class="danger-btn full-btn" data-phase3-action="submit-exam">Submit Assessment</button></aside>'+
    '<main class="exam-question"><div class="exam-question-meta"><span>'+esc((a.parts||[]).find(p=>p.id===q.partId)?.title||"Assessment")+'</span><span>'+esc(q.points)+' points</span></div>'+(q.sourceTitle?'<div class="source-title">'+esc(q.sourceTitle)+'</div>':'')+(q.stimulus?'<div class="exam-stimulus">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<h2>'+esc(q.prompt)+'</h2>'+response+
    '<div class="exam-controls"><button class="secondary-btn" data-phase3-action="mark-question">'+(marked?"Unmark":"Mark for Review")+'</button><div><button class="secondary-btn" data-phase3-action="exam-prev" '+(ex.index===0?'disabled':'')+'>Previous</button><button class="primary-btn" data-phase3-action="exam-next">'+(ex.index===ex.questions.length-1?"Review":"Next")+'</button></div></div></main></div></div>';
  bindExamInputs();
}

function bindExamInputs(){
  const ex=P3.exam,q=ex.questions[ex.index];
  document.querySelectorAll('input[name="examAnswer"]').forEach(x=>x.onchange=()=>{ex.answers[q.id]=x.value;scheduleSave();renderExam();});
  document.querySelectorAll('input[name="examMulti"]').forEach(x=>x.onchange=()=>{ex.answers[q.id]=[...document.querySelectorAll('input[name="examMulti"]:checked')].map(c=>c.value);scheduleSave();renderExam();});
  const w=$("#examWritten");if(w)w.oninput=()=>{ex.answers[q.id]=w.value;scheduleSave();};
}

function scheduleSave(){
  clearTimeout(P3.saveTimer);P3.saveTimer=setTimeout(saveExam,400);
}
async function saveExam(){
  if(!P3.exam)return;
  try{await updateDoc(doc(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid),{answers:P3.exam.answers,marked:P3.exam.marked,currentIndex:P3.exam.index,updatedAt:serverTimestamp()});}catch(_){}
}
async function submitExam(auto=false){
  if(!P3.exam)return;
  if(!auto&&!confirm("Submit this assessment? You will not be able to change your responses afterward."))return;
  await saveExam();
  try{
    await updateDoc(doc(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid),{answers:P3.exam.answers,marked:P3.exam.marked,currentIndex:P3.exam.index,status:"submitted",submittedAt:serverTimestamp(),updatedAt:serverTimestamp()});
    const id=P3.exam.assessment.id;
    clearInterval(P3.timer);document.removeEventListener("visibilitychange",visibilityEvent);window.removeEventListener("beforeunload",unloadEvent);P3.exam=null;receipt(id,auto);
  }catch(err){toast(err.message||"Unable to submit assessment.");}
}

async function receipt(id,auto=false){
  try{
    const [a,s]=await Promise.all([getDoc(doc(db,"assessments",id)),getDoc(doc(db,"assessments",id,"submissions",state().user.uid))]);
    let result=null;try{const r=await getDoc(doc(db,"assessments",id,"results",state().user.uid));if(r.exists())result=r.data();}catch(_){}
    const assessment=a.exists()?a.data():{},sub=s.exists()?s.data():{};
    const domains=result?.partScores?'<div class="receipt-domains"><div class="panel-title">Examination Domain Performance</div>'+Object.values(result.partScores).map(x=>'<div class="blueprint-row"><span>'+esc(x.title)+'</span><strong>'+esc(x.percent)+'%</strong></div>').join("")+'</div>':'';
    core().setPage("exam",assessment.title||"Submission Receipt");
    $("#examRoot").innerHTML='<div class="receipt-shell"><div class="receipt-mark">Θ</div><div class="eyebrow">Examination Receipt</div><h1>'+esc(assessment.title||"Assessment")+'</h1><p>Your response has been recorded'+(auto?" automatically when time expired":"")+'.</p><div class="receipt-grid"><div><span>Candidate Number</span><strong>'+esc(sub.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>'+esc(sub.status||"submitted")+'</strong></div><div><span>Submitted</span><strong>'+esc(dateText(sub.submittedAt))+'</strong></div><div><span>Result</span><strong>'+(result?esc(result.percent)+"%":"Awaiting evaluation")+'</strong></div></div>'+domains+(result?.overallComment?'<div class="academic-banner"><div class="kicker">Instructor Comment</div><p>'+esc(result.overallComment)+'</p></div>':'')+'<button class="primary-btn" data-phase3-action="back-assessments">Return to Assessments</button></div>';
  }catch(_){toast("Unable to load the submission receipt.");}
}

function calculator(){
  const modal=core().openModal({eyebrow:"Assessment Tool",title:"Calculator",body:'<div class="field"><label>Expression</label><input id="calcExpr" placeholder="(12 * 4) / 3"></div><div id="calcResult" class="calculator-result">0</div><button id="calcRun" class="primary-btn">Calculate</button>'});
  modal.querySelector("#calcRun").onclick=()=>{
    const expr=modal.querySelector("#calcExpr").value;if(!/^[0-9+\-*/(). %]+$/.test(expr))return modal.querySelector("#calcResult").textContent="Invalid expression";
    try{modal.querySelector("#calcResult").textContent=String(Function('"use strict";return ('+expr+')')());}catch(_){modal.querySelector("#calcResult").textContent="Invalid expression";}
  };
}

/* -------------------- GRADING -------------------- */

async function createEvaluation(studentId){
  const a=P3.current;
  try{await setDoc(doc(db,"assessments",a.id,"submissions",studentId),{studentId,candidateNumber:newCandidateNumber(),status:"submitted",startedAt:serverTimestamp(),acknowledgedAt:serverTimestamp(),submittedAt:serverTimestamp(),updatedAt:serverTimestamp(),answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:a.questionIds||[],accommodationsApplied:{}},{merge:true});await openAssessment(a.id,"candidates");toast("Evaluation record created.");}catch(err){toast(err.message||"Unable to create evaluation.");}
}

function metrics(a,d,grading){
  const total=Object.values(grading).reduce((n,x)=>n+Number(x.score||0),0),max=Number(a.totalPoints||d.questions.reduce((n,q)=>n+Number(q.points||0),0)),percent=max?Math.round(total/max*1000)/10:0;
  const complete=d.questions.length>0&&d.questions.every(q=>grading[q.id]?.score!==undefined&&grading[q.id]?.score!==null);
  const partScores={};
  (a.parts||[]).forEach(part=>{const qs=d.questions.filter(q=>q.partId===part.id),pm=qs.reduce((n,q)=>n+Number(q.points||0),0),ps=qs.reduce((n,q)=>n+Number(grading[q.id]?.score||0),0);partScores[part.id]={title:part.title,score:ps,max:pm,percent:pm?Math.round(ps/pm*1000)/10:0};});
  return {total,max,percent,complete,partScores};
}

async function persistResult(sub,grading,existing,overallComment=existing?.overallComment||""){
  const d=P3.detail,a=d.assessment,m=metrics(a,d,grading),released=existing?.released||false,batch=writeBatch(db);
  batch.set(doc(db,"assessments",a.id,"results",sub.studentId),{studentId:sub.studentId,candidateNumber:sub.candidateNumber,totalScore:m.total,maxScore:m.max,percent:m.percent,grading,partScores:m.partScores,released,complete:m.complete,overallComment,gradedAt:serverTimestamp(),gradedBy:state().user.uid},{merge:true});
  if(m.complete){
    batch.update(doc(db,"assessments",a.id,"submissions",sub.studentId),{status:"graded",updatedAt:serverTimestamp()});
    batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+sub.studentId),{assessmentId:a.id,assessmentTitle:a.title,assessmentType:a.type,studentId:sub.studentId,score:m.total,maxScore:m.max,percent:m.percent,partScores:m.partScores,released,updatedAt:serverTimestamp()},{merge:true});
  }
  await batch.commit();
}

function gradeCandidate(studentId){
  const d=P3.detail,a=d.assessment,sub=d.submissions.find(x=>x.studentId===studentId);if(!sub)return;
  const existing=d.results.find(x=>x.studentId===studentId),grading=existing?.grading||{},keyMap=new Map(d.keys.map(x=>[x.id,x]));
  const modal=core().openModal({
    eyebrow:"Candidate Evaluation",
    title:a.anonymousGrading!==false?sub.candidateNumber:(d.members.find(x=>x.id===studentId)?.displayName||"Candidate"),
    wide:true,
    body:'<form id="candidateGradeForm"><div class="grading-stack">'+d.questions.map((q,i)=>{
      const key=keyMap.get(q.id),suggested=objective(q.type)?(answerMatches(sub.answers?.[q.id],key?.correctAnswer,q.type)?Number(q.points||0):0):(grading[q.id]?.score??"");
      return '<section class="grading-question"><div class="grading-question-head"><span>Question '+(i+1)+' • '+esc(q.type)+'</span><strong>'+esc(q.points)+' pts</strong></div><h4>'+esc(q.prompt)+'</h4>'+(q.stimulus?'<div class="grading-source">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<div class="candidate-response"><span>Candidate response</span><p>'+esc(Array.isArray(sub.answers?.[q.id])?sub.answers[q.id].join(", "):(sub.answers?.[q.id]||"(No response recorded)"))+'</p></div>'+(objective(q.type)?'<div class="answer-key"><span>Answer key</span><strong>'+esc(Array.isArray(key?.correctAnswer)?key.correctAnswer.join(", "):(key?.correctAnswer||"—"))+'</strong></div>':'')+((key?.rubric||[]).length?'<div class="rubric-display">'+key.rubric.map(r=>'<div><span>'+esc(r.criterion)+'</span><strong>'+esc(r.points)+' pts</strong></div>').join("")+'</div>':'')+'<div class="form-grid"><div class="field"><label>Score</label><input name="score_'+q.id+'" type="number" min="0" max="'+esc(q.points)+'" step="0.5" value="'+esc(suggested)+'" required></div><div class="field"><label>Feedback</label><input name="comment_'+q.id+'" value="'+esc(grading[q.id]?.comment||"")+'"></div></div></section>';
    }).join("")+'</div><div class="field"><label>Overall Instructor Comment</label><textarea name="overallComment">'+esc(existing?.overallComment||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Evaluation</button></div></form>'
  });
  modal.querySelector("#candidateGradeForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),next={};
    d.questions.forEach(q=>next[q.id]={score:Number(fd.get("score_"+q.id)||0),comment:String(fd.get("comment_"+q.id)||"").trim()});
    try{await persistResult(sub,next,existing,String(fd.get("overallComment")||"").trim());core().closeModal();await openAssessment(a.id,"candidates");toast("Evaluation saved.");}catch(err){toast(err.message||"Unable to save evaluation.");}
  });
}

async function autoScore(){
  const d=P3.detail,a=d.assessment,keys=new Map(d.keys.map(x=>[x.id,x])),results=new Map(d.results.map(x=>[x.studentId,x])),subs=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded"),objectiveItems=d.questions.filter(q=>objective(q.type));
  if(!objectiveItems.length)return toast("No objective items to auto-score.");
  if(!subs.length)return toast("No submitted candidates.");
  for(const sub of subs){
    const existing=results.get(sub.studentId),grading={...(existing?.grading||{})};
    objectiveItems.forEach(q=>grading[q.id]={score:answerMatches(sub.answers?.[q.id],keys.get(q.id)?.correctAnswer,q.type)?Number(q.points||0):0,comment:grading[q.id]?.comment||""});
    await persistResult(sub,grading,existing);
  }
  await openAssessment(a.id,"grading");toast("Objective items scored.");
}

function horizontalGrade(questionId){
  const d=P3.detail,a=d.assessment,q=d.questions.find(x=>x.id===questionId),key=d.keys.find(x=>x.id===questionId),subs=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded"),results=new Map(d.results.map(x=>[x.studentId,x]));
  if(!q||!subs.length)return toast("No submitted candidates.");
  const modal=core().openModal({
    eyebrow:"Horizontal Grading",
    title:"Grade Question "+(d.questions.findIndex(x=>x.id===q.id)+1)+" Across Candidates",
    wide:true,
    body:'<form id="horizontalForm"><div class="notice">'+esc(q.prompt)+'</div><div class="horizontal-grade-list">'+subs.map(sub=>{const r=results.get(sub.studentId),score=r?.grading?.[q.id]?.score,suggested=score??(objective(q.type)?(answerMatches(sub.answers?.[q.id],key?.correctAnswer,q.type)?Number(q.points||0):0):"");return '<div class="horizontal-grade-row"><div><strong>'+esc(a.anonymousGrading!==false?sub.candidateNumber:(d.members.find(m=>m.id===sub.studentId)?.displayName||sub.studentId))+'</strong><p>'+esc(Array.isArray(sub.answers?.[q.id])?sub.answers[q.id].join(", "):(sub.answers?.[q.id]||"(No response)"))+'</p></div><div class="field"><label>Score / '+esc(q.points)+'</label><input name="score_'+sub.studentId+'" type="number" min="0" max="'+esc(q.points)+'" step="0.5" value="'+esc(suggested)+'" required></div></div>';}).join("")+'</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Horizontal Grades</button></div></form>'
  });
  modal.querySelector("#horizontalForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{
      for(const sub of subs){const existing=results.get(sub.studentId),grading={...(existing?.grading||{})};grading[q.id]={score:Number(fd.get("score_"+sub.studentId)||0),comment:grading[q.id]?.comment||""};await persistResult(sub,grading,existing);}
      core().closeModal();await openAssessment(a.id,"grading");toast("Horizontal grading saved.");
    }catch(err){toast(err.message||"Unable to save grades.");}
  });
}

async function toggleRelease(studentId){
  const d=P3.detail,a=d.assessment,r=d.results.find(x=>x.studentId===studentId);if(!r)return;
  if(r.complete===false)return toast("Complete grading before releasing this result.");
  const released=!r.released,batch=writeBatch(db);
  batch.update(doc(db,"assessments",a.id,"results",studentId),{released,updatedAt:serverTimestamp()});
  batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+studentId),{released,updatedAt:serverTimestamp()},{merge:true});
  try{await batch.commit();await openAssessment(a.id,"candidates");toast(released?"Result released.":"Result returned to private status.");}catch(err){toast(err.message||"Unable to update release.");}
}

/* -------------------- ROUTING -------------------- */

async function renderSectionTab(tab){
  if(tab==="examinations")return renderSectionAssessments();
  if(tab==="grading")return renderGradingPolicy();
  if(tab==="pathway")return renderStudentPathway();
}

function bind(){
  if(P3.ready)return;P3.ready=true;
  $("#createItemBtn")?.addEventListener("click",()=>itemModal());
  $("#createAssessmentBtn")?.addEventListener("click",()=>assessmentModal());
}

async function onReady(){
  bind();
  if($("#page-itembank")?.classList.contains("active"))await renderItemBank();
  if($("#page-assessments")?.classList.contains("active"))await renderAssessments();
}

window.addEventListener("theoria:ready",onReady);
window.addEventListener("theoria:page",async e=>{
  if(e.detail.page==="itembank")await renderItemBank();
  if(e.detail.page==="assessments")await renderAssessments();
});

document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-phase3-action]");if(!b)return;
  const a=b.dataset.phase3Action;
  if(a==="new-assessment")return assessmentModal();
  if(a==="edit-item")return itemModal(P3.items.find(x=>x.id===b.dataset.id&&x.courseId===b.dataset.course));
  if(a==="open-assessment")return openAssessment(b.dataset.id);
  if(a==="back-assessments"){clearInterval(P3.timer);P3.exam=null;core().setPage("assessments");return renderAssessments();}
  if(a==="assessment-tab")return renderAssessment(b.dataset.tab);
  if(a==="edit-assessment")return assessmentModal(P3.current);
  if(a==="add-items")return addItemsModal();
  if(a==="configure-item")return configureItemModal(b.dataset.id);
  if(a==="remove-item")return removeItem(b.dataset.id);
  if(a==="publish")return setStatus("Published");
  if(a==="close")return setStatus("Closed");
  if(a==="reopen")return setStatus("Published");
  if(a==="start-exam")return startExam(b.dataset.id);
  if(a==="receipt")return receipt(b.dataset.id);
  if(a==="save-pathway")return savePathway();
  if(a==="accommodations")return accommodationsModal(b.dataset.student);
  if(a==="create-evaluation")return createEvaluation(b.dataset.student);
  if(a==="grade-candidate")return gradeCandidate(b.dataset.student);
  if(a==="toggle-release")return toggleRelease(b.dataset.student);
  if(a==="auto-score")return autoScore();
  if(a==="horizontal-grade")return horizontalGrade(b.dataset.question);
  if(a==="exam-jump"){if(P3.exam&&(P3.exam.assessment.backtracking!==false||Number(b.dataset.index)>P3.exam.index)){P3.exam.index=Number(b.dataset.index);scheduleSave();renderExam();}return;}
  if(a==="exam-prev"){if(P3.exam&&P3.exam.index>0&&P3.exam.assessment.backtracking!==false){P3.exam.index--;scheduleSave();renderExam();}return;}
  if(a==="exam-next"){if(!P3.exam)return;P3.exam.index=P3.exam.index<P3.exam.questions.length-1?P3.exam.index+1:0;scheduleSave();renderExam();return;}
  if(a==="mark-question"){if(!P3.exam)return;const id=P3.exam.questions[P3.exam.index].id;P3.exam.marked=P3.exam.marked.includes(id)?P3.exam.marked.filter(x=>x!==id):[...P3.exam.marked,id];scheduleSave();renderExam();return;}
  if(a==="submit-exam")return submitExam(false);
  if(a==="calculator")return calculator();
});

window.TheoriaPhase3={renderSectionTab,renderAssessments,renderItemBank};

if(window.TheoriaCore)onReady();
