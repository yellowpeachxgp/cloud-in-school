import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCampusCloudApp as createApp } from '../apps/api/src/app.mjs';
import { CloudDatabaseStore } from '../packages/db/src/index.mjs';
import { CloudIdentityService } from '../packages/identity/src/index.mjs';
import { KmsEnvelopeVault } from '../packages/crypto/src/index.mjs';
import { RedisRespClient } from '../packages/redis-buffer/src/index.mjs';
import { ParcelHubService } from '../packages/parcel-hub/src/index.mjs';
import { CampusCloudClient } from '../packages/sdk-ts/src/index.mjs';
import { renderConsoleHtml } from '../apps/console/src/main.mjs';
globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const appFactory = () => createCampusCloudApp({redisEnabled:false});
const user = app => app.store.findOrCreateCloudUser({issuer:'https://synthetic.invalid',subject:'audit-user'});

test('production fails closed on missing/reference-only secrets; development keys are not shared', () => {
 const oldSession=process.env.CLOUD_SESSION_SIGNING_SECRET, oldKms=process.env.KMS_MASTER_SEED;
 delete process.env.CLOUD_SESSION_SIGNING_SECRET; delete process.env.KMS_MASTER_SEED;
 try {
  assert.throws(()=>new CloudIdentityService(new CloudDatabaseStore(),{environment:'production'}),/requires|Unresolved/);
  assert.throws(()=>new KmsEnvelopeVault({environment:'production'}),/requires|Unresolved/);
  assert.throws(()=>new CloudIdentityService(new CloudDatabaseStore(),{environment:'production',sessionSecret:'secret://campus-cloud/prod/session-signing'}),/requires|Unresolved/);
  assert.throws(()=>new KmsEnvelopeVault({environment:'production',initialKekMaterial:'secret://campus-cloud/prod/kms-material'}),/requires|Unresolved/);
  const a=new CloudIdentityService(new CloudDatabaseStore()), b=new CloudIdentityService(new CloudDatabaseStore());
  assert.notDeepEqual(a.sessionSecret,b.sessionSecret);
  assert.notDeepEqual(new KmsEnvelopeVault().kekRing.values().next().value,new KmsEnvelopeVault().kekRing.values().next().value);
 } finally {
  if(oldSession!==undefined)process.env.CLOUD_SESSION_SIGNING_SECRET=oldSession;
  if(oldKms!==undefined)process.env.KMS_MASTER_SEED=oldKms;
 }
});

test('unknown or removed user/session cannot resurrect through access, cookie, or refresh tokens', () => {
 const app=appFactory(), u=user(app), session=app.identity.issueDeviceSession(u,'test');
 const cookie=app.identity.signWebSessionCookie({cloudUserId:u.id,accessToken:session.access_token,refreshToken:session.refresh_token});
 assert.equal(app.identity.verifyAccessToken(session.access_token).cloudUserId,u.id);
 app.store.deviceSessions.clear();
 assert.throws(()=>app.identity.verifyAccessToken(session.access_token),/session/);
 assert.throws(()=>app.identity.refreshSession(session.refresh_token),/Unknown/);
 assert.equal(app.identity.verifyWebSessionCookie(`dis_web_session=${cookie}`),null);
 app.store.users.clear();
 assert.throws(()=>app.identity.verifyAccessToken(session.access_token));
 assert.equal(app.store.users.size,0);
});

test('web logout revokes only its session family, never delegation, plans or other devices', async () => {
 const app=appFactory(), u=user(app), web=app.identity.issueDeviceSession(u,'web'), phone=app.identity.issueDeviceSession(u,'phone');
 app.store.schoolBindings.set('b',{id:'b',cloud_user_id:u.id,status:'ACTIVE',revoked_at:null});
 app.store.reservationPlans.set('p',{id:'p',cloud_user_id:u.id,enabled:true});
 const cookie=app.identity.signWebSessionCookie({cloudUserId:u.id,accessToken:web.access_token,refreshToken:web.refresh_token});
 const result=await app.inject({url:'/api/v1/auth/web/logout',headers:{cookie:`dis_web_session=${cookie}`}});
 assert.equal(result.status,302); assert.equal(app.store.schoolBindings.get('b').revoked_at,null);
 assert.equal(app.store.reservationPlans.get('p').enabled,true);
 assert.throws(()=>app.identity.verifyAccessToken(web.access_token));
 assert.equal(app.identity.verifyAccessToken(phone.access_token).cloudUserId,u.id);
});

