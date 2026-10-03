import {
  db, doc, getDoc, setDoc, updateDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp, Timestamp
} from "../firebase.js";

const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();

function safe(v){return Array.isArray(v)?v:[];}
function nowDate(){const d=new Date();d.setHours(0,0,0,0);return d;}
function dateInput(d){const z=n=>String(n).padStart(2,"0");return d.getFullYear()+"-"+z(d.getMonth()+1)+"-"+z(d.getDate());}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}
function typeLabel(kind){
  return {
    "topic-practice":"Topic Practice",
    "progress-check":"Progress Check",
    "unit-assessment":"Unit Assessment",
    "practice-exam":"Practice Examination",
    "recommended-practice":"Recommended Practice"
  }[kind]||"Assessment";
}
function kindDefaults(kind){
  return {
    "topic-practice":{count:8,duration:15,counts:false,formative:true},
    "progress-check":{count:20,duration:30,counts:false,formative:true},
    "unit-assessment":{count:30,duration:50,counts:true,formative:false},
    "practice-exam":{count:50,duration:90,counts:false,formative:true},
    "recommended-practice":{count:12,duration:20,counts:false,formative:true}
  }[kind]||{count:20,duration:45,counts:true,formative:false};
}

async function courseFramework(courseId){
  const unitsSnap=await getDocs(collection(db,"courses",courseId,"units"));
  const units=unitsSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  for(const unit of units){
    const topicsSnap=await getDocs(collection(db,"courses",courseId,"units",unit.id,"topics"));
    unit.topics=topicsSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>Number(a.order||99)-Number(b.order||99));
  }
  return units;
}
async function courseBank(courseId){
  const snap=await getDocs(collection(db,"courses",courseId,"items"));
  return snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>!["Draft","Retired"].includes(x.qualityStatus||"Published"));
}
function competencyBlueprint(items){
  const byCode=new Map(),total=items.reduce((n,x)=>n+Number(x.pointsDefault||1),0);
  items.forEach(item=>{
    const codes=safe(item.competencyCodes);
    if(!codes.length)return;
    const share=Number(item.pointsDefault||1)/codes.length;
    codes.forEach(code=>byCode.set(code,(byCode.get(code)||0)+share));
  });
  return [...byCode.entries()].map(([code,pts])=>({id:code,label:code,weight:total?Math.round(pts/total*1000)/10:0}));
}
function filterFrameworkItems(items,unit,topic){
  return items.filter(item=>{
    if(topic){
      return item.topicId===topic.id
        ||String(item.topicNumber||"")===String(topic.number||"")
        ||String(item.topicTitle||"").trim().toLowerCase()===String(topic.title||"").trim().toLowerCase();
    }
    if(unit){
      return item.unitId===unit.id
        ||Number(item.unitNumber||0)===Number(unit.order||0)
        ||String(item.unitTitle||"").trim().toLowerCase()===String(unit.title||"").trim().toLowerCase();
    }
    return true;
  }).sort((a,b)=>
    String(a.topicNumber||"").localeCompare(String(b.topicNumber||""),undefined,{numeric:true})
    ||String(a.type||"").localeCompare(String(b.type||""))
    ||String(a.prompt||"").localeCompare(String(b.prompt||""))
  );
}

