import './test-secrets.mjs';
import { getReservationPriceVersion } from '../packages/contracts/src/index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

const now = Date.parse('2026-11-08T07:00:00+08:00');
function fixture() {
 const app=createCampusCloudApp();
 // Two users in one issuer and one in a separate issuer. All must be denied, not
 // merely the anonymous caller: the legacy records have no trustworthy owner.
 const actors=[['https://tenant-a.invalid','alice'],['https://tenant-a.invalid','bob'],['https://tenant-b.invalid','alice']].map(([issuer,subject])=>{
  const user=app.store.findOrCreateCloudUser({issuer,subject,displayName:subject});
  return {user,session:app.identity.issueDeviceSession(user,'offline-test',null,1,now,'MOBILE_APP')};
 });
 app.store.momentsState={posts:[{id:'known-post',contact:'private-post-contact',comments:[{contact_hint:'private-comment-contact'}]}],book_listings:[{id:'known-book',contact:'private-book-contact'}],anti_lost_tags:[{id:'known-tag',tag_code:'HAUT-TAG-ABC123',owner_contact:'private-owner-contact',reports:[{finder_contact:'private-finder-contact'}]}],isbn_catalog:[]};
 return {app,actors};
}
const routes=[
 ['GET','/api/v1/moments/snapshot?type=LOST&keyword=private'],
 ['POST','/api/v1/moments/posts',{id:'known-post',title:'overwrite'}],
 ['POST','/api/v1/moments/posts/known-post/comments',{content:'injected'}],
 ...['DELETE','RESOLVE','REOPEN','LIKE','FAVORITE'].map(action=>['POST','/api/v1/moments/posts/known-post/action',{action}]),
 ['POST','/api/v1/moments/books',{id:'known-book',title:'overwrite'}],
 ...['DELETE','MARK_SOLD','MARK_AVAILABLE','LIKE'].map(action=>['POST','/api/v1/moments/books/known-book/action',{action}]),
 ['GET','/api/v1/moments/isbn-resolve?isbn=123'],
 ['POST','/api/v1/moments/anti-lost-tags',{tag_code:'HAUT-TAG-ABC123',item_name:'overwrite',owner_contact:'attacker'}],
 ['POST','/api/v1/moments/anti-lost-tags/HAUT-TAG-ABC123/report-found',{found_location:'injected',finder_contact:'private-new-contact'}]
];
test('anonymous, same-tenant other users and cross-tenant users cannot read or mutate cloud Moments',async()=>{
 const {app,actors}=fixture();const before=JSON.stringify(app.store.momentsState);let saves=0;
 app.store.saveSnapshot=()=>{saves++;throw Error('Blocked route attempted persistence');};
 const headersList=[{}, {authorization:'Bearer invalid'}, ...actors.map(a=>({authorization:`Bearer ${a.session.access_token}`}))];
 for(const headers of headersList)for(const [method,url,body] of routes){
  const r=await app.inject({method,url,body,headers,nowMs:now});assert.equal(r.status,403,`${method} ${url}`);
  assert.equal(r.body.code,'FORBIDDEN');assert.doesNotMatch(JSON.stringify(r),/private-(post|book|owner|finder|comment)-contact/);
 }
 assert.equal(JSON.stringify(app.store.momentsState),before);assert.equal(saves,0);
});
test('claim links disclose neither tag existence nor owner/finder contacts for any auth context',async()=>{
 const {app,actors}=fixture();
 for(const headers of [{},...actors.map(a=>({authorization:`Bearer ${a.session.access_token}`}))]){
  for(const method of ['GET','HEAD','POST','OPTIONS'])for(const code of ['HAUT-TAG-ABC123','UNKNOWN']){
   const r=await app.inject({method,url:`/claim/${code}`,headers,nowMs:now});assert.equal(r.status,404);
   assert.doesNotMatch(JSON.stringify(r),/private-|HAUT-TAG-ABC123|UNKNOWN/);assert.equal(r.rawBody,undefined);
  }
 }
});
test('method/path variations and future Moments routes fail closed; health remains usable',async()=>{
 const {app}=fixture();
 for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'])for(const url of ['/api/v1/moments','/api/v1/moments/','/api/v1/moments/future-route','/api/v1/x/../moments/snapshot']){
  assert.equal((await app.inject({method,url,nowMs:now})).status,403);
 }
 assert.equal((await app.inject({url:'/healthz',nowMs:now})).status,200);
});