test('upstream demotion removes inherited roles, preserves explicit local grants, no subject backdoor', () => {
 const store=new CloudDatabaseStore();
 const u=store.findOrCreateCloudUser({issuer:'test',subject:'admin-a',role:'admin'});
 store.setUserRoles(u.id,['SECURITY_AUDITOR']);
 store.findOrCreateCloudUser({issuer:'test',subject:'admin-a',role:'user'});
 assert.deepEqual(store.getUserRoles(u.id).sort(),['SECURITY_AUDITOR','USER']);
 const special=store.findOrCreateCloudUser({issuer:'test',subject:'856f-cf51-b064-5d84',role:'user'});
 assert.deepEqual(store.getUserRoles(special.id),['USER']);
});

test('rate thresholds and buckets ignore attacker supplied HTTP headers', async () => {
 const app=appFactory();
 for(let i=0;i<60;i++)assert.equal((await app.inject({url:'/api/v1/auth/mobile/status?txn=nope',remoteAddress:'192.0.2.1'})).status,200);
 assert.equal((await app.inject({url:'/api/v1/auth/mobile/status?txn=nope',remoteAddress:'192.0.2.1',headers:{'x-rate-limit-max':'1000000','x-rate-limit-key':'new','x-forwarded-for':'192.0.2.2'}})).status,429);
 assert.equal((await app.inject({url:'/api/v1/auth/mobile/status?txn=nope',remoteAddress:'192.0.2.2'})).status,200);
});

test('Redis timeout rejects all queued commands and closes connection before late responses', async () => {
 const c=new RedisRespClient({commandTimeoutMs:10});let destroyed=false;
 c.connected=c.ready=true;c.socket={destroyed:false,write(){},destroy(){destroyed=true}};
 const first=c._sendRaw(['GET','a']).catch(e=>e.message),second=c._sendRaw(['GET','b']).catch(e=>e.message);
 assert.match(await first,/timeout/);assert.match(await second,/timeout/);
 c.parser.feed(Buffer.from('+LATE\r\n'));
 assert.equal(destroyed,true);assert.equal(c.queue.length,0);assert.equal(c.ready,false);
});

test('parcel natural key survives service recreation and picked-up state never regresses', () => {
 const store={parcels:new Map()};const first=new ParcelHubService(store,{});
 const p=first.upsertParcel({cloudUserId:'u',trackingNumber:'SF123456',status:'PICKED_UP'});
 const next=new ParcelHubService(store,{}).upsertParcel({cloudUserId:'u',trackingNumber:'SF123456',status:'IN_TRANSIT'});
 assert.equal(next.id,p.id);assert.equal(store.parcels.size,1);assert.equal(next.status,'PICKED_UP');
});

test('production parcel authority cannot be overridden by a client flag or unknown channel', () => {
 const hub=new ParcelHubService({parcels:new Map()},{});
 for(const id of ['parcel.pdd.orders','parcel.taobao.cainiao'])assert.throws(()=>hub.enforceProviderAuthority(id,{sandboxOverride:true}),/restricted/);
 assert.throws(()=>hub.enforceProviderAuthority('parcel.manual',{channel:'fake'}),/Unknown/);
});

test('actual rendered parcel form never submits example pickup data for a tracking-only import', async () => {
 const html=renderConsoleHtml({user:{username:'synthetic'},activeNav:'parcels'});
 const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
 const elements={'btn-add-parcel':{addEventListener(e,fn){this.click=fn}},'parcel-sms':{value:'',addEventListener(){}},'parcel-tracking':{value:'SF12345678'},'sms-preview-chip':{},'toast-banner':{style:{}}};
 let body;
 vm.runInNewContext(script,{document:{documentElement:{getAttribute:()=>null},querySelectorAll:()=>[],getElementById:id=>elements[id]||null},window:{location:{search:'',pathname:'/parcels',reload(){}}},fetch:async(url,opt)=>{body=JSON.parse(opt.body);return {ok:true,json:async()=>({ok:true,data:{}})}},setTimeout(){},URLSearchParams});
 elements['btn-add-parcel'].click();await new Promise(r=>setImmediate(r));
 assert.equal(body.pickup_code,null);assert.equal(body.status,'IN_TRANSIT');assert.equal(body.station_name,null);
});