async function createAssessmentFromItems({section,kind,title,items,unit=null,topic=null,durationMinutes=30,publish=true,countsTowardComposite=false,formative=true,sourceAssessmentId="",releasePolicy=null}){
  const s=state();if(!s?.user||!section||!items.length)throw new Error("Assessment creation context is incomplete.");
  const ref=doc(collection(db,"assessments"));
  const questionRefs=items.map(()=>doc(collection(db,"assessments",ref.id,"questions")));
  const questionIds=questionRefs.map(r=>r.id);
  const questionPool=items.map((item,index)=>({id:questionRefs[index].id,itemId:item.id,type:item.type,points:Number(item.pointsDefault||1)}));
  const totalPoints=items.reduce((n,item)=>n+Number(item.pointsDefault||1),0);
  const type=typeLabel(kind);
  const release=releasePolicy||{
    showOverallScore:true,showQuestionScores:true,showCorrectAnswers:false,showExplanations:false,
    showCompetencies:true,showClassAverage:false,releaseMode:"when-graded"
  };
  const assessment={
    ownerId:s.user.uid,
    courseId:section.courseId,courseCode:section.courseCode||"",courseTitle:section.courseTitle||"",
    sectionId:section.id,sectionName:section.sectionName||"",
    title,type,mode:"written",status:publish?"Published":"Draft",
    durationMinutes:Number(durationMinutes||0),opensAt:null,closesAt:null,
    instructions:formative?"Use this assessment to identify strengths and areas for additional practice.":"Complete all items according to the course assessment policy.",
    instructionSteps:[],
    anonymousGrading:false,backtracking:true,randomizeQuestions:false,
    randomDrawEnabled:false,randomDrawPlan:[],
    feedbackPolicy:"automatic",
    releasePolicy:release,
    correctionPolicy:{enabled:formative,instructions:formative?"Review missed items and use the recommended-practice tools to strengthen weak topics.":""},
    catalogKind:kind,officialMaterial:true,formative:!!formative,countsTowardComposite:!!countsTowardComposite,
    sourceAssessmentId:sourceAssessmentId||"",
    frameworkUnitId:unit?.id||"",frameworkUnitNumber:Number(unit?.order||0),frameworkUnitTitle:unit?.title||"",
    frameworkTopicId:topic?.id||"",frameworkTopicNumber:topic?.number||"",frameworkTopicTitle:topic?.title||"",
    contentBlueprint:unit?[{id:unit.id,label:"Unit "+(unit.order||"")+" — "+(unit.title||"Unit"),weight:100}]:[],
    competencyBlueprint:competencyBlueprint(items),competencyBlueprintAuto:true,
    competencyBlueprintMappedPoints:totalPoints,competencyBlueprintUnmappedPoints:0,
    parts:[{id:"main",title:type,weight:100}],
    questionIds,questionPool,poolQuestionCount:items.length,questionCount:items.length,totalPoints,
    createdAt:serverTimestamp(),updatedAt:serverTimestamp()
  };
  await setDoc(ref,assessment);

  for(let offset=0;offset<items.length;offset+=180){
    const batch=writeBatch(db);
    items.slice(offset,offset+180).forEach((item,index)=>{
      const qref=questionRefs[offset+index],order=offset+index+1;
      batch.set(qref,{
        itemId:item.id,itemVersion:Number(item.version||1),order,partId:"main",type:item.type,prompt:item.prompt||"",
        stimulus:item.stimulus||"",sourceTitle:item.sourceTitle||"",options:item.options||[],points:Number(item.pointsDefault||1),
        difficulty:item.difficulty||"Moderate",cognitiveLevel:item.cognitiveLevel||"Application",tags:item.tags||[],
        qualityStatus:item.qualityStatus||"Published",
        unitId:item.unitId||unit?.id||"",unitTitle:item.unitTitle||unit?.title||"",unitNumber:Number(item.unitNumber||unit?.order||0),
        topicId:item.topicId||topic?.id||"",topicTitle:item.topicTitle||topic?.title||"",topicNumber:item.topicNumber||topic?.number||"",
        competencyIds:item.competencyIds||[],competencyCodes:item.competencyCodes||[],
        createdAt:serverTimestamp()
      });
      batch.set(doc(db,"assessments",ref.id,"keys",qref.id),{
        itemId:item.id,itemVersion:Number(item.version||1),correctAnswer:item.correctAnswer??"",
        explanation:item.explanation||"",rubric:item.rubric||[],createdAt:serverTimestamp()
      });
    });
    await batch.commit();
  }

  if(publish){
    await setDoc(doc(db,"sections",section.id,"assessmentRefs",ref.id),{
      assessmentId:ref.id,title,type,assessmentType:type,totalPoints,status:"Published",
      opensAt:null,closesAt:null,durationMinutes:Number(durationMinutes||0),
      catalogKind:kind,officialMaterial:true,formative:!!formative,countsTowardComposite:!!countsTowardComposite,
      frameworkUnitId:unit?.id||"",frameworkUnitNumber:Number(unit?.order||0),frameworkUnitTitle:unit?.title||"",
      frameworkTopicId:topic?.id||"",frameworkTopicNumber:topic?.number||"",frameworkTopicTitle:topic?.title||"",
      updatedAt:serverTimestamp()
    },{merge:true});
  }
  if(window.TheoriaPhase5?.logSectionEvent){
    await window.TheoriaPhase5.logSectionEvent(section.id,"official_assessment_created","assessment",ref.id,{
      title,type,catalogKind:kind,questionCount:items.length,countsTowardComposite:!!countsTowardComposite,
      unitId:unit?.id||"",topicId:topic?.id||"",sourceAssessmentId:sourceAssessmentId||""
    });
  }
  return {id:ref.id,...assessment};
}

