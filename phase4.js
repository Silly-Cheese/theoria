import {
  db, doc, getDoc, setDoc, addDoc, updateDoc,
  collection, getDocs, query, where, writeBatch, serverTimestamp
} from "./firebase.js";

const P4={
  ready:false,
  masterySectionId:null,
  reportsSectionId:null,
  cache:new Map()
};

const core=()=>window.TheoriaCore;
const state=()=>core()?.getState();
const $=s=>document.querySelector(s);
const esc=v=>core()?.esc(v) ?? String(v??"");
const toast=m=>core()?.showToast(m);

const DEFAULT_SCALE=[
  {min:93,letter:"A"},{min:90,letter:"A-"},{min:87,letter:"B+"},
  {min:83,letter:"B"},{min:80,letter:"B-"},{min:77,letter:"C+"},
  {min:73,letter:"C"},{min:70,letter:"C-"},{min:67,letter:"D+"},
  {min:63,letter:"D"},{min:60,letter:"D-"},{min:0,letter:"F"}
];

function round(n){return Math.round(Number(n||0)*10)/10;}
function avg(values){
  const clean=values.filter(x=>x!==null&&x!==undefined&&!Number.isNaN(Number(x))).map(Number);
  return clean.length?round(clean.reduce((a,b)=>a+b,0)/clean.length):null;
}
function pct(score,max){return Number(max)>0?round(Number(score||0)/Number(max)*100):null;}
function letter(percent,scale=DEFAULT_SCALE){
  if(percent===null||percent===undefined)return "—";
  return (scale||DEFAULT_SCALE).find(x=>Number(percent)>=Number(x.min))?.letter||"F";
}
function dateText(v){
  if(!v)return "—";
  const d=v.toDate?v.toDate():new Date(v);
  if(Number.isNaN(d.getTime()))return "—";
  return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"}).format(d);
}
function idStamp(){
  const d=new Date(),z=n=>String(n).padStart(2,"0");
  const rand=Math.random().toString(36).slice(2,7).toUpperCase();
  return "THR-"+d.getFullYear()+z(d.getMonth()+1)+z(d.getDate())+"-"+rand;
}

async function getSection(sectionId){
  const s=state();
  const known=s?.sections?.find(x=>x.id===sectionId);
  if(known)return known;
  const snap=await getDoc(doc(db,"sections",sectionId));
  return snap.exists()?{id:snap.id,...snap.data()}:null;
}

async function loadSectionBundle(sectionId,{deep=false}={}){
  const key=sectionId+"|"+deep;
  if(P4.cache.has(key))return P4.cache.get(key);
  const s=state(),section=await getSection(sectionId);
  if(!section)throw new Error("Section not found.");

  const assignmentsSnap=s.role==="instructor"
    ? await getDocs(collection(db,"sections",sectionId,"assignments"))
    : await getDocs(query(collection(db,"sections",sectionId,"assignments"),where("status","==","Published")));
  const assignments=assignmentsSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=="Draft");
  const assessmentRefSnap=await getDocs(collection(db,"sections",sectionId,"assessmentRefs"));
  const assessmentRefs=assessmentRefSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=="Draft");
  for(const ref of assessmentRefs){
    if(ref.assessmentType||ref.type)continue;
    try{
      const assessmentSnap=await getDoc(doc(db,"assessments",ref.id));
      if(assessmentSnap.exists()){
        const data=assessmentSnap.data();
        ref.assessmentType=data.type||"Assessment";
        ref.type=data.type||"Assessment";
        ref.title=data.title||ref.title||"Assessment";
        ref.totalPoints=Number(data.totalPoints||ref.totalPoints||0);
      }
    }catch(_){}
  }

  let members=[],grades=[],assessmentGrades=[],pathways=[],records=[],mastery=[],appeals=[],portfolios=[],narratives=[];
  if(s.role==="instructor"){
    const results=await Promise.all([
      getDocs(collection(db,"sections",sectionId,"members")),
      getDocs(collection(db,"sections",sectionId,"grades")),
      getDocs(collection(db,"sections",sectionId,"assessmentGrades")),
      getDocs(collection(db,"sections",sectionId,"gradingPathways")),
      getDocs(collection(db,"sections",sectionId,"academicRecords")),
      getDocs(collection(db,"sections",sectionId,"mastery")),
      getDocs(collection(db,"sections",sectionId,"appeals")),
      getDocs(collection(db,"sections",sectionId,"portfolios")),
      getDocs(collection(db,"sections",sectionId,"narratives"))
    ]);
    members=results[0].docs.map(d=>({id:d.id,...d.data()}));
    grades=results[1].docs.map(d=>({id:d.id,...d.data()}));
    assessmentGrades=results[2].docs.map(d=>({id:d.id,...d.data()}));
    pathways=results[3].docs.map(d=>({id:d.id,...d.data()}));
    records=results[4].docs.map(d=>({id:d.id,...d.data()}));
    mastery=results[5].docs.map(d=>({id:d.id,...d.data()}));
    appeals=results[6].docs.map(d=>({id:d.id,...d.data()}));
    portfolios=results[7].docs.map(d=>({id:d.id,...d.data()}));
    narratives=results[8].docs.map(d=>({id:d.id,...d.data()}));
  }else{
    const uid=s.user.uid;
    const gets=await Promise.all([
      getDoc(doc(db,"sections",sectionId,"members",uid)),
      getDocs(query(collection(db,"sections",sectionId,"grades"),where("studentId","==",uid))),
      getDoc(doc(db,"sections",sectionId,"gradingPathways",uid)),
      getDoc(doc(db,"sections",sectionId,"academicRecords",uid)),
      getDoc(doc(db,"sections",sectionId,"mastery",uid)),
      getDocs(query(collection(db,"sections",sectionId,"appeals"),where("studentId","==",uid))),
      getDoc(doc(db,"sections",sectionId,"portfolios",uid)),
      getDoc(doc(db,"sections",sectionId,"narratives",uid))
    ]);
    if(gets[0].exists())members=[{id:gets[0].id,...gets[0].data()}];
    grades=gets[1].docs.map(d=>({id:d.id,...d.data()}));
    if(gets[2].exists())pathways=[{id:gets[2].id,...gets[2].data()}];
    if(gets[3].exists())records=[{id:gets[3].id,...gets[3].data()}];
    if(gets[4].exists())mastery=[{id:gets[4].id,...gets[4].data()}];
    appeals=gets[5].docs.map(d=>({id:d.id,...d.data()}));
    if(gets[6].exists())portfolios=[{id:gets[6].id,...gets[6].data()}];
    if(gets[7].exists())narratives=[{id:gets[7].id,...gets[7].data()}];

    for(const ref of assessmentRefs){
      try{
        const grade=await getDoc(doc(db,"sections",sectionId,"assessmentGrades",ref.id+"_"+uid));
        if(grade.exists())assessmentGrades.push({id:grade.id,...grade.data()});
      }catch(_){}
    }
  }

  let assessments=[];
  if(deep&&s.role==="instructor"){
    const aSnap=await getDocs(query(collection(db,"assessments"),where("ownerId","==",s.user.uid)));
    for(const aDoc of aSnap.docs.filter(d=>d.data().sectionId===sectionId)){
      const assessment={id:aDoc.id,...aDoc.data()};
      const [qSnap,kSnap,subSnap,resSnap]=await Promise.all([
        getDocs(collection(db,"assessments",assessment.id,"questions")),
        getDocs(collection(db,"assessments",assessment.id,"keys")),
        getDocs(collection(db,"assessments",assessment.id,"submissions")),
        getDocs(collection(db,"assessments",assessment.id,"results"))
      ]);
      assessment.questions=qSnap.docs.map(d=>({id:d.id,...d.data()}));
      assessment.keys=kSnap.docs.map(d=>({id:d.id,...d.data()}));
      assessment.submissions=subSnap.docs.map(d=>({id:d.id,...d.data()}));
      assessment.results=resSnap.docs.map(d=>({id:d.id,...d.data()}));
      assessments.push(assessment);
    }
  }

  const bundle={section,assignments,assessmentRefs,members,grades,assessmentGrades,pathways,records,mastery,appeals,portfolios,narratives,assessments};
  P4.cache.set(key,bundle);
  return bundle;
}

function invalidate(sectionId){
  [...P4.cache.keys()].filter(k=>k.startsWith(sectionId+"|")).forEach(k=>P4.cache.delete(k));
}

