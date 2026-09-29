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

function shuffled(values){
  const arr=[...(values||[])];
  for(let i=arr.length-1;i>0;i--){
    let j;
    if(globalThis.crypto?.getRandomValues){
      const n=new Uint32Array(1);crypto.getRandomValues(n);j=n[0]%(i+1);
    }else j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function buildAttemptQuestionOrder(assessment){
  const pool=Array.isArray(assessment.questionPool)&&assessment.questionPool.length
    ? assessment.questionPool
    : (assessment.questionIds||[]).map(id=>({id,type:"Question"}));

  if(assessment.randomDrawEnabled && Array.isArray(assessment.randomDrawPlan) && assessment.randomDrawPlan.length){
    const chosen=[];
    for(const row of assessment.randomDrawPlan){
      const count=Math.max(0,Number(row.count||0));
      if(!count)continue;
      const candidates=pool.filter(q=>q.type===row.type);
      if(candidates.length<count)throw new Error("The assessment pool no longer contains enough "+row.type+" questions for its random draw plan.");
      chosen.push(...shuffled(candidates).slice(0,count).map(q=>q.id));
    }
    return shuffled(chosen);
  }

  const ids=pool.map(q=>q.id);
  return assessment.randomizeQuestions?shuffled(ids):ids;
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

/* -------------------- Question Bank -------------------- */

async function loadItems(){
  const s=state();
  if(!s||s.role!=="instructor")return [];
  const all=[];
  for(const c of s.courses){
    try{
      const snap=await getDocs(collection(db,"courses",c.id,"items"));
      snap.docs.forEach(d=>all.push({id:d.id,courseId:c.id,courseCode:c.code,courseTitle:c.title,...d.data()}));
    }catch(error){
      console.warn("Question Bank unavailable for course:",c.code||c.id,error);
    }
  }
  P3.items=all.sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""))||String(a.prompt||"").localeCompare(String(b.prompt||"")));
  return P3.items;
}

function itemCard(item){
  const course=state()?.courses?.find(c=>c.id===item.courseId);
  const manager=!!course&&core().canManageCourse(course);
  return '<article class="assessment-item-card">'+
    '<div class="item-card-head"><div><div class="card-kicker">'+esc(item.courseCode||"COURSE")+' • '+esc(item.type||"Question")+'</div>'+
    '<h3>'+esc((item.prompt||"Untitled question").slice(0,150))+(String(item.prompt||"").length>150?"…":"")+'</h3></div>'+
    '<span class="badge">'+esc(item.difficulty||"Moderate")+'</span></div>'+
    '<div class="item-tags"><span>'+esc(item.topicNumber||"No topic")+'</span><span>'+esc(item.cognitiveLevel||"Application")+'</span><span>'+esc(item.pointsDefault||1)+' pts</span>'+
    (item.competencyCodes||[]).map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>'+
    '<div class="card-actions">'+(manager?'<button class="secondary-btn small-btn" data-phase3-action="edit-item" data-course="'+item.courseId+'" data-id="'+item.id+'">Edit</button><button class="danger-btn small-btn" data-phase3-action="delete-bank-question" data-course="'+item.courseId+'" data-id="'+item.id+'">Delete</button>':'<span class="badge">Official Question Bank</span>')+'</div></article>';
}

async function renderItemBank(){
  const el=$("#itemBankContent");
  if(!el||state()?.role!=="instructor")return;
  await loadItems();
  const s=state();
  if(!s.courses.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">Q</div><h3>Create a course first.</h3><p>The Question Bank belongs to reusable course frameworks.</p></div>';
    return;
  }

  const frameworks=new Map();
  for(const course of s.courses){
    try{frameworks.set(course.id,await framework(course.id));}
    catch(_){frameworks.set(course.id,{units:[],competencies:[]});}
  }

  el.innerHTML='<div class="academic-banner question-bank-catalog-banner"><div class="kicker">Theoria Master Question Bank</div><h3>Official course questions, ready for assessment design.</h3><p>'+(s.isSystemOwner?'You are viewing the system-authoring bank. Create, import, organize, edit, and maintain official questions here.':'Questions are provided by the Theoria course catalog. You can use them in your own assessment templates without changing the master bank.')+'</p></div><div class="assessment-toolbar"><div class="filter-row">'+
    '<select id="itemCourseFilter"><option value="">All courses</option>'+s.courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select>'+
    '<select id="itemTypeFilter"><option value="">All types</option>'+["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"].map(x=>'<option>'+x+'</option>').join("")+'</select>'+
    '<input id="itemSearch" placeholder="Search prompt, unit, topic, competency, or tag"></div><div class="toolbar-stat"><strong>'+P3.items.length+'</strong><span> reusable questions</span></div></div>'+
    '<div id="itemBankList"></div>';

  const renderCourseGroup=(course,list)=>{
    const fw=frameworks.get(course.id)||{units:[]};
    const groups=core().unitFolderGroups(list,fw);
    const unsortedCount=list.filter(item=>!item.unitId||!fw.units.some(u=>u.id===item.unitId)).length;
    return '<section class="question-course-group"><div class="page-head compact-head question-course-head"><div><div class="panel-title">'+esc(course.code+" — "+course.title)+'</div><p class="page-subtitle">'+list.length+' question'+(list.length===1?"":"s")+' organized by course unit.</p></div>'+
      (list.length&&core().canManageCourse(course)?'<button class="secondary-btn small-btn" data-phase3-action="auto-sort-question-bank" data-course="'+course.id+'">Auto-Sort'+(unsortedCount?' ('+unsortedCount+')':'')+'</button>':'')+
      '</div>'+
      (groups.length?'<div class="unit-folder-stack">'+groups.map((group,index)=>
        '<details class="unit-folder '+(group.id==="unsorted"?'unsorted-folder':'')+'" '+(index===0||group.id==="unsorted"?'open':'')+'>'+
          '<summary><div class="unit-folder-icon">'+(group.id==="unsorted"?'?':esc(group.unit?.order||"U"))+'</div><div><strong>'+esc(group.label)+'</strong><span>'+group.items.length+' question'+(group.items.length===1?"":"s")+'</span></div><div class="unit-folder-chevron">⌄</div></summary>'+
          '<div class="unit-folder-body"><div class="assessment-item-grid">'+group.items.map(itemCard).join("")+'</div></div>'+
        '</details>'
      ).join("")+'</div>':'<div class="empty-mini">No matching questions in this course.</div>')+
    '</section>';
  };

  const filter=()=>{
    const cid=$("#itemCourseFilter").value,type=$("#itemTypeFilter").value,q=$("#itemSearch").value.trim().toLowerCase();
    const list=P3.items.filter(x=>(!cid||x.courseId===cid)&&(!type||x.type===type)&&(!q||[
      x.prompt,x.unitTitle,x.topicTitle,x.topicNumber,(x.competencyCodes||[]).join(" "),(x.tags||[]).join(" ")
    ].join(" ").toLowerCase().includes(q)));

    if(!list.length){
      $("#itemBankList").innerHTML='<div class="empty-state"><div class="empty-symbol">Q</div><h3>No matching questions.</h3><p>Create a new question or adjust the filters.</p></div>';
      return;
    }

    const courses=s.courses.filter(course=>list.some(item=>item.courseId===course.id));
    $("#itemBankList").innerHTML=courses.map(course=>renderCourseGroup(course,list.filter(item=>item.courseId===course.id))).join("");
  };

  $("#itemCourseFilter").addEventListener("change",filter);
  $("#itemTypeFilter").addEventListener("change",filter);
  $("#itemSearch").addEventListener("input",filter);
  filter();
}

async function autoSortQuestionBankModal(courseId){
  const course=state()?.courses?.find(c=>c.id===courseId);
  if(!course)return toast("Course not found.");
  if(!core().canManageCourse(course))return toast("The official Question Bank is managed by the Theoria system owner.");
  const fw=await framework(courseId);
  if(!fw.units.length)return toast("Create course units and topics before using Auto-Sort.");

  const candidates=P3.items.filter(item=>item.courseId===courseId&&(!item.unitId||!fw.units.some(u=>u.id===item.unitId)));
  if(!candidates.length)return toast("Every question in this course is already placed in a unit folder.");

  const suggestions=candidates.map(item=>({item,suggestion:core().suggestFrameworkPlacement(item,fw)}));
  const modal=core().openModal({
    eyebrow:"Question Bank Organization",
    title:"Auto-Sort "+course.code,
    wide:true,
    body:'<div class="auto-sort-intro"><div><strong>'+candidates.length+' unsorted question'+(candidates.length===1?"":"s")+'</strong><span>Theoria compares each question with topic numbers, unit/topic titles, learning objectives, essential knowledge, tags, sources, and competency codes. Review every placement before applying it.</span></div><div class="auto-sort-legend"><span class="confidence exact">Exact</span><span class="confidence high">High</span><span class="confidence medium">Medium</span><span class="confidence low">Low</span></div></div>'+
      '<div class="auto-sort-list">'+suggestions.map(({item,suggestion})=>{
        const confident=suggestion.confidence!=="Low"&&suggestion.unit;
        const selected=confident?(suggestion.topic?"topic:"+suggestion.unit.id+":"+suggestion.topic.id:"unit:"+suggestion.unit.id):"";
        const percent=Math.round(Number(suggestion.score||0)*100);
        return '<div class="auto-sort-row"><div class="auto-sort-copy"><span>'+esc(item.type||"Question")+'</span><strong>'+esc((item.prompt||"Untitled question").slice(0,180))+'</strong><small>'+esc([item.sourceTitle,(item.tags||[]).join(", ")].filter(Boolean).join(" • ")||"No source/tag hints")+'</small></div>'+
          '<div class="auto-sort-confidence"><span class="confidence '+String(suggestion.confidence||"Low").toLowerCase()+'">'+esc(suggestion.confidence||"Low")+'</span><small>'+percent+'% match</small></div>'+
          '<div class="field auto-sort-select"><label>Place in</label><select data-auto-sort-question="'+item.id+'">'+core().frameworkPlacementOptions(fw,selected)+'</select></div></div>';
      }).join("")+'</div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="applyQuestionAutoSort">Apply Selected Placements</button>'
  });

  modal.querySelector("#applyQuestionAutoSort").onclick=async()=>{
    const selections=[...modal.querySelectorAll("[data-auto-sort-question]")].map(select=>({
      id:select.dataset.autoSortQuestion,
      placement:core().placementDataFromValue(select.value,fw)
    })).filter(x=>x.placement);
    if(!selections.length)return toast("Choose at least one Unit or Topic placement.");

    const button=modal.querySelector("#applyQuestionAutoSort");
    button.disabled=true;button.textContent="Sorting…";
    try{
      for(let offset=0;offset<selections.length;offset+=400){
        const batch=writeBatch(db);
        selections.slice(offset,offset+400).forEach(row=>{
          const topicOrder=fw.units.find(u=>u.id===row.placement.unitId)?.topics?.find(t=>t.id===row.placement.topicId)?.order||0;
          batch.update(doc(db,"courses",courseId,"items",row.id),{
            ...row.placement,
            unitSequence:Number(topicOrder||0),
            autoSortedAt:serverTimestamp(),
            updatedAt:serverTimestamp()
          });
        });
        await batch.commit();
      }
      core().closeModal();
      await renderItemBank();
      toast(selections.length+" question"+(selections.length===1?"":"s")+" sorted into unit folders.");
    }catch(error){
      button.disabled=false;button.textContent="Apply Selected Placements";
      toast(error.message||"Unable to sort Question Bank questions.");
    }
  };
}


function stripJsonFence(text){
  let value=String(text||"").trim();
  value=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const firstArray=value.indexOf("["),lastArray=value.lastIndexOf("]");
  const firstObject=value.indexOf("{"),lastObject=value.lastIndexOf("}");
  if(firstArray>=0&&lastArray>firstArray)return value.slice(firstArray,lastArray+1);
  if(firstObject>=0&&lastObject>firstObject)return value.slice(firstObject,lastObject+1);
  return value;
}

function normalizeBulkType(value){
  const raw=String(value||"").trim().toLowerCase();
  const aliases={
    "mcq":"Multiple Choice","multiple choice":"Multiple Choice","multiple-choice":"Multiple Choice",
    "multiple select":"Multiple Select","multiple-select":"Multiple Select","select all that apply":"Multiple Select","msq":"Multiple Select",
    "short response":"Short Response","short answer":"Short Response","short-response":"Short Response",
    "essay":"Essay",
    "passage analysis":"Passage Analysis","scripture analysis":"Passage Analysis",
    "primary source analysis":"Primary Source Analysis","source analysis":"Primary Source Analysis",
    "argument analysis":"Argument Analysis",
    "oral prompt":"Oral Prompt","oral":"Oral Prompt",
    "disputation prompt":"Disputation Prompt","disputation":"Disputation Prompt"
  };
  return aliases[raw]||String(value||"").trim();
}

function bulkPromptForCourse(course,fw){
  const topicLines=[];
  for(const unit of fw.units){
    for(const topic of unit.topics||[]){
      topicLines.push((topic.number||topic.id)+" — "+topic.title);
    }
  }
  const competencyLines=(fw.competencies||[]).map(c=>c.code+" — "+c.name);
  return [
    "Create a question set for Theoria for the course: "+(course.code||"")+" — "+(course.title||"")+".",
    "",
    "Return ONLY valid JSON. Do not use Markdown fences, commentary, headings, or explanatory prose.",
    "Return either a JSON array of question objects or an object with a single \"questions\" array.",
    "",
    "Each question object may use these fields:",
    "{",
    '  "type": "Multiple Choice | Multiple Select | Short Response | Essay | Passage Analysis | Primary Source Analysis | Argument Analysis | Oral Prompt | Disputation Prompt",',
    '  "prompt": "question text",',
    '  "options": ["first option", "second option", "third option", "fourth option"],',
    '  "correctAnswer": "A",',
    '  "difficulty": "Foundational | Moderate | Advanced",',
    '  "cognitiveLevel": "Recall | Understanding | Application | Analysis | Evaluation | Synthesis",',
    '  "pointsDefault": 1,',
    '  "topicNumber": "1.1",',
    '  "competencyCodes": ["ARG-3"],',
    '  "tags": ["tag-one", "tag-two"],',
    '  "sourceTitle": "optional source/citation",',
    '  "sourceSet": "optional source-set name",',
    '  "stimulus": "optional excerpt or source text",',
    '  "explanation": "answer-key explanation or scoring guidance",',
    '  "rubric": [{"criterion":"criterion name","points":4}]',
    "}",
    "",
    "Rules:",
    "- Multiple Choice must include at least 2 options and exactly one correctAnswer letter.",
    "- Multiple Select must include at least 2 options and correctAnswer must be an array of letters, such as [\"A\",\"C\"].",
    "- For non-objective questions, omit options and correctAnswer unless genuinely needed.",
    "- Use only the topic numbers and competency codes listed below when assigning them.",
    "- Keep points consistent within question types if the questions may be used in randomized exams.",
    "",
    "AVAILABLE TOPICS:",
    ...(topicLines.length?topicLines:["No topics are currently defined. Leave topicNumber empty."]),
    "",
    "AVAILABLE COMPETENCIES:",
    ...(competencyLines.length?competencyLines:["No competencies are currently defined. Leave competencyCodes empty."])
  ].join("\n");
}

function normalizeBulkQuestion(raw,index,fw){
  const errors=[],warnings=[];
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return {index,errors:["Question is not a JSON object."],warnings:[],data:null};

  const type=normalizeBulkType(raw.type);
  const allowedTypes=["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"];
  if(!allowedTypes.includes(type))errors.push("Unsupported question type: "+String(raw.type||"(missing)"));

  const prompt=String(raw.prompt||raw.question||"").trim();
  if(!prompt)errors.push("Prompt is required.");

  const difficultyAllowed=["Foundational","Moderate","Advanced"];
  const difficulty=difficultyAllowed.includes(String(raw.difficulty||""))?String(raw.difficulty):"Moderate";
  if(raw.difficulty&&!difficultyAllowed.includes(String(raw.difficulty)))warnings.push("Difficulty defaulted to Moderate.");

  const cognitiveAllowed=["Recall","Understanding","Application","Analysis","Evaluation","Synthesis"];
  const cognitiveLevel=cognitiveAllowed.includes(String(raw.cognitiveLevel||""))?String(raw.cognitiveLevel):"Application";
  if(raw.cognitiveLevel&&!cognitiveAllowed.includes(String(raw.cognitiveLevel)))warnings.push("Cognitive level defaulted to Application.");

  const pointsRaw=Number(raw.pointsDefault??raw.points??1);
  const pointsDefault=Number.isFinite(pointsRaw)&&pointsRaw>=0?pointsRaw:1;
  if(!Number.isFinite(pointsRaw)||pointsRaw<0)warnings.push("Points defaulted to 1.");

  let options=Array.isArray(raw.options)?raw.options.map((option,i)=>{
    if(option&&typeof option==="object")return {id:String(option.id||String.fromCharCode(65+i)).toUpperCase(),text:String(option.text??option.label??"").trim()};
    return {id:String.fromCharCode(65+i),text:String(option??"").trim()};
  }).filter(x=>x.text):[];

  let correctAnswer=raw.correctAnswer??raw.answer??"";
  const resolveAnswer=value=>{
    const v=String(value??"").trim();
    if(!v)return "";
    const upper=v.toUpperCase();
    if(/^[A-Z]$/.test(upper))return upper;
    const match=options.find(o=>o.text.trim().toLowerCase()===v.toLowerCase());
    return match?.id||upper;
  };

  if(type==="Multiple Choice"){
    if(options.length<2)errors.push("Multiple Choice requires at least 2 options.");
    correctAnswer=resolveAnswer(Array.isArray(correctAnswer)?correctAnswer[0]:correctAnswer);
    if(!correctAnswer)errors.push("Multiple Choice requires a correct answer.");
    if(correctAnswer&&!options.some(o=>o.id===correctAnswer))errors.push("Correct answer does not match an option.");
  }else if(type==="Multiple Select"){
    if(options.length<2)errors.push("Multiple Select requires at least 2 options.");
    const arr=(Array.isArray(correctAnswer)?correctAnswer:String(correctAnswer||"").split(",")).map(resolveAnswer).filter(Boolean);
    correctAnswer=[...new Set(arr)].sort();
    if(!correctAnswer.length)errors.push("Multiple Select requires at least one correct answer.");
    if(correctAnswer.some(id=>!options.some(o=>o.id===id)))errors.push("One or more correct answers do not match an option.");
  }else{
    options=[];
    correctAnswer="";
  }

  const topicNumber=String(raw.topicNumber||raw.topic||"").trim();
  let matchedTopic=null,matchedUnit=null;
  if(topicNumber){
    for(const unit of fw.units){
      const topic=(unit.topics||[]).find(t=>String(t.number||"").trim().toLowerCase()===topicNumber.toLowerCase());
      if(topic){matchedTopic=topic;matchedUnit=unit;break;}
    }
    if(!matchedTopic)warnings.push("Topic "+topicNumber+" was not found and will be left unassigned.");
  }

  let competencyCodes=Array.isArray(raw.competencyCodes)?raw.competencyCodes:String(raw.competencyCodes||"").split(",");
  competencyCodes=competencyCodes.map(x=>String(x).trim().toUpperCase()).filter(Boolean);
  const competencyMap=new Map((fw.competencies||[]).map(c=>[String(c.code||"").trim().toUpperCase(),c]));
  const matchedCompetencies=competencyCodes.map(code=>competencyMap.get(code)).filter(Boolean);
  const unknownCodes=competencyCodes.filter(code=>!competencyMap.has(code));
  if(unknownCodes.length)warnings.push("Unknown competencies ignored: "+unknownCodes.join(", "));

  let tags=Array.isArray(raw.tags)?raw.tags:String(raw.tags||"").split(",");
  tags=tags.map(x=>String(x).trim()).filter(Boolean);

  const rubric=Array.isArray(raw.rubric)?raw.rubric.map(row=>({
    criterion:String(row?.criterion||row?.name||"").trim(),
    points:Number(row?.points||0)
  })).filter(row=>row.criterion):[];

  return {
    index,errors,warnings,
    data:{
      type,difficulty,cognitiveLevel,
      unitId:matchedUnit?.id||"",unitTitle:matchedUnit?.title||"",unitNumber:Number(matchedUnit?.order||0),
      topicId:matchedTopic?.id||"",topicTitle:matchedTopic?.title||"",topicNumber:matchedTopic?.number||"",
      competencyIds:matchedCompetencies.map(c=>c.id),
      competencyCodes:matchedCompetencies.map(c=>c.code),
      pointsDefault,tags,
      sourceTitle:String(raw.sourceTitle||"").trim(),
      sourceSet:String(raw.sourceSet||"").trim(),
      stimulus:String(raw.stimulus||"").trim(),
      prompt,options,correctAnswer,
      explanation:String(raw.explanation||"").trim(),
      rubric
    }
  };
}