async function frameworkAssessmentModal(kind,unitId="",topicId=""){
  const s=state(),section=s?.currentSection;if(!s||s.role!=="instructor"||!section)return;
  const units=await courseFramework(section.courseId);
  const unit=units.find(u=>u.id===unitId)||null;
  const topic=unit?.topics?.find(t=>t.id===topicId)||null;
  const all=await courseBank(section.courseId),matches=filterFrameworkItems(all,unit,topic);
  if(!matches.length)return toast("No published Question Bank items are mapped to this "+(topic?"topic":unit?"unit":"course")+" yet.");
  const d=kindDefaults(kind),max=matches.length,initial=Math.min(d.count,max);
  const titleBase=kind==="topic-practice"
    ? "Topic "+(topic?.number||"")+" Practice — "+(topic?.title||"Topic")
    : kind==="progress-check"
      ? "Unit "+(unit?.order||"")+" Progress Check — "+(unit?.title||"Unit")
      : kind==="unit-assessment"
        ? "Unit "+(unit?.order||"")+" Assessment — "+(unit?.title||"Unit")
        : "Comprehensive Practice Examination";

  const m=modal({
    eyebrow:"Official Course Material",
    title:typeLabel(kind),
    wide:true,
    body:'<form id="frameworkAssessmentForm" class="academic-form">'+
      '<div class="academic-banner"><div class="kicker">'+esc(section.courseCode||"Course")+' • '+esc(typeLabel(kind))+'</div><h3>'+esc(titleBase)+'</h3><p>'+max+' published Question Bank item'+(max===1?" is":"s are")+' available for this scope. Theoria will create an independent, secure section assessment from the official bank.</p></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Assessment Scope</h3><p>Choose how much material to include.</p></div></div>'+
        '<div class="compact-field-grid"><div class="field"><label>Title</label><input name="title" value="'+esc(titleBase)+'" required></div><div class="field"><label>Questions</label><input name="count" type="number" min="1" max="'+max+'" value="'+initial+'"></div><div class="field"><label>Duration</label><div class="input-with-suffix"><input name="duration" type="number" min="0" value="'+d.duration+'"><span>min</span></div></div></div>'+
        '<div class="framework-scope-preview"><strong>'+esc(topic?("Topic "+topic.number+" — "+topic.title):unit?("Unit "+unit.order+" — "+unit.title):"Entire Course")+'</strong><span>'+max+' bank items available</span></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Academic Treatment</h3><p>Formative materials can produce mastery evidence without changing the Composite final grade.</p></div></div>'+
        '<div class="policy-card-grid"><label class="policy-card"><input type="checkbox" name="counts" '+(d.counts?'checked':'')+'><div><strong>Count in Composite Grade</strong><span>Include this assessment in the General Assessments component.</span></div></label><label class="policy-card"><input type="checkbox" name="publish" checked><div><strong>Publish Immediately</strong><span>Students can see the assessment as soon as its window permits.</span></div></label><label class="policy-card"><input type="checkbox" name="shuffle" '+(kind==="practice-exam"?'checked':'')+'><div><strong>Shuffle Selected Questions</strong><span>Randomize the generated question snapshot before assignment.</span></div></label></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>03</span><h3>Student Results</h3><p>Control what becomes visible after grading.</p></div></div>'+
        '<div class="policy-card-grid"><label class="policy-card"><input type="checkbox" name="showQuestionScores" checked><div><strong>Question Scores</strong><span>Show point-level performance.</span></div></label><label class="policy-card"><input type="checkbox" name="showExplanations" '+(d.formative?'checked':'')+'><div><strong>Explanations</strong><span>Show Question Bank explanations after grading.</span></div></label><label class="policy-card"><input type="checkbox" name="showCompetencies" checked><div><strong>Content & Skills</strong><span>Show competency/topic performance.</span></div></label></div>'+
      '</section>'+
      '<div class="modal-foot form-sticky-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Create '+esc(typeLabel(kind))+'</button></div></form>'
  });
  m.querySelector("#frameworkAssessmentForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const count=Math.max(1,Math.min(max,Math.floor(Number(fd.get("count")||initial))));
    let selected=matches.slice(0,count);
    if(e.currentTarget.elements.shuffle.checked)selected=[...selected].sort(()=>Math.random()-.5);
    const button=e.currentTarget.querySelector('button[type="submit"]');button.disabled=true;button.textContent="Creating…";
    try{
      const created=await createAssessmentFromItems({
        section,kind,title:String(fd.get("title")||titleBase).trim(),items:selected,unit,topic,
        durationMinutes:Number(fd.get("duration")||d.duration),publish:e.currentTarget.elements.publish.checked,
        countsTowardComposite:e.currentTarget.elements.counts.checked,formative:!e.currentTarget.elements.counts.checked,
        releasePolicy:{
          showOverallScore:true,
          showQuestionScores:e.currentTarget.elements.showQuestionScores.checked,
          showCorrectAnswers:false,
          showExplanations:e.currentTarget.elements.showExplanations.checked,
          showCompetencies:e.currentTarget.elements.showCompetencies.checked,
          showClassAverage:false,releaseMode:"when-graded"
        }
      });
      closeModal();
      await core().reloadCurrentSection?.("framework");
      toast(typeLabel(kind)+" created from "+selected.length+" official Question Bank item"+(selected.length===1?"":"s")+".");
      if(created?.id&&confirm("Open the new "+typeLabel(kind)+" now?"))window.TheoriaPhase3?.openAssessment?.(created.id);
    }catch(error){
      button.disabled=false;button.textContent="Create "+typeLabel(kind);
      toast(error.message||"Unable to create the assessment.");
    }
  };
}

function assignedFor(refs,kind,unitId="",topicId=""){
  return refs.filter(ref=>
    ref.catalogKind===kind
    &&(!unitId||ref.frameworkUnitId===unitId)
    &&(!topicId||ref.frameworkTopicId===topicId)
  );
}

