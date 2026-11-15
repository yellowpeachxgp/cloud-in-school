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
