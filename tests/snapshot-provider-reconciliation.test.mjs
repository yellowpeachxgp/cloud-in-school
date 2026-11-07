import './test-secrets.mjs';
import { getReservationPriceVersion } from '../packages/contracts/src/index.mjs';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { HautLibraryProvider } from '../packages/school-spi/src/index.mjs';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

function fixture() {
 const provider = new HautLibraryProvider();
 provider.parseCredentialBundle = () => ({isLiveCredential:true, raw_token:'synthetic'});
 const binding = {id:'binding-a',school_id:'haut',status:'DELEGATED_ACTIVE'};
 const job = {capability:'AUTHORIZED_AUTOMATION',school_id:'haut',booking_local_date:'2026-11-08',prewarmed_targets:{region_id:7,region_name:'Room',candidate_seats:[{id:12}],start_full:'2026-11-08 07:00:00',end_full:'2026-11-08 09:00:00'}};
 const active = {bookingId:'44',seatId:12,bookingStatus:1,startDate:'2026-11-08 07:00:00',endDate:'2026-11-08 09:00:00'};
 const plan={school_id:'haut',area_name:'Room',candidate_seats:['12']};
 const schoolIntegration={school_id:'haut',enabled:true,kill_switch:false,authorization_evidence_ref:'evidence',approver_primary_ref:'alice',approver_secondary_ref:'bob',authorization_approval:{id:'approval',status:'APPROVED',expires_at:'2099-01-01T00:00:00Z',evidence_ref:'evidence',primary_actor_ref:'alice',secondary_actor_ref:'bob'}};
 return {provider,binding,job,active,plan,schoolIntegration};
}
for (const kind of ['wrong id','wrong seat','wrong date','missing id','timeout','exact']) {
 test(`live submission readback: ${kind}`, async () => {
  const {provider,binding,job,active,plan,schoolIntegration}=fixture(); let writes=0, persists=0;
  if(kind==='wrong id') active.bookingId='99';
  if(kind==='wrong seat') active.seatId=99;
  if(kind==='wrong date') active.startDate='2026-11-09 07:00:00';
  provider.wslibGetJson=async()=>{writes++;if(kind==='timeout')throw Error('offline timeout');return {code:200,bookingid:kind==='missing id'?null:'44'};};
  let reads=0; provider.fetchCurrentActiveBooking=async()=>++reads===1?null:active;
  const result=await provider.executeMockOrAuthorizedCreate({job,binding,plan,schoolIntegration,nowInstant:new Date('2026-11-08T07:00:00+08:00'),beforeCreate:()=>{persists++;}});
  assert.equal(result.outcome,kind==='exact'?'SUBMITTED':'TIMEOUT_AMBIGUOUS');
  assert.equal(writes,1);assert.ok(persists>=1);
  if(kind==='exact') assert.equal((await provider.verifyBookingAuthoritative({job,binding,rawToken:'synthetic',expectedExternalBookingId:'44'})).verified,true);
 });
}
test('duplicate response cannot adopt arbitrary active booking',async()=>{
 const {provider,binding,job,active,plan,schoolIntegration}=fixture();provider.wslibGetJson=async()=>({code:500,msg:'seat.10079'});provider.fetchCurrentActiveBooking=async()=>active;
 const result=await provider.executeMockOrAuthorizedCreate({job,binding,plan,schoolIntegration,nowInstant:new Date('2026-11-08T07:00:00+08:00')});assert.equal(result.outcome,'TIMEOUT_AMBIGUOUS');
});
test('verification with no saved target fails closed',async()=>{
 const {provider,binding,job,active,plan,schoolIntegration}=fixture();provider.fetchCurrentActiveBooking=async()=>active;
 assert.equal((await provider.verifyBookingAuthoritative({job,binding,rawToken:'synthetic',expectedExternalBookingId:'44'})).verified,false);
});

test('snapshot replay preserves cancellation, client ID idempotence and missing-ID safety',async(t)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-sync-merge-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const snapshotPath=path.join(dir,'store.json');
 const app=createCampusCloudApp({storeOptions:{snapshotPath}});const now=Date.parse('2026-11-08T05:00:00+08:00');
 const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'sync-test',displayName:'Test'});
 const session=app.identity.issueDeviceSession(user,'test',null,1,now);
 const headers={authorization:`Bearer ${session.access_token}`};
 app.store.schoolBindings.set('bind',{id:'bind',cloud_user_id:user.id,school_id:'haut',status:'DELEGATED_ACTIVE'});
 app.store.consents.set('consent',{id:'consent',cloud_user_id:user.id,school_id:'haut',scope_list:['LIBRARY_SEAT_RESERVATION','CREDENTIAL_ESCROW']});
 const push=body=>app.inject({method:'POST',url:'/api/v1/sync/snapshot',headers,body,nowMs:now});
 const item={accepted_price_version:getReservationPriceVersion(app.store.pricingMicropeach),accepted_price_micropeach:app.store.pricingMicropeach,plan_id:'client-stable',target_local_date:'2026-11-08',target_local_time:'07:00:00',area_name:'A',candidate_seats:['1']};
 await push({reservation_plan_upserts:[{...item,accepted_price_version:undefined}]});
 assert.equal(app.store.reservationPlans.size,0);
 let r=await push({reservation_plan_upserts:[item]}); assert.equal(r.status,200);
 assert.equal(app.store.reservationPlans.size,1);
 await push({reservation_plan_upserts:[item]});assert.equal(app.store.reservationPlans.size,1);
 const plan=[...app.store.reservationPlans.values()][0];
 assert.equal(plan.preferences_json.allow_alternative_seat,false);
 await push({reservation_cancellations:[plan.id],reservation_plan_upserts:[{...item,plan_id:plan.id}]});
 await push({reservation_plan_upserts:[item,{...item,plan_id:plan.id},{...item,plan_id:undefined}]});
 assert.equal(app.store.reservationPlans.size,1);assert.equal(plan.enabled,false);
 await push({reservation_cancellations:['never-seen'],reservation_plan_upserts:[{...item,plan_id:'never-seen'}]});
 assert.equal(app.store.reservationPlans.size,1);
 assert.ok(user.reservation_sync_tombstones.includes('never-seen'));
 const reloaded=createCampusCloudApp({storeOptions:{snapshotPath}});
 assert.ok(reloaded.store.users.get(user.id).reservation_sync_tombstones.includes('never-seen'));
 assert.equal(reloaded.store.reservationPlans.get(plan.id).enabled,false);
});