function enhanceCourseGuide(){
  const s=state(),section=s?.currentSection,data=s?.sectionData;
  if(!section||!data||!document.querySelector("#page-section-detail.active"))return;
  const active=document.querySelector('#sectionDetail .tab-btn.active[data-tab="framework"]');
  if(!active)return;
  const root=document.querySelector("#sectionTabBody");if(!root||root.querySelector(".classroom-flow-banner"))return;
  const units=data.framework?.units||[],refs=data.assessmentRefs||[];
  const instructor=s.role==="instructor";
  const pacing=section.pacingPlan?.units||[];
  const today=nowDate();
  const currentPacing=pacing.find(row=>{
    const start=row.startDate?new Date(row.startDate+"T00:00:00"):null,end=row.endDate?new Date(row.endDate+"T23:59:59"):null;
    return start&&end&&today>=start&&today<=end;
  });
  const currentUnit=units.find(u=>u.id===currentPacing?.unitId)||units[0]||null;

  root.insertAdjacentHTML("afterbegin",
    '<div class="academic-banner classroom-flow-banner"><div class="kicker">Course Guide • Learning Flow</div><h3>'+(currentUnit?'Current focus: Unit '+esc(currentUnit.order||"")+' — '+esc(currentUnit.title||""):'Course framework')+'</h3><p>Move from topic instruction to formative practice, unit progress checks, summative assessment, and content/skills review without leaving the course guide.</p>'+
    (instructor?'<div class="card-actions"><button class="secondary-btn small-btn" data-classroom-action="pacing">Pacing</button><button class="secondary-btn small-btn" data-classroom-action="create-practice-exam">Create Practice Exam</button></div>':'')+
    '</div>'
  );

  [...root.querySelectorAll(".unit-card")].forEach((card,index)=>{
    const unit=units[index];if(!unit)return;
    const unitRefs=refs.filter(r=>r.frameworkUnitId===unit.id);
    const progress=assignedFor(refs,"progress-check",unit.id);
    const summative=assignedFor(refs,"unit-assessment",unit.id);
    const unitAssignments=(data.assignments||[]).filter(a=>a.unitId===unit.id&&a.status!=="Draft");
    const unitResources=(data.resources||[]).filter(r=>r.unitId===unit.id);
    const unitPractice=assignedFor(refs,"topic-practice",unit.id);
    const pacingRow=pacing.find(row=>row.unitId===unit.id);
    const pacingText=pacingRow?((pacingRow.startDate||"")+" → "+(pacingRow.endDate||"")):"No pacing dates";
    const head=card.querySelector(".unit-head");
    if(head){
      head.insertAdjacentHTML("beforeend",
        '<div class="course-flow-tools"><div class="course-flow-status"><span>'+unitAssignments.length+' coursework</span><span>'+unitResources.length+' resources</span><span>'+unitPractice.length+' topic practice</span><span>'+esc(pacingText)+'</span>'+(progress.length?'<b>Progress Check assigned</b>':'')+(summative.length?'<b>Unit Assessment assigned</b>':'')+'</div>'+
        (instructor?'<div class="inline-actions"><button class="secondary-btn small-btn" data-classroom-action="create-progress-check" data-unit="'+unit.id+'">Progress Check</button><button class="primary-btn small-btn" data-classroom-action="create-unit-assessment" data-unit="'+unit.id+'">Unit Assessment</button></div>':'')+
        '</div>'
      );
    }
    card.insertAdjacentHTML("beforeend",'<div class="unit-at-glance"><div><span>Topics</span><strong>'+safe(unit.topics).length+'</strong></div><div><span>Coursework</span><strong>'+unitAssignments.length+'</strong></div><div><span>Resources</span><strong>'+unitResources.length+'</strong></div><div><span>Practice</span><strong>'+unitPractice.length+'</strong></div><div><span>Progress Check</span><strong>'+(progress.length?"Ready":"—")+'</strong></div><div><span>Unit Assessment</span><strong>'+(summative.length?"Ready":"—")+'</strong></div></div>');
    [...card.querySelectorAll(".topic-row")].forEach((row,tIndex)=>{
      const topic=safe(unit.topics)[tIndex];if(!topic)return;
      const topicRefs=assignedFor(refs,"topic-practice",unit.id,topic.id);
      const videos=(data.resources||[]).filter(r=>r.topicId===topic.id&&String(r.type||"").toLowerCase().includes("video"));
      const copy=row.children[1];
      if(copy){
        copy.insertAdjacentHTML("beforeend",
          '<div class="topic-learning-tools">'+
          (topicRefs.length?topicRefs.map(ref=>'<button class="text-btn" data-phase3-action="open-assessment" data-id="'+ref.id+'">'+(instructor?"Open":"Topic Practice")+'</button>').join(""):'')+
          (videos.length?videos.map(v=>'<a class="text-btn" href="'+esc(v.url||"#")+'" target="_blank" rel="noopener">Topic Video</a>').join(""):'')+
          (instructor?'<button class="text-btn" data-classroom-action="create-topic-practice" data-unit="'+unit.id+'" data-topic="'+topic.id+'">+ Topic Practice</button>':'')+
          '</div>'
        );
      }
    });
  });
}