function courseworkPercent(bundle,studentId){
  const gradeMap=new Map(bundle.grades.filter(g=>g.studentId===studentId).map(g=>[g.assignmentId,g]));
  const rules=bundle.section.gradingPolicy?.courseworkRules||{};
  const missingAsZero=rules.missingAsZero===true;
  const latePenalty=Math.max(0,Math.min(100,Number(rules.latePenaltyPercent||0)));
  const entries=[];

  for(const a of bundle.assignments){
    const g=gradeMap.get(a.id),status=String(g?.gradeStatus||"Normal");
    if(status==="Excused")continue;
    const max=Number(a.points||0);
    if(status==="Missing"){
      entries.push({assignment:a,grade:g||null,score:0,max,percent:0,status});
    }else if(g&&g.score!==null&&g.score!==undefined){
      let score=Number(g.score||0);
      if(status==="Late"&&latePenalty)score=score*(1-latePenalty/100);
      entries.push({assignment:a,grade:g,score,max,percent:max?score/max*100:0,status});
    }else if(missingAsZero){
      entries.push({assignment:a,grade:null,score:0,max,percent:0,status:"Missing"});
    }
  }

  const dropCount=Math.max(0,Math.min(entries.length,Math.floor(Number(rules.dropLowest||0))));
  const dropped=new Set([...entries].sort((a,b)=>a.percent-b.percent).slice(0,dropCount).map(x=>x.assignment.id));
  const kept=entries.filter(x=>!dropped.has(x.assignment.id));

  const categoryWeights=rules.categoryWeights&&typeof rules.categoryWeights==="object"?rules.categoryWeights:{};
  const categoryTotal=Object.values(categoryWeights).reduce((n,x)=>n+Number(x||0),0);
  let percentValue=null,earned=0,possible=0;

  kept.forEach(x=>{earned+=x.score;possible+=x.max;});

  if(categoryTotal===100){
    let weighted=0,usedWeight=0;
    const groups=new Map();
    kept.forEach(x=>{
      const key=x.assignment.type||"Assignment";
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(x);
    });
    for(const [key,weightRaw] of Object.entries(categoryWeights)){
      const weight=Number(weightRaw||0);if(!weight)continue;
      const group=groups.get(key)||[];
      const gp=group.reduce((n,x)=>n+x.max,0),ge=group.reduce((n,x)=>n+x.score,0);
      if(gp){weighted+=(ge/gp*100)*weight;usedWeight+=weight;}
    }
    percentValue=usedWeight?round(weighted/usedWeight):null;
  }else{
    percentValue=possible?pct(earned,possible):null;
  }

  return {
    percent:percentValue,
    earned:round(earned),
    possible:round(possible),
    graded:kept.filter(x=>x.grade).length,
    total:bundle.assignments.length,
    dropped:[...dropped],
    rules
  };
}

function isGeneralAssessmentType(type){
  const value=String(type||"").trim().toLowerCase();
  return value && !value.includes("semester") && !value.includes("comprehensive") && !value.includes("entrance");
}

function generalAssessmentComponent(bundle,studentId){
  const refs=(bundle.assessmentRefs||[]).filter(ref=>isGeneralAssessmentType(ref.assessmentType||ref.type)&&ref.countsTowardComposite!==false);
  const refIds=new Set(refs.map(ref=>ref.id));
  const complete=(bundle.assessmentGrades||[]).filter(g=>g.studentId===studentId&&refIds.has(g.assessmentId)&&g.percent!==null&&g.percent!==undefined);
  let percent=null;
  if(complete.length){
    const canWeight=complete.every(row=>Number(row.maxScore||0)>0&&row.score!==null&&row.score!==undefined);
    if(canWeight){
      const earned=complete.reduce((n,row)=>n+Number(row.score||0),0);
      const possible=complete.reduce((n,row)=>n+Number(row.maxScore||0),0);
      percent=possible?round(earned/possible*100):avg(complete.map(row=>row.percent));
    }else{
      percent=avg(complete.map(row=>row.percent));
    }
  }
  return {
    percent,
    count:complete.length,
    total:refs.length,
    complete:refs.length===0||complete.length===refs.length,
    rows:complete,
    refs
  };
}

function compositeWeights(policy={}){
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
    coursework:round(legacyCoursework-assessmentShare),
    assessments:round(assessmentShare),
    semester:Number(raw.semester??15),
    comprehensive:Number(raw.comprehensive??25)
  };
}

function examComponent(bundle,studentId,type){
  const rows=bundle.assessmentGrades.filter(g=>g.studentId===studentId&&g.assessmentType===type);
  const complete=rows.filter(x=>x.percent!==null&&x.percent!==undefined);
  return {
    percent:avg(complete.map(x=>x.percent)),
    count:complete.length,
    rows:complete
  };
}

function pathwayFor(bundle,studentId){
  return bundle.pathways.find(x=>(x.studentId||x.id)===studentId)||null;
}

function openAppeals(bundle,studentId){
  return bundle.appeals.filter(x=>x.studentId===studentId&&!["Resolved","Denied","Withdrawn"].includes(x.status));
}

function finalCalculation(bundle,studentId){
  const section=bundle.section;
  const policy=section.gradingPolicy||{};
  const choice=pathwayFor(bundle,studentId);
  const coursework=courseworkPercent(bundle,studentId);
  const assessments=generalAssessmentComponent(bundle,studentId);
  const semester=examComponent(bundle,studentId,"Semester I Examination");
  const comprehensive=examComponent(bundle,studentId,"Comprehensive Final Examination");
  const pathway=choice?.pathway||null;
  const weights=pathway==="examination"
    ? (policy.examination||{semester:35,comprehensive:65})
    : compositeWeights(policy);

  const components=pathway==="examination"
    ? [
        {key:"semester",label:"Semester I Examination",value:semester.percent,weight:Number(weights.semester||0)},
        {key:"comprehensive",label:"Comprehensive Final Examination",value:comprehensive.percent,weight:Number(weights.comprehensive||0)}
      ]
    : [
        {key:"coursework",label:"Coursework",value:coursework.percent,weight:Number(weights.coursework||0)},
        ...(assessments.total?[{key:"assessments",label:"General Assessments",value:assessments.percent,weight:Number(weights.assessments||0)}]:[]),
        {key:"semester",label:"Semester I Examination",value:semester.percent,weight:Number(weights.semester||0)},
        {key:"comprehensive",label:"Comprehensive Final Examination",value:comprehensive.percent,weight:Number(weights.comprehensive||0)}
      ];

  let weighted=0,availableWeight=0,requiredWeight=0;
  for(const c of components){
    requiredWeight+=c.weight;
    if(c.value!==null){weighted+=Number(c.value)*c.weight;availableWeight+=c.weight;}
  }
  const complete=!!pathway&&components.every(c=>c.value!==null);
  const final=complete&&requiredWeight?round(weighted/requiredWeight):null;
  const projection=availableWeight?round(weighted/availableWeight):null;
  const appeals=openAppeals(bundle,studentId);

  const audit=[
    {id:"pathway",label:"Grading pathway selected",ok:!!pathway},
    {id:"assessments",label:assessments.total?("General assessments complete ("+assessments.count+"/"+assessments.total+")"):"No general assessments assigned",ok:pathway==="examination"||assessments.complete},
    {id:"semester",label:"Semester I Examination complete",ok:semester.percent!==null},
    {id:"comprehensive",label:"Comprehensive Final Examination complete",ok:comprehensive.percent!==null},
    {id:"coursework",label:"Required coursework grade available",ok:pathway==="examination"||coursework.percent!==null},
    {id:"appeals",label:"No unresolved grade appeals",ok:appeals.length===0}
  ];
  const ready=audit.every(x=>x.ok);

  return {pathway,choice,coursework,assessments,semester,comprehensive,components,final,projection,complete,ready,audit,appeals,weights};
}

function competencyClass(percent){
  if(percent===null)return "unknown";
  if(percent>=85)return "strong";
  if(percent>=70)return "developing";
  return "attention";
}

function masterySummary(snapshot){
  const rows=snapshot?.competencies||[];
  return rows.length?avg(rows.map(x=>x.percent)):null;
}

async function recomputeMastery(sectionId){
  const s=state();
  if(s.role!=="instructor")return;
  const bundle=await loadSectionBundle(sectionId,{deep:true});
  const members=bundle.members;
  const studentAgg=new Map(members.map(m=>[m.id,{competencies:new Map(),topics:new Map(),evidence:0}]));

  for(const assessment of bundle.assessments){
    const qMap=new Map(assessment.questions.map(q=>[q.id,q]));
    for(const result of assessment.results){
      const agg=studentAgg.get(result.studentId);
      if(!agg)continue;
      for(const [questionId,grade] of Object.entries(result.grading||{})){
        const q=qMap.get(questionId);if(!q)continue;
        const score=Number(grade.score||0),max=Number(q.points||0);
        if(!max)continue;
        agg.evidence++;
        for(const code of q.competencyCodes||[]){
          const row=agg.competencies.get(code)||{code,name:code,score:0,max:0,evidence:0};
          const comp=bundle.sectionData?.framework?.competencies?.find?.(x=>x.code===code);
          if(comp)row.name=comp.name;
          row.score+=score;row.max+=max;row.evidence++;agg.competencies.set(code,row);
        }
        if(q.topicId||q.topicNumber){
          const key=q.topicId||q.topicNumber,row=agg.topics.get(key)||{id:key,number:q.topicNumber||"",name:q.topicTitle||q.topicNumber||"Topic",score:0,max:0,evidence:0};
          row.score+=score;row.max+=max;row.evidence++;agg.topics.set(key,row);
        }
      }
    }
  }

  const courseSnap=await getDoc(doc(db,"courses",bundle.section.courseId));
  const course=courseSnap.exists()?courseSnap.data():{};
  const compSnap=await getDocs(collection(db,"courses",bundle.section.courseId,"competencies"));
  const compNames=new Map(compSnap.docs.map(d=>[d.data().code,d.data().name]));

  const batch=writeBatch(db);
  for(const member of members){
    const agg=studentAgg.get(member.id);
    const competencies=[...agg.competencies.values()].map(x=>({...x,name:compNames.get(x.code)||x.name,percent:pct(x.score,x.max)})).sort((a,b)=>a.code.localeCompare(b.code));
    const topics=[...agg.topics.values()].map(x=>({...x,percent:pct(x.score,x.max)})).sort((a,b)=>String(a.number).localeCompare(String(b.number),undefined,{numeric:true}));
    const overallPercent=competencies.length?avg(competencies.map(x=>x.percent)):null;
    const prior=bundle.mastery.find(x=>(x.studentId||x.id)===member.id);
    const history=[...(prior?.history||[]),{
      at:new Date().toISOString(),overallPercent,evidenceCount:agg.evidence,
      competencies:competencies.map(x=>({code:x.code,percent:x.percent})),
      topics:topics.map(x=>({id:x.id,number:x.number,percent:x.percent}))
    }].slice(-24);
    batch.set(doc(db,"sections",sectionId,"mastery",member.id),{
      studentId:member.id,studentName:member.displayName||"Student",courseId:bundle.section.courseId,
      courseCode:bundle.section.courseCode||course.code||"",competencies,topics,evidenceCount:agg.evidence,
      overallPercent,history,calculatedAt:serverTimestamp()
    },{merge:true});
  }
  await batch.commit();
  invalidate(sectionId);
  toast("Mastery evidence recalculated.");
}

