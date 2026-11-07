import './test-secrets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileSyncQueue} from '../apps/api/src/profile-sync.mjs';
import {createCampusCloudApp} from '../apps/api/src/app.mjs';
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function clock(){let ms=0,id=0;const jobs=new Map();return {now:()=>ms,
 setTimer:(fn,delay)=>{const key=++id;jobs.set(key,{fn,at:ms+delay});return key;},
 clearTimer:key=>jobs.delete(key),count:()=>jobs.size,
 async advance(delta){ms+=delta;for(const [key,job] of [...jobs])if(job.at<=ms){jobs.delete(key);job.fn();}await settle();}};}
test('throttle coalesces requests into a trailing latest snapshot without another trigger',async()=>{
 const c=clock();let value=1;const seen=[];const q=createProfileSyncQueue(async()=>{seen.push(value);return {ok:true};},c);
 await q.request('a');value=2;await q.request('a');value=3;await q.request('a');
 assert.deepEqual(seen,[1]);await c.advance(29999);assert.deepEqual(seen,[1]);await c.advance(1);assert.deepEqual(seen,[1,3]);assert.equal(c.count(),0);await q.close();
});
test('concurrent request during in-flight is dirty and cannot overlap or disappear',async()=>{
 const c=clock();let release,value=1;const seen=[];const q=createProfileSyncQueue(async()=>{seen.push(value);if(seen.length===1)await new Promise(r=>release=r);return {ok:true};},c);
 const first=q.request('a');await settle();value=2;const second=q.request('a');release();await Promise.all([first,second]);
 assert.deepEqual(seen,[1]);await c.advance(30000);assert.deepEqual(seen,[1,2]);await q.close();
});
test('returned failure and exception retry latest data without new requests',async()=>{
 const c=clock();let n=0;const q=createProfileSyncQueue(async()=>{n++;if(n===1)return {ok:false};if(n===2)throw Error('offline');return {ok:true};},c);
 await q.request('a');await c.advance(30000);assert.equal(n,2);await c.advance(30000);assert.equal(n,3);assert.equal(c.count(),0);await q.close();
});
test('close waits for flight then flushes trailing work once; retries stop and failure remains visible',async()=>{
 const c=clock();let release,n=0;const q=createProfileSyncQueue(async()=>{n++;if(n===1)await new Promise(r=>release=r);return {ok:false};},c);
 void q.request('a');await settle();void q.request('a');const closed=q.close();release();assert.deepEqual(await closed,{pending:1});assert.equal(n,2);assert.equal(c.count(),0);await c.advance(999999);await q.request('a');assert.equal(n,2);assert.equal(q.close(),closed);
});
test('API two accepted mutations send latest active plan count after throttle',async()=>{
 const c=clock();const app=createCampusCloudApp({profileSyncOptions:c});
 const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'profile'});user.sso_access_token='synthetic';
 const auth=app.identity.issueDeviceSession(user,'Phone',null,1,Date.now(),'MOBILE_APP');
 const seen=[];app.identity.syncUserSiteProfileToSso=async(u,patch)=>{seen.push(patch.active_plans_count);return {ok:true};};
 let n=0;app.reservationEngine.createPlanAndJob=id=>{const plan={id:`p${++n}`,cloud_user_id:id,enabled:true};app.store.reservationPlans.set(plan.id,plan);return {plan};};
 for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url:'/api/v1/reservation-plans',headers:{authorization:`Bearer ${auth.access_token}`},body:{}});assert.equal(r.status,201);}
 assert.deepEqual(seen,[1]);await c.advance(30000);assert.deepEqual(seen,[1,2]);await app.closeProfileSync();
});
test('startup resends latest authoritative profile for credentialed active users only',async()=>{
 const initial=createCampusCloudApp();const store=initial.store;
 const user=store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'restart'});user.sso_access_token='synthetic';
 store.reservationPlans.set('restored',{id:'restored',cloud_user_id:user.id,enabled:true});
 const seen=[];initial.identity.syncUserSiteProfileToSso=async(u,p)=>{seen.push(p.active_plans_count);return {ok:true};};
 const app=createCampusCloudApp({store,identity:initial.identity});await settle();await app.closeProfileSync();assert.deepEqual(seen,[1]);await initial.closeProfileSync();
});