function enhanceOverview(){
  const s=state(),section=s?.currentSection,data=s?.sectionData;
  if(!section||!data||!document.querySelector("#page-section-detail.active"))return;
  const active=document.querySelector('#sectionDetail .tab-btn.active[data-tab="overview"]');if(!active)return;
  const body=document.querySelector("#sectionTabBody");if(!body||body.querySelector(".student-course-now"))return;
  const units=data.framework?.units||[],assignments=(data.assignments||[]).filter(a=>a.status!=="Draft"),refs=(data.assessmentRefs||[]).filter(a=>a.status!=="Draft");
  const pacing=section.pacingPlan?.units||[],today=nowDate();
  let current=units[0]||null;
  const row=pacing.find(x=>{const a=x.startDate?new Date(x.startDate+"T00:00:00"):null,b=x.endDate?new Date(x.endDate+"T23:59:59"):null;return a&&b&&today>=a&&today<=b;});
  if(row)current=units.find(u=>u.id===row.unitId)||current;
  const unitAssignments=current?assignments.filter(a=>a.unitId===current.id):[];
  const unitAssessments=current?refs.filter(a=>a.frameworkUnitId===current.id):[];
  body.insertAdjacentHTML("afterbegin",
    '<section class="student-course-now"><div class="panel-head"><div><div class="panel-title">Course Now</div><div class="panel-subtitle">Your current unit, practice, and assessment flow.</div></div></div><div class="course-now-grid">'+
    '<div><span>Current Unit</span><strong>'+(current?("Unit "+esc(current.order||"")+" — "+esc(current.title||"")):"Course opening")+'</strong></div>'+
    '<div><span>Coursework</span><strong>'+unitAssignments.length+'</strong><small>in current unit</small></div>'+
    '<div><span>Assessments</span><strong>'+unitAssessments.length+'</strong><small>in current unit</small></div>'+
    '<div><span>Course Guide</span><button class="text-btn" data-action="section-tab" data-tab="framework">Continue Learning →</button></div>'+
    '</div></section>'
  );
}

async function pacingModal(){
  const s=state(),section=s?.currentSection,data=s?.sectionData;if(!section||s.role!=="instructor")return;
  if(section.ownerId!==s.user.uid)return toast("Only the section owner can change the pacing calendar.");
  const units=data.framework?.units||[];if(!units.length)return toast("Build the course framework before generating pacing.");
  const start=new Date((section.startDate||dateInput(new Date()))+"T00:00:00");
  const end=new Date((section.endDate||dateInput(addDays(start,Math.max(28,units.length*14))))+"T00:00:00");
  const totalDays=Math.max(units.length,Math.round((end-start)/86400000)+1),daysPer=Math.max(1,Math.floor(totalDays/units.length));
  const existing=new Map(safe(section.pacingPlan?.units).map(x=>[x.unitId,x]));
  const suggestions=units.map((unit,index)=>{
    const a=addDays(start,index*daysPer),b=index===units.length-1?end:addDays(start,(index+1)*daysPer-1);
    return {unitId:unit.id,unitNumber:Number(unit.order||index+1),title:unit.title||"Unit",startDate:existing.get(unit.id)?.startDate||dateInput(a),endDate:existing.get(unit.id)?.endDate||dateInput(b)};
  });
  const m=modal({
    eyebrow:"Course Pacing",
    title:(section.courseCode||"Course")+" — Suggested Pacing",
    wide:true,
    body:'<form id="pacingForm"><div class="academic-banner"><div class="kicker">Instructional Calendar</div><h3>Unit pacing from '+esc(section.startDate||dateInput(start))+' to '+esc(section.endDate||dateInput(end))+'</h3><p>Adjust dates without changing the canonical course framework. The course guide uses this plan to identify the current unit.</p></div><div class="pacing-list">'+
      suggestions.map((row,i)=>'<div class="pacing-row"><div><span>Unit '+esc(row.unitNumber)+'</span><strong>'+esc(row.title)+'</strong></div><div class="field"><label>Start</label><input type="date" name="start_'+i+'" value="'+row.startDate+'"></div><div class="field"><label>End</label><input type="date" name="end_'+i+'" value="'+row.endDate+'"></div></div>').join("")+
      '</div><div class="modal-foot"><button class="secondary-btn" type="button" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Pacing Plan</button></div></form>'
  });
  m.querySelector("#pacingForm").onsubmit=async e=>{
    e.preventDefault();
    const plan=suggestions.map((row,i)=>({...row,startDate:e.currentTarget.elements["start_"+i].value,endDate:e.currentTarget.elements["end_"+i].value}));
    try{
      await updateDoc(doc(db,"sections",section.id),{pacingPlan:{units:plan,updatedAt:Timestamp.now(),updatedBy:s.user.uid},updatedAt:serverTimestamp()});
      section.pacingPlan={units:plan,updatedAt:Timestamp.now(),updatedBy:s.user.uid};
      closeModal();await core().reloadCurrentSection?.("framework");toast("Course pacing saved.");
    }catch(error){toast(error.message||"Unable to save pacing.");}
  };
}

