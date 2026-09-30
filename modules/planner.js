import {
  db, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, serverTimestamp
} from "../firebase.js";

const $=s=>document.querySelector(s);
const core=()=>window.TheoriaCore;
const state=()=>core()?.getState?.();
const esc=v=>core()?.esc?.(v)??String(v??"");
const toast=m=>core()?.showToast?.(m);
const modal=a=>core()?.openModal?.(a);
const closeModal=()=>core()?.closeModal?.();
const now=()=>new Date();
const dateKey=d=>{const x=new Date(d);return x.toISOString().slice(0,10);};
const tsDate=v=>v?.toDate?.()||v?.seconds?new Date(v.seconds*1000):null;
const parseDate=v=>{if(!v)return null;if(v instanceof Date)return v;if(v?.toDate)return v.toDate();if(typeof v==="string"){const d=new Date(v.length===10?v+"T23:59:00":v);return Number.isNaN(d.getTime())?null:d;}return null;};
const humanDate=v=>{const d=parseDate(v);return d?d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"—";};
const humanDateTime=v=>{const d=parseDate(v);return d?d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"—";};
const activeSections=()=>state()?.sections?.filter(s=>s.status!=="Archived")||[];

async function fetchPlannerData(){
  const s=state(),items=[],announcements=[];
  if(!s?.user)return {items,announcements};

  for(const section of activeSections()){
    try{
      const a=await getDocs(collection(db,"sections",section.id,"assignments"));
      a.docs.forEach(d=>{
        const x=d.data();if(x.status==="Draft")return;
        const due=parseDate(x.dueDate);
        if(due)items.push({id:d.id,kind:"Assignment",title:x.title||"Assignment",date:due,section,meta:x.type||"Coursework",source:x});
      });
    }catch(_){}

    try{
      const refs=await getDocs(collection(db,"sections",section.id,"assessmentRefs"));
      refs.docs.forEach(d=>{
        const x=d.data();if(x.status==="Draft")return;
        const open=parseDate(x.opensAt),close=parseDate(x.closesAt);
        if(open)items.push({id:d.id+"-open",kind:"Assessment Opens",title:x.title||"Assessment",date:open,section,meta:x.assessmentType||x.type||"Assessment",source:x});
        if(close)items.push({id:d.id+"-close",kind:"Assessment Due",title:x.title||"Assessment",date:close,section,meta:x.assessmentType||x.type||"Assessment",source:x});
      });
    }catch(_){}

    try{
      const ev=await getDocs(collection(db,"sections",section.id,"events"));
      ev.docs.forEach(d=>{
        const x=d.data(),date=parseDate(x.startsAt||x.date);
        if(date)items.push({id:d.id,kind:x.type||"Course Event",title:x.title||"Event",date,section,meta:x.location||"",source:x});
      });
    }catch(_){}

    try{
      const an=await getDocs(collection(db,"sections",section.id,"announcements"));
      an.docs.forEach(d=>{
        const x=d.data(),expires=parseDate(x.expiresAt);
        if(expires&&expires<now())return;
        announcements.push({id:d.id,section,...x});
      });
    }catch(_){}
  }

  items.sort((a,b)=>a.date-b.date);
  announcements.sort((a,b)=>(Number(b.pinned===true)-Number(a.pinned===true))||((b.createdAt?.seconds||0)-(a.createdAt?.seconds||0)));
  return {items,announcements};
}

function monthMatrix(items,base=new Date()){
  const year=base.getFullYear(),month=base.getMonth();
  const first=new Date(year,month,1),last=new Date(year,month+1,0);
  const cells=[];
  for(let i=0;i<first.getDay();i++)cells.push(null);
  for(let d=1;d<=last.getDate();d++){
    const date=new Date(year,month,d),key=dateKey(date);
    cells.push({date,key,items:items.filter(x=>dateKey(x.date)===key)});
  }
  while(cells.length%7)cells.push(null);
  return {year,month,cells,label:first.toLocaleDateString(undefined,{month:"long",year:"numeric"})};
}

