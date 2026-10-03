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
  saveTimer:null,
  itemBasket:[]
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
  if(type==="Practice Examination")return [
    {id:"selected",title:"Selected Response",weight:60},
    {id:"written",title:"Written Response",weight:40}
  ];
  if(type==="Progress Check")return [
    {id:"selected",title:"Selected Response",weight:60},
    {id:"written",title:"Written Response",weight:40}
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


function loadItemBasket(){
  try{
    const raw=JSON.parse(localStorage.getItem("theoriaQuestionBasket")||"[]");
    P3.itemBasket=Array.isArray(raw)?raw.filter(x=>x&&x.courseId&&x.itemId):[];
  }catch(_){P3.itemBasket=[];}
  return P3.itemBasket;
}
function saveItemBasket(){
  try{localStorage.setItem("theoriaQuestionBasket",JSON.stringify(P3.itemBasket||[]));}catch(_){}
}
function basketHas(courseId,itemId){
  return (P3.itemBasket||[]).some(x=>x.courseId===courseId&&x.itemId===itemId);
}
function basketCourseId(){
  return P3.itemBasket?.[0]?.courseId||"";
}
function toggleItemBasket(courseId,itemId){
  const basket=P3.itemBasket||[],index=basket.findIndex(x=>x.courseId===courseId&&x.itemId===itemId);
  if(index>=0){basket.splice(index,1);saveItemBasket();return true;}
  const currentCourse=basketCourseId();
  if(currentCourse&&currentCourse!==courseId){
    if(!confirm("The Question Basket can contain one course at a time. Clear the current basket and start a basket for this course?"))return false;
    P3.itemBasket=[];
  }
  P3.itemBasket.push({courseId,itemId});
  saveItemBasket();
  return true;
}

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
    '<div class="inline-actions"><span class="badge '+((item.qualityStatus||"Published")==="Retired"?"closed":(item.qualityStatus||"Published")==="Draft"?"gold":"")+'">'+esc(item.qualityStatus||"Published")+'</span><span class="badge">'+esc(item.difficulty||"Moderate")+'</span></div></div>'+
    '<div class="item-tags"><span>v'+esc(item.version||1)+'</span><span>'+esc(item.topicNumber||"No topic")+'</span><span>'+esc(item.cognitiveLevel||"Application")+'</span><span>'+esc(item.pointsDefault||1)+' pts</span>'+
    (item.competencyCodes||[]).map(x=>'<span>'+esc(x)+'</span>').join("")+'</div>'+
    '<div class="card-actions"><button class="'+(basketHas(item.courseId,item.id)?'primary-btn':'secondary-btn')+' small-btn" data-phase3-action="basket-toggle" data-course="'+item.courseId+'" data-id="'+item.id+'">'+(basketHas(item.courseId,item.id)?'In Basket ✓':'Add to Basket')+'</button>'+(manager?(window.TheoriaFeatureFlags?.questionQuality!==false?'<button class="secondary-btn small-btn" data-teaching-action="question-quality" data-course="'+item.courseId+'" data-id="'+item.id+'">Quality Review</button>':'')+'<button class="secondary-btn small-btn" data-phase3-action="item-history" data-course="'+item.courseId+'" data-id="'+item.id+'">History & Analytics</button><button class="secondary-btn small-btn" data-phase3-action="edit-item" data-course="'+item.courseId+'" data-id="'+item.id+'">Edit</button>'+((item.qualityStatus||"Published")==="Retired"?'<button class="secondary-btn small-btn" data-phase3-action="restore-bank-question" data-course="'+item.courseId+'" data-id="'+item.id+'">Restore</button>':'<button class="danger-btn small-btn" data-phase3-action="retire-bank-question" data-course="'+item.courseId+'" data-id="'+item.id+'">Retire</button>'):'<span class="badge">Official Question Bank • v'+esc(item.version||1)+'</span>')+'</div></article>';
}

async function renderItemBank(){
  const el=$("#itemBankContent");
  if(!el||state()?.role!=="instructor")return;
  loadItemBasket();
  await loadItems();
  await loadAssessments();
  const s=state();
  const usedItemIds=new Set();
  for(const assessment of P3.assessments||[]){
    (assessment.questionPool||[]).forEach(row=>{if(row?.itemId)usedItemIds.add(row.itemId);});
  }
  if(!s.courses.length){
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">Q</div><h3>Create a course first.</h3><p>The Question Bank belongs to reusable course frameworks.</p></div>';
    return;
  }

  const frameworks=new Map();
  for(const course of s.courses){
    try{frameworks.set(course.id,await framework(course.id));}
    catch(_){frameworks.set(course.id,{units:[],competencies:[]});}
  }

  const allUnits=[...new Map(P3.items.filter(x=>x.unitId||x.unitNumber||x.unitTitle).map(x=>[(x.courseId||"")+"|"+(x.unitId||x.unitNumber||x.unitTitle),{id:x.unitId||"",number:Number(x.unitNumber||0),title:x.unitTitle||"Unit",courseId:x.courseId}])).values()].sort((a,b)=>a.courseId.localeCompare(b.courseId)||a.number-b.number);
  const allTopics=[...new Map(P3.items.filter(x=>x.topicId||x.topicNumber||x.topicTitle).map(x=>[(x.courseId||"")+"|"+(x.topicId||x.topicNumber||x.topicTitle),{id:x.topicId||"",number:x.topicNumber||"",title:x.topicTitle||"Topic",courseId:x.courseId}])).values()].sort((a,b)=>a.courseId.localeCompare(b.courseId)||String(a.number).localeCompare(String(b.number),undefined,{numeric:true}));
  el.innerHTML='<div class="academic-banner question-bank-catalog-banner"><div class="kicker">Theoria Master Question Bank</div><h3>Official course questions, ready for assessment design.</h3><p>'+(s.isSystemOwner?'You are viewing the system-authoring bank. Create, import, organize, edit, and maintain official questions here.':'Questions are provided by the Theoria course catalog. You can use them in your own assessment templates without changing the master bank.')+'</p></div><div class="assessment-toolbar advanced-question-bank-toolbar"><div class="filter-row">'+
    '<select id="itemCourseFilter"><option value="">All courses</option>'+s.courses.map(c=>'<option value="'+c.id+'">'+esc(c.code+" — "+c.title)+'</option>').join("")+'</select>'+
    '<select id="itemUnitFilter"><option value="">All units</option>'+allUnits.map(u=>'<option value="'+esc((u.courseId||"")+"|"+(u.id||u.number||u.title))+'">'+esc((u.number?"Unit "+u.number+" — ":"")+u.title)+'</option>').join("")+'</select>'+
    '<select id="itemTopicFilter"><option value="">All topics</option>'+allTopics.map(t=>'<option value="'+esc((t.courseId||"")+"|"+(t.id||t.number||t.title))+'">'+esc((t.number?t.number+" — ":"")+t.title)+'</option>').join("")+'</select>'+
    '<select id="itemTypeFilter"><option value="">All types</option>'+["Multiple Choice","Multiple Select","Short Response","Essay","Passage Analysis","Primary Source Analysis","Argument Analysis","Oral Prompt","Disputation Prompt"].map(x=>'<option>'+x+'</option>').join("")+'</select>'+
    '<select id="itemDifficultyFilter"><option value="">All difficulty</option>'+[...new Set(P3.items.map(x=>x.difficulty||"Moderate"))].sort().map(x=>'<option>'+esc(x)+'</option>').join("")+'</select>'+
    '<select id="itemCognitiveFilter"><option value="">All cognitive levels</option>'+[...new Set(P3.items.map(x=>x.cognitiveLevel||"Application"))].sort().map(x=>'<option>'+esc(x)+'</option>').join("")+'</select>'+
    '<select id="itemQualityFilter"><option value="">All statuses</option><option>Published</option><option>Draft</option><option>Retired</option></select>'+
    '<select id="itemUsageFilter"><option value="">All usage</option><option value="used">Used in assessments</option><option value="unused">Never used</option></select>'+
    '<input id="itemSearch" placeholder="Prompt, competency, tag, source, topic…"></div><div class="toolbar-stat"><strong id="itemFilteredCount">'+P3.items.length+'</strong><span> of '+P3.items.length+' reusable questions</span></div></div>'+
    '<div class="question-bank-workspace"><main id="itemBankList"></main><aside id="itemBasketPanel" class="question-basket-panel"></aside></div>';

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

  const renderBasket=()=>{
    const panel=$("#itemBasketPanel");if(!panel)return;
    const rows=(P3.itemBasket||[]).map(row=>P3.items.find(item=>item.id===row.itemId&&item.courseId===row.courseId)).filter(Boolean);
    const course=rows.length?s.courses.find(c=>c.id===rows[0].courseId):null;
    const points=rows.reduce((n,item)=>n+Number(item.pointsDefault||1),0);
    panel.innerHTML='<div class="question-basket-head"><div><span>Assessment Basket</span><strong>'+rows.length+' question'+(rows.length===1?"":"s")+'</strong></div><b>'+points+' pts</b></div>'+
      (rows.length?'<div class="question-basket-course">'+esc((course?.code||"Course")+" — "+(course?.title||""))+'</div><div class="question-basket-items">'+rows.map((item,i)=>'<div class="question-basket-item"><span>'+String(i+1).padStart(2,"0")+'</span><div><strong>'+esc((item.prompt||"Question").slice(0,90))+(String(item.prompt||"").length>90?"…":"")+'</strong><small>'+esc((item.topicNumber||"No topic")+" • "+(item.type||"Question"))+'</small></div><button class="row-remove" data-phase3-action="basket-toggle" data-course="'+item.courseId+'" data-id="'+item.id+'" aria-label="Remove">×</button></div>').join("")+'</div><div class="question-basket-actions"><button class="secondary-btn small-btn" data-phase3-action="basket-clear">Clear</button><button class="primary-btn small-btn" data-phase3-action="basket-create">Create Assessment</button></div>':'<div class="empty-mini">Add Question Bank items while you browse. Your basket stays on this browser until you create or clear it.</div>');
  };
  renderBasket();

  const filter=()=>{
    const cid=$("#itemCourseFilter").value,unit=$("#itemUnitFilter").value,topic=$("#itemTopicFilter").value,type=$("#itemTypeFilter").value,
      difficulty=$("#itemDifficultyFilter").value,cognitive=$("#itemCognitiveFilter").value,quality=$("#itemQualityFilter").value,usage=$("#itemUsageFilter").value,q=$("#itemSearch").value.trim().toLowerCase();
    const list=P3.items.filter(x=>{
      const unitKey=(x.courseId||"")+"|"+(x.unitId||x.unitNumber||x.unitTitle||"");
      const topicKey=(x.courseId||"")+"|"+(x.topicId||x.topicNumber||x.topicTitle||"");
      return (!cid||x.courseId===cid)
        &&(!unit||unitKey===unit)
        &&(!topic||topicKey===topic)
        &&(!type||x.type===type)
        &&(!difficulty||(x.difficulty||"Moderate")===difficulty)
        &&(!cognitive||(x.cognitiveLevel||"Application")===cognitive)
        &&(!quality||(x.qualityStatus||"Published")===quality)
        &&(!usage||(usage==="used"?usedItemIds.has(x.id):!usedItemIds.has(x.id)))
        &&(!q||[
          x.prompt,x.stimulus,x.sourceTitle,x.unitTitle,x.topicTitle,x.topicNumber,x.difficulty,x.cognitiveLevel,
          (x.competencyCodes||[]).join(" "),(x.tags||[]).join(" ")
        ].join(" ").toLowerCase().includes(q));
    });
    const count=$("#itemFilteredCount");if(count)count.textContent=String(list.length);

    if(!list.length){
      $("#itemBankList").innerHTML='<div class="empty-state"><div class="empty-symbol">Q</div><h3>No matching questions.</h3><p>Create a new question or adjust the filters.</p></div>';
      return;
    }

    const courses=s.courses.filter(course=>list.some(item=>item.courseId===course.id));
    $("#itemBankList").innerHTML=courses.map(course=>renderCourseGroup(course,list.filter(item=>item.courseId===course.id))).join("");
  };

  ["itemCourseFilter","itemUnitFilter","itemTopicFilter","itemTypeFilter","itemDifficultyFilter","itemCognitiveFilter","itemQualityFilter","itemUsageFilter"].forEach(id=>$("#"+id)?.addEventListener("change",filter));
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
      '<section class="form-section"><div class="form-section-head"><div><span>05</span><h3>Academic Mapping & Quality</h3><p>Tag the item for mastery evidence and move it through the Question Bank quality workflow.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Quality Status</label><select name="qualityStatus"><option>Draft</option><option>Reviewed</option><option>Published</option><option>Retired</option></select></div><label class="policy-card compact-policy"><input type="checkbox" name="reviewFlag" '+(existing?.reviewFlag?'checked':'')+'><div><strong>Flag for review</strong><span>Keep this item visible to authors as needing revision.</span></div></label></div>'+
        '<div class="field"><label>Revision / Review Notes</label><textarea class="editor-compact" rows="2" name="qualityNotes" placeholder="Why was this revised, flagged, or retired?">'+esc(existing?.qualityNotes||"")+'</textarea></div>'+
        '<div class="field"><label>Academic Competencies</label><div id="itemCompetencies" class="competency-picker"></div></div>'+
        '<div class="field"><label>Tags</label><input name="tags" value="'+esc((existing?.tags||[]).join(", "))+'" placeholder="christology, primary-source, final-review"></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Question</button></div></form>'
  });

  const form=modal.querySelector("#itemForm");
  form.courseId.value=courseId;
  form.difficulty.value=existing?.difficulty||"Moderate";
  form.cognitiveLevel.value=existing?.cognitiveLevel||"Application";
  form.qualityStatus.value=existing?.qualityStatus|| (existing?"Published":"Draft");

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
      qualityStatus:String(fd.get("qualityStatus")||"Draft"),reviewFlag:form.elements.reviewFlag.checked,qualityNotes:String(fd.get("qualityNotes")||"").trim(),
      sourceTitle:String(fd.get("sourceTitle")||"").trim(),sourceSet:String(fd.get("sourceSet")||"").trim(),stimulus:String(fd.get("stimulus")||"").trim(),
      prompt:String(fd.get("prompt")||"").trim(),options,
      correctAnswer:type==="Multiple Select"?checked.sort():(checked[0]||""),
      explanation:String(fd.get("explanation")||"").trim(),rubric,updatedAt:serverTimestamp()
    };
    const normalizedPrompt=String(data.prompt||"").toLowerCase().replace(/\s+/g," ").trim();
    const duplicate=P3.items.find(x=>x.courseId===cid&&x.id!==existing?.id&&String(x.prompt||"").toLowerCase().replace(/\s+/g," ").trim()===normalizedPrompt);
    if(duplicate&&!confirm("A Question Bank item with the same prompt already exists. Save this as a separate item/version anyway?"))return;
    try{
      if(existing){
        const currentVersion=Math.max(1,Number(existing.version||1));
        const batch=writeBatch(db);
        batch.set(doc(db,"courses",cid,"items",existing.id,"versions","v"+currentVersion),{
          ...Object.fromEntries(Object.entries(existing).filter(([key])=>key!=="id")),
          version:currentVersion,
          archivedAt:serverTimestamp(),
          archivedBy:s.user.uid
        });
        batch.update(doc(db,"courses",cid,"items",existing.id),{
          ...data,
          version:currentVersion+1,
          versionedAt:serverTimestamp()
        });
        await batch.commit();
        if(window.TheoriaPhase5?.logCourseEvent)await window.TheoriaPhase5.logCourseEvent(cid,"question_version_created","question",existing.id,{fromVersion:currentVersion,toVersion:currentVersion+1});
      }else{
        await addDoc(collection(db,"courses",cid,"items"),{...data,version:1,createdAt:serverTimestamp()});
      }
      core().closeModal();await renderItemBank();toast(existing?"Question updated as a new version.":"Question created.");
    }catch(err){toast(err.message||"Unable to save item.");}
  });
}

async function itemHistoryModal(courseId,itemId){
  const item=P3.items.find(x=>x.courseId===courseId&&x.id===itemId);
  if(!item)return toast("Question not found.");
  try{
    const snap=await getDocs(collection(db,"courses",courseId,"items",itemId,"versions"));
    const versions=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(b.version||0)-Number(a.version||0));

    const usage=[];
    try{
      const owned=await getDocs(query(collection(db,"assessments"),where("ownerId","==",state().user.uid)));
      for(const aDoc of owned.docs){
        const a={id:aDoc.id,...aDoc.data()};
        if(!a.sectionId)continue;
        const qSnap=await getDocs(collection(db,"assessments",a.id,"questions"));
        const matches=qSnap.docs.map(d=>({id:d.id,...d.data()})).filter(q=>q.itemId===itemId);
        if(!matches.length)continue;
        const [resultSnap,subSnap]=await Promise.all([
          getDocs(collection(db,"assessments",a.id,"results")),
          getDocs(collection(db,"assessments",a.id,"submissions"))
        ]);
        const results=resultSnap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.complete===true);
        const submissions=subSnap.docs.map(d=>({id:d.id,...d.data()}));
        for(const q of matches){
          const scores=[];
          for(const result of results){
            const score=result.grading?.[q.id]?.score;
            if(score!==undefined&&score!==null)scores.push(Number(score));
          }
          const avg=scores.length?scores.reduce((x,y)=>x+y,0)/scores.length:null;
          const difficulty=avg!==null&&Number(q.points||0)?Math.round((avg/Number(q.points))*1000)/10:null;
          const answerCounts=new Map();
          submissions.forEach(sub=>{
            const ans=sub.answers?.[q.id];
            if(ans===undefined)return;
            const key=Array.isArray(ans)?ans.join(", "):String(ans);
            answerCounts.set(key,(answerCounts.get(key)||0)+1);
          });
          usage.push({
            assessmentId:a.id,title:a.title||"Assessment",sectionName:a.sectionName||"Section",
            questionId:q.id,attempts:scores.length,difficulty,
            responses:[...answerCounts.entries()].sort((x,y)=>y[1]-x[1]).slice(0,4)
          });
        }
      }
    }catch(error){console.warn("Unable to aggregate Question Bank analytics:",error);}

    core().openModal({
      eyebrow:"Question Bank History & Analytics",
      title:"Question v"+(item.version||1),
      wide:true,
      body:'<div class="academic-banner"><div class="kicker">'+esc(item.courseCode||"Question Bank")+'</div><h3>'+esc((item.prompt||"Question").slice(0,180))+'</h3><p>Assessment copies remain immutable. Editing the master Question Bank creates a new version instead of rewriting prior assessment history.</p></div>'+
        '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Version History</h3><p>The master item evolves while prior assessment snapshots remain unchanged.</p></div></div><div class="version-history-list"><div class="version-history-row current"><div><strong>v'+esc(item.version||1)+' — Current</strong><span>'+esc(item.type||"Question")+' • '+esc(item.topicNumber||"No topic")+'</span></div><p>'+esc(item.prompt||"")+'</p></div>'+
        versions.map(v=>'<div class="version-history-row"><div><strong>v'+esc(v.version||v.id)+'</strong><span>'+esc(v.type||"Question")+' • '+esc(v.topicNumber||"No topic")+'</span></div><p>'+esc(v.prompt||"")+'</p></div>').join("")+'</div></section>'+
        '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Performance Across Your Assessments</h3><p>How this Question Bank item has performed in assigned assessments you own.</p></div></div>'+
        (usage.length?'<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Assessment</th><th>Attempts</th><th>Difficulty</th><th>Response Pattern</th></tr></thead><tbody>'+usage.map(u=>'<tr><td><strong>'+esc(u.title)+'</strong><span class="grade-sub">'+esc(u.sectionName)+'</span></td><td>'+u.attempts+'</td><td>'+(u.difficulty===null?"—":u.difficulty+"%")+'</td><td>'+(u.responses.length?u.responses.map(([k,v])=>'<span class="analytics-answer">'+esc(k||"(blank)")+': '+v+'</span>').join(" "):"—")+'</td></tr>').join("")+'</tbody></table></div>':'<div class="empty-mini">This item has not produced scored evidence in one of your assigned assessments yet.</div>')+
        '</section>',
      footer:'<button class="primary-btn" data-close-modal>Close</button>'
    });
  }catch(error){toast(error.message||"Unable to load question history.");}
}

async function setQuestionQuality(courseId,itemId,status){
  const item=P3.items.find(x=>x.courseId===courseId&&x.id===itemId);if(!item)return;
  if(status==="Retired"&&!confirm("Retire this Question Bank item? Existing assessment snapshots are preserved, but it will not be available for new assessments."))return;
  try{
    await updateDoc(doc(db,"courses",courseId,"items",itemId),{qualityStatus:status,reviewFlag:false,qualityUpdatedAt:serverTimestamp(),updatedAt:serverTimestamp()});
    if(window.TheoriaPhase5?.logCourseEvent)await window.TheoriaPhase5.logCourseEvent(courseId,"question_quality_changed","question",itemId,{status});
    await renderItemBank();toast(status==="Retired"?"Question retired.":"Question restored to Published.");
  }catch(error){toast(error.message||"Unable to update question quality status.");}
}

/* -------------------- ASSESSMENTS -------------------- */

