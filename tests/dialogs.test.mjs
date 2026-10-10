import {readFileSync} from "node:fs";
import {test} from "node:test";
import assert from "node:assert/strict";

const modules=[
  "app.js","institutions.js","school-admin.js","registrar.js",
  "institution-suite.js","campus.js","family.js","parent-portal.js",
  "phase3.js","phase4.js","phase5.js","phase6.js"
];
for(const name of modules){
 test(name+" does not use browser-native dialogs",()=>{
  const code=readFileSync(new URL("../"+name,import.meta.url),"utf8");
  assert.doesNotMatch(code,/(?<![\w$.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/g,
   "Use window.TheoriaDialog instead of native browser dialogs");
 });
}