async function bulkImportQuestionsModal(){
  const s=state();
  const manageable=(s?.courses||[]).filter(c=>core().canManageCourse(c));
  if(!manageable.length)return toast("Only the Theoria system owner can import questions into the official Question Bank.");

  let selectedCourse=manageable[0];
  let fw=await framework(selectedCourse.id);
  let parsedRows=[];

  const modal=core().openModal({
    eyebrow:"Question Bank",
    title:"Bulk Import Questions",
    wide:true,
    body:'<div class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Choose Course</h3><p>Theoria maps imported topic numbers and competency codes against this course framework.</p></div></div><div class="field"><label>Course</label><select id="bulkImportCourse">'+manageable.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select></div><div class="bulk-import-prompt-row"><div><strong>Generate in ChatGPT</strong><span>Copy a course-aware prompt that tells ChatGPT exactly how to format the full question set.</span></div><button type="button" class="secondary-btn" id="copyBulkPrompt">Copy ChatGPT Import Prompt</button></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Add Question Set</h3><p>Paste one complete JSON set from ChatGPT or upload a .json file. You do not need to paste questions individually.</p></div></div><div class="compact-field-grid"><div class="field"><label>JSON File</label><input id="bulkQuestionFile" type="file" accept=".json,application/json"></div><div class="field"><label>Expected Format</label><div class="static-field">JSON array or {"questions":[...]}</div></div></div><div class="field"><label>Paste Complete Question Set</label><textarea id="bulkQuestionJson" class="bulk-json-editor" spellcheck="false" placeholder="Paste the complete JSON question set here"></textarea></div><button type="button" class="primary-btn" id="previewBulkQuestions">Validate & Preview</button></section>'+
      '<section class="form-section" id="bulkPreviewSection"><div class="form-section-head"><div><span>03</span><h3>Import Preview</h3><p>Nothing is saved until you confirm the import.</p></div><div id="bulkPreviewSummary"></div></div><div id="bulkPreviewResults"><div class="empty-mini">Paste or upload a question set, then validate it.</div></div></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button type="button" class="primary-btn" id="importBulkQuestions" disabled>Import Questions</button></div></div>'
  });

  const courseSelect=modal.querySelector("#bulkImportCourse");
  const textarea=modal.querySelector("#bulkQuestionJson");
  const fileInput=modal.querySelector("#bulkQuestionFile");
  const summary=modal.querySelector("#bulkPreviewSummary");
  const results=modal.querySelector("#bulkPreviewResults");
  const importButton=modal.querySelector("#importBulkQuestions");

  const resetPreview=()=>{
    parsedRows=[];summary.innerHTML="";results.innerHTML='<div class="empty-mini">Validate the current question set before importing.</div>';importButton.disabled=true;importButton.textContent="Import Questions";
  };

  courseSelect.addEventListener("change",async()=>{
    selectedCourse=s.courses.find(c=>c.id===courseSelect.value)||s.courses[0];
    fw=await framework(selectedCourse.id);
    resetPreview();
  });

  modal.querySelector("#copyBulkPrompt").addEventListener("click",async()=>{
    const prompt=bulkPromptForCourse(selectedCourse,fw);
    try{
      await navigator.clipboard.writeText(prompt);
      toast("Course-aware ChatGPT import prompt copied.");
    }catch(_){
      textarea.value=prompt;
      toast("Clipboard access was unavailable, so the prompt was placed in the editor.");
    }
  });

  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files?.[0];if(!file)return;
    try{textarea.value=await file.text();resetPreview();}catch(_){toast("The JSON file could not be read.");}
  });

  modal.querySelector("#previewBulkQuestions").addEventListener("click",()=>{
    let payload;
    try{
      const parsed=JSON.parse(stripJsonFence(textarea.value));
      payload=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.questions)?parsed.questions:null);
      if(!payload)throw new Error("Expected a JSON array or an object with a questions array.");
    }catch(error){
      parsedRows=[];summary.innerHTML='<span class="badge danger">Invalid JSON</span>';results.innerHTML='<div class="notice danger-notice">'+esc(error.message||"The question set is not valid JSON.")+'</div>';importButton.disabled=true;return;
    }

    parsedRows=payload.map((row,index)=>normalizeBulkQuestion(row,index,fw));
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    const invalid=parsedRows.filter(row=>row.errors.length);
    const warnings=parsedRows.filter(row=>row.warnings.length);
    summary.innerHTML='<div class="bulk-preview-counts"><span><strong>'+valid.length+'</strong> valid</span><span><strong>'+invalid.length+'</strong> invalid</span><span><strong>'+warnings.length+'</strong> warnings</span></div>';

    results.innerHTML=parsedRows.length?'<div class="bulk-preview-list">'+parsedRows.map(row=>
      '<div class="bulk-preview-row '+(row.errors.length?'invalid':row.warnings.length?'warning':'valid')+'"><div class="bulk-preview-number">'+(row.index+1)+'</div><div><strong>'+esc(row.data?.prompt||"Invalid question")+'</strong><span>'+esc(row.data?.type||"")+(row.data?.topicNumber?' • Topic '+esc(row.data.topicNumber):'')+'</span>'+
      (row.errors.length?'<div class="bulk-messages errors">'+row.errors.map(x=>'<div>✕ '+esc(x)+'</div>').join("")+'</div>':'')+
      (row.warnings.length?'<div class="bulk-messages warnings">'+row.warnings.map(x=>'<div>! '+esc(x)+'</div>').join("")+'</div>':'')+
      '</div></div>'
    ).join("")+'</div>':'<div class="empty-mini">No questions were found in the JSON.</div>';

    importButton.disabled=!valid.length;
    importButton.textContent=valid.length?"Import "+valid.length+" Valid Question"+(valid.length===1?"":"s"):"Import Questions";
  });

  importButton.addEventListener("click",async()=>{
    const valid=parsedRows.filter(row=>row.data&&!row.errors.length);
    if(!valid.length)return;
    importButton.disabled=true;importButton.textContent="Importing…";
    try{
      for(let offset=0;offset<valid.length;offset+=400){
        const batch=writeBatch(db);
        valid.slice(offset,offset+400).forEach(row=>{
          const ref=doc(collection(db,"courses",selectedCourse.id,"items"));
          batch.set(ref,{
            ownerId:s.user.uid,
            courseId:selectedCourse.id,
            ...row.data,
            createdAt:serverTimestamp(),
            updatedAt:serverTimestamp()
          });
        });
        await batch.commit();
      }
      core().closeModal();
      await renderItemBank();
      const skipped=parsedRows.length-valid.length;
      toast(valid.length+" question"+(valid.length===1?"":"s")+" imported"+(skipped?" • "+skipped+" invalid skipped":"")+".");
    }catch(error){
      importButton.disabled=false;importButton.textContent="Import "+valid.length+" Valid Question"+(valid.length===1?"":"s");
      toast(error.message||"Unable to import the question set.");
    }
  });
}

async function deleteBankQuestion(courseId,itemId){
  const course=state()?.courses?.find(c=>c.id===courseId);
  if(!course||!core().canManageCourse(course))return toast("The official Question Bank is managed by the Theoria system owner.");
  const item=P3.items.find(x=>x.courseId===courseId&&x.id===itemId);
  if(!item)return toast("Question not found.");
  const modal=core().openModal({
    eyebrow:"Delete Question",
    title:"Remove from Question Bank",
    body:'<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>This removes the reusable Question Bank copy.</strong><p>Assessments that already copied this question keep their existing snapshot and answer key. Future assessments will no longer be able to select it from the bank.</p></div></div>'+
      '<div class="question-delete-preview"><span>'+esc(item.type||"Question")+'</span><strong>'+esc(item.prompt||"Untitled question")+'</strong><small>'+esc(item.courseCode||"Course")+' • '+esc(item.pointsDefault||1)+' pts</small></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteBankQuestion">Delete Question</button>'
  });
  modal.querySelector("#confirmDeleteBankQuestion").onclick=async()=>{
    try{
      await deleteDoc(doc(db,"courses",courseId,"items",itemId));
      core().closeModal();await renderItemBank();toast("Question deleted from the Question Bank.");
    }catch(err){toast(err.message||"Unable to delete the question.");}
  };
}