function availability(a){
  const now=Date.now(),open=a.opensAt?.toMillis?.()||0,close=a.closesAt?.toMillis?.()||0;
  const makeupOpen=a.makeupOpensAt?.toMillis?.()||0,makeupClose=a.makeupClosesAt?.toMillis?.()||0;
  const makeupEligible=!(a.makeupStudentIds||[]).length||(a.makeupStudentIds||[]).includes(state()?.user?.uid);
  if(a.status==="Draft")return "Draft";
  if(a.status==="Closed")return "Closed";
  const primaryOpen=(!open||now>=open)&&(!close||now<=close);
  const makeupActive=makeupEligible&&!!(makeupOpen||makeupClose)&&(!makeupOpen||now>=makeupOpen)&&(!makeupClose||now<=makeupClose);
  if(primaryOpen)return "Open";
  if(makeupActive)return "Makeup Open";
  if(open&&now<open)return "Scheduled";
  if(makeupOpen&&now<makeupOpen)return "Makeup Scheduled";
  return "Window Ended";
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
    '<section class="student-preview-section"><div class="panel-title">Schedule</div><div class="detail-list"><div><span>Primary Opens</span><strong>'+esc(dateText(a.opensAt))+'</strong></div><div><span>Primary Closes</span><strong>'+esc(dateText(a.closesAt))+'</strong></div>'+(a.makeupOpensAt||a.makeupClosesAt?'<div><span>Makeup Opens</span><strong>'+esc(dateText(a.makeupOpensAt))+'</strong></div><div><span>Makeup Closes</span><strong>'+esc(dateText(a.makeupClosesAt))+'</strong></div>':'')+'</div></section>'+
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
    const policy=a.releasePolicy||{showOverallScore:true,showQuestionScores:true,showCorrectAnswers:false,showExplanations:false,showCompetencies:true,showClassAverage:false,releaseMode:"when-graded"};

    let result=null,sub={};
    const resultSnap=await getDoc(doc(db,"assessments",id,"results",s.user.uid));
    if(resultSnap.exists())result={id:resultSnap.id,...resultSnap.data()};
    if(!result||result.complete!==true)return toast("This assessment has not been fully graded yet.");
    if(policy.releaseMode==="manual"&&result.released!==true)return toast("Your result has been graded but has not been released by the instructor yet.");

    try{
      const subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid));
      if(subSnap.exists())sub={id:subSnap.id,...subSnap.data()};
    }catch(error){console.warn("Submission metadata unavailable for results view:",error);}

    const order=safeArray(sub.questionOrder);
    const pool=new Map(safeArray(a.questionPool).map(q=>[q?.id,q||{}]).filter(([id])=>id));
    const grading=(result.grading&&typeof result.grading==="object")?result.grading:{};
    const feedback=result.releasedFeedback&&typeof result.releasedFeedback==="object"?result.releasedFeedback:{};
    const questionRows=order.map((qid,index)=>{
      const meta=pool.get(qid)||{},grade=grading[qid]||{},fb=feedback[qid]||{};
      const max=Number(meta.points||0),score=grade.score!==undefined&&grade.score!==null?Number(grade.score):null;
      const scoreText=policy.showQuestionScores?(score===null?'Not scored':esc(score)+' / '+esc(max||"—")+' pts'):(score===null?'Not scored':'Scored');
      return '<div class="student-result-question"><div class="result-question-number">'+(index+1)+'</div><div><span>'+esc(meta.type||"Question")+'</span><strong>'+scoreText+'</strong>'+(grade.comment?'<p>'+esc(grade.comment)+'</p>':'')+(policy.showCorrectAnswers&&fb.correctAnswer?'<div class="released-answer"><span>Correct answer</span><strong>'+esc(Array.isArray(fb.correctAnswer)?fb.correctAnswer.join(", "):fb.correctAnswer)+'</strong></div>':'')+(policy.showExplanations&&fb.explanation?'<div class="released-explanation">'+esc(fb.explanation)+'</div>':'')+'</div></div>';
    }).join("");
    const parts=result.partScores&&typeof result.partScores==="object"?Object.values(result.partScores).filter(Boolean):[];
    const skills=result.contentSkills||{};
    const domain=(title,rows)=>safeArray(rows).length?'<div class="result-skill-domain"><h4>'+esc(title)+'</h4>'+safeArray(rows).map(row=>'<div class="blueprint-row '+(Number(row.percent)<70?'needs-practice':'')+'"><span>'+esc(row.label||row.key||"Domain")+'</span><strong>'+esc(row.percent??"—")+'%</strong></div>').join("")+'</div>':'';

    core().setPage("exam",a.title||"Assessment Results");
    const root=$("#examRoot");if(!root)throw new Error("Assessment results workspace is unavailable.");
    root.innerHTML=
      '<div class="student-results-shell"><button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
      '<div class="student-results-hero"><div><div class="eyebrow">'+esc(a.courseCode||"")+' • '+esc(a.type||"Assessment")+(Number(result.attemptNumber||1)>1?' • RETAKE '+esc(result.attemptNumber):'')+'</div><h1>'+esc(a.title||"Assessment")+'</h1><p>Your instructor controls which parts of the graded result are released below.</p></div>'+(policy.showOverallScore?'<div class="result-score-mark"><strong>'+esc(result.percent??"—")+(result.percent!==undefined&&result.percent!==null?"%":"")+'</strong><span>'+(Number(result.attemptNumber||1)>1?'Official grade':'Assessment grade')+'</span></div>':'')+'</div>'+
      (Number(result.attemptNumber||1)>1&&policy.showOverallScore?'<div class="retake-result-summary"><div><span>Retake Raw Score</span><strong>'+esc(result.attemptPercent??result.percent)+'%</strong></div><div><span>Official Grade</span><strong>'+esc(result.percent)+'%</strong></div><div><span>Policy</span><strong>'+esc(retakePolicyLabel(result.retakePolicy,result.retakeWeightPercent))+'</strong></div></div>':'')+
      '<div class="receipt-grid student-result-meta"><div><span>Candidate Number</span><strong>'+esc(result.candidateNumber||sub.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>Released</strong></div><div><span>Submitted</span><strong>'+esc(dateText(sub.submittedAt))+'</strong></div><div><span>Graded</span><strong>'+esc(dateText(result.gradedAt))+'</strong></div>'+(policy.showClassAverage&&result.classAverage!==null&&result.classAverage!==undefined?'<div><span>Class Average</span><strong>'+esc(result.classAverage)+'%</strong></div>':'')+'</div>'+
      (parts.length&&policy.showOverallScore?'<section class="student-result-section"><div class="panel-title">Assessment Part Performance</div><div class="result-domain-grid">'+parts.map(x=>'<div><span>'+esc(x?.title||"Assessment Part")+'</span><strong>'+esc(x?.percent??"—")+(x?.percent!==undefined&&x?.percent!==null?"%":"")+'</strong><small>'+esc(x?.score??"—")+' / '+esc(x?.max??"—")+' pts</small></div>').join("")+'</div></section>':'')+
      (questionRows&&policy.showQuestionScores?'<section class="student-result-section"><div class="panel-title">Question Performance</div><div class="student-result-question-list">'+questionRows+'</div></section>':'')+
      (policy.showCompetencies?'<section class="student-result-section"><div class="panel-title">Content & Skills</div><div class="student-content-skills">'+domain("Units",skills.units)+domain("Topics",skills.topics)+domain("Competencies",skills.competencies)+'</div></section>':'')+
      (result.overallComment?'<section class="student-result-section"><div class="panel-title">Instructor Comment</div><div class="academic-banner"><p>'+esc(result.overallComment)+'</p></div></section>':'')+
      (a.correctionPolicy?.enabled?'<section class="student-result-section review-correction-card"><div><div class="panel-title">Corrections & Reflection</div><p>'+esc(a.correctionPolicy.instructions||"Review your performance and record what you would change or study next.")+'</p></div><button class="secondary-btn" data-phase3-action="result-reflection" data-id="'+a.id+'">Open Reflection</button></section>':'')+
      '<div class="student-results-actions"><button class="secondary-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Assessment Details</button><button class="primary-btn" data-phase3-action="back-assessments">Return to Assessments</button></div></div>';
  }catch(err){
    console.error("Unable to load student assessment results:",err);
    toast(err?.code==="permission-denied"?"Theoria could not authorize this result yet. Deploy the latest Firestore rules, then sign out and back in.":(err?.message||"Unable to load assessment results."));
  }
}

async function resultReflectionModal(assessmentId){
  const s=state();if(!s?.user)return;
  const aSnap=await getDoc(doc(db,"assessments",assessmentId));if(!aSnap.exists())return toast("Assessment not found.");
  const a={id:aSnap.id,...aSnap.data()};if(!a.correctionPolicy?.enabled)return toast("Corrections are not enabled for this assessment.");
  let existing=null;
  try{const snap=await getDoc(doc(db,"assessments",assessmentId,"reviewReflections",s.user.uid));if(snap.exists())existing=snap.data();}catch(_){}
  const m=core().openModal({
    eyebrow:"Assessment Review",
    title:a.title||"Corrections & Reflection",
    wide:true,
    body:'<form id="resultReflectionForm"><div class="academic-banner"><div class="kicker">Post-Result Review</div><h3>This does not change your official score.</h3><p>'+esc(a.correctionPolicy.instructions||"Explain what you misunderstood, what evidence supports the correct reasoning, and what you will study next.")+'</p></div><div class="field"><label>Reflection / Corrections</label><textarea name="reflection" rows="10" required placeholder="What did you learn from reviewing this assessment?">'+esc(existing?.reflection||"")+'</textarea></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Reflection</button></div></form>'
  });
  m.querySelector("#resultReflectionForm").onsubmit=async e=>{
    e.preventDefault();const reflection=String(new FormData(e.currentTarget).get("reflection")||"").trim();if(!reflection)return;
    try{
      await setDoc(doc(db,"assessments",assessmentId,"reviewReflections",s.user.uid),{studentId:s.user.uid,assessmentId,reflection,status:"Submitted",submittedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
      core().closeModal();toast("Assessment reflection saved. Your official score is unchanged.");
    }catch(error){toast(error.message||"Unable to save the reflection.");}
  };
}

async function loadAssessments(){
  const s=state();if(!s)return [];
  const list=[];
  if(s.role==="instructor"){
    const byId=new Map();
    const owned=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
    owned.docs.forEach(d=>byId.set(d.id,{id:d.id,...d.data()}));
    for(const section of (s.sections||[]).filter(sec=>sec.staffRole&&sec.staffRole!=="owner")){
      try{
        const delegated=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
        delegated.docs.forEach(d=>byId.set(d.id,{id:d.id,...d.data(),delegatedRole:section.staffRole}));
      }catch(error){console.warn("Unable to load delegated section assessments:",section.id,error);}
    }
    list.push(...byId.values());
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
    const card=a=>'<article class="assessment-card"><div class="assessment-type">'+esc(a.type)+(a.entranceExam?' • Entrance Exam':'')+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+(a.sectionId?esc(a.sectionName||"Assigned Section"):'Reusable assessment template')+'</p><div class="assessment-card-stats"><span><strong>'+esc(a.questionCount||0)+'</strong> '+(a.randomDrawEnabled?'questions/student':'questions')+'</span><span><strong>'+esc(a.totalPoints||0)+'</strong> points</span><span>'+(a.entranceExam?'Pass '+esc(a.entrancePassPercent||70)+'%':esc(a.sectionId?availability(a):"Template"))+'</span></div><div class="card-actions">'+(!a.sectionId?'<button class="primary-btn small-btn" data-phase3-action="assign-assessment" data-id="'+a.id+'">Assign to Section</button>':a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Section</button>':'<button class="secondary-btn small-btn" data-phase3-action="edit-assignment" data-id="'+a.id+'">Edit Assignment</button>')+'<button class="secondary-btn small-btn" data-phase3-action="open-assessment" data-id="'+a.id+'">Open Builder</button>'+(a.entranceExam?'':'<button class="danger-btn small-btn" data-phase3-action="delete-assessment" data-id="'+a.id+'">Delete</button>')+'</div></article>';
    const courseGroups=new Map();
    for(const assessment of P3.assessments){
      const key=assessment.courseId||assessment.courseCode||assessment.courseTitle||"uncategorized";
      if(!courseGroups.has(key))courseGroups.set(key,{courseId:assessment.courseId||"",courseCode:assessment.courseCode||"Course",courseTitle:assessment.courseTitle||"",items:[]});
      courseGroups.get(key).items.push(assessment);
    }
    const groups=[...courseGroups.values()].sort((a,b)=>{
      const codeCompare=String(a.courseCode||"").localeCompare(String(b.courseCode||""),undefined,{numeric:true,sensitivity:"base"});
      return codeCompare||String(a.courseTitle||"").localeCompare(String(b.courseTitle||""),undefined,{sensitivity:"base"});
    });
    const subgroup=(title,subtitle,items)=>items.length?'<div class="assessment-course-subgroup"><div class="page-head compact-head"><div><div class="panel-title">'+esc(title)+'</div><p class="page-subtitle">'+esc(subtitle)+'</p></div></div><div class="assessment-grid">'+items.map(card).join("")+'</div></div>':'';
    el.innerHTML=groups.map(group=>{
      const templates=group.items.filter(a=>!a.sectionId).sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""),undefined,{numeric:true,sensitivity:"base"}));
      const entrance=group.items.filter(a=>!!a.sectionId&&a.entranceExam===true).sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""),undefined,{numeric:true,sensitivity:"base"}));
      const assigned=group.items.filter(a=>!!a.sectionId&&a.entranceExam!==true).sort((a,b)=>String(a.sectionName||"").localeCompare(String(b.sectionName||""),undefined,{numeric:true,sensitivity:"base"})||String(a.title||"").localeCompare(String(b.title||""),undefined,{numeric:true,sensitivity:"base"}));
      const sectionCount=new Set(group.items.filter(a=>a.sectionId).map(a=>a.sectionId)).size;
      return '<section class="assessment-library-group assessment-course-group"><div class="detail-hero assessment-course-hero"><div class="detail-top"><div><div class="eyebrow">Course Assessments</div><h2 class="detail-title">'+esc(group.courseCode)+(group.courseTitle?' — '+esc(group.courseTitle):'')+'</h2><p class="page-subtitle">'+templates.length+' reusable template'+(templates.length===1?"":"s")+' • '+assigned.length+' assigned assessment'+(assigned.length===1?"":"s")+' • '+sectionCount+' section'+(sectionCount===1?"":"s")+'</p></div>'+(templates.length?'<div class="inline-actions"><button class="primary-btn small-btn" data-phase3-action="batch-assign-course" data-course="'+esc(group.courseId)+'">Assign Multiple</button></div>':'')+'</div></div>'+
        subgroup("Assessment Templates","Reusable assessments for this course.",templates)+
        subgroup("Entrance Examinations","Enrollment-gating assessments for this course.",entrance)+
        subgroup("Assigned Assessments","Live section copies, sorted by section and title.",assigned)+
      '</section>';
    }).join("");
    return;
  }
  const cards=[];
  for(const a of P3.assessments){
    let sub=null,result=null,retake=null;
    try{const x=await getDoc(doc(db,"assessments",a.id,"submissions",s.user.uid));if(x.exists())sub=x.data();}catch(_){}
    try{const x=await getDoc(doc(db,"assessments",a.id,"results",s.user.uid));if(x.exists())result=x.data();}catch(_){}
    try{const x=await getDoc(doc(db,"assessments",a.id,"retakes",s.user.uid));if(x.exists()&&x.data().active===true)retake=x.data();}catch(_){}
    const normalStatus=availability(a),status=retake?"Retake Authorized":normalStatus,graded=result?.complete===true;
    let actions='<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">View Details</button>';
    if(retake&&sub?.status==="in_progress"){
      actions='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">Resume Retake</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(retake&&!sub){
      actions='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">Begin Retake</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(graded){
      const visible=a.releasePolicy?.releaseMode!=="manual"||result?.released===true;
      actions=(visible?'<button class="primary-btn small-btn" data-phase3-action="student-assessment-results" data-id="'+a.id+'">View Results</button>':'<span class="badge gold">Graded • awaiting release</span>')+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(a.mode==="oral"){
      actions+='<span class="badge gold">Instructor administered</span>';
    }else if(sub?.status==="submitted"||sub?.status==="graded"){
      actions='<button class="secondary-btn small-btn" data-phase3-action="receipt" data-id="'+a.id+'">Submission Receipt</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }else if(normalStatus==="Open"){
      actions='<button class="primary-btn small-btn" data-phase3-action="start-exam" data-id="'+a.id+'">'+(sub?"Resume":"Begin")+'</button>'+
        '<button class="secondary-btn small-btn" data-phase3-action="student-assessment-details" data-id="'+a.id+'">Details</button>';
    }
    const types=assessmentTypeSummary(a);
    cards.push('<article class="assessment-card student-assessment-card"><div class="assessment-card-topline"><div class="assessment-type">'+esc(a.type)+'</div><span class="badge '+(status==="Open"?"live":status==="Scheduled"?"gold":"")+'">'+esc(status)+'</span></div><h3>'+esc(a.title)+'</h3><p>'+esc(a.courseCode||"")+' • '+esc(a.sectionName||"")+'</p>'+
      '<div class="assessment-card-stats"><span>'+esc(a.durationMinutes||0)+' min</span><span>'+esc(a.totalPoints||0)+' pts</span><span>'+esc(a.questionCount||0)+' questions</span></div>'+
      (types.length?'<div class="student-card-type-list">'+types.slice(0,4).map(row=>'<span>'+esc(row.count)+' '+esc(row.type)+'</span>').join("")+(types.length>4?'<span>+'+(types.length-4)+' more</span>':'')+'</div>':'')+
      (retake?'<div class="released-result retake-authorized"><strong>Retake '+esc(retake.authorizedAttemptNumber||"")+'</strong><span>'+esc(retakePolicyLabel(retake.scorePolicy,retake.retakeWeightPercent))+'</span></div>':graded?'<div class="released-result"><strong>'+esc(result.percent)+'%</strong><span>'+(a.releasePolicy?.releaseMode==="manual"&&!result?.released?'Graded • instructor release pending':'Graded result available')+'</span></div>':'')+
      '<div class="card-actions">'+actions+'</div></article>');
  }
  const studentGroups=new Map();
  for(let i=0;i<P3.assessments.length;i++){
    const assessment=P3.assessments[i],html=cards[i];
    const key=assessment.courseId||assessment.courseCode||assessment.courseTitle||"uncategorized";
    if(!studentGroups.has(key))studentGroups.set(key,{courseCode:assessment.courseCode||"Course",courseTitle:assessment.courseTitle||"",cards:[]});
    studentGroups.get(key).cards.push({assessment,html});
  }
  el.innerHTML=[...studentGroups.values()].sort((a,b)=>String(a.courseCode||"").localeCompare(String(b.courseCode||""),undefined,{numeric:true,sensitivity:"base"})).map(group=>
    '<section class="assessment-library-group assessment-course-group"><div class="page-head compact-head"><div><div class="panel-title">'+esc(group.courseCode)+(group.courseTitle?' — '+esc(group.courseTitle):'')+'</div><p class="page-subtitle">Scheduled and completed assessments for this course.</p></div></div><div class="assessment-grid">'+group.cards.sort((a,b)=>(a.assessment.opensAt?.toMillis?.()||0)-(b.assessment.opensAt?.toMillis?.()||0)||String(a.assessment.title||"").localeCompare(String(b.assessment.title||""),undefined,{numeric:true,sensitivity:"base"})).map(x=>x.html).join("")+'</div></section>'
  ).join("");
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

async function assessmentModal(existing,options={}){
  const s=state();if(!s?.courses?.length)return toast("Create a course before creating an assessment.");
  const types=["Topic Practice","Progress Check","Unit Assessment","Unit Evaluation","Practice Examination","Academic Exercise","Semester I Examination","Comprehensive Final Examination","Oral Examination","Disputation","Recommended Practice"];
  let selectedCourse=s.courses.find(c=>c.id===(existing?.courseId||options.courseId))||s.courses[0];
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
        '<div class="field"><label>Assessment Title</label><input class="title-input" name="title" value="'+esc(existing?.title||options.title||"")+'" placeholder="e.g. Semester I Examination" required></div>'+
        '<div class="field"><label>Assessment Type</label><div class="type-tile-grid compact">'+typeTiles+'</div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Administration Defaults</h3><p>These settings are copied when the template is assigned and can be adjusted for the section.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Duration</label><div class="input-with-suffix"><input name="durationMinutes" type="number" min="0" value="'+esc(existing?.durationMinutes??60)+'"><span>min</span></div></div><div class="field"><label>Opens</label><input name="opensAt" type="datetime-local" value="'+esc(localDateTime(existing?.opensAt))+'"></div><div class="field"><label>Closes</label><input name="closesAt" type="datetime-local" value="'+esc(localDateTime(existing?.closesAt))+'"></div></div>'+
        '<div class="policy-card-grid"><label class="policy-card"><input type="checkbox" name="anonymousGrading" '+(existing?.anonymousGrading!==false?'checked':'')+'><div><strong>Anonymous Grading</strong><span>Use candidate numbers while evaluating.</span></div></label><label class="policy-card"><input type="checkbox" name="backtracking" '+(existing?.backtracking!==false?'checked':'')+'><div><strong>Allow Backtracking</strong><span>Students may revisit earlier questions.</span></div></label><label class="policy-card"><input type="checkbox" name="randomizeQuestions" '+(existing?.randomizeQuestions?'checked':'')+'><div><strong>Shuffle Question Order</strong><span>Shuffle the final question order for each student.</span></div></label><label class="policy-card"><input type="checkbox" name="countsTowardComposite" '+((existing?existing.countsTowardComposite!==false:!["Topic Practice","Progress Check","Practice Examination","Recommended Practice"].includes(currentType))?'checked':'')+'><div><strong>Count in Composite Grade</strong><span>Include this assessment in the General Assessments component. Leave off for formative practice.</span></div></label></div>'+
        '<input type="hidden" name="feedbackPolicy" value="automatic">'+
        '<div class="result-policy-builder"><div class="panel-subtitle">Student Result Release</div><div class="policy-card-grid"><label class="policy-card"><input type="checkbox" name="showQuestionScores" '+(existing?.releasePolicy?.showQuestionScores!==false?'checked':'')+'><div><strong>Question Scores</strong><span>Show points earned per question.</span></div></label><label class="policy-card"><input type="checkbox" name="showExplanations" '+(existing?.releasePolicy?.showExplanations?'checked':'')+'><div><strong>Explanations</strong><span>Show Question Bank explanations after release.</span></div></label><label class="policy-card"><input type="checkbox" name="showCompetencies" '+(existing?.releasePolicy?.showCompetencies!==false?'checked':'')+'><div><strong>Content & Skills</strong><span>Show topic and competency performance.</span></div></label></div></div>'+
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

  let selectedQuestionIds=new Set(existing?[]:(options.questionIds||[]));
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
      if(randomDrawToggle.checked){
        const randomizeInput=form.querySelector('[name="randomizeQuestions"]');
        if(randomizeInput)randomizeInput.checked=true;
      }
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
      examMode:["Practice Examination","Semester I Examination","Comprehensive Final Examination"].includes(type),
      status:existing?.status||"Draft",durationMinutes:Number(fd.get("durationMinutes")||0),opensAt:timestampFrom(fd.get("opensAt")),closesAt:timestampFrom(fd.get("closesAt")),
      instructions:instructionSteps.join("\n"),instructionSteps,anonymousGrading:form.querySelector('[name="anonymousGrading"]')?.checked===true,backtracking:form.querySelector('[name="backtracking"]')?.checked===true,randomizeQuestions:randomDrawEnabled?true:form.querySelector('[name="randomizeQuestions"]')?.checked===true,
      randomDrawEnabled:existing?!!existing.randomDrawEnabled:randomDrawEnabled,
      randomDrawPlan:existing?(existing.randomDrawPlan||[]):randomDrawPlan,
      feedbackPolicy:String(fd.get("feedbackPolicy")),
      countsTowardComposite:form.querySelector('[name="countsTowardComposite"]')?.checked===true,
      formative:form.querySelector('[name="countsTowardComposite"]')?.checked!==true,
      releasePolicy:{
        ...(existing?.releasePolicy||{}),
        showOverallScore:existing?.releasePolicy?.showOverallScore!==false,
        showQuestionScores:form.querySelector('[name="showQuestionScores"]')?.checked!==false,
        showCorrectAnswers:existing?.releasePolicy?.showCorrectAnswers===true,
        showExplanations:form.querySelector('[name="showExplanations"]')?.checked===true,
        showCompetencies:form.querySelector('[name="showCompetencies"]')?.checked!==false,
        showClassAverage:existing?.releasePolicy?.showClassAverage===true,
        releaseMode:existing?.releasePolicy?.releaseMode||"when-graded"
      },
      correctionPolicy:existing?.correctionPolicy||{enabled:false,instructions:""},
      contentBlueprint,competencyBlueprint,competencyBlueprintAuto:true,competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,parts:existing?.parts?.length?existing.parts:defaultParts(type),
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
              itemId:item.id,itemVersion:Number(item.version||1),order,partId:(data.parts?.[0]?.id||"main"),type:item.type,prompt:item.prompt,
              stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points:Number(item.pointsDefault||1),
              difficulty:item.difficulty||"Moderate",cognitiveLevel:item.cognitiveLevel||"Application",tags:item.tags||[],qualityStatus:item.qualityStatus||"Published",
              unitId:item.unitId||"",unitTitle:item.unitTitle||"",unitNumber:Number(item.unitNumber||0),
              topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
              competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()
            });
            batch.set(doc(db,"assessments",id,"keys",ref.id),{
              itemId:item.id,itemVersion:Number(item.version||1),correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()
            });
          });
          await batch.commit();
        }
      }
      if(existing?.sectionId&&window.TheoriaPhase5?.logSectionEvent){
        await window.TheoriaPhase5.logSectionEvent(existing.sectionId,"assessment_content_updated","assessment",id,{title:String(fd.get("title")||existing.title||""),questionCount:existing?P3.detail?.questions?.length:chosenQuestions.length});
      }else if(window.TheoriaPhase5?.logCourseEvent){
        await window.TheoriaPhase5.logCourseEvent(course.id,existing?"assessment_template_updated":"assessment_template_created","assessment",id,{title:String(fd.get("title")||""),questionCount:existing?P3.detail?.questions?.length:chosenQuestions.length});
      }
      if(!existing&&options.fromBasket){P3.itemBasket=[];saveItemBasket();}
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
  let keys=[],submissions=[],results=[],members=[],retakes=[],attemptHistory=[],reviewReflections=[];
  if(state().role==="instructor"){
    const [k,s,r,rt,h,rr]=await Promise.all([
      getDocs(collection(db,"assessments",id,"keys")),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"submissions")):Promise.resolve({docs:[]}),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"results")):Promise.resolve({docs:[]}),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"retakes")):Promise.resolve({docs:[]}),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"attemptHistory")):Promise.resolve({docs:[]}),
      assessment.sectionId?getDocs(collection(db,"assessments",id,"reviewReflections")):Promise.resolve({docs:[]})
    ]);
    keys=k.docs.map(d=>({id:d.id,...d.data()}));
    submissions=s.docs.map(d=>({id:d.id,...d.data()}));
    results=r.docs.map(d=>({id:d.id,...d.data()}));
    retakes=rt.docs.map(d=>({id:d.id,...d.data()}));
    attemptHistory=h.docs.map(d=>({id:d.id,...d.data()}));
    reviewReflections=rr.docs.map(d=>({id:d.id,...d.data()}));
    if(assessment.sectionId){
      const m=assessment.entranceExam
        ? await getDocs(collection(db,"sections",assessment.sectionId,"entranceCandidates"))
        : await getDocs(collection(db,"sections",assessment.sectionId,"members"));
      members=m.docs.map(d=>({id:d.id,...d.data()})).sort((x,y)=>String(x.displayName||"").localeCompare(String(y.displayName||"")));
    }
  }
  return {assessment,questions,keys,submissions,results,members,retakes,attemptHistory,reviewReflections};
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
  const securityEnabled=window.TheoriaFeatureFlags?.assessmentSecurity!==false;
  const analyticsEnabled=window.TheoriaFeatureFlags?.analytics!==false;
  const tabs=[["overview","Overview"],["items","Questions"],["blueprint","Blueprint"]];
  if(securityEnabled)tabs.push(["security","Security"]);
  if(P3.current?.sectionId){
    tabs.push(["candidates","Progress"],["results","Student Results"],["grading","Grading"]);
    if(analyticsEnabled)tabs.push(["analytics","Content & Skills"]);
  }
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
  const canConfigure=(!a.sectionId||!(P3.detail.submissions||[]).length)&&a.officialMaterial!==true;
  return '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">'+(a.entranceExam?'Entrance Examination Snapshot':a.officialMaterial?'Official Assessment Snapshot':a.randomDrawEnabled?'Randomized Assessment Pool':'Assessment Assembly')+'</div><p class="page-subtitle">'+(a.entranceExam?'This entrance exam is a locked copy of '+esc(a.entranceSourceCourseCode||a.courseCode||"the source course")+' Question Bank material. Edit the source assessment template and replace the exam from the section to change its content.':a.officialMaterial?'This official Theoria course material is a locked Question Bank snapshot. Administration and release settings remain configurable, but question content is preserved.':a.randomDrawEnabled?'Students receive a locked random subset from this pool according to the draw plan.':'Students never receive answer-key documents.')+'</p></div><div class="inline-actions">'+(a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Entrance Exam</button>':a.officialMaterial?'<span class="badge gold">Official Snapshot Locked</span>':((canConfigure?'<button class="secondary-btn small-btn" data-phase3-action="configure-random-draw">'+(a.randomDrawEnabled?'Edit Random Draw':'Configure Random Draw')+'</button>':'')+'<button class="primary-btn small-btn" data-phase3-action="add-items">Add from Question Bank</button>'))+'</div></div>'+
    randomSummary+
    (a.randomDrawEnabled?'<div class="random-plan-display">'+(a.randomDrawPlan||[]).map(row=>'<div><span>'+esc(row.type)+'</span><strong>'+esc(row.count)+' of '+esc(row.available||q.filter(x=>x.type===row.type).length)+'</strong></div>').join("")+'</div>':'')+
    (q.length?'<div class="assessment-builder-list">'+q.map((x,i)=>'<div class="builder-item"><div class="builder-order">'+(i+1)+'</div><div class="builder-copy"><div class="card-kicker">'+esc((a.parts||[]).find(p=>p.id===x.partId)?.title||"Main")+' • '+esc(x.type)+'</div><h4>'+esc(x.prompt)+'</h4><div class="item-tags"><span>'+esc(x.points)+' pts</span>'+(x.itemId?'<span>QB v'+esc(x.itemVersion||1)+'</span>':'')+(x.sourceCourseCode?'<span>Source: '+esc(x.sourceCourseCode)+'</span>':'')+(x.unitTitle?'<span>Unit '+esc(x.unitNumber||"")+' — '+esc(x.unitTitle)+'</span>':'')+'<span>'+esc(x.topicNumber||"No topic")+'</span>'+(x.competencyCodes||[]).map(code=>'<span>'+esc(code)+'</span>').join("")+'</div></div>'+((a.entranceExam||a.officialMaterial)?'':'<div class="inline-actions">'+(x.itemId?'<button class="text-btn" data-phase3-action="refresh-item-version" data-id="'+x.id+'">Check Latest</button>':'')+'<button class="text-btn" data-phase3-action="configure-item" data-id="'+x.id+'">Configure</button><button class="text-btn danger-text" data-phase3-action="remove-item" data-id="'+x.id+'">Remove</button></div>')+'</div>').join("")+'</div>':
    '<div class="empty-state"><div class="empty-symbol">Q</div><h3>No assessment questions yet.</h3><p>'+(a.entranceExam?'Replace the entrance exam from the section with a populated source template.':'Add reusable questions from the course Question Bank.')+'</p>'+((a.entranceExam||a.officialMaterial)?'':'<button class="primary-btn" data-phase3-action="add-items">Add Questions</button>')+'</div>');
}