test('live provider create/cancel remain disabled even with legacy approval-looking flags',async()=>{
 const {app}=fixture();const provider=app.schoolProvider || app.reservationEngine.schoolProvider;
 const args={job:{capability:'AUTHORIZED_AUTOMATION',school_id:'haut',booking_local_date:'2026-11-08'},plan:{school_id:'haut'},binding:{id:'binding',school_id:'haut',status:'DELEGATED_ACTIVE'},schoolIntegration:{enabled:true,kill_switch:false,authorization_evidence_ref:'unverified',approver_primary_ref:'one',approver_secondary_ref:'two'},decryptedSecret:JSON.stringify({raw_token:'x'.repeat(64)}),nowInstant:new Date(now)};
 let touched=0;provider.wslibGetJson=provider.authenticateHautSession=async()=>{touched++;throw Error('Live transport');};
 await assert.rejects(provider.executeMockOrAuthorizedCreate(args),{code:'SCHOOL_PERMISSION_REQUIRED'});
 await assert.rejects(provider.cancelLiveSeatBooking(args),{code:'SCHOOL_PERMISSION_REQUIRED'});
 assert.equal(touched,0);
});

test('existing live FIRE jobs cannot execute or settle ambiguous results; Mock still works',async()=>{
 const {app,actors}=fixture();const user=actors[0].user;
 const provider=app.reservationEngine.schoolProvider;let touched=0;
 provider.executeMockOrAuthorizedCreate=provider.verifyBookingAuthoritative=async()=>{touched++;throw Error('Live operation');};
 app.store.saveSnapshot=()=>true;
 app.reservationEngine._decryptBindingCredential=()=>JSON.stringify({raw_token:'x'.repeat(64)});
 app.store.schoolBindings.set('bind',{id:'bind',cloud_user_id:user.id,school_id:'haut',status:'DELEGATED_ACTIVE'});
 app.store.consents.set('consent',{id:'consent',cloud_user_id:user.id,school_id:'haut',scope_list:['LIBRARY_SEAT_RESERVATION','CREDENTIAL_ESCROW']});
 for(const state of ['ARMED','RESULT_UNKNOWN']){
  const created=app.reservationEngine.createPlanAndJob(user.id,{accepted_price_version:getReservationPriceVersion(app.store.pricingMicropeach),accepted_price_micropeach:app.store.pricingMicropeach,school_binding_id:'bind',consent_id:'consent',target_local_date:'2026-11-08',target_local_time:'07:00:00'},now-3600000);
  const job=app.store.reservationJobs.get(created.job_id);job.state=state;job.capability="AUTHORIZED_AUTOMATION";
  const result=await app.reservationEngine.runScheduleEvent(job.id,'FIRE',now+100);
  assert.equal(result.event.diagnostic_code,'SCHOOL_PERMISSION_REQUIRED');assert.equal(job.state,state==='RESULT_UNKNOWN'?'RESULT_UNKNOWN':'CANCELLED');
  job.state='CANCELLED';
 }
 assert.equal(touched,0);assert.equal(app.store.reservationOrders.size,0);
 const {HautLibraryProvider}=await import('../packages/school-spi/src/index.mjs');
 const mock=new HautLibraryProvider({mockBackend:{handleCreateReservation:async()=>({outcome:'SUBMITTED',externalBookingId:'synthetic-mock'})}});
 assert.equal((await mock.executeMockOrAuthorizedCreate({job:{school_id:'haut'},plan:{school_id:'haut'},binding:{id:'mock',school_id:'haut',status:'DELEGATED_ACTIVE'},nowInstant:new Date(now)})).externalBookingId,'synthetic-mock');
});