async function releasePolicyModal(){
  const a=window.TheoriaPhase3?.getCurrent?.();if(!a||state()?.role!=="instructor")return;
  const p=a.releasePolicy||{showOverallScore:true,showQuestionScores:true,showCorrectAnswers:false,showExplanations:false,showCompetencies:true,showClassAverage:false,releaseMode:"when-graded"};
  const c=a.correctionPolicy||{enabled:false,instructions:""};
  const m=modal({
    eyebrow:"Student Results Policy",
    title:a.title||"Assessment",
    body:'<form id="releasePolicyForm"><div class="policy-grid">'+
      '<label class="policy-card"><input type="checkbox" name="overall" '+(p.showOverallScore!==false?'checked':'')+'><div><strong>Overall Score</strong><span>Show the assessment percentage.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="questions" '+(p.showQuestionScores!==false?'checked':'')+'><div><strong>Question Scores</strong><span>Show points earned per question.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="answers" '+(p.showCorrectAnswers?'checked':'')+'><div><strong>Correct Answers</strong><span>Expose correct answers after release.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="explanations" '+(p.showExplanations?'checked':'')+'><div><strong>Explanations</strong><span>Show Question Bank explanations.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="competencies" '+(p.showCompetencies!==false?'checked':'')+'><div><strong>Content & Skills</strong><span>Show topic and competency performance.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="classAverage" '+(p.showClassAverage?'checked':'')+'><div><strong>Class Average</strong><span>Show the section assessment average.</span></div></label>'+
      '</div><div class="field"><label>Release Mode</label><select name="releaseMode"><option value="when-graded">When grading is complete</option><option value="manual">Manual release only</option></select></div>'+
      '<div class="panel" style="margin-top:14px"><div class="panel-head"><div class="panel-title">Corrections / Review Mode</div></div><div class="panel-body"><label class="checkbox-line"><input type="checkbox" name="corrections" '+(c.enabled?'checked':'')+'> Allow post-result correction/reflection review</label><div class="field"><label>Student Guidance</label><textarea name="correctionInstructions">'+esc(c.instructions||"")+'</textarea></div></div></div>'+
      '<div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Results Policy</button></div></form>'
  });
  m.querySelector("#releasePolicyForm").elements.releaseMode.value=p.releaseMode||"when-graded";
  m.querySelector("#releasePolicyForm").onsubmit=async e=>{
    e.preventDefault();
    const f=e.currentTarget;
    const releasePolicy={showOverallScore:f.elements.overall.checked,showQuestionScores:f.elements.questions.checked,showCorrectAnswers:f.elements.answers.checked,showExplanations:f.elements.explanations.checked,showCompetencies:f.elements.competencies.checked,showClassAverage:f.elements.classAverage.checked,releaseMode:f.elements.releaseMode.value};
    const correctionPolicy={enabled:f.elements.corrections.checked,instructions:String(f.elements.correctionInstructions.value||"").trim()};
    try{await updateDoc(doc(db,"assessments",a.id),{releasePolicy,correctionPolicy,updatedAt:serverTimestamp()});a.releasePolicy=releasePolicy;a.correctionPolicy=correctionPolicy;closeModal();toast("Student results policy saved.");}
    catch(error){toast(error.message||"Unable to save results policy.");}
  };
}

