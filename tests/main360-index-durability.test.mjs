import './test-secrets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CloudDatabaseStore} from '../packages/db/src/index.mjs';
import {createCampusCloudApp} from '../apps/api/src/app.mjs';

test('issuer/subject tuple index cannot collide on delimiter characters',()=>{
 const db=new CloudDatabaseStore();
 const a=db.findOrCreateCloudUser({issuer:'https://issuer.invalid/a|b',subject:'c'});
 const b=db.findOrCreateCloudUser({issuer:'https://issuer.invalid/a',subject:'b|c'});
 assert.notEqual(a.id,b.id);
 assert.equal(db.findOrCreateCloudUser({issuer:a.issuer,subject:a.subject}).id,a.id);
});
test('derived scoped indexes follow ordinary Map insert/replace/delete/clear and reject stale ownership',()=>{
 const db=new CloudDatabaseStore();
 for(const name of ['schoolBindings','reservationPlans','reservationJobs','reservationOrders','consents','notifications']){
  db[name].set('id',{id:'id',cloud_user_id:'alice',job_id:'job-a'});
  assert.equal(db.recordsForUser(name,'alice').length,1);
  db[name].set('id',{id:'id',cloud_user_id:'bob',job_id:'job-b'});
  assert.equal(db.recordsForUser(name,'alice').length,0);assert.equal(db.recordsForUser(name,'bob').length,1);
  db[name].get('id').cloud_user_id='carol';assert.equal(db.recordsForUser(name,'bob').length,0);
  db[name].delete('id');assert.equal(db.recordsForUser(name,'bob').length,0);
  db[name].set('id2',{cloud_user_id:'alice'});db[name].clear();assert.equal(db.recordsForUser(name,'alice').length,0);
 }
 db.scheduleEvents.set('ev',{job_id:'one'});assert.equal(db.eventsForJob('one').length,1);
 db.scheduleEvents.set('ev',{job_id:'two'});assert.equal(db.eventsForJob('one').length,0);assert.equal(db.eventsForJob('two').length,1);
 db.scheduleEvents.clear();assert.equal(db.eventsForJob('two').length,0);
});
test('required persistence remains synchronous and immediately reloadable, never a deferred intent',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-main360-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const snapshotPath=path.join(dir,'snapshot.json');const db=new CloudDatabaseStore({snapshotPath});
 db.reservationJobs.set('job',{id:'job',cloud_user_id:'alice',state:'RESULT_UNKNOWN'});
 assert.equal(db.saveSnapshot({required:true}),true);
 assert.equal(new CloudDatabaseStore({snapshotPath}).recordsForUser('reservationJobs','alice')[0].state,'RESULT_UNKNOWN');
 assert.throws(()=>new CloudDatabaseStore().saveSnapshot({required:true}));
});
test('breakglass is issuer-scoped and removal/demotion cannot leave persistent privileges',()=>{
 const db=new CloudDatabaseStore({adminSsoSubjects:['same'],adminSsoIssuer:'https://issuer-a.invalid'});
 const a=db.findOrCreateCloudUser({issuer:'https://issuer-a.invalid',subject:'same'});
 const b=db.findOrCreateCloudUser({issuer:'https://issuer-b.invalid',subject:'same'});
 assert.equal(db.hasAdminAccess(a.id),true);assert.equal(db.hasAdminAccess(b.id),false);
 db.adminSsoSubjects.clear();assert.equal(db.hasAdminAccess(a.id),false);
 const admin=db.findOrCreateCloudUser({issuer:'https://issuer-a.invalid',subject:'admin',role:'admin'});
 assert.equal(db.getUserRoles(admin.id).includes('PLATFORM_OWNER'),false);
 db.userRoles.set(admin.id,new Set(['PLATFORM_OWNER']));admin.role='member';assert.equal(db.hasAdminAccess(admin.id),false);
});
test('idempotency capacity rejection happens before creating work and preserves existing receipts',async()=>{
 const app=createCampusCloudApp();const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'capacity'});
 const session=app.identity.issueDeviceSession(user,'Phone',null,1,Date.now(),'MOBILE_APP');
 for(let i=0;i<2000;i++)app.store.idempotencyRecords.set('receipt'+i,{data:{}});
 let calls=0;app.reservationEngine.createPlanAndJob=()=>{calls++;return {};};
 const r=await app.inject({method:'POST',url:'/api/v1/reservation-plans',headers:{authorization:`Bearer ${session.access_token}`,'idempotency-key':'new'},body:{}});
 assert.equal(r.status,409);assert.equal(calls,0);assert.equal(app.store.idempotencyRecords.size,2000);
});