async function itemModal(existing){
  const s=state();
  const manageable=(s?.courses||[]).filter(c=>core().canManageCourse(c));
  if(!manageable.length)return toast("Only the Theoria system owner can author the official Question Bank.");
  let courseId=existing?.courseId||manageable[0].id;
  const selectedManagedCourse=s.courses.find(c=>c.id===courseId);
  if(!selectedManagedCourse||!core().canManageCourse(selectedManagedCourse))return toast("This official Question Bank is read-only for instructors.");
  let fw=await framework(courseId);
  const types=["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"];
  const currentType=existing?.type||"Multiple Choice";
  const typeTiles=types.map((type,i)=>'<label class="type-tile '+(currentType===type?'selected':'')+'"><input type="radio" name="type" value="'+esc(type)+'" '+(currentType===type?'checked':'')+'><span class="type-tile-mark">'+String(i+1).padStart(2,"0")+'</span><span>'+esc(type)+'</span></label>').join("");

  const modal=core().openModal({
    eyebrow:"Question Bank",
    title:existing?"Edit Question":"Create Question",
    wide:true,
    body:'<form id="itemForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Item Identity</h3><p>Place the question inside the course framework.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Course</label><select name="courseId" id="itemCourse" '+(existing?'disabled':'')+'>'+manageable.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select></div>'+
        '<div class="field"><label>Difficulty</label><select name="difficulty"><option>Foundational</option><option>Moderate</option><option>Advanced</option></select></div>'+
        '<div class="field"><label>Cognitive Level</label><select name="cognitiveLevel"><option>Recall</option><option>Understanding</option><option>Application</option><option>Analysis</option><option>Evaluation</option><option>Synthesis</option></select></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Unit</label><select name="unitId" id="itemUnit"></select></div><div class="field"><label>Topic</label><select name="topicId" id="itemTopic"></select></div><div class="field"><label>Default Points</label><div class="input-with-suffix"><input name="pointsDefault" type="number" min="0" step="0.5" value="'+esc(existing?.pointsDefault??1)+'"><span>pts</span></div></div></div>'+
        '<div class="field"><label>Question Type</label><div class="type-tile-grid compact">'+typeTiles+'</div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Question</h3><p>Write the prompt cleanly; add source material only when the item needs it.</p></div></div>'+
        '<div class="field"><label>Prompt</label><textarea class="editor-compact" rows="3" name="prompt" placeholder="What should the student analyze, explain, defend, or identify?" required>'+esc(existing?.prompt||"")+'</textarea></div>'+
        '<details class="form-disclosure" '+((existing?.stimulus||existing?.sourceTitle)?'open':'')+'><summary><span>Add source or stimulus</span><small>Optional passage, quotation, argument, or primary source</small></summary><div class="disclosure-body"><div class="field"><label>Source Title / Citation</label><input name="sourceTitle" value="'+esc(existing?.sourceTitle||"")+'" placeholder="Athanasius, On the Incarnation §8"></div><div class="field"><label>Source Text</label><textarea class="editor-compact source-editor" rows="4" name="stimulus" placeholder="Paste only the excerpt students need for this item.">'+esc(existing?.stimulus||"")+'</textarea></div><div class="field"><label>Source Set / Group</label><input name="sourceSet" value="'+esc(existing?.sourceSet||"")+'" placeholder="Nicene Controversy Set"></div></div></details>'+
      '</section>'+
      '<section class="form-section" id="objectiveAnswerSection"><div class="form-section-head"><div><span>03</span><h3>Answer Choices</h3><p>Add choices individually and mark the correct answer directly.</p></div><button type="button" class="secondary-btn small-btn" id="addAnswerOption">+ Add Choice</button></div><div id="answerOptionRows" class="structured-list answer-option-list"></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>04</span><h3>Scoring & Explanation</h3><p>Build a rubric with real rows instead of encoded text.</p></div></div>'+
        '<div class="structured-builder"><div class="structured-builder-head"><div><strong>Rubric Criteria</strong><span>Most useful for written, oral, and analytical items.</span></div><button type="button" class="secondary-btn small-btn" id="addRubricCriterion">+ Add Criterion</button></div><div id="rubricRows" class="structured-list"></div></div>'+
        '<div class="field"><label>Instructor Explanation / Key Notes</label><textarea class="editor-compact" rows="3" name="explanation" placeholder="Why is the answer correct, or what should a strong response demonstrate?">'+esc(existing?.explanation||"")+'</textarea></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>05</span><h3>Academic Mapping</h3><p>Tag the item for analytics and mastery evidence.</p></div></div>'+
        '<div class="field"><label>Academic Competencies</label><div id="itemCompetencies" class="competency-picker"></div></div>'+
        '<div class="field"><label>Tags</label><input name="tags" value="'+esc((existing?.tags||[]).join(", "))+'" placeholder="christology, primary-source, final-review"></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Question</button></div></form>'
  });

  const form=modal.querySelector("#itemForm");
  form.courseId.value=courseId;
  form.difficulty.value=existing?.difficulty||"Moderate";
  form.cognitiveLevel.value=existing?.cognitiveLevel||"Application";

  let optionSeed=(existing?.options||[]).map(x=>x.text||x);
  if(!optionSeed.length&&objective(currentType))optionSeed=["","","",""];
  const existingCorrect=new Set(Array.isArray(existing?.correctAnswer)?existing.correctAnswer:[existing?.correctAnswer].filter(Boolean));
  const optionBox=modal.querySelector("#answerOptionRows");
  const rubricBox=modal.querySelector("#rubricRows");

  const renumberOptions=()=>{
    [...optionBox.querySelectorAll(".answer-option-row")].forEach((row,i)=>{
      const id=String.fromCharCode(65+i);
      row.dataset.optionId=id;
      row.querySelector(".answer-letter").textContent=id;
      row.querySelector(".option-correct").value=id;
    });
  };
  const addOption=(value="",checked=false)=>{
    const row=document.createElement("div");
    row.className="answer-option-row";
    row.innerHTML='<div class="answer-letter">A</div><input class="structured-input option-text" value="'+esc(value)+'" placeholder="Answer choice"><label class="correct-control"><input class="option-correct" type="checkbox" '+(checked?'checked':'')+'><span>Correct</span></label><button type="button" class="row-remove" aria-label="Remove">×</button>';
    row.querySelector(".row-remove").addEventListener("click",()=>{row.remove();renumberOptions();});
    row.querySelector(".option-correct").addEventListener("change",e=>{
      const multi=form.querySelector('input[name="type"]:checked')?.value==="Multiple Select";
      if(e.target.checked&&!multi)optionBox.querySelectorAll(".option-correct").forEach(x=>{if(x!==e.target)x.checked=false;});
    });
    optionBox.appendChild(row);renumberOptions();
  };
  optionSeed.forEach((text,i)=>addOption(text,existingCorrect.has(String.fromCharCode(65+i))));

  const addRubric=(criterion="",points="")=>{
    const row=document.createElement("div");
    row.className="structured-row rubric-row";
    row.innerHTML='<div class="structured-index">•</div><input class="structured-input rubric-criterion" value="'+esc(criterion)+'" placeholder="Criterion, e.g. Theological synthesis"><div class="input-with-suffix mini"><input class="rubric-points" type="number" min="0" step="0.5" value="'+esc(points)+'"><span>pts</span></div><button type="button" class="row-remove" aria-label="Remove">×</button>';
    row.querySelector(".row-remove").addEventListener("click",()=>row.remove());
    rubricBox.appendChild(row);
  };
  (existing?.rubric||[]).forEach(r=>addRubric(r.criterion,r.points));

  const updateTypeUI=()=>{
    const type=form.querySelector('input[name="type"]:checked')?.value||"Multiple Choice";
    modal.querySelectorAll(".type-tile").forEach(tile=>tile.classList.toggle("selected",tile.querySelector("input").checked));
    modal.querySelector("#objectiveAnswerSection").classList.toggle("hidden",!objective(type));
    if(objective(type)&&!optionBox.children.length)["","","",""].forEach(()=>addOption());
    if(type==="Multiple Choice"){
      const checked=[...optionBox.querySelectorAll(".option-correct:checked")];
      checked.slice(1).forEach(x=>x.checked=false);
    }
  };
  modal.querySelectorAll('input[name="type"]').forEach(x=>x.addEventListener("change",updateTypeUI));
  modal.querySelector("#addAnswerOption").addEventListener("click",()=>addOption());
  modal.querySelector("#addRubricCriterion").addEventListener("click",()=>addRubric());
  updateTypeUI();

  const populate=async(id)=>{
    courseId=id;fw=await framework(id);
    const unit=form.querySelector("#itemUnit"),topic=form.querySelector("#itemTopic");
    unit.innerHTML='<option value="">Unassigned</option>'+fw.units.map(u=>'<option value="'+u.id+'">'+esc("Unit "+(u.order||"")+" — "+u.title)+'</option>').join("");
    unit.value=existing?.unitId||"";
    const fillTopics=()=>{
      const u=fw.units.find(x=>x.id===unit.value);
      topic.innerHTML='<option value="">Unassigned</option>'+((u?.topics||[]).map(t=>'<option value="'+t.id+'">'+esc((t.number||"")+" — "+t.title)+'</option>').join(""));
      topic.value=existing?.topicId||"";
    };
    unit.onchange=fillTopics;fillTopics();
    form.querySelector("#itemCompetencies").innerHTML=fw.competencies.length?fw.competencies.map(c=>'<label class="competency-choice"><input type="checkbox" name="competency" value="'+c.id+'" data-code="'+esc(c.code)+'" '+((existing?.competencyIds||[]).includes(c.id)?'checked':'')+'><span><strong>'+esc(c.code)+'</strong>'+esc(c.name)+'</span></label>').join(""):'<div class="empty-mini">No competencies created for this course.</div>';
  };
  if(!existing)form.querySelector("#itemCourse").addEventListener("change",e=>populate(e.target.value));
  await populate(courseId);

  form.querySelectorAll(".editor-compact").forEach(area=>{
    const grow=()=>{area.style.height="auto";area.style.height=Math.min(area.scrollHeight,240)+"px";};
    area.addEventListener("input",grow);grow();
  });

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form),cid=existing?.courseId||String(fd.get("courseId"));
    const unit=fw.units.find(x=>x.id===String(fd.get("unitId"))),topic=unit?.topics?.find(x=>x.id===String(fd.get("topicId")));
    const type=form.querySelector('input[name="type"]:checked')?.value||"Multiple Choice";
    const optionRows=[...optionBox.querySelectorAll(".answer-option-row")];
    const options=objective(type)?optionRows.map((row,i)=>({id:String.fromCharCode(65+i),text:row.querySelector(".option-text").value.trim()})).filter(x=>x.text):[];
    const checked=optionRows.filter(row=>row.querySelector(".option-correct").checked).map(row=>row.dataset.optionId);
    if(type==="Multiple Choice"&&options.length<2)return toast("Add at least two answer choices.");
    if(type==="Multiple Select"&&options.length<2)return toast("Add at least two answer choices.");
    if(objective(type)&&!checked.length)return toast("Mark at least one correct answer.");
    const selected=[...form.querySelectorAll('input[name="competency"]:checked')];
    const rubric=[...rubricBox.querySelectorAll(".rubric-row")].map(row=>({criterion:row.querySelector(".rubric-criterion").value.trim(),points:Number(row.querySelector(".rubric-points").value||0)})).filter(x=>x.criterion);
    const data={
      ownerId:s.user.uid,courseId:cid,type,
      difficulty:String(fd.get("difficulty")),cognitiveLevel:String(fd.get("cognitiveLevel")),
      unitId:unit?.id||"",unitTitle:unit?.title||"",unitNumber:Number(unit?.order||0),topicId:topic?.id||"",topicTitle:topic?.title||"",topicNumber:topic?.number||"",
      competencyIds:selected.map(x=>x.value),competencyCodes:selected.map(x=>x.dataset.code),
      pointsDefault:Number(fd.get("pointsDefault")||1),tags:String(fd.get("tags")||"").split(",").map(x=>x.trim()).filter(Boolean),
      sourceTitle:String(fd.get("sourceTitle")||"").trim(),sourceSet:String(fd.get("sourceSet")||"").trim(),stimulus:String(fd.get("stimulus")||"").trim(),
      prompt:String(fd.get("prompt")||"").trim(),options,
      correctAnswer:type==="Multiple Select"?checked.sort():(checked[0]||""),
      explanation:String(fd.get("explanation")||"").trim(),rubric,updatedAt:serverTimestamp()
    };
    try{
      if(existing)await updateDoc(doc(db,"courses",cid,"items",existing.id),data);
      else await addDoc(collection(db,"courses",cid,"items"),{...data,createdAt:serverTimestamp()});
      core().closeModal();await renderItemBank();toast(existing?"Question updated.":"Question created.");
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

function safeArray(value){
  return Array.isArray(value)?value:[];
}

function cachedAssessment(id){
  if(P3.current?.id===id)return P3.current;
  return P3.assessments.find(a=>a.id===id)||null;
}

function assessmentTypeSummary(a){
  const drawPlan=safeArray(a?.randomDrawPlan);
  if(a?.randomDrawEnabled&&drawPlan.length){
    return drawPlan.filter(row=>Number(row?.count||0)>0).map(row=>({
      type:row?.type||"Question",
      count:Number(row?.count||0),
      available:Number(row?.available||0),
      randomized:true
    }));
  }
  const counts=new Map();
  for(const q of safeArray(a?.questionPool)){
    const type=String(q?.type||"Question");
    counts.set(type,(counts.get(type)||0)+1);
  }
  if(counts.size)return [...counts.entries()].map(([type,count])=>({type,count,available:count,randomized:false}));
  return Number(a?.questionCount||0)>0?[{type:"Questions",count:Number(a.questionCount||0),available:Number(a.questionCount||0),randomized:false}]:[];
}

function assessmentStudentDetailsBody(a){
  const types=assessmentTypeSummary(a);
  const instructions=safeArray(a?.instructionSteps).length?safeArray(a.instructionSteps):String(a?.instructions||"").split("\n").map(x=>x.trim()).filter(Boolean);
  const content=safeArray(a?.contentBlueprint).filter(x=>Number(x?.weight||0)>0);
  const competencies=safeArray(a?.competencyBlueprint).filter(x=>Number(x?.weight||0)>0);
  const parts=safeArray(a?.parts).filter(x=>Number(x?.weight||0)>0);

  return '<div class="student-assessment-preview">'+
    '<div class="assessment-preview-guard"><div class="preview-lock">Θ</div><div><strong>Assessment contents only</strong><span>Question prompts, passages, answer choices, and answer keys remain hidden until the assessment is legitimately opened.</span></div></div>'+
    '<div class="assessment-preview-summary"><div><span>Status</span><strong>'+esc(availability(a))+'</strong></div><div><span>Questions</span><strong>'+esc(a.questionCount||0)+'</strong></div><div><span>Points</span><strong>'+esc(a.totalPoints||0)+'</strong></div><div><span>Duration</span><strong>'+esc(a.durationMinutes||0)+' min</strong></div></div>'+
    '<section class="student-preview-section"><div class="panel-title">Schedule</div><div class="detail-list"><div><span>Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div></div></section>'+
    '<section class="student-preview-section"><div class="panel-title">Question Types</div>'+
      (types.length?'<div class="assessment-type-breakdown">'+types.map(row=>'<div><span>'+esc(row.type)+'</span><strong>'+esc(row.count)+'</strong><small>'+(row.randomized?(row.available?esc(row.available)+' available in pool • ':'')+'random draw':'on assessment')+'</small></div>').join("")+'</div>':'<div class="empty-mini">Question-type details are not available for this legacy assessment.</div>')+
    '</section>'+
    (parts.length?'<section class="student-preview-section"><div class="panel-title">Assessment Parts</div><div class="preview-blueprint-list">'+parts.map(row=>'<div><span>'+esc(row.title||row.label||"Assessment Part")+'</span><strong>'+esc(row.weight||0)+'%</strong></div>').join("")+'</div></section>':'')+
    (content.length?'<section class="student-preview-section"><div class="panel-title">Content Coverage</div><div class="preview-blueprint-list">'+content.map(row=>'<div><span>'+esc(row.label||row.title||"Content Area")+'</span><strong>'+esc(row.weight||0)+'%</strong></div>').join("")+'</div></section>':'')+
    (competencies.length?'<section class="student-preview-section"><div class="panel-title">Competency Emphasis</div><div class="preview-blueprint-list">'+competencies.map(row=>'<div><span>'+esc(row.label||row.title||"Competency")+'</span><strong>'+esc(row.weight||0)+'%</strong></div>').join("")+'</div></section>':'')+
    (instructions.length?'<section class="student-preview-section"><div class="panel-title">Student Instructions</div><div class="preview-instructions">'+instructions.map((step,i)=>'<div><span>'+String(i+1).padStart(2,"0")+'</span><p>'+esc(step)+'</p></div>').join("")+'</div></section>':'')+
  '</div>';
}

async function studentAssessmentDetails(id){
  try{
    let a=cachedAssessment(id);
    if(!a){
      const snap=await getDoc(doc(db,"assessments",id));
      if(!snap.exists())return toast("Assessment not found.");
      a={id:snap.id,...snap.data()};
    }
    if(!a.sectionId)return toast("This assessment is not assigned to a section.");
    return core().openModal({
      eyebrow:a.type||"Assessment",
      title:a.title||"Assessment Details",
      wide:true,
      body:assessmentStudentDetailsBody(a),
      footer:'<button class="primary-btn" data-close-modal>Close</button>'
    });
  }catch(err){
    console.error("Unable to open assessment details:",err);
    toast(err?.code==="permission-denied"?"Theoria could not authorize this assessment detail view. Confirm that you are enrolled in the assigned section.":(err?.message||"Unable to load assessment details."));
  }
}

async function studentAssessmentResults(id){
  const s=state();
  try{
    let a=cachedAssessment(id);
    if(!a){
      const aSnap=await getDoc(doc(db,"assessments",id));
      if(!aSnap.exists())return toast("Assessment not found.");
      a={id:aSnap.id,...aSnap.data()};
    }

    let result=null,sub={};
    try{
      const resultSnap=await getDoc(doc(db,"assessments",id,"results",s.user.uid));
      if(resultSnap.exists())result={id:resultSnap.id,...resultSnap.data()};
    }catch(error){
      console.error("Unable to read assessment result:",error);
      throw error;
    }
    if(!result||result.complete!==true)return toast("This assessment has not been fully graded yet.");

    try{
      const subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));
      if(subSnap.exists())sub={id:subSnap.id,...subSnap.data()};
    }catch(error){
      console.warn("Submission metadata unavailable for results view:",error);
    }

    const order=safeArray(sub.questionOrder);
    const pool=new Map(safeArray(a.questionPool).map(q=>[q?.id,q||{}]).filter(([id])=>id));
    const grading=(result.grading&&typeof result.grading==="object")?result.grading:{};
    const questionRows=order.map((qid,index)=>{
      const meta=pool.get(qid)||{},grade=grading[qid]||{};
      const max=Number(meta.points||0);
      const score=grade.score!==undefined&&grade.score!==null?Number(grade.score):null;
      return '<div class="student-result-question"><div class="result-question-number">'+(index+1)+'</div><div><span>'+esc(meta.type||"Question")+'</span><strong>'+(score===null?'Not scored':esc(score)+' / '+esc(max||"—")+' pts')+'</strong>'+(grade.comment?'<p>'+esc(grade.comment)+'</p>':'')+'</div></div>';
    }).join("");

    const parts=result.partScores&&typeof result.partScores==="object"
      ? Object.values(result.partScores).filter(Boolean)
      : [];

    core().setPage("exam",a.title||"Assessment Results");
    const root=$("#examRoot");
    if(!root)throw new Error("Assessment results workspace is unavailable.");
    root.innerHTML=
      '<div class="student-results-shell"><button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
      '<div class="student-results-hero"><div><div class="eyebrow">'+esc(a.courseCode||"")+' • '+esc(a.type||"Assessment")+'</div><h1>'+esc(a.title||"Assessment")+'</h1><p>Grading is complete. This summary shows your performance without exposing answer keys.</p></div><div class="result-score-mark"><strong>'+esc(result.percent??"—")+(result.percent!==undefined&&result.percent!==null?"%":"")+'</strong><span>'+esc(result.totalScore??"—")+' / '+esc(result.maxScore??a.totalPoints??"—")+' points</span></div></div>'+
      '<div class="receipt-grid student-result-meta"><div><span>Candidate Number</span><strong>'+esc(result.candidateNumber||sub.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>Graded</strong></div><div><span>Submitted</span><strong>'+esc(dateText(sub.submittedAt))+'</strong></div><div><span>Graded</span><strong>'+esc(dateText(result.gradedAt))+'</strong></div></div>'+
      (parts.length?'<section class="student-result-section"><div class="panel-title">Assessment Part Performance</div><div class="result-domain-grid">'+parts.map(x=>'<div><span>'+esc(x?.title||"Assessment Part")+'</span><strong>'+esc(x?.percent??"—")+(x?.percent!==undefined&&x?.percent!==null?"%":"")+'</strong><small>'+esc(x?.score??"—")+' / '+esc(x?.max??"—")+' pts</small></div>').join("")+'</div></section>':'')+
      (questionRows?'<section class="student-result-section"><div class="panel-title">Question Performance</div><p class="student-result-note">Question text and answer keys are not displayed in this results summary.</p><div class="student-result-question-list">'+questionRows+'</div></section>':'<section class="student-result-section"><div class="panel-title">Question Performance</div><p class="student-result-note">Per-question metadata is unavailable for this legacy attempt, but your overall and assessment-part results are shown above.</p></section>')+
      (result.overallComment?'<section class="student-result-section"><div class="panel-title">Instructor Comment</div><div class="academic-banner"><p>'+esc(result.overallComment)+'</p></div></section>':'')+
      '<div class="student-results-actions"><button class="secondary-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Assessment Details</button><button class="primary-btn" data-phase3-action="back-assessments">Return to Assessments</button></div></div>';
  }catch(err){
    console.error("Unable to load student assessment results:",err);
    toast(err?.code==="permission-denied"?"Theoria could not authorize this result yet. Deploy the latest Firestore rules, then sign out and back in.":(err?.message||"Unable to load assessment results."));
  }
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
    const templates=P3.assessments.filter(a=>!a.sectionId);
    const entrance=P3.assessments.filter(a=>!!a.sectionId&&a.entranceExam===true);
    const assigned=P3.assessments.filter(a=>!!a.sectionId&&a.entranceExam!==true);
    const card=a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+(a.entranceExam?' • Entrance Exam':'')+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+(a.sectionId?esc(a.sectionName||"Assigned Section"):'Reusable assessment template')+'</p><div class="assessment-card-stats"><span><strong>'+esc(a.questionCount||0)+'</strong> '+(a.randomDrawEnabled?'questions/student':'questions')+'</span><span><strong>'+esc(a.totalPoints||0)+'</strong> points</span><span>'+(a.entranceExam?'Pass '+esc(a.entrancePassPercent||70)+'%':esc(a.sectionId?availability(a):"Template"))+'</span></div><div class="card-actions">'+(!a.sectionId?'<button class="primary-btn small-btn" data-phase3-action="assign-assessment" data-id="'+a.id+'">Assign to Section</button>':a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Section</button>':'<button class="secondary-btn small-btn" data-phase3-action="edit-assignment" data-id="'+a.id+'">Edit Assignment</button>')+'<button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button>'+(a.entranceExam?'':'<button class="danger-btn small-btn" data-phase3-action="delete-assessment" data-id="'+a.id+'">Delete</button>')+'</div></article>';
    el.innerHTML=(templates.length?'<div class="assessment-library-group"><div class="page-head compact-head"><div><div class="panel-title">Assessment Templates</div><p class="page-subtitle">Build once from the Question Bank, then assign to one or more sections.</p></div></div><div class="assessment-grid">'+templates.map(card).join("")+'</div></div>':'')+
      (entrance.length?'<div class="assessment-library-group"><div class="page-head compact-head"><div><div class="panel-title">Entrance Examinations</div><p class="page-subtitle">Enrollment-gating assessments configured from section settings.</p></div></div><div class="assessment-grid">'+entrance.map(card).join("")+'</div></div>':'')+
      (assigned.length?'<div class="assessment-library-group"><div class="page-head compact-head"><div><div class="panel-title">Assigned Assessments</div><p class="page-subtitle">Live section copies with their own schedule, submissions, and grading.</p></div></div><div class="assessment-grid">'+assigned.map(card).join("")+'</div></div>':'');
    return;
  }
  const cards=[];
  for(const a of P3.assessments){
    let sub=null,result=null;
    try{const x=await getDoc(doc(db,"assessments",a.id,"submissions",s.user.uid));if(x.exists())sub=x.data();}catch(_){}
    try{const x=await getDoc(doc(db,"assessments",a.id,"results",s.user.uid));if(x.exists())result=x.data();}catch(_){}
    const status=availability(a),graded=result?.complete===true;
    let actions='<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">View Details</button>';
    if(graded){
      actions='<button class="primary-btn small-btn" data-phase3-action="student-assessment-results" data-id="'+a.id+'">View Results</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(a.mode==="oral"){
      actions+='<span class="badge gold">Instructor administered</span>';
    }else if(sub?.status==="submitted"||sub?.status==="graded"){
      actions='<button class="secondary-btn small-btn" data-phase3-action="receipt" data-id="'+a.id+'">Submission Receipt</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(status==="Open"){
      actions='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">'+(sub?"Resume":"Begin")+'</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }
    const types=assessmentTypeSummary(a);
    cards.push('<article class="assessment-card student-assessment-card"><div class="assessment-card-topline"><div class="assessment-type">'+esc(a.type)+'</div><span class="badge '+(status==="Open"?"live":status==="Scheduled"?"gold":"")+'">'+esc(status)+'</span></div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p>'+
      '<div class="assessment-card-stats"><span>'+esc(a.durationMinutes||0)+' min</span><span>'+esc(a.totalPoints||0)+' pts</span><span>'+esc(a.questionCount||0)+' questions</span></div>'+
      (types.length?'<div class="student-card-type-list">'+types.slice(0,4).map(row=>'<span>'+esc(row.count)+' '+esc(row.type)+'</span>').join("")+(types.length>4?'<span>+'+(types.length-4)+' more</span>':'')+'</div>':'')+
      (graded?'<div class="released-result"><strong>'+esc(result.percent)+'%</strong><span>Graded result available</span></div>':'')+
      '<div class="card-actions">'+actions+'</div></article>');
  }
  el.innerHTML='<div class="assessment-grid">'+cards.join("")+'</div>';
}


function deriveCompetencyBlueprint(questions,competencies=[],options={}){
  const list=Array.isArray(questions)?questions:[];
  const byId=new Map(),byCode=new Map();
  for(const comp of competencies||[]){
    if(comp?.id)byId.set(String(comp.id),comp);
    if(comp?.code)byCode.set(String(comp.code).trim().toUpperCase(),comp);
  }

  const randomDrawEnabled=!!options.randomDrawEnabled;
  const planByType=new Map((options.randomDrawPlan||[]).map(row=>[String(row?.type||""),row]));
  const typeCounts=new Map();
  for(const q of list){
    const type=String(q?.type||"Question");
    typeCounts.set(type,(typeCounts.get(type)||0)+1);
  }

  const totals=new Map();
  let taggedExpectedPoints=0,untaggedExpectedPoints=0,taggedQuestions=0;

  for(const q of list){
    const points=Math.max(0,Number(q?.points??q?.pointsDefault??1)||0);
    if(!points)continue;

    let factor=1;
    if(randomDrawEnabled){
      const row=planByType.get(String(q?.type||"Question"));
      const count=Math.max(0,Number(row?.count||0));
      if(!row||count<=0)continue;
      const available=Math.max(1,typeCounts.get(String(q?.type||"Question"))||Number(row?.available||0)||1);
      factor=Math.min(1,count/available);
    }

    const expectedPoints=points*factor;
    if(expectedPoints<=0)continue;

    const attached=[];
    const seen=new Set();

    for(const rawId of q?.competencyIds||[]){
      const id=String(rawId||"").trim();if(!id)continue;
      const comp=byId.get(id);
      const key=comp?.id?String(comp.id):"id:"+id;
      if(seen.has(key))continue;seen.add(key);
      attached.push({
        key,
        id:comp?.id||id,
        code:comp?.code||"",
        label:comp?((comp.code?comp.code+" — ":"")+(comp.name||comp.code||id)):id,
        order:Number(comp?.order||9999)
      });
    }

    for(const rawCode of q?.competencyCodes||[]){
      const code=String(rawCode||"").trim().toUpperCase();if(!code)continue;
      const comp=byCode.get(code);
      const key=comp?.id?String(comp.id):"code:"+code;
      if(seen.has(key))continue;seen.add(key);
      attached.push({
        key,
        id:comp?.id||("code:"+code),
        code:comp?.code||code,
        label:comp?((comp.code?comp.code+" — ":"")+(comp.name||comp.code||code)):code,
        order:Number(comp?.order||9999)
      });
    }

    if(!attached.length){
      untaggedExpectedPoints+=expectedPoints;
      continue;
    }

    taggedQuestions++;
    taggedExpectedPoints+=expectedPoints;
    const share=expectedPoints/attached.length;
    for(const comp of attached){
      const current=totals.get(comp.key)||{...comp,points:0};
      current.points+=share;
      totals.set(comp.key,current);
    }
  }

  if(taggedExpectedPoints<=0){
    return {rows:[],taggedExpectedPoints:0,untaggedExpectedPoints,taggedQuestions,totalQuestions:list.length};
  }

  const entries=[...totals.values()].sort((a,b)=>a.order-b.order||String(a.label).localeCompare(String(b.label)));
  const rows=entries.map(entry=>({
    id:entry.id,
    code:entry.code,
    label:entry.label,
    weight:Math.round((entry.points/taggedExpectedPoints*100)*10)/10,
    evidencePoints:Math.round(entry.points*100)/100
  }));

  const roundedTotal=Math.round(rows.reduce((n,row)=>n+Number(row.weight||0),0)*10)/10;
  const correction=Math.round((100-roundedTotal)*10)/10;
  if(rows.length&&Math.abs(correction)>=0.1){
    const largest=rows.reduce((best,row,index)=>Number(row.weight||0)>Number(rows[best].weight||0)?index:best,0);
    rows[largest].weight=Math.round((Number(rows[largest].weight||0)+correction)*10)/10;
  }

  return {
    rows,
    taggedExpectedPoints:Math.round(taggedExpectedPoints*100)/100,
    untaggedExpectedPoints:Math.round(untaggedExpectedPoints*100)/100,
    taggedQuestions,
    totalQuestions:list.length
  };
}

async function calculateAssessmentCompetencyBlueprint(assessment,questions,fwOverride=null,optionsOverride=null){
  const fw=fwOverride||await framework(assessment.courseId);
  const options=optionsOverride||{
    randomDrawEnabled:!!assessment.randomDrawEnabled,
    randomDrawPlan:assessment.randomDrawPlan||[]
  };
  return deriveCompetencyBlueprint(questions,fw.competencies||[],options);
}

async function assessmentModal(existing){
  const s=state();if(!s?.courses?.length)return toast("Create a course before creating an assessment.");
  const types=["Academic Exercise","Unit Evaluation","Semester I Examination","Comprehensive Final Examination","Oral Examination","Disputation"];
  let selectedCourse=s.courses.find(c=>c.id===existing?.courseId)||s.courses[0];
  let fw=await framework(selectedCourse.id);
  let bankQuestions=[];
  const loadBankQuestions=async course=>{
    const snap=await getDocs(collection(db,"courses",course.id,"items"));
    bankQuestions=snap.docs.map(d=>({id:d.id,courseId:course.id,...d.data()}))
      .sort((a,b)=>String(a.topicNumber||"").localeCompare(String(b.topicNumber||""),undefined,{numeric:true})||String(a.prompt||"").localeCompare(String(b.prompt||"")));
  };
  if(!existing) await loadBankQuestions(selectedCourse);
  const currentType=existing?.type||"Unit Evaluation";
  const typeTiles=types.map((type,i)=>'<label class="type-tile '+(currentType===type?'selected':'')+'"><input type="radio" name="type" value="'+esc(type)+'" '+(currentType===type?'checked':'')+'><span class="type-tile-mark">'+String(i+1).padStart(2,"0")+'</span><span>'+esc(type)+'</span></label>').join("");
  const initialInstructions=Array.isArray(existing?.instructionSteps)&&existing.instructionSteps.length?existing.instructionSteps:(existing?.instructions?[existing.instructions]:[""]);

  const modal=core().openModal({
    eyebrow:existing?.sectionId?"Assigned Assessment":"Assessment Template",
    title:existing?"Edit Assessment":"Create Assessment Template",
    wide:true,
    body:'<form id="assessmentForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Assessment Identity</h3><p>Assessments belong to a course and are assembled from its Question Bank.</p></div></div>'+
        '<div class="field"><label>Course</label><select name="courseId" id="assessmentCourse" '+(existing?'disabled':'')+'>'+s.courses.map(x=>'<option value="'+x.id+'">'+esc(x.code+" — "+x.title)+'</option>').join("")+'</select></div>'+
        (existing?.sectionId?'<div class="assignment-context"><span>Assigned to</span><strong>'+esc(existing.sectionName||"Section")+'</strong></div>':'')+
        '<div class="field"><label>Assessment Title</label><input class="title-input" name="title" value="'+esc(existing?.title||"")+'" placeholder="e.g. Semester I Examination" required></div>'+
        '<div class="field"><label>Assessment Type</label><div class="type-tile-grid compact">'+typeTiles+'</div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Administration Defaults</h3><p>These settings are copied when the template is assigned and can be adjusted for the section.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Duration</label><div class="input-with-suffix"><input name="durationMinutes" type="number" min="0" value="'+esc(existing?.durationMinutes??60)+'"><span>min</span></div></div><div class="field"><label>Opens</label><input name="opensAt" type="datetime-local" value="'+esc(localDateTime(existing?.opensAt))+'"></div><div class="field"><label>Closes</label><input name="closesAt" type="datetime-local" value="'+esc(localDateTime(existing?.closesAt))+'"></div></div>'+
        '<div class="policy-card-grid"><label class="policy-card"><input type="checkbox" name="anonymousGrading" '+(existing?.anonymousGrading!==false?'checked':'')+'><div><strong>Anonymous Grading</strong><span>Use candidate numbers while evaluating.</span></div></label><label class="policy-card"><input type="checkbox" name="backtracking" '+(existing?.backtracking!==false?'checked':'')+'><div><strong>Allow Backtracking</strong><span>Students may revisit earlier questions.</span></div></label><label class="policy-card"><input type="checkbox" name="randomizeQuestions" '+(existing?.randomizeQuestions?'checked':'')+'><div><strong>Shuffle Question Order</strong><span>Shuffle the final question order for each student.</span></div></label></div>'+
        '<div class="field"><label>Results Visibility</label><input type="hidden" name="feedbackPolicy" value="automatic"><div class="static-field">Results become visible to the student automatically when grading is complete.</div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Student Instructions</h3><p>Add concise instructions one line at a time.</p></div><button type="button" class="secondary-btn small-btn" id="addAssessmentInstruction">+ Add Instruction</button></div><div id="assessmentInstructions" class="structured-list"></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>04</span><h3>Content Blueprint</h3><p>Choose course units and assign their intended share of the assessment.</p></div><div class="inline-actions"><button type="button" class="secondary-btn small-btn" id="balanceContentBlueprint">Balance</button><button type="button" class="secondary-btn small-btn" id="addContentBlueprint">+ Add Target</button></div></div><div id="contentBlueprintRows" class="blueprint-builder"></div><div class="builder-total"><span>Total</span><strong id="contentBlueprintTotal">0%</strong></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>05</span><h3>Competency Blueprint</h3><p>Automatically calculated from the questions in this assessment and the competencies attached to those questions.</p></div><span class="badge live">Auto</span></div><div id="competencyBlueprintRows" class="blueprint-builder auto-blueprint-builder"></div><div id="competencyBlueprintAutoNote" class="auto-blueprint-note">Select competency-tagged questions to build the blueprint.</div><div class="builder-total"><span>Mapped competency weight</span><strong id="competencyBlueprintTotal">0%</strong></div></section>'+
      (!existing?'<section class="form-section question-bank-builder"><div class="form-section-head"><div><span>06</span><h3>Question Pool</h3><p>Select every question that may appear on this assessment. You can then use all selected questions or draw a random number from each question type.</p></div><div class="question-selection-summary"><strong id="selectedQuestionCount">0</strong><span>in pool</span><b id="selectedQuestionPoints">0 pts total</b></div></div>'+
        '<div class="question-bank-toolbar"><div class="field"><label>Search Question Bank</label><input id="assessmentQuestionSearch" placeholder="Search prompt, unit, topic, competency, or tag"></div><div class="field"><label>Unit</label><select id="assessmentQuestionUnit"><option value="">All units</option></select></div><div class="field"><label>Question Type</label><select id="assessmentQuestionType"><option value="">All question types</option></select></div><button type="button" class="secondary-btn small-btn question-select-filtered" id="selectFilteredQuestions">Select Filtered</button></div>'+
        '<div class="random-draw-panel"><label class="policy-card random-draw-toggle"><input type="checkbox" id="randomDrawEnabled"><div><strong>Random Draw by Question Type</strong><span>Each student receives a locked random subset from this pool. Their version does not change on refresh or resume.</span></div></label><div id="randomDrawPlan" class="random-draw-plan hidden"></div></div>'+
        '<div id="assessmentQuestionChoices" class="assessment-question-picker"></div></section>':'')+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(existing?"Save Assessment":"Create Template")+'</button></div></form>'
  });

  const form=modal.querySelector("#assessmentForm");
  form.courseId.value=selectedCourse.id;
  form.feedbackPolicy.value="automatic";

  let selectedQuestionIds=new Set();
  const questionBox=modal.querySelector("#assessmentQuestionChoices");
  const questionSearch=modal.querySelector("#assessmentQuestionSearch");
  const questionUnit=modal.querySelector("#assessmentQuestionUnit");
  const questionType=modal.querySelector("#assessmentQuestionType");
  const randomDrawToggle=modal.querySelector("#randomDrawEnabled");
  const randomDrawPlanBox=modal.querySelector("#randomDrawPlan");
  const drawCounts=new Map();
  let syncCompetencyBlueprint=()=>{};

  const selectedQuestions=()=>bankQuestions.filter(q=>selectedQuestionIds.has(q.id));
  const selectedGroups=()=>{
    const groups=new Map();
    selectedQuestions().forEach(q=>{
      if(!groups.has(q.type))groups.set(q.type,[]);
      groups.get(q.type).push(q);
    });
    return groups;
  };

  const renderRandomDrawPlan=()=>{
    if(existing||!randomDrawPlanBox)return;
    const enabled=!!randomDrawToggle.checked;
    randomDrawPlanBox.classList.toggle("hidden",!enabled);
    if(!enabled)return;

    const groups=selectedGroups();
    if(!groups.size){
      randomDrawPlanBox.innerHTML='<div class="empty-mini">Select questions first. Draw controls will appear by question type.</div>';
      return;
    }

    for(const [type,questions] of groups){
      if(!drawCounts.has(type))drawCounts.set(type,questions.length);
      drawCounts.set(type,Math.min(Number(drawCounts.get(type)||0),questions.length));
    }
    [...drawCounts.keys()].forEach(type=>{if(!groups.has(type))drawCounts.delete(type);});

    randomDrawPlanBox.innerHTML='<div class="random-draw-head"><div><strong>Questions per student</strong><span>Set how many questions Theoria should draw from each selected type.</span></div><div class="random-draw-total"><strong id="randomDrawTotal">0</strong><span>on each exam</span></div></div>'+
      [...groups.entries()].map(([type,questions])=>{
        const points=[...new Set(questions.map(q=>Number(q.pointsDefault||1)))];
        const pointText=points.length===1?points[0]+" pts each":"mixed point values";
        return '<div class="random-draw-row"><div><strong>'+esc(type)+'</strong><span>'+questions.length+' available • '+esc(pointText)+'</span></div><div class="input-with-suffix mini"><input class="random-draw-count" data-type="'+esc(type)+'" type="number" min="0" max="'+questions.length+'" step="1" value="'+esc(drawCounts.get(type))+'"><span>draw</span></div></div>';
      }).join("")+
      '<div class="random-draw-note">Every student receives a separately randomized, persistent version. To keep every version worth the same number of points, questions within a randomized type must use the same point value.</div>';

    const refreshTotal=()=>{
      randomDrawPlanBox.querySelectorAll(".random-draw-count").forEach(input=>{
        const max=Number(input.max||0),value=Math.max(0,Math.min(max,Math.floor(Number(input.value||0))));
        input.value=value;drawCounts.set(input.dataset.type,value);
      });
      const total=[...drawCounts.values()].reduce((n,x)=>n+Number(x||0),0);
      const totalEl=modal.querySelector("#randomDrawTotal");if(totalEl)totalEl.textContent=String(total);
      syncCompetencyBlueprint();
    };
    randomDrawPlanBox.querySelectorAll(".random-draw-count").forEach(input=>input.addEventListener("input",refreshTotal));
    refreshTotal();
  };

  const updateQuestionSummary=()=>{
    if(existing)return;
    const selected=selectedQuestions();
    modal.querySelector("#selectedQuestionCount").textContent=String(selected.length);
    modal.querySelector("#selectedQuestionPoints").textContent=selected.reduce((n,q)=>n+Number(q.pointsDefault||1),0)+" pts total";
    renderRandomDrawPlan();
    syncCompetencyBlueprint();
  };

  const filteredQuestions=()=>{
    const q=String(questionSearch?.value||"").trim().toLowerCase(),type=String(questionType?.value||""),unitId=String(questionUnit?.value||"");
    return bankQuestions.filter(item=>{
      const placement=core().resolveFrameworkPlacement?core().resolveFrameworkPlacement(item,fw):null;
      const itemUnitId=placement?.unit?.id||item.unitId||"unsorted";
      const unitMatches=!unitId||itemUnitId===unitId;
      const typeMatches=!type||item.type===type;
      const searchMatches=!q||[item.prompt,item.unitTitle,placement?.unit?.title,item.topicTitle,item.topicNumber,(item.competencyCodes||[]).join(" "),(item.tags||[]).join(" ")].join(" ").toLowerCase().includes(q);
      return unitMatches&&typeMatches&&searchMatches;
    });
  };

  const renderBankQuestions=()=>{
    if(existing||!questionBox)return;
    const filtered=filteredQuestions();
    const groups=core().unitFolderGroups?core().unitFolderGroups(filtered,fw):[];
    const choice=item=>
      '<label class="assessment-question-choice '+(selectedQuestionIds.has(item.id)?'selected':'')+'">'+
        '<input type="checkbox" value="'+item.id+'" '+(selectedQuestionIds.has(item.id)?'checked':'')+'>'+
        '<div class="question-choice-copy"><div class="question-choice-meta"><span>'+esc(item.type||"Question")+'</span><span>'+esc(item.topicNumber||"No topic")+'</span><span>'+esc(item.pointsDefault||1)+' pts</span></div><strong>'+esc(item.prompt||"Untitled question")+'</strong>'+
        ((item.competencyCodes||[]).length?'<div class="item-tags">'+item.competencyCodes.map(code=>'<span>'+esc(code)+'</span>').join("")+'</div>':'')+
        '</div><div class="question-select-mark">✓</div></label>';

    questionBox.innerHTML=filtered.length
      ? '<div class="unit-folder-stack assessment-create-unit-stack">'+groups.map((group,index)=>
          '<details class="unit-folder '+(group.id==="unsorted"?'unsorted-folder':'')+'" '+(index===0||String(questionUnit?.value||"")===group.id?'open':'')+'>'+
            '<summary><div class="unit-folder-icon">'+(group.id==="unsorted"?'?':esc(group.unit?.order||"U"))+'</div><div><strong>'+esc(group.label)+'</strong><span>'+group.items.length+' matching question'+(group.items.length===1?"":"s")+'</span></div><div class="unit-folder-chevron">⌄</div></summary>'+
            '<div class="unit-folder-body"><div class="assessment-question-picker unit-question-picker">'+group.items.map(choice).join("")+'</div></div>'+
          '</details>'
        ).join("")+'</div>'
      : '<div class="empty-state compact-empty"><div class="empty-symbol">Q</div><h3>No matching questions.</h3><p>'+(bankQuestions.length?"Adjust the search or filter.":"Create questions in the Question Bank for this course first.")+'</p></div>';

    questionBox.querySelectorAll('input[type="checkbox"]').forEach(input=>input.onchange=()=>{
      if(input.checked)selectedQuestionIds.add(input.value);else selectedQuestionIds.delete(input.value);
      input.closest(".assessment-question-choice").classList.toggle("selected",input.checked);
      updateQuestionSummary();
    });
  };

  const populateQuestionFilters=()=>{
    if(existing||!questionType||!questionUnit)return;
    const types=[...new Set(bankQuestions.map(x=>x.type).filter(Boolean))].sort();
    questionType.innerHTML='<option value="">All question types</option>'+types.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join("");
    const unitCounts=new Map();
    for(const item of bankQuestions){
      const placement=core().resolveFrameworkPlacement?core().resolveFrameworkPlacement(item,fw):null;
      const id=placement?.unit?.id||item.unitId||"unsorted";
      unitCounts.set(id,(unitCounts.get(id)||0)+1);
    }
    questionUnit.innerHTML='<option value="">All units ('+bankQuestions.length+')</option>'+
      (fw.units||[]).filter(unit=>unitCounts.get(unit.id)).map(unit=>'<option value="'+unit.id+'">Unit '+esc(unit.order||"")+' — '+esc(unit.title)+' ('+unitCounts.get(unit.id)+')</option>').join("")+
      (unitCounts.get("unsorted")?'<option value="unsorted">Unsorted ('+unitCounts.get("unsorted")+')</option>':'');
  };

  if(!existing){
    populateQuestionFilters();renderBankQuestions();updateQuestionSummary();
    questionSearch.addEventListener("input",renderBankQuestions);
    questionUnit.addEventListener("change",renderBankQuestions);
    questionType.addEventListener("change",renderBankQuestions);
    randomDrawToggle.addEventListener("change",()=>{
      if(randomDrawToggle.checked)form.elements.randomizeQuestions.checked=true;
      renderRandomDrawPlan();
      syncCompetencyBlueprint();
    });
    modal.querySelector("#selectFilteredQuestions").addEventListener("click",()=>{
      filteredQuestions().forEach(q=>selectedQuestionIds.add(q.id));
      renderBankQuestions();updateQuestionSummary();
    });
  }

  const instructionBox=modal.querySelector("#assessmentInstructions");
  const addInstruction=(value="")=>{
    const row=document.createElement("div");row.className="structured-row";
    row.innerHTML='<div class="structured-index">'+String(instructionBox.children.length+1).padStart(2,"0")+'</div><input class="structured-input" value="'+esc(value)+'" placeholder="e.g. Support written responses with specific textual evidence."><button type="button" class="row-remove" aria-label="Remove">×</button>';
    row.querySelector(".row-remove").onclick=()=>{row.remove();[...instructionBox.children].forEach((x,i)=>x.querySelector(".structured-index").textContent=String(i+1).padStart(2,"0"));};
    instructionBox.appendChild(row);
  };
  initialInstructions.forEach(addInstruction);modal.querySelector("#addAssessmentInstruction").onclick=()=>addInstruction();

  const contentBox=modal.querySelector("#contentBlueprintRows"),competencyBox=modal.querySelector("#competencyBlueprintRows");
  const targetOptions=kind=>kind==="content"?fw.units.map(u=>({id:u.id,label:"Unit "+(u.order||"")+" — "+u.title})):fw.competencies.map(c=>({id:c.id,label:c.code+" — "+c.name}));
  const roundBlueprint=n=>Math.round(n*10)/10;
  const updateTotal=kind=>{
    const box=kind==="content"?contentBox:competencyBox,totalEl=modal.querySelector(kind==="content"?"#contentBlueprintTotal":"#competencyBlueprintTotal");
    const total=[...box.querySelectorAll(".blueprint-weight")].reduce((n,x)=>n+Number(x.value||0),0);
    totalEl.textContent=roundBlueprint(total)+"%";totalEl.className=roundBlueprint(total)===100?"complete":"";
  };
  const addBlueprintRow=(kind,rowData={})=>{
    const box=kind==="content"?contentBox:competencyBox,opts=targetOptions(kind),row=document.createElement("div");row.className="blueprint-edit-row";
    let options=opts.map(o=>'<option value="'+esc(o.id)+'" data-label="'+esc(o.label)+'">'+esc(o.label)+'</option>').join("");
    const match=opts.find(o=>o.id===rowData.id||o.label===rowData.label);
    if(rowData.label&&!match)options='<option value="'+esc(rowData.id||rowData.label)+'" data-label="'+esc(rowData.label)+'">'+esc(rowData.label)+'</option>'+options;
    row.innerHTML='<select class="blueprint-target">'+options+'</select><div class="input-with-suffix mini"><input class="blueprint-weight" type="number" min="0" max="100" step="0.5" value="'+esc(rowData.weight??0)+'"><span>%</span></div><button type="button" class="row-remove" aria-label="Remove">×</button>';
    if(rowData.id)row.querySelector(".blueprint-target").value=match?.id||rowData.id;
    row.querySelector(".blueprint-weight").oninput=()=>updateTotal(kind);row.querySelector(".row-remove").onclick=()=>{row.remove();updateTotal(kind);};
    if(kind==="competency"){
      row.classList.add("auto-blueprint-row");
      row.querySelector(".blueprint-target").disabled=true;
      row.querySelector(".blueprint-weight").readOnly=true;
      row.querySelector(".row-remove").classList.add("hidden");
    }
    box.appendChild(row);updateTotal(kind);
  };
  const buildDefaults=()=>{
    contentBox.innerHTML="";competencyBox.innerHTML="";
    const content=existing?.contentBlueprint?.length?existing.contentBlueprint:targetOptions("content").slice(0,Math.min(4,targetOptions("content").length)).map(x=>({...x,weight:0}));
    content.forEach(x=>addBlueprintRow("content",x));
  };
  buildDefaults();

  const competencyPlanOptions=()=>{
    if(existing)return {randomDrawEnabled:!!existing.randomDrawEnabled,randomDrawPlan:existing.randomDrawPlan||[]};
    if(!randomDrawToggle?.checked)return {randomDrawEnabled:false,randomDrawPlan:[]};
    const groups=selectedGroups();
    return {
      randomDrawEnabled:true,
      randomDrawPlan:[...groups.entries()].map(([type,questions])=>({type,count:Math.max(0,Math.floor(Number(drawCounts.get(type)||0))),available:questions.length}))
    };
  };

  syncCompetencyBlueprint=()=>{
    const questions=(existing?(P3.detail?.questions||[]):selectedQuestions()).map(q=>({...q,points:Number(q.points??q.pointsDefault??1)}));
    const derived=deriveCompetencyBlueprint(questions,fw.competencies||[],competencyPlanOptions());
    competencyBox.innerHTML="";
    derived.rows.forEach(row=>addBlueprintRow("competency",row));
    const note=modal.querySelector("#competencyBlueprintAutoNote");
    if(note){
      if(!questions.length)note.textContent="Add questions to this assessment to generate its competency blueprint.";
      else if(!derived.rows.length)note.textContent="None of the current questions have competencies attached. Add competency tags in the Question Bank to generate this blueprint.";
      else{
        const mapped=derived.taggedExpectedPoints;
        const unmapped=derived.untaggedExpectedPoints;
        note.textContent="Auto-calculated from "+derived.taggedQuestions+" competency-tagged question"+(derived.taggedQuestions===1?"":"s")+" • "+mapped+" mapped expected point"+(mapped===1?"":"s")+(unmapped?" • "+unmapped+" expected point"+(unmapped===1?"":"s")+" currently has no competency tag":"")+(competencyPlanOptions().randomDrawEnabled?" • weighted for the configured random draw":"")+".";
      }
    }
    updateTotal("competency");
  };
  syncCompetencyBlueprint();
  const balance=kind=>{
    const box=kind==="content"?contentBox:competencyBox,rows=[...box.querySelectorAll(".blueprint-edit-row")];if(!rows.length)return toast("Add at least one blueprint target.");
    const base=Math.floor((100/rows.length)*10)/10;let used=0;
    rows.forEach((row,i)=>{const value=i===rows.length-1?roundBlueprint(100-used):base;row.querySelector(".blueprint-weight").value=value;used+=value;});updateTotal(kind);
  };
  modal.querySelector("#addContentBlueprint").onclick=()=>addBlueprintRow("content");
  modal.querySelector("#balanceContentBlueprint").onclick=()=>balance("content");
  modal.querySelectorAll('input[name="type"]').forEach(input=>input.onchange=()=>modal.querySelectorAll(".type-tile").forEach(tile=>tile.classList.toggle("selected",tile.querySelector("input").checked)));

  if(!existing)form.querySelector("#assessmentCourse").onchange=async e=>{
    selectedCourse=s.courses.find(x=>x.id===e.target.value);fw=await framework(selectedCourse.id);
    contentBox.innerHTML="";competencyBox.innerHTML="";
    targetOptions("content").slice(0,Math.min(4,targetOptions("content").length)).forEach(x=>addBlueprintRow("content",{...x,weight:0}));
    selectedQuestionIds.clear();drawCounts.clear();
    await loadBankQuestions(selectedCourse);
    populateQuestionFilters();renderBankQuestions();updateQuestionSummary();
  };

  const readBlueprint=kind=>{
    const box=kind==="content"?contentBox:competencyBox;
    return [...box.querySelectorAll(".blueprint-edit-row")].map(row=>{const select=row.querySelector(".blueprint-target"),option=select.options[select.selectedIndex];return {id:select.value,label:option?.dataset.label||option?.textContent||select.value,weight:Number(row.querySelector(".blueprint-weight").value||0)};}).filter(x=>x.id);
  };

  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(form),course=s.courses.find(x=>x.id===(existing?.courseId||String(fd.get("courseId"))))||selectedCourse;
    const type=form.querySelector('input[name="type"]:checked')?.value||"Unit Evaluation",contentBlueprint=readBlueprint("content");
    if(contentBlueprint.length&&roundBlueprint(totalWeight(contentBlueprint))!==100)return toast("Content blueprint must total 100%.");
    const instructionSteps=[...instructionBox.querySelectorAll(".structured-input")].map(x=>x.value.trim()).filter(Boolean);
    const chosenQuestions=existing?[]:bankQuestions.filter(q=>selectedQuestionIds.has(q.id));
    const randomDrawEnabled=!existing&&!!randomDrawToggle?.checked;
    let randomDrawPlan=[];
    let plannedQuestionCount=chosenQuestions.length;
    let plannedTotalPoints=chosenQuestions.reduce((n,q)=>n+Number(q.pointsDefault||1),0);

    if(!existing&&randomDrawEnabled){
      if(!chosenQuestions.length)return toast("Select at least one Question Bank question for the random pool.");
      const groups=selectedGroups();
      randomDrawPlan=[...groups.entries()].map(([questionType,questions])=>({
        type:questionType,
        count:Math.max(0,Math.floor(Number(drawCounts.get(questionType)||0))),
        available:questions.length,
        pointsPerQuestion:questions.length?Number(questions[0].pointsDefault||1):0
      })).filter(x=>x.count>0);

      if(!randomDrawPlan.length)return toast("Set at least one random draw count above zero.");
      for(const row of randomDrawPlan){
        if(row.count>row.available)return toast("The "+row.type+" draw exceeds the number of selected questions.");
        const group=groups.get(row.type)||[];
        const pointValues=[...new Set(group.map(q=>Number(q.pointsDefault||1)))];
        if(pointValues.length!==1)return toast("All selected "+row.type+" questions must use the same point value for randomized exams. Adjust their Question Bank points first.");
        row.pointsPerQuestion=pointValues[0];
      }
      plannedQuestionCount=randomDrawPlan.reduce((n,row)=>n+row.count,0);
      plannedTotalPoints=randomDrawPlan.reduce((n,row)=>n+(row.count*row.pointsPerQuestion),0);
    }

    const blueprintQuestions=(existing?(P3.detail?.questions||[]):chosenQuestions).map(q=>({...q,points:Number(q.points??q.pointsDefault??1)}));
    const competencyDerivation=deriveCompetencyBlueprint(
      blueprintQuestions,
      fw.competencies||[],
      existing
        ? {randomDrawEnabled:!!existing.randomDrawEnabled,randomDrawPlan:existing.randomDrawPlan||[]}
        : {randomDrawEnabled,randomDrawPlan}
    );
    const competencyBlueprint=competencyDerivation.rows;

    const data={
      ownerId:s.user.uid,courseId:course.id,courseCode:course.code,courseTitle:course.title,
      sectionId:existing?.sectionId||"",sectionName:existing?.sectionName||"",templateSourceId:existing?.templateSourceId||"",
      title:String(fd.get("title")).trim(),type,mode:type==="Oral Examination"?"oral":"written",
      status:existing?.status||"Draft",durationMinutes:Number(fd.get("durationMinutes")||0),opensAt:timestampFrom(fd.get("opensAt")),closesAt:timestampFrom(fd.get("closesAt")),
      instructions:instructionSteps.join("\n"),instructionSteps,anonymousGrading:form.elements.anonymousGrading.checked,backtracking:form.elements.backtracking.checked,randomizeQuestions:randomDrawEnabled?true:form.elements.randomizeQuestions.checked,
      randomDrawEnabled:existing?!!existing.randomDrawEnabled:randomDrawEnabled,
      randomDrawPlan:existing?(existing.randomDrawPlan||[]):randomDrawPlan,
      feedbackPolicy:String(fd.get("feedbackPolicy")),contentBlueprint,competencyBlueprint,competencyBlueprintAuto:true,competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,parts:existing?.parts?.length?existing.parts:defaultParts(type),
      questionIds:existing?.questionIds||[],questionPool:existing?(existing.questionPool||[]):[],
      poolQuestionCount:existing?Number(existing.poolQuestionCount||existing.questionIds?.length||0):chosenQuestions.length,
      questionCount:existing?Number(existing.questionCount||0):plannedQuestionCount,
      totalPoints:existing?Number(existing.totalPoints||0):plannedTotalPoints,updatedAt:serverTimestamp()
    };
    try{
      let id=existing?.id;
      if(existing){
        await updateDoc(doc(db,"assessments",id),data);
      }else{
        const assessmentRef=doc(collection(db,"assessments"));
        id=assessmentRef.id;
        const questionRefs=chosenQuestions.map(()=>doc(collection(db,"assessments",id,"questions")));
        const questionIds=questionRefs.map(r=>r.id);
        const questionPool=chosenQuestions.map((item,index)=>({
          id:questionRefs[index].id,
          itemId:item.id,
          type:item.type,
          points:Number(item.pointsDefault||1)
        }));
        await setDoc(assessmentRef,{...data,questionIds,questionPool,poolQuestionCount:chosenQuestions.length,questionCount:plannedQuestionCount,totalPoints:plannedTotalPoints,createdAt:serverTimestamp()});
        for(let offset=0;offset<chosenQuestions.length;offset+=180){
          const batch=writeBatch(db),chunk=chosenQuestions.slice(offset,offset+180);
          chunk.forEach((item,index)=>{
            const ref=questionRefs[offset+index],order=offset+index+1;
            batch.set(ref,{
              itemId:item.id,order,partId:(data.parts?.[0]?.id||"main"),type:item.type,prompt:item.prompt,
              stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points:Number(item.pointsDefault||1),
              unitId:item.unitId||"",unitTitle:item.unitTitle||"",unitNumber:Number(item.unitNumber||0),
              topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
              competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()
            });
            batch.set(doc(db,"assessments",id,"keys",ref.id),{
              itemId:item.id,correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()
            });
          });
          await batch.commit();
        }
      }
      core().closeModal();await openAssessment(id);toast(existing?"Assessment updated.":(chosenQuestions.length?(randomDrawEnabled?"Randomized assessment template created from a "+chosenQuestions.length+"-question pool; each student receives "+plannedQuestionCount+".":"Assessment template created with "+chosenQuestions.length+" Question Bank question"+(chosenQuestions.length===1?"":"s")+"."):"Assessment template created. You can add questions from the Questions tab."));
    }catch(err){toast(err.message||"Unable to save assessment.");}
  };
}

