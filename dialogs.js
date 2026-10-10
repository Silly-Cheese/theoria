const esc=x=>String(x??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));let queue=Promise.resolve();
function modal(kind,message,defaultValue=""){return new Promise(resolve=>{const root=document.createElement("div");root.className="theoria-native-dialog";root.innerHTML='<div class="theoria-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="nativeDialogTitle"><div class="eyebrow">Theoria</div><h2 id="nativeDialogTitle">'+(kind==="confirm"?"Confirm action":kind==="prompt"?"Enter information":"Notification")+'</h2><p>'+esc(message)+'</p>'+(kind==="prompt"?'<label class="theoria-dialog-label">Response<input id="nativeDialogInput" maxlength="2000" value="'+esc(defaultValue)+'"></label>':'')+'<div class="theoria-dialog-buttons">'+(kind!=="alert"?'<button type="button" id="nativeDialogCancel" class="secondary-btn">Cancel</button>':'')+'<button type="button" class="primary-btn" id="nativeDialogAccept">'+(kind==="alert"?"OK":"Continue")+'</button></div></div>';document.body.append(root);
const input=root.querySelector("#nativeDialogInput");let done=false;
function finish(value){if(done)return;done=true;document.removeEventListener("keydown",key);root.remove();resolve(value);}
function key(event){if(event.key==="Escape"){event.preventDefault();finish(kind==="confirm"?false:null);}if(event.key==="Enter"&&kind!=="alert"){event.preventDefault();finish(kind==="confirm"?true:input.value);}}
document.addEventListener("keydown",key);
root.querySelector("#nativeDialogAccept").onclick=()=>finish(kind==="confirm"?true:kind==="prompt"?input.value:undefined);
root.querySelector("#nativeDialogCancel")?.addEventListener("click",()=>finish(kind==="confirm"?false:null));
setTimeout(()=>{(input||root.querySelector("#nativeDialogAccept")).focus();},0);
});}

function inputForm(title,fields){
 return new Promise(resolve=>{
  const previous=document.activeElement;
  const backdrop=document.createElement("div");backdrop.className="theoria-native-dialog";
  backdrop.innerHTML='<div class="theoria-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="theoriaFormTitle"><div class="eyebrow">THEORIA</div><h2 id="theoriaFormTitle">'+esc(title)+'</h2><form id="theoriaDialogForm">'+fields.map((field,i)=>'<label class="theoria-dialog-label">'+esc(field.label)+'<'+(field.multiline?'textarea':'input')+' name="'+esc(field.name)+'" maxlength="'+Number(field.maxLength||1500)+'" required '+(field.multiline?'rows="5"':'type="text"')+'></'+(field.multiline?'textarea':'input')+'>').join("")+'<div class="theoria-dialog-buttons"><button type="button" class="secondary-btn" id="theoriaFormCancel">Cancel</button><button class="primary-btn" type="submit">Submit</button></div></form></div>';
  document.body.append(backdrop);
  const cleanup=result=>{document.removeEventListener("keydown",key);backdrop.remove();previous?.focus?.();resolve(result);};
  const key=event=>{if(event.key==="Escape"){event.preventDefault();cleanup(null);}};
  document.addEventListener("keydown",key);
  backdrop.querySelector("#theoriaFormCancel").onclick=()=>cleanup(null);
  backdrop.querySelector("#theoriaDialogForm").onsubmit=event=>{event.preventDefault();cleanup(Object.fromEntries(new FormData(event.currentTarget).entries()));};
  backdrop.querySelector("input,textarea")?.focus();
 });
}
window.TheoriaDialog={form:inputForm,alert:message=>modal("alert",message),confirm:message=>modal("confirm",message),prompt:(message,value="")=>modal("prompt",message,value)};