function configureRandomDrawModal(){
  const a=P3.current,d=P3.detail;if(!a||!d)return;
  if(a.officialMaterial===true)return toast("Official Theoria assessment snapshots cannot be reassembled. Create a custom assessment if you need different content.");
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
    const enabled=form.querySelector('[name="enabled"]')?.checked===true;
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


function retakePolicyLabel(policy,weight=50){
  if(policy==="replace")return "Retake replaces prior score";
  if(policy==="highest")return "Highest attempt counts";
  if(policy==="average")return "Average of all graded attempts";
  if(policy==="keep-original")return "Original score remains";
  if(policy==="weighted")return "Weighted blend • retake "+Number(weight||50)+"%";
  return "Retake score policy";
}

function retakeOfficialPercent(attemptPercent,authorization){
  const attempt=Math.max(0,Math.min(100,Number(attemptPercent||0)));
  if(!authorization)return attempt;
  const previous=safeArray(authorization.previousAttemptPercents).map(Number).filter(Number.isFinite);
  const baseline=Number.isFinite(Number(authorization.baselineOfficialPercent))?Number(authorization.baselineOfficialPercent):(previous.length?previous[previous.length-1]:attempt);
  const policy=String(authorization.scorePolicy||"replace");
  let official=attempt;
  if(policy==="highest")official=Math.max(attempt,...(previous.length?previous:[baseline]));
  else if(policy==="average"){
    const all=[...previous,attempt];
    official=all.reduce((n,x)=>n+x,0)/Math.max(1,all.length);
  }else if(policy==="keep-original")official=baseline;
  else if(policy==="weighted"){
    const weight=Math.max(0,Math.min(100,Number(authorization.retakeWeightPercent||50)))/100;
    official=baseline*(1-weight)+attempt*weight;
  }
  return Math.round(official*10)/10;
}

async function authorizeRetakeModal(studentId){
  const d=P3.detail,a=d?.assessment;
  if(!a?.sectionId||a.entranceExam)return toast("Use the entrance-exam reset workflow for entrance examinations.");
  const student=d.members.find(x=>x.id===studentId),sub=d.submissions.find(x=>x.studentId===studentId),res=d.results.find(x=>x.studentId===studentId);
  if(!student)return toast("Student not found.");
  if(!res?.complete)return toast("The current attempt must be fully graded before a retake can be authorized.");
  if(sub?.status==="in_progress")return toast("This student already has an active attempt.");

  let counterCount=Number(sub?.attemptNumber||1),history=[];
  try{
    const counter=await getDoc(doc(db,"assessments",a.id,"attemptCounters",studentId));
    if(counter.exists())counterCount=Math.max(counterCount,Number(counter.data().count||0));
  }catch(_){}
  try{
    const snap=await getDocs(collection(db,"assessments",a.id,"attemptHistory"));
    history=snap.docs.map(x=>({id:x.id,...x.data()})).filter(x=>x.studentId===studentId).sort((x,y)=>Number(x.attemptNumber||0)-Number(y.attemptNumber||0));
  }catch(_){}

  const currentAttemptNumber=Math.max(1,Number(sub?.attemptNumber||counterCount||1));
  const previousPercents=[
    ...history.filter(x=>Number(x.attemptNumber||0)!==currentAttemptNumber).map(x=>Number(x.attemptPercent??x.result?.attemptPercent??x.result?.percent)).filter(Number.isFinite),
    Number(res.attemptPercent??res.percent)
  ].filter(Number.isFinite);
  const baselineOfficial=Number(res.officialPercent??res.percent??0);
  const nextAttempt=Math.max(1,counterCount+1);
  const modal=core().openModal({
    eyebrow:"Assessment Retake",
    title:"Authorize Retake — "+(student.displayName||"Student"),
    wide:true,
    body:'<form id="retakeAuthorizationForm" class="academic-form">'+
      '<div class="academic-banner"><div class="kicker">'+esc(a.courseCode||"Assessment")+' • '+esc(a.title||"Assessment")+'</div><h3>Attempt '+nextAttempt+'</h3><p>The current official grade remains in the section Gradebook while the retake is pending. Once the retake is graded, Theoria applies the scoring rule selected below.</p></div>'+
      '<div class="section-summary"><div class="summary-block"><div class="summary-label">Current Official Score</div><div class="summary-value">'+esc(baselineOfficial)+'%</div></div><div class="summary-block"><div class="summary-label">Completed Attempts</div><div class="summary-value">'+previousPercents.length+'</div></div><div class="summary-block"><div class="summary-label">Next Attempt</div><div class="summary-value">'+nextAttempt+'</div></div></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>How should the retake affect the grade?</h3><p>The raw score for every attempt is preserved in attempt history regardless of the official-grade rule.</p></div></div>'+
        '<div class="retake-policy-grid">'+
          '<label class="policy-card"><input type="radio" name="scorePolicy" value="replace" checked><div><strong>Replace Previous Score</strong><span>The retake becomes the official assessment grade, even if it is lower.</span></div></label>'+
          '<label class="policy-card"><input type="radio" name="scorePolicy" value="highest"><div><strong>Highest Attempt</strong><span>The highest raw attempt score becomes the official grade.</span></div></label>'+
          '<label class="policy-card"><input type="radio" name="scorePolicy" value="average"><div><strong>Average All Attempts</strong><span>The official grade is the arithmetic mean of all graded attempts.</span></div></label>'+
          '<label class="policy-card"><input type="radio" name="scorePolicy" value="keep-original"><div><strong>Keep Original Grade</strong><span>The retake is recorded for evidence/practice but does not change the official grade.</span></div></label>'+
          '<label class="policy-card span-2"><input type="radio" name="scorePolicy" value="weighted"><div><strong>Weighted Blend</strong><span>Blend the current official grade with the new retake score using a custom retake weight.</span></div></label>'+
        '</div>'+
        '<div class="field hidden" id="retakeWeightField" style="margin-top:12px"><label>Retake Weight</label><div class="input-with-suffix"><input type="number" name="retakeWeightPercent" min="0" max="100" step="1" value="50"><span>%</span></div><small>The previous official grade receives the remaining weight.</small></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Retake Window</h3><p>Optional dates let this authorization work even if the original assessment window has closed.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Available From</label><input type="datetime-local" name="opensAt"></div><div class="field"><label>Retake Deadline</label><input type="datetime-local" name="closesAt"></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="field"><label>Instructor Note</label><textarea name="note" placeholder="Reason for retake, remediation completed, special condition, etc."></textarea></div></section>'+
      '<div class="notice danger-notice">Authorizing the retake archives the current attempt and result as immutable attempt history, then clears the active submission so the student can begin the new authorized attempt. The current Gradebook score remains in place until the new attempt is graded.</div>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Authorize Retake</button></div>'+
    '</form>'
  });
  const form=modal.querySelector("#retakeAuthorizationForm"),weightField=modal.querySelector("#retakeWeightField");
  const syncPolicy=()=>weightField.classList.toggle("hidden",form.querySelector('input[name="scorePolicy"]:checked')?.value!=="weighted");
  form.querySelectorAll('input[name="scorePolicy"]').forEach(x=>x.addEventListener("change",syncPolicy));syncPolicy();

  form.onsubmit=async e=>{
    e.preventDefault();
    const fd=new FormData(form),scorePolicy=String(fd.get("scorePolicy")||"replace"),retakeWeightPercent=Math.max(0,Math.min(100,Number(fd.get("retakeWeightPercent")||50)));
    const opensAt=timestampFrom(fd.get("opensAt")),closesAt=timestampFrom(fd.get("closesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The retake deadline must be after the retake start time.");
    const button=form.querySelector('button[type="submit"]');button.disabled=true;button.textContent="Authorizing…";
    try{
      const attemptNumber=currentAttemptNumber;
      const archiveId=studentId+"_attempt_"+attemptNumber;
      const historyRef=doc(db,"assessments",a.id,"attemptHistory",archiveId);
      const batch=writeBatch(db);
      batch.set(historyRef,{
        studentId,attemptNumber,
        candidateNumber:sub?.candidateNumber||res?.candidateNumber||"",
        submissionStatus:sub?.status||"graded",
        startedAt:sub?.startedAt||null,submittedAt:sub?.submittedAt||null,gradedAt:res?.gradedAt||null,
        attemptPercent:Number(res?.attemptPercent??res?.percent??0),
        officialPercent:Number(res?.officialPercent??res?.percent??0),
        retakePolicy:res?.retakePolicy||"",
        retakeWeightPercent:res?.retakeWeightPercent??null,
        archivedReason:"retake_authorized",
        archivedAt:serverTimestamp(),
        archivedBy:state().user.uid
      },{merge:true});
      if(sub)batch.set(doc(db,"assessments",a.id,"attemptSubmissions",archiveId),{...sub,studentId,attemptNumber,archivedAt:serverTimestamp(),archivedBy:state().user.uid},{merge:false});
      if(res)batch.set(doc(db,"assessments",a.id,"attemptResults",archiveId),{...res,studentId,attemptNumber,archivedAt:serverTimestamp(),archivedBy:state().user.uid},{merge:false});
      batch.set(doc(db,"assessments",a.id,"attemptCounters",studentId),{
        studentId,count:Math.max(attemptNumber,counterCount),updatedAt:serverTimestamp()
      },{merge:true});
      batch.set(doc(db,"assessments",a.id,"retakes",studentId),{
        studentId,active:true,authorizedAttemptNumber:nextAttempt,
        scorePolicy,retakeWeightPercent,
        baselineOfficialPercent:baselineOfficial,
        previousAttemptPercents:previousPercents,
        opensAt,closesAt,
        note:String(fd.get("note")||"").trim(),
        authorizedAt:serverTimestamp(),authorizedBy:state().user.uid,
        completedAt:null,lastAttemptPercent:null,lastOfficialPercent:null,
        updatedAt:serverTimestamp()
      },{merge:true});
      if(sub)batch.delete(doc(db,"assessments",a.id,"submissions",studentId));
      batch.delete(doc(db,"assessments",a.id,"results",studentId));
      batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+studentId),{
        retakePending:true,retakeAttemptNumber:nextAttempt,retakePolicy:scorePolicy,
        previousOfficialPercent:baselineOfficial,updatedAt:serverTimestamp()
      },{merge:true});
      await batch.commit();
      if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(a.sectionId,"assessment_retake_authorized","student",studentId,{assessmentId:a.id,attemptNumber:nextAttempt,scorePolicy,retakeWeightPercent,baselineOfficialPercent:baselineOfficial});
      core().closeModal();await openAssessment(a.id,"candidates");toast("Retake authorized for "+(student.displayName||"student")+".");
    }catch(error){
      button.disabled=false;button.textContent="Authorize Retake";
      toast(error.message||"Unable to authorize the retake.");
    }
  };
}

