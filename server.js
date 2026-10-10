const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = Number(process.env.PORT || 3000);
// Keep this password on the server; never send it to the browser.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sikuadmin123';
const players = new Map();
const bans = new Set();
const skills = new Map();
let serverLocked = false;
const ADMIN_ID = 'developer';
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, players: players.size }));
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function safeName(s) { return String(s || '플레이어').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || '플레이어'; }
function publicPlayer(p) { return { id:p.id, name:p.name, x:p.x, z:p.z, hp:p.hp, maxHp:100, level:p.level, money:p.money, inventory:p.inventory, hasLegendarySword:!!p.hasLegendarySword, isAdmin:p.isAdmin, online:true }; }
function adminOnly(p, ws) { if (!p.isAdmin) { send(ws,{type:'toast',text:'관리자만 사용할 수 있습니다.'}); return false; } return true; }
wss.on('connection', ws => {
  let p = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'join') {
      if (p) return;
      const name = safeName(m.name);
      if (serverLocked) { send(ws,{type:'error',text:'서버가 잠겨 있습니다.'}); ws.close(); return; }
      p = { id:crypto.randomUUID(), ws, name, x:Math.random()*6-3, z:Math.random()*6-3, hp:100, level:1, money:100, inventory:[], hasLegendarySword:false, isAdmin:false, lastAttack:0, lastUltimate:0, friends:[], joined:Date.now() };
      if (bans.has(name.toLowerCase())) { send(ws,{type:'error',text:'이 이름은 서버에서 차단되었습니다.'}); ws.close(); p=null; return; }
      players.set(p.id,p); send(ws,{type:'welcome',id:p.id,player:publicPlayer(p)});
      broadcast({type:'system',text:`${name}님이 입장했습니다.`}); broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked}); return;
    }
    if (!p) return;
    if (m.type === 'move') { p.x=Math.max(-24,Math.min(24,Number(m.x)||0)); p.z=Math.max(-24,Math.min(24,Number(m.z)||0)); broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked}); }
    else if (m.type === 'chat') { const text=String(m.text||'').replace(/[<>]/g,'').trim().slice(0,220); if(text) broadcast({type:'chat',from:p.name,isAdmin:p.isAdmin,text}); }
    else if (m.type === 'adminLogin') {
      const candidate=String(m.password||'');
      if (crypto.timingSafeEqual(Buffer.from(candidate.padEnd(128,'\0').slice(0,128)),Buffer.from(ADMIN_PASSWORD.padEnd(128,'\0').slice(0,128))) && candidate.length===ADMIN_PASSWORD.length) {
        p.isAdmin=true; p.name = safeName(m.name || p.name); send(ws,{type:'adminResult',ok:true}); broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});
      } else send(ws,{type:'adminResult',ok:false,text:'비밀번호가 올바르지 않습니다.'});
    }
    else if (m.type === 'attack') {
      const now=Date.now(); if(now-p.lastAttack<650) return; p.lastAttack=now; broadcast({type:'attackFX',id:p.id});
      for(const target of players.values()) { if(target.id===p.id) continue; const d=Math.hypot(target.x-p.x,target.z-p.z); if(d<2.4){ target.hp-=20; if(target.hp<=0){target.hp=100;target.x=0;target.z=0;broadcast({type:'system',text:`${target.name}님이 쓰러졌다가 부활했습니다.`});} } }
      broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});
    }
    else if (m.type === 'honoikazuchi') {
      const now=Date.now();
      if (!p.isAdmin) { send(ws,{type:'toast',text:'화뢰신은 개발자 전용 스킬입니다.'}); return; }
      if (now-p.lastUltimate<6500) { send(ws,{type:'toast',text:'화뢰신 재사용 대기 중입니다.'}); return; }
      p.lastUltimate=now;
      const start={x:p.x,z:p.z};
      const dirX=Number.isFinite(Number(m.dirX))?Math.max(-1,Math.min(1,Number(m.dirX))):0;
      const dirZ=Number.isFinite(Number(m.dirZ))?Math.max(-1,Math.min(1,Number(m.dirZ))):-1;
      const mag=Math.hypot(dirX,dirZ)||1, dx=dirX/mag,dz=dirZ/mag;
      const hit=[];
      for(const target of players.values()){
        if(target.id===p.id)continue;
        const rx=target.x-p.x, rz=target.z-p.z, along=rx*dx+rz*dz, side=Math.abs(rx*dz-rz*dx);
        if(along>0.5&&along<14&&side<2.8){target.hp-=75;hit.push({id:target.id,damage:75});if(target.hp<=0){target.hp=100;target.x=0;target.z=0;broadcast({type:'system',text:`${target.name}님이 화뢰신에 휩쓸려 쓰러졌다가 부활했습니다.`});}}
      }
      broadcast({type:'honoikazuchiFX',casterId:p.id,name:p.name,x:start.x,z:start.z,dirX:dx,dirZ:dz,hitIds:hit.map(h=>h.id),damage:75});
      broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});
    }
    else if (m.type === 'friend') { const target=[...players.values()].find(q=>q.name.toLowerCase()===String(m.name||'').toLowerCase()); if(target&&target.id!==p.id&&!p.friends.includes(target.id)){p.friends.push(target.id);send(ws,{type:'toast',text:`${target.name}님을 친구 목록에 추가했어요.`});} }
    else if (m.type === 'admin') {
      if(!adminOnly(p,ws)) return;
      const target=[...players.values()].find(q=>q.id===m.id || q.name.toLowerCase()===String(m.name||'').toLowerCase());
      if(m.action==='list'){send(ws,{type:'adminPlayers',players:[...players.values()].map(publicPlayer),bans:[...bans],serverLocked});return;}
      if(m.action==='announce'){const text=String(m.text||'').replace(/[<>]/g,'').trim().slice(0,240);if(text)broadcast({type:'announcement',text});return;}
      if(m.action==='lock'){serverLocked=true;broadcast({type:'serverLock',locked:true});return;}
      if(m.action==='unlock'){serverLocked=false;broadcast({type:'serverLock',locked:false});return;}
      if(m.action==='ban'){const name=safeName(m.name || target?.name);bans.add(name.toLowerCase());if(target){send(target.ws,{type:'error',text:'관리자에 의해 영구 차단되었습니다.'});target.ws.close();}send(ws,{type:'toast',text:`${name} 차단 완료`});return;}
      if(m.action==='unban'){const name=safeName(m.name);bans.delete(name.toLowerCase());send(ws,{type:'toast',text:`${name} 차단 해제 완료`});return;}
      if(m.action==='kick'){if(target){send(target.ws,{type:'error',text:'관리자에 의해 퇴장되었습니다.'});target.ws.close();}return;}
      if(m.action==='legendarySword'){p.hasLegendarySword=true;send(ws,{type:'toast',text:'전설의 검을 장착했습니다.'});broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});return;}
      if(m.action==='giveAll'){for(const q of players.values())q.inventory.push({name:safeName(m.item||'하늘의 검'),adminOnly:false});broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});return;}
      if(m.action==='give'&&target){target.inventory.push({name:safeName(m.item||'하늘의 검'),adminOnly:!!m.adminItem});send(ws,{type:'toast',text:`${target.name}님에게 아이템 지급`});broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});return;}
      if(m.action==='take'&&target){const i=target.inventory.findIndex(x=>x.name===m.item);if(i>=0)target.inventory.splice(i,1);broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});return;}
      if((m.action==='money'||m.action==='level')&&target){const value=Math.max(0,Math.min(999999,Number(m.value)||0));if(m.action==='money')target.money=value;else target.level=Math.max(1,Math.min(999,value));broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});return;}
      if(m.action==='skill'){const skill={name:safeName(m.skillName||'관리자 광휘'),damage:Math.max(1,Math.min(1000,Number(m.damage)||100)),color:String(m.color||'#ffcc33').slice(0,16)};skills.set(skill.name,skill);p.inventory.push({name:skill.name,adminOnly:true});broadcast({type:'adminSkill',skill});return;}
    }
  });
  ws.on('close',()=>{if(p){players.delete(p.id);broadcast({type:'system',text:`${p.name}님이 나갔습니다.`});broadcast({type:'state',players:[...players.values()].map(publicPlayer),serverLocked});}});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Skyrealm listening on ${PORT}`));
