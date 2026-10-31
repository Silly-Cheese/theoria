// Assessment Course Navigator — keeps large academic assessment catalogs manageable.
// Preferences are browser-local and isolated by signed-in account and role.
// No Firestore writes are used for accordion preferences.
const PREFIX="theoria:assessment-courses:v1:";

export function preferenceKey(uid,role){
  return PREFIX+String(uid||"guest")+":"+String(role||"student");
}
export function readCoursePreferences(storage,uid,role){
  let values={};
  try{
    const parsed=JSON.parse(storage?.getItem(preferenceKey(uid,role))||"{}");
    if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))values=parsed;
  }catch(_){}
  const safe=Object.create(null);
  for(const [key,value] of Object.entries(values)){
    if(value===true||value===false)safe[key]=value;
  }
  return safe;
}
export function courseExpanded(preferences,key,index){
  return Object.hasOwn(preferences,String(key))?preferences[String(key)]===true:index===0;
}
function savePreferences(storage,uid,role,preferences){
  try{storage?.setItem(preferenceKey(uid,role),JSON.stringify(preferences));}catch(_){}
}
export function courseAccordionMarkup({key,title,description,count,body,expanded,escapeHTML}){
  const esc=escapeHTML||((v)=>String(v));
  return '<details class="assessment-library-group assessment-course-group assessment-course-accordion" data-assessment-course="'+esc(key)+'"'+(expanded?' open':'')+'>'+
    '<summary class="assessment-course-summary">'+
      '<span class="assessment-course-chevron" aria-hidden="true">⌄</span>'+
      '<span class="assessment-course-heading"><span class="eyebrow">Course Assessments</span>'+
        '<span class="assessment-course-title">'+esc(title)+'</span>'+
        '<span class="assessment-course-description">'+esc(description)+'</span></span>'+
      '<span class="assessment-course-count">'+Number(count||0)+' assessment'+(Number(count||0)===1?'':'s')+'</span>'+
    '</summary>'+
    '<div class="assessment-course-panel">'+body+'</div>'+
  '</details>';
}
export function courseNavigationToolbar(groupCount,searchValue="",escapeHTML){
  const esc=escapeHTML||((v)=>String(v));
  return '<div class="assessment-course-toolbar">'+
    '<div class="assessment-course-search"><label for="assessmentCourseSearch">Find a course</label>'+
    '<input id="assessmentCourseSearch" type="search" autocomplete="off" placeholder="Course code or title…" value="'+esc(searchValue)+'"></div>'+
    '<div class="assessment-course-toolbar-actions">'+
      '<button type="button" class="secondary-btn small-btn" data-assessment-course-control="expand">Expand All</button>'+
      '<button type="button" class="secondary-btn small-btn" data-assessment-course-control="collapse">Collapse All</button>'+
    '</div>'+
    '<span id="assessmentCourseStatus" class="assessment-course-status" role="status" aria-live="polite">'+Number(groupCount||0)+' courses</span>'+
  '</div>';
}

export function wireCourseNavigation(root,{uid,role,storage}={}){
  if(!root)return;
  const doc=root.ownerDocument;
  const pref=readCoursePreferences(storage,uid,role);
  const accordions=[...root.querySelectorAll('details[data-assessment-course]')];
  const search=root.querySelector("#assessmentCourseSearch");
  const status=root.querySelector("#assessmentCourseStatus");
  const persist=()=>savePreferences(storage,uid,role,pref);

  accordions.forEach(details=>{
    details.addEventListener("toggle",()=>{
      pref[details.dataset.assessmentCourse]=details.hasAttribute("open");
      persist();
    });
  });
  const setOpen=(isOpen)=>{
    for(const details of accordions){
      details.toggleAttribute("open",isOpen);
      pref[details.dataset.assessmentCourse]=isOpen;
    }
    persist();
  };
  root.querySelector('[data-assessment-course-control="expand"]')?.addEventListener("click",()=>setOpen(true));
  root.querySelector('[data-assessment-course-control="collapse"]')?.addEventListener("click",()=>setOpen(false));

  const filter=()=>{
    const query=String(search?.value||"").trim().toLocaleLowerCase();
    let visible=0;
    for(const details of accordions){
      const title=details.querySelector(".assessment-course-heading")?.textContent?.toLocaleLowerCase()||"";
      const matched=!query||title.includes(query);
      details.hidden=!matched;
      if(matched)visible++;
    }
    if(status)status.textContent=query
      ? visible+" of "+accordions.length+" courses match"
      : accordions.length+" courses";
    let empty=root.querySelector("#assessmentCourseEmpty");
    if(!visible&&!empty){
      empty=doc.createElement("div");
      empty.id="assessmentCourseEmpty";
      empty.className="empty-mini assessment-course-empty";
      empty.textContent="No courses match that search. Try another course code or title.";
      root.appendChild(empty);
    }
    if(empty)empty.hidden=visible>0;
  };
  search?.addEventListener("input",filter);
  filter();
}