async function loadAssessment(id){
  const a=await getDoc(doc(db,"assessments",id));
  if(!a.exists())throw new Error("Assessment not found.");
  const assessment={id:a.id,...a.data()};
  const q=await getDocs(collection(db,"assessments",id,"questions"));
  const questions=q.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>Number(x.order||99)-Number(y.order||99));
  let keys=[],submissions=[],results=[],members=[];
  if(state().role==="instructor"){
    const [k,s,r]=await Promise.all([
      getDocs(collection(db,"assessments",id,"keys")),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"submissions")):Promise.resolve({docs:[]}),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"results")):Promise.resolve({docs:[]})
    ]);
    keys=k.docs.map(d=>({id:d.id,...d.data()}));
    submissions=s.docs.map(d=>({id:d.id,...d.data()}));
    results=r.docs.map(d=>({id:d.id,...d.data()}));
    if(assessment.sectionId){
      const m=assessment.entranceExam
        ? await getDocs(collection(db,"sections",assessment.sectionId,"entranceCandidates"))
        : await getDocs(collection(db,"sections",assessment.sectionId,"members"));
      members=m.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>String(x.displayName||"").localeCompare(String(y.displayName||"")));
    }
  }
  return {assessment,questions,keys,submissions,results,members};
}

async function openAssessment(id,tab="overview"){
  try{
    P3.detail=await loadAssessment(id);
    P3.current=P3.detail.assessment;

    // One-time migration for assessments created before competency blueprints
    // became question-driven. New and edited assessments stay synced through
    // the assessment builder actions below.
    if(state()?.role==="instructor"&&P3.detail.questions.length&&P3.current.competencyBlueprintAuto!==true){
      try{
        const competencyDerivation=await calculateAssessmentCompetencyBlueprint(P3.current,P3.detail.questions);
        await updateDoc(doc(db,"assessments",id),{
          competencyBlueprint:competencyDerivation.rows,
          competencyBlueprintAuto:true,
          competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,
          competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,
          updatedAt:serverTimestamp()
        });
        P3.current={...P3.current,
          competencyBlueprint:competencyDerivation.rows,
          competencyBlueprintAuto:true,
          competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,
          competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints
        };
        P3.detail.assessment=P3.current;
      }catch(error){
        console.warn("Unable to migrate competency blueprint for assessment:",id,error);
      }
    }

    renderAssessment(tab);
    core().setPage("assessment-detail",P3.current.courseCode+" / "+P3.current.title);
  }catch(err){toast(err.message||"Unable to open assessment.");}
}

function assessmentTabs(active){
  const tabs=P3.current?.sectionId?[["overview","Overview"],["items","Questions"],["candidates","Candidates"],["grading","Grading"]]:[["overview","Overview"],["items","Questions"]];
  return '<div class="tabs">'+tabs.map(([id,label])=>'<button class="tab-btn '+(active===id?'active':'')+'" data-phase3-action="assessment-tab" data-tab="'+id+'">'+label+'</button>').join("")+'</div>';
}

