/**
 * Concurrency-limited mapping for independent Firestore reads.
 * Preserves input order and rejects on failure just like Promise.all().
 * Avoids sequential N-request waterfalls without flooding the Firestore client.
 */
export async function mapConcurrent(items,concurrency,worker){
  const source=Array.from(items||[]);
  if(typeof worker!=="function")throw new TypeError("Expected a map worker");
  if(!source.length)return [];
  const limit=Math.min(source.length,Math.max(1,Math.floor(Number(concurrency)||1)));
  const output=new Array(source.length);
  let next=0;
  await Promise.all(Array.from({length:limit},async()=>{
    while(next<source.length){
      const index=next++;
      output[index]=await worker(source[index],index);
    }
  }));
  return output;
}
