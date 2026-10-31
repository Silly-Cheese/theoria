import test from "node:test";
import assert from "node:assert/strict";
import {parseHTML} from "linkedom";
import {createAcademicModal,clearAcademicModal} from "../modules/ui-modal.js";

function setup(){
  const {document}=parseHTML('<html><body><main></main><div id="modalRoot"></div></body></html>');
  return {document,host:document.getElementById("modalRoot")};
}

test("progression dialog retains form, requirement list and add button",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{
    title:"Prerequisites — BIBL 01",wide:true,
    body:'<form id="prerequisiteForm"><div id="competencyReqRows"></div><button type="button" id="addCompetencyReq">Add requirement</button></form>'
  });
  assert.equal(dialog.classList.contains("wide"),true);
  assert.ok(dialog.querySelector("#prerequisiteForm"));
  assert.ok(dialog.querySelector("#competencyReqRows"));
  assert.ok(dialog.querySelector("#addCompetencyReq"));
  assert.equal(host.querySelectorAll(".modal").length,1);
});

test("all dialog shells exist even when provided content has mismatched closing tags",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{
    title:"Student Academic Record",
    body:'<form id="recordForm"><input name="name"></div></form></div></div>'
  });
  assert.ok(dialog);
  assert.equal(dialog.className,"modal");
  assert.ok(host.contains(dialog));
  assert.ok(dialog.querySelector(".modal-close"));
  assert.ok(dialog.querySelector(".modal-head"));
});

test("opening multiple dialogs replaces old content without losing modal host",()=>{
  const {host}=setup();
  createAcademicModal(host,{title:"First",body:'<form id="first"></form>'});
  const dialog=createAcademicModal(host,{title:"Second",body:'<form id="second"></form>',footer:'<button id="save">Save</button>'});
  assert.equal(host.querySelector("#first"),null);
  assert.ok(dialog.querySelector("#second"));
  assert.ok(dialog.querySelector("#save"));
  clearAcademicModal(host);
  assert.equal(host.childElementCount,0);
});

test("user-provided title is rendered as text, never executed as HTML",()=>{
  const {host}=setup();
  const dialog=createAcademicModal(host,{title:'<img src=x onerror=alert(1)>',eyebrow:'<script>alert(2)</script>'});
  assert.equal(dialog.querySelector("h2").textContent,'<img src=x onerror=alert(1)>');
  assert.equal(dialog.querySelector("img"),null);
  assert.equal(dialog.querySelector("script"),null);
});

test("missing modal host fails with actionable error",()=>{
  assert.throws(()=>createAcademicModal(null,{title:"Test"}),/modal host/);
});