function calendarHtml(items,base){
  const m=monthMatrix(items,base);
  return '<div class="calendar-shell"><div class="calendar-toolbar"><button class="text-btn" data-planner-action="month-prev">←</button><strong>'+esc(m.label)+'</strong><button class="text-btn" data-planner-action="month-next">→</button></div>'+
    '<div class="calendar-weekdays">'+["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x=>'<span>'+x+'</span>').join("")+'</div>'+
    '<div class="calendar-grid">'+m.cells.map(cell=>cell?'<div class="calendar-day '+(cell.key===dateKey(now())?'today':'')+'"><div class="calendar-date">'+cell.date.getDate()+'</div><div class="calendar-items">'+cell.items.slice(0,3).map(item=>'<button class="calendar-chip '+item.kind.toLowerCase().replace(/[^a-z]+/g,"-")+'" data-planner-action="show-item" data-item="'+esc(item.id)+'" title="'+esc(item.title)+'">'+esc(item.title)+'</button>').join("")+(cell.items.length>3?'<span class="calendar-more">+'+(cell.items.length-3)+' more</span>':'')+'</div></div>':'<div class="calendar-day empty"></div>').join("")+'</div></div>';
}

let plannerMonth=new Date(),plannerCache={items:[],announcements:[]};

async function renderPlanner(){
  const el=$("#plannerContent"),s=state();if(!el||!s?.user)return;
  el.innerHTML='<div class="empty-mini">Building your academic planner…</div>';
  plannerCache=await fetchPlannerData();
  const horizon=new Date();horizon.setDate(horizon.getDate()+14);
  const upcoming=plannerCache.items.filter(x=>x.date>=new Date(now().setHours(0,0,0,0))&&x.date<=horizon).slice(0,12);

  el.innerHTML='<div class="page-actions planner-page-actions">'+(s.role==="instructor"?'<button class="secondary-btn" data-planner-action="new-announcement">Announcement</button><button class="primary-btn" data-planner-action="new-event">Add Event</button>':'')+'<button class="secondary-btn" data-planner-action="notifications">Notifications</button></div>'+
    '<div id="plannerCalendar">'+calendarHtml(plannerCache.items,plannerMonth)+'</div>'+
    '<div class="grid-2 planner-bottom-grid"><div class="panel"><div class="panel-head"><div><div class="panel-title">Next 14 Days</div><div class="panel-subtitle">Assignments, assessments, and course events in chronological order.</div></div></div><div class="panel-body">'+(upcoming.length?'<div class="agenda-list">'+upcoming.map(item=>'<div class="agenda-row"><div class="agenda-date"><strong>'+item.date.getDate()+'</strong><span>'+item.date.toLocaleDateString(undefined,{month:"short"})+'</span></div><div><span>'+esc(item.kind)+' • '+esc(item.section.courseCode||"Course")+'</span><strong>'+esc(item.title)+'</strong><small>'+esc(item.section.sectionName||item.section.courseTitle||"")+' • '+humanDateTime(item.date)+'</small></div></div>').join("")+'</div>':'<div class="empty-mini">Nothing scheduled in the next 14 days.</div>')+'</div></div>'+
    '<div class="panel"><div class="panel-head"><div><div class="panel-title">Announcements</div><div class="panel-subtitle">Current notices across your active sections.</div></div></div><div class="panel-body">'+(plannerCache.announcements.length?plannerCache.announcements.slice(0,10).map(a=>'<article class="announcement-card '+(a.pinned?'pinned':'')+'"><div class="announcement-meta">'+(a.pinned?'<span class="badge gold">Pinned</span>':'')+'<span>'+esc(a.section.courseCode||"Course")+'</span></div><strong>'+esc(a.title||"Announcement")+'</strong><p>'+esc(a.body||"")+'</p><small>'+esc(a.authorName||"Instructor")+'</small></article>').join(""):'<div class="empty-mini">No active announcements.</div>')+'</div></div></div>';
}

function sectionOptions(){
  return activeSections().map(s=>'<option value="'+s.id+'">'+esc((s.courseCode||"Course")+" — "+(s.sectionName||s.courseTitle||"Section"))+'</option>').join("");
}

function eventModal(){
  const sections=activeSections();if(!sections.length)return toast("Create or join a section first.");
  const m=modal({
    eyebrow:"Academic Calendar",
    title:"Add Course Event",
    body:'<form id="plannerEventForm"><div class="field"><label>Section</label><select name="sectionId">'+sectionOptions()+'</select></div><div class="field"><label>Title</label><input name="title" required placeholder="Seminar, review session, deadline…"></div><div class="compact-field-grid"><div class="field"><label>Type</label><select name="type"><option>Course Event</option><option>Seminar</option><option>Review Session</option><option>Office Hours</option><option>Deadline</option></select></div><div class="field"><label>Date & Time</label><input type="datetime-local" name="startsAt" required></div></div><div class="field"><label>Location / Link</label><input name="location"></div><div class="field"><label>Details</label><textarea name="details"></textarea></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Add Event</button></div></form>'
  });
  m.querySelector("#plannerEventForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sectionId=String(fd.get("sectionId"));
    try{
      await addDoc(collection(db,"sections",sectionId,"events"),{
        title:String(fd.get("title")).trim(),type:String(fd.get("type")),startsAt:String(fd.get("startsAt")),
        location:String(fd.get("location")||"").trim(),details:String(fd.get("details")||"").trim(),
        createdBy:state().user.uid,createdByName:state().profile?.displayName||state().user.displayName||"Instructor",
        createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      closeModal();toast("Calendar event added.");renderPlanner();
    }catch(error){toast(error.message||"Unable to add the event.");}
  };
}

function announcementModal(){
  const sections=activeSections();if(!sections.length)return toast("Create a section first.");
  const m=modal({
    eyebrow:"Instructor Communication",
    title:"New Announcement",
    body:'<form id="announcementForm"><div class="field"><label>Section</label><select name="sectionId">'+sectionOptions()+'</select></div><div class="field"><label>Title</label><input name="title" required></div><div class="field"><label>Announcement</label><textarea name="body" rows="5" required></textarea></div><div class="compact-field-grid"><div class="field"><label>Expires</label><input type="date" name="expiresAt"></div><label class="policy-card compact-policy"><input type="checkbox" name="pinned"><div><strong>Pin announcement</strong><span>Keep it above ordinary notices.</span></div></label></div><div class="modal-foot" style="margin:24px -24px -24px"><button type="button" class="secondary-btn" data-close-modal>Cancel</button><button class="primary-btn" type="submit">Publish Announcement</button></div></form>'
  });
  m.querySelector("#announcementForm").onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.currentTarget),sectionId=String(fd.get("sectionId"));
    try{
      await addDoc(collection(db,"sections",sectionId,"announcements"),{
        title:String(fd.get("title")).trim(),body:String(fd.get("body")).trim(),pinned:e.currentTarget.elements.pinned.checked,
        expiresAt:String(fd.get("expiresAt")||""),authorId:state().user.uid,
        authorName:state().profile?.displayName||state().user.displayName||"Instructor",
        createdAt:serverTimestamp(),updatedAt:serverTimestamp()
      });
      closeModal();toast("Announcement published.");renderPlanner();
    }catch(error){toast(error.message||"Unable to publish announcement.");}
  };
}

async function loadNotifications(){
  const s=state();if(!s?.user)return [];
  try{
    const snap=await getDocs(collection(db,"users",s.user.uid,"notifications"));
    return snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
  }catch(_){return [];}
}

async function refreshNotificationBadge(){
  const rows=await loadNotifications(),unread=rows.filter(x=>x.read!==true).length;
  const badge=$("#notificationBadge");if(badge){badge.textContent=unread>99?"99+":String(unread);badge.classList.toggle("hidden",!unread);}
}

async function notificationsModal(){
  const rows=await loadNotifications();
  const m=modal({
    eyebrow:"Notification Center",
    title:"Academic Notifications",
    wide:true,
    body:rows.length?'<div class="notification-list">'+rows.map(n=>'<article class="notification-row '+(n.read?'read':'unread')+'"><div class="notification-icon">'+esc(n.icon||"•")+'</div><div><strong>'+esc(n.title||"Notification")+'</strong><p>'+esc(n.body||"")+'</p><small>'+esc(n.sectionLabel||"Theoria")+'</small></div>'+(n.read?'':'<button class="text-btn" data-planner-action="read-notification" data-id="'+n.id+'">Mark read</button>')+'</article>').join("")+'</div>':'<div class="empty-state compact-empty"><div class="empty-symbol">N</div><h3>No notifications.</h3><p>Academic updates and workflow reminders will appear here.</p></div>',
    footer:'<button class="secondary-btn" data-planner-action="mark-all-read">Mark all read</button><button class="primary-btn" data-close-modal>Close</button>'
  });
  return m;
}

async function writeNotification(id,data){
  const s=state();if(!s?.user)return;
  try{
    const ref=doc(db,"users",s.user.uid,"notifications",id),existing=await getDoc(ref);
    if(existing.exists())return;
    await setDoc(ref,{...data,read:false,createdAt:serverTimestamp()});
  }catch(_){}
}

async function runAcademicWorkflows(){
  const s=state();if(!s?.user)return;
  const data=await fetchPlannerData(),today=now(),in48=new Date(today.getTime()+48*3600000);
  for(const item of data.items.filter(x=>x.date>=today&&x.date<=in48)){
    const id=("due_"+item.section.id+"_"+item.id+"_"+dateKey(item.date)).replace(/[^A-Za-z0-9_-]/g,"_");
    await writeNotification(id,{
      icon:item.kind.includes("Assessment")?"✓":"◫",
      title:item.kind+" soon: "+item.title,
      body:"Scheduled for "+humanDateTime(item.date)+".",
      sectionId:item.section.id,
      sectionLabel:(item.section.courseCode||"Course")+" • "+(item.section.sectionName||"Section"),
      kind:"deadline"
    });
  }

  if(s.role==="instructor"){
    for(const section of activeSections()){
      try{
        const candidates=await getDocs(collection(db,"sections",section.id,"entranceCandidates"));
        const pending=candidates.docs.filter(d=>d.data().status==="pending").length;
        if(pending){
          await writeNotification("entrance_pending_"+section.id+"_"+dateKey(today),{
            icon:"↗",title:pending+" entrance candidate"+(pending===1?"":"s")+" need attention",
            body:"Review the section entrance-examination workflow and submitted attempts.",
            sectionId:section.id,sectionLabel:(section.courseCode||"Course")+" • "+(section.sectionName||"Section"),kind:"workflow"
          });
        }
      }catch(_){}
    }
  }
  refreshNotificationBadge();
}

function installTopbar(){
  const actions=document.querySelector(".top-actions");if(!actions||$("#notificationBtn"))return;
  actions.insertAdjacentHTML("afterbegin",'<button id="notificationBtn" class="icon-action-btn" title="Notifications" aria-label="Notifications">N<span id="notificationBadge" class="notification-badge hidden">0</span></button>');
  $("#notificationBtn").onclick=notificationsModal;
}

window.addEventListener("theoria:ready",()=>{installTopbar();runAcademicWorkflows();});
window.addEventListener("theoria:page",e=>{if(e.detail.page==="planner")renderPlanner();});
document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-planner-action]");if(!b)return;
  const a=b.dataset.plannerAction;
  if(a==="new-event")return eventModal();
  if(a==="new-announcement")return announcementModal();
  if(a==="notifications")return notificationsModal();
  if(a==="month-prev"){plannerMonth=new Date(plannerMonth.getFullYear(),plannerMonth.getMonth()-1,1);$("#plannerCalendar").innerHTML=calendarHtml(plannerCache.items,plannerMonth);return;}
  if(a==="month-next"){plannerMonth=new Date(plannerMonth.getFullYear(),plannerMonth.getMonth()+1,1);$("#plannerCalendar").innerHTML=calendarHtml(plannerCache.items,plannerMonth);return;}
  if(a==="read-notification"){await updateDoc(doc(db,"users",state().user.uid,"notifications",b.dataset.id),{read:true,readAt:serverTimestamp()});closeModal();await notificationsModal();refreshNotificationBadge();return;}
  if(a==="mark-all-read"){const rows=await loadNotifications();for(const row of rows.filter(x=>!x.read))await updateDoc(doc(db,"users",state().user.uid,"notifications",row.id),{read:true,readAt:serverTimestamp()});closeModal();await notificationsModal();refreshNotificationBadge();return;}
});

window.TheoriaPlanner={renderPlanner,runAcademicWorkflows,notificationsModal,writeNotification,refreshNotificationBadge};
if(window.TheoriaCore){installTopbar();runAcademicWorkflows();}