async function recommendedPracticeModal(sourceAssessmentId){
  const s=state();if(!s||s.role!=="instructor")return;
  const sourceSnap=await getDoc(doc(db,"assessments",sourceAssessmentId));if(!sourceSnap.exists())return toast("Assessment not found.");
  const source={id:sourceSnap.id,...sourceSnap.data()};if(!source.sectionId)return toast("Assign the source assessment to a section before generating recommended practice.");
  const [qSnap,rSnap]=await Promise.all([getDocs(collection(db,"assessments",source.id,"questions")),getDocs(collection(db,"assessments",source.id,"results"))]);
  const questions=qSnap.docs.map(d=>({id:d.id,...d.data()})),results=rSnap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.complete===true);
  if(!results.length)return toast("Completed assessment results are required before Theoria can recommend practice.");

  const perf=new Map();
  for(const result of results){
    for(const q of questions){
      const score=result.grading?.[q.id]?.score;if(score===undefined||score===null)continue;
      const key=q.topicId||q.topicNumber||q.topicTitle||"unmapped",row=perf.get(key)||{topicId:q.topicId||"",topicNumber:q.topicNumber||"",topicTitle:q.topicTitle||"Unmapped",earned:0,max:0,competencies:new Set()};
      row.earned+=Number(score||0);row.max+=Number(q.points||0);safe(q.competencyCodes).forEach(c=>row.competencies.add(c));perf.set(key,row);
    }
  }
  const weak=[...perf.values()].map(x=>({...x,percent:x.max?Math.round(x.earned/x.max*1000)/10:null})).filter(x=>x.percent!==null&&x.percent<75).sort((a,b)=>a.percent-b.percent);
  if(!weak.length)return toast("No topic is currently below the 75% recommended-practice threshold.");

  const bank=await courseBank(source.courseId),used=new Set(questions.map(q=>q.itemId).filter(Boolean)),weakIds=new Set(weak.map(x=>x.topicId).filter(Boolean)),weakNums=new Set(weak.map(x=>x.topicNumber).filter(Boolean)),weakComps=new Set(weak.flatMap(x=>[...x.competencies]));
  const candidates=bank.filter(item=>!used.has(item.id)&&(weakIds.has(item.topicId)||weakNums.has(item.topicNumber)||safe(item.competencyCodes).some(c=>weakComps.has(c))));
  if(!candidates.length)return toast("No unused Question Bank items match the weak topics/competencies.");

  const selected=candidates.slice(0,Math.min(12,candidates.length));
  const section=s.sections.find(x=>x.id===source.sectionId)||s.currentSection;
  const m=modal({
    eyebrow:"Recommended Practice",
    title:"Build from "+(source.title||"Assessment"),
    wide:true,
    body:'<div class="academic-banner"><div class="kicker">Evidence → Practice</div><h3>'+weak.length+' content area'+(weak.length===1?" needs":"s need")+' reinforcement</h3><p>Theoria found unused Question Bank items connected to weak topics and competencies. This practice set will be formative and will not affect the Composite grade.</p></div>'+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Weak Topics</div></div><div class="panel-body">'+weak.map(x=>'<div class="blueprint-row"><span>'+esc((x.topicNumber?x.topicNumber+" — ":"")+x.topicTitle)+'</span><strong>'+x.percent+'%</strong></div>').join("")+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Practice Set</div></div><div class="panel-body"><div class="detail-list"><div><span>Questions</span><strong>'+selected.length+'</strong></div><div><span>Grade Impact</span><strong>Formative only</strong></div><div><span>Source</span><strong>Unused official Question Bank items</strong></div></div></div></div></div>',
    footer:'<button class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" id="createRecommendedPractice">Create & Publish Practice</button>'
  });
  m.querySelector("#createRecommendedPractice").onclick=async()=>{
    try{
      const created=await createAssessmentFromItems({section,kind:"recommended-practice",title:"Recommended Practice — "+(source.title||"Assessment"),items:selected,durationMinutes:20,publish:true,countsTowardComposite:false,formative:true,sourceAssessmentId:source.id});
      closeModal();toast("Recommended practice published.");if(created?.id)window.TheoriaPhase3?.openAssessment?.(created.id);
    }catch(error){toast(error.message||"Unable to create recommended practice.");}
  };
}

function enhanceAssessmentDetail(){
  const a=window.TheoriaPhase3?.getCurrent?.();if(!a||state()?.role!=="instructor"||!document.querySelector("#page-assessment-detail.active"))return;
  const actions=document.querySelector("#assessmentDetail .detail-top .inline-actions");if(!actions)return;
  if(!actions.querySelector('[data-classroom-action="release-policy"]'))actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-classroom-action="release-policy">Results Policy</button>');
  if(a.sectionId&&!actions.querySelector('[data-classroom-action="recommended-practice"]'))actions.insertAdjacentHTML("beforeend",'<button class="secondary-btn small-btn" data-classroom-action="recommended-practice" data-id="'+a.id+'">Recommended Practice</button>');
  const hero=document.querySelector("#assessmentDetail .detail-hero");
  if(hero&&a.officialMaterial&&!hero.querySelector(".official-material-badge"))hero.insertAdjacentHTML("afterbegin",'<div class="official-material-badge">Θ Official Theoria Course Material • '+esc(typeLabel(a.catalogKind)||a.type||"Assessment")+'</div>');
}

