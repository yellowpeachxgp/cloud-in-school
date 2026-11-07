import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {CloudIdentityService} from '../packages/identity/src/index.mjs';
import {KmsEnvelopeVault} from '../packages/crypto/src/index.mjs';
import {IsolatedFinanceBridge, FinanceSagaService} from '../packages/finance/src/index.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
function storeFixture(){
 const user={id:'user',issuer:'https://sso.synthetic.invalid/t/acme',subject:'subject',status:'ACTIVE'};
 const store={users:new Map([[user.id,user]]),deviceSessions:new Map(),authTransactions:new Map(),appTickets:new Map(),_idxSessionByRefreshHash:new Map(),_idxSessionIdsByFamily:new Map(),_idxTxnByServerState:new Map(),admin:false,
 getUserRoles:()=>[],hasAdminAccess(){return this.admin;},saveSnapshot:()=>true,recordAudit:()=>{},indexDeviceSession(id,s){this._idxSessionByRefreshHash.set(s.refresh_token_hash,id);if(!this._idxSessionIdsByFamily.has(s.family_id))this._idxSessionIdsByFamily.set(s.family_id,new Set());this._idxSessionIdsByFamily.get(s.family_id).add(id);}};
 const identity=new CloudIdentityService(store,{sessionSecret:crypto.randomBytes(32),expectedIssuer:user.issuer,requireAdminAccess:true});return {store,user,identity};
}
test('production requires strong resolved material; development is not public-default keyed',()=>{
 const store={};
 for(const material of ['', 'short', 'secret://unresolved']){
  assert.throws(()=>new CloudIdentityService(store,{environment:'production',sessionSecret:material}));
  assert.throws(()=>new KmsEnvelopeVault({environment:'production',initialKekMaterial:material}));
 }
 assert.throws(()=>new CloudIdentityService(store,{sessionSecret:'secret://unresolved'}));
 assert.throws(()=>new KmsEnvelopeVault({initialKekMaterial:'secret://unresolved'}));
 const a=new CloudIdentityService(store),b=new CloudIdentityService(store);assert.notDeepEqual(a.sessionSecret,b.sessionSecret);
});
test('mobile sessions work without admin; web sessions require current admin and valid flow',()=>{
 const {store,user,identity}=storeFixture();const now=Date.now();
 assert.throws(()=>identity.issueDeviceSession(user,'web',null,1,now),{code:'FORBIDDEN'});
 const mobile=identity.issueDeviceSession(user,'app',null,1,now,'MOBILE_APP');assert.equal(identity.verifyAccessToken(mobile.access_token,now).cloudUserId,user.id);
 store.admin=true;const web=identity.issueDeviceSession(user,'web',null,1,now,'WEB_CONSOLE');store.admin=false;
 assert.throws(()=>identity.verifyAccessToken(web.access_token,now),{code:'FORBIDDEN'});
 assert.throws(()=>identity.issueDeviceSession(user,'bad',null,1,now,'BAD'),{code:'BAD_REQUEST'});
 const session=[...store.deviceSessions.values()].find(s=>s.family_id===mobile.family_id);delete session.flow;
 assert.throws(()=>identity.verifyAccessToken(mobile.access_token,now),{code:'CLOUD_AUTH_REQUIRED'});assert.throws(()=>identity.refreshSession(mobile.refresh_token,now),{code:'CLOUD_AUTH_REQUIRED'});
});
test('encrypted cookie uses strict active access session, cannot convert mobile flow or survive revocation',()=>{
 const {store,user,identity}=storeFixture();const now=Date.now();store.admin=true;
 const web=identity.issueDeviceSession(user,'web',null,1,now,'WEB_CONSOLE');
 const cookie=identity.signWebSessionCookie({cloudUserId:user.id,accessToken:web.access_token,refreshToken:web.refresh_token});
 assert.match(cookie,/^v2\./);assert.ok(!cookie.includes(web.access_token));
 const header=`dis_web_session=${encodeURIComponent(cookie)}`;
 assert.equal(identity.verifyWebSessionCookie(header,now).familyId,web.family_id);
 const mobile=identity.issueDeviceSession(user,'app',null,1,now,'MOBILE_APP');
 const mobileCookie=identity.signWebSessionCookie({cloudUserId:user.id,accessToken:mobile.access_token,refreshToken:mobile.refresh_token});
 assert.equal(identity.verifyWebSessionCookie(`dis_web_session=${mobileCookie}`,now),null);
 store._idxSessionIdsByFamily.set(web.family_id,new Set());identity.revokeSessionFamily(web.family_id,'USER_LOGOUT',now);
 assert.equal(identity.verifyWebSessionCookie(header,now),null);
 assert.equal(identity.verifyWebSessionCookie('dis_web_session=%broken',now),null);
});
test('stale refresh index cannot select another session; authoritative fallback remains valid',()=>{
 const {store,user,identity}=storeFixture();const now=Date.now();const one=identity.issueDeviceSession(user,'app',null,1,now,'MOBILE_APP');const two=identity.issueDeviceSession(user,'app',null,1,now,'MOBILE_APP');
 const hash=crypto.createHash('sha256').update(one.refresh_token).digest('hex');const other=[...store.deviceSessions.values()].find(s=>s.family_id===two.family_id);store._idxSessionByRefreshHash.set(hash,other.id);
 const rotated=identity.refreshSession(one.refresh_token,now);assert.equal(rotated.family_id,one.family_id);assert.equal(other.consumed_at,null);
});
for(const alg of ['RS256','ES256'])test(`real local ${alg} signature and JWK algorithm boundary`,async()=>{
 const {identity}=storeFixture();const pair=alg==='RS256'?crypto.generateKeyPairSync('rsa',{modulusLength:2048}):crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const jwk={...pair.publicKey.export({format:'jwk'}),kid:'local',alg,use:'sig'};identity.fetchJwksKeys=async()=>[jwk];
 const input='header.payload';const signature=crypto.sign(alg==='RS256'?'RSA-SHA256':'SHA256',Buffer.from(input),alg==='RS256'?pair.privateKey:{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 await identity.verifyIdTokenSignature(input,signature,{kid:'local',alg});
 await assert.rejects(identity.verifyIdTokenSignature('tampered',signature,{kid:'local',alg}),{code:'CLOUD_AUTH_REQUIRED'});
 jwk.use='enc';await assert.rejects(identity.verifyIdTokenSignature(input,signature,{kid:'local',alg}),{code:'CLOUD_AUTH_REQUIRED'});
});
test('discovery cannot switch issuer or JWKS origin',async(t)=>{
 const {identity}=storeFixture();const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let count=0;
 globalThis.fetch=async()=>{count++;return {ok:true,json:async()=>({issuer:'https://wrong.invalid',jwks_uri:'https://sso.synthetic.invalid/keys'})};};
 await assert.rejects(identity.fetchJwksKeys(),{code:'CLOUD_AUTH_REQUIRED'});assert.equal(count,1);
 globalThis.fetch=async()=>({ok:true,json:async()=>({issuer:identity.expectedIssuer,jwks_uri:'https://other.invalid/keys'})});
 await assert.rejects(identity.fetchJwksKeys(),{code:'CLOUD_AUTH_REQUIRED'});
});
test('monetary idempotency history survives more than 5000 distinct keys',async()=>{
 const bridge=new IsolatedFinanceBridge({realDebitsEnabled:false,allowSandboxFallback:true});bridge.setSandboxBalance('user',100000);
 const key=`dis:reservation:${crypto.randomUUID()}:debit:v1`;const args={cloudUserId:'user',ssoSubject:'synthetic_user',deltaMicropeach:-100,eventKey:key,reason:'offline'};
 await bridge.adjustBalanceIdempotent(args);
 for(let i=0;i<5001;i++)bridge.processedIdempotencyKeys.set(`synthetic-prior-${i}`,{ok:true});
 await bridge.adjustBalanceIdempotent({...args,eventKey:`dis:reservation:${crypto.randomUUID()}:debit:v1`});
 const balance=bridge.getSandboxBalance('user');assert.equal((await bridge.adjustBalanceIdempotent(args)).deduplicated,true);assert.equal(bridge.getSandboxBalance('user'),balance);
});
test('stale order index cannot create or settle a second order for same job',async()=>{
 const order={id:'order',job_id:'job',cloud_user_id:'user',payment_state:'NOT_REQUIRED',price_micropeach:0};
 const store={reservationOrders:new Map([[order.id,order]]),_idxOrderByJob:new Map([['job','missing']])};const svc=new FinanceSagaService(store,{});svc.settleOrderDebit=async id=>store.reservationOrders.get(id);
 assert.equal(await svc.createAndSettleOrderForConfirmedJob({job:{id:'job',cloud_user_id:'user'},plan:{}}),order);assert.equal(store.reservationOrders.size,1);
});
test('OIDC callback rejects non-numeric expiry rather than accepting an indefinite token',async()=>{
 const {identity}=storeFixture();const now=Date.now();const txn=identity.startWebTransaction({},now);
 const pending=[...identity.store.authTransactions.values()][0];
 identity.ssoCodeExchanger=async()=>({iss:identity.expectedIssuer,aud:identity.clientId,sub:'subject',nonce:pending.serverNonce,exp:'not-a-time'});
 await assert.rejects(identity.handleOidcCallback({code:'synthetic',state:pending.serverState},now),{code:'CLOUD_AUTH_REQUIRED'});
});
