import test from "node:test";
import assert from "node:assert/strict";
import { HautLibraryProvider } from "../packages/school-spi/src/index.mjs";

const token = 'a'.repeat(40) + '.isolated.fixture';
function fixture() {
  const provider = new HautLibraryProvider();
  // Every possible network boundary fails locally unless explicitly stubbed below.
  provider.wslibGetJson = async () => { throw new Error('Unexpected transport'); };
  provider.authenticateHautSession = async () => ({ rawToken: token });
  provider.fetchCurrentActiveBooking = async () => null;
  provider.fetchLiveStudyRegions = async () => ({ regions: [{ id: 7, region_name: 'Room' }] });
  provider.fetchLiveRegionSeats = async () => ({ start_full: '2026-11-07 07:30:00', end_full: '2026-11-07 22:00:00', seats: [{ id: 8, seat_name: 'A8', available: true }] });
  const args = {
    job: { id: 'job', school_id: 'haut', school_binding_id: 'binding', booking_local_date: '2026-11-07', capability: 'AUTHORIZED_AUTOMATION' },
    binding: { id: 'binding', school_id: 'haut', status: 'DELEGATED_ACTIVE' },
    plan: { school_id: 'haut', area_name: 'Room', preferences_json: { preferred_seat_ids: ['A8'] } },
    schoolIntegration: { school_id: 'haut', enabled: true, kill_switch: false, authorization_evidence_ref: 'evidence', approver_primary_ref: 'alice', approver_secondary_ref: 'bob', authorization_approval: { id: 'approval', status: 'APPROVED', expires_at: '2099-01-01T00:00:00Z', evidence_ref: 'evidence', primary_actor_ref: 'alice', secondary_actor_ref: 'bob' } },
    beforeCancel: async () => {}, decryptedSecret: token, nowInstant: '2026-11-07T00:00:00Z', beforeCreate: async () => {}
  };
  const target = { school_id: 'haut', binding_id: 'binding', booking_local_date: '2026-11-07', seat_id: '8', region_id: '7', start_full: '2026-11-07 07:30:00', end_full: '2026-11-07 22:00:00' };
  const active = { bookingId: '42', seatId: 8, bookingStatus: 1, startDate: target.start_full, endDate: target.end_full, seatName: 'A8' };
  return { provider, args, target, active };
}

test('live writes require matching school, kill switch false and distinct authenticated approvals', async () => {
  for (const patch of [{ kill_switch: true }, { kill_switch: undefined }, { school_id: 'other' }, { enabled: false }, { authorization_approval: undefined }, { approver_secondary_ref: 'alice' }, { authorization_evidence_ref: 'other' }]) {
    const { provider, args } = fixture();
    Object.assign(args.schoolIntegration, patch);
    let touched = false;
    provider.fetchCurrentActiveBooking = async () => { touched = true; return null; };
    await assert.rejects(provider.executeMockOrAuthorizedCreate(args), { code: 'SCHOOL_PERMISSION_REQUIRED' });
    assert.equal(touched, false);
  }
  for (const key of ['job', 'binding', 'plan']) {
    const { provider, args } = fixture();
    args[key].school_id = 'other';
    await assert.rejects(provider.executeMockOrAuthorizedCreate(args), { code: 'FORBIDDEN' });
  }
});

for (const prewarm of [true, false]) {
  test(`${prewarm ? 'prewarmed' : 'discovery'} timeout sends exactly one create, persists target first and only reads on retry`, async () => {
    const { provider, args, target } = fixture();
    if (prewarm) args.job.prewarmed_targets = { ...target, region_name: 'Room', candidate_seats: [{ id: 8, seat_name: 'A8' }, { id: 9 }] };
    let writes = 0, persisted = false;
    args.beforeCreate = async t => { assert.equal(t.seat_id, '8'); persisted = true; };
    provider.wslibGetJson = async path => {
      assert.match(path, /addbooking/);
      assert.equal(persisted, true);
      writes++;
      throw new Error('timeout after remote commit');
    };
    assert.equal((await provider.executeMockOrAuthorizedCreate(args)).outcome, 'TIMEOUT_AMBIGUOUS');
    assert.equal((await provider.executeMockOrAuthorizedCreate(args)).outcome, 'TIMEOUT_AMBIGUOUS');
    assert.equal(writes, 1);
    assert.equal(args.job.submission_target.seat_id, '8');
  });
}

test('persist failure and missing callback prevent create; wrong date cannot fall back to today', async () => {
  for (const mode of ['missing', 'failed', 'date']) {
    const { provider, args } = fixture();
    let writes = 0;
    provider.wslibGetJson = async () => { writes++; return { code: 200 }; };
    if (mode === 'missing') delete args.beforeCreate;
    if (mode === 'failed') args.beforeCreate = async () => { throw new Error('disk failure'); };
    if (mode === 'date') { args.job.booking_local_date = '2026-11-08'; args.allowDateFallbackToToday = true; }
    await assert.rejects(provider.executeMockOrAuthorizedCreate(args));
    assert.equal(writes, 0);
  }
});

