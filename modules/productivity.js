import {
  db, doc, getDoc, setDoc, addDoc, updateDoc,
  collection, getDocs, query, where, serverTimestamp, Timestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const esc=v=>window.TheoriaCore?.esc?.(v)??String(v??"");
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();

function dateOnly(value){
  if(!value)return "";
  if(typeof value==="string")return value.slice(0,10);
  const d=value?.toDate?value.toDate():new Date(value);
  return Number.isNaN(d.getTime())?"":d.toISOString().slice(0,10);
}
function dateTime(value){
  if(!value)return "";
  const d=value?.toDate?value.toDate():new Date(value);
  return Number.isNaN(d.getTime())?"":d.toLocaleString(undefined,{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
}
function parseLocalDate(value,end=false){
  if(!value)return null;
  if(value?.toDate)return value.toDate();
  const raw=String(value);
  const d=new Date(raw.length<=10?raw+(end?"T23:59:59":"T00:00:00"):raw);
  return Number.isNaN(d.getTime())?null:d;
}
function daysFromNow(date){
  const d=parseLocalDate(date);if(!d)return null;
  const now=new Date();now.setHours(0,0,0,0);d.setHours(0,0,0,0);
  return Math.round((d-now)/86400000);
}
function stableId(value){
  let h=2166136261;
  for(const ch of String(value||"")){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
  return "n_"+(h>>>0).toString(36);
}
function sectionById(id){return state()?.sections?.find(x=>x.id===id)||null;}
function isInstructor(){return state()?.role==="instructor";}

async function getCollection(pathParts){
  try{
    const snap=await getDocs(collection(db,...pathParts));
    return snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(_){return [];}
}

async function loadSectionProductivity(section){
  const sid=section.id;
  const [assignments,refs,announcements,events,extensions]=await Promise.all([
    getCollection(["sections",sid,"assignments"]),
    getCollection(["sections",sid,"assessmentRefs"]),
    getCollection(["sections",sid,"announcements"]),
    getCollection(["sections",sid,"events"]),
    getCollection(["sections",sid,"extensions"])
  ]);
  return {section,assignments,refs,announcements,events,extensions};
}

async function plannerItems(){
  const s=state();if(!s?.user)return [];
  const rows=[];
  for(const section of (s.sections||[]).filter(x=>x.status!=="Archived")){
    const data=await loadSectionProductivity(section);
    const userExtension=new Map(data.extensions.filter(x=>x.studentId===s.user.uid).map(x=>[x.assignmentId,x]));
    for(const a of data.assignments){
      if(s.role==="student"&&a.status==="Draft")continue;
      const ext=userExtension.get(a.id);
      const due=ext?.dueDate||a.dueDate||"";
      if(due)rows.push({
        kind:"Assignment",sectionId:section.id,sectionName:section.sectionName||section.courseTitle,
        courseCode:section.courseCode,title:a.title,date:due,sortDate:parseLocalDate(due,true),
        meta:(ext?"Extended deadline • ":"")+(a.gradingPeriod||"Overall"),id:a.id
      });
    }
    for(const a of data.refs){
      if(a.status==="Draft")continue;
      if(a.opensAt)rows.push({kind:"Assessment Opens",sectionId:section.id,sectionName:section.sectionName||section.courseTitle,courseCode:section.courseCode,title:a.title,date:a.opensAt,sortDate:parseLocalDate(a.opensAt),meta:a.assessmentType||a.type||"Assessment",id:a.id});
      if(a.closesAt)rows.push({kind:"Assessment Closes",sectionId:section.id,sectionName:section.sectionName||section.courseTitle,courseCode:section.courseCode,title:a.title,date:a.closesAt,sortDate:parseLocalDate(a.closesAt),meta:a.assessmentType||a.type||"Assessment",id:a.id});
    }
    for(const e of data.events){
      rows.push({kind:e.type||"Course Event",sectionId:section.id,sectionName:section.sectionName||section.courseTitle,courseCode:section.courseCode,title:e.title||"Course Event",date:e.startAt||e.date,sortDate:parseLocalDate(e.startAt||e.date),meta:e.location||e.notes||"",id:e.id});
    }
    for(const a of data.announcements){
      const published=a.publishAt?parseLocalDate(a.publishAt):null;
      if(a.status==="Draft")continue;
      if(published&&published>new Date())continue;
      rows.push({kind:"Announcement",sectionId:section.id,sectionName:section.sectionName||section.courseTitle,courseCode:section.courseCode,title:a.title||"Announcement",date:a.publishAt||a.createdAt,sortDate:parseLocalDate(a.publishAt||a.createdAt),meta:a.pinned?"Pinned announcement":"Section announcement",id:a.id});
    }
  }
  return rows.filter(x=>x.sortDate).sort((a,b)=>a.sortDate-b.sortDate);
}

function plannerCard(row){
  const d=row.sortDate;
  return '<article class="planner-item '+(daysFromNow(d)<0?"past":"")+'"><div class="planner-date"><strong>'+esc(d.toLocaleDateString(undefined,{month:"short"}).toUpperCase())+'</strong><span>'+esc(d.getDate())+'</span></div><div class="planner-copy"><div class="card-kicker">'+esc(row.courseCode||"THEORIA")+' • '+esc(row.kind)+'</div><h3>'+esc(row.title)+'</h3><p>'+esc(row.sectionName||"")+(row.meta?' • '+esc(row.meta):'')+'</p></div><button class="text-btn" data-productivity-action="open-planner-section" data-section="'+esc(row.sectionId)+'">Open Section</button></article>';
}

async function renderPlanner(){
  const el=$("#plannerContent");if(!el)return;
  el.innerHTML='<div class="empty-mini">Building your academic calendar…</div>';
  const rows=await plannerItems(),now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const weekEnd=new Date(today);weekEnd.setDate(weekEnd.getDate()+7);
  const upcoming=rows.filter(r=>r.sortDate>=today);
  const todayRows=upcoming.filter(r=>r.sortDate.toDateString()===today.toDateString());
  const weekRows=upcoming.filter(r=>r.sortDate<=weekEnd);
  const later=upcoming.filter(r=>r.sortDate>weekEnd);
  const overdue=rows.filter(r=>r.sortDate<today&&["Assignment","Assessment Closes"].includes(r.kind)).slice(-12).reverse();
  el.innerHTML='<div class="planner-summary"><div><span>Today</span><strong>'+todayRows.length+'</strong></div><div><span>Next 7 Days</span><strong>'+weekRows.length+'</strong></div><div><span>Later</span><strong>'+later.length+'</strong></div><div><span>Past Deadlines</span><strong>'+overdue.length+'</strong></div></div>'+
    '<div class="planner-toolbar">'+(isInstructor()?'<button class="primary-btn" data-productivity-action="create-calendar-event">Add Course Event</button>':'')+'<button class="secondary-btn" data-productivity-action="planner-export-ics">Export Calendar (.ics)</button></div>'+
    '<section class="planner-group"><div class="panel-title">Today</div>'+(todayRows.length?todayRows.map(plannerCard).join(""):'<div class="empty-mini">Nothing scheduled for today.</div>')+'</section>'+
    '<section class="planner-group"><div class="panel-title">Next 7 Days</div>'+(weekRows.length?weekRows.map(plannerCard).join(""):'<div class="empty-mini">No upcoming work in the next seven days.</div>')+'</section>'+
    '<section class="planner-group"><div class="panel-title">Later</div>'+(later.length?later.slice(0,30).map(plannerCard).join(""):'<div class="empty-mini">Nothing later on the academic calendar.</div>')+'</section>'+
    (overdue.length?'<section class="planner-group"><div class="panel-title">Past Deadlines</div>'+overdue.map(plannerCard).join("")+'</section>':'');
}

async function createCalendarEventModal(){
  const sections=(state()?.sections||[]).filter(x=>x.status!=="Archived"&&x.ownerId===state()?.user?.uid);
  if(!sections.length)return toast("You need an active section you own before adding a course event.");
  const m=modal({
    eyebrow:"Academic Calendar",
    title:"Add Course Event",
    body:'<form id="calendarEventForm"><div class="field"><label>Section</label><select name="sectionId">'+sections.map(s=>'<option value="'+s.id+'">'+esc((s.courseCode||"Course")+" — "+(s.sectionName||s.courseTitle))+'</option>').join("")+'</select></div><div class="field"><label>Event Title</label><input name="title" required></div><div class="compact-field-grid"><div class="field"><label>Type</label><select name="type"><option>Class Meeting</option><option>Review Session</option><option>Deadline</option><option>Office Hours</option><option>Seminar</option><option>Course Event</option></select></div><div class="field"><label>Date & Time</label><input type="datetime-local" name="startAt" required></div></div><div class="field"><label>Location / Notes</label><input name="notes"></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Add Event</button></div></form>'
  });
  m.querySelector("#calendarEventForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sectionId=String(fd.get("sectionId")),start=new Date(String(fd.get("startAt")));
    try{
      await addDoc(collection(db,"sections",sectionId,"events"),{
        title:String(fd.get("title")).trim(),type:String(fd.get("type")),startAt:Timestamp.fromDate(start),
        notes:String(fd.get("notes")||"").trim(),createdBy:state().user.uid,createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      closeModal();toast("Course event added.");renderPlanner();
    }catch(error){toast(error.message||"Unable to add course event.");}
  };
}

function downloadText(filename,text,type="text/plain"){
  const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function exportPlannerICS(){
  const rows=await plannerItems();
  const escIcs=v=>String(v||"").replace(/\\/g,"\\\\").replace(/;/g,"\\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");
  const stamp=d=>d.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"");
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Theoria//Academic Calendar//EN"];
  rows.filter(r=>r.sortDate>=new Date(Date.now()-86400000)).forEach(r=>{
    const d=r.sortDate,allDay=String(r.date||"").length<=10;
    lines.push("BEGIN:VEVENT","UID:"+escIcs(r.kind+"-"+r.sectionId+"-"+r.id+"@theoria"),"DTSTAMP:"+stamp(new Date()),allDay?"DTSTART;VALUE=DATE:"+dateOnly(d).replace(/-/g,""):"DTSTART:"+stamp(d),"SUMMARY:"+escIcs((r.courseCode?r.courseCode+" — ":"")+r.title),"DESCRIPTION:"+escIcs(r.kind+" • "+(r.sectionName||"")+(r.meta?" • "+r.meta:"")),"END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  downloadText("theoria-academic-calendar.ics",lines.join("\r\n"),"text/calendar");
}

/* -------------------- ANNOUNCEMENTS + NOTIFICATIONS -------------------- */

async function announcementsForUser(){
  const rows=[];
  for(const section of (state()?.sections||[]).filter(x=>x.status!=="Archived")){
    const list=await getCollection(["sections",section.id,"announcements"]);
    for(const a of list){
      const publish=a.publishAt?parseLocalDate(a.publishAt):null,expire=a.expiresAt?parseLocalDate(a.expiresAt,true):null,now=new Date();
      if(a.status==="Draft"&&state()?.role!=="instructor")continue;
      if(publish&&publish>now&&state()?.role!=="instructor")continue;
      if(expire&&expire<now&&state()?.role!=="instructor")continue;
      rows.push({...a,sectionId:section.id,sectionName:section.sectionName||section.courseTitle,courseCode:section.courseCode});
    }
  }
  return rows.sort((a,b)=>(b.pinned===true)-(a.pinned===true)||(parseLocalDate(b.publishAt||b.createdAt)?.getTime()||0)-(parseLocalDate(a.publishAt||a.createdAt)?.getTime()||0));
}

async function createAnnouncementModal(){
  const sections=(state()?.sections||[]).filter(x=>x.status!=="Archived"&&(x.ownerId===state()?.user?.uid||["coordinator","teaching_assistant"].includes(x.staffRole)));
  if(!sections.length)return toast("You do not manage an active section.");
  const m=modal({
    eyebrow:"Section Communications",
    title:"Create Announcement",
    wide:true,
    body:'<form id="announcementForm"><div class="field"><label>Section</label><select name="sectionId">'+sections.map(s=>'<option value="'+s.id+'">'+esc((s.courseCode||"Course")+" — "+(s.sectionName||s.courseTitle))+'</option>').join("")+'</select></div><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Announcement</label><textarea name="body" rows="7" required></textarea></div><div class="compact-field-grid"><div class="field"><label>Publish</label><input type="datetime-local" name="publishAt"></div><div class="field"><label>Expires</label><input type="datetime-local" name="expiresAt"></div><div class="field"><label>Status</label><select name="status"><option>Published</option><option>Draft</option></select></div></div><div class="policy-grid"><label class="policy-card"><input type="checkbox" name="pinned"><div><strong>Pin announcement</strong><span>Keep it at the top of the section communication feed.</span></div></label><label class="policy-card"><input type="checkbox" name="requiresAcknowledgement"><div><strong>Require acknowledgement</strong><span>Students receive an acknowledgement action for important notices.</span></div></label></div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Announcement</button></div></form>'
  });
  m.querySelector("#announcementForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sid=String(fd.get("sectionId"));
    try{
      const publishRaw=String(fd.get("publishAt")||""),expireRaw=String(fd.get("expiresAt")||"");
      await addDoc(collection(db,"sections",sid,"announcements"),{
        title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),status:String(fd.get("status")),
        pinned:e.currentTarget.elements.pinned.checked,requiresAcknowledgement:e.currentTarget.elements.requiresAcknowledgement.checked,
        publishAt:publishRaw?Timestamp.fromDate(new Date(publishRaw)):serverTimestamp(),
        expiresAt:expireRaw?Timestamp.fromDate(new Date(expireRaw)):null,
        createdBy:state().user.uid,createdByName:state().profile?.displayName||state().user.displayName||"Instructor",
        createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      closeModal();toast("Announcement saved.");await synthesizeNotifications();renderCommunications();
    }catch(error){toast(error.message||"Unable to save announcement.");}
  };
}

async function acknowledgeAnnouncement(sectionId,announcementId){
  const uid=state()?.user?.uid;if(!uid)return;
  try{
    await setDoc(doc(db,"users",uid,"announcementAcks",announcementId),{
      announcementId,sectionId,acknowledgedAt:serverTimestamp()
    },{merge:true});
    toast("Announcement acknowledged.");renderCommunications();
  }catch(error){toast(error.message||"Unable to acknowledge announcement.");}
}

async function notificationRows(){
  const uid=state()?.user?.uid;if(!uid)return [];
  return (await getCollection(["users",uid,"notifications"])).sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
}
async function synthesizeNotifications(){
  const s=state();if(!s?.user)return;
  const uid=s.user.uid,rows=await plannerItems(),now=new Date(),prefs=s.profile?.notificationPreferences||{};
  const seeds=[];
  rows.forEach(r=>{
    const diff=(r.sortDate-now)/86400000;
    if(prefs.deadlines!==false&&["Assignment","Assessment Closes"].includes(r.kind)&&diff>=0&&diff<=3){
      seeds.push({
        key:"deadline|"+r.sectionId+"|"+r.kind+"|"+r.id+"|"+dateOnly(r.sortDate),
        type:"deadline",title:r.title,body:r.kind+" in "+Math.max(0,Math.ceil(diff))+" day"+(Math.ceil(diff)===1?"":"s")+" • "+r.sectionName,
        sectionId:r.sectionId,targetPage:"planner"
      });
    }
  });
  const announcements=await announcementsForUser();
  if(prefs.announcements!==false)announcements.slice(0,25).forEach(a=>{
    if(a.status==="Draft")return;
    seeds.push({key:"announcement|"+a.sectionId+"|"+a.id,type:"announcement",title:a.title,body:(a.courseCode?a.courseCode+" • ":"")+String(a.body||"").slice(0,180),sectionId:a.sectionId,targetPage:"communications"});
  });

  if(s.role==="student"&&prefs.grades!==false){
    for(const section of (s.sections||[]).filter(x=>x.status!=="Archived")){
      try{
        const gradeSnap=await getDocs(query(collection(db,"sections",section.id,"grades"),where("studentId","==",uid)));
        gradeSnap.docs.forEach(d=>{
          const g=d.data(),stamp=g.updatedAt?.toMillis?.()||g.updatedAt?.seconds||0;
          seeds.push({
            key:"grade|"+section.id+"|"+d.id+"|"+stamp,type:"grade",
            title:(g.assignmentTitle||"Coursework")+" graded",
            body:(section.courseCode?section.courseCode+" • ":"")+String(g.gradeStatus&&g.gradeStatus!=="Normal"?g.gradeStatus+" • ":"")+(g.score!==undefined?g.score+" / "+(g.maxPoints||"—"):"Grade updated"),
            sectionId:section.id,targetPage:"reports"
          });
        });
      }catch(_){}
      try{
        const resultSnap=await getDocs(query(collection(db,"sections",section.id,"assessmentGrades"),where("studentId","==",uid)));
        resultSnap.docs.forEach(d=>{
          const g=d.data(),stamp=g.updatedAt?.toMillis?.()||g.updatedAt?.seconds||0;
          seeds.push({
            key:"assessment-grade|"+section.id+"|"+d.id+"|"+stamp,type:"grade",
            title:(g.assessmentTitle||"Assessment")+" result available",
            body:(section.courseCode?section.courseCode+" • ":"")+(g.percent!==undefined?g.percent+"%":"Result updated"),
            sectionId:section.id,targetPage:"reports"
          });
        });
      }catch(_){}
    }
  }

  for(const n of seeds){
    const ref=doc(db,"users",uid,"notifications",stableId(n.key));
    try{
      const exists=await getDoc(ref);
      if(!exists.exists())await setDoc(ref,{...n,read:false,createdAt:serverTimestamp()});
    }catch(_){}
  }
  await updateNotificationBadge();
}
async function updateNotificationBadge(){
  const rows=await notificationRows(),count=rows.filter(x=>x.read!==true).length;
  const badge=$("#notificationBadge");if(badge){badge.textContent=String(count);badge.classList.toggle("hidden",count===0);}
}
async function markNotification(id,read=true){
  try{await updateDoc(doc(db,"users",state().user.uid,"notifications",id),{read,readAt:read?serverTimestamp():null});await updateNotificationBadge();renderCommunications();}catch(_){}
}
async function markAllNotifications(){
  const rows=await notificationRows();
  for(let i=0;i<rows.length;i+=400){
    const {writeBatch}=await import("../firebase.js");const batch=writeBatch(db);
    rows.slice(i,i+400).filter(x=>x.read!==true).forEach(x=>batch.update(doc(db,"users",state().user.uid,"notifications",x.id),{read:true,readAt:serverTimestamp()}));
    await batch.commit();
  }
  updateNotificationBadge();renderCommunications();
}

function notificationPreferencesModal(){
  const prefs=state()?.profile?.notificationPreferences||{};
  const m=modal({
    eyebrow:"Notifications",
    title:"Notification Preferences",
    body:'<form id="notificationPreferencesForm"><div class="policy-grid">'+
      '<label class="policy-card"><input type="checkbox" name="deadlines" '+(prefs.deadlines===false?"":"checked")+'><div><strong>Deadlines</strong><span>Upcoming assignments and assessment windows.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="announcements" '+(prefs.announcements===false?"":"checked")+'><div><strong>Announcements</strong><span>Section communication and important notices.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="grades" '+(prefs.grades===false?"":"checked")+'><div><strong>Grades & Results</strong><span>Returned grades, assessment results, and grade changes.</span></div></label>'+
      '<label class="policy-card"><input type="checkbox" name="workflows" '+(prefs.workflows===false?"":"checked")+'><div><strong>Academic Workflows</strong><span>Entrance exams, appeals, records, and instructor follow-up.</span></div></label>'+
      '</div><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Save Preferences</button></div></form>'
  });
  m.querySelector("#notificationPreferencesForm").onsubmit=async e=>{
    e.preventDefault();
    const notificationPreferences={
      deadlines:e.currentTarget.elements.deadlines.checked,
      announcements:e.currentTarget.elements.announcements.checked,
      grades:e.currentTarget.elements.grades.checked,
      workflows:e.currentTarget.elements.workflows.checked
    };
    try{
      await updateDoc(doc(db,"users",state().user.uid),{notificationPreferences,updatedAt:serverTimestamp()});
      state().profile.notificationPreferences=notificationPreferences;
      closeModal();toast("Notification preferences saved.");await synthesizeNotifications();renderCommunications();
    }catch(error){toast(error.message||"Unable to save notification preferences.");}
  };
}

async function renderCommunications(){
  const el=$("#communicationsContent");if(!el)return;
  el.innerHTML='<div class="empty-mini">Loading communications…</div>';
  const [announcements,notifications]=await Promise.all([announcementsForUser(),notificationRows()]);
  let ackSet=new Set();
  try{
    const acks=await getDocs(collection(db,"users",state().user.uid,"announcementAcks"));
    ackSet=new Set(acks.docs.map(d=>d.id));
  }catch(_){}
  el.innerHTML='<div class="communications-toolbar">'+(isInstructor()?'<button class="primary-btn" data-productivity-action="create-announcement">New Announcement</button>':'')+'<button class="secondary-btn" data-productivity-action="notification-preferences">Preferences</button><button class="secondary-btn" data-productivity-action="mark-all-notifications">Mark Notifications Read</button></div>'+
    '<div class="grid-2 communications-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">Announcements</div><div class="panel-subtitle">Pinned, scheduled, and acknowledgement-aware section communication.</div></div></div><div class="panel-body communications-feed">'+(announcements.length?announcements.map(a=>'<article class="announcement-card '+(a.pinned?'pinned':'')+'"><div class="announcement-head"><div><span>'+esc(a.courseCode||"THEORIA")+' • '+esc(a.sectionName||"Section")+'</span><h3>'+esc(a.title||"Announcement")+'</h3></div>'+(a.pinned?'<span class="badge gold">Pinned</span>':'')+'</div><p>'+esc(a.body||"").replace(/\n/g,"<br>")+'</p><div class="announcement-foot"><span>'+esc(dateTime(a.publishAt||a.createdAt))+'</span>'+(a.requiresAcknowledgement&&state().role==="student"?(ackSet.has(a.id)?'<span class="badge live">Acknowledged</span>':'<button class="secondary-btn small-btn" data-productivity-action="ack-announcement" data-section="'+a.sectionId+'" data-id="'+a.id+'">Acknowledge</button>'):'')+'</div></article>').join(""):'<div class="empty-mini">No section announcements.</div>')+'</div></section>'+
    '<section class="panel"><div class="panel-head"><div><div class="panel-title">Notifications</div><div class="panel-subtitle">Deadlines, announcements, grading, and academic workflow reminders.</div></div></div><div class="panel-body notification-feed">'+(notifications.length?notifications.slice(0,60).map(n=>'<button class="notification-row '+(n.read===true?'read':'unread')+'" data-productivity-action="notification-open" data-id="'+n.id+'" data-page="'+esc(n.targetPage||"home")+'" data-section="'+esc(n.sectionId||"")+'"><span class="notification-dot"></span><div><strong>'+esc(n.title||"Notification")+'</strong><p>'+esc(n.body||"")+'</p><small>'+esc(dateTime(n.createdAt))+'</small></div></button>').join(""):'<div class="empty-mini">No notifications.</div>')+'</div></section></div>';
}

/* -------------------- COMMAND PALETTE -------------------- */

async function commandItems(){
  const s=state(),items=[
    {label:"Home",detail:"Workspace",action:()=>core().setPage("home")},
    {label:"Planner",detail:"Academic calendar",action:()=>core().setPage("planner")},
    {label:"Communications",detail:"Announcements and notifications",action:()=>core().setPage("communications")},
    {label:"Assessments",detail:"Evaluation",action:()=>core().setPage("assessments")},
    {label:"Progression",detail:"Academic pathways",action:()=>core().setPage("progression")},
    {label:"Academic Profile",detail:"Records and identity",action:()=>core().setPage("academic-profile")},
    {label:"Question Bank",detail:"Assessment design",action:()=>core().setPage("itembank")}
  ];
  if(isInstructor()){
    items.push({label:"Insights",detail:"Instructor analytics",action:()=>core().setPage("insights")});
    items.push({label:"Teaching Tools",detail:"Rubrics, attendance, groups, extensions",action:()=>core().setPage("teaching-tools")});
  }
  if(s?.isSystemOwner){
    items.push({label:"System Control Center",detail:"Administration",action:()=>core().setPage("admin-center")});
    items.push({label:"Program Map",detail:"Curriculum dependencies",action:()=>core().setPage("program-map")});
  }

  (s?.courses||[]).forEach(c=>items.push({
    label:(c.code||"Course")+" — "+(c.title||"Untitled"),
    detail:"Course Catalog • "+(c.discipline||""),
    action:()=>core().openCourse?core().openCourse(c.id):core().setPage("courses")
  }));
  (s?.sections||[]).forEach(sec=>items.push({
    label:(sec.courseCode||"Course")+" — "+(sec.sectionName||sec.courseTitle),
    detail:"Section • "+(sec.term||""),
    action:()=>core().openSection(sec.id)
  }));

  if(s?.currentSection&&s.sectionData){
    (s.sectionData.members||[]).forEach(student=>items.push({
      label:student.displayName||student.email||"Student",
      detail:"Student • "+(s.currentSection.courseCode||"")+" • "+(student.email||""),
      action:()=>window.TheoriaPhase6?.teaching?.studentProfileModal?.(student.id)
    }));
    (s.sectionData.assignments||[]).forEach(a=>items.push({
      label:a.title,detail:"Assignment • "+(s.currentSection.courseCode||""),
      action:()=>core().openSection(s.currentSection.id,"assignments")
    }));
    (s.sectionData.resources||[]).forEach(r=>items.push({
      label:r.title,detail:"Resource • "+(s.currentSection.courseCode||""),
      action:()=>core().openSection(s.currentSection.id,"resources")
    }));
  }

  if(isInstructor()){
    let loaded=0;
    for(const course of (s?.courses||[])){
      if(loaded>=250)break;
      try{
        const snap=await getDocs(collection(db,"courses",course.id,"items"));
        for(const q of snap.docs){
          if(loaded++>=250)break;
          const item=q.data();
          if(item.qualityStatus==="Retired")continue;
          items.push({
            label:(item.prompt||"Question").slice(0,120),
            detail:"Question Bank • "+(course.code||"Course")+" • "+(item.topicNumber||item.type||""),
            action:()=>core().setPage("itembank")
          });
        }
      }catch(_){}
    }
  }
  return items;
}
async function openCommandPalette(){
  const items=await commandItems();
  const m=modal({
    eyebrow:"Theoria Command Palette",
    title:"Search and Go",
    wide:true,
    body:'<div class="command-palette"><input id="commandSearch" class="command-search" placeholder="Search courses, sections, assignments, tools…" autocomplete="off"><div id="commandResults" class="command-results"></div></div>'
  });
  const input=m.querySelector("#commandSearch"),box=m.querySelector("#commandResults");
  const render=()=>{
    const q=input.value.trim().toLowerCase();
    const filtered=items.filter(x=>!q||(x.label+" "+x.detail).toLowerCase().includes(q)).slice(0,40);
    box.innerHTML=filtered.map((x,i)=>'<button class="command-result" data-command-index="'+items.indexOf(x)+'"><span>'+esc(x.label)+'</span><small>'+esc(x.detail)+'</small></button>').join("")||'<div class="empty-mini">No matches.</div>';
  };
  box.onclick=e=>{const b=e.target.closest("[data-command-index]");if(!b)return;const x=items[Number(b.dataset.commandIndex)];closeModal();x?.action?.();};
  input.oninput=render;render();setTimeout(()=>input.focus(),30);
}

/* -------------------- ACCESSIBILITY -------------------- */

const ACCESS_KEY="theoria-accessibility-v1";
function accessSettings(){
  try{return JSON.parse(localStorage.getItem(ACCESS_KEY)||"{}");}catch{return {};}
}
function applyAccessibility(){
  const s=accessSettings(),body=document.body;
  body.classList.toggle("a11y-high-contrast",!!s.highContrast);
  body.classList.toggle("a11y-reduced-motion",!!s.reducedMotion);
  body.classList.toggle("a11y-compact",s.density==="compact");
  body.classList.toggle("a11y-spacious",s.density==="spacious");
  document.documentElement.style.setProperty("--user-font-scale",String(Number(s.textScale||1)));
}
function accessibilityModal(){
  const s=accessSettings(),m=modal({
    eyebrow:"Accessibility",
    title:"Display & Interaction",
    body:'<form id="accessibilityForm"><div class="field"><label>Text Size</label><select name="textScale"><option value="0.9">90%</option><option value="1">100%</option><option value="1.1">110%</option><option value="1.2">120%</option><option value="1.35">135%</option></select></div><div class="field"><label>Interface Density</label><select name="density"><option value="standard">Standard</option><option value="compact">Compact</option><option value="spacious">Spacious</option></select></div><label class="policy-card"><input type="checkbox" name="highContrast" '+(s.highContrast?'checked':'')+'><div><strong>High Contrast</strong><span>Increase separation between text, controls, and surfaces.</span></div></label><label class="policy-card"><input type="checkbox" name="reducedMotion" '+(s.reducedMotion?'checked':'')+'><div><strong>Reduced Motion</strong><span>Disable nonessential transitions and smooth scrolling.</span></div></label><div class="modal-foot"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Apply Accessibility Settings</button></div></form>'
  });
  const form=m.querySelector("#accessibilityForm");form.elements.textScale.value=String(s.textScale||1);form.elements.density.value=s.density||"standard";
  form.onsubmit=e=>{e.preventDefault();localStorage.setItem(ACCESS_KEY,JSON.stringify({textScale:Number(form.elements.textScale.value||1),density:form.elements.density.value,highContrast:form.elements.highContrast.checked,reducedMotion:form.elements.reducedMotion.checked}));applyAccessibility();closeModal();toast("Accessibility settings applied.");};
}

/* -------------------- EXAM DRAFT RECOVERY -------------------- */

function examDraftKey(assessmentId,userId=state()?.user?.uid){return "theoria-exam-draft:"+assessmentId+":"+userId;}
function examHistoryKey(assessmentId,userId=state()?.user?.uid){return "theoria-exam-history:"+assessmentId+":"+userId;}
function saveExamDraft(assessmentId,payload){
  if(!assessmentId||!state()?.user)return;
  try{
    const item={...payload,savedAt:Date.now()};
    localStorage.setItem(examDraftKey(assessmentId),JSON.stringify(item));
    const key=examHistoryKey(assessmentId),history=JSON.parse(localStorage.getItem(key)||"[]");
    const last=history[history.length-1],changed=JSON.stringify(last?.answers||{})!==JSON.stringify(payload.answers||{});
    if(changed&&(history.length===0||Date.now()-Number(last?.savedAt||0)>15000)){
      history.push({answers:payload.answers||{},marked:payload.marked||[],currentIndex:Number(payload.currentIndex||0),savedAt:Date.now()});
      localStorage.setItem(key,JSON.stringify(history.slice(-12)));
    }
  }catch(_){}
}
function loadExamDraft(assessmentId){
  try{return JSON.parse(localStorage.getItem(examDraftKey(assessmentId))||"null");}catch{return null;}
}
function clearExamDraft(assessmentId){
  try{localStorage.removeItem(examDraftKey(assessmentId));localStorage.removeItem(examHistoryKey(assessmentId));}catch(_){}
}
function examDraftHistory(assessmentId){
  try{return JSON.parse(localStorage.getItem(examHistoryKey(assessmentId))||"[]");}catch{return [];}
}

/* -------------------- ASSIGNMENT DRAFT RECOVERY -------------------- */

function assignmentDraftKey(sectionId,assignmentId,userId=state()?.user?.uid){return "theoria-assignment-draft:"+sectionId+":"+assignmentId+":"+userId;}
function assignmentHistoryKey(sectionId,assignmentId,userId=state()?.user?.uid){return "theoria-assignment-history:"+sectionId+":"+assignmentId+":"+userId;}
function saveAssignmentDraft(sectionId,assignmentId,payload){
  if(!sectionId||!assignmentId||!state()?.user)return;
  try{
    const item={...payload,savedAt:Date.now()};
    localStorage.setItem(assignmentDraftKey(sectionId,assignmentId),JSON.stringify(item));
    const key=assignmentHistoryKey(sectionId,assignmentId),history=JSON.parse(localStorage.getItem(key)||"[]"),last=history[history.length-1];
    const changed=JSON.stringify({text:last?.responseText||"",url:last?.responseUrl||""})!==JSON.stringify({text:payload.responseText||"",url:payload.responseUrl||""});
    if(changed&&(history.length===0||Date.now()-Number(last?.savedAt||0)>15000)){
      history.push(item);localStorage.setItem(key,JSON.stringify(history.slice(-12)));
    }
  }catch(_){}
}
function loadAssignmentDraft(sectionId,assignmentId){
  try{return JSON.parse(localStorage.getItem(assignmentDraftKey(sectionId,assignmentId))||"null");}catch{return null;}
}
function clearAssignmentDraft(sectionId,assignmentId){
  try{localStorage.removeItem(assignmentDraftKey(sectionId,assignmentId));localStorage.removeItem(assignmentHistoryKey(sectionId,assignmentId));}catch(_){}
}
function assignmentDraftHistory(sectionId,assignmentId){
  try{return JSON.parse(localStorage.getItem(assignmentHistoryKey(sectionId,assignmentId))||"[]");}catch{return [];}
}

/* -------------------- INIT -------------------- */

function bind(){
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();openCommandPalette();}
  });
  document.addEventListener("click",async e=>{
    const b=e.target.closest("[data-productivity-action]");if(!b)return;
    const a=b.dataset.productivityAction;
    if(a==="open-command")return openCommandPalette();
    if(a==="accessibility")return accessibilityModal();
    if(a==="create-calendar-event")return createCalendarEventModal();
    if(a==="planner-export-ics")return exportPlannerICS();
    if(a==="open-planner-section")return core().openSection(b.dataset.section);
    if(a==="create-announcement")return createAnnouncementModal();
    if(a==="ack-announcement")return acknowledgeAnnouncement(b.dataset.section,b.dataset.id);
    if(a==="notification-preferences")return notificationPreferencesModal();
    if(a==="mark-all-notifications")return markAllNotifications();
    if(a==="notification-open"){await markNotification(b.dataset.id,true);closeModal();if(b.dataset.section)return core().openSection(b.dataset.section);return core().setPage(b.dataset.page||"home");}
  });
}

export function initProductivity(){
  applyAccessibility();bind();
  window.addEventListener("theoria:ready",async()=>{await synthesizeNotifications();});
  window.addEventListener("theoria:page",e=>{
    if(e.detail.page==="planner")renderPlanner();
    if(e.detail.page==="communications")renderCommunications();
  });
  return {
    renderPlanner,renderCommunications,openCommandPalette,accessibilityModal,notificationPreferencesModal,
    synthesizeNotifications,updateNotificationBadge,
    saveExamDraft,loadExamDraft,clearExamDraft,examDraftHistory,
    saveAssignmentDraft,loadAssignmentDraft,clearAssignmentDraft,assignmentDraftHistory
  };
}
