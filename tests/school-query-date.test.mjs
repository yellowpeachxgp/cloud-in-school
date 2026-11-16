import test from 'node:test';
import assert from 'node:assert/strict';
import { HautLibraryProvider } from '../packages/school-spi/src/index.mjs';

const target = '2030-01-02';
function provider() {
  const p = new HautLibraryProvider();
  p.getShanghaiTodayDateString = () => '2026-11-15';
  return p;
}
test('Cloud 实际学校端口按目标绝对日期查询且保留学校原始可用状态', async () => {
  const p = provider(), urls = [];
  p.wslibGetJson = async url => {
    urls.push(decodeURIComponent(url));
    if (url.includes('getDefaultTime')) return { code: 200, startDate: '2000-01-01', endDate: '2000-01-01', startTime: '07:30', endTime: '22:00' };
    if (url.includes('/building')) return { code: 200, builderInfo: [{ id: 1 }] };
    if (url.includes('/region')) return { code: 200, regionList: [{ id: 7, regionName: '测试区', num: 10, cannum: 3 }] };
    return { code: 200, layout: { regionName: '测试区' }, seatList: [{ id: 1, seatName: '测试区01', seatStatus: 1 }] };
  };
  const regions = await p.fetchLiveStudyRegions('test', target);
  const seats = await p.fetchLiveRegionSeats('test', 7, target);
  assert.equal(regions.regions[0].available_seats, 3);
  assert.equal(seats.seats[0].available, false);
  assert.equal(seats.booking_date, target);
  assert.ok(urls.filter(url => url.includes('starttime=')).every(url => url.includes(`starttime=${target} `) && url.includes(`endtime=${target} `)));
});
test('Cloud 目标日期未开放时不退回今天查询', async () => {
  const p = provider(), urls = [];
  p.wslibGetJson = async url => { urls.push(decodeURIComponent(url)); return url.includes('getDefaultTime') ? { code: 200 } : { code: 500, msg: 'seat.10057' }; };
  await assert.rejects(p.fetchLiveRegionSeats('test', 7, target));
  assert.ok(urls.every(url => !url.includes('starttime=') || url.includes(`starttime=${target} `)));
});

test('提前选择的自习室次日消失时，预热不能换到其他自习室的同号座位', async () => {
  const p = provider();
  p.parseCredentialBundle = () => ({ isLiveCredential: true });
  p.authenticateHautSession = async () => ({ rawToken: 'isolated-preference-token' });
  p.fetchLiveStudyRegions = async (_, date) => {
    assert.equal(date, target);
    return { regions: [{ id: 8, region_name: '其他自习室', open_time: '07:30', close_time: '22:00' }] };
  };
  let seatQueries = 0;
  p.fetchLiveRegionSeats = async () => {
    seatQueries++;
    return { seats: [{ id: 18, seat_name: '01', short_name: '01' }] };
  };
  const result = await p.prewarmJobTargetSeats({
    job: { booking_local_date: target },
    plan: { area_name: '指定自习室', candidate_seats: ['01'] },
    binding: { id: 'isolated-binding', student_no: 'isolated-student' },
    decryptedSecret: 'isolated-only'
  });
  assert.equal(result.prewarmed, null);
  assert.equal(seatQueries, 0);
});

test('已有预热缓存的自习室或座号与偏好不符时，到点也不能误提交', async () => {
  for (const mismatch of ['region', 'seat']) {
    const p = provider();
    const now = new Date('2030-01-02T09:00:00+08:00');
    p.parseCredentialBundle = () => ({ isLiveCredential: true, raw_token: 'isolated-only' });
    p.fetchActiveBookings = async () => [];
    let writes = 0;
    p.submitCandidateSeatAndVerify = async () => {
      writes++;
      return { action: 'RETURN_FINAL', result: { outcome: 'SUBMITTED' } };
    };
    p.fetchLiveStudyRegions = async () => { const error = new Error('隔离测试终止，未提交'); error.code = 'CONSENT_WITHDRAWN'; throw error; };
    const job = { school_id: 'haut', booking_local_date: target, auth_version: 1,
      prewarmed_targets: { binding_id: 'isolated-binding', student_no: 'isolated-student', auth_version: 1,
        plan_generation: 1, target_local_date: target, region_id: 8, region_name: mismatch === 'region' ? '其他自习室' : '指定自习室',
        start_full: `${target} 07:30:00`, end_full: `${target} 22:00:00`,
        candidate_seats: [{ id: 18, seat_name: mismatch === 'seat' ? '101' : '01' }], expires_at: new Date(now.getTime() + 60000).toISOString() } };
    try {
      await p.executeMockOrAuthorizedCreate({ job,
        plan: { area_name: '指定自习室', candidate_seats: ['01'], generation: 1 },
        binding: { id: 'isolated-binding', student_no: 'isolated-student', status: 'DELEGATED_ACTIVE' }, nowInstant: now });
    } catch (error) { assert.equal(error.code, 'CONSENT_WITHDRAWN'); }
    assert.equal(writes, 0);
    assert.equal(job.prewarmed_targets, null);
  }
});

test('偏好 01 号座不能被预热匹配成 101 号座', async () => {
  const p = provider();
  p.parseCredentialBundle = () => ({ isLiveCredential: true });
  p.authenticateHautSession = async () => ({ rawToken: 'isolated-only' });
  p.fetchLiveStudyRegions = async () => ({ regions: [{ id: 7, region_name: '指定自习室', open_time: '07:30', close_time: '22:00' }] });
  p.fetchLiveRegionSeats = async () => ({ seats: [
    { id: 101, seat_name: '指定自习室101', short_name: '101' },
    { id: 1, seat_name: '指定自习室01', short_name: '01' }
  ] });
  const result = await p.prewarmJobTargetSeats({
    job: { booking_local_date: target },
    plan: { area_name: '指定自习室', candidate_seats: ['01'] },
    binding: { id: 'isolated-binding', student_no: 'isolated-student' }, decryptedSecret: 'isolated-only'
  });
  assert.deepEqual(result.prewarmed.candidate_seats.map(seat => seat.id), [1]);
});
