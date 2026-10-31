import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {BANK_INITIAL_COUNT,BANK_INCREMENT,limitQuestionItems} from "../modules/question-bank-paging.js";

const bank=Array.from({length:2570},(_,index)=>({
  id:"question-"+index,courseId:"BIBL01",prompt:"Question "+index,
  topicNumber:String(Math.floor(index/100))
}));

test("large banks render only a bounded initial group",()=>{
  const page=limitQuestionItems(bank);
  assert.equal(BANK_INITIAL_COUNT,24);
  assert.equal(page.shown,24);
  assert.equal(page.remaining,2546);
  assert.equal(page.total,2570);
  assert.equal(page.visible.at(-1).id,"question-23");
  assert.equal(bank.length,2570,"Rendering must not delete question data");
});

test("load more preserves stable ordering and eventually reaches every question",()=>{
  let limit=BANK_INITIAL_COUNT;
  while(limit<bank.length){
    const page=limitQuestionItems(bank,limit);
    assert.deepEqual(page.visible,bank.slice(0,limit));
    limit+=BANK_INCREMENT;
  }
  const last=limitQuestionItems(bank,limit);
  assert.equal(last.shown,2570);
  assert.equal(last.remaining,0);
});

test("filters and empty results still report accurate counts",()=>{
  const filtered=bank.filter(question=>question.topicNumber==="9");
  assert.equal(filtered.length,100);
  const page=limitQuestionItems(filtered);
  assert.equal(page.total,100);
  assert.equal(page.shown,24);
  assert.equal(limitQuestionItems([],24).remaining,0);
  assert.equal(limitQuestionItems(bank,-4).shown,0);
});

test("real Question Bank uses pagination after filtering, with opt-in measurements",()=>{
  const source=readFileSync(new URL("../phase3.js",import.meta.url),"utf8");
  assert.ok(source.includes("visibleLimits.clear()"));
  assert.ok(source.includes("limitQuestionItems(list,limit)"));
  assert.ok(source.includes("data-itembank-more"));
  assert.ok(source.includes("[Theoria perf] Question Bank loaded"));
  assert.ok(source.includes("140);"));
});
