// Theoria mobile navigation and accessible horizontal academic tables.
// No account data, Firebase calls or roles are changed by this module.
export function createMobileNavigation({doc,win,sidebar,trigger}){
  if(!doc||!win||!sidebar||!trigger)throw new Error("Mobile navigation requires a sidebar and menu button");
  const backdrop=doc.createElement("button");
  backdrop.type="button";
  backdrop.id="mobileNavBackdrop";
  backdrop.className="mobile-nav-backdrop";
  backdrop.setAttribute("aria-label","Close academic navigation");
  backdrop.setAttribute("aria-hidden","true");
  backdrop.tabIndex=-1;
  sidebar.parentElement?.appendChild(backdrop);
  trigger.setAttribute("aria-controls",sidebar.id);
  trigger.setAttribute("aria-expanded","false");
  sidebar.setAttribute("aria-label","Academic navigation");
  const isOpen=()=>sidebar.classList.contains("open");
  const sync=()=>{
    const open=isOpen();
    trigger.setAttribute("aria-expanded",String(open));
    trigger.setAttribute("aria-label",open?"Close navigation":"Open navigation");
    doc.querySelectorAll("[data-mobile-menu]").forEach(button=>button.setAttribute("aria-expanded",String(open)));
    backdrop.setAttribute("aria-hidden",String(!open));
    doc.body.classList.toggle("mobile-nav-open",open);
  };
  const close=({restoreFocus=true}={})=>{
    const wasOpen=isOpen();
    const focusedInside=sidebar.contains(doc.activeElement);
    sidebar.classList.remove("open");
    sync();
    if(wasOpen&&restoreFocus&&(focusedInside||doc.activeElement===backdrop))trigger.focus();
  };
  const open=()=>{
    if(isOpen())return;
    sidebar.classList.add("open");
    sync();
    const visible=[...sidebar.querySelectorAll(".nav-item")].find(button=>
      !button.classList.contains("hidden") && !button.closest(".hidden")
    );
    (visible||sidebar).focus();
  };
  const toggle=()=>isOpen()?close():open();
  trigger.addEventListener("click",toggle);
  backdrop.addEventListener("click",()=>close());
  sidebar.addEventListener("click",e=>{
    const proxy=e.target.closest("[data-mobile-proxy]");
    if(proxy){
      const original=doc.getElementById(proxy.dataset.mobileProxy);
      close({restoreFocus:false});
      original?.click();
      return;
    }
    if(e.target.closest("[data-page]"))close({restoreFocus:false});
  });
  doc.addEventListener("keydown",e=>{
    if(!isOpen())return;
    if(e.key==="Escape"){e.preventDefault();close();return;}
    if(e.key!=="Tab")return;
    const focusables=[...sidebar.querySelectorAll("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]")].filter(el=>
      !el.classList.contains("hidden")&&!el.closest(".hidden")&&el.getAttribute("aria-hidden")!=="true"
    );
    if(!focusables.length)return;
    const first=focusables[0],last=focusables.at(-1);
    if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}
  });
  win.addEventListener("resize",()=>{
    if(win.innerWidth>760&&isOpen())close({restoreFocus:false});
  });
  sync();
  return {open,close,toggle,isOpen,backdrop};
}

export function enhanceMobileTables(root,doc){
  if(!root||!doc)return 0;
  let enhanced=0;
  for(const table of root.querySelectorAll("table")){
    if(table.classList.contains("gradebook-table")||
       table.closest(".gradebook-wrap,.mobile-table-scroll,.table-scroll,.table-wrap,.responsive-table-wrap"))continue;
    const holder=doc.createElement("div");
    holder.className="mobile-table-scroll";
    holder.setAttribute("role","region");
    holder.setAttribute("aria-label","Academic table — scroll horizontally to see more columns");
    holder.tabIndex=0;
    table.parentNode?.insertBefore(holder,table);
    holder.appendChild(table);
    enhanced++;
  }
  return enhanced;
}

export function createMobileTableEnhancer({doc,win}){
  const main=doc.getElementById("theoriaMain");
  if(!main)return {refresh:()=>0,disconnect:()=>{}};
  let pending=false;
  const refresh=()=>enhanceMobileTables(main,doc);
  const schedule=()=>{
    if(pending)return;
    pending=true;
    win.setTimeout(()=>{pending=false;refresh();},60);
  };
  const Observer=win.MutationObserver;
  let observer=null;
  if(Observer){
    observer=new Observer(mutations=>{
      // Only walk tables when content actually introduces a new table.
      if(mutations.some(m=>[...m.addedNodes].some(node=>node.nodeType===1&&
        (node.matches?.("table")||node.querySelector?.("table")))))schedule();
    });
    observer.observe(main,{childList:true,subtree:true});
  }
  win.addEventListener("theoria:page",schedule);
  return {refresh,disconnect:()=>observer?.disconnect()};
}