function blueprintPanel(title,rows){
  return '<div class="panel"><div class="panel-head"><div class="panel-title">'+title+'</div><span class="badge '+(totalWeight(rows)===100?'live':'gold')+'">'+totalWeight(rows)+'%</span></div><div class="panel-body">'+((rows||[]).length?rows.map(x=>'<div class="blueprint-row"><span>'+esc(x.label)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join(""):'<div class="empty-mini">No blueprint targets defined.</div>')+'</div></div>';
}

function overviewView(){
  const a=P3.current;
  const poolSize=Number(a.poolQuestionCount||a.questionIds?.length||a.questionCount||0);
  const randomPanel=a.randomDrawEnabled
    ? '<div class="panel random-plan-overview"><div class="panel-head"><div class="panel-title">Random Draw Plan</div><span class="badge live">'+esc(a.questionCount||0)+' per student</span></div><div class="panel-body">'+
      ((a.randomDrawPlan||[]).length?(a.randomDrawPlan||[]).map(row=>'<div class="blueprint-row"><span>'+esc(row.type)+'</span><strong>'+esc(row.count)+' of '+esc(row.available||"—")+'</strong></div>').join(""):'<div class="empty-mini">No random draw targets are configured.</div>')+
      '<div class="notice" style="margin-top:12px">Question pool: '+esc(poolSize)+' • Each student receives one persistent randomized version.</div></div></div>'
    : '<div class="panel"><div class="panel-head"><div class="panel-title">Question Administration</div></div><div class="panel-body"><div class="detail-list"><div><span>Question order</span><strong>'+(a.randomizeQuestions?"Shuffled per student":"Fixed")+'</strong></div><div><span>Question pool</span><strong>'+esc(poolSize)+'</strong></div></div></div></div>';

  const entranceSource=a.entranceExam
    ? '<div class="panel entrance-source-overview" style="margin-bottom:18px"><div class="panel-head"><div><div class="panel-title">Prerequisite Source</div><div class="panel-subtitle">This enrollment gate may intentionally assess prior-course material.</div></div><span class="badge gold">Cross-Course Ready</span></div><div class="panel-body"><div class="detail-list"><div><span>Source Course</span><strong>'+esc((a.entranceSourceCourseCode||"Course")+(a.entranceSourceCourseTitle?" — "+a.entranceSourceCourseTitle:""))+'</strong></div><div><span>Discipline</span><strong>'+esc(a.entranceSourceDiscipline||"—")+'</strong></div><div><span>Source Template</span><strong>'+esc(a.entranceSourceTemplateTitle||a.title||"Entrance Examination")+'</strong></div><div><span>Required Score</span><strong>'+esc(a.entrancePassPercent||70)+'%</strong></div></div></div></div>'
    : '';
  return entranceSource+'<div class="section-summary"><div class="summary-block"><div class="summary-label">Status</div><div class="summary-value">'+esc(a.status)+'</div></div><div class="summary-block"><div class="summary-label">'+(a.randomDrawEnabled?"Questions / Student":"Questions")+'</div><div class="summary-value">'+esc(a.questionCount||0)+'</div></div><div class="summary-block"><div class="summary-label">Points</div><div class="summary-value">'+esc(a.totalPoints||0)+'</div></div><div class="summary-block"><div class="summary-label">Duration</div><div class="summary-value">'+esc(a.durationMinutes||0)+'m</div></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Administration</div></div><div class="panel-body"><div class="detail-list"><div><span>Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Anonymous grading</span><strong>'+(a.anonymousGrading!==false?"Enabled":"Disabled")+'</strong></div><div><span>Backtracking</span><strong>'+(a.backtracking!==false?"Allowed":"Restricted")+'</strong></div></div></div></div>'+randomPanel+'</div>'+
    '<div class="grid-2" style="margin-top:18px"><div class="panel"><div class="panel-head"><div class="panel-title">Examination Parts</div><span class="badge '+(totalWeight(a.parts)===100?'live':'gold')+'">'+totalWeight(a.parts)+'%</span></div><div class="panel-body">'+(a.parts||[]).map(x=>'<div class="blueprint-row"><span>'+esc(x.title)+'</span><strong>'+esc(x.weight)+'%</strong></div>').join("")+'</div></div>'+blueprintPanel("Content Blueprint",a.contentBlueprint)+'</div>'+
    '<div style="margin-top:18px">'+blueprintPanel("Competency Blueprint · Auto",a.competencyBlueprint)+(Number(a.competencyBlueprintUnmappedPoints||0)>0?'<div class="notice" style="margin-top:10px"><strong>'+esc(a.competencyBlueprintUnmappedPoints)+' assessment point'+(Number(a.competencyBlueprintUnmappedPoints)===1?"":"s")+' currently has no competency tag.</strong><span>Attach competencies to those Question Bank items if you want them represented in the automatic blueprint.</span></div>':'')+'</div>';
}

function itemsView(){
  const a=P3.current,q=P3.detail.questions;
  const randomSummary=a.randomDrawEnabled
    ? '<div class="random-pool-summary"><div><span>Question Pool</span><strong>'+q.length+'</strong></div><div><span>Per Student</span><strong>'+esc(a.questionCount||0)+'</strong></div><div><span>Exam Points</span><strong>'+esc(a.totalPoints||0)+'</strong></div></div>'
    : '';
  const canConfigure=!a.sectionId||!(P3.detail.submissions||[]).length;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">'+(a.entranceExam?'Entrance Examination Snapshot':a.randomDrawEnabled?'Randomized Assessment Pool':'Assessment Assembly')+'</div><p class="page-subtitle">'+(a.entranceExam?'This entrance exam is a locked copy of '+esc(a.entranceSourceCourseCode||a.courseCode||"the source course")+' Question Bank material. Edit the source assessment template and replace the exam from the section to change its content.':a.randomDrawEnabled?'Students receive a locked random subset from this pool according to the draw plan.':'Students never receive answer-key documents.')+'</p></div><div class="inline-actions">'+(a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Entrance Exam</button>':((canConfigure?'<button class="secondary-btn small-btn" data-phase3-action="configure-random-draw">'+(a.randomDrawEnabled?'Edit Random Draw':'Configure Random Draw')+'</button>':'')+'<button class="primary-btn small-btn" data-phase3-action="add-items">Add from Question Bank</button>'))+'</div></div>'+
    randomSummary+
    (a.randomDrawEnabled?'<div class="random-plan-display">'+(a.randomDrawPlan||[]).map(row=>'<div><span>'+esc(row.type)+'</span><strong>'+esc(row.count)+' of '+esc(row.available||q.filter(x=>x.type===row.type).length)+'</strong></div>').join("")+'</div>':'')+
    (q.length?'<div class="assessment-builder-list">'+q.map((x,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc((a.parts||[]).find(p=>p.id===x.partId)?.title||"Main")+' • '+esc(x.type)+'</div><h4>'+esc(x.prompt)+'</h4><div class="item-tags"><span>'+esc(x.points)+' pts</span>'+(x.sourceCourseCode?'<span>Source: '+esc(x.sourceCourseCode)+'</span>':'')+(x.unitTitle?'<span>Unit '+esc(x.unitNumber||"")+' — '+esc(x.unitTitle)+'</span>':'')+'<span>'+esc(x.topicNumber||"No topic")+'</span>'+(x.competencyCodes||[]).map(code=>'<span>'+esc(code)+'</span>').join("")+'</div></div>'+(a.entranceExam?'':'<div class="inline-actions"><button class="text-btn" data-phase3-action="configure-item" data-id="'+x.id+'">Configure</button><button class="text-btn danger-text" data-phase3-action="remove-item" data-id="'+x.id+'">Remove</button></div>')+'</div>').join("")+'</div>':
    '<div class="empty-state"><div class="empty-symbol">Q</div><h3>No assessment questions yet.</h3><p>'+(a.entranceExam?'Replace the entrance exam from the section with a populated source template.':'Add reusable questions from the course Question Bank.')+'</p>'+(a.entranceExam?'':'<button class="primary-btn" data-phase3-action="add-items">Add Questions</button>')+'</div>');
}

function configureRandomDrawModal(){
  const a=P3.current,d=P3.detail;if(!a||!d)return;
  if(a.sectionId&&d.submissions.length)return toast("Random draw settings lock after the first student attempt is created.");

  const groups=new Map();
  d.questions.forEach(q=>{
    if(!groups.has(q.type))groups.set(q.type,[]);
    groups.get(q.type).push(q);
  });
  if(!groups.size)return toast("Add questions to the assessment before configuring a random draw.");

  const existing=new Map((a.randomDrawPlan||[]).map(row=>[row.type,Number(row.count||0)]));
  const modal=core().openModal({
    eyebrow:"Random Assessment Versions",
    title:"Configure Random Draw",
    wide:true,
    body:'<form id="randomDrawConfigForm" class="academic-form"><section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Randomization Mode</h3><p>Choose whether every student receives the entire pool or a random subset by question type.</p></div></div>'+
      '<label class="policy-card random-draw-toggle"><input type="checkbox" name="enabled" '+(a.randomDrawEnabled?'checked':'')+'><div><strong>Use Random Draw</strong><span>Each student receives a separately randomized version that remains locked for their attempt.</span></div></label></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Questions Per Student</h3><p>Set how many questions to draw from each type in the pool.</p></div></div><div id="editRandomPlan" class="random-draw-plan">'+
      [...groups.entries()].map(([type,questions])=>{
        const points=[...new Set(questions.map(q=>Number(q.points||0)))],value=existing.has(type)?Math.min(existing.get(type),questions.length):questions.length;
        return '<div class="random-draw-row"><div><strong>'+esc(type)+'</strong><span>'+questions.length+' available • '+(points.length===1?esc(points[0])+' pts each':'mixed point values')+'</span></div><div class="input-with-suffix mini"><input class="random-draw-count" data-type="'+esc(type)+'" type="number" min="0" max="'+questions.length+'" step="1" value="'+esc(value)+'"><span>draw</span></div></div>';
      }).join("")+
      '</div></section><div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Random Draw</button></div></form>'
  });

  const form=modal.querySelector("#randomDrawConfigForm");
  form.onsubmit=async e=>{
    e.preventDefault();
    const enabled=form.elements.enabled.checked;
    let plan=[],questionCount=d.questions.length,totalPoints=d.questions.reduce((n,q)=>n+Number(q.points||0),0);
    if(enabled){
      for(const [type,questions] of groups){
        const input=form.querySelector('.random-draw-count[data-type="'+CSS.escape(type)+'"]');
        const count=Math.max(0,Math.min(questions.length,Math.floor(Number(input?.value||0))));
        if(!count)continue;
        const points=[...new Set(questions.map(q=>Number(q.points||0)))];
        if(points.length!==1)return toast("All "+type+" questions in a randomized pool must use the same point value.");
        plan.push({type,count,available:questions.length,pointsPerQuestion:points[0]});
      }
      if(!plan.length)return toast("Set at least one question type above zero.");
      questionCount=plan.reduce((n,row)=>n+row.count,0);
      totalPoints=plan.reduce((n,row)=>n+(row.count*row.pointsPerQuestion),0);
    }
    const questionPool=d.questions.map(q=>({id:q.id,itemId:q.itemId||"",type:q.type,points:Number(q.points||0)}));
    try{
      const competencyDerivation=await calculateAssessmentCompetencyBlueprint(a,d.questions,null,{randomDrawEnabled:enabled,randomDrawPlan:plan});
      await updateDoc(doc(db,"assessments",a.id),{
        randomDrawEnabled:enabled,randomDrawPlan:plan,randomizeQuestions:enabled?true:!!a.randomizeQuestions,
        questionPool,poolQuestionCount:d.questions.length,questionCount,totalPoints,
        competencyBlueprint:competencyDerivation.rows,competencyBlueprintAuto:true,
        competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,
        competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,
        updatedAt:serverTimestamp()
      });
      core().closeModal();await openAssessment(a.id,"items");toast(enabled?"Random draw updated.":"Random draw disabled; all assessment questions will be used.");
    }catch(err){toast(err.message||"Unable to update the random draw.");}
  };
}

function candidatesView(){
  const d=P3.detail,a=d.assessment,subMap=new Map(d.submissions.map(x=>[x.studentId,x])),resMap=new Map(d.results.map(x=>[x.studentId,x]));
  if(!d.members.length)return '<div class="empty-state"><div class="empty-symbol">C</div><h3>No enrolled candidates.</h3></div>';
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Student Visibility</th><th>Action</th></tr></thead><tbody>'+d.members.map(m=>{
    const sub=subMap.get(m.id),res=resMap.get(m.id),name=a.anonymousGrading!==false?(sub?.candidateNumber||"Not assigned"):m.displayName;
    let action="—";
    if(!sub&&(a.mode==="oral"))action='<button class="secondary-btn small-btn" data-phase3-action="create-evaluation" data-student="'+m.id+'">Begin Evaluation</button>';
    else if(sub)action='<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>';
    if(a.entranceExam&&(sub||res))action='<div class="inline-actions">'+(sub?'<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>':'')+'<button class="text-btn danger-text" data-phase3-action="reset-entrance-attempt" data-student="'+m.id+'">Reset Attempt</button></div>';
    const visibility=a.entranceExam
      ? (res?.complete?'<span class="badge '+(Number(res.percent||0)>=Number(a.entrancePassPercent||70)?'live':'gold')+'">'+(Number(res.percent||0)>=Number(a.entrancePassPercent||70)?'Passed':'Not Passed')+'</span>':sub?'<span class="badge gold">'+esc(sub.status||"In progress")+'</span>':'<span class="badge">Waiting</span>')
      : (res?(res.complete===false?'<span class="badge gold">Private while grading</span>':'<span class="badge live">Visible to student</span>'):"—");
    return '<tr><td><strong>'+esc(name)+'</strong></td><td><span class="badge">'+esc(sub?.status||"Not started")+'</span></td><td>'+(res?'<strong>'+esc(res.percent)+'%</strong>':'—')+'</td><td>'+visibility+'</td><td>'+action+'</td></tr>';
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
  const template=!a.sectionId;
  if(template&&(tab==="candidates"||tab==="grading"))tab="overview";
  const body=tab==="items"?itemsView():tab==="candidates"?candidatesView():tab==="grading"?gradingView():overviewView();
  let statusButton="";
  if(a.entranceExam===true)statusButton='';
  else if(template)statusButton='<button class="primary-btn small-btn" data-phase3-action="assign-assessment" data-id="'+a.id+'">Assign to Section</button>';
  else if(a.status==="Draft")statusButton='<button class="primary-btn small-btn" data-phase3-action="publish">Publish to Students</button>';
  else if(a.status==="Published")statusButton='<button class="secondary-btn small-btn" data-phase3-action="close">Close</button>';
  else statusButton='<button class="secondary-btn small-btn" data-phase3-action="reopen">Reopen</button>';
  $("#assessmentDetail").innerHTML='<button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(a.courseCode)+' • '+esc(a.type)+(a.entranceExam?' • ENTRANCE EXAM':'')+'</div><h1 class="detail-title">'+esc(a.title)+'</h1><div class="detail-meta"><span>'+(template?'Reusable Template':esc(a.sectionName||"Assigned Section"))+'</span><span>'+esc(a.entranceExam?'Enrollment Gate':template?"Template":a.status)+'</span>'+(template||a.entranceExam?'':'<span>'+esc(dateText(a.opensAt))+'</span>')+'</div></div><div class="inline-actions">'+(a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Section</button>':(!template?'<button class="secondary-btn small-btn" data-phase3-action="edit-assignment" data-id="'+a.id+'">Edit Assignment</button>':''))+(a.entranceExam?'':'<button class="secondary-btn small-btn" data-phase3-action="edit-assessment">Edit Content</button>')+statusButton+(a.entranceExam?'':'<button class="danger-btn small-btn" data-phase3-action="delete-assessment" data-id="'+a.id+'">Delete Assessment</button>')+'</div></div>'+(a.instructions?'<p class="page-subtitle" style="margin-top:16px">'+esc(a.instructions)+'</p>':'')+'</div>'+
    (template?'<div class="workflow-strip"><div class="done"><span>1</span><strong>Template</strong></div><div class="'+(a.questionCount?"done":"current")+'"><span>2</span><strong>Question Bank</strong></div><div class="'+(a.questionCount?"current":"")+'"><span>3</span><strong>Assign</strong></div><div><span>4</span><strong>Publish</strong></div></div>':'')+
    assessmentTabs(tab)+'<div>'+body+'</div>';
}

async function addItemsModal(){
  await loadItems();
  const a=P3.current;
  const available=P3.items.filter(x=>x.courseId===a.courseId&&!P3.detail.questions.some(q=>q.itemId===x.id));
  if(!available.length)return toast("No unused Question Bank questions are available for this course.");

  let fw={units:[],competencies:[]};
  try{fw=await framework(a.courseId);}catch(error){console.warn("Unable to load course framework for assessment Question Bank:",error);}

  const topicSortValue=value=>String(value||"").split(".").map(part=>String(Number(part)||0).padStart(4,"0")).join(".");
  const groups=(core().unitFolderGroups?core().unitFolderGroups(available,fw):[])
    .map(group=>({...group,items:[...group.items].sort((x,y)=>
      topicSortValue(x.topicNumber).localeCompare(topicSortValue(y.topicNumber))
      ||String(x.type||"").localeCompare(String(y.type||""))
      ||String(x.prompt||"").localeCompare(String(y.prompt||""))
    )}));
  if(!groups.length)groups.push({id:"unsorted",unit:null,label:"Unsorted",items:[...available]});

  const unitOptions='<option value="all">All Units ('+available.length+')</option>'+
    groups.map(group=>'<option value="'+esc(group.id)+'">'+esc(group.label)+' ('+group.items.length+')</option>').join("");

  const groupHtml=groups.map((group,index)=>{
    const rows=group.items.map(x=>{
      const searchText=[
        x.prompt,x.type,x.topicNumber,x.topicTitle,x.unitTitle,x.difficulty,
        ...(x.competencyCodes||[]),...(x.tags||[])
      ].filter(Boolean).join(" ").toLowerCase();
      return '<label class="item-select-row assessment-bank-item" data-unit="'+esc(group.id)+'" data-search="'+esc(searchText)+'">'+
        '<input type="checkbox" name="item" value="'+x.id+'">'+
        '<div><strong>'+esc(x.type)+' • '+esc(x.topicNumber||"No topic")+'</strong>'+
        '<p>'+esc(x.prompt)+'</p>'+
        '<span>'+esc(x.pointsDefault||1)+' pts • '+esc(x.difficulty||"Moderate")+(x.topicTitle?' • '+esc(x.topicTitle):'')+'</span></div></label>';
    }).join("");
    return '<details class="unit-folder assessment-bank-unit '+(group.id==="unsorted"?'unsorted-folder':'')+'" data-unit-group="'+esc(group.id)+'" '+(index===0?'open':'')+'>'+
      '<summary><div class="unit-folder-icon">'+(group.id==="unsorted"?'?':esc(group.unit?.order||"U"))+'</div>'+
      '<div><strong>'+esc(group.label)+'</strong><span>'+group.items.length+' available question'+(group.items.length===1?"":"s")+'</span></div>'+
      '<div class="unit-folder-chevron">⌄</div></summary>'+
      '<div class="unit-folder-body"><div class="assessment-unit-actions"><span>Choose questions from this unit</span><button type="button" class="text-btn" data-select-assessment-unit="'+esc(group.id)+'">Select Unit</button></div>'+
      '<div class="item-select-list assessment-unit-question-list">'+rows+'</div></div>'+
      '</details>';
  }).join("");

  const modal=core().openModal({
    eyebrow:"Assessment Assembly",
    title:"Add Questions from Question Bank",
    wide:true,
    body:'<form id="addItemsForm" class="academic-form">'+
      '<section class="form-section assessment-bank-picker">'+
        '<div class="form-section-head"><div><span>01</span><h3>Assessment Placement</h3><p>Choose the examination part, then browse the Question Bank by course unit.</p></div></div>'+
        '<div class="assessment-bank-controls">'+
          '<div class="field"><label>Examination Part</label><select name="partId">'+(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("")+'</select></div>'+
          '<div class="field"><label>Unit</label><select id="assessmentBankUnitFilter">'+unitOptions+'</select></div>'+
          '<div class="field assessment-bank-search"><label>Search Questions</label><input id="assessmentBankSearch" type="search" placeholder="Prompt, topic, type, competency, tag…"></div>'+
        '</div>'+
      '</section>'+
      '<section class="form-section">'+
        '<div class="assessment-bank-selection-bar"><div><strong id="assessmentSelectedCount">0 selected</strong><span>'+available.length+' unused Question Bank question'+(available.length===1?"":"s")+' available</span></div>'+
        '<div class="inline-actions"><button type="button" class="secondary-btn small-btn" id="selectVisibleAssessmentItems">Select Visible</button><button type="button" class="text-btn" id="clearAssessmentItems">Clear</button></div></div>'+
        '<div id="assessmentBankUnitGroups" class="unit-folder-stack assessment-bank-unit-stack">'+groupHtml+'</div>'+
        '<div id="assessmentBankNoMatch" class="empty-mini hidden">No questions match the current unit and search filters.</div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit" id="addSelectedAssessmentItems">Add Selected Questions</button></div>'+
    '</form>'
  });

  const form=modal.querySelector("#addItemsForm");
  const unitFilter=modal.querySelector("#assessmentBankUnitFilter");
  const search=modal.querySelector("#assessmentBankSearch");
  const selectedCount=modal.querySelector("#assessmentSelectedCount");
  const submitButton=modal.querySelector("#addSelectedAssessmentItems");
  const noMatch=modal.querySelector("#assessmentBankNoMatch");

  const allChecks=()=>[...form.querySelectorAll('input[name="item"]')];
  const updateSelectedCount=()=>{
    const count=allChecks().filter(input=>input.checked).length;
    selectedCount.textContent=count+" selected";
    submitButton.textContent=count?"Add "+count+" Selected Question"+(count===1?"":"s"):"Add Selected Questions";
  };

  const updateFilters=()=>{
    const selectedUnit=unitFilter.value;
    const term=String(search.value||"").trim().toLowerCase();
    let visibleTotal=0;

    modal.querySelectorAll("[data-unit-group]").forEach(group=>{
      const groupId=group.dataset.unitGroup;
      const unitMatches=selectedUnit==="all"||selectedUnit===groupId;
      let visibleInGroup=0;
      group.querySelectorAll(".assessment-bank-item").forEach(row=>{
        const searchMatches=!term||String(row.dataset.search||"").includes(term);
        const visible=unitMatches&&searchMatches;
        row.classList.toggle("hidden",!visible);
        if(visible){visibleInGroup++;visibleTotal++;}
      });
      group.classList.toggle("hidden",visibleInGroup===0);
      if((term||selectedUnit!=="all")&&visibleInGroup)group.open=true;
    });

    noMatch.classList.toggle("hidden",visibleTotal!==0);
  };

  form.addEventListener("change",e=>{
    if(e.target.matches('input[name="item"]'))updateSelectedCount();
  });
  unitFilter.addEventListener("change",updateFilters);
  search.addEventListener("input",updateFilters);

  modal.querySelectorAll("[data-select-assessment-unit]").forEach(button=>{
    button.addEventListener("click",()=>{
      const group=modal.querySelector('[data-unit-group="'+CSS.escape(button.dataset.selectAssessmentUnit)+'"]');
      if(!group)return;
      group.querySelectorAll('input[name="item"]').forEach(input=>input.checked=true);
      updateSelectedCount();
    });
  });

  modal.querySelector("#selectVisibleAssessmentItems").addEventListener("click",()=>{
    modal.querySelectorAll(".assessment-bank-item:not(.hidden) input[name='item']").forEach(input=>input.checked=true);
    updateSelectedCount();
  });
  modal.querySelector("#clearAssessmentItems").addEventListener("click",()=>{
    allChecks().forEach(input=>input.checked=false);
    updateSelectedCount();
  });

  updateSelectedCount();
  updateFilters();

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget),ids=fd.getAll("item");if(!ids.length)return toast("Select at least one item.");
    const batch=writeBatch(db),questionIds=P3.detail.questions.map(q=>q.id);
    const questionPool=(a.questionPool?.length?a.questionPool:P3.detail.questions.map(q=>({id:q.id,itemId:q.itemId||"",type:q.type,points:Number(q.points||0)}))).map(x=>({...x}));
    let order=P3.detail.questions.length,total=Number(a.totalPoints||0);
    for(const id of ids){
      const item=available.find(x=>x.id===id);if(!item)continue;
      const ref=doc(collection(db,"assessments",a.id,"questions"));order++;questionIds.push(ref.id);
      const points=Number(item.pointsDefault||1);
      if(!a.randomDrawEnabled)total+=points;
      questionPool.push({id:ref.id,itemId:item.id,type:item.type,points});
      batch.set(ref,{
        itemId:item.id,order,partId:String(fd.get("partId")),type:item.type,prompt:item.prompt,
        stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points,
        unitId:item.unitId||"",unitTitle:item.unitTitle||"",unitNumber:Number(item.unitNumber||0),
        topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
        competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()
      });
      batch.set(doc(db,"assessments",a.id,"keys",ref.id),{itemId:item.id,correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()});
    }
    const addedQuestions=ids.map(id=>{
      const item=available.find(x=>x.id===id);
      return item?{...item,points:Number(item.pointsDefault||1)}:null;
    }).filter(Boolean);
    const combinedQuestions=[...P3.detail.questions,...addedQuestions];
    const updatedRandomDrawPlan=(a.randomDrawPlan||[]).map(row=>({
      ...row,
      available:combinedQuestions.filter(q=>q.type===row.type).length
    }));
    const competencyDerivation=deriveCompetencyBlueprint(combinedQuestions,fw.competencies||[],{
      randomDrawEnabled:!!a.randomDrawEnabled,
      randomDrawPlan:updatedRandomDrawPlan
    });
    batch.update(doc(db,"assessments",a.id),{
      questionIds,questionPool,poolQuestionCount:questionPool.length,
      randomDrawPlan:updatedRandomDrawPlan,
      questionCount:a.randomDrawEnabled?Number(a.questionCount||0):order,
      totalPoints:a.randomDrawEnabled?Number(a.totalPoints||0):total,
      competencyBlueprint:competencyDerivation.rows,competencyBlueprintAuto:true,
      competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,
      competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,
      updatedAt:serverTimestamp()
    });
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"items");toast(ids.length+" question"+(ids.length===1?"":"s")+" added.");}catch(err){toast(err.message||"Unable to add questions.");}
  });
}