test('strict live verification rejects wrong ID, seat, date, interval and inactive or unknown status', async () => {
  for (const patch of [{ bookingId: '43' }, { seatId: 9 }, { startDate: '2026-11-08 07:30:00' }, { endDate: '2026-11-07 21:00:00' }, { bookingStatus: 5 }, { bookingStatus: undefined }]) {
    const { provider, args, target, active } = fixture();
    args.job.submission_target = target;
    provider.fetchCurrentActiveBooking = async () => ({ ...active, ...patch });
    const result = await provider.verifyBookingAuthoritative({ ...args, expectedExternalBookingId: '42', rawToken: token });
    assert.equal(result.verified, false);
  }
  const { provider, args, target, active } = fixture();
  args.job.submission_target = target;
  provider.fetchCurrentActiveBooking = async () => active;
  assert.equal((await provider.verifyBookingAuthoritative({ ...args, expectedExternalBookingId: '42', rawToken: token })).verified, true);
});

test('uncertain response reconciles matching persisted target, not unrelated active booking', async () => {
  for (const match of [true, false]) {
    const { provider, args, active } = fixture();
    let reads = 0, writes = 0;
    provider.fetchCurrentActiveBooking = async () => ++reads === 1 ? null : { ...active, seatId: match ? 8 : 9 };
    provider.wslibGetJson = async () => { writes++; throw new Error('timeout'); };
    assert.equal((await provider.executeMockOrAuthorizedCreate(args)).outcome, match ? 'SUBMITTED' : 'TIMEOUT_AMBIGUOUS');
    assert.equal(writes, 1);
  }
});

test('mock execution with live-looking credentials never contacts school; unknown IDs never verify as mock', async () => {
  const { provider, args } = fixture();
  args.job.capability = 'MOCK_ONLY';
  args.schoolIntegration.kill_switch = true;
  provider.fetchCurrentActiveBooking = provider.authenticateHautSession = provider.wslibGetJson = async () => assert.fail('School transport in mock mode');
  const submitted = await provider.executeMockOrAuthorizedCreate(args);
  assert.match(submitted.externalBookingId, /^haut_mock_/);
  assert.equal((await provider.verifyBookingAuthoritative({ ...args, expectedExternalBookingId: submitted.externalBookingId })).verified, true);
  assert.equal(await provider.prewarmJobTargetSeats(args), null);
  assert.equal((await provider.verifyBookingAuthoritative({ ...args, decryptedSecret: 'test_secret', expectedExternalBookingId: 'unrecognized' })).verified, false);
});

test('cancellation requires exact ID and never cancels unrelated current booking or signs off', async () => {
  for (const id of [null, 'haut_mock_invalid', '43', '42']) {
    const { provider, args, active } = fixture();
    provider.fetchCurrentActiveBooking = async () => active;
    const requests = [];
    provider.wslibGetJson = async path => { requests.push(path); return { code: 500 }; };
    if (!id || id.startsWith('haut_mock')) await assert.rejects(provider.cancelLiveSeatBooking({ ...args, externalBookingId: id }));
    else assert.equal((await provider.cancelLiveSeatBooking({ ...args, externalBookingId: id })).cancelled, false);
    assert.equal(requests.length, id === '42' ? 1 : 0);
    assert.ok(requests.every(path => path.includes('/cancel?bookingid=42') && !path.includes('signoff')));
  }
});

 test('expired evidence and missing live credentials fail closed', async () => {
  const { provider, args } = fixture();
  args.schoolIntegration.authorization_approval.expires_at = '2000-01-01T00:00:00Z';
  await assert.rejects(provider.executeMockOrAuthorizedCreate(args), { code: 'SCHOOL_PERMISSION_REQUIRED' });
  args.schoolIntegration.authorization_approval.expires_at = '2099-01-01T00:00:00Z';
  args.decryptedSecret = 'test_secret';
  await assert.rejects(provider.executeMockOrAuthorizedCreate(args), { code: 'SCHOOL_AUTH_EXPIRED' });
});

test('inconclusive authoritative current/fallback responses never permit a new create', async () => {
  for (const [current, fallback] of [
    [{ code: 500, data: null }, { code: 200, rows: [] }],
    [{ code: 200 }, { code: 200, rows: [] }],
    [{ code: 200, data: {} }, { code: 200, rows: [] }],
    [{ code: 200, data: null }, new Error('fallback timeout')],
    [{ code: 200, data: null }, { code: 500, rows: [] }],
    [{ code: 200, data: null }, { code: 200 }],
    [{ code: 200, data: null }, { code: 200, rows: [null] }],
    [{ code: 200, data: null }, { code: 200, rows: [], total: 20 }]
  ]) {
    const { provider, args } = fixture();
    delete provider.fetchCurrentActiveBooking;
    let writes = 0;
    provider.wslibGetJson = async path => {
      if (path.includes('addbooking')) { writes++; return { code: 200 }; }
      if (path.includes('crrentbooking')) return current;
      if (fallback instanceof Error) throw fallback;
      return fallback;
    };
    await assert.rejects(provider.executeMockOrAuthorizedCreate(args));
    assert.equal(writes, 0);
  }
});

