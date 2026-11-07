import test from 'node:test';
import assert from 'node:assert/strict';
import { HautLibraryProvider } from '../packages/school-spi/src/index.mjs';
import { createCampusCloudApp } from '../apps/api/src/app.mjs';

function fixture() {
 const provider = new HautLibraryProvider();
 provider.parseCredentialBundle = () => ({isLiveCredential:true, raw_token:'synthetic'});
 const binding = {id:'binding-a',school_id:'haut',status:'DELEGATED_ACTIVE'};
 const job = {school_id:'haut',booking_local_date:'2026-11-08',prewarmed_targets:{candidate_seats:[{id:12}],start_full:'2026-11-08 07:00:00',end_full:'2026-11-08 09:00:00'}};
 const active = {bookingId:'44',seatId:12,bookingStatus:1,startDate:'2026-11-08 07:00:00',endDate:'2026-11-08 09:00:00'};
 return {provider,binding,job,active};
}
for (const kind of ['wrong id','wrong seat','wrong date','missing id','timeout','exact']) {
 test(`live submission readback: ${kind}`, async () => {
  const {provider,binding,job,active}=fixture(); let writes=0, persists=0;
  if(kind==='wrong id') active.bookingId='99';
  if(kind==='wrong seat') active.seatId=99;
  if(kind==='wrong date') active.startDate='2026-11-09 07:00:00';
  provider.wslibGetJson=async()=>{writes++;if(kind==='timeout')throw Error('offline timeout');return {code:200,bookingid:kind==='missing id'?null:'44'};};
  provider.fetchCurrentActiveBooking=async()=>active;
  const result=await provider.executeMockOrAuthorizedCreate({job,binding,plan:{},nowInstant:new Date('2026-11-08T07:00:00+08:00'),persistSubmission:()=>{persists++;}});
  assert.equal(result.outcome,kind==='exact'?'SUBMITTED':'TIMEOUT_AMBIGUOUS');
  assert.equal(writes,1);assert.ok(persists>=1);
  if(kind==='exact') assert.equal((await provider.verifyBookingAuthoritative({job,binding,rawToken:'synthetic',expectedExternalBookingId:'44'})).verified,true);
 });
}
test('duplicate response cannot adopt arbitrary active booking',async()=>{
 const {provider,binding,job,active}=fixture();provider.wslibGetJson=async()=>({code:500,msg:'seat.10079'});provider.fetchCurrentActiveBooking=async()=>active;
 const result=await provider.executeMockOrAuthorizedCreate({job,binding,plan:{},nowInstant:new Date('2026-11-08T07:00:00+08:00')});assert.equal(result.outcome,'FAILED');
});
test('verification with no saved target fails closed',async()=>{
 const {provider,binding,job,active}=fixture();provider.fetchCurrentActiveBooking=async()=>active;
 assert.equal((await provider.verifyBookingAuthoritative({job,binding,rawToken:'synthetic',expectedExternalBookingId:'44'})).verified,false);
});

test('snapshot replay preserves cancellation, client ID idempotence and missing-ID safety',async()=>{
 const app=createCampusCloudApp();const now=Date.parse('2026-11-08T05:00:00+08:00');
 const user=app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'sync-test',displayName:'Test'});
 const session=app.identity.issueDeviceSession(user,'test',null,1,now);
 const headers={authorization:`Bearer ${session.access_token}`};
 app.store.schoolBindings.set('bind',{id:'bind',cloud_user_id:user.id,school_id:'haut',status:'DELEGATED_ACTIVE'});
 app.store.consents.set('consent',{id:'consent',cloud_user_id:user.id,school_id:'haut',scope_list:['LIBRARY_SEAT_RESERVATION','CREDENTIAL_ESCROW']});
 const push=body=>app.inject({method:'POST',url:'/api/v1/sync/snapshot',headers,body,nowMs:now});
 const item={plan_id:'client-stable',target_local_date:'2026-11-08',target_local_time:'07:00:00',area_name:'A',candidate_seats:['1']};
 let r=await push({reservation_plan_upserts:[item]}); assert.equal(r.status,200);
 assert.equal(app.store.reservationPlans.size,1);
 await push({reservation_plan_upserts:[item]});assert.equal(app.store.reservationPlans.size,1);
 const plan=[...app.store.reservationPlans.values()][0];
 await push({reservation_cancellations:[plan.id],reservation_plan_upserts:[{...item,plan_id:plan.id}]});
 await push({reservation_plan_upserts:[item,{...item,plan_id:plan.id},{...item,plan_id:undefined}]});
 assert.equal(app.store.reservationPlans.size,1);assert.equal(plan.enabled,false);
 await push({reservation_cancellations:['never-seen'],reservation_plan_upserts:[{...item,plan_id:'never-seen'}]});
 assert.equal(app.store.reservationPlans.size,1);
 assert.ok(user.reservation_sync_tombstones.includes('never-seen'));
});