test('SDK routes reach current API and obsolete order creation fails explicitly', async () => {
 const app=appFactory(), u=user(app), session=app.identity.issueDeviceSession(u,'sdk');
 const sdk=new CampusCloudClient({baseUrl:'http://offline/api',accessToken:session.access_token,fetchImpl:async(url,opt)=>{
  const res=await app.inject({method:opt.method,url:new URL(url).pathname,headers:opt.headers,body:opt.body?JSON.parse(opt.body):undefined});return {status:res.status,json:async()=>res.body};
 }});
 assert.equal((await sdk.getHealth()).status,200);
 assert.equal((await sdk.listParcels()).status,200);
 assert.equal((await sdk.listPlugins()).status,200);
 assert.equal((await sdk.listReservationOrders()).status,200);
 assert.equal((await sdk.getReservationOrder('missing')).status,404);
 assert.equal((await sdk.upsertParcel({tracking_number:'SF12345678'})).status,201);
 assert.throws(()=>sdk.createReservationOrder({}),/Unsupported/);
});

test('cache warming fences old in-flight computes', async () => {
 const {RedisGatewayBuffer}=await import('../packages/redis-buffer/src/index.mjs');
 const b=new RedisGatewayBuffer({client:{enabled:false}});let release;
 const old=b.getOrCompute('campus_content','haut',120,()=>new Promise(r=>{release=r}));
 await b.invalidate('campus_content','haut');await b.setAndWarm('campus_content','haut',{version:2});
 release({version:1});await old;
 assert.deepEqual((await b.getOrCompute('campus_content','haut',120,async()=>({version:3}))).value,{version:2});
});

test('cookie-authenticated POST logout revokes the real session family', async () => {
 const app=appFactory(), u=user(app), session=app.identity.issueDeviceSession(u,'web');
 const cookie=app.identity.signWebSessionCookie({cloudUserId:u.id,accessToken:session.access_token,refreshToken:session.refresh_token});
 const result=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie:`dis_web_session=${cookie}`}});
 assert.equal(result.status,200);assert.equal(result.body.data.family_id,session.family_id);
 assert.throws(()=>app.identity.verifyAccessToken(session.access_token));
});

test('console HTML does not embed supplied bearer credentials or persist session credentials in JS storage', () => {
 const marker='synthetic-access-marker-not-a-credential';
 const html=renderConsoleHtml({user:{username:'test'},accessToken:marker});
 assert.equal(html.includes(marker),false);
 assert.equal(html.includes('SERVER_TOKEN'),false);
 assert.equal(html.includes('options.credentials = "same-origin"'),true);
 assert.equal(renderConsoleHtml().includes('localStorage.setItem("dis_web_session"'),false);
});

test('HttpOnly-cookie mutations remain compatible and reject cross-site requests', async () => {
 const app=appFactory(), u=user(app), session=app.identity.issueDeviceSession(u,'web');
 const cookie=app.identity.signWebSessionCookie({cloudUserId:u.id,accessToken:session.access_token,refreshToken:session.refresh_token});
 const headers={cookie:`dis_web_session=${cookie}`,host:'campus.test',origin:'https://campus.test','sec-fetch-site':'same-origin'};
 assert.equal((await app.inject({method:'POST',url:'/api/v1/parcels/imports',headers,body:{tracking_number:'SF12345678'}})).status,201);
 assert.equal((await app.inject({method:'POST',url:'/api/v1/parcels/imports',headers:{...headers,origin:'https://attacker.test','sec-fetch-site':'cross-site'},body:{tracking_number:'SF99999999'}})).status,403);
 assert.equal(app.store.parcels.size,1);
});

// Legacy service fixtures are not console-login authorization tests.
function createCampusCloudApp(options = {}) { return createApp({requireAdminAccess:false, ...options}); }