test('cancellation rechecks revocation and policy after asynchronous auth/readback', async () => {
  for (const revoke of ['binding', 'policy']) {
    const { provider, args, active } = fixture();
    let writes = 0;
    provider.fetchCurrentActiveBooking = async () => {
      if (revoke === 'binding') args.binding.revoked_at = new Date().toISOString();
      else args.schoolIntegration.kill_switch = true;
      return active;
    };
    provider.wslibGetJson = async () => { writes++; return { code: 200 }; };
    await assert.rejects(provider.cancelLiveSeatBooking({ ...args, externalBookingId: '42' }));
    assert.equal(writes, 0);
  }
});

test('cancellation success requires exact-ID authoritative absence, not HTTP success', async () => {
  for (const after of ['still-active', 'empty', 'read-error', 'other-current-but-target-listed', 'truncated']) {
    const { provider, args } = fixture();
    delete provider.fetchCurrentActiveBooking;
    let cancelled = false, writes = 0;
    const raw = { id: 42, seatId: 8, bookingStatus: 1 };
    provider.wslibGetJson = async path => {
      if (path.includes('/cancel?')) { cancelled = true; writes++; return { code: 200 }; }
      if (!cancelled) return { code: 200, data: raw };
      if (after === 'read-error') throw new Error('timeout');
      if (path.includes('crrentbooking')) {
        return { code: 200, data: after === 'still-active' ? raw : after === 'other-current-but-target-listed' ? { ...raw, id: 43 } : null };
      }
      return { code: 200, rows: after === 'other-current-but-target-listed' ? [raw] : [], total: after === 'truncated' ? 20 : after === 'other-current-but-target-listed' ? 1 : 0 };
    };
    const result = await provider.cancelLiveSeatBooking({ ...args, externalBookingId: '42' });
    assert.equal(result.cancelled, after === 'empty');
    assert.equal(writes, 1);
  }
});


test('cancellation requires successful fresh authorization callback before transport', async () => {
  for (const mode of ['missing', 'denied', 'revoked']) {
    const { provider, args, active } = fixture();
    provider.fetchCurrentActiveBooking = async () => active;
    let writes = 0;
    provider.wslibGetJson = async () => { writes++; return { code: 200 }; };
    if (mode === 'missing') delete args.beforeCancel;
    if (mode === 'denied') args.beforeCancel = async () => { throw new Error('Latest policy denies cancellation'); };
    if (mode === 'revoked') args.beforeCancel = async () => { args.binding.status = 'REVOKED'; };
    await assert.rejects(provider.cancelLiveSeatBooking({ ...args, externalBookingId: '42' }));
    assert.equal(writes, 0);
  }
});

test('prewarm through execute never suffix-matches seats or substitutes unapproved regions', async () => {
  for (const [regionName, seatName] of [['Wrong Room', '11'], ['Requested Room', '11'], ['Requested Room Annex', '1'], ['Requested Room', '1']]) {
    const { provider, args } = fixture();
    args.plan.area_name = 'Requested Room';
    args.plan.candidate_seats = ['1'];
    args.plan.preferences_json.allow_alternative_seat = false;
    provider.fetchLiveStudyRegions = async () => ({ regions: [{ id: 7, region_name: regionName }] });
    provider.fetchLiveRegionSeats = async () => ({ start_full: '2026-11-07 07:30:00', end_full: '2026-11-07 22:00:00', seats: [{ id: 88, seat_name: seatName, short_name: seatName, available: true }] });
    let writes = 0;
    provider.wslibGetJson = async path => { assert.match(path, /addbooking/); writes++; return { code: 200, bookingid: 42 }; };
    args.job.prewarmed_targets = (await provider.prewarmJobTargetSeats(args)).prewarmed;
    await provider.executeMockOrAuthorizedCreate(args);
    assert.equal(writes, regionName === 'Requested Room' && seatName === '1' ? 1 : 0);
  }
});

test('stale cached room/seat and missing area cannot bypass current explicit target preferences', async () => {
  for (const mismatch of ['region', 'seat', 'missing-area']) {
    const { provider, args, target } = fixture();
    args.plan.area_name = mismatch === 'missing-area' ? '' : 'Room';
    args.plan.candidate_seats = ['1'];
    args.plan.preferences_json.allow_alternative_seat = false;
    args.job.prewarmed_targets = {
      ...target, region_name: mismatch === 'region' ? 'Wrong Room' : mismatch === 'missing-area' ? '' : 'Room',
      candidate_seats: [{ id: 88, seat_name: mismatch === 'seat' ? '11' : '1', short_name: mismatch === 'seat' ? '11' : '1' }]
    };
    provider.fetchLiveStudyRegions = async () => ({ regions: [] });
    let writes = 0;
    provider.wslibGetJson = async () => { writes++; return { code: 200 }; };
    assert.equal((await provider.executeMockOrAuthorizedCreate(args)).outcome, 'FAILED');
    assert.equal(writes, 0);
  }
});