async function revokeRetake(studentId){
  const d=P3.detail,a=d?.assessment,auth=d?.retakes?.find(x=>x.id===studentId||x.studentId===studentId);
  if(!a||!auth?.active)return toast("No pending retake authorization was found.");
  if(d.submissions.some(x=>x.studentId===studentId&&x.status==="in_progress"))return toast("The retake has already started and can no longer be revoked from this control.");
  if(!confirm("Revoke this pending retake authorization and restore the student's most recent completed attempt?"))return;
  try{
    const archived=safeArray(d.attemptHistory)
      .filter(x=>x.studentId===studentId)
      .sort((x,y)=>Number(y.attemptNumber||0)-Number(x.attemptNumber||0))[0];
    let archivedSubmission=null,archivedResult=null;
    if(archived){
      const archiveId=studentId+"_attempt_"+Number(archived.attemptNumber||1);
      try{const snap=await getDoc(doc(db,"assessments",a.id,"attemptSubmissions",archiveId));if(snap.exists())archivedSubmission=snap.data();}catch(_){}
      try{const snap=await getDoc(doc(db,"assessments",a.id,"attemptResults",archiveId));if(snap.exists())archivedResult=snap.data();}catch(_){}
      // Backward compatibility for any history written by the first retake implementation.
      archivedSubmission=archivedSubmission||archived.submission||null;
      archivedResult=archivedResult||archived.result||null;
    }
    const batch=writeBatch(db);
    batch.set(doc(db,"assessments",a.id,"retakes",studentId),{
      active:false,revokedAt:serverTimestamp(),revokedBy:state().user.uid,updatedAt:serverTimestamp()
    },{merge:true});
    batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+studentId),{retakePending:false,updatedAt:serverTimestamp()},{merge:true});
    if(archivedSubmission)batch.set(doc(db,"assessments",a.id,"submissions",studentId),{...archivedSubmission,updatedAt:serverTimestamp()},{merge:false});
    if(archivedResult)batch.set(doc(db,"assessments",a.id,"results",studentId),{...archivedResult,updatedAt:serverTimestamp()},{merge:false});
    await batch.commit();
    if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(a.sectionId,"assessment_retake_revoked","student",studentId,{assessmentId:a.id,attemptNumber:auth.authorizedAttemptNumber,restoredAttempt:archived?.attemptNumber||null});
    await openAssessment(a.id,"candidates");toast("Retake authorization revoked and the prior attempt restored.");
  }catch(error){toast(error.message||"Unable to revoke the retake.");}
}