test('stale binding and plan snapshots cannot restore withdrawn consent or revoked delegation',async()=>{
 const app=createCampusCloudApp();const now=Date.parse('2026-11-08T05:00:00+08:00');
 const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'revoked-sync',displayName:'Test'});
 const session=app.identity.issueDeviceSession(user,'test',null,1,now);
 const headers={authorization:`Bearer ${session.access_token}`};
 const binding={id:'revoked-bind',cloud_user_id:user.id,school_id:'haut',student_no:'original',status:'REVOKED',revoked_at:new Date(now).toISOString(),credential_ref:null};
 const consent={id:'withdrawn-consent',cloud_user_id:user.id,school_id:'haut',scope_list:['LIBRARY_SEAT_RESERVATION','CREDENTIAL_ESCROW'],withdrawn_at:new Date(now).toISOString()};
 app.store.schoolBindings.set(binding.id,binding);app.store.consents.set(consent.id,consent);
 const body={school_binding_upserts:[{school_id:'haut',student_no:'stale-student',delegated_secret:'synthetic-stale-secret'}],reservation_plan_upserts:[{plan_id:'stale-new-plan',target_local_date:'2026-11-08',target_local_time:'07:00:00',accepted_price_version:getReservationPriceVersion(app.store.pricingMicropeach),accepted_price_micropeach:app.store.pricingMicropeach}]};
 const push=()=>app.inject({method:'POST',url:'/api/v1/sync/snapshot',headers,body,nowMs:now});
 assert.equal((await push()).status,200);
 assert.equal(app.store.schoolBindings.size,1);assert.equal(binding.status,'REVOKED');assert.equal(binding.student_no,'original');
 assert.equal(app.store.consents.size,1);assert.ok(consent.withdrawn_at);assert.equal(app.store.encryptedCredentials.size,0);assert.equal(app.store.reservationPlans.size,0);
 // Consent withdrawal alone must also block plans and prevent credential refresh.
 binding.status='DELEGATED_ACTIVE';binding.revoked_at=null;
 await push();assert.equal(app.store.consents.size,1);assert.ok(consent.withdrawn_at);assert.equal(app.store.encryptedCredentials.size,0);assert.equal(binding.student_no,'original');assert.equal(app.store.reservationPlans.size,0);
 // A new account cannot enrol through the same background snapshot payload either.
 app.store.schoolBindings.clear();app.store.consents.clear();await push();
 assert.equal(app.store.schoolBindings.size,0);assert.equal(app.store.consents.size,0);assert.equal(app.store.reservationPlans.size,0);
});

test('snapshot keeps completed job zero and preserves repeat total after rollover',async()=>{
const app=createCampusCloudApp();const now=Date.parse('2026-11-08T05:00:00+08:00');
const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'snapshot-incremental'});
const session=app.identity.issueDeviceSession(user,'audit',null,1,now);
const plan={id:'plan',cloud_user_id:user.id,school_id:'haut',school_binding_id:'binding',repeat_days:7,remaining_days:7,enabled:true,generation:1,target_local_date:'2026-11-08',target_local_time:'07:00:00'};
const old={id:'old',plan_id:plan.id,cloud_user_id:user.id,school_id:'haut',booking_local_date:'2026-11-08',repeat_days:7,remaining_days:7,state:'CONFIRMED'};
app.store.reservationPlans.set(plan.id,plan);app.store.reservationJobs.set(old.id,old);
const next=app.reservationEngine.rolloverMultiDayPlanIfEligible(plan,old,'synthetic',now);
const snapshot=async()=>{const r=await app.inject({method:'GET',url:'/api/v1/sync/snapshot',headers:{authorization:`Bearer ${session.access_token}`},nowMs:now});assert.equal(r.status,200);return r.body.data;};
let s=await snapshot();const jobs=s.reservation_jobs;
assert.equal(jobs.find(j=>j.id==='old').remaining_days,0);
assert.equal(jobs.find(j=>j.id===next.id).remaining_days,6);
assert.equal(jobs.find(j=>j.id===next.id).repeat_days,7);
plan.repeat_days=1;next.repeat_days=7;s=await snapshot();assert.equal(s.reservation_jobs.find(j=>j.id===next.id).repeat_days,7);
delete next.remaining_days;s=await snapshot();assert.equal(s.reservation_jobs.find(j=>j.id===next.id).remaining_days,6);

});
