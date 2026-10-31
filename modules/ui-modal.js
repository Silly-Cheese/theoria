// Shared, document-safe Theoria dialog construction.
// The outer modal shell is always a real DOM element, independent of form HTML.
export function createAcademicModal(host,{title="",eyebrow="Theoria",body="",wide=false,footer=""}={}){
  if(!host?.ownerDocument||typeof host.replaceChildren!=="function"){
    throw new Error("Theoria modal host is not available.");
  }
  const doc=host.ownerDocument;
  const backdrop=doc.createElement("div");
  backdrop.className="modal-backdrop";
  const panel=doc.createElement("div");
  panel.className=wide?"modal wide":"modal";
  panel.setAttribute("role","dialog");
  panel.setAttribute("aria-modal","true");
  const header=doc.createElement("div");
  header.className="modal-head";
  const headingBox=doc.createElement("div");
  const label=doc.createElement("div");
  label.className="eyebrow";
  label.textContent=String(eyebrow??"Theoria");
  const heading=doc.createElement("h2");
  heading.textContent=String(title??"");
  const close=doc.createElement("button");
  close.className="modal-close";
  close.type="button";
  close.setAttribute("data-close-modal","");
  close.setAttribute("aria-label","Close");
  close.textContent="×";
  headingBox.append(label,heading);
  header.append(headingBox,close);
  panel.append(header);
  const content=doc.createElement("div");
  content.className="modal-body";
  content.innerHTML=String(body??"");
  panel.append(content);
  if(footer){
    const actions=doc.createElement("div");
    actions.className="modal-foot";
    actions.innerHTML=String(footer);
    panel.append(actions);
  }
  backdrop.append(panel);
  host.replaceChildren(backdrop);
  if(!host.contains(panel))throw new Error("Theoria dialog could not be mounted.");
  return panel;
}

export function clearAcademicModal(host){
  host?.replaceChildren?.();
}