function configureItemModal(id){
  const q=P3.detail.questions.find(x=>x.id===id),a=P3.current;if(!q)return;
  const modal=core().openModal({
    eyebrow:"Assessment Question",
    title:"Configure Question",
    body:'<form id="configureItemForm"><div class="field"><label>Examination Part</label><select name="partId">'+(a.parts||[]).map(p=>'<option value="'+p.id+'">'+esc(p.title)+'</option>').join("")+'</select></div><div class="field"><label>Points</label><input name="points" type="number" min="0" step="0.5" value="'+esc(q.points)+'"></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save</button></div></form>'
  });
  const form=modal.querySelector("#configureItemForm");form.partId.value=q.partId||a.parts?.[0]?.id;
  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form),points=Number(fd.get("points")||0),delta=points-Number(q.points||0),batch=writeBatch(db);
    let questionPool=(a.questionPool?.length?a.questionPool:P3.detail.questions.map(x=>({id:x.id,itemId:x.itemId||"",type:x.type,points:Number(x.points||0)}))).map(x=>({...x}));
    let randomDrawPlan=(a.randomDrawPlan||[]).map(x=>({...x}));
    let totalPoints=Number(a.totalPoints||0);

    if(a.randomDrawEnabled){
      const sameType=P3.detail.questions.filter(x=>x.id!==q.id&&x.type===q.type);
      const otherPointValues=[...new Set(sameType.map(x=>Number(x.points||0)))];
      if(otherPointValues.length&&otherPointValues.some(v=>v!==points))return toast("Randomized "+q.type+" questions must all use the same point value.");
      const planRow=randomDrawPlan.find(row=>row.type===q.type);
      if(planRow)planRow.pointsPerQuestion=points;
      questionPool=questionPool.map(x=>x.id===q.id?{...x,points}:x);
      totalPoints=randomDrawPlan.reduce((n,row)=>n+(Number(row.count||0)*Number(row.pointsPerQuestion||0)),0);
    }else totalPoints+=delta;

    const updatedQuestions=P3.detail.questions.map(x=>x.id===q.id?{...x,points}:x);
    const fw=await framework(a.courseId);
    const competencyDerivation=deriveCompetencyBlueprint(updatedQuestions,fw.competencies||[],{randomDrawEnabled:!!a.randomDrawEnabled,randomDrawPlan});
    batch.update(doc(db,"assessments",a.id,"questions",id),{partId:String(fd.get("partId")),points,updatedAt:serverTimestamp()});
    batch.update(doc(db,"assessments",a.id),{questionPool,randomDrawPlan,totalPoints,competencyBlueprint:competencyDerivation.rows,competencyBlueprintAuto:true,competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,updatedAt:serverTimestamp()});
    try{await batch.commit();core().closeModal();await openAssessment(a.id,"items");}catch(err){toast(err.message||"Unable to configure question.");}
  });
}

async function removeItem(id){
  const q=P3.detail.questions.find(x=>x.id===id),a=P3.current;if(!q)return;
  if(a.sectionId&&P3.detail.submissions.length)return toast("Questions cannot be removed after a student attempt has been created.");
  const remaining=P3.detail.questions.filter(x=>x.id!==id);
  const remainingOfType=remaining.filter(x=>x.type===q.type).length;
  const planRow=(a.randomDrawPlan||[]).find(row=>row.type===q.type);
  if(a.randomDrawEnabled&&planRow&&Number(planRow.count||0)>remainingOfType){
    return toast("Reduce the "+q.type+" random draw count before removing this question.");
  }
  if(!confirm("Remove this question from the assessment? The Question Bank copy remains."))return;

  const questionIds=remaining.map(x=>x.id);
  const questionPool=(a.questionPool?.length?a.questionPool:P3.detail.questions.map(x=>({id:x.id,itemId:x.itemId||"",type:x.type,points:Number(x.points||0)}))).filter(x=>x.id!==id);
  const randomDrawPlan=(a.randomDrawPlan||[]).map(row=>row.type===q.type?{...row,available:remainingOfType}:row).filter(row=>Number(row.available??1)>0||Number(row.count||0)>0);
  const questionCount=a.randomDrawEnabled?Number(a.questionCount||0):remaining.length;
  const totalPoints=a.randomDrawEnabled
    ? randomDrawPlan.reduce((n,row)=>n+(Number(row.count||0)*Number(row.pointsPerQuestion||0)),0)
    : remaining.reduce((n,x)=>n+Number(x.points||0),0);

  const fw=await framework(a.courseId);
  const competencyDerivation=deriveCompetencyBlueprint(remaining,fw.competencies||[],{randomDrawEnabled:!!a.randomDrawEnabled,randomDrawPlan});
  const batch=writeBatch(db);
  batch.delete(doc(db,"assessments",a.id,"questions",id));
  batch.delete(doc(db,"assessments",a.id,"keys",id));
  batch.update(doc(db,"assessments",a.id),{questionIds,questionPool,poolQuestionCount:questionPool.length,randomDrawPlan,questionCount,totalPoints,competencyBlueprint:competencyDerivation.rows,competencyBlueprintAuto:true,competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,updatedAt:serverTimestamp()});
  try{await batch.commit();await openAssessment(a.id,"items");}catch(err){toast(err.message||"Unable to remove question.");}
}


async function deleteEntranceAssessmentTree(assessmentId){
  if(!assessmentId)return;
  const submissionSnap=await getDocs(collection(db,"assessments",assessmentId,"submissions"));
  for(const sub of submissionSnap.docs){
    const events=await getDocs(collection(db,"assessments",assessmentId,"submissions",sub.id,"events"));
    for(let offset=0;offset<events.docs.length;offset+=400){
      const batch=writeBatch(db);
      events.docs.slice(offset,offset+400).forEach(d=>batch.delete(d.ref));
      await batch.commit();
    }
  }
  for(const name of ["questions","keys","results","submissions"]){
    const snap=await getDocs(collection(db,"assessments",assessmentId,name));
    for(let offset=0;offset<snap.docs.length;offset+=400){
      const batch=writeBatch(db);
      snap.docs.slice(offset,offset+400).forEach(d=>batch.delete(d.ref));
      await batch.commit();
    }
  }
  await deleteDoc(doc(db,"assessments",assessmentId));
}

async function configureEntranceExam(sectionId){
  const s=state();
  if(!s||s.role!=="instructor")return;
  const section=s.sections.find(sec=>sec.id===sectionId)||s.currentSection;
  if(!section)return toast("Section not found.");

  await loadAssessments();

  // Entrance examinations are intentionally allowed to come from a different
  // course. This lets a second-course or advanced-course section test mastery
  // of prior coursework before enrollment.
  const templates=P3.assessments
    .filter(a=>!a.sectionId&&a.mode!=="oral"&&Number(a.questionCount||a.questionIds?.length||0)>0)
    .sort((a,b)=>{
      const ac=String(a.courseCode||""),bc=String(b.courseCode||"");
      return ac.localeCompare(bc)||String(a.title||"").localeCompare(String(b.title||""));
    });

  if(!templates.length){
    const modal=core().openModal({
      eyebrow:"Entrance Examination",
      title:"Create an Assessment Template First",
      body:'<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.courseTitle||"Course")+'</h3><p>Entrance examinations can draw from assessment templates built from any course Question Bank you teach.</p></div><div class="notice"><strong>No eligible written assessment templates exist yet.</strong><p>Create an assessment template from the Question Bank of the prerequisite or prior course you want students tested on, then return here.</p></div>',
      footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="createEntranceTemplate">Create Assessment Template</button>'
    });
    modal.querySelector("#createEntranceTemplate").onclick=()=>{core().closeModal();core().setPage("assessments");setTimeout(()=>assessmentModal(),60);};
    return;
  }

  const courseById=new Map((s.courses||[]).map(course=>[course.id,course]));
  const grouped=new Map();
  for(const template of templates){
    const course=courseById.get(template.courseId)||{
      id:template.courseId,
      code:template.courseCode||"Course",
      title:template.courseTitle||"Course",
      discipline:""
    };
    if(!grouped.has(course.id))grouped.set(course.id,{course,templates:[]});
    grouped.get(course.id).templates.push(template);
  }

  // Prefer an explicitly configured source. Otherwise, if this appears to be
  // a later course in a discipline, prefer a different course from the same
  // discipline before falling back to the current course.
  const targetCourse=courseById.get(section.courseId);
  let preferredTemplateId=section.entranceTemplateSourceId||"";
  if(!preferredTemplateId){
    const sameDisciplineDifferentCourse=templates.find(template=>{
      const sourceCourse=courseById.get(template.courseId);
      return sourceCourse
        && template.courseId!==section.courseId
        && targetCourse?.discipline
        && String(sourceCourse.discipline||"").trim().toLowerCase()===String(targetCourse.discipline||"").trim().toLowerCase();
    });
    preferredTemplateId=(sameDisciplineDifferentCourse||templates.find(t=>t.courseId===section.courseId)||templates[0])?.id||"";
  }

  const templateOptions=[...grouped.values()].map(group=>{
    const course=group.course;
    const label=(course.code||"Course")+" — "+(course.title||"Untitled Course")+(course.discipline?" · "+course.discipline:"");
    return '<optgroup label="'+esc(label)+'">'+group.templates.map(t=>
      '<option value="'+t.id+'" '+(t.id===preferredTemplateId?'selected':'')+'>'+
        esc(t.title)+' • '+esc(t.questionCount||t.questionIds?.length||0)+' questions • '+esc(t.totalPoints||0)+' pts'+
      '</option>'
    ).join("")+'</optgroup>';
  }).join("");

  let hasExistingAttempts=false;
  if(section.entranceAssessmentId){
    try{
      const existingAttempts=await getDocs(collection(db,"assessments",section.entranceAssessmentId,"submissions"));
      hasExistingAttempts=existingAttempts.docs.length>0;
    }catch(_){}
  }

  const modal=core().openModal({
    eyebrow:"Entrance Examination",
    title:section.entranceAssessmentId?"Change Entrance Examination":"Configure Entrance Examination",
    wide:true,
    body:'<form id="entranceExamForm" class="academic-form">'+
      '<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+'</div><h3>'+esc(section.sectionName||section.courseTitle||"Section")+'</h3><p>The entrance exam may test this course or prerequisite material from a different course or discipline.</p></div>'+
      (hasExistingAttempts?'<div class="notice danger-notice"><strong>This section already has entrance-exam attempts.</strong><p>Replacing the exam will permanently clear those entrance attempts and results. Enrolled students are not affected.</p></div>':'')+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Prerequisite / Source Course</h3><p>Select an assessment template from any course you teach. For a second course in a sequence, you can deliberately choose the earlier course so the entrance exam measures prior mastery.</p></div></div>'+
        '<div class="field"><label>Entrance Examination Template</label><select name="templateId" id="entranceTemplateSelect">'+templateOptions+'</select></div>'+
        '<div id="entranceSourcePreview" class="entrance-source-preview"></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Passing Requirement</h3><p>The final graded percentage must meet or exceed this threshold before enrollment unlocks.</p></div></div>'+
        '<div class="field"><label>Passing Score</label><div class="input-with-suffix"><input name="passPercent" type="number" min="1" max="100" step="1" value="'+esc(section.entrancePassPercent||70)+'" required><span>%</span></div></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">'+(section.entranceAssessmentId?"Replace Entrance Exam":"Configure Entrance Exam")+'</button></div>'+
    '</form>'
  });

  const form=modal.querySelector("#entranceExamForm");
  const select=modal.querySelector("#entranceTemplateSelect");
  const preview=modal.querySelector("#entranceSourcePreview");
  const renderSourcePreview=()=>{
    const template=templates.find(x=>x.id===select.value)||templates[0];
    const sourceCourse=courseById.get(template?.courseId)||{};
    const crossCourse=template?.courseId!==section.courseId;
    preview.innerHTML=template
      ? '<div class="entrance-source-card '+(crossCourse?'cross-course':'same-course')+'">'+
          '<div><span>'+(crossCourse?'PREREQUISITE SOURCE':'CURRENT COURSE SOURCE')+'</span><strong>'+esc(template.courseCode||sourceCourse.code||"Course")+' — '+esc(template.courseTitle||sourceCourse.title||"Course")+'</strong>'+
          '<small>'+(sourceCourse.discipline?esc(sourceCourse.discipline)+' • ':'')+esc(template.title||"Assessment Template")+'</small></div>'+
          '<div class="entrance-source-stats"><span><strong>'+esc(template.questionCount||template.questionIds?.length||0)+'</strong> questions</span><span><strong>'+esc(template.totalPoints||0)+'</strong> points</span></div>'+
        '</div>'
      : '';
  };
  select.addEventListener("change",renderSourcePreview);
  renderSourcePreview();

  form.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(form),templateId=String(fd.get("templateId")),passPercent=Math.max(1,Math.min(100,Math.round(Number(fd.get("passPercent")||70))));
    const template=templates.find(x=>x.id===templateId);
    if(!template)return toast("Choose an assessment template.");
    if(hasExistingAttempts&&!confirm("Replace the entrance examination and permanently clear existing entrance attempts and results?"))return;

    const button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent="Configuring…";
    try{
      const source=await loadAssessment(template.id);
      if(!source.questions.length)throw new Error("The selected template has no questions.");

      const sourceCourse=courseById.get(template.courseId)||{};
      const ref=doc(collection(db,"assessments"));
      const questionRefs=source.questions.map(()=>doc(collection(db,"assessments",ref.id,"questions")));
      const questionIds=questionRefs.map(q=>q.id);

      // The entrance assessment belongs academically to the destination
      // section/course, while retaining explicit source-course provenance for
      // every imported prerequisite question.
      const clone={
        ...Object.fromEntries(Object.entries(source.assessment).filter(([k])=>![
          "id","createdAt","updatedAt","sectionId","sectionName","status","opensAt","closesAt",
          "templateSourceId","entranceExam","courseId","courseCode","courseTitle","questionIds",
          "questionPool","poolQuestionCount","questionCount","totalPoints"
        ].includes(k))),
        ownerId:s.user.uid,
        courseId:section.courseId,
        courseCode:section.courseCode,
        courseTitle:section.courseTitle,
        sectionId:section.id,
        sectionName:section.sectionName,
        templateSourceId:template.id,
        entranceExam:true,
        entrancePassPercent:passPercent,
        entranceSourceCourseId:template.courseId,
        entranceSourceCourseCode:template.courseCode||sourceCourse.code||"",
        entranceSourceCourseTitle:template.courseTitle||sourceCourse.title||"",
        entranceSourceDiscipline:sourceCourse.discipline||"",
        entranceSourceTemplateTitle:template.title||"",
        title:template.title,
        status:"Published",
        opensAt:null,
        closesAt:null,
        randomDrawEnabled:false,
        randomDrawPlan:[],
        randomizeQuestions:!!template.randomizeQuestions,
        questionIds,
        questionPool:source.questions.map((q,index)=>({
          id:questionRefs[index].id,
          itemId:q.itemId||"",
          type:q.type,
          points:Number(q.points||0)
        })),
        poolQuestionCount:source.questions.length,
        questionCount:source.questions.length,
        totalPoints:source.questions.reduce((n,q)=>n+Number(q.points||0),0),
        createdAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      };
      await setDoc(ref,clone);

      for(let offset=0;offset<source.questions.length;offset+=180){
        const batch=writeBatch(db),chunk=source.questions.slice(offset,offset+180);
        for(let localIndex=0;localIndex<chunk.length;localIndex++){
          const sourceQuestion=chunk[localIndex];
          const absoluteIndex=offset+localIndex;
          const questionRef=questionRefs[absoluteIndex];
          const cleanQ=Object.fromEntries(Object.entries(sourceQuestion).filter(([k])=>k!=="id"));
          batch.set(questionRef,{
            ...cleanQ,
            order:absoluteIndex+1,
            sourceCourseId:template.courseId,
            sourceCourseCode:template.courseCode||sourceCourse.code||"",
            sourceCourseTitle:template.courseTitle||sourceCourse.title||"",
            sourceTemplateId:template.id,
            sourceTemplateTitle:template.title||"",
            clonedAt:serverTimestamp()
          });
          const key=source.keys.find(k=>k.id===sourceQuestion.id);
          if(key){
            const cleanK=Object.fromEntries(Object.entries(key).filter(([k])=>k!=="id"));
            batch.set(doc(db,"assessments",ref.id,"keys",questionRef.id),{...cleanK,itemId:sourceQuestion.itemId||key.itemId||"",clonedAt:serverTimestamp()});
          }
        }
        await batch.commit();
      }

      const oldAssessmentId=section.entranceAssessmentId||"";

      if(oldAssessmentId&&oldAssessmentId!==ref.id){
        const candidates=await getDocs(collection(db,"sections",section.id,"entranceCandidates"));
        for(let offset=0;offset<candidates.docs.length;offset+=400){
          const batch=writeBatch(db);
          candidates.docs.slice(offset,offset+400).forEach(d=>batch.delete(d.ref));
          await batch.commit();
        }
      }

      await updateDoc(doc(db,"sections",section.id),{
        entranceExamRequired:false,
        entranceAssessmentId:ref.id,
        entranceTemplateSourceId:template.id,
        entranceExamTitle:template.title,
        entrancePassPercent:passPercent,
        entranceSourceCourseId:template.courseId,
        entranceSourceCourseCode:template.courseCode||sourceCourse.code||"",
        entranceSourceCourseTitle:template.courseTitle||sourceCourse.title||"",
        entranceSourceDiscipline:sourceCourse.discipline||"",
        entranceConfiguredAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      });

      Object.assign(section,{
        entranceExamRequired:false,
        entranceAssessmentId:ref.id,
        entranceTemplateSourceId:template.id,
        entranceExamTitle:template.title,
        entrancePassPercent:passPercent,
        entranceSourceCourseId:template.courseId,
        entranceSourceCourseCode:template.courseCode||sourceCourse.code||"",
        entranceSourceCourseTitle:template.courseTitle||sourceCourse.title||"",
        entranceSourceDiscipline:sourceCourse.discipline||""
      });
      const sectionIndex=s.sections.findIndex(x=>x.id===section.id);
      if(sectionIndex>=0)s.sections[sectionIndex]={...s.sections[sectionIndex],...section};
      if(s.currentSection?.id===section.id)Object.assign(s.currentSection,section);

      if(oldAssessmentId&&oldAssessmentId!==ref.id){
        try{await deleteEntranceAssessmentTree(oldAssessmentId);}catch(error){console.warn("Old entrance examination cleanup failed:",error);}
      }

      core().closeModal();
      await core().reloadCurrentSection("overview");
      const sourceLabel=(template.courseCode||sourceCourse.code||"Prerequisite course");
      toast("Entrance examination configured from "+sourceLabel+". Students must earn "+passPercent+"% before enrollment.");
    }catch(error){
      button.disabled=false;button.textContent=section.entranceAssessmentId?"Replace Entrance Exam":"Configure Entrance Exam";
      toast(error.message||"Unable to configure the entrance examination.");
    }
  };
}


