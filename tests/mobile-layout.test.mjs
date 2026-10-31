import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseHTML} from "linkedom";
import {createMobileNavigation,enhanceMobileTables} from "../modules/mobile-ui.js";
function fixture(){
 const {document}=parseHTML('<html><body><section id="appShell"><aside id="sidebar"><div class="side-scroll"><button class="nav-item" data-page="home">Home</button><button class="nav-item" data-page="courses">Courses</button></div><button data-mobile-proxy="commandPaletteBtn">Search</button></aside><button id="mobileMenuBtn">Menu</button><button id="commandPaletteBtn">Search actual</button></section><main id="theoriaMain"><table id="transcript"><thead><tr><th>Course</th></tr></thead></table><div class="gradebook-wrap"><table class="gradebook-table"></table></div></main></body></html>');
 return {document,win:{innerWidth:390,addEventListener:()=>{}},sidebar:document.getElementById("sidebar"),trigger:document.getElementById("mobileMenuBtn")};
}
test("drawer opens and closes with accessible state",()=>{
 const f=fixture(),nav=createMobileNavigation({doc:f.document,win:f.win,sidebar:f.sidebar,trigger:f.trigger});
 assert.equal(f.trigger.getAttribute("aria-expanded"),"false");
 nav.open();assert.equal(nav.isOpen(),true);assert.equal(f.trigger.getAttribute("aria-expanded"),"true");
 assert.equal(f.document.body.classList.contains("mobile-nav-open"),true);
 nav.backdrop.click();assert.equal(nav.isOpen(),false);assert.equal(f.trigger.getAttribute("aria-expanded"),"false");
});
test("menu navigation and proxy utilities remain operational",()=>{
 const f=fixture(),nav=createMobileNavigation({doc:f.document,win:f.win,sidebar:f.sidebar,trigger:f.trigger});
 nav.open();f.sidebar.querySelector('[data-page="courses"]').click();assert.equal(nav.isOpen(),false);
 let called=0;f.document.getElementById("commandPaletteBtn").addEventListener("click",()=>called++);
 nav.open();f.sidebar.querySelector("[data-mobile-proxy]").click();assert.equal(called,1);assert.equal(nav.isOpen(),false);
});
test("tables are scrollable and gradebook tables retain their own wrap",()=>{
 const {document}=fixture(),root=document.getElementById("theoriaMain");
 assert.equal(enhanceMobileTables(root,document),1);assert.equal(enhanceMobileTables(root,document),0);
 assert.equal(document.querySelector(".mobile-table-scroll").getAttribute("role"),"region");
 assert.ok(document.querySelector(".mobile-table-scroll>#transcript"));
 assert.ok(document.querySelector(".gradebook-wrap>.gradebook-table"));
});
test("dock shortcuts refer to existing academic pages and mobile proxies to live controls",()=>{
 const phase=readFileSync(new URL("../phase6.js",import.meta.url),"utf8");
 const html=readFileSync(new URL("../index.html",import.meta.url),"utf8");
 const pages=[...html.matchAll(/id="page-([^"]+)"/g)].map(x=>x[1]);
 for(const name of ["home","sections","assessments","itembank","progression"])assert.ok(pages.includes(name));
 assert.equal(phase.includes('["progress","Progress"'),false);
 assert.ok(phase.includes("data-mobile-menu"));
 for(const id of ["commandPaletteBtn","contextHelpBtn","accessibilityBtn","quickCreateBtn","quickJoinBtn"])assert.ok(html.includes('data-mobile-proxy="'+id+'"'));
});
test("responsive styles cover academic tables, forms, mobile bottom bar and safe areas",()=>{
 const css=readFileSync(new URL("../mobile.css",import.meta.url),"utf8");
 for(const m of ["@media(max-width:760px)","@media(max-width:420px)","safe-area-inset-bottom","mobile-nav-backdrop","mobile-dock","mobile-table-scroll","question-bank-workspace","gradebook-wrap","prefers-reduced-motion"])assert.ok(css.includes(m),m);
});