async function attemptHistoryModal(studentId){
  const d=P3.detail,a=d?.assessment,student=d?.members?.find(x=>x.id===studentId);
  if(!a)return;
  let rows=safeArray(d.attemptHistory).filter(x=>x.studentId===studentId).map(x=>({
    attemptNumber:Number(x.attemptNumber||x.submission?.attemptNumber||1),
    result:x.result||{
      attemptPercent:x.attemptPercent,officialPercent:x.officialPercent,percent:x.officialPercent,
      retakePolicy:x.retakePolicy,retakeWeightPercent:x.retakeWeightPercent,gradedAt:x.gradedAt
    },
    submission:x.submission||{
      candidateNumber:x.candidateNumber,status:x.submissionStatus,startedAt:x.startedAt,submittedAt:x.submittedAt
    },
    archived:true
  }));
  const currentSub=d.submissions.find(x=>x.studentId===studentId),currentResult=d.results.find(x=>x.studentId===studentId);
  if(currentSub||currentResult){
    const currentAttemptNumber=Number(currentSub?.attemptNumber||currentResult?.attemptNumber||rows.length+1);
    rows=rows.filter(row=>row.attemptNumber!==currentAttemptNumber);
    rows.push({attemptNumber:currentAttemptNumber,result:currentResult||{},submission:currentSub||{},archived:false});
  }
  rows.sort((x,y)=>x.attemptNumber-y.attemptNumber);
  const auth=d.retakes.find(x=>x.id===studentId||x.studentId===studentId);
  core().openModal({
    eyebrow:"Assessment Attempt History",
    title:(student?.displayName||"Student")+" — "+a.title,
    wide:true,
    body:(auth?.active?'<div class="notice"><strong>Retake '+esc(auth.authorizedAttemptNumber)+' authorized.</strong><p>'+esc(retakePolicyLabel(auth.scorePolicy,auth.retakeWeightPercent))+(auth.note?' • '+esc(auth.note):'')+'</p></div>':'')+
      (rows.length?'<div class="attempt-history-list">'+rows.map(row=>{
        const r=row.result||{},raw=r.attemptPercent??r.percent,official=r.officialPercent??r.percent;
        return '<div class="attempt-history-row"><div class="attempt-number">Attempt '+esc(row.attemptNumber)+'</div><div><strong>'+(raw!==undefined&&raw!==null?esc(raw)+'% raw score':'Awaiting result')+'</strong><span>'+(official!==undefined&&official!==null?'Official after attempt: '+esc(official)+'%':'')+'</span><small>'+esc(row.submission?.status||"Archived")+' • '+esc(dateText(row.submission?.submittedAt||r.gradedAt))+'</small></div>'+(r.retakePolicy?'<span class="badge">'+esc(retakePolicyLabel(r.retakePolicy,r.retakeWeightPercent))+'</span>':'')+'</div>';
      }).join("")+'</div>':'<div class="empty-mini">No attempt history is available yet.</div>'),
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
}

function candidatesView(){
  const d=P3.detail,a=d.assessment,subMap=new Map(d.submissions.map(x=>[x.studentId,x])),resMap=new Map(d.results.map(x=>[x.studentId,x])),retakeMap=new Map((d.retakes||[]).map(x=>[x.studentId||x.id,x]));
  const section=state()?.sections?.find(x=>x.id===a.sectionId),canManageRetakes=a.ownerId===state()?.user?.uid||["owner","coordinator"].includes(section?.staffRole||"");
  if(!d.members.length)return '<div class="empty-state"><div class="empty-symbol">C</div><h3>No enrolled candidates.</h3></div>';
  return '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Candidate</th><th>Status</th><th>Result</th><th>Student Visibility</th><th>Action</th></tr></thead><tbody>'+d.members.map(m=>{
    const sub=subMap.get(m.id),res=resMap.get(m.id),retake=retakeMap.get(m.id),history=(d.attemptHistory||[]).filter(x=>x.studentId===m.id),name=a.anonymousGrading!==false?(sub?.candidateNumber||m.displayName||"Candidate"):m.displayName;
    let action="—";
    if(!sub&&(a.mode==="oral"))action='<button class="secondary-btn small-btn" data-phase3-action="create-evaluation" data-student="'+m.id+'">Begin Evaluation</button>';
    else if(sub)action='<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>';

    if(a.entranceExam&&(sub||res))action='<div class="inline-actions">'+(sub?'<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>':'')+'<button class="text-btn danger-text" data-phase3-action="reset-entrance-attempt" data-student="'+m.id+'">Reset Attempt</button></div>';
    else if(!a.entranceExam){
      const controls=[];
      if(sub)controls.push('<button class="secondary-btn small-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Grade</button>');
      if(res?.complete&&canManageRetakes)controls.push('<button class="secondary-btn small-btn" data-phase3-action="authorize-retake" data-student="'+m.id+'">Authorize Retake</button>');
      if(retake?.active&&canManageRetakes)controls.push('<button class="text-btn danger-text" data-phase3-action="revoke-retake" data-student="'+m.id+'">Revoke Retake</button>');
      if(history.length||res||retake)controls.push('<button class="text-btn" data-phase3-action="attempt-history" data-student="'+m.id+'">Attempts</button>');
      action=controls.length?'<div class="inline-actions">'+controls.join("")+'</div>':action;
    }

    const visibility=a.entranceExam
      ? (res?.complete?'<span class="badge '+(Number(res.percent||0)>=Number(a.entrancePassPercent||70)?'live':'gold')+'">'+(Number(res.percent||0)>=Number(a.entrancePassPercent||70)?'Passed':'Not Passed')+'</span>':sub?'<span class="badge gold">'+esc(sub.status||"In progress")+'</span>':'<span class="badge">Waiting</span>')
      : retake?.active?'<span class="badge gold">Retake Authorized</span>' : (res?(res.complete===false?'<span class="badge gold">Private while grading</span>':'<span class="badge live">Visible to student</span>'):"—");

    const resultText=res
      ? (res.attemptPercent!==undefined&&res.attemptPercent!==null&&Number(res.attemptPercent)!==Number(res.percent)
          ? '<strong>'+esc(res.percent)+'%</strong><span class="grade-sub">Official • attempt '+esc(res.attemptPercent)+'%</span>'
          : '<strong>'+esc(res.percent)+'%</strong>')
      : retake?.active?'<span class="grade-sub">Prior grade retained in Gradebook</span>':'—';

    const status=sub?.status|| (retake?.active?"Retake pending":"Not started");
    return '<tr><td><strong>'+esc(name)+'</strong></td><td><span class="badge">'+esc(status)+'</span></td><td>'+resultText+'</td><td>'+visibility+'</td><td>'+action+'</td></tr>';
  }).join("")+'</tbody></table></div>';
}


function studentResultsView(){
  const d=P3.detail,a=d.assessment,resMap=new Map(d.results.map(x=>[x.studentId,x])),subMap=new Map(d.submissions.map(x=>[x.studentId,x])),reflectionMap=new Map((d.reviewReflections||[]).map(x=>[x.studentId||x.id,x]));
  if(!d.members.length)return '<div class="empty-state"><div class="empty-symbol">R</div><h3>No students in this assessment yet.</h3></div>';
  const complete=d.results.filter(x=>x.complete===true),avg=complete.length?Math.round(complete.reduce((n,x)=>n+Number(x.percent||0),0)/complete.length*10)/10:null;
  return '<div class="section-summary"><div class="summary-block"><div class="summary-label">Students</div><div class="summary-value">'+d.members.length+'</div></div><div class="summary-block"><div class="summary-label">Submitted</div><div class="summary-value">'+d.submissions.filter(x=>["submitted","graded"].includes(x.status)).length+'</div></div><div class="summary-block"><div class="summary-label">Complete Results</div><div class="summary-value">'+complete.length+'</div></div><div class="summary-block"><div class="summary-label">Class Average</div><div class="summary-value">'+(avg===null?"—":avg+"%")+'</div></div></div>'+
    '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Attempt</th><th>Status</th><th>Score</th><th>Released</th><th>Review</th><th>Action</th></tr></thead><tbody>'+d.members.map(m=>{const r=resMap.get(m.id),sub=subMap.get(m.id),reflection=reflectionMap.get(m.id);return '<tr><td><strong>'+esc(m.displayName||"Student")+'</strong><span class="grade-sub">'+esc(m.email||"")+'</span></td><td>'+esc(sub?.attemptNumber||r?.attemptNumber||1)+'</td><td>'+esc(r?.complete?"Graded":sub?.status||"Not started")+'</td><td>'+(r?.complete?'<strong>'+esc(r.percent)+'%</strong>':"—")+'</td><td>'+(r?.released?'<span class="badge live">Released</span>':'<span class="badge">Private</span>')+'</td><td>'+(reflection?'<button class="text-btn" data-phase3-action="view-reflection" data-student="'+m.id+'">Submitted</button>':'—')+'</td><td><div class="inline-actions">'+(sub?'<button class="text-btn" data-phase3-action="grade-candidate" data-student="'+m.id+'">Open Result</button>':'')+(r?.complete?'<button class="text-btn" data-phase3-action="toggle-release" data-student="'+m.id+'">'+(r.released?"Make Private":"Release")+'</button>':'')+'</div></td></tr>';}).join("")+'</tbody></table></div>';
}

function instructorReflectionModal(studentId){
  const d=P3.detail,m=d.members.find(x=>x.id===studentId),reflection=(d.reviewReflections||[]).find(x=>(x.studentId||x.id)===studentId);
  if(!reflection)return toast("No review reflection has been submitted.");
  core().openModal({
    eyebrow:"Post-Result Review",
    title:(m?.displayName||"Student")+" — "+(d.assessment.title||"Assessment"),
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">Score-Preserving Reflection</div><h3>Official grade unchanged</h3><p>This reflection documents review and learning after the released result. It does not modify assessment scoring.</p></div><div class="panel"><div class="panel-head"><div class="panel-title">Student Reflection</div></div><div class="panel-body"><p class="reflection-copy">'+esc(reflection.reflection||"").replace(/\n/g,"<br>")+'</p></div></div>',
    footer:'<button class="primary-btn" data-close-modal>Close</button>'
  });
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
  const body=tab==="items"?itemsView():tab==="blueprint"?'<div id="phase6BlueprintDesigner"><div class="empty-mini">Building assessment blueprint…</div></div>':tab==="security"?'<div id="phase6AssessmentSecurity"><div class="empty-mini">Loading security policy…</div></div>':tab==="candidates"?candidatesView():tab==="results"?studentResultsView():tab==="grading"?gradingView():tab==="analytics"?'<div id="phase5AssessmentAnalytics"><div class="empty-mini">Calculating content & skills report…</div></div>':overviewView();
  let statusButton="";
  if(a.entranceExam===true)statusButton='';
  else if(template)statusButton='<button class="primary-btn small-btn" data-phase3-action="assign-assessment" data-id="'+a.id+'">Assign to Section</button>';
  else if(a.status==="Draft")statusButton='<button class="primary-btn small-btn" data-phase3-action="publish">Publish to Students</button>';
  else if(a.status==="Published")statusButton='<button class="secondary-btn small-btn" data-phase3-action="close">Close</button>';
  else statusButton='<button class="secondary-btn small-btn" data-phase3-action="reopen">Reopen</button>';
  $("#assessmentDetail").innerHTML='<button class="text-btn" data-phase3-action="back-assessments">← Assessments</button>'+
    '<div class="detail-hero"><div class="detail-top"><div><div class="eyebrow">'+esc(a.courseCode)+' • '+esc(a.type)+(a.entranceExam?' • ENTRANCE EXAM':'')+'</div><h1 class="detail-title">'+esc(a.title)+'</h1><div class="detail-meta"><span>'+(template?'Reusable Template':esc(a.sectionName||"Assigned Section"))+'</span><span>'+esc(a.entranceExam?'Enrollment Gate':template?"Template":a.status)+'</span>'+(template||a.entranceExam?'':'<span>'+esc(dateText(a.opensAt))+'</span>')+'</div></div><div class="inline-actions">'+(a.entranceExam?'<button class="secondary-btn small-btn" data-phase3-action="open-entrance-section" data-section="'+esc(a.sectionId)+'">Manage Section</button>':(!template?'<button class="secondary-btn small-btn" data-phase3-action="edit-assignment" data-id="'+a.id+'">Edit Assignment</button>':''))+((a.entranceExam||a.officialMaterial)?'':'<button class="secondary-btn small-btn" data-phase3-action="edit-assessment">Edit Content</button>')+statusButton+(a.entranceExam?'':'<button class="danger-btn small-btn" data-phase3-action="delete-assessment" data-id="'+a.id+'">Delete Assessment</button>')+'</div></div>'+(a.instructions?'<p class="page-subtitle" style="margin-top:16px">'+esc(a.instructions)+'</p>':'')+'</div>'+
    (template?'<div class="workflow-strip"><div class="done"><span>1</span><strong>Template</strong></div><div class="'+(a.questionCount?"done":"current")+'"><span>2</span><strong>Question Bank</strong></div><div class="'+(a.questionCount?"current":"")+'"><span>3</span><strong>Assign</strong></div><div><span>4</span><strong>Publish</strong></div></div>':'')+
    assessmentTabs(tab)+'<div>'+body+'</div>';
  if(tab==="analytics")window.TheoriaPhase5?.renderAssessmentAnalytics?.(P3.detail);
  if(tab==="blueprint")window.TheoriaPlatform?.renderBlueprintDesigner?.(P3.detail);
  if(tab==="security")window.TheoriaPlatform?.renderAssessmentSecurity?.(P3.detail);
}

async function refreshAssessmentQuestionFromBank(questionId){
  const a=P3.current,d=P3.detail,q=d?.questions?.find(x=>x.id===questionId);if(!a||!q)return;
  if(a.officialMaterial===true)return toast("Official Theoria assessment snapshots remain pinned to their assigned Question Bank versions.");
  if(a.entranceExam)return toast("Entrance examination snapshots are replaced from their prerequisite source template, not updated question-by-question.");
  if(a.sectionId&&(d.submissions||[]).length)return toast("Question snapshots lock after the first assessment attempt is created.");
  if(!q.itemId)return toast("This question is not linked to a reusable Question Bank item.");
  const sourceCourseId=q.sourceCourseId||a.courseId;
  try{
    const snap=await getDoc(doc(db,"courses",sourceCourseId,"items",q.itemId));
    if(!snap.exists())return toast("The linked Question Bank item no longer exists.");
    const item={id:snap.id,...snap.data()},currentVersion=Math.max(1,Number(q.itemVersion||1)),latestVersion=Math.max(1,Number(item.version||1));
    if(latestVersion<=currentVersion)return toast("This assessment question already uses Question Bank v"+latestVersion+".");
    if(item.type!==q.type)return toast("The latest Question Bank version changed question type. Remove and re-add the item so assessment structure can be recalculated safely.");
    if(!confirm("Update this assessment snapshot from Question Bank v"+currentVersion+" to v"+latestVersion+"? The answer key and academic mappings will be refreshed from the master item."))return;
    const questionPatch={
      itemVersion:latestVersion,type:item.type,prompt:item.prompt||"",stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",
      options:item.options||[],unitId:item.unitId||"",unitTitle:item.unitTitle||"",unitNumber:Number(item.unitNumber||0),
      topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
      competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],
      cognitiveLevel:item.cognitiveLevel||q.cognitiveLevel||"Application",difficulty:item.difficulty||q.difficulty||"Moderate",
      tags:item.tags||[],updatedAt:serverTimestamp()
    };
    const batch=writeBatch(db);
    batch.update(doc(db,"assessments",a.id,"questions",q.id),questionPatch);
    batch.set(doc(db,"assessments",a.id,"keys",q.id),{
      itemId:item.id,itemVersion:latestVersion,correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],updatedAt:serverTimestamp()
    },{merge:true});
    await batch.commit();

    const updatedQuestions=d.questions.map(row=>row.id===q.id?{...row,...questionPatch}:row),fw=await framework(a.courseId);
    const competencyDerivation=deriveCompetencyBlueprint(updatedQuestions,fw.competencies||[],{randomDrawEnabled:!!a.randomDrawEnabled,randomDrawPlan:a.randomDrawPlan||[]});
    await updateDoc(doc(db,"assessments",a.id),{
      competencyBlueprint:competencyDerivation.rows,competencyBlueprintAuto:true,
      competencyBlueprintMappedPoints:competencyDerivation.taggedExpectedPoints,
      competencyBlueprintUnmappedPoints:competencyDerivation.untaggedExpectedPoints,updatedAt:serverTimestamp()
    });
    if(a.sectionId&&window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(a.sectionId,"assessment_question_version_updated","question",q.id,{itemId:item.id,fromVersion:currentVersion,toVersion:latestVersion});
    else if(window.TheoriaPhase5?.logCourseEvent)await window.TheoriaPhase5.logCourseEvent(a.courseId,"assessment_question_version_updated","question",q.id,{itemId:item.id,fromVersion:currentVersion,toVersion:latestVersion});
    await openAssessment(a.id,"items");toast("Assessment snapshot updated to Question Bank v"+latestVersion+".");
  }catch(error){toast(error.message||"Unable to refresh the assessment question.");}
}

async function addItemsModal(){
  await loadItems();
  const a=P3.current;
  if(a?.officialMaterial===true)return toast("Official Theoria assessment content is locked. Create a custom assessment to change the question set.");
  const available=P3.items.filter(x=>x.courseId===a.courseId&&!["Retired","Draft"].includes(x.qualityStatus||"Published")&&!P3.detail.questions.some(q=>q.itemId===x.id));
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
        itemId:item.id,itemVersion:Number(item.version||1),order,partId:String(fd.get("partId")),type:item.type,prompt:item.prompt,
        stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points,
        difficulty:item.difficulty||"Moderate",cognitiveLevel:item.cognitiveLevel||"Application",tags:item.tags||[],qualityStatus:item.qualityStatus||"Published",
        unitId:item.unitId||"",unitTitle:item.unitTitle||"",unitNumber:Number(item.unitNumber||0),
        topicId:item.topicId||"",topicTitle:item.topicTitle||"",topicNumber:item.topicNumber||"",
        competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],createdAt:serverTimestamp()
      });
      batch.set(doc(db,"assessments",a.id,"keys",ref.id),{itemId:item.id,itemVersion:Number(item.version||1),correctAnswer:item.correctAnswer??"",explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()});
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
  if(a.officialMaterial===true)return toast("Official Theoria assessment content is locked.");
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
        randomDrawEnabled:!!template.randomDrawEnabled,
        randomDrawPlan:(template.randomDrawPlan||[]).map(row=>({...row})),
        randomizeQuestions:!!template.randomizeQuestions,
        questionIds,
        questionPool:source.questions.map((q,index)=>({
          id:questionRefs[index].id,
          itemId:q.itemId||"",
          type:q.type,
          points:Number(q.points||0)
        })),
        poolQuestionCount:source.questions.length,
        questionCount:template.randomDrawEnabled?Number(template.questionCount||source.questions.length):source.questions.length,
        totalPoints:template.randomDrawEnabled?Number(template.totalPoints||0):source.questions.reduce((n,q)=>n+Number(q.points||0),0),
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
      if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(section.id,"entrance_exam_configured","assessment",ref.id,{sourceCourseId:template.courseId,sourceCourseCode:template.courseCode||sourceCourse.code||"",templateId:template.id,passPercent});
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
        '<div class="panel-subtitle" style="margin-top:14px">Optional Makeup Administration</div><div class="compact-field-grid"><div class="field"><label>Makeup Opens</label><input name="makeupOpensAt" type="datetime-local"></div><div class="field"><label>Makeup Closes</label><input name="makeupClosesAt" type="datetime-local"></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Academic Treatment</h3><p>Choose whether this section copy contributes to the Composite General Assessments grade.</p></div></div><label class="policy-card"><input type="checkbox" name="countsTowardComposite" '+(a.countsTowardComposite!==false?'checked':'')+'><div><strong>Count in Composite Grade</strong><span>Turn this off for formative practice and progress checks.</span></div></label></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>04</span><h3>Release</h3><p>Keep it private while reviewing, or publish it to students immediately.</p></div></div>'+
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
    const makeupOpensAt=timestampFrom(fd.get("makeupOpensAt")),makeupClosesAt=timestampFrom(fd.get("makeupClosesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The close time must be after the open time.");
    if(makeupOpensAt&&makeupClosesAt&&makeupOpensAt.toMillis()>=makeupClosesAt.toMillis())return toast("The makeup close time must be after its open time.");
    const administrationWindows=(makeupOpensAt||makeupClosesAt)?[{kind:"makeup",label:"Makeup Administration",opensAt:makeupOpensAt||null,closesAt:makeupClosesAt||null}]:[];
    const countsTowardComposite=form.elements.countsTowardComposite.checked===true;

    const duplicate=P3.assessments.find(x=>x.sectionId===section.id&&x.templateSourceId===a.id);
    if(duplicate&&!confirm("This template is already assigned to "+section.sectionName+". Assign another copy anyway?"))return;

    const ref=doc(collection(db,"assessments"));
    const clone={
      ...Object.fromEntries(Object.entries(a).filter(([k])=>!["id","createdAt","updatedAt"].includes(k))),
      ownerId:s.user.uid,sectionId:section.id,sectionName:section.sectionName,templateSourceId:a.id,
      title:String(fd.get("title")).trim(),status:initialStatus,durationMinutes:Number(fd.get("durationMinutes")||0),
      opensAt,closesAt,administrationWindows,makeupOpensAt:makeupOpensAt||null,makeupClosesAt:makeupClosesAt||null,
      makeupStudentIds:[],countsTowardComposite,formative:!countsTowardComposite,
      questionIds:d.questions.map(q=>q.id),
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
          opensAt:clone.opensAt||null,closesAt:clone.closesAt||null,durationMinutes:clone.durationMinutes||0,
          makeupOpensAt:clone.makeupOpensAt||null,makeupClosesAt:clone.makeupClosesAt||null,makeupStudentIds:[],
          catalogKind:clone.catalogKind||"",officialMaterial:clone.officialMaterial===true,formative:!countsTowardComposite,countsTowardComposite,
          frameworkUnitId:clone.frameworkUnitId||"",frameworkUnitNumber:Number(clone.frameworkUnitNumber||0),frameworkUnitTitle:clone.frameworkUnitTitle||"",
          frameworkTopicId:clone.frameworkTopicId||"",frameworkTopicNumber:clone.frameworkTopicNumber||"",frameworkTopicTitle:clone.frameworkTopicTitle||"",
          updatedAt:serverTimestamp()
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
  let assignedMembers=[];
  try{
    const memberSnap=await getDocs(collection(db,"sections",a.sectionId,"members"));
    assignedMembers=memberSnap.docs.map(x=>({id:x.id,...x.data()})).sort((x,y)=>String(x.displayName||"").localeCompare(String(y.displayName||"")));
  }catch(_){}
  const makeupSelected=new Set(a.makeupStudentIds||[]);
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
        '<div class="panel-subtitle" style="margin-top:14px">Optional Makeup Administration</div><div class="compact-field-grid"><div class="field"><label>Makeup Opens</label><input name="makeupOpensAt" type="datetime-local" value="'+esc(localDateTime(a.makeupOpensAt||(a.administrationWindows||[]).find(x=>x.kind==="makeup")?.opensAt))+'"></div><div class="field"><label>Makeup Closes</label><input name="makeupClosesAt" type="datetime-local" value="'+esc(localDateTime(a.makeupClosesAt||(a.administrationWindows||[]).find(x=>x.kind==="makeup")?.closesAt))+'"></div></div>'+
        '<div class="field" style="margin-top:12px"><label>Makeup Administration Group</label><div class="field-help">Select specific students for the makeup window. Leave everyone unselected to make the makeup window available to the entire section.</div><div class="makeup-student-grid">'+assignedMembers.map(m=>'<label class="checkbox-line compact-check"><input type="checkbox" name="makeupStudentId" value="'+m.id+'" '+(makeupSelected.has(m.id)?'checked':'')+'> '+esc(m.displayName||"Student")+'</label>').join("")+'</div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Academic Treatment</h3><p>Control whether this assigned assessment changes the Composite final grade.</p></div></div><label class="policy-card"><input type="checkbox" name="countsTowardComposite" '+(a.countsTowardComposite!==false?'checked':'')+'><div><strong>Count in Composite Grade</strong><span>Include this assessment in General Assessments. Turn off for formative Topic Practice, Progress Checks, and practice exams.</span></div></label></section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Assignment Changes</button></div></form>'
  });
  const form=modal.querySelector("#editAssignedAssessmentForm");
  form.sectionId.value=a.sectionId;
  form.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(form);
    const newSectionId=hasAttempts?a.sectionId:String(fd.get("sectionId")),newSection=sections.find(sec=>sec.id===newSectionId);
    const opensAt=timestampFrom(fd.get("opensAt")),closesAt=timestampFrom(fd.get("closesAt"));
    const makeupOpensAt=timestampFrom(fd.get("makeupOpensAt")),makeupClosesAt=timestampFrom(fd.get("makeupClosesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The close time must be after the open time.");
    if(makeupOpensAt&&makeupClosesAt&&makeupOpensAt.toMillis()>=makeupClosesAt.toMillis())return toast("The makeup close time must be after its open time.");
    const moved=newSectionId!==a.sectionId;
    const makeupStudentIds=moved?[]:fd.getAll("makeupStudentId").map(String);
    const administrationWindows=(makeupOpensAt||makeupClosesAt)?[{kind:"makeup",label:"Makeup Administration",opensAt:makeupOpensAt||null,closesAt:makeupClosesAt||null,studentIds:makeupStudentIds}]:[];
    const countsTowardComposite=form.elements.countsTowardComposite.checked===true;
    const title=String(fd.get("title")).trim(),durationMinutes=Number(fd.get("durationMinutes")||0);
    try{
      const batch=writeBatch(db);
      batch.update(doc(db,"assessments",a.id),{
        title,durationMinutes,opensAt,closesAt,administrationWindows,makeupOpensAt:makeupOpensAt||null,makeupClosesAt:makeupClosesAt||null,makeupStudentIds,countsTowardComposite,formative:!countsTowardComposite,sectionId:newSectionId,sectionName:newSection.sectionName,updatedAt:serverTimestamp()
      });
      if(a.status==="Published"){
        if(moved)batch.delete(doc(db,"sections",a.sectionId,"assessmentRefs",a.id));
        batch.set(doc(db,"sections",newSectionId,"assessmentRefs",a.id),{
          assessmentId:a.id,title,type:a.type,assessmentType:a.type,totalPoints:Number(a.totalPoints||0),status:a.status,opensAt:opensAt||null,closesAt:closesAt||null,durationMinutes,
          catalogKind:a.catalogKind||"",officialMaterial:a.officialMaterial===true,formative:!countsTowardComposite,countsTowardComposite,
          makeupOpensAt:makeupOpensAt||null,makeupClosesAt:makeupClosesAt||null,makeupStudentIds,
          frameworkUnitId:a.frameworkUnitId||"",frameworkUnitNumber:Number(a.frameworkUnitNumber||0),frameworkUnitTitle:a.frameworkUnitTitle||"",
          frameworkTopicId:a.frameworkTopicId||"",frameworkTopicNumber:a.frameworkTopicNumber||"",frameworkTopicTitle:a.frameworkTopicTitle||"",
          updatedAt:serverTimestamp()
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
      const [results,retakes,attemptHistory,attemptSubmissions,attemptResults,attemptCounters]=await Promise.all([
        getDocs(collection(db,"assessments",a.id,"results")),
        getDocs(collection(db,"assessments",a.id,"retakes")),
        getDocs(collection(db,"assessments",a.id,"attemptHistory")),
        getDocs(collection(db,"assessments",a.id,"attemptSubmissions")),
        getDocs(collection(db,"assessments",a.id,"attemptResults")),
        getDocs(collection(db,"assessments",a.id,"attemptCounters"))
      ]);
      results.docs.forEach(x=>refs.push(x.ref));
      retakes.docs.forEach(x=>refs.push(x.ref));
      attemptHistory.docs.forEach(x=>refs.push(x.ref));
      attemptSubmissions.docs.forEach(x=>refs.push(x.ref));
      attemptResults.docs.forEach(x=>refs.push(x.ref));
      attemptCounters.docs.forEach(x=>refs.push(x.ref));
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

async function chooseSectionForCourseBatch(courseId){
  const s=state();
  const course=s.courses?.find(c=>c.id===courseId);
  const sections=(s.sections||[]).filter(sec=>sec.courseId===courseId).sort((a,b)=>String(a.sectionName||"").localeCompare(String(b.sectionName||""),undefined,{numeric:true,sensitivity:"base"}));
  if(!sections.length)return toast("Create a teaching section for "+(course?.code||"this course")+" before assigning assessments.");
  if(sections.length===1)return chooseAssessmentForSection(sections[0].id);

  const modal=core().openModal({
    eyebrow:"Batch Assessment Assignment",
    title:"Choose Destination Section",
    body:'<form id="batchAssessmentSectionForm"><div class="academic-banner"><div class="kicker">'+esc(course?.code||"Course")+'</div><h3>'+esc(course?.title||"Assign Multiple Assessments")+'</h3><p>Select the section that should receive the assessment copies.</p></div><div class="section-choice-grid">'+sections.map((sec,index)=>'<label class="section-choice '+(index===0?'selected':'')+'"><input type="radio" name="sectionId" value="'+sec.id+'" '+(index===0?'checked':'')+'><div><span>'+esc(sec.courseCode||course?.code||"Course")+'</span><strong>'+esc(sec.sectionName||"Section")+'</strong><small>'+esc(sec.term||"")+'</small></div><div class="section-choice-check">✓</div></label>').join("")+'</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Choose Assessments</button></div></form>'
  });
  modal.querySelectorAll('.section-choice input').forEach(input=>input.addEventListener("change",()=>modal.querySelectorAll(".section-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked))));
  modal.querySelector("#batchAssessmentSectionForm").onsubmit=e=>{
    e.preventDefault();
    const sectionId=String(new FormData(e.currentTarget).get("sectionId")||"");
    if(!sectionId)return toast("Choose a section.");
    core().closeModal();
    chooseAssessmentForSection(sectionId);
  };
}

async function cloneAssessmentTemplateToSection(template,detail,section,{initialStatus="Draft",opensAt=null,closesAt=null}={}){
  const s=state();
  const ref=doc(collection(db,"assessments"));
  const questionTotal=detail.questions.reduce((n,q)=>n+Number(q.points||0),0);
  const clone={
    ...Object.fromEntries(Object.entries(template).filter(([k])=>!["id","createdAt","updatedAt"].includes(k))),
    ownerId:s.user.uid,
    sectionId:section.id,
    sectionName:section.sectionName,
    templateSourceId:template.id,
    title:String(template.title||"Assessment").trim(),
    status:initialStatus,
    durationMinutes:Number(template.durationMinutes||60),
    opensAt,
    closesAt,
    questionIds:detail.questions.map(q=>q.id),
    questionPool:(template.questionPool?.length?template.questionPool:detail.questions.map(q=>({id:q.id,itemId:q.itemId||"",type:q.type,points:Number(q.points||0)}))),
    poolQuestionCount:detail.questions.length,
    questionCount:Number(template.questionCount||detail.questions.length),
    totalPoints:Number(template.totalPoints||questionTotal),
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  };

  await setDoc(ref,clone);
  for(let i=0;i<detail.questions.length;i+=180){
    const batch=writeBatch(db),chunk=detail.questions.slice(i,i+180);
    for(const q of chunk){
      const cleanQ=Object.fromEntries(Object.entries(q).filter(([k])=>k!=="id"));
      batch.set(doc(db,"assessments",ref.id,"questions",q.id),{...cleanQ,clonedAt:serverTimestamp()});
      const key=detail.keys.find(k=>k.id===q.id);
      if(key){
        const cleanK=Object.fromEntries(Object.entries(key).filter(([k])=>k!=="id"));
        batch.set(doc(db,"assessments",ref.id,"keys",q.id),{...cleanK,clonedAt:serverTimestamp()});
      }
    }
    await batch.commit();
  }

  if(initialStatus==="Published"){
    await setDoc(doc(db,"sections",section.id,"assessmentRefs",ref.id),{
      assessmentId:ref.id,
      title:clone.title,
      type:clone.type,
      assessmentType:clone.type,
      totalPoints:Number(clone.totalPoints||0),
      status:"Published",
      opensAt:clone.opensAt||null,
      closesAt:clone.closesAt||null,
      durationMinutes:clone.durationMinutes||0,
      catalogKind:clone.catalogKind||"",
      officialMaterial:clone.officialMaterial===true,
      formative:clone.formative===true,
      countsTowardComposite:clone.countsTowardComposite!==false,
      frameworkUnitId:clone.frameworkUnitId||"",
      frameworkUnitNumber:Number(clone.frameworkUnitNumber||0),
      frameworkUnitTitle:clone.frameworkUnitTitle||"",
      frameworkTopicId:clone.frameworkTopicId||"",
      frameworkTopicNumber:clone.frameworkTopicNumber||"",
      frameworkTopicTitle:clone.frameworkTopicTitle||"",
      updatedAt:serverTimestamp()
    });
  }

  if(window.TheoriaPhase5?.logSectionEvent){
    await window.TheoriaPhase5.logSectionEvent(section.id,"assessment_assigned","assessment",ref.id,{
      title:clone.title||"",
      templateSourceId:template.id,
      status:initialStatus,
      batchAssignment:true
    });
  }
  return {id:ref.id,...clone};
}

async function chooseAssessmentForSection(sectionId){
  await loadAssessments();
  const section=state().sections.find(x=>x.id===sectionId)||state().currentSection;
  if(!section)return toast("Section not found.");
  const templates=P3.assessments
    .filter(a=>!a.sectionId&&a.courseId===section.courseId)
    .sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""),undefined,{numeric:true,sensitivity:"base"}));
  if(!templates.length)return toast("No reusable assessment templates exist for this course yet. Create one in Assessments and add Question Bank questions first.");

  const assignedForSection=P3.assessments.filter(a=>a.sectionId===section.id);
  const existingTemplateIds=new Set(assignedForSection.map(a=>a.templateSourceId).filter(Boolean));
  const modal=core().openModal({
    eyebrow:"Assign Assessments",
    title:"Assign to "+section.sectionName,
    wide:true,
    body:'<form id="chooseAssessmentForm" class="academic-form">'+
      '<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+' • Batch Assignment</div><h3>Select one or more assessment templates</h3><p>Every selected template becomes its own independent section assessment with its own questions, submissions, results, grading, and security policy.</p></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Assessment Templates</h3><p>Select as many assessments as you want to assign in this batch.</p></div><div class="assignment-preview-stats compact"><div><strong id="selectedAssessmentCount">0</strong><span>Selected</span></div><div><strong>'+templates.length+'</strong><span>Available</span></div><div><strong>'+assignedForSection.length+'</strong><span>Already Assigned</span></div></div></div>'+
      '<div class="question-bank-toolbar"><div class="field"><label>Search Assessments</label><input id="templateSearch" placeholder="Search title or assessment type"></div><div class="field"><label>Type</label><select id="templateType"><option value="">All types</option>'+[...new Set(templates.map(x=>x.type).filter(Boolean))].sort().map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("")+'</select></div></div>'+
      '<div class="inline-actions" style="margin-bottom:12px"><button type="button" class="secondary-btn small-btn" id="selectVisibleAssessments">Select Visible</button><button type="button" class="text-btn" id="clearAssessmentSelection">Clear Selection</button></div>'+
      '<div id="templateChoiceList" class="template-choice-list"></div></section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Shared Schedule</h3><p>The selected assessments keep their own duration, but use this common availability window.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Opens</label><input name="opensAt" type="datetime-local"></div><div class="field"><label>Closes</label><input name="closesAt" type="datetime-local"></div></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Release</h3><p>Choose how every assessment in this batch should be created.</p></div></div>'+
        '<div class="release-choice-grid"><label class="release-choice"><input type="radio" name="initialStatus" value="Draft" checked><div><strong>Save All as Draft</strong><span>Students cannot see them until you publish each assessment.</span></div></label><label class="release-choice"><input type="radio" name="initialStatus" value="Published"><div><strong>Assign & Publish All</strong><span>Each assessment becomes visible according to the shared schedule.</span></div></label></div>'+
      '</section>'+
      '<div class="assignment-copy-note"><strong>Templates remain unchanged.</strong><span>Existing assignments are marked in the list. If you select one that is already assigned to this section, Theoria will ask before creating another independent copy.</span></div>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="batchAssignSubmit" type="submit">Assign Selected Assessments</button></div></form>'
  });

  const form=modal.querySelector("#chooseAssessmentForm");
  const list=modal.querySelector("#templateChoiceList");
  const search=modal.querySelector("#templateSearch");
  const type=modal.querySelector("#templateType");
  const count=modal.querySelector("#selectedAssessmentCount");
  const selected=new Set();

  const filteredTemplates=()=>{
    const q=search.value.trim().toLowerCase(),t=type.value;
    return templates.filter(a=>(!t||a.type===t)&&(!q||[a.title,a.type,a.courseCode,a.courseTitle].join(" ").toLowerCase().includes(q)));
  };
  const refreshCount=()=>{count.textContent=String(selected.size);};
  const render=()=>{
    const rows=filteredTemplates();
    list.innerHTML=rows.length?rows.map(a=>{
      const assignedCount=P3.assessments.filter(x=>x.templateSourceId===a.id).length;
      const alreadyHere=existingTemplateIds.has(a.id);
      return '<label class="template-choice rich '+(selected.has(a.id)?'selected':'')+'"><input type="checkbox" name="assessmentId" value="'+a.id+'" '+(selected.has(a.id)?'checked':'')+'><div><span>'+esc(a.type)+(alreadyHere?' • Already in this section':'')+'</span><strong>'+esc(a.title)+'</strong><small>'+esc(a.questionCount||0)+' questions • '+esc(a.totalPoints||0)+' points • '+esc(a.durationMinutes||0)+' min'+(assignedCount?' • assigned '+assignedCount+' time'+(assignedCount===1?"":"s"):'')+'</small></div><div class="section-choice-check">✓</div></label>';
    }).join(""):'<div class="empty-state compact-empty"><div class="empty-symbol">A</div><h3>No matching assessment templates.</h3><p>Adjust the search or filter.</p></div>';
    list.querySelectorAll('input[name="assessmentId"]').forEach(input=>input.onchange=()=>{
      if(input.checked)selected.add(input.value);else selected.delete(input.value);
      refreshCount();render();
    });
    refreshCount();
  };

  search.oninput=render;
  type.onchange=render;
  modal.querySelector("#selectVisibleAssessments").onclick=()=>{filteredTemplates().forEach(a=>selected.add(a.id));render();};
  modal.querySelector("#clearAssessmentSelection").onclick=()=>{selected.clear();render();};
  modal.querySelectorAll('.release-choice input').forEach(x=>x.addEventListener("change",()=>modal.querySelectorAll(".release-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked))));
  modal.querySelectorAll(".release-choice").forEach(label=>label.classList.toggle("selected",label.querySelector("input").checked));
  render();

  form.onsubmit=async e=>{
    e.preventDefault();
    if(!selected.size)return toast("Select at least one assessment template.");
    const fd=new FormData(form);
    const initialStatus=String(fd.get("initialStatus")||"Draft");
    const opensAt=timestampFrom(fd.get("opensAt")),closesAt=timestampFrom(fd.get("closesAt"));
    if(opensAt&&closesAt&&opensAt.toMillis()>=closesAt.toMillis())return toast("The close time must be after the open time.");

    const selectedTemplates=templates.filter(a=>selected.has(a.id));
    const duplicates=selectedTemplates.filter(a=>existingTemplateIds.has(a.id));
    if(duplicates.length&&!confirm(duplicates.length+" selected assessment"+(duplicates.length===1?" is":"s are")+" already assigned to this section. Create another independent cop"+(duplicates.length===1?"y":"ies")+" anyway?"))return;

    const submit=modal.querySelector("#batchAssignSubmit");
    submit.disabled=true;submit.textContent="Assigning 0 / "+selectedTemplates.length;
    const created=[],failed=[];
    for(let i=0;i<selectedTemplates.length;i++){
      const template=selectedTemplates[i];
      submit.textContent="Assigning "+(i+1)+" / "+selectedTemplates.length;
      try{
        const detail=await loadAssessment(template.id);
        if(!detail.questions.length)throw new Error("No questions are attached to this template.");
        const clone=await cloneAssessmentTemplateToSection(template,detail,section,{initialStatus,opensAt,closesAt});
        created.push(clone);
      }catch(error){
        console.error("Batch assessment assignment failed:",template.id,error);
        failed.push({template,error});
      }
    }

    await loadAssessments();
    core().closeModal();
    if(state().currentSection?.id===section.id)await renderSectionAssessments();
    else await renderAssessments();

    if(failed.length){
      toast(created.length+" assessment"+(created.length===1?"":"s")+" assigned; "+failed.length+" could not be assigned.");
    }else{
      toast(created.length+" assessment"+(created.length===1?"":"s")+" assigned "+(initialStatus==="Published"?"and published.":"as drafts."));
    }
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
  else batch.set(doc(db,"sections",a.sectionId,"assessmentRefs",a.id),{assessmentId:a.id,title:a.title,type:a.type,assessmentType:a.type,totalPoints:Number(a.totalPoints||0),status,opensAt:a.opensAt||null,closesAt:a.closesAt||null,durationMinutes:a.durationMinutes||0,catalogKind:a.catalogKind||"",officialMaterial:a.officialMaterial===true,formative:a.formative===true,countsTowardComposite:a.countsTowardComposite!==false,frameworkUnitId:a.frameworkUnitId||"",frameworkUnitNumber:Number(a.frameworkUnitNumber||0),frameworkUnitTitle:a.frameworkUnitTitle||"",frameworkTopicId:a.frameworkTopicId||"",frameworkTopicNumber:a.frameworkTopicNumber||"",frameworkTopicTitle:a.frameworkTopicTitle||"",updatedAt:serverTimestamp()},{merge:true});
  try{
    await batch.commit();
    if(a.sectionId&&window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(a.sectionId,"assessment_status_changed","assessment",a.id,{title:a.title||"",status});
    await openAssessment(a.id);await renderAssessments();toast("Assessment "+status.toLowerCase()+".");
  }catch(err){toast(err.message||"Unable to update assessment.");}
}

/* -------------------- SECTION ASSESSMENTS / PATHWAYS -------------------- */

async function renderSectionAssessments(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!s||!section||!el)return;
  el.innerHTML='<div class="empty-mini">Loading section assessments…</div>';
  try{
    let list=[];
    if(s.role==="instructor"){
      try{
        // Preferred path for owners and delegated academic staff.
        const snap=await getDocs(query(collection(db,"assessments"),where("sectionId","==",section.id)));
        list=snap.docs.map(d=>({id:d.id,...d.data()}));
      }catch(primaryError){
        console.warn("Section assessment query unavailable; using compatibility fallback.",primaryError);
        const byId=new Map();

        // A section owner can always recover every assigned copy, including
        // Draft assessments, through the existing ownerId rule. This keeps the
        // section workspace usable even before newly published rules deploy.
        if(section.ownerId===s.user.uid){
          const owned=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
          owned.docs
            .map(d=>({id:d.id,...d.data()}))
            .filter(a=>a.sectionId===section.id)
            .forEach(a=>byId.set(a.id,a));
        }else{
          // Delegated staff can at minimum recover published section refs when
          // the section-scoped query is unavailable.
          const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
          for(const r of refs.docs){
            try{
              const a=await getDoc(doc(db,"assessments",r.id));
              if(a.exists())byId.set(a.id,{id:a.id,...a.data()});
            }catch(error){console.warn("Unable to load assessment ref",r.id,error);}
          }
        }

        // Entrance examinations are intentionally not placed in assessmentRefs.
        if(section.entranceAssessmentId&&!byId.has(section.entranceAssessmentId)){
          try{
            const entrance=await getDoc(doc(db,"assessments",section.entranceAssessmentId));
            if(entrance.exists())byId.set(entrance.id,{id:entrance.id,...entrance.data()});
          }catch(error){console.warn("Unable to load entrance assessment",error);}
        }

        list=[...byId.values()];
      }
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
      ? '<div class="page-head" style="margin-bottom:16px"><div><div class="panel-title">Assigned Assessments</div><p class="page-subtitle">Assign reusable course assessments to this section, then publish when ready.</p></div><button class="primary-btn small-btn" data-phase3-action="assign-current-section" data-section="'+section.id+'">Assign Assessments</button></div>'
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
    const permission=String(error?.code||"").includes("permission-denied");
    el.innerHTML='<div class="empty-state"><div class="empty-symbol">!</div><h3>Assessments could not be loaded.</h3><p>'+(permission?'The currently deployed Firestore rules are blocking this section assessment view. Deploy the current repository rules, then refresh.':'The assessment workspace encountered an unexpected data error. Refresh once; if it continues, check the browser console for the exact Firebase error.')+'</p></div>';
  }
}

async function toggleGradingPeriodLock(period){
  const s=state(),section=s?.currentSection;if(!section||s.role!=="instructor")return;
  const snap=await getDoc(doc(db,"sections",section.id));if(!snap.exists())return toast("Section not found.");
  const data=snap.data(),policy=data.gradingPolicy||{},settings={...(policy.gradingPeriodSettings||{})},current=settings[period]||{},nextLocked=current.locked!==true;
  if(nextLocked){
    const sectionData=s.sectionData||{},assignments=(sectionData.assignments||[]).filter(a=>a.status!=="Draft"&&(a.gradingPeriod||"Overall")===period),members=sectionData.members||[],grades=sectionData.grades||[];
    let ungraded=0,markedMissing=0;
    for(const assignment of assignments){
      for(const member of members){
        const grade=grades.find(g=>g.assignmentId===assignment.id&&g.studentId===member.id);
        if(!grade||grade.score===null||grade.score===undefined)ungraded++;
        if(String(grade?.gradeStatus||"")==="Missing")markedMissing++;
      }
    }
    const review="Finalize and lock "+period+"?\n\nFinalization review:\n• "+assignments.length+" coursework item"+(assignments.length===1?"":"s")+"\n• "+members.length+" student"+(members.length===1?"":"s")+"\n• "+ungraded+" ungraded cell"+(ungraded===1?"":"s")+"\n• "+markedMissing+" explicitly marked Missing\n\nGrade edits will be blocked until an instructor reopens the period.";
    if(!confirm(review))return;
  }
  if(!nextLocked&&!confirm("Reopen "+period+" for grade changes? The audit log will record this action."))return;
  settings[period]={
    ...current,
    locked:nextLocked,
    finalizedAt:nextLocked?Timestamp.now():null,
    finalizedBy:nextLocked?s.user.uid:"",
    reopenedAt:nextLocked?null:Timestamp.now(),
    reopenedBy:nextLocked?"":s.user.uid
  };
  const gradingPolicy={...policy,gradingPeriodSettings:settings,updatedAt:Timestamp.now()};
  try{
    await updateDoc(doc(db,"sections",section.id),{gradingPolicy,updatedAt:serverTimestamp()});
    section.gradingPolicy=gradingPolicy;
    if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(section.id,nextLocked?"grading_period_finalized":"grading_period_reopened","section",section.id,{period});
    toast(period+(nextLocked?" finalized and locked.":" reopened for grading."));
    await renderGradingPolicy();
  }catch(error){toast(error.message||"Unable to update the grading period.");}
}

function compositePolicyWeights(policy={}){
  const raw=policy.composite||{coursework:60,semester:15,comprehensive:25};
  if(raw.assessments!==undefined&&raw.assessments!==null){
    return {
      coursework:Number(raw.coursework||0),
      assessments:Number(raw.assessments||0),
      semester:Number(raw.semester||0),
      comprehensive:Number(raw.comprehensive||0)
    };
  }
  const legacyCoursework=Number(raw.coursework??60);
  const assessmentShare=Math.min(20,Math.max(0,legacyCoursework/2));
  return {
    coursework:Math.round((legacyCoursework-assessmentShare)*10)/10,
    assessments:Math.round(assessmentShare*10)/10,
    semester:Number(raw.semester??15),
    comprehensive:Number(raw.comprehensive??25)
  };
}

async function renderGradingPolicy(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const secSnap=await getDoc(doc(db,"sections",section.id)),sec=secSnap.exists()?secSnap.data():section;
  const policy=sec.gradingPolicy||{selectionOpen:true,selectionDeadline:null,gradingPeriods:["Overall"],examination:{semester:35,comprehensive:65},composite:{coursework:40,assessments:20,semester:15,comprehensive:25},courseworkRules:{dropLowest:0,missingAsZero:false,latePenaltyPercent:0,categoryWeights:{}}};
  const compositePolicy=compositePolicyWeights(policy);
  const pathSnap=await getDocs(collection(db,"sections",section.id,"gradingPathways"));
  const selections=pathSnap.docs.map(d=>({id:d.id,...d.data()}));
  el.innerHTML='<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Grading Pathway Policy</div></div><div class="panel-body"><form id="gradingPolicyForm">'+
    '<div class="compact-field-grid"><div class="field"><label>Selection Deadline</label><input name="deadline" type="datetime-local" value="'+esc(localDateTime(policy.selectionDeadline))+'"></div><div class="field"><label>Grading Periods</label><input name="gradingPeriods" value="'+esc((policy.gradingPeriods?.length?policy.gradingPeriods:["Overall"]).join(", "))+'" placeholder="Quarter 1, Quarter 2, Final"></div></div>'+
    '<div class="grading-period-locks">'+(policy.gradingPeriods?.length?policy.gradingPeriods:["Overall"]).map(period=>{const setting=policy.gradingPeriodSettings?.[period]||{};return '<div class="grading-period-lock-row"><div><strong>'+esc(period)+'</strong><span>'+(setting.locked?'Finalized'+(setting.finalizedAt?' • '+esc(dateText(setting.finalizedAt)):''):'Open for grading')+'</span></div><button type="button" class="'+(setting.locked?'secondary-btn':'danger-btn')+' small-btn" data-phase3-action="toggle-grading-period" data-period="'+esc(period)+'">'+(setting.locked?'Reopen':'Finalize & Lock')+'</button></div>';}).join("")+'</div>'+
    '<label class="checkbox-line" style="margin-bottom:16px"><input type="checkbox" name="selectionOpen" '+(policy.selectionOpen!==false?'checked':'')+'> Students may select/change pathways</label>'+
    '<div class="path-policy"><h4>Examination Pathway</h4><div class="form-grid"><div class="field"><label>Semester I Exam %</label><input name="examSemester" type="number" value="'+esc(policy.examination?.semester??35)+'"></div><div class="field"><label>Comprehensive Final %</label><input name="examFinal" type="number" value="'+esc(policy.examination?.comprehensive??65)+'"></div></div></div>'+
    '<div class="path-policy"><h4>Composite Pathway</h4><p class="page-subtitle">General Assessments includes Unit Evaluations, Academic Exercises, Oral Examinations, Disputations, and other regular formal assessments. Semester and Comprehensive exams remain separate and are not double-counted.</p><div class="form-grid"><div class="field"><label>Coursework %</label><input name="compCoursework" type="number" min="0" max="100" step="0.1" value="'+esc(compositePolicy.coursework)+'"></div><div class="field"><label>General Assessments %</label><input name="compAssessments" type="number" min="0" max="100" step="0.1" value="'+esc(compositePolicy.assessments)+'"></div><div class="field"><label>Semester I Exam %</label><input name="compSemester" type="number" min="0" max="100" step="0.1" value="'+esc(compositePolicy.semester)+'"></div><div class="field"><label>Comprehensive Final %</label><input name="compFinal" type="number" min="0" max="100" step="0.1" value="'+esc(compositePolicy.comprehensive)+'"></div></div></div>'+
    '<div class="path-policy"><h4>Coursework Rules</h4><div class="compact-field-grid"><div class="field"><label>Drop Lowest</label><input name="dropLowest" type="number" min="0" max="20" value="'+esc(policy.courseworkRules?.dropLowest??0)+'"></div><div class="field"><label>Late Penalty</label><div class="input-with-suffix"><input name="latePenaltyPercent" type="number" min="0" max="100" value="'+esc(policy.courseworkRules?.latePenaltyPercent??0)+'"><span>%</span></div></div></div><label class="checkbox-line"><input type="checkbox" name="missingAsZero" '+(policy.courseworkRules?.missingAsZero?'checked':'')+'> Treat ungraded Missing items as zero in coursework calculations</label><div class="panel-subtitle" style="margin:12px 0 7px">Optional category weights. Leave all values at 0 for normal points-based grading.</div><div class="compact-field-grid">'+[...new Set((s.sectionData?.assignments||[]).map(a=>a.type||"Assignment"))].map(type=>'<div class="field"><label>'+esc(type)+' %</label><input class="category-weight-input" data-category="'+esc(type)+'" type="number" min="0" max="100" value="'+esc(policy.courseworkRules?.categoryWeights?.[type]??0)+'"></div>').join("")+'</div></div>'+
    '<button class="primary-btn" type="submit">Save Grading Policy</button></form></div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Student Selections</div></div><div class="panel-body">'+(selections.length?selections.map(x=>'<div class="selection-row"><div><strong>'+esc(x.studentName||x.studentId)+'</strong><span>'+esc(x.pathway==="examination"?"Examination Pathway":"Composite Pathway")+'</span></div><span class="badge '+(x.pathway==="examination"?'gold':'live')+'">'+esc(x.pathway)+'</span></div>').join(""):'<div class="empty-mini">No selections yet.</div>')+'</div></div></div>';
  $("#gradingPolicyForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const examination={semester:Number(fd.get("examSemester")),comprehensive:Number(fd.get("examFinal"))};
    const composite={coursework:Number(fd.get("compCoursework")),assessments:Number(fd.get("compAssessments")),semester:Number(fd.get("compSemester")),comprehensive:Number(fd.get("compFinal"))};
    if(Math.abs(examination.semester+examination.comprehensive-100)>0.001)return toast("Examination Pathway must total 100%.");
    if(Math.abs(composite.coursework+composite.assessments+composite.semester+composite.comprehensive-100)>0.001)return toast("Composite Pathway must total 100%.");
    const categoryWeights={};
    [...e.currentTarget.querySelectorAll(".category-weight-input")].forEach(input=>{categoryWeights[input.dataset.category]=Number(input.value||0);});
    const categoryTotal=Object.values(categoryWeights).reduce((n,x)=>n+Number(x||0),0);
    if(categoryTotal!==0&&categoryTotal!==100)return toast("Coursework category weights must total 100%, or all remain 0 for points-based grading.");
    const courseworkRules={
      dropLowest:Math.max(0,Math.floor(Number(fd.get("dropLowest")||0))),
      missingAsZero:e.currentTarget.querySelector('[name="missingAsZero"]')?.checked===true,
      latePenaltyPercent:Math.max(0,Math.min(100,Number(fd.get("latePenaltyPercent")||0))),
      categoryWeights
    };
    const gradingPeriods=[...new Set(String(fd.get("gradingPeriods")||"Overall").split(",").map(x=>x.trim()).filter(Boolean))];
    if(!gradingPeriods.length)gradingPeriods.push("Overall");
    const gradingPolicy={...policy,selectionOpen:e.currentTarget.querySelector('[name="selectionOpen"]')?.checked===true,selectionDeadline:timestampFrom(fd.get("deadline")),gradingPeriods,gradingPeriodSettings:{...(policy.gradingPeriodSettings||{})},examination,composite,courseworkRules,updatedAt:serverTimestamp()};
    try{
      await updateDoc(doc(db,"sections",section.id),{gradingPolicy,updatedAt:serverTimestamp()});
      section.gradingPolicy=gradingPolicy;
      if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(section.id,"grading_policy_updated","section",section.id,{examination,composite,courseworkRules});
      toast("Grading policy saved.");await renderGradingPolicy();
    }catch(err){toast(err.message||"Unable to save grading policy.");}
  });
}

async function renderStudentPathway(){
  const s=state(),section=s.currentSection,el=$("#phase3SectionTab");if(!section||!el)return;
  const secSnap=await getDoc(doc(db,"sections",section.id)),sec=secSnap.exists()?secSnap.data():section,policy=sec.gradingPolicy;
  if(!policy){el.innerHTML='<div class="empty-state"><div class="empty-symbol">G</div><h3>Pathway selection is not open yet.</h3></div>';return;}
  let selection=null;try{const x=await getDoc(doc(db,"sections",section.id,"gradingPathways",s.user.uid));if(x.exists())selection=x.data();}catch(_){}
  const deadline=policy.selectionDeadline?.toDate?.(),open=policy.selectionOpen!==false&&(!deadline||deadline.getTime()>=Date.now()),ex=policy.examination||{semester:35,comprehensive:65},co=compositePolicyWeights(policy);
  el.innerHTML='<div class="academic-banner"><div class="kicker">Final Grade Method</div><h3>'+(selection?"Current selection: "+(selection.pathway==="examination"?"Examination Pathway":"Composite Pathway"):"Choose your grading pathway")+'</h3><p>Coursework remains graded throughout the course. Selection deadline: '+esc(dateText(policy.selectionDeadline))+'</p></div>'+
    '<div class="pathway-grid"><label class="pathway-card '+(selection?.pathway==="examination"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="examination" '+(selection?.pathway==="examination"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">A</div><div><h3>Examination Pathway</h3><p>Final standing is determined entirely by cumulative examination performance.</p><div class="formula-row"><span>Semester I Examination</span><strong>'+ex.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+ex.comprehensive+'%</strong></div></div></label>'+
    '<label class="pathway-card '+(selection?.pathway==="composite"?'selected':'')+'"><input type="radio" name="pathwayChoice" value="composite" '+(selection?.pathway==="composite"?'checked':'')+' '+(!open?'disabled':'')+'><div class="pathway-letter">B</div><div><h3>Composite Pathway</h3><p>Final standing combines sustained coursework, regular formal assessments, and cumulative examinations.</p><div class="formula-row"><span>Coursework</span><strong>'+co.coursework+'%</strong></div><div class="formula-row"><span>General Assessments</span><strong>'+co.assessments+'%</strong></div><div class="formula-row"><span>Semester I Examination</span><strong>'+co.semester+'%</strong></div><div class="formula-row"><span>Comprehensive Final</span><strong>'+co.comprehensive+'%</strong></div></div></label></div>'+
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
      '<label class="policy-card" style="margin-top:14px"><input type="checkbox" name="persistentProfile"><div><strong>Save as Persistent Access Profile</strong><span>Use these authorized settings as the student’s default in future sections unless another instructor sets a section-specific override.</span></div></label>'+
      '<div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Accommodations</button></div></form>'
  });
  const form=modal?.querySelector("#accommodationForm");
  if(!form){core().closeModal();return toast("The accommodation editor could not be initialized. Refresh Theoria and try again.");}
  const timeMultiplierInput=form.querySelector('[name="timeMultiplier"]');
  if(timeMultiplierInput)timeMultiplierInput.value=String(a.timeMultiplier||1);
  form.addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(form),accommodations={timeMultiplier:Number(fd.get("timeMultiplier")||1),breaks:form.querySelector('[name="breaks"]')?.checked===true,calculator:form.querySelector('[name="calculator"]')?.checked===true,largeText:form.querySelector('[name="largeText"]')?.checked===true,reducedDistractions:form.querySelector('[name="reducedDistractions"]')?.checked===true,notes:String(fd.get("notes")||"").trim()};
    try{
      const usePersistent=form.querySelector('[name="persistentProfile"]')?.checked===true;
      if(usePersistent){
        await setDoc(doc(db,"academicAccess",studentId),{
          studentId,accommodations,notes:accommodations.notes||"",
          updatedBy:s.user.uid,updatedByName:s.profile?.displayName||s.user.displayName||"Instructor",
          updatedAt:serverTimestamp()
        },{merge:true});
      }
      await updateDoc(doc(db,"sections",section.id,"members",studentId),{accommodations,useProfileDefaults:usePersistent,updatedAt:serverTimestamp()});
      if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(section.id,"accommodations_updated","student",studentId,{persistentProfile:usePersistent,timeMultiplier:accommodations.timeMultiplier,breaks:accommodations.breaks,calculator:accommodations.calculator,largeText:accommodations.largeText,reducedDistractions:accommodations.reducedDistractions});
      core().closeModal();await core().reloadCurrentSection("students");toast(usePersistent?"Persistent access profile and section accommodations saved.":"Section-specific accommodations saved.");
    }catch(err){toast(err.message||"Unable to save accommodations.");}
  });
}

/* -------------------- EXAM RUNTIME -------------------- */

async function startExam(id,confirmed=false){
  const s=state();
  try{
    const snap=await getDoc(doc(db,"assessments",id));if(!snap.exists())return toast("Assessment not found.");
    const a={id:snap.id,...snap.data()};
    if(a.mode==="oral")return toast("This oral examination is instructor administered.");
    let retakeAuth=null;
    try{
      const rt=await getDoc(doc(db,"assessments",id,"retakes",s.user.uid));
      if(rt.exists()&&rt.data().active===true)retakeAuth={id:rt.id,...rt.data()};
    }catch(_){}
    const now=Date.now(),opens=a.opensAt?.toMillis?.()||0,closes=a.closesAt?.toMillis?.()||0;
    const makeupOpens=a.makeupOpensAt?.toMillis?.()||0,makeupCloses=a.makeupClosesAt?.toMillis?.()||0;
    const retakeOpens=retakeAuth?.opensAt?.toMillis?.()||0,retakeCloses=retakeAuth?.closesAt?.toMillis?.()||0;
    let activeAdministration=null;
    if(!retakeAuth){
      if(a.status!=="Published"&&a.status!=="Closed")return toast("This assessment has not been published to students.");
      if(a.status==="Closed")return toast("This assessment has been closed by the instructor.");
      const primaryOpen=(!opens||now>=opens)&&(!closes||now<=closes);
      const makeupEligible=!(a.makeupStudentIds||[]).length||(a.makeupStudentIds||[]).includes(s.user.uid);
      const makeupOpen=makeupEligible&&!!(makeupOpens||makeupCloses)&&(!makeupOpens||now>=makeupOpens)&&(!makeupCloses||now<=makeupCloses);
      if(primaryOpen)activeAdministration={kind:"primary",opensAt:a.opensAt,closesAt:a.closesAt};
      else if(makeupOpen)activeAdministration={kind:"makeup",opensAt:a.makeupOpensAt,closesAt:a.makeupClosesAt};
      else{
        if(opens&&now<opens)return toast("This assessment opens "+dateText(a.opensAt)+".");
        if(makeupOpens&&now<makeupOpens)return toast("The primary window has ended. The makeup administration opens "+dateText(a.makeupOpensAt)+".");
        return toast("All assessment administration windows have ended.");
      }
    }else{
      if(retakeOpens&&now<retakeOpens)return toast("Your authorized retake opens "+dateText(retakeAuth.opensAt)+".");
      if(retakeCloses&&now>retakeCloses)return toast("Your authorized retake window closed "+dateText(retakeAuth.closesAt)+".");
      activeAdministration={kind:"retake",opensAt:retakeAuth.opensAt,closesAt:retakeAuth.closesAt};
    }
    const security=a.securityPolicy||{};
    let subSnap=await getDoc(doc(db,"assessments",id,"submissions",s.user.uid)),sub=subSnap.exists()?{id:subSnap.id,...subSnap.data()}:null;
    const activeOpens=activeAdministration?.opensAt?.toMillis?.()||0;
    if(!sub&&!retakeAuth&&security.lateEntryPolicy==="deny-after-start"&&activeOpens){
      const grace=Math.max(0,Number(security.lateEntryGraceMinutes||0))*60000;
      if(now>activeOpens+grace)return toast("Late entry is not permitted for this administration window.");
    }
    if(sub&&sub.status!=="in_progress")return receipt(id);

    const memberSnap=await getDoc(doc(db,"sections",a.sectionId,"members",s.user.uid));
    let participantData=memberSnap.exists()?memberSnap.data():null;
    if(!participantData&&a.entranceExam===true){
      const candidateSnap=await getDoc(doc(db,"sections",a.sectionId,"entranceCandidates",s.user.uid));
      if(candidateSnap.exists())participantData=candidateSnap.data();
    }
    if(!participantData)return toast(a.entranceExam?"Your entrance-exam access has not been initialized. Re-enter the section join code.":"You are not enrolled in the section assigned to this assessment.");
    let attemptCount=0;
    try{
      const counter=await getDoc(doc(db,"assessments",id,"attemptCounters",s.user.uid));
      if(counter.exists())attemptCount=Number(counter.data().count||0);
    }catch(_){}
    const nextAttemptNumber=attemptCount+1;
    const retakeAllowed=!!retakeAuth&&Number(retakeAuth.authorizedAttemptNumber||0)===nextAttemptNumber;
    if(!sub&&attemptCount>=Math.max(1,Number(security.maxAttempts||1))&&!retakeAllowed)return toast("You have reached the maximum number of attempts for this assessment.");
    let persistentDefaults=s.profile?.defaultAccommodations||{};
    try{
      const accessSnap=await getDoc(doc(db,"academicAccess",s.user.uid));
      if(accessSnap.exists())persistentDefaults=accessSnap.data().accommodations||persistentDefaults;
    }catch(_){}
    const acc=(participantData.useProfileDefaults===true||a.entranceExam===true)
      ? {...persistentDefaults,...(participantData.useProfileDefaults===true?{}:(participantData.accommodations||{}))}
      : (participantData.accommodations||persistentDefaults||{});
    if(!sub&&!confirmed){
      const minutes=Math.round(Number(a.durationMinutes||0)*Number(acc.timeMultiplier||1));
      const modal=core().openModal({
        eyebrow:retakeAllowed?"Authorized Retake":a.entranceExam?"Entrance Examination":"Formal Assessment",
        title:a.title,
        wide:true,
        body:'<div class="exam-preflight"><div class="preflight-warning"><strong>Before you begin</strong><p>'+(retakeAllowed?"Your instructor authorized this retake. Beginning creates attempt "+nextAttemptNumber+" and starts the assessment timer. The retake will be graded under the policy shown below.":a.entranceExam?"This examination is required before enrollment. Beginning creates your entrance candidate record and starts the examination timer.":"Beginning creates your official candidate record and starts the examination timer.")+' Refreshing the browser does not create a new attempt.</p></div>'+
          (retakeAllowed?'<div class="notice"><strong>'+esc(retakePolicyLabel(retakeAuth.scorePolicy,retakeAuth.retakeWeightPercent))+'</strong><p>'+(retakeAuth.note?esc(retakeAuth.note):'Your previous attempt remains preserved in academic attempt history.')+'</p></div>':'')+
          '<div class="detail-list"><div><span>Assessment</span><strong>'+esc(a.type)+'</strong></div><div><span>Time Allowed</span><strong>'+(minutes?minutes+" minutes":"Untimed")+'</strong></div><div><span>Administration</span><strong>'+esc(retakeAllowed?"Authorized Retake":activeAdministration?.kind==="makeup"?"Makeup":"Primary")+'</strong></div><div><span>Closes</span><strong>'+esc(dateText(retakeAllowed?(retakeAuth.closesAt||a.closesAt):(activeAdministration?.closesAt||a.closesAt)))+'</strong></div><div><span>Backtracking</span><strong>'+(a.backtracking!==false?"Permitted":"Restricted")+'</strong></div><div><span>Grading</span><strong>'+(a.anonymousGrading!==false?"Anonymous candidate number":"Named")+'</strong></div><div><span>Attempt</span><strong>'+(retakeAllowed?("Retake "+nextAttemptNumber+" • instructor authorized"):(nextAttemptNumber+" of "+Math.max(1,Number(security.maxAttempts||1))))+'</strong></div></div>'+
          ((security.fullscreenRequired||security.fullscreenExpectation)?'<div class="notice"><strong>Fullscreen required.</strong><p>The assessment will lock if fullscreen is exited and will remain hidden until fullscreen is restored.</p></div>':'')+
          (security.accessCodeConfigured?'<div class="field"><label>Assessment Access Code</label><input id="examAccessCode" type="password" autocomplete="off" required></div>':'')+
          (a.instructions?'<div class="preflight-instructions"><div class="eyebrow">Instructor Instructions</div><p>'+esc(a.instructions).replace(/\n/g,"<br>")+'</p></div>':'')+
          '<div class="accommodation-summary"><div class="eyebrow">Assessment Access</div><span>'+esc(acc.timeMultiplier||1)+'× time</span>'+(acc.breaks?'<span>Breaks permitted</span>':'')+(acc.calculator?'<span>Calculator permitted</span>':'')+(acc.largeText?'<span>Large text</span>':'')+'</div>'+
          '<label class="checkbox-line preflight-ack"><input id="examAck" type="checkbox"> I have read the instructions and understand that beginning starts my official attempt.</label>'+
          (security.honorAcknowledgement?'<label class="checkbox-line preflight-ack"><input id="honorAck" type="checkbox"> I affirm that I will complete this assessment according to the instructor\'s academic-integrity expectations.</label>':'')+'</div>',
        footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="beginExamBtn" disabled>'+(retakeAllowed?'Begin Retake':'Begin Assessment')+'</button>'
      });
      const ack=modal.querySelector("#examAck"),honor=modal.querySelector("#honorAck"),begin=modal.querySelector("#beginExamBtn");
      const sync=()=>{begin.disabled=!ack.checked||(honor&&!honor.checked);};ack.onchange=sync;if(honor)honor.onchange=sync;sync();
      begin.onclick=async()=>{
        begin.disabled=true;begin.textContent="Authorizing…";
        const fullscreenRequired=security.fullscreenRequired||security.fullscreenExpectation;
        if(fullscreenRequired&&!document.fullscreenElement){
          try{
            await document.documentElement.requestFullscreen();
          }catch(error){
            begin.disabled=false;begin.textContent="Begin Assessment";
            return toast("Fullscreen is required for this assessment. Allow fullscreen, then begin again.");
          }
        }
        if(security.accessCodeConfigured){
          const code=modal.querySelector("#examAccessCode")?.value||"";
          const authorized=await window.TheoriaPlatform?.authorizeAssessmentAccess?.(a,code);
          if(!authorized){
            if(fullscreenRequired&&document.fullscreenElement&&document.exitFullscreen)document.exitFullscreen().catch(()=>{});
            begin.disabled=false;begin.textContent="Begin Assessment";return;
          }
        }
        core().closeModal();startExam(id,true);
      };return;
    }

    if(!sub){
      let order=[];
      try{order=buildAttemptQuestionOrder(a);}catch(error){return toast(error.message||"Unable to build your assessment version.");}
      if(!order.length)return toast("This assessment has no published questions.");
      const nextAttempt=attemptCount+1;
      const attemptBatch=writeBatch(db);
      attemptBatch.set(doc(db,"assessments",id,"attemptCounters",s.user.uid),{
        studentId:s.user.uid,count:nextAttempt,lastStartedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      attemptBatch.set(doc(db,"assessments",id,"submissions",s.user.uid),{
        studentId:s.user.uid,candidateNumber:newCandidateNumber(),status:"in_progress",attemptNumber:nextAttempt,
        startedAt:serverTimestamp(),acknowledgedAt:serverTimestamp(),honorAcknowledged:security.honorAcknowledgement?true:false,updatedAt:serverTimestamp(),
        answers:{},marked:[],currentIndex:0,elapsedSeconds:0,questionOrder:order,securityViolationCount:0,
        securityPolicySnapshot:{
          maxAttempts:Math.max(1,Number(security.maxAttempts||1)),
          lateEntryPolicy:String(security.lateEntryPolicy||"allow"),
          lateEntryGraceMinutes:Math.max(0,Number(security.lateEntryGraceMinutes||0)),
          honorAcknowledgement:!!security.honorAcknowledgement,
          fullscreenRequired:!!(security.fullscreenRequired||security.fullscreenExpectation),
          focusPolicy:String(security.focusPolicy||((security.logFocusLoss===false)?"none":"log")),
          maxFocusViolations:Math.max(1,Number(security.maxFocusViolations||3)),
          blockCopy:!!security.blockCopy,
          blockPaste:!!security.blockPaste,
          blockCut:!!security.blockCut,
          blockContextMenu:!!security.blockContextMenu,
          logCopy:security.logCopy!==false,
          accessCodeConfigured:!!security.accessCodeConfigured,
          accessCodeVersion:Number(security.accessCodeVersion||0)
        },
        accommodationsApplied:{timeMultiplier:Number(acc.timeMultiplier||1),breaks:!!acc.breaks,calculator:!!acc.calculator,largeText:!!acc.largeText,reducedDistractions:!!acc.reducedDistractions}
      });
      await attemptBatch.commit();
      if(a.entranceExam===true){
        await setDoc(doc(db,"users",s.user.uid,"entranceAttempts",a.sectionId),{status:"in_progress",assessmentId:a.id,updatedAt:serverTimestamp()},{merge:true});
      }
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
    const runtimeAssessment={...a,securityPolicy:sub.securityPolicySnapshot||a.securityPolicy||{}};
    launchExam(runtimeAssessment,questions,sub);
  }catch(err){
    console.error("Unable to start assessment:",err);
    toast(err?.code==="permission-denied"?"Theoria could not authorize this assessment attempt. Confirm that the assessment is published to this exact section and that your account is enrolled, then try again.":(err.message||"This assessment is not available."));
  }
}

function examSecurityPolicy(){
  return P3.exam?.assessment?.securityPolicy||{};
}

async function logEvent(type,details={}){
  if(!P3.exam)return;
  try{
    await addDoc(collection(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid,"events"),{
      studentId:state().user.uid,
      attemptNumber:Number(P3.exam?.submission?.attemptNumber||1),
      type,
      details,
      at:serverTimestamp()
    });
  }catch(error){console.warn("Unable to write assessment security event:",error);}
}

function lockExamSecurity(reason,eventType="security_lock"){
  if(!P3.exam)return;
  core().closeModal?.();
  P3.exam.securityState.locked=true;
  P3.exam.securityState.lockReason=reason||"The secure assessment session is paused.";
  logEvent(eventType,{reason:P3.exam.securityState.lockReason,violationCount:P3.exam.securityState.violationCount});
  renderSecurityOverlay();
}

async function recordSecurityViolation(type,details={}){
  if(!P3.exam)return;
  const policy=examSecurityPolicy();
  const now=Date.now(),security=P3.exam.securityState;
  if(now-Number(security.lastViolationAt||0)<1000&&type!=="fullscreen_exit"){
    await logEvent(type,{...details,debounced:true,violationCount:security.violationCount});
    return;
  }
  security.lastViolationAt=now;
  security.violationCount=Number(security.violationCount||0)+1;
  const violationCount=security.violationCount;
  await logEvent(type,{...details,violationCount});
  security.persistPromise=(security.persistPromise||Promise.resolve()).then(async()=>{
    try{
      await updateDoc(doc(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid),{
        securityViolationCount:violationCount,
        updatedAt:serverTimestamp()
      });
    }catch(error){console.warn("Unable to persist security violation count:",error);}
  });
  await security.persistPromise;

  const policyMode=String(policy.focusPolicy||((policy.logFocusLoss===false)?"none":"log"));
  if(policyMode==="pause"){
    lockExamSecurity("The assessment was paused because the secure session lost focus. Return to the assessment and explicitly resume.","security_lock_focus");
  }else if(policyMode==="submit"&&security.violationCount>=Math.max(1,Number(policy.maxFocusViolations||3))){
    if(!security.autoSubmitting){
      security.autoSubmitting=true;
      await logEvent("security_auto_submit",{reason:type,violationCount:security.violationCount});
      setTimeout(()=>submitExam(true),0);
    }
  }
}

function renderSecurityOverlay(){
  const ex=P3.exam,root=$("#examRoot");if(!ex||!root)return;
  root.querySelector("#examSecurityLock")?.remove();
  if(!ex.securityState?.locked)return;
  const policy=examSecurityPolicy(),fullscreenRequired=policy.fullscreenRequired===true||policy.fullscreenExpectation===true;
  root.insertAdjacentHTML("beforeend",
    '<div id="examSecurityLock" class="exam-security-lock" role="dialog" aria-modal="true">'+
      '<div class="exam-security-lock-card"><div class="security-lock-mark">Θ</div><div class="eyebrow">Secure Session Paused</div>'+
      '<h2>Assessment interaction is locked.</h2><p>'+esc(ex.securityState.lockReason||"Restore the secure session to continue.")+'</p>'+
      '<div class="security-lock-status"><span>Violations recorded</span><strong>'+esc(ex.securityState.violationCount||0)+'</strong></div>'+
      '<button class="primary-btn" data-phase3-action="security-resume">'+(fullscreenRequired&&!document.fullscreenElement?"Re-enter Fullscreen & Continue":"Resume Secure Assessment")+'</button>'+
      '<small>The assessment timer continues while the secure session is locked.</small></div>'+
    '</div>'
  );
}

async function resumeSecureExam(){
  if(!P3.exam)return;
  const policy=examSecurityPolicy(),fullscreenRequired=policy.fullscreenRequired===true||policy.fullscreenExpectation===true;
  if(fullscreenRequired&&!document.fullscreenElement){
    try{await document.documentElement.requestFullscreen();}
    catch(error){return toast("Fullscreen is required. Allow fullscreen before continuing the assessment.");}
  }
  P3.exam.securityState.locked=false;
  P3.exam.securityState.lockReason="";
  await logEvent("security_resumed",{violationCount:P3.exam.securityState.violationCount});
  renderExam();
}

function visibilityEvent(){
  if(!P3.exam)return;
  const policy=examSecurityPolicy(),mode=String(policy.focusPolicy||((policy.logFocusLoss===false)?"none":"log"));
  if(document.visibilityState==="hidden"&&mode!=="none")recordSecurityViolation("visibility_hidden",{visibility:"hidden"});
  if(document.visibilityState==="visible"&&P3.exam?.securityState?.locked)renderSecurityOverlay();
}
function blurEvent(){
  if(!P3.exam)return;
  const policy=examSecurityPolicy(),mode=String(policy.focusPolicy||((policy.logFocusLoss===false)?"none":"log"));
  if(mode!=="none")recordSecurityViolation("window_blur",{});
}
function fullscreenEvent(){
  if(!P3.exam)return;
  const policy=examSecurityPolicy(),required=policy.fullscreenRequired===true||policy.fullscreenExpectation===true;
  if(required&&!document.fullscreenElement){
    recordSecurityViolation("fullscreen_exit",{}).finally(()=>{
      if(P3.exam&&!P3.exam.securityState.locked)lockExamSecurity("Fullscreen is required for this assessment. Re-enter fullscreen to restore the secure session.","security_lock_fullscreen");
      else if(P3.exam)renderSecurityOverlay();
    });
  }else{
    logEvent("fullscreen_change",{fullscreen:!!document.fullscreenElement});
  }
}
function copyEvent(e){
  if(!P3.exam)return;
  const p=examSecurityPolicy();
  if(p.blockCopy){e.preventDefault();logEvent("copy_blocked",{});toast("Copy is disabled for this assessment.");}
  else if(p.logCopy!==false)logEvent("copy_event",{});
}
function pasteEvent(e){
  if(!P3.exam)return;
  const p=examSecurityPolicy();
  if(p.blockPaste){e.preventDefault();logEvent("paste_blocked",{});toast("Paste is disabled for this assessment.");}
  else if(p.logCopy!==false)logEvent("paste_event",{});
}
function cutEvent(e){
  if(!P3.exam)return;
  const p=examSecurityPolicy();
  if(p.blockCut){e.preventDefault();logEvent("cut_blocked",{});toast("Cut is disabled for this assessment.");}
  else if(p.logCopy!==false)logEvent("cut_event",{});
}
function contextMenuEvent(e){
  if(!P3.exam)return;
  const p=examSecurityPolicy();
  if(p.blockContextMenu){e.preventDefault();logEvent("context_menu_blocked",{});}
}
function securityKeydownEvent(e){
  if(!P3.exam)return;
  const p=examSecurityPolicy(),key=String(e.key||"").toLowerCase(),mod=e.ctrlKey||e.metaKey;
  if(mod&&key==="c"&&p.blockCopy){e.preventDefault();logEvent("copy_shortcut_blocked",{});return;}
  if(mod&&key==="v"&&p.blockPaste){e.preventDefault();logEvent("paste_shortcut_blocked",{});return;}
  if(mod&&key==="x"&&p.blockCut){e.preventDefault();logEvent("cut_shortcut_blocked",{});return;}
  if(mod&&["p","s","k","u"].includes(key)){
    e.preventDefault();
    logEvent("browser_shortcut_blocked",{key});
    toast("That browser shortcut is disabled during the secure assessment.");
  }
}
function examNavigationGuard(e){
  if(!P3.exam)return;
  const target=e.target.closest?.("[data-page],[data-page-shortcut],.nav-item");
  if(!target)return;
  e.preventDefault();
  e.stopImmediatePropagation();
  toast("Submit the assessment before leaving the secure exam workspace.");
}
function unloadEvent(e){
  if(!P3.exam)return;
  e.preventDefault();
  e.returnValue="";
}

function bindRuntimeSecurity(){
  document.addEventListener("visibilitychange",visibilityEvent);
  document.addEventListener("fullscreenchange",fullscreenEvent);
  window.addEventListener("blur",blurEvent);
  document.addEventListener("copy",copyEvent,true);
  document.addEventListener("paste",pasteEvent,true);
  document.addEventListener("cut",cutEvent,true);
  document.addEventListener("contextmenu",contextMenuEvent,true);
  document.addEventListener("keydown",securityKeydownEvent,true);
  document.addEventListener("click",examNavigationGuard,true);
  window.addEventListener("beforeunload",unloadEvent);
}
function unbindRuntimeSecurity(){
  document.removeEventListener("visibilitychange",visibilityEvent);
  document.removeEventListener("fullscreenchange",fullscreenEvent);
  window.removeEventListener("blur",blurEvent);
  document.removeEventListener("copy",copyEvent,true);
  document.removeEventListener("paste",pasteEvent,true);
  document.removeEventListener("cut",cutEvent,true);
  document.removeEventListener("contextmenu",contextMenuEvent,true);
  document.removeEventListener("keydown",securityKeydownEvent,true);
  document.removeEventListener("click",examNavigationGuard,true);
  window.removeEventListener("beforeunload",unloadEvent);
}

function launchExam(assessment,questions,submission){
  clearInterval(P3.timer);
  unbindRuntimeSecurity();
  const localDraft=window.TheoriaPhase6?.loadExamDraft?.(assessment.id);
  const serverUpdated=submission.updatedAt?.toMillis?.()||0;
  const recoverLocal=!!(localDraft&&Number(localDraft.savedAt||0)>serverUpdated&&submission.status==="in_progress");
  P3.exam={
    assessment,questions,submission,
    index:recoverLocal?Number(localDraft.currentIndex||0):Number(submission.currentIndex||0),
    answers:recoverLocal?{...(localDraft.answers||{})}:{...(submission.answers||{})},
    marked:recoverLocal?[...(localDraft.marked||[])]:[...(submission.marked||[])],
    securityState:{
      violationCount:Number(submission.securityViolationCount||0),
      lastViolationAt:0,
      locked:false,
      lockReason:"",
      autoSubmitting:false,
      persistPromise:Promise.resolve()
    }
  };
  if(recoverLocal)setTimeout(()=>toast("Recovered a newer local assessment draft after an interrupted save."),80);
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
  bindRuntimeSecurity();

  const policy=assessment.securityPolicy||{},fullscreenRequired=policy.fullscreenRequired===true||policy.fullscreenExpectation===true;
  if(fullscreenRequired&&!document.fullscreenElement){
    lockExamSecurity("Fullscreen is required before assessment interaction can continue.","security_lock_fullscreen");
  }
}

function clock(sec){
  const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return (h?h+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}


function renderExam(){
  const ex=P3.exam;if(!ex)return;
  const a=ex.assessment,q=ex.questions[ex.index],answer=ex.answers[q.id],marked=ex.marked.includes(q.id);
  const nav=ex.questions.map((x,i)=>'<button class="exam-nav-item '+(i===ex.index?'active':'')+' '+(ex.answers[x.id]!==undefined&&String(ex.answers[x.id]).length?'answered':'')+' '+(ex.marked.includes(x.id)?'marked':'')+'" data-phase3-action="exam-jump" data-index="'+i+'" '+(a.backtracking===false&&i<ex.index?'disabled aria-disabled="true"':'')+'>'+(i+1)+'</button>').join("");
  let response="";
  if(q.type==="Multiple Choice")response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(answer===o.id?'selected':'')+'"><input type="radio" name="examAnswer" value="'+esc(o.id)+'" '+(answer===o.id?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';
  else if(q.type==="Multiple Select"){const arr=Array.isArray(answer)?answer:[];response='<div class="choice-list">'+(q.options||[]).map(o=>'<label class="choice-option '+(arr.includes(o.id)?'selected':'')+'"><input type="checkbox" name="examMulti" value="'+esc(o.id)+'" '+(arr.includes(o.id)?'checked':'')+'><span class="choice-label">'+esc(o.id)+'</span><span>'+esc(o.text)+'</span></label>').join("")+'</div>';}
  else response='<textarea id="examWritten" class="exam-response" placeholder="Enter your response here…">'+esc(answer||"")+'</textarea>';

  $("#examRoot").innerHTML='<div class="exam-shell '+(a.examMode?'dedicated-exam-mode':'')+'"><header class="exam-header"><div><div class="exam-brand">Θ THEORIA'+(a.examMode?' • EXAM MODE':'')+'</div><div class="exam-title">'+esc(a.title)+'</div></div><div class="exam-candidate">Candidate <strong>'+esc(ex.submission.candidateNumber)+'</strong></div><div id="examTimer" class="exam-timer">--:--</div></header>'+
    '<div class="exam-body"><aside class="exam-sidebar"><div class="exam-progress">Question '+(ex.index+1)+' of '+ex.questions.length+'</div><div class="exam-navigator">'+nav+'</div><div class="exam-legend"><span>● Answered</span><span>◆ Marked</span></div>'+(ex.submission.accommodationsApplied?.calculator?'<button class="secondary-btn small-btn full-btn" data-phase3-action="calculator">Calculator</button>':'')+'<button class="danger-btn full-btn" data-phase3-action="submit-exam">Submit Assessment</button></aside>'+
    '<main class="exam-question"><div class="exam-question-meta"><span>'+esc((a.parts||[]).find(p=>p.id===q.partId)?.title||"Assessment")+'</span><span>'+esc(q.points)+' points</span></div>'+(q.sourceTitle?'<div class="source-title">'+esc(q.sourceTitle)+'</div>':'')+(q.stimulus?'<div class="exam-stimulus">'+esc(q.stimulus).replace(/\n/g,"<br>")+'</div>':'')+'<h2>'+esc(q.prompt)+'</h2>'+response+
    '<div class="exam-controls"><button class="secondary-btn" data-phase3-action="mark-question">'+(marked?"Unmark":"Mark for Review")+'</button><div><button class="secondary-btn" data-phase3-action="exam-prev" '+(ex.index===0||a.backtracking===false?'disabled':'')+'>Previous</button><button class="primary-btn" data-phase3-action="'+(ex.index===ex.questions.length-1?"review-exam":"exam-next")+'">'+(ex.index===ex.questions.length-1?"Review & Submit":"Next")+'</button></div></div></main></div></div>';
  bindExamInputs();
  renderSecurityOverlay();
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
  window.TheoriaPhase6?.saveExamDraft?.(P3.exam.assessment.id,{
    answers:P3.exam.answers,marked:P3.exam.marked,currentIndex:P3.exam.index
  });
  try{
    await updateDoc(doc(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid),{answers:P3.exam.answers,marked:P3.exam.marked,currentIndex:P3.exam.index,updatedAt:serverTimestamp()});
  }catch(error){
    console.warn("Assessment server autosave failed; local recovery copy retained.",error);
  }
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
      (unanswered?'<div class="notice danger-notice" style="margin-top:14px">You still have '+unanswered+' unanswered question'+(unanswered===1?"":"s")+'. '+(ex.assessment.backtracking===false?'Backtracking is disabled, so earlier questions cannot be reopened.':'You may return to them before submitting.')+'</div>':'<div class="notice" style="margin-top:14px">All questions have a response recorded.</div>')+
      '<div class="review-question-grid">'+ex.questions.map((q,i)=>{const ans=ex.answers[q.id],done=Array.isArray(ans)?ans.length>0:String(ans??"").trim().length>0,blocked=ex.assessment.backtracking===false&&i<ex.index;return '<button type="button" class="review-question-chip '+(done?'answered':'unanswered')+' '+(ex.marked.includes(q.id)?'marked':'')+'" data-phase3-action="review-jump" data-index="'+i+'" '+(blocked?'disabled aria-disabled="true"':'')+'><span>Q'+(i+1)+'</span><strong>'+(done?"Answered":"Unanswered")+'</strong>'+(ex.marked.includes(q.id)?'<small>Marked</small>':'')+'</button>';}).join("")+'</div>',
    footer:'<button class="secondary-btn" data-close-modal>Return to Assessment</button><button class="danger-btn" data-phase3-action="confirm-submit-exam">Submit Assessment</button>'
  });
}

async function submitExam(auto=false){
  if(!P3.exam)return;
  if(!auto&&!confirm("Submit this assessment? You will not be able to change your responses afterward."))return;
  await saveExam();
  try{
    await updateDoc(doc(db,"assessments",P3.exam.assessment.id,"submissions",state().user.uid),{answers:P3.exam.answers,marked:P3.exam.marked,currentIndex:P3.exam.index,status:"submitted",submittedAt:serverTimestamp(),updatedAt:serverTimestamp()});
    if(P3.exam.assessment.entranceExam===true){
      await setDoc(doc(db,"users",state().user.uid,"entranceAttempts",P3.exam.assessment.sectionId),{status:"submitted",assessmentId:P3.exam.assessment.id,submittedAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
    }
    const id=P3.exam.assessment.id;
    window.TheoriaPhase6?.clearExamDraft?.(id);
    clearInterval(P3.timer);
    unbindRuntimeSecurity();
    if(document.fullscreenElement&&document.exitFullscreen)document.exitFullscreen().catch(()=>{});
    P3.exam=null;receipt(id,auto);
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
    const retakeResult=result&&Number(result.attemptNumber||1)>1?'<div class="retake-result-summary" style="margin-top:16px"><div><span>Retake '+esc(result.attemptNumber)+' Raw Score</span><strong>'+esc(result.attemptPercent??result.percent)+'%</strong></div><div><span>Official Grade</span><strong>'+esc(result.percent)+'%</strong></div><div><span>Policy</span><strong>'+esc(retakePolicyLabel(result.retakePolicy,result.retakeWeightPercent))+'</strong></div></div>':'';
    $("#examRoot").innerHTML='<div class="receipt-shell"><div class="receipt-mark">Θ</div><div class="eyebrow">'+(assessment.entranceExam?'Entrance Examination':Number(sub.attemptNumber||1)>1?'Assessment Retake Receipt':'Examination Receipt')+'</div><h1>'+esc(assessment.title||"Assessment")+'</h1><p>Your response has been recorded'+(auto?" automatically when time expired":"")+'.</p><div class="receipt-grid"><div><span>Candidate Number</span><strong>'+esc(sub.candidateNumber||"—")+'</strong></div><div><span>Status</span><strong>'+esc(sub.status||"submitted")+'</strong></div><div><span>Attempt</span><strong>'+esc(sub.attemptNumber||1)+'</strong></div><div><span>Result</span><strong>'+(result?esc(result.percent)+"%":"Awaiting evaluation")+'</strong></div></div>'+retakeResult+domains+entranceResult+(result?.overallComment?'<div class="academic-banner"><div class="kicker">Instructor Comment</div><p>'+esc(result.overallComment)+'</p></div>':'')+'<button class="primary-btn" data-phase3-action="'+(assessment.entranceExam?'entrance-return':'back-assessments')+'">'+(assessment.entranceExam?'Return to Enrollment':'Return to Assessments')+'</button></div>';
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
    batch.delete(doc(db,"assessments",a.id,"attemptCounters",studentId));
    batch.set(doc(db,"sections",a.sectionId,"entranceCandidates",studentId),{
      status:"pending",
      assessmentId:a.id,
      percent:null,
      score:null,
      maxScore:null,
      updatedAt:serverTimestamp()
    },{merge:true});
    batch.set(doc(db,"users",studentId,"entranceAttempts",a.sectionId),{
      sectionId:a.sectionId,courseId:a.courseId,courseCode:a.courseCode||"",courseTitle:a.courseTitle||"",
      sectionName:a.sectionName||"",assessmentId:a.id,assessmentTitle:a.title||"Entrance Examination",
      status:"pending",percent:null,score:null,maxScore:null,passPercent:Number(a.entrancePassPercent||70),updatedAt:serverTimestamp()
    },{merge:true});
    await batch.commit();
    if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(a.sectionId,"entrance_attempt_reset","student",studentId,{assessmentId:a.id});
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
  const d=P3.detail,a=d.assessment,m=metrics(a,d,grading,sub),releasePolicy=a.releasePolicy||{},released=m.complete?(releasePolicy.releaseMode==="manual"?(existing?.released||false):true):(existing?.released||false);
  let retakeAuthorization=null;
  if(!a.entranceExam&&Number(sub.attemptNumber||1)>1){
    try{
      const snap=await getDoc(doc(db,"assessments",a.id,"retakes",sub.studentId));
      if(snap.exists()&&Number(snap.data().authorizedAttemptNumber||0)===Number(sub.attemptNumber||0)){
        retakeAuthorization={id:snap.id,...snap.data()};
      }
    }catch(error){console.warn("Unable to load retake scoring policy:",error);}
  }

  const officialPercent=m.complete&&retakeAuthorization?retakeOfficialPercent(m.percent,retakeAuthorization):m.percent;
  const officialScore=m.max?Math.round((m.max*officialPercent/100)*100)/100:m.total;
  const candidateQuestions=questionsForSubmission(d,sub),unitMap=new Map(),topicMap=new Map(),compMap=new Map(),keyMap=new Map((d.keys||[]).map(k=>[k.id,k]));
  const addDomain=(map,key,label,score,max)=>{if(!key)return;const row=map.get(key)||{key,label,earned:0,max:0,evidence:0};row.earned+=Number(score||0);row.max+=Number(max||0);row.evidence++;map.set(key,row);};
  candidateQuestions.forEach(q=>{
    const score=grading[q.id]?.score;if(score===undefined||score===null)return;
    const max=Number(q.points||0);
    addDomain(unitMap,q.unitId||q.unitTitle||"unmapped",q.unitTitle||"Unmapped / No Unit",score,max);
    addDomain(topicMap,q.topicId||q.topicNumber||q.topicTitle||"unmapped",(q.topicNumber?q.topicNumber+" — ":"")+(q.topicTitle||"Unmapped / No Topic"),score,max);
    (q.competencyCodes||[]).forEach(code=>addDomain(compMap,code,code,score,max));
  });
  const domainRows=map=>[...map.values()].map(row=>({...row,percent:row.max?Math.round(row.earned/row.max*1000)/10:null}));
  const contentSkills={units:domainRows(unitMap),topics:domainRows(topicMap),competencies:domainRows(compMap)};
  const releasedFeedback={};
  if(releasePolicy.showExplanations||releasePolicy.showCorrectAnswers){
    candidateQuestions.forEach(q=>{
      const key=keyMap.get(q.id)||{};
      releasedFeedback[q.id]={
        explanation:releasePolicy.showExplanations?String(key.explanation||""):"",
        correctAnswer:releasePolicy.showCorrectAnswers?(Array.isArray(key.correctAnswer)?key.correctAnswer:String(key.correctAnswer??"")):""
      };
    });
  }
  const peerPercents=(d.results||[]).filter(r=>r.studentId!==sub.studentId&&r.complete===true).map(r=>Number(r.percent)).filter(Number.isFinite);
  const classAverage=m.complete?Math.round([...peerPercents,officialPercent].reduce((n,x)=>n+x,0)/Math.max(1,peerPercents.length+1)*10)/10:null;
  const batch=writeBatch(db);

  batch.set(doc(db,"assessments",a.id,"results",sub.studentId),{
    studentId:sub.studentId,
    candidateNumber:sub.candidateNumber,
    totalScore:officialScore,
    maxScore:m.max,
    percent:officialPercent,
    officialPercent,
    attemptScore:m.total,
    attemptMaxScore:m.max,
    attemptPercent:m.percent,
    attemptNumber:Number(sub.attemptNumber||1),
    retakePolicy:retakeAuthorization?.scorePolicy||"",
    retakeWeightPercent:retakeAuthorization?.retakeWeightPercent??null,
    grading,partScores:m.partScores,released,complete:m.complete,overallComment,
    contentSkills,releasedFeedback,classAverage,
    gradedAt:serverTimestamp(),gradedBy:state().user.uid
  },{merge:true});

  if(m.complete){
    (d.results||[]).filter(r=>r.studentId!==sub.studentId&&r.complete===true).forEach(r=>{
      batch.set(doc(db,"assessments",a.id,"results",r.studentId),{classAverage,updatedAt:serverTimestamp()},{merge:true});
    });
    batch.update(doc(db,"assessments",a.id,"submissions",sub.studentId),{status:"graded",updatedAt:serverTimestamp()});
    if(a.entranceExam===true){
      const passPercent=Number(a.entrancePassPercent||70);
      batch.set(doc(db,"sections",a.sectionId,"entranceCandidates",sub.studentId),{
        status:m.percent>=passPercent?"passed":"failed",
        score:m.total,maxScore:m.max,percent:m.percent,passPercent,assessmentId:a.id,
        gradedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
      batch.set(doc(db,"users",sub.studentId,"entranceAttempts",a.sectionId),{
        sectionId:a.sectionId,courseId:a.courseId,courseCode:a.courseCode||"",courseTitle:a.courseTitle||"",
        sectionName:a.sectionName||"",assessmentId:a.id,assessmentTitle:a.title||"Entrance Examination",
        status:m.percent>=passPercent?"passed":"failed",score:m.total,maxScore:m.max,percent:m.percent,passPercent,
        gradedAt:serverTimestamp(),updatedAt:serverTimestamp()
      },{merge:true});
    }else{
      batch.set(doc(db,"sections",a.sectionId,"assessmentGrades",a.id+"_"+sub.studentId),{
        assessmentId:a.id,assessmentTitle:a.title,assessmentType:a.type,studentId:sub.studentId,
        score:officialScore,maxScore:m.max,percent:officialPercent,
        attemptScore:m.total,attemptPercent:m.percent,attemptNumber:Number(sub.attemptNumber||1),
        retakePolicy:retakeAuthorization?.scorePolicy||"",retakeWeightPercent:retakeAuthorization?.retakeWeightPercent??null,
        retakePending:false,partScores:m.partScores,released,updatedAt:serverTimestamp()
      },{merge:true});
      if(retakeAuthorization){
        batch.set(doc(db,"assessments",a.id,"retakes",sub.studentId),{
          active:false,completedAt:serverTimestamp(),
          lastAttemptPercent:m.percent,lastOfficialPercent:officialPercent,
          completedAttemptNumber:Number(sub.attemptNumber||1),
          updatedAt:serverTimestamp()
        },{merge:true});
      }
    }
  }

  await batch.commit();
  if(a.sectionId&&window.TheoriaPhase5?.logSectionEvent){
    await window.TheoriaPhase5.logSectionEvent(a.sectionId,"assessment_result_updated","student",sub.studentId,{
      assessmentId:a.id,assessmentTitle:a.title||"",attemptNumber:Number(sub.attemptNumber||1),
      attemptPercent:m.percent,officialPercent,retakePolicy:retakeAuthorization?.scorePolicy||"",
      complete:m.complete,entranceExam:a.entranceExam===true
    });
  }
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
  if(a==="basket-toggle"){
    if(toggleItemBasket(b.dataset.course,b.dataset.id))return renderItemBank();
    return;
  }
  if(a==="basket-clear"){P3.itemBasket=[];saveItemBasket();return renderItemBank();}
  if(a==="basket-create"){
    const basket=loadItemBasket();if(!basket.length)return toast("Add questions to the basket first.");
    const courseId=basket[0].courseId,questionIds=basket.map(x=>x.itemId);
    return assessmentModal(null,{courseId,questionIds,title:"Custom Assessment",fromBasket:true});
  }
  if(a==="batch-assign-course")return chooseSectionForCourseBatch(b.dataset.course);
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
  if(a==="item-history")return itemHistoryModal(b.dataset.course,b.dataset.id);
  if(a==="retire-bank-question")return setQuestionQuality(b.dataset.course,b.dataset.id,"Retired");
  if(a==="restore-bank-question")return setQuestionQuality(b.dataset.course,b.dataset.id,"Published");
  if(a==="edit-item")return itemModal(P3.items.find(x=>x.id===b.dataset.id&&x.courseId===b.dataset.course));
  if(a==="open-assessment")return openAssessment(b.dataset.id);
  if(a==="back-assessments"){clearInterval(P3.timer);P3.exam=null;core().setPage("assessments");return renderAssessments();}
  if(a==="assessment-tab")return renderAssessment(b.dataset.tab);
  if(a==="edit-assessment")return assessmentModal(P3.current);
  if(a==="add-items")return addItemsModal();
  if(a==="configure-random-draw")return configureRandomDrawModal();
  if(a==="refresh-item-version")return refreshAssessmentQuestionFromBank(b.dataset.id);
  if(a==="configure-item")return configureItemModal(b.dataset.id);
  if(a==="remove-item")return removeItem(b.dataset.id);
  if(a==="publish")return setStatus("Published");
  if(a==="close")return setStatus("Closed");
  if(a==="reopen")return setStatus("Published");
  if(a==="student-assessment-details")return studentAssessmentDetails(b.dataset.id);
  if(a==="student-assessment-results")return studentAssessmentResults(b.dataset.id);
  if(a==="result-reflection")return resultReflectionModal(b.dataset.id);
  if(a==="start-exam")return startExam(b.dataset.id);
  if(a==="receipt")return receipt(b.dataset.id);
  if(a==="save-pathway")return savePathway();
  if(a==="toggle-grading-period")return toggleGradingPeriodLock(b.dataset.period);
  if(a==="accommodations")return accommodationsModal(b.dataset.student);
  if(a==="create-evaluation")return createEvaluation(b.dataset.student);
  if(a==="grade-candidate")return gradeCandidate(b.dataset.student);
  if(a==="authorize-retake")return authorizeRetakeModal(b.dataset.student);
  if(a==="revoke-retake")return revokeRetake(b.dataset.student);
  if(a==="attempt-history")return attemptHistoryModal(b.dataset.student);
  if(a==="reset-entrance-attempt")return resetEntranceAttempt(b.dataset.student);
  if(a==="toggle-release")return toggleRelease(b.dataset.student);
  if(a==="view-reflection")return instructorReflectionModal(b.dataset.student);
  if(a==="auto-score")return autoScore();
  if(a==="horizontal-grade")return horizontalGrade(b.dataset.question);
  if(a==="exam-jump"){if(P3.exam&&(P3.exam.assessment.backtracking!==false||Number(b.dataset.index)>P3.exam.index)){P3.exam.index=Number(b.dataset.index);scheduleSave();renderExam();}return;}
  if(a==="exam-prev"){if(P3.exam&&P3.exam.index>0&&P3.exam.assessment.backtracking!==false){P3.exam.index--;scheduleSave();renderExam();}return;}
  if(a==="review-exam"){reviewExam();return;}
  if(a==="review-jump"){
    if(P3.exam){
      const target=Number(b.dataset.index);
      if(P3.exam.assessment.backtracking===false&&target<P3.exam.index)return toast("Backtracking is disabled for this assessment.");
      P3.exam.index=target;core().closeModal();scheduleSave();renderExam();
    }
    return;
  }
  if(a==="security-resume")return resumeSecureExam();
  if(a==="confirm-submit-exam"){core().closeModal();submitExam(false);return;}
  if(a==="exam-next"){if(!P3.exam)return;P3.exam.index=Math.min(P3.exam.index+1,P3.exam.questions.length-1);scheduleSave();renderExam();return;}
  if(a==="mark-question"){if(!P3.exam)return;const id=P3.exam.questions[P3.exam.index].id;P3.exam.marked=P3.exam.marked.includes(id)?P3.exam.marked.filter(x=>x!==id):[...P3.exam.marked,id];scheduleSave();renderExam();return;}
  if(a==="submit-exam")return reviewExam();
  if(a==="calculator")return calculator();
});

window.TheoriaPhase3={renderSectionTab,renderAssessments,renderItemBank,openAssessment,configureEntranceExam,startEntranceExam:(id)=>startExam(id),getCurrent:()=>P3.current,getDetail:()=>P3.detail,getExam:()=>P3.exam,getItems:()=>P3.items,getAssessments:()=>P3.assessments};

if(window.TheoriaCore)onReady();
