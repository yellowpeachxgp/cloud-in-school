import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudDatabaseStore } from '../packages/db/src/index.mjs';
import { TripleScheduleEngine, computeTripleSchedule } from '../packages/reservations/src/index.mjs';
import { HautLibraryProvider } from '../packages/school-spi/src/index.mjs';
import { getReservationPriceVersion } from '../packages/contracts/src/index.mjs';
import { createCampusCloudApp as createApp } from '../apps/api/src/app.mjs';
import { scanDueScheduleEvents } from '../apps/scheduler/src/main.mjs';

// No live school, identity, or financial network traffic is permitted in this file.
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const T = Date.parse('2026-11-07T08:00:00+08:00');
const secret = JSON.stringify({ raw_token: 'fictional-token-for-isolated-regression-only-0000000' });
const target = { school_id:'haut', binding_id:'binding', booking_local_date:'2026-11-07', seat_id:'7', region_id:'8', start_full:'2026-11-07 08:00:00', end_full:'2026-11-07 22:00:00' };
function authorized(store) {
  const integration = store.schoolIntegrations.get('haut');
  Object.assign(integration, { kill_switch:false, authorization_evidence_ref:'test-evidence', approver_primary_ref:'one', approver_secondary_ref:'two',
    authorization_approval:{ id:'approval', status:'APPROVED', evidence_ref:'test-evidence', primary_actor_ref:'one', secondary_actor_ref:'two', expires_at:'2099-01-01T00:00:00Z' } });
  store.setUserRoles('one', ['SCHOOL_OPERATOR']); store.setUserRoles('two', ['SCHOOL_OPERATOR']);
}
function fixture(t, { live=false, wallet=50000, maxLateness=1800 }={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reservation-safety-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new CloudDatabaseStore({snapshotPath:path.join(dir,'state.json')});
  const provider=new HautLibraryProvider();
  // Test latent authorization/settlement safeguards with a synthetic provider only.
  // Production has no enable flag; containment is tested separately without this stub.
  provider.assertLiveAutomationEnabled = () => {};
  if (live) authorized(store);
  const binding={id:'binding',cloud_user_id:'user',school_id:'haut',status:'DELEGATED_ACTIVE'};
  store.schoolBindings.set(binding.id,binding);
  store.consents.set('consent',{id:'consent',cloud_user_id:'user',school_id:'haut',scope_list:['LIBRARY_SEAT_RESERVATION','CREDENTIAL_ESCROW'],withdrawn_at:null});
  const state={writes:0,debits:0,wallet};
  const finance={getWalletSnapshot:async()=>({micropeach_balance:state.wallet}),createAndSettleOrderForConfirmedJob:async()=>{state.debits++;return {payment_state:'PAID'};}};
  const engine=new TripleScheduleEngine(store,provider,finance,{});
  engine._decryptBindingCredential=()=>secret;
  provider.prewarmJobTargetSeats=async()=>null;
  const payload={school_binding_id:'binding',consent_id:'consent',target_local_date:'2026-11-07',target_local_time:'08:00:00',max_lateness_seconds:maxLateness,accepted_price_version:getReservationPriceVersion(store.pricingMicropeach),accepted_price_micropeach:store.pricingMicropeach};
  const created=engine.createPlanAndJob('user',payload,T-3600000);
  const job=store.reservationJobs.get(created.job_id);
  return {store,provider,engine,job,state,payload,binding};
}
async function stages(f) {
  await f.engine.runScheduleEvent(f.job.id,'PRECHECK',T-1800000);
  await f.engine.runScheduleEvent(f.job.id,'FINAL_CHECK',T-300000);
}

test('wrong-school and empty-scope consents are rejected before plan creation', t=>{
  const f=fixture(t);
  f.store.reservationJobs.clear();
  const consent=f.store.consents.get('consent');
  consent.school_id='other';
  assert.throws(()=>f.engine.createPlanAndJob('user',f.payload,T-3600000),{code:'CONSENT_WITHDRAWN'});
  consent.school_id='haut'; consent.scope_list=[];
  assert.throws(()=>f.engine.createPlanAndJob('user',f.payload,T-3600000),{code:'CONSENT_WITHDRAWN'});
});

test('MOCK_ONLY remains sandboxed when a later school approval appears', async t=>{
  const f=fixture(t);
  authorized(f.store);
  f.provider.wslibGetJson=async()=>{throw new Error('LIVE_PATH_REACHED');};
  f.provider.prewarmJobTargetSeats=async()=>{throw new Error('PREWARM_REACHED');};
  await stages(f);
  const result=await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
  assert.equal(result.job.capability,'MOCK_ONLY');
  assert.equal(result.job.state,'CONFIRMED');
});

test('kill switch, consent withdrawal, and current operator-role revocation gate live FIRE', async t=>{
  for (const change of [f=>f.store.schoolIntegrations.get('haut').kill_switch=true,f=>f.store.consents.get('consent').withdrawn_at=new Date().toISOString(),f=>f.store.setUserRoles('one',[])]) {
    const f=fixture(t,{live:true});
    f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
    await stages(f); change(f);
    await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
    assert.equal(f.state.writes,0); assert.equal(f.state.debits,0);
  }
});

test('failed or missing prerequisites cannot be erased by FINAL_CHECK or FIRE', async t=>{
  const f=fixture(t,{wallet:0});
  f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
  await f.engine.runScheduleEvent(f.job.id,'PRECHECK',T-1800000);
  assert.equal(f.job.state,'SKIPPED_FINANCE');
  f.state.wallet=50000;
  await f.engine.runScheduleEvent(f.job.id,'FINAL_CHECK',T-300000);
  await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
  assert.equal(f.state.writes,0); assert.equal(f.state.debits,0);
  assert.equal([...f.store.scheduleEvents.values()].find(e=>e.kind==='PRECHECK').status,'PRECHECK_NEEDS_USER');
});

test('wallet read failures fail closed, and accepted short expiry is not extended', async t=>{
  const f=fixture(t,{maxLateness:60});
  await stages(f);
  f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
  await f.engine.runScheduleEvent(f.job.id,'FIRE',T+60000);
  assert.equal(f.job.state,'EXPIRED'); assert.equal(f.state.writes,0);
  const g=fixture(t);
  g.engine.financeService.getWalletSnapshot=async()=>{throw new Error('offline');};
  await g.engine.runScheduleEvent(g.job.id,'PRECHECK',T-1800000);
  assert.equal(g.job.state,'SKIPPED_AUTH');
});

test('durable intent survives restart and reconciles without a second create', async t=>{
  const f=fixture(t,{live:true}); await stages(f);
  f.provider.executeMockOrAuthorizedCreate=async ({beforeCreate})=>{
    await beforeCreate(target); f.state.writes++;
    const persisted=JSON.parse(fs.readFileSync(f.store.snapshotPath,'utf8'));
    const stored=persisted.reservationJobs.find(([id])=>id===f.job.id)[1];
    assert.equal(stored.attempt_count,1); assert.deepEqual(stored.submission_target,target);
    throw new Error('connection lost after server may accept');
  };
  await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
  assert.equal(f.job.state,'RESULT_UNKNOWN'); assert.equal(f.state.debits,0);
  const store2=new CloudDatabaseStore({snapshotPath:f.store.snapshotPath});
  const engine2=new TripleScheduleEngine(store2,f.provider,f.engine.financeService,{});
  engine2._decryptBindingCredential=()=>secret;
  f.provider.verifyBookingAuthoritative=async()=>({verified:true,externalBookingId:'12',officialStatus:'CONFIRMED',evidenceSha256:'proof'});
  const result=await engine2.runScheduleEvent(f.job.id,'FIRE',T+3600000);
  assert.equal(result.job.state,'CONFIRMED'); assert.equal(f.state.writes,1); assert.equal(f.state.debits,1);
});

test('failed required snapshot prevents any live provider create', async t=>{
  const f=fixture(t,{live:true}); await stages(f);
  f.store.saveSnapshot=({required}={})=>{if(required)throw new Error('disk full');return false;};
  f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
  await assert.rejects(f.engine.runScheduleEvent(f.job.id,'FIRE',T),/disk full/);
  assert.equal(f.state.writes,0);
});

test('policy and consent are rechecked after provider discovery before the write checkpoint', async t=>{
  const f=fixture(t,{live:true}); await stages(f);
  f.provider.executeMockOrAuthorizedCreate=async({beforeCreate})=>{
    f.store.schoolIntegrations.get('haut').kill_switch=true;
    await beforeCreate(target); f.state.writes++;
    return {outcome:'SUBMITTED'};
  };
  await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
  assert.equal(f.state.writes,0); assert.equal(f.state.debits,0);
});

test('failed remote cancellation preserves confirmed official state, uncertain jobs are not replaced',async t=>{
  const f=fixture(t,{live:true});
  f.job.state='CONFIRMED'; f.job.attempt_count=1;
  f.store.schoolReservations.set(f.job.id,{external_booking_id:'12',official_status:'CONFIRMED'});
  f.provider.cancelLiveSeatBooking=async()=>({cancelled:false,message:'upstream refused'});
  const result=await f.engine.cancelConfirmedOrActiveJob(f.job.id,T);
  assert.equal(result.job.state,'CONFIRMED'); assert.equal(result.school_reservation.official_status,'CONFIRMED');
  f.job.state='RESULT_UNKNOWN'; f.store.schoolReservations.clear();
  assert.throws(()=>f.engine.createPlanAndJob('user',{...f.payload,replace_existing:true},T-3600000),{code:'CONFLICT'});
  const pending=await f.engine.cancelConfirmedOrActiveJob(f.job.id,T);
  assert.equal(pending.job.state,'RESULT_UNKNOWN'); assert.equal(pending.live_cancel.cancelled,false);
});

test('late catch-up is pending real checks and invalid or stale target dates are rejected',()=>{
  const rules=new HautLibraryProvider().getRules();
  const s=computeTripleSchedule({targetLocalDate:'2026-11-07',targetLocalTime:'08:00',rules,nowMs:T-60000});
  assert.equal(s.precheckInitialStatus,'ARMED'); assert.equal(s.finalCheckInitialStatus,'ARMED');
  assert.equal(s.targetAtMs,T);
  assert.throws(()=>computeTripleSchedule({targetLocalDate:'2026-02-30',targetLocalTime:'08:00',rules,nowMs:0}),{code:'BAD_REQUEST'});
  assert.throws(()=>computeTripleSchedule({targetLocalDate:'2026-11-07',targetLocalTime:'08:00',rules,nowMs:T+3600000}),{code:'BOOKING_WINDOW_CLOSED'});
});

test('persisted and legacy school settings remain fail-closed across reload',t=>{
  const f=fixture(t,{live:true});
  f.store.schoolIntegrations.get('haut').kill_switch=true; f.store.saveSnapshot({required:true});
  assert.equal(new CloudDatabaseStore({snapshotPath:f.store.snapshotPath}).schoolIntegrations.get('haut').kill_switch,true);
  fs.writeFileSync(f.store.snapshotPath,JSON.stringify({schoolBindings:[]}));
  assert.equal(new CloudDatabaseStore({snapshotPath:f.store.snapshotPath}).schoolIntegrations.get('haut').kill_switch,true);
});

test('school policy requires two authenticated operators and a durable explicit kill-switch release', async t=>{
  const f=fixture(t); const app=createCampusCloudApp({store:f.store}); const now=Date.now();
  const headers=[];
  for(const subject of ['admin-one','admin-two']) {
    const u=f.store.findOrCreateCloudUser({issuer:'test',subject}); f.store.setUserRoles(u.id,['PLATFORM_OWNER']);
    const session=app.identity.issueDeviceSession(u,'test',null,1,now); headers.push({authorization:`Bearer ${session.access_token}`});
  }
  const url='/api/v1/admin/schools/haut/authorization-approval';
  const forged=await app.inject({method:'POST',url,headers:headers[0],body:{secondary_approver_ref:'made-up'},nowMs:now});
  assert.equal(forged.status,400);
  const first=await app.inject({method:'POST',url,headers:headers[0],body:{evidence_ref:'test-evidence',expires_at:'2099-01-01T00:00:00Z'},nowMs:now});
  assert.equal(first.status,200); assert.equal(first.body.code,'SCHOOL_AUTHORIZATION_PENDING');
  const id=first.body.data.authorization_request.id;
  const repeat=await app.inject({method:'POST',url,headers:headers[0],body:{authorization_request_id:id},nowMs:now});
  assert.equal(repeat.status,403);
  const approved=await app.inject({method:'POST',url,headers:headers[1],body:{authorization_request_id:id},nowMs:now});
  assert.equal(approved.body.code,'SCHOOL_AUTHORIZATION_APPROVED'); assert.equal(approved.body.data.kill_switch,true);
  const kill='/api/v1/admin/schools/haut/kill-switch';
  const malformed=await app.inject({method:'POST',url:kill,headers:headers[0],body:{},nowMs:now});
  assert.equal(malformed.status,400);
  const enabled=await app.inject({method:'POST',url:kill,headers:headers[0],body:{kill_switch:false},nowMs:now});
  assert.equal(enabled.status,200);
  const loaded=new CloudDatabaseStore({snapshotPath:f.store.snapshotPath});
  assert.equal(new HautLibraryProvider().isLiveAuthorized(loaded.schoolIntegrations.get('haut')),true);
});

test('scheduler reconciles crash-interrupted EXECUTING intent without repeating CREATE after expiry',async t=>{
  const f=fixture(t,{live:true});
  f.job.state='EXECUTING'; f.job.attempt_count=1; f.job.submission_target=target;
  for(const e of f.store.scheduleEvents.values())e.status='DONE';
  f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
  let reads=0; f.provider.verifyBookingAuthoritative=async()=>{reads++;return {verified:false};};
  await scanDueScheduleEvents({store:f.store,reservationEngine:f.engine},T+3600000);
  assert.equal(reads,1); assert.equal(f.state.writes,0); assert.equal(f.job.state,'RESULT_UNKNOWN');
});

test('revocation preserves uncertain school result durably instead of falsely cancelling it',t=>{
  for(const revoke of [f=>f.store.haltAllUserPlansAndBindings('user'),f=>f.store.revokeSchoolBindingCascade('user','binding')]) {
    const f=fixture(t,{live:true}); f.job.state='EXECUTING'; f.job.attempt_count=1; revoke(f);
    assert.equal(f.job.state,'RESULT_UNKNOWN');
    assert.equal(new CloudDatabaseStore({snapshotPath:f.store.snapshotPath}).reservationJobs.get(f.job.id).state,'RESULT_UNKNOWN');
  }
});

test('stopping a plan with active consent still allows pending-result readback',async t=>{
  const f=fixture(t,{live:true}); f.job.state='RESULT_UNKNOWN'; f.job.attempt_count=1; f.job.submission_target=target;
  await f.engine.cancelConfirmedOrActiveJob(f.job.id,T);
  let reads=0; f.provider.verifyBookingAuthoritative=async()=>{reads++; return {verified:false};};
  await f.engine.runScheduleEvent(f.job.id,'FIRE',T+3600000);
  assert.equal(reads,1); assert.equal(f.job.state,'RESULT_UNKNOWN');
});

test('legacy missing accepted price snapshot blocks stages before live submission',async t=>{
  const f=fixture(t,{live:true}); delete f.store.reservationPlans.get(f.job.plan_id).price_accepted_at;
  f.provider.executeMockOrAuthorizedCreate=async()=>{f.state.writes++;};
  await stages(f); await f.engine.runScheduleEvent(f.job.id,'FIRE',T);
  assert.equal(f.state.writes,0); assert.equal(f.state.debits,0);
});

test('execute-now cannot fabricate a future clock to book early',async t=>{
  const f=fixture(t); const app=createCampusCloudApp({store:f.store}); const now=T-3600000;
  const user=f.store.findOrCreateCloudUser({issuer:'test',subject:'future-clock-test'});
  const session=app.identity.issueDeviceSession(user,'test',null,1,now); f.job.cloud_user_id=user.id;
  let runs=0; app.reservationEngine.runScheduleEvent=async()=>{runs++;};
  const response=await app.inject({method:'POST',url:`/api/v1/reservation-jobs/${f.job.id}/execute-now`,headers:{authorization:`Bearer ${session.access_token}`},nowMs:now});
  assert.equal(response.status,422); assert.equal(response.body.code,'BOOKING_WINDOW_CLOSED'); assert.equal(runs,0);
});

test('an invalid replacement never cancels the existing valid plan',t=>{
  const f=fixture(t);
  assert.throws(()=>f.engine.createPlanAndJob('user',{...f.payload,replace_existing:true,target_local_time:'06:00:00'},T-3600000),{code:'BOOKING_WINDOW_CLOSED'});
  assert.equal(f.job.state,'ARMED');
  assert.equal(f.store.reservationPlans.get(f.job.plan_id).enabled,true);
  assert.equal(f.store.reservationJobs.size,1);
});

// Legacy service fixtures are not console-login authorization tests.
function createCampusCloudApp(options = {}) { return createApp({requireAdminAccess:false, ...options}); }
