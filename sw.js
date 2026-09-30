const CACHE="theoria-shell-v20260930-1";
const SHELL=[
  "./",
  "./index.html",
  "./styles.css",
  "./favicon.svg",
  "./app.js",
  "./phase3.js",
  "./phase4.js",
  "./phase5.js",
  "./phase6.js",
  "./firebase.js",
  "./modules/productivity.js",
  "./modules/teaching.js",
  "./modules/admin.js"
];

self.addEventListener("install",event=>{
  event.waitUntil(
    caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()).catch(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith("theoria-shell-")&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  if(request.mode==="navigate"){
    event.respondWith(
      fetch(request).then(response=>{
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put("./index.html",copy)).catch(()=>{});
        return response;
      }).catch(()=>caches.match("./index.html").then(cached=>cached||caches.match("./")))
    );
    return;
  }

  if(["script","style","image","font"].includes(request.destination)){
    event.respondWith(
      caches.match(request,{ignoreSearch:true}).then(cached=>{
        const network=fetch(request).then(response=>{
          if(response&&response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone())).catch(()=>{});
          return response;
        }).catch(()=>cached);
        return cached||network;
      })
    );
  }
});