function masteryHistoryHtml(snapshot){
  const rows=snapshot?.history||[];
  if(!rows.length)return '<div class="empty-mini">Mastery history begins after the next recalculation.</div>';
  const recent=rows.slice(-12),max=Math.max(1,...recent.map(x=>Number(x.overallPercent||0)));
  return '<div class="mastery-history-chart">'+recent.map((row,i)=>{
    const value=Number(row.overallPercent||0),height=Math.max(8,Math.round(value/max*100));
    const when=row.at?new Date(row.at):null;
    const label=when&&!Number.isNaN(when.getTime())?when.toLocaleDateString(undefined,{month:"short",day:"numeric"}):"Run "+(i+1);
    return '<div class="mastery-history-point"><div class="mastery-history-bar" style="height:'+height+'%"><span>'+esc(value)+'%</span></div><small>'+esc(label)+'</small></div>';
  }).join("")+'</div>';
}

function masteryBars(rows){
  if(!rows?.length)return '<div class="empty-mini">No competency evidence has been calculated yet.</div>';
  return '<div class="mastery-list">'+rows.map(x=>'<div class="mastery-row"><div class="mastery-label"><strong>'+esc(x.code||"")+'</strong><span>'+esc(x.name||x.code||"Competency")+'</span></div><div class="mastery-track"><div class="mastery-fill '+competencyClass(x.percent)+'" style="width:'+Math.max(0,Math.min(100,Number(x.percent||0)))+'%"></div></div><div class="mastery-score">'+(x.percent===null?"—":esc(x.percent)+"%")+'<span>'+esc(x.evidence||0)+' evidence</span></div></div>').join("")+'</div>';
}