async function enhanceStudentHome(){
  const s=state();if(!s?.user||s.role!=="student"||!document.querySelector("#page-home.active"))return;
  const target=document.querySelector("#homeAttention");if(!target||target.dataset.classroomStudentHome==="1")return;
  target.dataset.classroomStudentHome="1";
  const today=new Date(),soon=new Date(Date.now()+7*86400000);
  const cards=[],due=[],results=[];
  for(const section of (s.sections||[]).filter(x=>x.status!=="Archived"&&x.enrollmentStatus!=="Completed")){
    let assignments=[],refs=[],assessmentGrades=[];
    try{
      const [as,rs,gs]=await Promise.all([
        getDocs(query(collection(db,"sections",section.id,"assignments"),where("status","==","Published"))),
        getDocs(collection(db,"sections",section.id,"assessmentRefs")),
        getDocs(query(collection(db,"sections",section.id,"assessmentGrades"),where("studentId","==",s.user.uid)))
      ]);
      assignments=as.docs.map(d=>({id:d.id,...d.data()}));
      refs=rs.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=="Draft");
      assessmentGrades=gs.docs.map(d=>({id:d.id,...d.data()}));
    }catch(_){}
    let currentUnitLabel="Course Guide";
    const pacing=safe(section.pacingPlan?.units);
    const active=pacing.find(row=>{const a=row.startDate?new Date(row.startDate+"T00:00:00"):null,b=row.endDate?new Date(row.endDate+"T23:59:59"):null;return a&&b&&today>=a&&today<=b;});
    if(active)currentUnitLabel="Unit "+(active.unitNumber||"")+" — "+(active.title||"Current Unit");
    cards.push({section,currentUnitLabel});
    assignments.forEach(a=>{
      if(!a.dueDate)return;const d=new Date(a.dueDate+"T23:59:59");
      if(d>=today&&d<=soon)due.push({kind:"Coursework",title:a.title,when:d,section});
    });
    refs.forEach(a=>{
      const d=a.closesAt?.toDate?.()||a.opensAt?.toDate?.();
      if(d&&d>=today&&d<=soon)due.push({kind:a.catalogKind?typeLabel(a.catalogKind):a.assessmentType||"Assessment",title:a.title,when:d,section});
    });
    assessmentGrades.filter(g=>g.released!==false&&g.percent!==null&&g.percent!==undefined).forEach(g=>results.push({title:g.assessmentTitle||"Assessment",percent:g.percent,section,updated:g.updatedAt?.toDate?.()||new Date(0)}));
  }
  due.sort((a,b)=>a.when-b.when);results.sort((a,b)=>b.updated-a.updated);
  target.innerHTML='<div class="student-home-flow">'+
    '<div class="page-head compact-head"><div><div class="panel-title">Your Learning Flow</div><p class="page-subtitle">Current course focus, work due soon, and recently released results.</p></div></div>'+
    '<div class="student-home-course-grid">'+cards.map(row=>'<article class="course-now-card"><div class="card-kicker">'+esc(row.section.courseCode||"Course")+' • '+esc(row.section.term||"")+'</div><h3>'+esc(row.section.courseTitle||row.section.sectionName||"Course")+'</h3><p>'+esc(row.currentUnitLabel)+'</p><div class="card-actions"><button class="primary-btn small-btn" data-action="open-section" data-id="'+row.section.id+'">Continue</button></div></article>').join("")+'</div>'+
    '<div class="grid-2 student-home-priority-grid"><div class="panel"><div class="panel-head"><div><div class="panel-title">Due in the Next 7 Days</div><div class="panel-subtitle">Coursework and assessment deadlines.</div></div></div><div class="panel-body">'+(due.length?due.slice(0,8).map(x=>'<div class="priority-line"><div><strong>'+esc(x.title)+'</strong><span>'+esc(x.section.courseCode||"Course")+' • '+esc(x.kind)+'</span></div><b>'+esc(x.when.toLocaleDateString(undefined,{month:"short",day:"numeric"}))+'</b></div>').join(""):'<div class="empty-mini">Nothing due in the next seven days.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div><div class="panel-title">Recent Results</div><div class="panel-subtitle">Recently released formal-assessment results.</div></div></div><div class="panel-body">'+(results.length?results.slice(0,8).map(x=>'<div class="priority-line"><div><strong>'+esc(x.title)+'</strong><span>'+esc(x.section.courseCode||"Course")+'</span></div><b>'+esc(x.percent)+'%</b></div>').join(""):'<div class="empty-mini">No released assessment results yet.</div>')+'</div></div></div>'+
    '</div>';
}

function enhanceAll(){
  enhanceCourseGuide();
  enhanceOverview();
  enhanceAssessmentDetail();
  enhanceStudentHome().catch(()=>{});
}

function bind(){
  document.addEventListener("click",e=>{
    const b=e.target.closest("[data-classroom-action]");if(!b)return;
    const a=b.dataset.classroomAction;
    if(a==="create-topic-practice")return frameworkAssessmentModal("topic-practice",b.dataset.unit,b.dataset.topic);
    if(a==="create-progress-check")return frameworkAssessmentModal("progress-check",b.dataset.unit);
    if(a==="create-unit-assessment")return frameworkAssessmentModal("unit-assessment",b.dataset.unit);
    if(a==="create-practice-exam")return frameworkAssessmentModal("practice-exam");
    if(a==="pacing")return pacingModal();
    if(a==="release-policy")return releasePolicyModal();
    if(a==="recommended-practice")return recommendedPracticeModal(b.dataset.id||window.TheoriaPhase3?.getCurrent?.()?.id);
  });
  window.addEventListener("theoria:page",()=>setTimeout(enhanceAll,80));
  window.addEventListener("theoria:ready",()=>setTimeout(enhanceAll,150));
}

export function initClassroom(){
  bind();
  return {enhanceAll,enhanceCourseGuide,enhanceStudentHome,frameworkAssessmentModal,recommendedPracticeModal,releasePolicyModal,pacingModal,createAssessmentFromItems};
}