async function assignAssessmentModal(assessmentId,preferredSectionId=""){
  if(!P3.current || P3.current.id!==assessmentId) await openAssessment(assessmentId);
  const a=P3.current,d=P3.detail,s=state();
  if(a.sectionId)return toast("This assessment is already assigned to a section.");
  if(!d.questions.length)return toast("Add questions from the Question Bank before assigning this assessment.");
  const sections=s.sections.filter(sec=>sec.courseId===a.courseId);
  if(!sections.length)return toast("Create a teaching section for "+(a.courseCode||"this course")+" before assigning the assessment.");

  const modal=core().openModal({
    eyebrow:"Assign Assessment",
    title:a.title,
    wide:true,
    body:'<form id="assignAssessmentForm" class="academic-form">'+
      '<div class="assignment-preview-card"><div><span>'+esc(a.type)+'</span><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"Course")+' • '+(a.randomDrawEnabled?'Randomized question pool':'Reusable template')+'</p></div><div class="assignment-preview-stats"><div><strong>'+esc(a.randomDrawEnabled?(a.questionCount||0):d.questions.length)+'</strong><span>'+(a.randomDrawEnabled?'Per Student':'Questions')+'</span></div><div><strong>'+esc(a.totalPoints||d.questions.reduce((n,q)=>n+Number(q.points||0),0))+'</strong><span>Points</span></div><div><strong>'+esc(a.randomDrawEnabled?d.questions.length:(a.durationMinutes||0))+'</strong><span>'+(a.randomDrawEnabled?'Pool Size':'Minutes')+'</span></div></div></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Destination</h3><p>Select the class receiving its own copy of this assessment.</p></div></div>'+
        '<div class="section-choice-grid" id="assignSectionChoices">'+sections.map(sec=>'<label class="section-choice"><input type="radio" name="sectionId" value="'+sec.id+'" '+((preferredSectionId?sec.id===preferredSectionId:sec.id===sections[0].id)?'checked':'')+'><div><span>'+esc(sec.courseCode||a.courseCode)+'</span><strong>'+esc(sec.sectionName)+'</strong><small>'+esc(sec.term||"")+' • '+esc(sec.studentCount||"")+(sec.studentCount?" students":"")+'</small></div><div class="section-choice-check">✓</div></label>').join("")+'</div>'+
        '<div class="field" style="margin-top:14px"><label>Assigned Title</label><input class="title-input" name="title" value="'+esc(a.title)+'" required></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Schedule</h3><p>Set when this section will take the assessment.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Duration</label><div class="input-with-suffix"><input name="durationMinutes" type="number" min="0" value="'+esc(a.durationMinutes||60)+'"><span>min</span></div></div><div class="field"><label>Opens</label><input name="opensAt" type="datetime-local" value="'+esc(localDateTime(a.opensAt))+'"></div><div class="field"><label>Closes</label><input name="closesAt" type="datetime-local" value="'+esc(localDateTime(a.closesAt))+'"></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Release</h3><p>Keep it private while reviewing, or publish it to students immediately.</p></div></div>'+
        '<div class="release-choice-grid"><label class="release-choice"><input type="radio" name="initialStatus" value="Draft" checked><div><strong>Save as Draft</strong><span>Students cannot see or start it yet.</span></div></label><label class="release-choice"><input type="radio" name="initialStatus" value="Published"><div><strong>Assign & Publish</strong><span>Create the section copy and make it available according to the schedule.</span></div></label></div>'+
      '</section>'+
      '<div class="assignment-copy-note"><strong>The reusable template stays unchanged.</strong><span>This creates an independent section copy with its own submissions, grading, schedule, and results.</span></div>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Assign Assessment</button></div></form>'
  });

  const form=modal.querySelector("#assignAssessmentForm");
  modal.querySelectorAll('.section-choice input').forEach(x=>x.addEventListener("change",()=>modal.querySelectorAll(".section-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked))));
  modal.querySelectorAll(".section-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked));
  modal.querySelectorAll('.release-choice input').forEach(x=>x.addEventListener("change",()=>modal.querySelectorAll(".release-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked))));
  modal.querySelectorAll(".release-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked));

  form.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(form),section=sections.find(sec=>sec.id===String(fd.get("sectionId"))),initialStatus=String(fd.get("initialStatus")||"Draft");
    if(!section)return toast("Choose a section.");
    const opensAt=timestampFrom(fd.get("opensAt")),closesAt=timestampFrom(fd.get("closesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The close time must be after the open time.");

    const duplicate=P3.assessments.find(x=>x.sectionId===section.id&&x.templateSourceId===a.id);
    if(duplicate&&!confirm("This template is already assigned to "+section.sectionName+". Assign another copy anyway?"))return;

    const ref=doc(collection(db,"assessments"));
    const clone={
      ...Object.fromEntries(Object.entries(a).filter(([k])=>!["id","createdAt","updatedAt"].includes(k))),
      ownerId:s.user.uid,sectionId:section.id,sectionName:section.sectionName,templateSourceId:a.id,
      title:String(fd.get("title")).trim(),status:initialStatus,durationMinutes:Number(fd.get("durationMinutes")||0),
      opensAt,closesAt,questionIds:d.questions.map(q=>q.id),
      questionPool:(a.questionPool?.length?a.questionPool:d.questions.map(q=>({id:q.id,itemId:q.itemId||"",type:q.type,points:Number(q.points||0)}))),
      poolQuestionCount:d.questions.length,
      questionCount:Number(a.questionCount||d.questions.length),
      totalPoints:Number(a.totalPoints||d.questions.reduce((n,q)=>n+Number(q.points||0),0)),createdAt:serverTimestamp(),updatedAt:serverTimestamp()
    };
    try{
      await setDoc(ref,clone);
      for(let i=0;i<d.questions.length;i+=180){
        const batch=writeBatch(db),chunk=d.questions.slice(i,i+180);
        for(const q of chunk){
          const cleanQ=Object.fromEntries(Object.entries(q).filter(([k])=>k!=="id"));
          batch.set(doc(db,"assessments",ref.id,"questions",q.id),{...cleanQ,clonedAt:serverTimestamp()});
          const key=d.keys.find(k=>k.id===q.id);
          if(key){
            const cleanK=Object.fromEntries(Object.entries(key).filter(([k])=>k!=="id"));
            batch.set(doc(db,"assessments",ref.id,"keys",q.id),{...cleanK,clonedAt:serverTimestamp()});
          }
        }
        await batch.commit();
      }
      if(initialStatus==="Published"){
        await setDoc(doc(db,"sections",section.id,"assessmentRefs",ref.id),{
          assessmentId:ref.id,title:clone.title,type:clone.type,assessmentType:clone.type,totalPoints:Number(clone.totalPoints||0),status:"Published",
          opensAt:clone.opensAt||null,closesAt:clone.closesAt||null,durationMinutes:clone.durationMinutes||0,updatedAt:serverTimestamp()
        });
      }
      core().closeModal();await loadAssessments();await openAssessment(ref.id);
      toast(initialStatus==="Published"?"Assessment assigned and published.":"Assessment assigned as a draft.");
    }catch(err){toast(err.message||"Unable to assign assessment.");}
  };
}

async function editAssignedAssessmentModal(assessmentId){
  const s=state();
  if(!P3.current || P3.current.id!==assessmentId) await openAssessment(assessmentId);
  const a=P3.current,d=P3.detail;
  if(!a.sectionId)return toast("This is a reusable template, not an assigned assessment.");
  const sections=s.sections.filter(sec=>sec.courseId===a.courseId);
  const hasAttempts=d.submissions.length>0||d.results.length>0;
  const modal=core().openModal({
    eyebrow:"Edit Assignment",
    title:a.title,
    wide:true,
    body:'<form id="editAssignedAssessmentForm" class="academic-form">'+
      '<div class="assignment-preview-card"><div><span>'+esc(a.type)+'</span><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"Course")+' • '+esc(a.sectionName||"Assigned Section")+'</p></div><div class="assignment-preview-stats"><div><strong>'+esc(a.questionCount||d.questions.length)+'</strong><span>Questions</span></div><div><strong>'+esc(a.totalPoints||0)+'</strong><span>Points</span></div><div><strong>'+esc(d.submissions.length)+'</strong><span>Attempts</span></div></div></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Assignment Details</h3><p>Edit the section-facing copy without changing the reusable template.</p></div></div>'+
        '<div class="field"><label>Assigned Title</label><input class="title-input" name="title" value="'+esc(a.title)+'" required></div>'+
        '<div class="field"><label>Assigned Section</label><select name="sectionId" '+(hasAttempts?'disabled':'')+'>'+sections.map(sec=>'<option value="'+sec.id+'">'+esc(sec.courseCode+" — "+sec.sectionName+" • "+sec.term)+'</option>').join("")+'</select>'+(hasAttempts?'<div class="field-help warning-text">This assessment has student activity, so its section can no longer be moved. Title and schedule can still be edited.</div>':'<div class="field-help">You may move this assigned copy to another section of the same course until a student starts it.</div>')+'</div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Schedule</h3><p>Adjust the live section administration settings.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Duration</label><div class="input-with-suffix"><input name="durationMinutes" type="number" min="0" value="'+esc(a.durationMinutes||0)+'"><span>min</span></div></div><div class="field"><label>Opens</label><input name="opensAt" type="datetime-local" value="'+esc(localDateTime(a.opensAt))+'"></div><div class="field"><label>Closes</label><input name="closesAt" type="datetime-local" value="'+esc(localDateTime(a.closesAt))+'"></div></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Assignment Changes</button></div></form>'
  });
  const form=modal.querySelector("#editAssignedAssessmentForm");
  form.sectionId.value=a.sectionId;
  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(form);
    const newSectionId=hasAttempts?a.sectionId:String(fd.get("sectionId")),newSection=sections.find(sec=>sec.id===newSectionId);
    const opensAt=timestampFrom(fd.get("opensAt")),closesAt=timestampFrom(fd.get("closesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The close time must be after the open time.");
    const moved=newSectionId!==a.sectionId;
    const title=String(fd.get("title")).trim(),durationMinutes=Number(fd.get("durationMinutes")||0);
    try{
      const batch=writeBatch(db);
      batch.update(doc(db,"assessments",a.id),{
        title,durationMinutes,opensAt,closesAt,sectionId:newSectionId,sectionName:newSection.sectionName,updatedAt:serverTimestamp()
      });
      if(a.status==="Published"){
        if(moved)batch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
        batch.set(doc(db,"sections",newSectionId,"assessmentRefs",a.id),{
          assessmentId:a.id,title,type:a.type,assessmentType:a.type,totalPoints:Number(a.totalPoints||0),status:a.status,opensAt:opensAt||null,closesAt:closesAt||null,durationMinutes,updatedAt:serverTimestamp()
        },{merge:true});
      }
      await batch.commit();
      core().closeModal();await loadAssessments();await openAssessment(a.id);toast(moved?"Assessment assignment moved and updated.":"Assessment assignment updated.");
    }catch(err){toast(err.message||"Unable to update the assigned assessment.");}
  };
}

async function deleteRefsInBatches(refs){
  for(let i=0;i<refs.length;i+=400){
    const batch=writeBatch(db);
    refs.slice(i,i+400).forEach(ref=>batch.delete(ref));
    await batch.commit();
  }
}

async function deleteAssessment(assessmentId){
  if(!P3.current || P3.current.id!==assessmentId) await openAssessment(assessmentId);
  const a=P3.current,d=P3.detail;
  if(!a)return toast("Assessment not found.");
  if(a.entranceExam===true)return toast("Entrance examinations are managed from the section. Replace the entrance exam or delete the section instead.");

  const assigned=!!a.sectionId;
  let unresolvedAppeals=[],portfolioDocs=[],sectionGradeDocs=[];
  if(assigned){
    const [appealSnap,portfolioSnap,gradeSnap]=await Promise.all([
      getDocs(collection(db,"sections",a.sectionId,"appeals")),
      getDocs(collection(db,"sections",a.sectionId,"portfolios")),
      getDocs(collection(db,"sections",a.sectionId,"assessmentGrades"))
    ]);
    unresolvedAppeals=appealSnap.docs.filter(x=>{
      const row=x.data();
      return row.targetType==="Assessment"&&row.targetId===a.id&&![ "Resolved","Denied","Withdrawn" ].includes(row.status);
    });
    portfolioDocs=portfolioSnap.docs;
    sectionGradeDocs=gradeSnap.docs.filter(x=>x.data().assessmentId===a.id);
    if(unresolvedAppeals.length){
      return toast("Resolve the open grade appeal"+(unresolvedAppeals.length===1?"":"s")+" for this assessment before deleting it.");
    }
  }

  const assignedCopies=!assigned?P3.assessments.filter(x=>x.templateSourceId===a.id):[];
  const hasStudentData=assigned&&(d.submissions.length>0||d.results.length>0||sectionGradeDocs.length>0);
  const needsTypedConfirmation=hasStudentData||assignedCopies.length>0;

  const modal=core().openModal({
    eyebrow:assigned?"Delete Assigned Assessment":"Delete Assessment Template",
    title:a.title,
    body:
      '<div class="delete-assessment-warning"><div class="delete-warning-icon">!</div><div><strong>'+
      (assigned?"This permanently removes this section assessment.":"This permanently removes this reusable assessment template.")+
      '</strong><p>'+
      (assigned
        ?"Student attempts, event logs, results, gradebook rows, and section publication references tied to this assessment will be deleted. The original reusable template is not affected."
        :(assignedCopies.length
          ?"Existing assigned copies are independent and will remain available to their sections. Their link back to this template will be cleared."
          :"Question Bank questions are not deleted; only this assessment template and its copied assessment questions/keys are removed."))+
      '</p></div></div>'+
      '<div class="detail-list" style="margin-top:16px">'+
        '<div><span>Type</span><strong>'+esc(a.type||"Assessment")+'</strong></div>'+
        '<div><span>Question Pool</span><strong>'+esc(d.questions.length)+'</strong></div>'+
        (assigned?'<div><span>Student Attempts</span><strong>'+esc(d.submissions.length)+'</strong></div><div><span>Results</span><strong>'+esc(d.results.length)+'</strong></div><div><span>Gradebook Rows</span><strong>'+esc(sectionGradeDocs.length)+'</strong></div>':'<div><span>Existing Assigned Copies</span><strong>'+esc(assignedCopies.length)+'</strong></div>')+
      '</div>'+
      (needsTypedConfirmation
        ?'<div class="notice danger-notice" style="margin-top:16px">This deletion affects existing academic records or assigned copies. Type <strong>DELETE</strong> to confirm.</div><div class="field" style="margin-top:14px"><label>Confirmation</label><input id="deleteAssessmentConfirm" autocomplete="off" placeholder="Type DELETE"></div>'
        :'<div class="notice" style="margin-top:16px">No student attempt data or assigned copies are attached to this assessment.</div>'),
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" id="confirmDeleteAssessment" '+(needsTypedConfirmation?'disabled':'')+'>'+esc(assigned?"Delete Assessment":"Delete Template")+'</button>'
  });

  const button=modal.querySelector("#confirmDeleteAssessment"),input=modal.querySelector("#deleteAssessmentConfirm");
  if(input)input.addEventListener("input",()=>button.disabled=input.value.trim()!=="DELETE");

  button.onclick=async()=>{
    button.disabled=true;button.textContent="Deleting…";
    try{
      const refs=[];
      const questions=await getDocs(collection(db,"assessments",a.id,"questions"));
      const keys=await getDocs(collection(db,"assessments",a.id,"keys"));
      questions.docs.forEach(x=>refs.push(x.ref));keys.docs.forEach(x=>refs.push(x.ref));

      const submissions=await getDocs(collection(db,"assessments",a.id,"submissions"));
      for(const sub of submissions.docs){
        const events=await getDocs(collection(db,"assessments",a.id,"submissions",sub.id,"events"));
        events.docs.forEach(x=>refs.push(x.ref));
        refs.push(sub.ref);
      }
      const results=await getDocs(collection(db,"assessments",a.id,"results"));
      results.docs.forEach(x=>refs.push(x.ref));
      await deleteRefsInBatches(refs);

      if(assigned){
        await deleteRefsInBatches(sectionGradeDocs.map(x=>x.ref));

        // Remove stale portfolio references but keep every other curated work item.
        for(const p of portfolioDocs){
          const row=p.data(),works=Array.isArray(row.featuredWorks)?row.featuredWorks:[];
          if(works.some(w=>w.type==="Assessment"&&w.id===a.id)){
            await updateDoc(p.ref,{
              featuredWorks:works.filter(w=>!(w.type==="Assessment"&&w.id===a.id)),
              updatedAt:serverTimestamp()
            });
          }
        }

        const finalBatch=writeBatch(db);
        finalBatch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
        finalBatch.delete(doc(db,"assessments",a.id));
        await finalBatch.commit();
      }else{
        // Assigned copies remain valid but no longer point at a deleted template.
        for(let i=0;i<assignedCopies.length;i+=400){
          const batch=writeBatch(db);
          assignedCopies.slice(i,i+400).forEach(copy=>{
            batch.update(doc(db,"assessments",copy.id),{templateSourceId:"",updatedAt:serverTimestamp()});
          });
          await batch.commit();
        }
        await deleteDoc(doc(db,"assessments",a.id));
      }

      const deletedSectionId=a.sectionId||"";
      core().closeModal();P3.current=null;P3.detail=null;await loadAssessments();
      if(deletedSectionId){
        window.TheoriaPhase4?.invalidate?.(deletedSectionId);
        try{await window.TheoriaPhase4?.recomputeMastery?.(deletedSectionId);}catch(_){}
      }

      if(deletedSectionId&&state().currentSection?.id===deletedSectionId&&$("#page-section-detail")?.classList.contains("active")){
        await renderSectionAssessments();
      }else{
        core().setPage("assessments");await renderAssessments();
      }
      toast(assigned?"Assessment deleted.":"Assessment template deleted.");
    }catch(err){
      button.disabled=false;button.textContent=assigned?"Delete Assessment":"Delete Template";
      toast(err.message||"Unable to delete the assessment.");
    }
  };
}

async function chooseAssessmentForSection(sectionId){
  await loadAssessments();
  const section=state().sections.find(x=>x.id===sectionId)||state().currentSection;
  const templates=P3.assessments.filter(a=>!a.sectionId&&a.courseId===section.courseId);
  if(!templates.length)return toast("No reusable assessment templates exist for this course yet. Create one in Assessments and add Question Bank questions first.");

  const assignedForSection=P3.assessments.filter(a=>a.sectionId===section.id);
  const modal=core().openModal({
    eyebrow:"Assign Assessment",
    title:"Choose Assessment for "+section.sectionName,
    wide:true,
    body:'<form id="chooseAssessmentForm" class="academic-form">'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Reusable Assessments</h3><p>Select a course template to create an independent copy for this section.</p></div><div class="assignment-preview-stats compact"><div><strong>'+templates.length+'</strong><span>Templates</span></div><div><strong>'+assignedForSection.length+'</strong><span>Already Assigned</span></div></div></div>'+
      '<div class="question-bank-toolbar"><div class="field"><label>Search Assessments</label><input id="templateSearch" placeholder="Search title or assessment type"></div><div class="field"><label>Type</label><select id="templateType"><option value="">All types</option>'+[...new Set(templates.map(x=>x.type).filter(Boolean))].sort().map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("")+'</select></div></div>'+
      '<div id="templateChoiceList" class="template-choice-list"></div></section>'+
      '<div class="assignment-copy-note"><strong>Nothing is published yet.</strong><span>After choosing a template, you will set the destination schedule and decide whether to save it as Draft or publish immediately.</span></div>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Continue to Assignment</button></div></form>'
  });
  const form=modal.querySelector("#chooseAssessmentForm"),list=modal.querySelector("#templateChoiceList"),search=modal.querySelector("#templateSearch"),type=modal.querySelector("#templateType");
  let selectedId=templates[0]?.id||"";
  const render=()=>{
    const q=search.value.trim().toLowerCase(),t=type.value;
    const rows=templates.filter(a=>(!t||a.type===t)&&(!q||[a.title,a.type,a.courseCode].join(" ").toLowerCase().includes(q)));
    if(rows.length&&!rows.some(x=>x.id===selectedId))selectedId=rows[0].id;
    list.innerHTML=rows.length?rows.map(a=>{
      const assignedCount=P3.assessments.filter(x=>x.templateSourceId===a.id).length;
      return '<label class="template-choice rich '+(selectedId===a.id?'selected':'')+'"><input type="radio" name="assessmentId" value="'+a.id+'" '+(selectedId===a.id?'checked':'')+'><div><span>'+esc(a.type)+'</span><strong>'+esc(a.title)+'</strong><small>'+esc(a.questionCount||0)+' questions • '+esc(a.totalPoints||0)+' points • '+esc(a.durationMinutes||0)+' min'+(assignedCount?' • assigned '+assignedCount+' time'+(assignedCount===1?"":"s"):'')+'</small></div><div class="template-choice-arrow">→</div></label>';
    }).join(""):'<div class="empty-state compact-empty"><div class="empty-symbol">A</div><h3>No matching assessment templates.</h3><p>Adjust the search or filter.</p></div>';
    list.querySelectorAll('input[name="assessmentId"]').forEach(input=>input.onchange=()=>{selectedId=input.value;render();});
  };
  search.oninput=render;type.onchange=render;render();
  form.onsubmit=e=>{
    e.preventDefault();
    const id=form.querySelector('input[name="assessmentId"]:checked')?.value;
    if(!id)return toast("Choose an assessment template.");
    core().closeModal();assignAssessmentModal(String(id),sectionId);
  };
}

async function setStatus(status){
  const a=P3.current;
  if(status==="Published"&&!a.sectionId)return toast("Assign this assessment template to a section before publishing.");
  if(status==="Published"&&!P3.detail.questions.length)return toast("Add at least one Question Bank question or evaluation prompt before publishing.");
  if(status==="Published"&&totalWeight(a.parts)!==100)return toast("Examination parts must total 100%.");
  const batch=writeBatch(db);
  batch.update(doc(db,"assessments",a.id),{status,questionIds:P3.detail.questions.map(q=>q.id),updatedAt:serverTimestamp()});
  if(status==="Draft")batch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
  else batch.set(doc(db,"sections",a.sectionId,"assessmentRefs",a.id),{assessmentId:a.id,title:a.title,type:a.type,assessmentType:a.type,totalPoints:Number(a.totalPoints||0),status,opensAt:a.opensAt||null,closesAt:a.closesAt||null,durationMinutes:a.durationMinutes||0,updatedAt:serverTimestamp()},{merge:true});
  try{await batch.commit();await openAssessment(a.id);await renderAssessments();toast("Assessment "+status.toLowerCase()+".");}catch(err){toast(err.message||"Unable to update assessment.");}
}

/* -------------------- SECTION ASSESSMENTS / PATHWAYS -------------------- */

async function renderSectionAssessments(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!s||!section||!el)return;
  el.innerHTML='<div class="empty-mini">Loading section assessments…</div>';
  try{
    let list=[];
    if(s.role==="instructor"){
      const snap=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
      list=snap.docs.map(d=>({id:d.id,...d.data()})).filter(a=>a.sectionId===section.id);
    }else{
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
      for(const r of refs.docs){
        try{
          const a=await getDoc(doc(db,"assessments",r.id));
          if(a.exists())list.push({id:a.id,...a.data()});
        }catch(_){}
      }
    }
    list.sort((a,b)=>(b.opensAt?.toMillis?.()||0)-(a.opensAt?.toMillis?.()||0));

    const header=s.role==="instructor"
      ? '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Assigned Assessments</div><p class="page-subtitle">Assign reusable course assessments to this section, then publish when ready.</p></div><button class="primary-btn small-btn" data-phase3-action="assign-current-section" data-section="'+section.id+'">Assign Assessment</button></div>'
      : '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Assessments</div><p class="page-subtitle">View scheduled assessment contents before opening, then review results after grading is complete.</p></div></div>';

    if(!list.length){
      el.innerHTML=header+'<div class="empty-state"><div class="empty-symbol">A</div><h3>No assessments assigned yet.</h3><p>'+(s.role==="instructor"?"Choose a reusable assessment template for this course.":"Published assessments will appear here.")+'</p></div>';
      return;
    }

    if(s.role==="instructor"){
      el.innerHTML=header+'<div class="assessment-grid">'+list.map(a=>
        '<article class="assessment-card assigned-card"><div class="assessment-card-topline"><div class="assessment-type">'+esc(a.type)+'</div><span class="badge '+(a.status==="Published"?"live":a.status==="Draft"?"gold":"")+'">'+esc(a.status||"Draft")+'</span></div><h3>'+esc(a.title)+'</h3><p>'+esc(a.questionCount||0)+' questions • '+esc(a.totalPoints||0)+' points</p><div class="assigned-schedule"><div><span>Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Duration</span><strong>'+esc(a.durationMinutes||0)+' min</strong></div></div><div class="card-actions"><button class="secondary-btn small-btn" data-phase3-action="edit-assignment" data-id="'+a.id+'">Edit Assignment</button><button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open</button><button class="danger-btn small-btn" data-phase3-action="delete-assigned" data-id="'+a.id+'">Delete</button></div></article>'
      ).join("")+'</div>';
      return;
    }

    const cards=[];
    for(const a of list){
      let sub=null,result=null;
      try{const x=await getDoc(doc(db,"assessments",a.id,"submissions",s.user.uid));if(x.exists())sub=x.data();}catch(_){}
      try{const x=await getDoc(doc(db,"assessments",a.id,"results",s.user.uid));if(x.exists())result=x.data();}catch(_){}
      const status=availability(a),graded=result?.complete===true,types=assessmentTypeSummary(a);
      let actions='<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">View Details</button>';
      if(graded){
        actions='<button class="primary-btn small-btn" data-phase3-action="student-assessment-results" data-id="'+a.id+'">View Results</button><button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
      }else if(a.mode==="oral"){
        actions+='<span class="badge gold">Instructor administered</span>';
      }else if(sub?.status==="submitted"||sub?.status==="graded"){
        actions='<button class="secondary-btn small-btn" data-phase3-action="receipt" data-id="'+a.id+'">Submission Receipt</button><button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
      }else if(status==="Open"){
        actions='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">'+(sub?"Resume":"Begin")+'</button><button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
      }

      cards.push('<article class="assessment-card assigned-card student-assessment-card"><div class="assessment-card-topline"><div class="assessment-type">'+esc(a.type)+'</div><span class="badge '+(status==="Open"?"live":status==="Scheduled"?"gold":"")+'">'+esc(status)+'</span></div><h3>'+esc(a.title)+'</h3><p>'+esc(a.questionCount||0)+' questions • '+esc(a.totalPoints||0)+' points</p>'+
        '<div class="assigned-schedule"><div><span>Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Duration</span><strong>'+esc(a.durationMinutes||0)+' min</strong></div></div>'+
        (types.length?'<div class="student-card-type-list">'+types.slice(0,4).map(row=>'<span>'+esc(row.count)+' '+esc(row.type)+'</span>').join("")+(types.length>4?'<span>+'+(types.length-4)+' more</span>':'')+'</div>':'')+
        (graded?'<div class="released-result"><strong>'+esc(result.percent)+'%</strong><span>Graded result available</span></div>':'')+
        '<div class="card-actions">'+actions+'</div></article>');
    }
    el.innerHTML=header+'<div class="assessment-grid">'+cards.join("")+'</div>';
  }catch(error){
    console.error("Unable to load section assessments:",error);
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">!</div><h3>Assessments could not be loaded.</h3><p>Refresh after deploying the latest Firestore rules. If the problem continues, open the main Assessments workspace.</p></div>';
  }
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
    if(a.mode==="oral")return toast("This oral examination is instructor administered.");
    if(a.status!=="Published"&&a.status!=="Closed")return toast("This assessment has not been published to students.");
    if(a.status==="Closed")return toast("This assessment has been closed by the instructor.");
    const now=Date.now(),opens=a.opensAt?.toMillis?.()||0,closes=a.closesAt?.toMillis?.()||0;
    if(opens&&now<opens)return toast("This assessment opens "+dateText(a.opensAt)+".");
    if(closes&&now>closes)return toast("The assessment window closed "+dateText(a.closesAt)+".");
    let subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid)),sub=subSnap.exists()?{id:subSnap.id,...subSnap.data()}:null;
    if(sub&&sub.status!=="in_progress")return receipt(id);

    const memberSnap=await getDoc(doc(db,"sections",a.sectionId,"members",s.user.uid));
    let participantData=memberSnap.exists()?memberSnap.data():null;
    if(!participantData&&a.entranceExam===true){
      const candidateSnap=await getDoc(doc(db,"sections",a.sectionId,"entranceCandidates",s.user.uid));
      if(candidateSnap.exists())participantData=candidateSnap.data();
    }
    if(!participantData)return toast(a.entranceExam?"Your entrance-exam access has not been initialized. Re-enter the section join code.":"You are not enrolled in the section assigned to this assessment.");
    const acc=participantData.accommodations||{};
    if(!sub&&!confirmed){
      const minutes=Math.round(Number(a.durationMinutes||0)*Number(acc.timeMultiplier||1));
      const modal=core().openModal({
        eyebrow:a.entranceExam?"Entrance Examination":"Formal Assessment",
        title:a.title,
        wide:true,
        body:'<div class="exam-preflight"><div class="preflight-warning"><strong>Before you begin</strong><p>'+(a.entranceExam?"This examination is required before enrollment. Beginning creates your entrance candidate record and starts the examination timer.":"Beginning creates your official candidate record and starts the examination timer.")+' Refreshing the browser does not create a new attempt.</p></div>'+
          '<div class="detail-list"><div><span>Assessment</span><strong>'+esc(a.type)+'</strong></div><div><span>Time Allowed</span><strong>'+(minutes?minutes+" minutes":"Untimed")+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div><div><span>Backtracking</span><strong>'+(a.backtracking!==false?"Permitted":"Restricted")+'</strong></div><div><span>Grading</span><strong>'+(a.anonymousGrading!==false?"Anonymous candidate number":"Named")+'</strong></div></div>'+
          (a.instructions?'<div class="preflight-instructions"><div class="eyebrow">Instructor Instructions</div><p>'+esc(a.instructions).replace(/\n/g,"<br>")+'</p></div>':'')+
          '<div class="accommodation-summary"><div class="eyebrow">Assessment Access</div><span>'+esc(acc.timeMultiplier||1)+'× time</span>'+(acc.breaks?'<span>Breaks permitted</span>':'')+(acc.calculator?'<span>Calculator permitted</span>':'')+(acc.largeText?'<span>Large text</span>':'')+'</div>'+
          '<label class="checkbox-line preflight-ack"><input id="examAck" type="checkbox"> I have read the instructions and understand that beginning starts my official attempt.</label></div>',
        footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="beginExamBtn" disabled>Begin Assessment</button>'
      });
      const ack=modal.querySelector("#examAck"),begin=modal.querySelector("#beginExamBtn");ack.onchange=()=>begin.disabled=!ack.checked;begin.onclick=()=>{core().closeModal();startExam(id,true);};return;
    }

    if(!sub){
      let order=[];
      try{order=buildAttemptQuestionOrder(a);}catch(error){return toast(error.message||"Unable to build your assessment version.");}
      if(!order.length)return toast("This assessment has no published questions.");
      await setDoc(doc(db,"assessments",id,"submissions",s.user.uid),{
        studentId:s.user.uid,candidateNumber:newCandidateNumber(),status:"in_progress",
        startedAt:serverTimestamp(),acknowledgedAt:serverTimestamp(),updatedAt:serverTimestamp(),
        answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:order,
        accommodationsApplied:{timeMultiplier:Number(acc.timeMultiplier||1),breaks:!!acc.breaks,calculator:!!acc.calculator,largeText:!!acc.largeText,reducedDistractions:!!acc.reducedDistractions}
      });
      subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));sub={id:subSnap.id,...subSnap.data()};
    }

    let order=(sub.questionOrder?.length?sub.questionOrder:a.questionIds)||[];
    if(!order.length){
      try{
        const legacy=await getDocs(collection(db,"assessments",id,"questions"));
        order=legacy.docs.map(d=>d.id);
        if(order.length){
          await updateDoc(doc(db,"assessments",id,"submissions",s.user.uid),{questionOrder:order,updatedAt:serverTimestamp()});
          sub.questionOrder=order;
        }
      }catch(error){
        console.error("Unable to recover legacy assessment question manifest:",error);
      }
    }
    if(!order.length)return toast("This assessment has no available questions. Ask the instructor to reopen and republish the assigned assessment.");
    const questions=[];
    for(const qid of order){
      try{
        const qDoc=await getDoc(doc(db,"assessments",id,"questions",qid));
        if(qDoc.exists())questions.push({id:qDoc.id,...qDoc.data()});
      }catch(error){
        console.error("Unable to load assessment question",qid,error);
        throw error;
      }
    }
    if(!questions.length)return toast("No examination questions are available.");
    if(questions.length!==order.length)return toast("Some assessment questions are unavailable. Ask the instructor to republish this assigned assessment.");
    launchExam(a,questions,sub);
  }catch(err){
    console.error("Unable to start assessment:",err);
    toast(err?.code==="permission-denied"?"Theoria could not authorize this assessment attempt. Confirm that the assessment is published to this exact section and that your account is enrolled, then try again.":(err.message||"This assessment is not available."));
  }
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
    '<div class="exam-controls"><button class="secondary-btn" data-phase3-action="mark-question">'+(marked?"Unmark":"Mark for Review")+'</button><div><button class="secondary-btn" data-phase3-action="exam-prev" '+(ex.index===0?'disabled':'')+'>Previous</button><button class="primary-btn" data-phase3-action="'+(ex.index===ex.questions.length-1?"review-exam":"exam-next")+'">'+(ex.index===ex.questions.length-1?"Review & Submit":"Next")+'</button></div></div></main></div></div>';
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
function reviewExam(){
  const ex=P3.exam;if(!ex)return;
  const answered=ex.questions.filter(q=>{
    const a=ex.answers[q.id];
    return Array.isArray(a)?a.length>0:String(a??"").trim().length>0;
  }).length;
  const unanswered=ex.questions.length-answered;
  const marked=ex.marked.length;
  const modal=core().openModal({
    eyebrow:"Assessment Review",
    title:"Review Before Submission",
    wide:true,
    body:'<div class="review-summary-grid"><div><strong>'+answered+'</strong><span>Answered</span></div><div><strong>'+unanswered+'</strong><span>Unanswered</span></div><div><strong>'+marked+'</strong><span>Marked</span></div></div>'+
      (unanswered?'<div class="notice danger-notice" style="margin-top:14px">You still have '+unanswered+' unanswered question'+(unanswered===1?"":"s")+'. You may return to them before submitting.</div>':'<div class="notice" style="margin-top:14px">All questions have a response recorded.</div>')+
      '<div class="review-question-grid">'+ex.questions.map((q,i)=>{const a=ex.answers[q.id],done=Array.isArray(a)?a.length>0:String(a??"").trim().length>0;return '<button type="button" class="review-question-chip '+(done?'answered':'unanswered')+' '+(ex.marked.includes(q.id)?'marked':'')+'" data-phase3-action="review-jump" data-index="'+i+'"><span>Q'+(i+1)+'</span><strong>'+(done?"Answered":"Unanswered")+'</strong>'+(ex.marked.includes(q.id)?'<small>Marked</small>':'')+'</button>';}).join("")+'</div>',
    footer:'<button class="secondary-btn" data-close-modal>Return to Assessment</button><button class="danger-btn" data-phase3-action="confirm-submit-exam">Submit Assessment</button>'
  });
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
    const entranceResult=assessment.entranceExam&&result?'<div class="notice '+(Number(result.percent||0)>=Number(assessment.entrancePassPercent||70)?'':'danger-notice')+'" style="margin-top:16px"><strong>'+(Number(result.percent||0)>=Number(assessment.entrancePassPercent||70)?'Entrance requirement passed.':'Entrance requirement not yet met.')+'</strong><p>Score: '+esc(result.percent)+'% • Required: '+esc(assessment.entrancePassPercent||70)+'%'+(Number(result.percent||0)>=Number(assessment.entrancePassPercent||70)?'. Return to enrollment and enter the section join code to finish enrolling.':'. Contact the instructor if a retake should be authorized.')+'</p></div>':'';
    $("#examRoot").innerHTML='<div class="receipt-shell"><div class="receipt-mark">Θ</div><div class="eyebrow">'+(assessment.entranceExam?'Entrance Examination':'Examination Receipt')+'</div><h1>'+esc(assessment.title||"Assessment")+'</h1><p>Your response has been recorded'+(auto?" automatically when time expired":"")+'.</p><div class="receipt-grid"><div><span>Candidate Number</span><strong>'+esc(sub.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>'+esc(sub.status||"submitted")+'</strong></div><div><span>Submitted</span><strong>'+esc(dateText(sub.submittedAt))+'</strong></div><div><span>Result</span><strong>'+(result?esc(result.percent)+"%":"Awaiting evaluation")+'</strong></div></div>'+domains+entranceResult+(result?.overallComment?'<div class="academic-banner"><div class="kicker">Instructor Comment</div><p>'+esc(result.overallComment)+'</p></div>':'')+'<button class="primary-btn" data-phase3-action="'+(assessment.entranceExam?'entrance-return':'back-assessments')+'">'+(assessment.entranceExam?'Return to Enrollment':'Return to Assessments')+'</button></div>';
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


async function resetEntranceAttempt(studentId){
  const a=P3.current;
  if(!a?.entranceExam||!a.sectionId)return;
  const candidate=P3.detail?.members?.find(x=>x.id===studentId);
  if(!confirm("Reset the entrance examination attempt for "+(candidate?.displayName||"this candidate")+"? Their submitted responses and graded result for this entrance exam will be deleted."))return;
  try{
    const events=await getDocs(collection(db,"assessments",a.id,"submissions",studentId,"events"));
    for(let offset=0;offset<events.docs.length;offset+=400){
      const batch=writeBatch(db);
      events.docs.slice(offset,offset+400).forEach(d=>batch.delete(d.ref));
      await batch.commit();
    }
    const batch=writeBatch(db);
    batch.delete(doc(db,"assessments",a.id,"submissions",studentId));
    batch.delete(doc(db,"assessments",a.id,"results",studentId));
    batch.set(doc(db,"sections",a.sectionId,"entranceCandidates",studentId),{
      status:"pending",
      assessmentId:a.id,
      percent:null,
      score:null,
      maxScore:null,
      updatedAt:serverTimestamp()
    },{merge:true});
    await batch.commit();
    await openAssessment(a.id,"candidates");
    toast("Entrance attempt reset. The candidate may use the join code to try again.");
  }catch(error){toast(error.message||"Unable to reset the entrance attempt.");}
}


async function createEvaluation(studentId){
  const a=P3.current;
  try{await setDoc(doc(db,"assessments",a.id,"submissions",studentId),{studentId,candidateNumber:newCandidateNumber(),status:"submitted",startedAt:serverTimestamp(),acknowledgedAt:serverTimestamp(),submittedAt:serverTimestamp(),updatedAt:serverTimestamp(),answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:a.questionIds||[],accommodationsApplied:{}},{merge:true});await openAssessment(a.id,"candidates");toast("Evaluation record created.");}catch(err){toast(err.message||"Unable to create evaluation.");}
}

function questionsForSubmission(d,sub){
  const ids=Array.isArray(sub?.questionOrder)&&sub.questionOrder.length?new Set(sub.questionOrder):null;
  return ids?d.questions.filter(q=>ids.has(q.id)):d.questions;
}

function metrics(a,d,grading,sub){
  const questions=questionsForSubmission(d,sub);
  const total=questions.reduce((n,q)=>n+Number(grading[q.id]?.score||0),0);
  const max=questions.reduce((n,q)=>n+Number(q.points||0),0);
  const percent=max?Math.round(total/max*1000)/10:0;
  const complete=questions.length>0&&questions.every(q=>grading[q.id]?.score!==undefined&&grading[q.id]?.score!==null);
  const partScores={};
  (a.parts||[]).forEach(part=>{
    const qs=questions.filter(q=>q.partId===part.id),pm=qs.reduce((n,q)=>n+Number(q.points||0),0),ps=qs.reduce((n,q)=>n+Number(grading[q.id]?.score||0),0);
    partScores[part.id]={title:part.title,score:ps,max:pm,percent:pm?Math.round(ps/pm*1000)/10:0};
  });
  return {total,max,percent,complete,partScores};
}

async function persistResult(sub,grading,existing,overallComment=existing?.overallComment||""){
  const d=P3.detail,a=d.assessment,m=metrics(a,d,grading,sub),released=m.complete?true:(existing?.released||false),batch=writeBatch(db);
  batch.set(doc(db,"assessments",a.id,"results",sub.studentId),{studentId:sub.studentId,candidateNumber:sub.candidateNumber,totalScore:m.total,maxScore:m.max,percent:m.percent,grading,partScores:m.partScores,released,complete:m.complete,overallComment,gradedAt:serverTimestamp(),gradedBy:state().user.uid},{merge:true});
  if(m.complete){
    batch.update(doc(db,"assessments",a.id,"submissions",sub.studentId),{status:"graded",updatedAt:serverTimestamp()});
    if(a.entranceExam===true){
      const passPercent=Number(a.entrancePassPercent||70);
      batch.set(doc(db,"sections",a.sectionId,"entranceCandidates",sub.studentId),{
        status:m.percent>=passPercent?"passed":"failed",
        score:m.total,
        maxScore:m.max,
        percent:m.percent,
        passPercent,
        assessmentId:a.id,
        gradedAt:serverTimestamp(),
        updatedAt:serverTimestamp()
      },{merge:true});
    }else{
      batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+sub.studentId),{assessmentId:a.id,assessmentTitle:a.title,assessmentType:a.type,studentId:sub.studentId,score:m.total,maxScore:m.max,percent:m.percent,partScores:m.partScores,released,updatedAt:serverTimestamp()},{merge:true});
    }
  }
  await batch.commit();
}

function gradeCandidate(studentId){
  const d=P3.detail,a=d.assessment,sub=d.submissions.find(x=>x.studentId===studentId);if(!sub)return;
  const existing=d.results.find(x=>x.studentId===studentId),grading=existing?.grading||{},keyMap=new Map(d.keys.map(x=>[x.id,x]));
  const candidateQuestions=questionsForSubmission(d,sub);
  const modal=core().openModal({
    eyebrow:"Candidate Evaluation",
    title:a.anonymousGrading!==false?sub.candidateNumber:(d.members.find(x=>x.id===studentId)?.displayName||"Candidate"),
    wide:true,
    body:'<form id="candidateGradeForm"><div class="grading-stack">'+candidateQuestions.map((q,i)=>{
      const key=keyMap.get(q.id),suggested=objective(q.type)?(answerMatches(sub.answers?.[q.id],key?.correctAnswer,q.type)?Number(q.points||0):0):(grading[q.id]?.score??"");
      return '<section class="grading-question"><div class="grading-question-head"><span>Question '+(i+1)+' • '+esc(q.type)+'</span><strong>'+esc(q.points)+' pts</strong></div><h4>'+esc(q.prompt)+'</h4>'+(q.stimulus?'<div class="grading-source">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<div class="candidate-response"><span>Candidate response</span><p>'+esc(Array.isArray(sub.answers?.[q.id])?sub.answers[q.id].join(", "):(sub.answers?.[q.id]||"(No response recorded)"))+'</p></div>'+(objective(q.type)?'<div class="answer-key"><span>Answer key</span><strong>'+esc(Array.isArray(key?.correctAnswer)?key.correctAnswer.join(", "):(key?.correctAnswer||"—"))+'</strong></div>':'')+((key?.rubric||[]).length?'<div class="rubric-display">'+key.rubric.map(r=>'<div><span>'+esc(r.criterion)+'</span><strong>'+esc(r.points)+' pts</strong></div>').join("")+'</div>':'')+'<div class="form-grid"><div class="field"><label>Score</label><input name="score_'+q.id+'" type="number" min="0" max="'+esc(q.points)+'" step="0.5" value="'+esc(suggested)+'" required></div><div class="field"><label>Feedback</label><input name="comment_'+q.id+'" value="'+esc(grading[q.id]?.comment||"")+'"></div></div></section>';
    }).join("")+'</div><div class="field"><label>Overall Instructor Comment</label><textarea name="overallComment">'+esc(existing?.overallComment||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Evaluation</button></div></form>'
  });
  modal.querySelector("#candidateGradeForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),next={};
    candidateQuestions.forEach(q=>next[q.id]={score:Number(fd.get("score_"+q.id)||0),comment:String(fd.get("comment_"+q.id)||"").trim()});
    try{await persistResult(sub,next,existing,String(fd.get("overallComment")||"").trim());core().closeModal();await openAssessment(a.id,"candidates");toast("Evaluation saved.");}catch(err){toast(err.message||"Unable to save evaluation.");}
  });
}

async function autoScore(){
  const d=P3.detail,a=d.assessment,keys=new Map(d.keys.map(x=>[x.id,x])),results=new Map(d.results.map(x=>[x.studentId,x])),subs=d.submissions.filter(x=>x.status==="submitted"||x.status==="graded");
  if(!subs.length)return toast("No submitted candidates.");
  let scored=0;
  for(const sub of subs){
    const existing=results.get(sub.studentId),grading={...(existing?.grading||{})};
    const objectiveItems=questionsForSubmission(d,sub).filter(q=>objective(q.type));
    objectiveItems.forEach(q=>{grading[q.id]={score:answerMatches(sub.answers?.[q.id],keys.get(q.id)?.correctAnswer,q.type)?Number(q.points||0):0,comment:grading[q.id]?.comment||""};scored++;});
    await persistResult(sub,grading,existing);
  }
  if(!scored)return toast("No objective questions were assigned to submitted candidates.");
  await openAssessment(a.id,"grading");toast("Objective questions scored.");
}

function horizontalGrade(questionId){
  const d=P3.detail,a=d.assessment,q=d.questions.find(x=>x.id===questionId),key=d.keys.find(x=>x.id===questionId),subs=d.submissions.filter(x=>(x.status==="submitted"||x.status==="graded")&&questionsForSubmission(d,x).some(item=>item.id===questionId)),results=new Map(d.results.map(x=>[x.studentId,x]));
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
  if(a==="assign-assessment")return assignAssessmentModal(b.dataset.id);
  if(a==="assign-current-section")return chooseAssessmentForSection(b.dataset.section);
  if(a==="configure-entrance-exam")return configureEntranceExam(b.dataset.section);
  if(a==="open-entrance-section")return core().openSection(b.dataset.section,"overview");
  if(a==="entrance-return"){core().setPage("sections");return;}
  if(a==="edit-assignment")return editAssignedAssessmentModal(b.dataset.id);
  if(a==="delete-assigned"||a==="delete-assessment")return deleteAssessment(b.dataset.id);
  if(a==="bulk-import-questions")return bulkImportQuestionsModal();
  if(a==="auto-sort-question-bank")return autoSortQuestionBankModal(b.dataset.course);
  if(a==="delete-bank-question")return deleteBankQuestion(b.dataset.course,b.dataset.id);
  if(a==="edit-item")return itemModal(P3.items.find(x=>x.id===b.dataset.id&&x.courseId===b.dataset.course));
  if(a==="open-assessment")return openAssessment(b.dataset.id);
  if(a==="back-assessments"){clearInterval(P3.timer);P3.exam=null;core().setPage("assessments");return renderAssessments();}
  if(a==="assessment-tab")return renderAssessment(b.dataset.tab);
  if(a==="edit-assessment")return assessmentModal(P3.current);
  if(a==="add-items")return addItemsModal();
  if(a==="configure-random-draw")return configureRandomDrawModal();
  if(a==="configure-item")return configureItemModal(b.dataset.id);
  if(a==="remove-item")return removeItem(b.dataset.id);
  if(a==="publish")return setStatus("Published");
  if(a==="close")return setStatus("Closed");
  if(a==="reopen")return setStatus("Published");
  if(a==="student-assessment-details")return studentAssessmentDetails(b.dataset.id);
  if(a==="student-assessment-results")return studentAssessmentResults(b.dataset.id);
  if(a==="start-exam")return startExam(b.dataset.id);
  if(a==="receipt")return receipt(b.dataset.id);
  if(a==="save-pathway")return savePathway();
  if(a==="accommodations")return accommodationsModal(b.dataset.student);
  if(a==="create-evaluation")return createEvaluation(b.dataset.student);
  if(a==="grade-candidate")return gradeCandidate(b.dataset.student);
  if(a==="reset-entrance-attempt")return resetEntranceAttempt(b.dataset.student);
  if(a==="auto-score")return autoScore();
  if(a==="horizontal-grade")return horizontalGrade(b.dataset.question);
  if(a==="exam-jump"){if(P3.exam&&(P3.exam.assessment.backtracking!==false||Number(b.dataset.index)>P3.exam.index)){P3.exam.index=Number(b.dataset.index);scheduleSave();renderExam();}return;}
  if(a==="exam-prev"){if(P3.exam&&P3.exam.index>0&&P3.exam.assessment.backtracking!==false){P3.exam.index--;scheduleSave();renderExam();}return;}
  if(a==="review-exam"){reviewExam();return;}
  if(a==="review-jump"){if(P3.exam){P3.exam.index=Number(b.dataset.index);core().closeModal();scheduleSave();renderExam();}return;}
  if(a==="confirm-submit-exam"){core().closeModal();submitExam(false);return;}
  if(a==="exam-next"){if(!P3.exam)return;P3.exam.index=Math.min(P3.exam.index+1,P3.exam.questions.length-1);scheduleSave();renderExam();return;}
  if(a==="mark-question"){if(!P3.exam)return;const id=P3.exam.questions[P3.exam.index].id;P3.exam.marked=P3.exam.marked.includes(id)?P3.exam.marked.filter(x=>x!==id):[...P3.exam.marked,id];scheduleSave();renderExam();return;}
  if(a==="submit-exam")return reviewExam();
  if(a==="calculator")return calculator();
});

window.TheoriaPhase3={renderSectionTab,renderAssessments,renderItemBank,openAssessment,configureEntranceExam,startEntranceExam:(id)=>startExam(id)};

if(window.TheoriaCore)onReady();
