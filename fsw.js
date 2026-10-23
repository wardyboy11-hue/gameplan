self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('push',function(e){
 e.waitUntil(fetch('https://touchline-push.wardyboy11.workers.dev/latest',{cache:'no-store'}).then(function(r){return r.json();}).catch(function(){return {title:'Wigan Junior Latics U15 Blues',body:'Open the page for the latest news.',url:'/family.html'};}).then(function(m){
  return self.registration.showNotification(m.title||'Wigan Junior Latics U15 Blues',{body:m.body||'',icon:'coach/icon-192.png',badge:'coach/badge.png',data:{url:m.url||'/family.html'},tag:'latics-alert',renotify:true});
 }));
});
self.addEventListener('notificationclick',function(e){
 e.notification.close();
 var u=(e.notification.data&&e.notification.data.url)||'/family.html';
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){
  for(var i=0;i<l.length;i++){if(l[i].url.indexOf('family')>-1&&'focus' in l[i])return l[i].focus();}
  return self.clients.openWindow(u);
 }));
});
