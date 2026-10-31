// Render a bounded number of Question Bank item cards without narrowing the
// search dataset or changing persistence. The complete list stays in memory.
export const BANK_INITIAL_COUNT = 24;
export const BANK_INCREMENT = 48;

export function limitQuestionItems(items,limit=BANK_INITIAL_COUNT){
  const source=Array.isArray(items)?items:[];
  const numeric=Number(limit);
  const shown=Number.isFinite(numeric)
    ?Math.max(0,Math.min(source.length,Math.floor(numeric)))
    :Math.min(source.length,BANK_INITIAL_COUNT);
  return {
    visible:source.slice(0,shown),
    shown,
    total:source.length,
    remaining:source.length-shown
  };
}
