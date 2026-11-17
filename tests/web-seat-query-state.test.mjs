import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderConsoleHtml } from '../apps/console/src/main.mjs';

function workbench() {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', style: {}, disabled: false,
      events: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, action) { this.events[name] = action; }, querySelectorAll() { return []; } });
    return nodes.get(id);
  }
  element('plan-date').value = '2026-11-18';
  element('plan-area').value = '五层中区';
  const requests = [];
  const html = renderConsoleHtml({ user: { id: 'fake-web-user' }, activeNav: 'reservations' });
  const start = html.indexOf('var dateInput = document.getElementById("plan-date")');
  const end = html.indexOf('var btnSyncWallet =', start);
  const context = vm.createContext({ document: { getElementById: element, querySelectorAll() { return []; } },
    Date, Boolean, String, Number, Promise, encodeURIComponent, escHtml: String,
    apiFetch(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })); } });
  vm.runInContext(html.slice(start, end), context);
  return { element, requests, context };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('真实工作台遇到学校凭据过期时展示原因，而非吞掉错误继续提示绑定学号', async () => {
  const w = workbench();
  w.element('plan-seat-1').options = [{ value: '01桌 A座', textContent: '01桌 A座（空闲可选）' }];
  w.requests[0].reject(Object.assign(new Error('Delegated credential has expired'), { code: 'SCHOOL_AUTH_EXPIRED' }));
  await settle();
  assert.match(w.element('seat-query-status').textContent, /学校授权已过期/);
  assert.match(w.element('seat-query-status').textContent, /重新验证/);
  assert.doesNotMatch(w.element('plan-seat-1').innerHTML, /绑定学号后加载实时状态/);
  assert.equal(w.element('live-region-badge').style.display, 'none');
  assert.match(w.element('plan-seat-1').options[0].textContent, /未核验/);
});

test('真实日期 change 接线拒绝较早查询的晚到结果', async () => {
  const w = workbench();
  w.element('plan-date').value = '2026-11-19';
  w.element('plan-date').events.change();
  w.requests[1].resolve({ data: { regions: [{ region_id: 2, region_name: '新日期区域', layer_name: '二层' }] } });
  await settle();
  w.requests[0].resolve({ data: { regions: [{ region_id: 1, region_name: '过期区域', layer_name: '一层' }] } });
  await settle();
  assert.match(w.element('plan-area').innerHTML, /新日期区域/);
  assert.doesNotMatch(w.element('plan-area').innerHTML, /过期区域/);
});

test('刷新座位结果保留用户仍有效的首选与备选', () => {
  const w = workbench();
  w.element('plan-seat-1').value = '02桌 A座';
  w.element('plan-seat-2').value = '01桌 A座';
  w.element('plan-seat-3').value = '';
  vm.runInContext('populateSeatsFromList([{code:"01桌 A座",tag:"参考",available:true},{code:"02桌 A座",tag:"参考",available:true}])', w.context);
  assert.equal(w.element('plan-seat-1').value, '02桌 A座');
  assert.equal(w.element('plan-seat-2').value, '01桌 A座');
  assert.equal(w.element('plan-seat-3').value, '');
});

test('初始渲染把过期学校绑定显示为需要重新验证', () => {
  const html = renderConsoleHtml({ user: { id: 'fake-bound-user' }, activeNav: 'reservations', nowIso: '2026-11-17T05:00:00Z',
    userBindings: [{ student_no: '2026999999', status: 'DELEGATED_ACTIVE', credential_expires_at: '2026-11-14T05:00:00Z' }] });
  assert.match(html.slice(0, html.indexOf('var SERVER_TOKEN')), /学校授权已过期/);
});

test('切换日期后，旧日期座位查询的晚到响应不能覆盖新日期结果', async () => {
  const w = workbench();
  const regions = { data: { regions: [{ region_id: 2, region_name: '二层区域', layer_name: '二层' }] } };
  w.requests[0].resolve(regions); await settle();
  w.element('plan-date').value = '2026-11-19'; w.element('plan-date').events.change();
  w.requests[2].resolve(regions); await settle();
  w.requests[3].resolve({ data: { seats: [{ short_name: '新日期座位', available: true }] } }); await settle();
  w.requests[1].resolve({ data: { seats: [{ short_name: '旧日期座位', available: true }] } }); await settle();
  assert.match(w.element('plan-seat-1').innerHTML, /新日期座位/);
  assert.doesNotMatch(w.element('plan-seat-1').innerHTML, /旧日期座位/);
});

test('区域从名称映射到真实 ID 后首次查座失败，仍保留同区域的参考选择', async () => {
  const w = workbench();
  w.element('plan-area').value = '四层西书库北区';
  w.element('plan-area').events.change();
  w.element('plan-seat-1').value = '06桌 F座';
  w.requests[0].resolve({ data: { regions: [
    { region_id: 1, region_name: '无关区域', layer_name: '一层' },
    { region_id: 13, region_name: '四层西书库北区', layer_name: '四层' }
  ] } });
  await settle();
  w.requests[1].reject(Object.assign(new Error('尚未开放'), { code: 'SCHOOL_CAPABILITY_UNVERIFIED' }));
  await settle();
  assert.equal(w.element('plan-area').value, '13');
  assert.equal(w.element('plan-seat-1').value, '06桌 F座');
  assert.match(w.element('plan-seat-1').innerHTML, /未核验/);
});