async function renderMasteryPage(sectionId=P4.masterySectionId){
  const el=$("#masteryContent");if(!el)return;
  const s=state();
  if(!sectionId){
    el.innerHTML='<div class="record-card-grid">'+s.sections.map(sec=>'<article class="academic-card"><div class="card-kicker">'+esc(sec.courseCode||"THEO")+' • '+esc(sec.term||"")+'</div><h3>'+esc(sec.courseTitle||sec.sectionName)+'</h3><p>'+esc(sec.sectionName||"")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-phase4-action="open-mastery-section" data-section="'+sec.id+'">Open Mastery</button></div></article>').join("")+'</div>';
    return;
  }
  P4.masterySectionId=sectionId;
  const bundle=await loadSectionBundle(sectionId);
  if(s.role==="instructor"){
    const snaps=bundle.mastery;
    const allCodes=new Map();
    snaps.forEach(m=>(m.competencies||[]).forEach(c=>{
      const r=allCodes.get(c.code)||{code:c.code,name:c.name,values:[]};r.values.push(c.percent);allCodes.set(c.code,r);
    }));
    const classRows=[...allCodes.values()].map(x=>({...x,percent:avg(x.values),evidence:x.values.length}));
    el.innerHTML='<button class="text-btn" data-phase4-action="mastery-back">← All Sections</button><div class="detail-hero"><div class="eyebrow">'+esc(bundle.section.courseCode||"Course")+' • '+esc(bundle.section.term||"")+'</div><h1 class="detail-title">'+esc(bundle.section.courseTitle||"Section")+'</h1><p class="page-subtitle">Class-level competency mastery calculated from scored assessment evidence.</p></div>'+
      '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Section Competency Mastery</div></div><div class="panel-body">'+masteryBars(classRows)+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Students</div></div><div class="panel-body">'+(snaps.length?snaps.sort((a,b)=>String(a.studentName).localeCompare(String(b.studentName))).map(m=>'<button class="mastery-student-row" data-phase4-action="mastery-student" data-student="'+m.id+'"><span>'+esc(m.studentName)+'</span><strong>'+(m.overallPercent===null?"—":esc(m.overallPercent)+"%")+'</strong></button>').join(""):'<div class="empty-mini">No mastery snapshots yet. Recalculate mastery.</div>')+'</div></div></div>';
  }else{
    const snap=bundle.mastery.find(x=>x.id===s.user.uid);
    el.innerHTML='<button class="text-btn" data-phase4-action="mastery-back">← All Sections</button><div class="detail-hero"><div class="eyebrow">'+esc(bundle.section.courseCode||"Course")+' • '+esc(bundle.section.term||"")+'</div><h1 class="detail-title">'+esc(bundle.section.courseTitle||"Section")+'</h1><p class="page-subtitle">Mastery is evidence of academic competencies and remains separate from your course grade.</p></div>'+
      (snap?'<div class="mastery-overall"><div><span>Overall Competency Mastery</span><strong>'+esc(snap.overallPercent??"—")+'%</strong></div><small>'+esc(snap.evidenceCount||0)+' scored evidence points</small></div><div class="panel" style="margin-bottom:16px"><div class="panel-head"><div><div class="panel-title">Mastery Over Time</div><div class="panel-subtitle">Longitudinal evidence from mastery recalculations.</div></div></div><div class="panel-body">'+masteryHistoryHtml(snap)+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Competencies</div></div><div class="panel-body">'+masteryBars(snap.competencies)+'</div></div>':'<div class="empty-state"><div class="empty-symbol">M</div><h3>No mastery snapshot yet.</h3><p>Your instructor can calculate mastery after scored assessments produce evidence.</p></div>');
  }
}

async function masteryStudentModal(studentId){
  const bundle=await loadSectionBundle(P4.masterySectionId),m=bundle.mastery.find(x=>x.id===studentId);if(!m)return;
  core().openModal({
    eyebrow:"Mastery Profile",
    title:m.studentName||"Student",
    wide:true,
    body:'<div class="mastery-overall"><div><span>Overall Competency Mastery</span><strong>'+esc(m.overallPercent??"—")+'%</strong></div><small>'+esc(m.evidenceCount||0)+' evidence points</small></div><div class="panel-title" style="margin:18px 0 10px">Mastery Over Time</div>'+masteryHistoryHtml(m)+'<div class="panel-title" style="margin:22px 0 10px">Competencies</div>'+masteryBars(m.competencies)+'<div class="panel-title" style="margin:22px 0 10px">Topics</div>'+masteryBars((m.topics||[]).map(x=>({code:x.number,name:x.name,percent:x.percent,evidence:x.evidence})))
  });
}

/* -------------------- ANALYTICS -------------------- */

async function renderAnalytics(sectionId){
  const el=$("#phase4SectionTab");if(!el)return;
  el.innerHTML='<div class="empty-mini">Calculating section analytics…</div>';
  const bundle=await loadSectionBundle(sectionId,{deep:true});
  const classCoursework=avg(bundle.members.map(m=>courseworkPercent(bundle,m.id).percent));
  const classMastery=avg(bundle.mastery.map(x=>x.overallPercent));
  const questionRows=[];

  for(const a of bundle.assessments){
    const keys=new Map(a.keys.map(k=>[k.id,k]));
    const subs=new Map(a.submissions.map(s=>[s.studentId,s]));
    for(const q of a.questions){
      const scored=a.results.map(r=>({result:r,grade:r.grading?.[q.id],sub:subs.get(r.studentId)})).filter(x=>x.grade);
      if(!scored.length)continue;
      const avgScore=avg(scored.map(x=>pct(x.grade.score,q.points)));
      const choices={};
      if(q.type==="Multiple Choice"||q.type==="Multiple Select"){
        scored.forEach(x=>{
          const ans=x.sub?.answers?.[q.id];
          const key=Array.isArray(ans)?ans.join(", "):String(ans||"No response");
          choices[key]=(choices[key]||0)+1;
        });
      }
      questionRows.push({assessment:a.title,number:q.order||"",prompt:q.prompt,type:q.type,percent:avgScore,responses:scored.length,choices,correct:keys.get(q.id)?.correctAnswer});
    }
  }

  const weak=[...questionRows].sort((a,b)=>(a.percent??101)-(b.percent??101)).slice(0,8);
  const attention=bundle.mastery.filter(x=>x.overallPercent!==null&&x.overallPercent<70).sort((a,b)=>a.overallPercent-b.overallPercent);

  el.innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Students</div><div class="summary-value">'+bundle.members.length+'</div></div><div class="summary-block"><div class="summary-label">Coursework Avg</div><div class="summary-value">'+(classCoursework===null?"—":classCoursework+"%")+'</div></div><div class="summary-block"><div class="summary-label">Mastery Avg</div><div class="summary-value">'+(classMastery===null?"—":classMastery+"%")+'</div></div><div class="summary-block"><div class="summary-label">Scored Items</div><div class="summary-value">'+questionRows.length+'</div></div></div>'+
    '<div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Questions Needing Review</div></div><div class="panel-body">'+(weak.length?weak.map(q=>'<div class="analysis-row"><div><strong>'+esc(q.assessment)+' • Q'+esc(q.number)+'</strong><span>'+esc(q.prompt.slice(0,95))+(q.prompt.length>95?"…":"")+'</span></div><b>'+esc(q.percent)+'%</b></div>').join(""):'<div class="empty-mini">No scored question data yet.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div class="panel-title">Students Needing Support</div></div><div class="panel-body">'+(attention.length?attention.map(m=>'<div class="analysis-row"><div><strong>'+esc(m.studentName)+'</strong><span>'+esc(m.evidenceCount||0)+' mastery evidence points</span></div><b>'+esc(m.overallPercent)+'%</b></div>').join(""):'<div class="empty-mini">No students are currently below the 70% mastery threshold.</div>')+'</div></div></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div class="panel-title">Item Analysis</div></div><div class="data-table-wrap" style="border:0"><table class="data-table"><thead><tr><th>Assessment / Item</th><th>Type</th><th>Responses</th><th>Mean Performance</th><th>Response Pattern</th></tr></thead><tbody>'+questionRows.map(q=>'<tr><td><strong>'+esc(q.assessment)+' • Q'+esc(q.number)+'</strong><span class="grade-sub">'+esc(q.prompt.slice(0,80))+'</span></td><td>'+esc(q.type)+'</td><td>'+q.responses+'</td><td><strong>'+esc(q.percent)+'%</strong></td><td>'+esc(Object.entries(q.choices).slice(0,4).map(([k,v])=>k+": "+v).join(" • ")||"Written response")+'</td></tr>').join("")+'</tbody></table></div></div>';
}

/* -------------------- RECORDS / PORTFOLIO -------------------- */

function recordFor(bundle,studentId){return bundle.records.find(x=>(x.studentId||x.id)===studentId)||null;}
function portfolioFor(bundle,studentId){return bundle.portfolios.find(x=>(x.studentId||x.id)===studentId)||null;}

function auditHtml(calc){
  return '<div class="audit-list">'+calc.audit.map(x=>'<div class="audit-row '+(x.ok?'ok':'missing')+'"><span class="audit-icon">'+(x.ok?"✓":"!")+'</span><span>'+esc(x.label)+'</span><strong>'+(x.ok?"Ready":"Required")+'</strong></div>').join("")+'</div>';
}

function componentHtml(calc){
  return '<div class="record-components">'+calc.components.map(c=>'<div><span>'+esc(c.label)+'</span><strong>'+(c.value===null?"—":esc(c.value)+"%")+'</strong><small>'+esc(c.weight)+'% of final grade</small></div>').join("")+'</div>';
}

async function buildRecordSnapshot(bundle,studentId){
  const member=bundle.members.find(x=>x.id===studentId);
  const calc=finalCalculation(bundle,studentId);
  const mastery=bundle.mastery.find(x=>x.id===studentId);
  const narrative=bundle.narratives.find(x=>x.id===studentId);
  const scale=bundle.section.gradingPolicy?.gradeScale||DEFAULT_SCALE;
  let courseVersion="";
  try{
    const courseSnap=await getDoc(doc(db,"courses",bundle.section.courseId));
    if(courseSnap.exists())courseVersion=courseSnap.data().versionLabel||"";
  }catch(_){}
  return {
    studentId,studentName:member?.displayName||"Student",studentEmail:member?.email||"",sectionId:bundle.section.id,
    courseId:bundle.section.courseId,courseCode:bundle.section.courseCode||"",courseTitle:bundle.section.courseTitle||"",
    sectionName:bundle.section.sectionName||"",term:bundle.section.term||"",courseVersion,
    narrativeEvaluation:narrative?.includeOnRecord?{strengths:narrative.strengths||"",recommendations:narrative.recommendations||""}:null,
    pathway:calc.pathway,
    courseworkPercent:calc.coursework.percent,
    generalAssessmentPercent:calc.assessments.percent,
    generalAssessmentCount:calc.assessments.count,
    generalAssessmentTotal:calc.assessments.total,
    semesterExamPercent:calc.semester.percent,
    comprehensiveExamPercent:calc.comprehensive.percent,
    finalPercent:calc.final,
    projectedPercent:calc.projection,
    letterGrade:calc.final===null?"—":letter(calc.final,scale),
    masteryPercent:mastery?.overallPercent??null,
    audit:calc.audit,
    components:calc.components,
    status:"Certified",
    recordId:recordFor(bundle,studentId)?.recordId||idStamp()
  };
}

async function certifyRecord(sectionId,studentId,reason=""){
  invalidate(sectionId);
  const bundle=await loadSectionBundle(sectionId);
  const calc=finalCalculation(bundle,studentId);
  if(!calc.ready)return toast("The final-grade audit is not ready for certification.");
  const prior=recordFor(bundle,studentId),snapshot=await buildRecordSnapshot(bundle,studentId);
  const action=prior?.status==="Certified"?"Amendment":"Certification";
  if(action==="Amendment"&&!reason)return amendmentModal(sectionId,studentId);

  const batch=writeBatch(db);
  batch.set(doc(db,"sections",sectionId,"academicRecords",studentId),{
    ...snapshot,
    status:"Certified",
    certifiedAt:serverTimestamp(),
    certifiedBy:state().user.uid,
    amendmentReason:reason||"",
    version:Number(prior?.version||0)+1,
    updatedAt:serverTimestamp()
  },{merge:true});
  const historyRef=doc(collection(db,"sections",sectionId,"recordHistory"));
  batch.set(historyRef,{
    studentId,action,reason:reason||"",version:Number(prior?.version||0)+1,
    snapshot,createdAt:serverTimestamp(),createdBy:state().user.uid
  });
  await batch.commit();
  if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(sectionId,action==="Amendment"?"academic_record_amended":"academic_record_certified","student",studentId,{reason:reason||"",version:Number(prior?.version||0)+1,finalPercent:snapshot.finalPercent,letterGrade:snapshot.letterGrade});
  invalidate(sectionId);
  toast(action==="Amendment"?"Academic record amended and recertified.":"Final grade certified.");
  if(state().currentSection?.id===sectionId)renderRecords(sectionId);
  if(P4.reportsSectionId===sectionId)renderReportsPage(sectionId);
}


async function withdrawalCertificationModal(sectionId,studentId,options={}){
  invalidate(sectionId);
  const bundle=await loadSectionBundle(sectionId);
  const member=bundle.members.find(x=>x.id===studentId);
  if(!member)return toast("Student not found in this section.");

  const coursework=courseworkPercent(bundle,studentId);
  if(coursework.percent===null){
    return toast("A withdrawal grade cannot be certified until at least one coursework grade is available.");
  }

  const prior=recordFor(bundle,studentId);
  const scale=bundle.section.gradingPolicy?.gradeScale||DEFAULT_SCALE;
  const modal=core().openModal({
    eyebrow:"Withdrawal Certification",
    title:"Certify Withdrawal — "+(member.displayName||"Student"),
    wide:true,
    body:'<form id="withdrawalCertificationForm">'+
      '<div class="academic-banner"><div class="kicker">'+esc(bundle.section.courseCode||"Course")+' • Withdrawal</div><h3>Certify a coursework-only final grade</h3><p>This withdrawal pathway waives semester and comprehensive assessment requirements. The permanent record identifies the grade as a withdrawal certification rather than a normal course-completion certification.</p></div>'+
      '<div class="record-calculation"><div><span>Current Coursework Grade</span><strong>'+esc(coursework.percent)+'%</strong></div><div><span>Assessment Requirement</span><strong>Waived</strong></div><div><span>Current Letter</span><strong>'+esc(letter(coursework.percent,scale))+'</strong></div></div>'+
      '<section class="form-section"><div class="form-section-head"><div><span>01</span><h3>Grade Adjustment Authority</h3><p>You must explicitly decide whether the withdrawal grade may be adjusted.</p></div></div>'+
        '<div class="retake-policy-grid">'+
          '<label class="policy-card"><input type="radio" name="adjustmentMode" value="none" checked><div><strong>No Adjustment Permitted</strong><span>The current coursework percentage becomes the certified withdrawal grade exactly as recorded.</span></div></label>'+
          '<label class="policy-card"><input type="radio" name="adjustmentMode" value="points"><div><strong>Instructor Adjustment Permitted</strong><span>Apply a signed percentage-point adjustment with a permanent written rationale.</span></div></label>'+
        '</div>'+
        '<div class="compact-field-grid" style="margin-top:14px"><div class="field"><label>Adjustment (percentage points)</label><input id="withdrawalAdjustmentPoints" name="adjustmentPoints" type="number" min="-100" max="100" step="0.1" value="0" disabled></div><div class="field"><label>Adjusted Final Preview</label><input id="withdrawalAdjustedPreview" value="'+esc(coursework.percent)+'%" disabled></div></div>'+
        '<div class="field"><label>Adjustment Rationale</label><textarea id="withdrawalAdjustmentReason" name="adjustmentReason" disabled placeholder="Required when an adjustment is applied."></textarea></div>'+
      '</section>'+
      '<section class="form-section"><div class="form-section-head"><div><span>02</span><h3>Withdrawal Documentation</h3><p>The reason and certification basis are preserved in enrollment history and the permanent academic record.</p></div></div>'+
        '<div class="field"><label>Withdrawal Reason</label><textarea name="withdrawalReason" required placeholder="Document the student’s withdrawal request or other basis for ending enrollment.">'+esc(options.requestReason||"")+'</textarea></div>'+
        (options.requestId?'<div class="notice"><strong>Student withdrawal request attached.</strong><p>Approving this certification will resolve the pending request and preserve the student-submitted reason.</p></div>':'')+
        '<label class="checkbox-line"><input type="checkbox" name="acknowledgement" required> I understand that this certification waives the normal assessment requirements for this withdrawal and closes the student’s active enrollment.</label>'+
      '</section>'+
      '<div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="danger-btn" type="submit">Certify Grade & Withdraw Student</button></div>'+
    '</form>'
  });

  const form=modal.querySelector("#withdrawalCertificationForm");
  const pointsInput=modal.querySelector("#withdrawalAdjustmentPoints");
  const reasonInput=modal.querySelector("#withdrawalAdjustmentReason");
  const preview=modal.querySelector("#withdrawalAdjustedPreview");

  const refreshAdjustment=()=>{
    const mode=form.querySelector('input[name="adjustmentMode"]:checked')?.value||"none";
    const enabled=mode==="points";
    pointsInput.disabled=!enabled;
    reasonInput.disabled=!enabled;
    const points=enabled?Number(pointsInput.value||0):0;
    const adjusted=round(Number(coursework.percent)+points);
    preview.value=(Number.isFinite(adjusted)?adjusted:coursework.percent)+"%";
  };
  form.querySelectorAll('input[name="adjustmentMode"]').forEach(x=>x.addEventListener("change",refreshAdjustment));
  pointsInput.addEventListener("input",refreshAdjustment);

  form.addEventListener("submit",async e=>{
    e.preventDefault();
    const fd=new FormData(form);
    const mode=String(fd.get("adjustmentMode")||"none");
    const adjustment=mode==="points"?round(Number(fd.get("adjustmentPoints")||0)):0;
    const adjustmentReason=String(fd.get("adjustmentReason")||"").trim();
    const withdrawalReason=String(fd.get("withdrawalReason")||"").trim();
    if(!withdrawalReason)return toast("Enter the withdrawal reason before certification.");
    if(mode==="points"&&adjustment!==0&&!adjustmentReason)return toast("A written rationale is required for a grade adjustment.");

    const finalPercent=round(Number(coursework.percent)+adjustment);
    if(!Number.isFinite(finalPercent)||finalPercent<0||finalPercent>100){
      return toast("The adjusted withdrawal grade must remain between 0% and 100%.");
    }

    const mastery=bundle.mastery.find(x=>x.id===studentId);
    const narrative=bundle.narratives.find(x=>x.id===studentId);
    let courseVersion="";
    try{
      const courseSnap=await getDoc(doc(db,"courses",bundle.section.courseId));
      if(courseSnap.exists())courseVersion=courseSnap.data().versionLabel||"";
    }catch(_){}

    const version=Number(prior?.version||0)+1;
    const recordId=prior?.recordId||idStamp();
    const gradeLetter=letter(finalPercent,scale);
    const snapshot={
      studentId,studentName:member.displayName||"Student",studentEmail:member.email||"",
      sectionId:bundle.section.id,courseId:bundle.section.courseId,courseCode:bundle.section.courseCode||"",
      courseTitle:bundle.section.courseTitle||"",sectionName:bundle.section.sectionName||"",term:bundle.section.term||"",
      courseVersion,recordId,version,status:"Certified",recordType:"Withdrawal",enrollmentOutcome:"Withdrawn",
      certificationBasis:"Coursework at withdrawal",assessmentRequirementWaived:true,
      withdrawalReason,withdrawalCertified:true,
      pathway:"withdrawal-coursework",courseworkPercent:coursework.percent,
      generalAssessmentPercent:null,generalAssessmentCount:0,generalAssessmentTotal:0,
      semesterExamPercent:null,comprehensiveExamPercent:null,
      rawWithdrawalPercent:coursework.percent,gradeAdjustmentMode:mode,
      gradeAdjustmentPoints:adjustment,gradeAdjustmentReason:adjustmentReason,
      finalPercent,projectedPercent:coursework.percent,letterGrade:gradeLetter,
      masteryPercent:mastery?.overallPercent??null,
      narrativeEvaluation:narrative?.includeOnRecord?{strengths:narrative.strengths||"",recommendations:narrative.recommendations||""}:null,
      audit:[
        {id:"coursework",label:"Coursework grade available at withdrawal",ok:true},
        {id:"assessments-waived",label:"Assessment requirements waived for withdrawal",ok:true},
        {id:"adjustment",label:mode==="points"?"Instructor adjustment decision documented":"Instructor chose no grade adjustment",ok:true}
      ],
      components:[{key:"coursework",label:"Coursework at Withdrawal",value:coursework.percent,weight:100}]
    };

    try{
      const batch=writeBatch(db);
      batch.set(doc(db,"sections",sectionId,"academicRecords",studentId),{
        ...snapshot,
        certifiedAt:serverTimestamp(),certifiedBy:state().user.uid,
        amendmentReason:prior?"Withdrawal certification superseded the prior record.":"",
        updatedAt:serverTimestamp()
      },{merge:true});
      batch.set(doc(collection(db,"sections",sectionId,"recordHistory")),{
        studentId,
        action:prior?"Withdrawal Certification / Amendment":"Withdrawal Certification",
        reason:withdrawalReason,version,snapshot,
        createdAt:serverTimestamp(),createdBy:state().user.uid
      });
      batch.set(doc(db,"users",studentId,"enrollments",sectionId),{
        sectionId,courseId:bundle.section.courseId,courseCode:bundle.section.courseCode||"",
        courseTitle:bundle.section.courseTitle||"",sectionName:bundle.section.sectionName||"",
        term:bundle.section.term||"",status:"Withdrawn",endedAt:serverTimestamp(),
        certifiedFinalPercent:finalPercent,certifiedLetterGrade:gradeLetter,
        withdrawalCertified:true,updatedAt:serverTimestamp()
      },{merge:true});
      batch.set(doc(collection(db,"sections",sectionId,"enrollmentHistory")),{
        studentId,studentName:member.displayName||"Student",studentEmail:member.email||"",
        status:"Withdrawn",reason:withdrawalReason,
        actorId:state().user.uid,actorName:state().profile?.displayName||state().user.displayName||"Instructor",
        withdrawalCertified:true,finalPercent,letterGrade:gradeLetter,
        courseworkPercent:coursework.percent,assessmentRequirementWaived:true,
        gradeAdjustmentMode:mode,gradeAdjustmentPoints:adjustment,
        gradeAdjustmentReason:adjustmentReason,recordId,recordVersion:version,
        withdrawalRequestId:options.requestId||"",
        createdAt:serverTimestamp()
      });
      if(options.requestId){
        batch.set(doc(db,"sections",sectionId,"withdrawalRequests",options.requestId),{
          status:"Certified",resolvedAt:serverTimestamp(),resolvedBy:state().user.uid,
          certifiedFinalPercent:finalPercent,certifiedLetterGrade:gradeLetter,
          recordId,recordVersion:version,instructorReason:withdrawalReason,
          updatedAt:serverTimestamp()
        },{merge:true});
      }
      batch.delete(doc(db,"sections",sectionId,"members",studentId));
      await batch.commit();

      if(window.TheoriaPhase5?.logSectionEvent){
        await window.TheoriaPhase5.logSectionEvent(sectionId,"withdrawal_grade_certified","student",studentId,{
          withdrawalReason,courseworkPercent:coursework.percent,finalPercent,
          letterGrade:gradeLetter,adjustmentMode:mode,adjustmentPoints:adjustment,
          assessmentRequirementWaived:true,recordId,version,withdrawalRequestId:options.requestId||""
        });
      }

      core().closeModal();
      invalidate(sectionId);
      if(state().currentSection?.id===sectionId)await core().reloadCurrentSection("students");
      toast((member.displayName||"Student")+" was withdrawn with a certified "+gradeLetter+" ("+finalPercent+"%) final grade.");
    }catch(error){
      toast(error.message||"Unable to certify the withdrawal.");
    }
  });
}

function amendmentModal(sectionId,studentId){
  const modal=core().openModal({
    eyebrow:"Academic Record Amendment",
    title:"Certify an Amendment",
    body:'<div class="notice">This record is already certified. A new calculation will not silently replace it; the reason below will be preserved in the permanent record history.</div><form id="amendRecordForm"><div class="field"><label>Reason for Amendment</label><textarea name="reason" required placeholder="Explain the grade correction, resolved appeal, data correction, or other basis for this amendment."></textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Certify Amendment</button></div></form>'
  });
  modal.querySelector("#amendRecordForm").addEventListener("submit",async e=>{
    e.preventDefault();const reason=String(new FormData(e.currentTarget).get("reason")||"").trim();if(!reason)return;
    core().closeModal();await certifyRecord(sectionId,studentId,reason);
  });
}

async function markIncompleteRecord(sectionId,studentId){
  const bundle=await loadSectionBundle(sectionId),member=bundle.members.find(x=>x.id===studentId);
  if(!member)return toast("Student not found.");
  const prior=recordFor(bundle,studentId);
  const reason=await window.TheoriaDialog.prompt("Reason for the Incomplete status?")?.trim();
  if(!reason)return;
  const version=Number(prior?.version||0)+1;
  const snapshot={
    studentId,studentName:member.displayName||"Student",studentEmail:member.email||"",
    sectionId,courseId:bundle.section.courseId,courseCode:bundle.section.courseCode||"",courseTitle:bundle.section.courseTitle||"",
    sectionName:bundle.section.sectionName||"",term:bundle.section.term||"",
    status:"Incomplete",incompleteReason:reason,recordId:prior?.recordId||idStamp(),version
  };
  const batch=writeBatch(db);
  batch.set(doc(db,"sections",sectionId,"academicRecords",studentId),{
    ...snapshot,updatedAt:serverTimestamp(),updatedBy:state().user.uid
  },{merge:true});
  batch.set(doc(collection(db,"sections",sectionId,"recordHistory")),{
    studentId,action:"Incomplete",reason,version,snapshot,createdAt:serverTimestamp(),createdBy:state().user.uid
  });
  await batch.commit();
  if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(sectionId,"academic_record_incomplete","student",studentId,{reason,version});
  invalidate(sectionId);toast("Academic record marked Incomplete.");
  await refreshRecordContext(sectionId);
}

function recordStatusCard(bundle,member){
  const calc=finalCalculation(bundle,member.id),record=recordFor(bundle,member.id),mastery=bundle.mastery.find(x=>x.id===member.id);
  return '<tr><td><strong>'+esc(member.displayName||"Student")+'</strong><span class="grade-sub">'+esc(calc.pathway==="examination"?"Examination Pathway":calc.pathway==="composite"?"Composite Pathway":"No pathway selected")+'</span></td>'+
    '<td>'+(calc.coursework.percent===null?"—":calc.coursework.percent+"%")+'</td><td>'+(calc.assessments.total?(calc.assessments.percent===null?"—":calc.assessments.percent+"%"):"N/A")+'</td><td>'+(calc.semester.percent===null?"—":calc.semester.percent+"%")+'</td><td>'+(calc.comprehensive.percent===null?"—":calc.comprehensive.percent+"%")+'</td>'+
    '<td><strong>'+(calc.final===null?(calc.projection===null?"—":calc.projection+"%*"):calc.final+"%")+'</strong></td><td>'+(mastery?.overallPercent===null||mastery?.overallPercent===undefined?"—":mastery.overallPercent+"%")+'</td>'+
    '<td><span class="badge '+(record?.status==="Certified"?'live':calc.ready?'gold':'')+'">'+esc(record?.status|| (calc.ready?"Ready":"Incomplete"))+'</span></td>'+
    '<td><div class="inline-actions"><button class="text-btn" data-phase4-action="record-audit" data-section="'+bundle.section.id+'" data-student="'+member.id+'">Audit</button>'+(calc.ready?'<button class="primary-btn small-btn" data-phase4-action="certify-record" data-section="'+bundle.section.id+'" data-student="'+member.id+'">'+(record?.status==="Certified"?"Recalculate / Amend":"Certify")+'</button>':record?.status!=="Certified"?'<button class="secondary-btn small-btn" data-phase4-action="mark-incomplete" data-section="'+bundle.section.id+'" data-student="'+member.id+'">Mark Incomplete</button>':'')+'<button class="text-btn" data-phase4-action="portfolio" data-section="'+bundle.section.id+'" data-student="'+member.id+'">Portfolio</button></div></td></tr>';
}

async function renderRecords(sectionId,targetSelector="#phase4SectionTab"){
  const el=$(targetSelector);if(!el)return;
  const bundle=await loadSectionBundle(sectionId);
  const pending=bundle.appeals.filter(x=>x.status==="Pending"||x.status==="Under Review");
  el.innerHTML='<div class="section-summary"><div class="summary-block"><div class="summary-label">Students</div><div class="summary-value">'+bundle.members.length+'</div></div><div class="summary-block"><div class="summary-label">Ready to Certify</div><div class="summary-value">'+bundle.members.filter(m=>finalCalculation(bundle,m.id).ready).length+'</div></div><div class="summary-block"><div class="summary-label">Certified</div><div class="summary-value">'+bundle.records.filter(r=>r.status==="Certified").length+'</div></div><div class="summary-block"><div class="summary-label">Open Appeals</div><div class="summary-value">'+pending.length+'</div></div></div>'+
    '<div class="data-table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Coursework</th><th>General Assessments</th><th>Semester Exam</th><th>Comprehensive</th><th>Final / Projection</th><th>Mastery</th><th>Record</th><th>Action</th></tr></thead><tbody>'+bundle.members.map(m=>recordStatusCard(bundle,m)).join("")+'</tbody></table></div>'+
    '<div class="panel" style="margin-top:18px"><div class="panel-head"><div class="panel-title">Grade Appeals</div></div><div class="panel-body">'+(pending.length?pending.map(a=>'<div class="appeal-row"><div><strong>'+esc(a.studentName||"Student")+' — '+esc(a.title||"Grade Appeal")+'</strong><span>'+esc(a.reason||"")+'</span><small>'+esc(a.targetType||"Coursework")+' • '+esc(a.status)+'</small></div><button class="secondary-btn small-btn" data-phase4-action="review-appeal" data-section="'+sectionId+'" data-id="'+a.id+'">Review</button></div>').join(""):'<div class="empty-mini">No unresolved grade appeals.</div>')+'</div></div>';
}

function auditModal(sectionId,studentId){
  loadSectionBundle(sectionId).then(bundle=>{
    const member=bundle.members.find(x=>x.id===studentId),calc=finalCalculation(bundle,studentId),record=recordFor(bundle,studentId);
    core().openModal({
      eyebrow:"Final Grade Audit",
      title:member?.displayName||"Student",
      wide:true,
      body:'<div class="record-calculation"><div><span>Current Projection</span><strong>'+(calc.projection===null?"—":esc(calc.projection)+"%")+'</strong></div><div><span>Certified Calculation</span><strong>'+(calc.final===null?"Pending":esc(calc.final)+"%")+'</strong></div><div><span>Pathway</span><strong>'+esc(calc.pathway==="examination"?"Examination":calc.pathway==="composite"?"Composite":"Not selected")+'</strong></div></div>'+componentHtml(calc)+'<div class="panel-title" style="margin:20px 0 10px">Certification Audit</div>'+auditHtml(calc)+(record?'<div class="notice" style="margin-top:16px">Current certified record: '+esc(record.recordId)+' • Version '+esc(record.version||1)+' • '+esc(record.letterGrade)+' ('+esc(record.finalPercent)+'%)</div>':'')
    });
  });
}

async function portfolioModal(sectionId,studentId){
  const bundle=await loadSectionBundle(sectionId),member=bundle.members.find(x=>x.id===studentId),existing=portfolioFor(bundle,studentId);
  const gradeRows=bundle.grades.filter(g=>g.studentId===studentId).map(g=>{
    const a=bundle.assignments.find(x=>x.id===g.assignmentId);
    return {type:"Coursework",id:g.assignmentId,title:a?.title||g.assignmentTitle||"Assignment",percent:a?.points?pct(g.score,a.points):null};
  });
  const assessmentRows=bundle.assessmentGrades.filter(g=>g.studentId===studentId).map(g=>({type:"Assessment",id:g.assessmentId,title:g.assessmentTitle,percent:g.percent}));
  const best=[...gradeRows,...assessmentRows].filter(x=>x.percent!==null).sort((a,b)=>b.percent-a.percent).slice(0,5);
  const modal=core().openModal({
    eyebrow:"Academic Portfolio",
    title:member?.displayName||"Student",
    wide:true,
    body:'<form id="portfolioForm"><div class="academic-banner"><div class="kicker">Suggested Featured Work</div><h3>Highest-performing academic work</h3><p>Theoria references existing Firestore records; no file-storage system is required.</p></div><div class="portfolio-work-list">'+best.map((x,i)=>'<label class="portfolio-work"><input type="checkbox" name="work" value="'+esc(x.type+"|"+x.id+"|"+x.title+"|"+x.percent)+'" '+((existing?.featuredWorks||[]).some(w=>w.id===x.id)?'checked':'')+'><div><strong>'+esc(x.title)+'</strong><span>'+esc(x.type)+' • '+esc(x.percent)+'%</span></div></label>').join("")+'</div><div class="field" style="margin-top:16px"><label>Instructor Portfolio Commentary</label><textarea name="comment" placeholder="Summarize the student’s strongest academic work, growth, and theological competencies.">'+esc(existing?.instructorComment||"")+'</textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Portfolio</button></div></form>'
  });
  modal.querySelector("#portfolioForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    const works=fd.getAll("work").map(v=>{const [type,id,title,percent]=String(v).split("|");return {type,id,title,percent:Number(percent)};});
    try{await setDoc(doc(db,"sections",sectionId,"portfolios",studentId),{studentId,studentName:member?.displayName||"Student",featuredWorks:works,instructorComment:String(fd.get("comment")||"").trim(),updatedAt:serverTimestamp(),updatedBy:state().user.uid},{merge:true});if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(sectionId,"academic_portfolio_updated","student",studentId,{featuredWorkCount:works.length});core().closeModal();invalidate(sectionId);toast("Academic portfolio saved.");}catch(err){toast(err.message||"Unable to save portfolio.");}
  });
}

async function recordHistoryModal(sectionId,studentId){
  const snap=await getDocs(query(collection(db,"sections",sectionId,"recordHistory"),where("studentId","==",studentId)));
  const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
  core().openModal({
    eyebrow:"Record History",
    title:"Certification & Amendments",
    wide:true,
    body:rows.length?'<div class="timeline">'+rows.map(r=>'<div class="timeline-item"><div class="timeline-dot"></div><div><strong>'+esc(r.action)+' • Version '+esc(r.version||1)+'</strong><span>'+esc(dateText(r.createdAt))+'</span><p>'+esc(r.reason||"Initial certification")+'</p><small>'+esc(r.snapshot?.letterGrade||"—")+' • '+esc(r.snapshot?.finalPercent??"—")+'%</small></div></div>').join("")+'</div>':'<div class="empty-mini">No record history yet.</div>'
  });
}

async function renderStudentRecord(sectionId,targetSelector="#phase4SectionTab"){
  const el=$(targetSelector);if(!el)return;
  const bundle=await loadSectionBundle(sectionId),uid=state().user.uid,calc=finalCalculation(bundle,uid),record=recordFor(bundle,uid),portfolio=portfolioFor(bundle,uid),mastery=bundle.mastery.find(x=>x.id===uid);
  const appeals=bundle.appeals.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
  el.innerHTML='<div class="record-calculation"><div><span>Coursework</span><strong>'+(calc.coursework.percent===null?"—":calc.coursework.percent+"%")+'</strong></div><div><span>General Assessments</span><strong>'+(calc.assessments.total?(calc.assessments.percent===null?"—":calc.assessments.percent+"%"):"N/A")+'</strong></div><div><span>Semester I Exam</span><strong>'+(calc.semester.percent===null?"—":calc.semester.percent+"%")+'</strong></div><div><span>Comprehensive Final</span><strong>'+(calc.comprehensive.percent===null?"—":calc.comprehensive.percent+"%")+'</strong></div><div><span>Current Projection</span><strong>'+(calc.projection===null?"—":calc.projection+"%")+'</strong></div></div>'+
    (record?.status==="Incomplete"?'<div class="academic-banner"><div class="kicker">Academic Record</div><h3>Incomplete</h3><p>'+esc(record.incompleteReason||"Additional academic work or evaluation is required before a final grade can be certified.")+'</p></div>'+componentHtml(calc):record?formalRecordHtml(record,portfolio,mastery,true):'<div class="academic-banner"><div class="kicker">Academic Record</div><h3>Your final grade has not been certified.</h3><p>Your current grades and pathway remain visible while required components are completed.</p></div>'+componentHtml(calc))+
    '<div class="grid-2" style="margin-top:18px"><div class="panel"><div class="panel-head"><div class="panel-title">Academic Portfolio</div></div><div class="panel-body">'+portfolioHtml(portfolio)+'</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Grade Appeals</div><button class="panel-link" data-phase4-action="new-appeal" data-section="'+sectionId+'">New Appeal</button></div><div class="panel-body">'+(appeals.length?appeals.map(a=>'<div class="appeal-mini"><strong>'+esc(a.title||"Grade Appeal")+'</strong><span>'+esc(a.status||"Pending")+' • '+esc(dateText(a.createdAt))+'</span><p>'+esc(a.reason||"")+'</p>'+(a.decision?'<small>Decision: '+esc(a.decision)+'</small>':'')+'</div>').join(""):'<div class="empty-mini">No grade appeals submitted.</div>')+'</div></div></div>';
}

function formalRecordHtml(record,portfolio,mastery,studentView=false){
  return '<article class="formal-record" id="formalAcademicRecord"><div class="record-seal">Θ</div><div class="record-heading"><div class="eyebrow">Theoria Academic Record</div><h2>'+esc(record.courseCode)+' — '+esc(record.courseTitle)+'</h2><p>'+esc(record.sectionName)+' • '+esc(record.term)+'</p></div><div class="record-identity"><div><span>Student</span><strong>'+esc(record.studentName)+'</strong></div><div><span>Record ID</span><strong>'+esc(record.recordId)+'</strong></div><div><span>Status</span><strong>'+esc(record.status)+'</strong></div><div><span>Version</span><strong>'+esc(record.version||1)+'</strong></div></div><div class="record-final"><div><span>Certified Final Grade</span><strong>'+esc(record.letterGrade)+'</strong><small>'+esc(record.finalPercent)+'%</small></div><div><span>Academic Mastery</span><strong>'+(record.masteryPercent===null||record.masteryPercent===undefined?"—":esc(record.masteryPercent)+"%")+'</strong><small>Separate from grade</small></div><div><span>Grading Basis</span><strong class="record-path">'+esc(record.pathway==="examination"?"Examination":record.pathway==="withdrawal-coursework"?"Withdrawal Coursework":"Composite")+'</strong></div></div><div class="record-breakdown"><div><span>Coursework</span><strong>'+(record.courseworkPercent===null?"N/A":esc(record.courseworkPercent)+"%")+'</strong></div><div><span>General Assessments</span><strong>'+(record.recordType==="Withdrawal"?"Waived":record.generalAssessmentTotal===0?"N/A":record.generalAssessmentPercent===null||record.generalAssessmentPercent===undefined?"—":esc(record.generalAssessmentPercent)+"%")+'</strong></div><div><span>Semester I Examination</span><strong>'+(record.semesterExamPercent===null||record.semesterExamPercent===undefined?"Waived":esc(record.semesterExamPercent)+"%")+'</strong></div><div><span>Comprehensive Final Examination</span><strong>'+(record.comprehensiveExamPercent===null||record.comprehensiveExamPercent===undefined?"Waived":esc(record.comprehensiveExamPercent)+"%")+'</strong></div></div>'+(record.courseVersion?'<div class="notice" style="margin-top:14px"><strong>Course Version</strong><p>'+esc(record.courseVersion)+'</p></div>':'')+(record.narrativeEvaluation?'<div class="record-narrative"><div><span>Instructor Narrative — Strengths</span><p>'+esc(record.narrativeEvaluation.strengths||"")+'</p></div><div><span>Growth / Recommendations</span><p>'+esc(record.narrativeEvaluation.recommendations||"")+'</p></div></div>':'')+'<div class="record-footer"><p>This record documents academic performance within Theoria. It does not represent outside accreditation unless separately established by the issuing institution.</p><div class="inline-actions"><button class="secondary-btn small-btn" data-phase4-action="print-record">Print Record</button>'+(studentView?'<button class="text-btn" data-phase4-action="record-history" data-section="'+esc(record.sectionId||"")+'" data-student="'+esc(record.studentId)+'">View Amendment History</button>':'')+'</div></div></article>';
}

function portfolioHtml(portfolio){
  if(!portfolio)return '<div class="empty-mini">No academic portfolio has been curated yet.</div>';
  return (portfolio.featuredWorks||[]).map(x=>'<div class="portfolio-entry"><span>'+esc(x.type)+'</span><strong>'+esc(x.title)+'</strong><b>'+esc(x.percent)+'%</b></div>').join("")+(portfolio.instructorComment?'<div class="portfolio-comment"><div class="eyebrow">Instructor Commentary</div><p>'+esc(portfolio.instructorComment)+'</p></div>':'');
}

async function refreshRecordContext(sectionId){
  invalidate(sectionId);
  if(P4.reportsSectionId===sectionId && $("#page-reports")?.classList.contains("active")){
    return renderReportsPage(sectionId);
  }
  if(state().currentSection?.id===sectionId){
    return state().role==="instructor" ? renderRecords(sectionId) : renderStudentRecord(sectionId);
  }
}

function newAppealModal(sectionId){
  const bundlePromise=loadSectionBundle(sectionId);
  bundlePromise.then(bundle=>{
    const uid=state().user.uid;
    const ordinary=bundle.grades.filter(g=>g.studentId===uid).map(g=>({type:"Coursework",id:g.assignmentId,title:bundle.assignments.find(a=>a.id===g.assignmentId)?.title||g.assignmentTitle||"Assignment",score:g.score}));
    const exams=bundle.assessmentGrades.filter(g=>g.studentId===uid).map(g=>({type:"Assessment",id:g.assessmentId,title:g.assessmentTitle||"Assessment",score:g.percent+"%"}));
    const options=[...ordinary,...exams];
    const modal=core().openModal({
      eyebrow:"Grade Appeal",
      title:"Request Reconsideration",
      body:'<form id="appealForm"><div class="field"><label>Academic Item</label><select name="target">'+options.map(x=>'<option value="'+esc(x.type+"|"+x.id+"|"+x.title)+'">'+esc(x.title+" — "+x.score)+'</option>').join("")+'</select></div><div class="field"><label>Reason for Appeal</label><textarea name="reason" required placeholder="Explain specifically what you believe should be reconsidered and why."></textarea></div><div class="notice">Submitting an appeal does not automatically change a score. The instructor’s decision and any resulting amendment will remain in the academic audit history.</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Submit Appeal</button></div></form>'
    });
    modal.querySelector("#appealForm").addEventListener("submit",async e=>{
      e.preventDefault();const fd=new FormData(e.currentTarget),[targetType,targetId,title]=String(fd.get("target")).split("|");
      try{await addDoc(collection(db,"sections",sectionId,"appeals"),{studentId:uid,studentName:state().profile.displayName||state().user.displayName||"Student",targetType,targetId,title,reason:String(fd.get("reason")||"").trim(),status:"Pending",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(sectionId,"grade_appeal_submitted",targetType,targetId,{studentId:uid,title});core().closeModal();toast("Grade appeal submitted.");await refreshRecordContext(sectionId);}catch(err){toast(err.message||"Unable to submit appeal.");}
    });
  });
}

async function reviewAppealModal(sectionId,appealId){
  const bundle=await loadSectionBundle(sectionId),appeal=bundle.appeals.find(x=>x.id===appealId);if(!appeal)return;
  const modal=core().openModal({
    eyebrow:"Grade Appeal Review",
    title:appeal.studentName+" — "+appeal.title,
    body:'<div class="academic-banner"><div class="kicker">'+esc(appeal.targetType)+'</div><h3>'+esc(appeal.title)+'</h3><p>'+esc(appeal.reason)+'</p></div><form id="appealReviewForm"><div class="field"><label>Decision Status</label><select name="status"><option>Under Review</option><option>Resolved</option><option>Denied</option></select></div><div class="field"><label>Instructor Decision</label><textarea name="decision" required>'+esc(appeal.decision||"")+'</textarea></div><div class="notice">If the appeal changes a grade, update the grade in the relevant Gradebook/Assessment workspace. Then recalculate and certify an amendment to any already-certified academic record.</div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Decision</button></div></form>'
  });
  modal.querySelector("#appealReviewForm").addEventListener("submit",async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget);
    try{await updateDoc(doc(db,"sections",sectionId,"appeals",appealId),{status:String(fd.get("status")),decision:String(fd.get("decision")).trim(),decidedAt:serverTimestamp(),decidedBy:state().user.uid,updatedAt:serverTimestamp()});if(window.TheoriaPhase5?.logSectionEvent)await window.TheoriaPhase5.logSectionEvent(sectionId,"grade_appeal_decided",appeal.targetType||"appeal",appeal.targetId||appealId,{studentId:appeal.studentId,status:String(fd.get("status")),decision:String(fd.get("decision")).trim()});core().closeModal();toast("Appeal decision saved.");await refreshRecordContext(sectionId);}catch(err){toast(err.message||"Unable to save decision.");}
  });
}

/* -------------------- REPORTS PAGE -------------------- */

async function renderReportsPage(sectionId=P4.reportsSectionId){
  const el=$("#reportsContent");if(!el)return;
  const s=state();
  if(!sectionId){
    el.innerHTML='<div class="record-card-grid">'+s.sections.map(sec=>'<article class="academic-card"><div class="card-kicker">'+esc(sec.courseCode||"THEO")+' • '+esc(sec.term||"")+'</div><h3>'+esc(sec.courseTitle||sec.sectionName)+'</h3><p>'+esc(sec.sectionName||"")+'</p><div class="card-actions"><button class="secondary-btn small-btn" data-phase4-action="open-report-section" data-section="'+sec.id+'">'+(s.role==="instructor"?"Open Records":"View Academic Record")+'</button></div></article>').join("")+'</div>';
    return;
  }
  P4.reportsSectionId=sectionId;
  const bundle=await loadSectionBundle(sectionId);
  if(s.role==="instructor"){
    el.innerHTML='<button class="text-btn" data-phase4-action="reports-back">← All Sections</button><div class="detail-hero"><div class="eyebrow">'+esc(bundle.section.courseCode||"Course")+' • '+esc(bundle.section.term||"")+'</div><h1 class="detail-title">'+esc(bundle.section.courseTitle||"Section")+'</h1><p class="page-subtitle">Final-grade audits, certification, portfolios, and record amendments.</p></div><div id="reportsRecordBody"></div>';
    await renderRecords(sectionId,"#reportsRecordBody");
  }else{
    el.innerHTML='<button class="text-btn" data-phase4-action="reports-back">← All Sections</button><div class="detail-hero"><div class="eyebrow">'+esc(bundle.section.courseCode||"Course")+' • '+esc(bundle.section.term||"")+'</div><h1 class="detail-title">'+esc(bundle.section.courseTitle||"Section")+'</h1><p class="page-subtitle">Your progress, portfolio, and certified academic record.</p></div><div id="studentReportBody"></div>';
    await renderStudentRecord(sectionId,"#studentReportBody");
  }
}

/* -------------------- SECTION TABS -------------------- */

async function renderProgress(sectionId){
  const el=$("#phase4SectionTab");if(!el)return;
  const bundle=await loadSectionBundle(sectionId),uid=state().user.uid,calc=finalCalculation(bundle,uid),mastery=bundle.mastery.find(x=>x.id===uid);
  el.innerHTML='<div class="record-calculation"><div><span>Coursework Grade</span><strong>'+(calc.coursework.percent===null?"—":calc.coursework.percent+"%")+'</strong></div><div><span>General Assessments</span><strong>'+(calc.assessments.total?(calc.assessments.percent===null?"—":calc.assessments.percent+"%"):"N/A")+'</strong></div><div><span>Semester Exam</span><strong>'+(calc.semester.percent===null?"—":calc.semester.percent+"%")+'</strong></div><div><span>Comprehensive Final</span><strong>'+(calc.comprehensive.percent===null?"—":calc.comprehensive.percent+"%")+'</strong></div><div><span>Current Final Projection</span><strong>'+(calc.projection===null?"—":calc.projection+"%")+'</strong></div></div><div class="grid-2"><div class="panel"><div class="panel-head"><div class="panel-title">Grading Pathway Projection</div></div><div class="panel-body">'+componentHtml(calc)+'<div class="notice" style="margin-top:14px">A projection uses only currently available components. It is not a certified final grade.</div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Academic Mastery</div></div><div class="panel-body">'+(mastery?masteryBars(mastery.competencies):'<div class="empty-mini">No mastery snapshot calculated yet.</div>')+'</div></div></div>';
}

async function renderSectionTab(tab){
  const sectionId=state()?.currentSection?.id;if(!sectionId)return;
  if(tab==="analytics")return renderAnalytics(sectionId);
  if(tab==="records")return renderRecords(sectionId);
  if(tab==="progress")return renderProgress(sectionId);
  if(tab==="record")return renderStudentRecord(sectionId);
}

/* -------------------- EVENTS -------------------- */

function bind(){
  if(P4.ready)return;P4.ready=true;
  $("#refreshMasteryBtn")?.addEventListener("click",async()=>{
    if(!P4.masterySectionId)return toast("Open a section mastery report first.");
    await recomputeMastery(P4.masterySectionId);await renderMasteryPage(P4.masterySectionId);
  });
}

async function onReady(){
  bind();
  if($("#page-mastery")?.classList.contains("active"))await renderMasteryPage();
  if($("#page-reports")?.classList.contains("active"))await renderReportsPage();
}

window.addEventListener("theoria:ready",onReady);
window.addEventListener("theoria:page",async e=>{
  if(e.detail.page==="mastery")await renderMasteryPage();
  if(e.detail.page==="reports")await renderReportsPage();
});

document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-phase4-action]");if(!b)return;
  const a=b.dataset.phase4Action;
  if(a==="open-mastery-section"){P4.masterySectionId=b.dataset.section;return renderMasteryPage(b.dataset.section);}
  if(a==="mastery-back"){P4.masterySectionId=null;return renderMasteryPage();}
  if(a==="mastery-student")return masteryStudentModal(b.dataset.student);
  if(a==="open-report-section"){P4.reportsSectionId=b.dataset.section;return renderReportsPage(b.dataset.section);}
  if(a==="reports-back"){P4.reportsSectionId=null;return renderReportsPage();}
  if(a==="record-audit")return auditModal(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.student);
  if(a==="certify-record")return certifyRecord(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.student);
  if(a==="mark-incomplete")return markIncompleteRecord(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.student);
  if(a==="portfolio")return portfolioModal(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.student);
  if(a==="record-history")return recordHistoryModal(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.student);
  if(a==="new-appeal")return newAppealModal(b.dataset.section||P4.reportsSectionId||state().currentSection?.id);
  if(a==="review-appeal")return reviewAppealModal(b.dataset.section||P4.reportsSectionId||state().currentSection?.id,b.dataset.id);
  if(a==="print-record"){window.print();return;}
});

window.TheoriaPhase4={renderSectionTab,renderMasteryPage,renderReportsPage,recomputeMastery,invalidate,withdrawalCertificationModal};

if(window.TheoriaCore)onReady();
