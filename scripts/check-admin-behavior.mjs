import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const staticRoot = process.env.ADMIN_STATIC_DIR || fileURLToPath(new URL('../admin/', import.meta.url));
const source = await readFile(resolve(staticRoot, 'admin.js'), 'utf8');
assert.match(source, /\nboot\(\);\s*$/);

// Exercise the actual navigation, table actions and form submit handlers without
// browser dependencies or network access. Only this isolated DOM fixture is fake.
class Element {
  constructor(tag, text = '') { this.tagName = tag.toUpperCase(); this.className = ''; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.value = ''; this.checked = false; this.disabled = false; this.ownText = text; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.ownText = String(text); this.children = []; }
  append(...nodes) { for (const value of nodes) { const node = typeof value === 'string' ? new Element('#text', value) : value; node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  get classList() {
    const node = this;
    return {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      add(name) { const names = new Set(node.className.split(/\s+/).filter(Boolean)); names.add(name); node.className = [...names].join(' '); },
      toggle(name, enabled) { const names = new Set(node.className.split(/\s+/).filter(Boolean)); const next = enabled ?? !names.has(name); if (next) names.add(name); else names.delete(name); node.className = [...names].join(' '); return next; },
    };
  }
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    const simple = (node, value) => value.startsWith('.') ? node.classList.contains(value.slice(1)) : value.startsWith('#') ? node.id === value.slice(1) : node.tagName === value.toUpperCase();
    if (!simple(this, parts.pop())) return false;
    let ancestor = this.parent;
    while (parts.length) { const value = parts.pop(); while (ancestor && !simple(ancestor, value)) ancestor = ancestor.parent; if (!ancestor) return false; ancestor = ancestor.parent; }
    return true;
  }
  querySelectorAll(selector) { const selectors = selector.split(',').map(value => value.trim()); const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return selector === '*' ? descendants : descendants.filter(node => selectors.some(value => node.matches(value))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, handler, options = {}) { this.listeners.set(type, [...(this.listeners.get(type) || []), { handler, once: !!options.once }]); }
  async emit(type) { for (const listener of [...(this.listeners.get(type) || [])]) { if (listener.once) this.listeners.set(type, this.listeners.get(type).filter(value => value !== listener)); await listener.handler({ preventDefault() {}, currentTarget: this }); } }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}

function fixture(role = 'root') {
  const body = new Element('body'), app = new Element('div'); app.id = 'app'; body.append(app);
  const document = { body, createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), title: '' };
  const calls = [], replies = [], windowEvents = new Map();
  const location = { origin: 'https://admin.example.test' }; let hash = '#overview';
  Object.defineProperty(location, 'hash', { get: () => hash, set: value => { hash = '#' + String(value).replace(/^#/, ''); } });
  const context = vm.createContext({ document, window: { addEventListener: (type, handler) => windowEvents.set(type, handler) }, location, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, fetch: async (path, options = {}) => { if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; calls.push({ path, ...options }); return { ok: true, json: async () => replies.length ? replies.shift() : path.startsWith('/api/v2/rental/admin/venues') ? { items: [{ id: 11, name: 'Synthetic venue', status: 'active', useFeeCents: 2000, depositCents: 10000, version: 3 }] } : ({ id: 11, role: JSON.parse(options.body || '{}').role }) }; }, pageLoads: 0 });
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '') + '\nconst originalLoadPage = loadPage; loadPage = () => { pageLoads++; }; globalThis.spec = { loadPage: originalLoadPage, useRealPages: () => { loadPage = originalLoadPage; }, heading, renderMerchants, renderMerchantContext, selectManagementMerchant, openMerchantVenues, refreshMerchants, managementMerchantId, managementMerchant, setPage: page => { state.page = page; }, api, merchantDialog, transferDialog, createDeviceDialog, configureDialog, venueDialog, renderVenues, renderToolbar, canManageVenues, canUseAdmin, canManageUsers, assignableRoles, roleLabel, completeLogin, shell, userRow, roleDialog, setContext: (merchant, merchants = []) => { state.merchantGeneration++; state.merchant = merchant; state.merchantId = merchant?.id || null; state.merchants = merchants; }, setUser: value => { state.user = value; }, getUser: () => state.user, getPage: () => state.page, getUserScope: () => state.filters.users.scope };', context);
  context.spec.setUser({ id: 10, role });
  return { context, spec: context.spec, document, app, calls, replies, windowEvents };
}
function controls(fixture) {
  const dialog = fixture.document.querySelector('dialog'), form = dialog.querySelector('form');
  return { dialog, form, select: form.querySelector('select'), reason: form.querySelector('textarea'), checked: form.querySelector('input'), submit: form.querySelectorAll('button').find(button => button.type === 'submit') };
}
function merchantField(form, label) {
  return form.querySelectorAll('label').find(node => node.children[0]?.textContent === label)?.querySelector('input,select,textarea') || null;
}
function assertNoEntryControls(form) {
  for (const label of ['小程序入口', '入口域名', '小程序 AppID', '入口名称', '新用户注册', '小程序 AppSecret']) assert.equal(merchantField(form, label), null, 'Unexpected platform control: ' + label);
  assert.equal(form.querySelectorAll('input').some(input => input.type === 'url'), false);
  assert.deepEqual(form.querySelectorAll('input,select,textarea').filter(input => input.required).map(input => input.parent.children[0].textContent), ['商户名称', '商户编号']);
}
async function selectRole(controls, role) { controls.select.value = role; await controls.select.emit('change'); controls.checked.checked = true; await controls.checked.emit('change'); controls.reason.value = 'Synthetic role-change test'; }

// All operational roles can establish a session; only adminer/root see users.
for (const role of ['manager', 'adminer', 'root']) {
  const f = fixture(role); f.context.location.hash = '#users'; f.spec.shell();
  const navigation = f.app.querySelector('nav').querySelectorAll('a').map(link => link.dataset.page);
  assert.equal(navigation.includes('users'), role !== 'manager');
  assert.equal(navigation.includes('merchants'), true);
  const group = f.app.querySelector('.nav-group'); assert.ok(group);
  assert.equal(group.querySelector('.nav-parent').textContent, role === 'root' ? '商户管理' : '我的商户');
  assert.equal(group.querySelector('.subnav').querySelector('a').dataset.page, 'venues');
  assert.equal(f.app.querySelector('nav').children.some(node => node.tagName === 'A' && node.dataset.page === 'venues'), false);
  assert.equal(navigation.includes('venues'), true);
  assert.equal(f.spec.getPage(), role === 'manager' ? 'overview' : 'users');
  assert.equal(f.spec.canUseAdmin(role), true);
  assert.equal(f.spec.canManageUsers(role), role !== 'manager');
  assert.ok(f.app.textContent.includes(f.spec.roleLabel(role)));
}
{
  const f = fixture('user');
  assert.equal(f.spec.canUseAdmin('user'), false);
  assert.throws(() => f.spec.completeLogin({ user: { id: 11, role: 'user' } }, () => true), /没有管理权限/);
  f.spec.completeLogin({ user: { id: 12, role: 'adminer' } }, () => true);
  assert.equal(f.spec.getUser().role, 'adminer');
  assert.equal(f.spec.roleLabel('root'), 'ROOT · 超级管理员');
  assert.equal(f.spec.roleLabel('adminer'), '商户管理员');
  assert.equal(f.spec.roleLabel('manager'), '设备管理员');
  assert.equal(f.spec.roleLabel('user'), '普通用户');
}

// The retired spelling cannot log in, gain capabilities or appear as a grant.
{
  const f = fixture('admin');
  assert.equal(f.spec.canUseAdmin('admin'), false);
  assert.equal(f.spec.canManageUsers('admin'), false);
  assert.throws(() => f.spec.completeLogin({ user: { id: 10, role: 'admin' } }, () => true), /没有管理权限/);
  assert.deepEqual(Array.from(f.spec.assignableRoles({ id: 10, role: 'admin' }, { id: 11, role: 'user' })), []);
  assert.deepEqual(Array.from(f.spec.assignableRoles({ id: 10, role: 'root' }, { id: 11, role: 'admin' })), []);
  const root = fixture('root'); root.spec.roleDialog({ id: 11, role: 'manager', allowedRoles: ['user', 'manager', 'admin', 'adminer'] }); const c = controls(root);
  assert.deepEqual(c.select.querySelectorAll('option').map(option => option.value), ['user', 'manager', 'adminer']);
  await selectRole(c, 'adminer'); c.select.value = 'admin'; await c.form.emit('submit');
  assert.equal(root.calls.length, 0); assert.match(c.form.textContent, /重新核对/);
}

// Protected and same-level rows never render a role-action button.
{
  const f = fixture('adminer');
  for (const user of [{ id: 10, role: 'adminer' }, { id: 11, role: 'adminer' }, { id: 12, role: 'root' }, { id: 13, role: 'user', allowedRoles: [] }]) assert.equal(f.spec.userRow(user).querySelectorAll('button').length, 0);
  for (const role of ['user', 'manager']) assert.equal(f.spec.userRow({ id: 11, role }).querySelectorAll('button').length, 1);
  const root = fixture('root');
  assert.equal(root.spec.userRow({ id: 11, role: 'adminer' }).querySelectorAll('button').length, 2);
  for (const user of [{ id: 10, role: 'root' }, { id: 11, role: 'root' }]) assert.equal(root.spec.userRow(user).querySelectorAll('button').length, 0);
  f.spec.roleDialog({ id: 11, role: 'adminer' }); assert.equal(f.document.querySelector('dialog'), null);
}

// The server's allowedRoles can narrow the local policy, never widen it.
{
  const f = fixture('adminer');
  assert.deepEqual(Array.from(f.spec.assignableRoles({ id: 10, role: 'adminer' }, { id: 11, role: 'user', allowedRoles: ['manager', 'adminer', 'root'] })), ['manager']);
  assert.deepEqual(Array.from(f.spec.assignableRoles({ id: 10, role: 'root' }, { id: 11, role: 'adminer', allowedRoles: ['user', 'manager'] })), ['user', 'manager']);
}

// User rows show complete verified phones; legacy tel and unverified fields never imply ownership.
{
  const f = fixture('root'), phoneNumber = '+8613800138000';
  const verified = { id: 11, role: 'user', phoneVerified: true, phoneNumber, tel: '+86 138****8000' };
  const row = f.spec.userRow(verified), cells = row.querySelectorAll('td');
  assert.equal(cells[0].querySelector('.cell-main').textContent, phoneNumber);
  assert.equal(cells[1].querySelector('.cell-main').textContent, phoneNumber);
  assert.match(cells[1].textContent, /微信已验证/); assert.doesNotMatch(row.textContent, /\*\*\*\*/);
  const named = f.spec.userRow({ ...verified, nickname: 'Synthetic renter' });
  assert.equal(named.querySelector('.cell-main').textContent, 'Synthetic renter'); assert.match(named.querySelectorAll('td')[1].textContent, /\+8613800138000/);
  for (const phone of [{ phoneVerified: false, phoneNumber: null }, { tel: phoneNumber }, { phoneVerified: false, phoneNumber }, { phoneVerified: true, tel: phoneNumber }, { phoneVerified: true, phoneNumber: '138****8000' }]) {
    const unverified = f.spec.userRow({ id: 12, role: 'user', ...phone });
    assert.equal(unverified.querySelector('.cell-main').textContent, '用户 #12');
    assert.match(unverified.textContent, /未授权手机号/); assert.match(unverified.textContent, /需本人在小程序授权/);
    assert.doesNotMatch(unverified.textContent, /138|微信已验证/);
  }
}

// Both permission and merchant-assignment dialogs identify the target by the verified phone.
for (const verified of [true, false]) {
  const user = { id: 11, role: 'user', nickname: 'Synthetic renter', tel: '+8613900139000', phoneVerified: verified, phoneNumber: verified ? '+8613800138000' : null };
  const checkIdentity = node => {
    assert.match(node.textContent, /Synthetic renter（ID 11）/); assert.doesNotMatch(node.textContent, /13900139000/);
    if (verified) { assert.match(node.textContent, /手机号：\+8613800138000（微信已验证）/); assert.doesNotMatch(node.textContent, /未授权手机号/); }
    else { assert.match(node.textContent, /未授权手机号，请由用户本人在小程序授权/); assert.doesNotMatch(node.textContent, /微信已验证/); }
  };
  const role = fixture('root'); role.spec.roleDialog(user); checkIdentity(controls(role).form);
  const transfer = fixture('root'), first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' };
  transfer.spec.setContext(first); transfer.replies.push({ items: [first, second], currentMerchantId: 1 });
  await transfer.spec.transferDialog('users', user);
  const form = transfer.document.querySelector('dialog').querySelector('form'); checkIdentity(form);
  form.querySelector('select').value = '2'; form.querySelector('textarea').value = 'Synthetic assignment';
  transfer.replies.push({ binding: { token: 'a'.repeat(64), appId: 'wxsynthetic', origin: 'https://synthetic.example.test', expiresAt: '2026-11-15T12:00:00.000Z' } });
  await form.emit('submit'); assert.match(form.textContent, /等待原账号确认商户分配/); checkIdentity(form);
  const written = transfer.calls.find(call => call.method === 'POST');
  assert.deepEqual(JSON.parse(written.body), { merchantId: 2, reason: 'Synthetic assignment', role: 'user' });
}

// Actual form submission grants only the selected, explicitly acknowledged role.
{
  const f = fixture('adminer'); f.spec.roleDialog({ id: 11, role: 'user', allowedRoles: ['user', 'manager'] }); const c = controls(f);
  assert.deepEqual(c.select.querySelectorAll('option').map(option => option.value), ['user', 'manager']);
  assert.equal(c.submit.disabled, true);
  await selectRole(c, 'manager'); assert.match(c.submit.textContent, /提升权限/);
  await c.form.emit('submit');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/v2/rental/admin/users/11/role'); assert.equal(f.calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[0].body), { role: 'manager', reason: 'Synthetic role-change test' });
  assert.equal(f.calls[0].credentials, 'same-origin');
}
{
  const f = fixture('root'); f.spec.roleDialog({ id: 11, role: 'manager', allowedRoles: ['user', 'manager', 'adminer'] }); const c = controls(f);
  assert.deepEqual(c.select.querySelectorAll('option').map(option => option.value), ['user', 'manager', 'adminer']);
  await selectRole(c, 'adminer'); await c.form.emit('submit'); assert.equal(JSON.parse(f.calls[0].body).role, 'adminer');
}

// Demotion has distinct confirmation; switching choices clears acknowledgement.
{
  const f = fixture('adminer'); f.spec.roleDialog({ id: 11, role: 'manager' }); const c = controls(f);
  await selectRole(c, 'user'); assert.match(c.submit.textContent, /降低权限/); assert.equal(c.submit.classList.contains('danger-button'), true);
  c.select.value = 'manager'; await c.select.emit('change'); assert.equal(c.checked.checked, false); assert.equal(c.submit.disabled, true);
  await c.form.emit('submit'); assert.equal(f.calls.length, 0);
  await selectRole(c, 'user'); await c.form.emit('submit'); assert.equal(JSON.parse(f.calls[0].body).role, 'user');
}

// Even manually injecting a higher target role into the select never sends it.
{
  const f = fixture('adminer'); f.spec.roleDialog({ id: 11, role: 'user' }); const c = controls(f);
  await selectRole(c, 'manager'); c.select.value = 'adminer'; await c.form.emit('submit'); assert.equal(f.calls.length, 0); assert.match(c.form.textContent, /重新核对/);
  c.select.value = 'root'; await c.form.emit('submit'); assert.equal(f.calls.length, 0);
}

console.log('Four-role sessions, navigation, protected rows and role-change forms verified with isolated fixtures.');

// Root selection and staff membership scope business requests; authentication remains entry-scoped.
{
  const root = fixture('root'); root.spec.setContext({ id: 2, name: 'Synthetic merchant' });
  await root.spec.api('/rental/admin/devices');
  await root.spec.api('/rental/admin/auth/session');
  await root.spec.api('/rental/admin/merchants');
  assert.equal(root.calls[0].headers['X-Merchant-Id'], '2');
  assert.equal(root.calls[1].headers['X-Merchant-Id'], undefined);
  assert.equal(root.calls[2].headers['X-Merchant-Id'], undefined);
  const manager = fixture('manager'); manager.spec.setContext({ id: 2 }); await manager.spec.api('/rental/admin/devices');
  assert.equal(manager.calls[0].headers['X-Merchant-Id'], undefined);
  manager.spec.setUser({ id: 10, role: 'manager', merchantId: 2 });
  manager.spec.setContext({ id: 9 });
  await manager.spec.api('/rental/admin/devices');
  await manager.spec.api('/rental/admin/auth/session');
  assert.equal(manager.calls[1].headers['X-Merchant-Id'], '2');
  assert.equal(manager.calls[2].headers['X-Merchant-Id'], undefined);
  await manager.spec.merchantDialog(); assert.equal(manager.document.querySelector('dialog'), null);
}

// Creation never renders platform controls; only business details are required to save.
for (const merchants of [[], [{ id: 1, name: 'Platform', miniappOwnerId: null, appId: 'wx03dbf50c15cac06f', origin: 'https://d.4mr.cn' }, { id: 3, name: 'Historical entry', miniappOwnerId: null, origin: 'https://d3.4mr.cn', appId: 'wx3333333333333333' }]]) {
  const f = fixture('root'); f.spec.setContext({ id: 1, name: 'Platform' }, merchants);
  await f.spec.merchantDialog();
  const form = f.document.querySelector('dialog').querySelector('form');
  assertNoEntryControls(form); assert.equal(form.querySelector('select'), null);
  assert.match(form.textContent, /共用平台小程序及 d\.4mr\.cn，无需配置域名、AppID、AppSecret/);
  assert.match(form.textContent, /商户自己的收款账户/); assert.doesNotMatch(form.textContent, /独立小程序及域名/);
  merchantField(form, '商户名称').value = 'Shared merchant'; merchantField(form, '商户编号').value = 'shared2'; merchantField(form, '微信支付商户号').value = '2000000002';
  f.replies.push({ merchant: { id: 2 } }, { items: [], currentMerchantId: 1 }); await form.emit('submit');
  const saved = JSON.parse(f.calls.find(call => call.method === 'POST').body);
  assert.deepEqual(saved, { name: 'Shared merchant', code: 'shared2', miniappOwnerId: 1, mchId: '2000000002', payEnabled: false });
}

// Editing uses only configuration flags; secret values from a response are never copied into the form.
{
  const f = fixture('root');
  f.replies.push({ merchant: { id: 2, code: 'merchant2', name: 'Synthetic merchant', origin: 'https://d1.4mr.cn', appId: 'wx1111111111111111', mchId: '1234567890', status: 'draft', payEnabled: false, configuration: { hasAppSecret: true, hasPrivateKey: true, hasApiV3Key: true, hasPlatformKeys: true }, credentials: { appSecret: 'must-never-be-rendered' } } });
  await f.spec.merchantDialog(2);
  const form = f.document.querySelector('dialog').querySelector('form');
  assert.ok(!form.textContent.includes('must-never-be-rendered'));
  assert.equal(form.querySelector('select').disabled, false);
  assert.ok(form.querySelector('select').querySelectorAll('option').some(option => option.value === ''));
  const secretInputs = form.querySelectorAll('input').filter(input => input.type === 'password');
  assert.ok(secretInputs.length >= 4); assert.ok(secretInputs.every(input => input.value === ''));
  f.replies.push({ merchant: { id: 2 } }, { items: [], currentMerchantId: 1 });
  await form.emit('submit');
  const saved = JSON.parse(f.calls.find(call => call.method === 'PATCH').body);
  assert.equal(saved.credentials, undefined); assert.equal(saved.payEnabled, false);
  assert.equal(saved.appId, 'wx1111111111111111'); assert.equal(saved.origin, 'https://d1.4mr.cn');
  assert.equal(saved.entryName, 'Synthetic merchant'); assert.equal(saved.entryStatus, 'active');
}

// Existing shared merchants have no platform controls and retain their own receiving-account fields.
for (const ownerId of [1, 3]) {
  const f = fixture('root');
  f.replies.push({ merchant: { id: 2, code: 'shared2', name: 'Shared merchant', miniappOwnerId: ownerId, origin: 'https://d.4mr.cn', appId: 'wx03dbf50c15cac06f', mchId: '2000000002', status: 'active', payEnabled: false, entry: { name: 'Public entry', status: 'paused' }, configuration: { hasAppSecret: true } } });
  await f.spec.merchantDialog(2);
  const form = f.document.querySelector('dialog').querySelector('form');
  assertNoEntryControls(form); assert.equal(form.querySelectorAll('select').length, 1);
  for (const label of ['微信支付商户号', '商户私钥（PEM）', 'API v3 密钥', '商户证书序列号', '微信支付公钥 ID / 平台证书序列号', '微信支付公钥 / 平台证书（PEM）']) assert.ok(merchantField(form, label), 'Missing receiving-account field: ' + label);
  merchantField(form, 'API v3 密钥').value = 'synthetic-own-account-key';
  f.replies.push({ merchant: { id: 2 } }, { items: [], currentMerchantId: 1 }); await form.emit('submit');
  const saved = JSON.parse(f.calls.find(call => call.method === 'PATCH').body);
  assert.equal(saved.miniappOwnerId, ownerId); assert.equal(saved.status, 'active'); assert.deepEqual(saved.credentials, { apiV3Key: 'synthetic-own-account-key' });
  for (const key of ['origin', 'appId', 'entryName', 'entryStatus']) assert.equal(saved[key], undefined);
}

// Platform owners retain entry settings and AppSecret independently of business status.
{
  const f = fixture('root');
  f.replies.push({ merchant: { id: 1, code: 'platform', name: 'Business name', origin: 'https://d.4mr.cn', appId: 'wx03dbf50c15cac06f', status: 'paused', entry: { id: 1, name: 'Public entry name', status: 'active' }, configuration: {} } });
  await f.spec.merchantDialog(1);
  const form = f.document.querySelector('dialog').querySelector('form');
  const input = label => form.querySelectorAll('label').find(node => node.children[0]?.textContent === label).querySelector('input,select');
  assert.equal(input('入口名称').value, 'Public entry name'); assert.equal(input('新用户注册').value, 'active');
  assert.equal(input('商户经营状态').value, 'paused'); assert.match(form.textContent, /已有身份仍可登录并查看历史/);
  input('入口名称').value = 'Renamed entry'; input('新用户注册').value = 'paused';
  assert.ok(input('入口域名')); assert.ok(input('小程序 AppID'));
  input('小程序 AppSecret').value = 'synthetic-owner-app-secret';
  f.replies.push({ merchant: { id: 1 } }, { items: [], currentMerchantId: 1 }); await form.emit('submit');
  const saved = JSON.parse(f.calls.find(call => call.method === 'PATCH').body);
  assert.equal(saved.entryName, 'Renamed entry'); assert.equal(saved.entryStatus, 'paused'); assert.equal(saved.status, 'paused');
  assert.equal(saved.credentials.appSecret, 'synthetic-owner-app-secret'); assert.equal(saved.miniappOwnerId, null);
}
// Device registration must not bind to a different root selection after the form opens.
{
  const f = fixture('root'); f.spec.setContext({ id: 2, name: 'Second merchant' }); await f.spec.createDeviceDialog();
  const form = f.document.querySelector('dialog').querySelector('form');
  const inputs = form.querySelectorAll('input'); inputs[0].value = 'Synthetic device'; inputs[1].value = 'synthetic-device';
  assert.match(form.textContent, /所属商户：Second merchant/); assert.match(form.textContent, /商户归属由所选场地继承/);
  f.spec.setContext({ id: 3, name: 'Third merchant' }); await form.emit('submit');
  assert.equal(f.calls.filter(call => call.method).length, 0); assert.match(form.textContent, /绑定商户已变化/);
}

// A confirmed device registration uses the authenticated merchant scope without a client receiving-account field.
{
  const f = fixture('manager'); f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); f.spec.setContext({ id: 2, name: 'Second merchant' }); await f.spec.createDeviceDialog();
  const form = f.document.querySelector('dialog').querySelector('form');
  const inputs = form.querySelectorAll('input'); inputs[0].value = 'Synthetic device'; inputs[1].value = 'synthetic-device';
  f.replies.push({ created: true }); await form.emit('submit');
  const created = f.calls.find(call => call.method === 'POST'); assert.equal(created.headers['X-Merchant-Id'], '2');
  assert.deepEqual(JSON.parse(created.body), { name: 'Synthetic device', uuid: 'synthetic-device', type: 'Rokid Studio2', venueId: 11 });
}

// A transfer cannot accidentally be submitted after the operation context changes.
{
  const f = fixture('root'); const sourceMerchant = { id: 1, name: 'First' }, targetMerchant = { id: 2, name: 'Second' };
  f.spec.setContext(sourceMerchant); f.replies.push({ items: [sourceMerchant, targetMerchant], currentMerchantId: 1 });
  await f.spec.transferDialog('devices', { id: 3 });
  const form = f.document.querySelector('dialog').querySelector('form');
  form.querySelector('select').value = '2'; form.querySelector('textarea').value = 'Synthetic transfer';
  f.spec.setContext(targetMerchant); await form.emit('submit');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.match(form.textContent, /当前商户已变化/);
}
console.log('Root merchant navigation, scoped headers, secret-free edits and transfer context verified.');

// Device-transfer instructions follow the server's entry comparison rather than requiring every device to change QR.
for (const requiresNewQr of [false, true]) {
  const f = fixture('root'); const first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' };
  f.spec.setContext(first); f.replies.push({ items: [first, second], currentMerchantId: 1 });
  await f.spec.transferDialog('devices', { id: 3 });
  const form = f.document.querySelector('dialog').querySelector('form');
  assert.match(form.textContent, /共用同一小程序入口可保留二维码/);
  form.querySelector('select').value = '2'; form.querySelector('textarea').value = 'Synthetic transfer';
  f.replies.push({ device: { id: 3, merchantId: 2 }, requiresNewQr }); await form.emit('submit');
  const notice = f.document.querySelector('.toast').textContent;
  assert.match(notice, requiresNewQr ? /更换目标入口二维码/ : /原二维码可继续使用/);
  if (!requiresNewQr) assert.doesNotMatch(notice, /请换码|请更换/);
  const transferred = f.calls.find(call => call.method === 'POST');
  assert.equal(JSON.parse(transferred.body).venueId, 11);
}

const syntheticVenue = { id: 11, merchantId: 2, name: 'Synthetic venue', address: 'Synthetic address', contactName: 'Synthetic contact', contactPhone: '00000000000', description: 'Synthetic venue description', status: 'active', useFeeCents: 2005, depositCents: 10010, version: 3 };

// Device managers read venue information while only merchant administrators/root edit it.
{
  const f = fixture('manager'); f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); f.spec.setContext({ id: 2, name: 'Second' });
  assert.equal(f.spec.canManageVenues('manager'), false); assert.equal(f.spec.canManageVenues('adminer'), true); assert.equal(f.spec.canManageVenues('root'), true);
  f.spec.venueDialog(); assert.equal(f.document.querySelector('dialog'), null);
  const content = f.document.createElement('section'); f.spec.renderVenues(content, { items: [syntheticVenue] });
  assert.match(content.textContent, /Synthetic venue/); assert.match(content.textContent, /20.05/); assert.match(content.textContent, /100.10/);
  assert.equal(content.querySelectorAll('button').length, 0);
}

// Venue prices are entered in yuan and submitted as exact integer cents in the authenticated merchant scope.
{
  const f = fixture('adminer'); f.spec.setUser({ id: 10, role: 'adminer', merchantId: 2 }); f.spec.setContext({ id: 2, name: 'Second' });
  f.spec.venueDialog(); const form = f.document.querySelector('dialog').querySelector('form'), inputs = form.querySelectorAll('input');
  inputs[0].value = '  Venue two  '; inputs[1].value = 'Synthetic address'; inputs[2].value = 'Synthetic contact'; inputs[3].value = '00000000000'; inputs[4].value = '20.05'; inputs[5].value = '100.10';
  form.querySelector('textarea').value = 'Venue description';
  f.replies.push({ venue: syntheticVenue }); await form.emit('submit');
  const written = f.calls.find(call => call.method === 'POST'), payload = JSON.parse(written.body);
  assert.equal(written.path, '/api/v2/rental/admin/venues'); assert.equal(written.headers['X-Merchant-Id'], '2');
  assert.equal(payload.name, 'Venue two'); assert.equal(payload.useFeeCents, 2005); assert.equal(payload.depositCents, 10010);
  assert.equal(payload.merchantId, undefined); assert.equal(payload.version, undefined);
}

// Invalid precision never gets sent, and edits keep the server's version.
{
  const f = fixture('root'); f.spec.setContext({ id: 2, name: 'Second' }); f.spec.venueDialog(syntheticVenue);
  const form = f.document.querySelector('dialog').querySelector('form'), inputs = form.querySelectorAll('input');
  inputs[4].value = '20.005'; await form.emit('submit'); assert.equal(f.calls.length, 0); assert.match(form.textContent, /两位小数/);
  inputs[4].value = '20.05'; f.replies.push({ venue: syntheticVenue }); await form.emit('submit');
  const written = f.calls.find(call => call.method === 'PATCH'); assert.equal(JSON.parse(written.body).version, 3);
}

// Root changing merchant while editing cannot save the venue into a different merchant.
{
  const f = fixture('root'); f.spec.setContext({ id: 2, name: 'Second' }); f.spec.venueDialog(syntheticVenue);
  const form = f.document.querySelector('dialog').querySelector('form'); f.spec.setContext({ id: 3, name: 'Third' }); await form.emit('submit');
  assert.equal(f.calls.length, 0); assert.match(form.textContent, /当前商户已变化/);
}

// A merchant card locks the header, venue route, breadcrumb and new-venue draft to the same merchant.
{
  const f = fixture('root'), first = { id: 1, code: 'first', name: 'First', status: 'active' }, second = { id: 2, code: 'second', name: 'Second', status: 'active' };
  f.spec.setContext(first, [first, second]); f.context.location.hash = '#merchants';
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    return { ok: true, json: async () => path.endsWith('/admin/merchants') ? { items: [first, second] } : { items: [syntheticVenue] } };
  };
  f.spec.shell(); await f.spec.refreshMerchants(); f.spec.useRealPages(); await f.spec.loadPage();
  const card = f.app.querySelectorAll('article').find(node => node.querySelector('h2').textContent === 'Second');
  await card.querySelectorAll('button').find(node => node.textContent === '管理场地').emit('click');
  assert.equal(f.spec.managementMerchantId(), 2); assert.equal(f.app.querySelector('#merchant-context').querySelector('select').value, '2');
  assert.equal(f.app.querySelector('.nav-merchant-scope').textContent, 'Second · second');
  assert.equal(f.context.location.hash, '#venues'); await f.windowEvents.get('hashchange')();
  assert.equal(f.app.querySelector('.breadcrumb').textContent, '商户管理 / Second / 场地');
  assert.equal(f.app.querySelector('h1').textContent, 'Second / 场地');
  assert.equal(f.app.querySelector('.nav-parent').classList.contains('active'), true);
  assert.equal(f.calls.find(call => call.path.endsWith('/admin/venues')).headers['X-Merchant-Id'], '2');
  f.spec.venueDialog(); const dialog = f.document.querySelector('dialog');
  assert.match(dialog.textContent, /所属商户：Second（second \/ ID 2）/); dialog.close();
  await f.app.querySelectorAll('button').find(node => node.textContent === '返回商户列表').emit('click');
  f.context.location.hash = '#merchants'; await f.windowEvents.get('hashchange')();
  assert.equal(f.app.querySelector('h1').textContent, '商户管理'); assert.equal(f.app.querySelectorAll('article').length, 2);
}

// Staff take their scope from managementMerchant and see only their own merchant parent and venues.
{
  const f = fixture('adminer'), own = { id: 2, code: 'own', name: 'Own merchant' }, other = { id: 3, code: 'other', name: 'Other merchant' };
  f.spec.completeLogin({ user: { id: 10, role: 'adminer', merchantId: 99 }, managementMerchant: own, merchant: { id: 1, name: 'Entry legacy alias' } }, () => true);
  f.spec.setContext(other, [other]); f.spec.renderMerchantContext();
  assert.equal(f.spec.managementMerchantId(), 2); assert.equal(f.app.querySelector('#merchant-context').querySelector('select'), null);
  assert.match(f.app.querySelector('#merchant-context').textContent, /Own merchant/);
  assert.equal(f.app.querySelector('.nav-merchant-scope').textContent, 'Own merchant · own');
  f.spec.useRealPages(); f.spec.setPage('merchants'); await f.spec.loadPage();
  assert.equal(f.app.querySelector('h1').textContent, '我的商户'); assert.equal(f.app.querySelectorAll('article').length, 1);
  assert.equal(f.app.querySelector('article').querySelector('h2').textContent, 'Own merchant');
  assert.equal(f.spec.selectManagementMerchant(other), false);
  f.spec.openMerchantVenues(other); assert.equal(f.spec.managementMerchantId(), 2);
  f.context.location.hash = '#venues'; await f.windowEvents.get('hashchange')();
  assert.equal(f.calls.find(call => call.path.endsWith('/admin/venues')).headers['X-Merchant-Id'], '2');
  assert.equal(f.app.querySelector('.breadcrumb').textContent, '我的商户 / Own merchant / 场地');
  f.spec.venueDialog(); assert.match(f.document.querySelector('dialog').textContent, /所属商户：Own merchant（own \/ ID 2）/);
  assert.equal(f.calls.some(call => call.path.includes('/rental/admin/merchants')), false);
  assert.equal(f.app.querySelectorAll('button').some(node => node.textContent === '新建商户' || node.textContent === '编辑配置'), false);
}

// No selected or assigned merchant means no venue request, no creation button and no dialog.
for (const role of ['root', 'adminer']) {
  const f = fixture(role); f.spec.setContext(null); f.context.location.hash = '#venues';
  f.context.fetch = async (path, options = {}) => { f.calls.push({ path, ...options }); return { ok: true, json: async () => ({ items: [{ id: 1, name: 'Entry' }], currentMerchantId: 1 }) }; };
  f.spec.shell(); if (role === 'root') await f.spec.refreshMerchants(); f.spec.useRealPages(); await f.spec.loadPage();
  assert.equal(f.spec.managementMerchantId(), null); assert.equal(f.calls.some(call => call.path.endsWith('/admin/venues')), false);
  assert.equal(f.app.querySelectorAll('button').some(node => node.textContent === '新建场地'), false);
  f.spec.venueDialog(); assert.equal(f.document.querySelector('dialog'), null);
  assert.match(f.app.querySelector('#main-content').textContent, /请先选择所属商户/);
  f.spec.setPage('overview'); await f.spec.loadPage(); assert.equal(f.calls.some(call => call.path.endsWith('/admin/overview')), false);
}

// Switching during a delayed protocol preflight invalidates the draft before any POST is dispatched.
{
  const f = fixture('root'), first = { id: 2, name: 'First' }, second = { id: 3, name: 'Second' };
  f.spec.setContext(first, [first, second]); f.spec.venueDialog(); const form = f.document.querySelector('dialog').querySelector('form');
  merchantField(form, '场地名称').value = 'Draft'; merchantField(form, '每次租金（元）').value = '1'; merchantField(form, '押金（元）').value = '2';
  let release; const delayed = new Promise(resolve => { release = resolve; });
  f.context.fetch = async (path, options = {}) => { if (path.endsWith('/rental/capabilities')) { await delayed; return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; } f.calls.push({ path, ...options }); return { ok: true, json: async () => ({}) }; };
  const pending = form.emit('submit'); f.spec.selectManagementMerchant(second); release(); await pending;
  assert.equal(f.calls.some(call => call.method === 'POST'), false); assert.equal(f.spec.managementMerchantId(), 3);
}

// An already dispatched save stays on its captured header, locks duplicates and cannot navigate a new context.
{
  const f = fixture('root'), first = { id: 2, name: 'First' }, second = { id: 3, name: 'Second' };
  f.spec.setContext(first, [first, second]); f.spec.venueDialog(); const form = f.document.querySelector('dialog').querySelector('form');
  merchantField(form, '场地名称').value = 'Draft'; merchantField(form, '每次租金（元）').value = '1'; merchantField(form, '押金（元）').value = '2';
  let release, started; const delayed = new Promise(resolve => { release = resolve; }), dispatch = new Promise(resolve => { started = resolve; });
  f.context.fetch = async (path, options = {}) => {
    if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) };
    f.calls.push({ path, ...options }); started(); await delayed; return { ok: true, json: async () => ({ venue: syntheticVenue }) };
  };
  const pending = form.emit('submit'); await dispatch; await form.emit('submit');
  f.spec.selectManagementMerchant(second); f.spec.setPage('merchants'); f.context.location.hash = '#merchants'; release(); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].headers['X-Merchant-Id'], '2'); assert.equal(f.calls[0].beforeDispatch, undefined);
  assert.equal(f.spec.managementMerchantId(), 3); assert.equal(f.context.location.hash, '#merchants'); assert.equal(f.context.pageLoads, 0);
  assert.match(f.document.querySelector('.toast').textContent, /First的场地已保存/);
}

// A failed draft cannot be replayed after switching away and back, even if its fields remain available.
{
  const f = fixture('root'), first = { id: 2, name: 'First' }, second = { id: 3, name: 'Second' };
  f.spec.setContext(first, [first, second]); f.spec.venueDialog(); const form = f.document.querySelector('dialog').querySelector('form');
  merchantField(form, '场地名称').value = 'Draft'; merchantField(form, '每次租金（元）').value = '1'; merchantField(form, '押金（元）').value = '2';
  f.context.fetch = async (path, options = {}) => { if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; f.calls.push({ path, ...options }); return { ok: false, status: 409, json: async () => ({ message: 'Conflict' }) }; };
  await form.emit('submit'); assert.match(form.textContent, /场地已被更新/);
  f.spec.setContext(second, [first, second]); f.spec.setContext(first, [first, second]); await form.emit('submit'); assert.equal(f.calls.length, 1);
}

// Real page loading ignores old venue/overview responses after a synchronous merchant selection change.
for (const page of ['venues', 'overview']) {
  const f = fixture('root'), first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' };
  f.spec.setContext(first, [first, second]);
  f.context.fetch = async () => ({ ok: true, json: async () => ({ items: [first, second] }) });
  f.spec.shell(); await f.spec.refreshMerchants(); f.spec.setContext(first, [first, second]);
  let release; const delayed = new Promise(resolve => { release = resolve; });
  f.context.fetch = async (path, options = {}) => { f.calls.push({ path, ...options }); const old = options.headers['X-Merchant-Id'] === '1'; if (old) await delayed; return { ok: true, json: async () => page === 'venues' ? { items: [{ ...syntheticVenue, name: old ? 'Old venue' : 'Current venue' }] } : { merchant: old ? first : second, devices: {}, orders: {} } }; };
  f.spec.useRealPages(); f.spec.setPage(page); const pending = f.spec.loadPage();
  f.spec.selectManagementMerchant(second); await f.spec.loadPage(); release(); await pending;
  assert.equal(f.spec.managementMerchantId(), 2); assert.equal(f.spec.managementMerchant().name, 'Second');
  assert.equal(f.app.querySelector('#merchant-context').querySelector('select').value, '2');
  if (page === 'venues') { assert.match(f.app.querySelector('#main-content').textContent, /Current venue/); assert.doesNotMatch(f.app.querySelector('#main-content').textContent, /Old venue/); }
}

// Older merchant-list responses cannot replace a newer selected merchant or its visible name.
{
  const f = fixture('root'), first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' };
  f.spec.setContext(first, [first, second]);
  let release, count = 0; const delayed = new Promise(resolve => { release = resolve; });
  f.context.fetch = async () => { const old = ++count === 1; if (old) await delayed; return { ok: true, json: async () => ({ items: [first, { ...second, name: old ? 'Stale name' : 'Fresh name' }] }) }; };
  const pending = f.spec.refreshMerchants(); f.spec.selectManagementMerchant(second); await f.spec.refreshMerchants(); release(); await pending;
  assert.equal(f.spec.managementMerchantId(), 2); assert.equal(f.spec.managementMerchant().name, 'Fresh name');
}
console.log('Merchant venue hierarchy, fixed draft scopes, no-scope gates and delayed response isolation verified.');

// Registration has no unbound fallback when all venues are unavailable.
{
  const f = fixture('root'); f.spec.setContext({ id: 2, name: 'Second' }); f.replies.push({ items: [{ ...syntheticVenue, status: 'paused' }] });
  await f.spec.createDeviceDialog(); const form = f.document.querySelector('dialog').querySelector('form');
  assert.match(form.textContent, /暂无可用场地/); assert.equal(form.querySelectorAll('input').length, 0); assert.equal(f.calls.some(call => call.method), false);
}

// Device configuration binds a venue and toggles rental; it never edits venue pricing.
{
  const f = fixture('manager'); f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); f.spec.setContext({ id: 2, name: 'Second' });
  f.replies.push({ items: [syntheticVenue, { ...syntheticVenue, id: 22, name: 'Venue 22' }] });
  await f.spec.configureDialog({ device: { id: 7, name: 'Synthetic device', venueId: 11 }, pricing: { enabled: true, version: 5 } });
  const form = f.document.querySelector('dialog').querySelector('form'), select = form.querySelector('select');
  assert.equal(form.querySelectorAll('input').length, 1); select.value = '22'; await select.emit('change');
  assert.equal(form.querySelector('input').checked, false);
  f.replies.push({ device: { id: 7 } }); await form.emit('submit');
  const written = f.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(JSON.parse(written.body), { enabled: false, venueId: 22, version: 5 });
}

// A paused current venue may still be kept while switching its device off.
{
  const f = fixture('manager'); f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); f.spec.setContext({ id: 2, name: 'Second' });
  f.replies.push({ items: [{ ...syntheticVenue, status: 'paused' }] });
  await f.spec.configureDialog({ device: { id: 7, name: 'Synthetic device', venueId: 11 }, pricing: { enabled: false, deviceEnabled: true, version: 5 } });
  const form = f.document.querySelector('dialog').querySelector('form'); assert.equal(form.querySelector('input').checked, false);
  f.replies.push({ device: { id: 7 } }); await form.emit('submit');
  assert.deepEqual(JSON.parse(f.calls.find(call => call.method === 'PATCH').body), { enabled: false, venueId: 11, version: 5 });
}
console.log('Venue management, exact pricing, required device venue binding and paused-venue controls verified.');

// Switching a transfer target discards an older target's late venue result and keeps the source scope unchanged.
{
  const f = fixture('root'), first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' }, third = { id: 3, name: 'Third' };
  f.spec.setContext(first); f.replies.push({ items: [first, second, third], currentMerchantId: 1 }, { items: [{ ...syntheticVenue, id: 21, merchantId: 2 }] });
  await f.spec.transferDialog('devices', { id: 7 });
  const form = f.document.querySelector('dialog').querySelector('form'), [merchant, venue] = form.querySelectorAll('select');
  let releaseOld; const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  f.context.fetch = async (path, options = {}) => {
    if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) };
    f.calls.push({ path, ...options });
    if (options.method === 'POST') return { ok: true, json: async () => ({ requiresNewQr: false }) };
    if (options.headers['X-Merchant-Id'] === '2') await oldResponse;
    return { ok: true, json: async () => ({ items: [{ ...syntheticVenue, id: options.headers['X-Merchant-Id'] === '3' ? 31 : 21 }] }) };
  };
  merchant.value = '2'; const pendingOld = merchant.emit('change');
  merchant.value = '3'; await merchant.emit('change'); releaseOld(); await pendingOld;
  assert.equal(venue.value, '31'); assert.equal(venue.querySelectorAll('option').some(option => option.value === '21'), false);
  form.querySelector('textarea').value = 'Synthetic transfer'; await form.emit('submit');
  const written = f.calls.find(call => call.method === 'POST');
  assert.deepEqual(JSON.parse(written.body), { merchantId: 3, venueId: 31, reason: 'Synthetic transfer' });
  assert.equal(written.headers['X-Merchant-Id'], '1');
}

// A target with no active venue cannot accept a device transfer.
{
  const f = fixture('root'), first = { id: 1, name: 'First' }, second = { id: 2, name: 'Second' };
  f.spec.setContext(first); f.replies.push({ items: [first, second], currentMerchantId: 1 }, { items: [] });
  await f.spec.transferDialog('devices', { id: 7 });
  const form = f.document.querySelector('dialog').querySelector('form');
  assert.match(form.textContent, /目标商户暂无可用场地/); form.querySelector('textarea').value = 'Synthetic transfer'; await form.emit('submit');
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
}
console.log('Transfer venue scope, unavailable targets and delayed target responses verified.');

// Future protocol requirements block writes while historical reads remain available.
{
  const f = fixture('root'); let capabilities = 0, business = 0;
  f.context.fetch = async path => path.endsWith('/rental/capabilities') ? (++capabilities, { ok: true, json: async () => ({ currentClientProtocol: 3, minClientProtocol: 3 }) }) : (++business, { ok: true, json: async () => ({ items: [] }) });
  await assert.rejects(f.spec.api('/rental/admin/venues', { method: 'POST', body: '{}' }), error => error.code === 'CLIENT_UPGRADE_REQUIRED');
  assert.equal(business, 0); await f.spec.api('/rental/admin/orders'); assert.equal(business, 1); assert.equal(capabilities, 1);
}

// Complete replacement needs all receiving-account credentials and keeps AppSecret independent.
{
  const f = fixture('root');
  f.replies.push({ merchant: { id: 2, code: 'merchant_2', name: 'Synthetic merchant', origin: 'https://d1.4mr.cn', appId: 'wx1111111111111111', mchId: '2000000002', status: 'draft', configuration: {} } });
  await f.spec.merchantDialog(2); const form = f.document.querySelector('dialog').querySelector('form');
  form.querySelectorAll('input').filter(input => input.type === 'checkbox')[1].checked = true;
  await form.emit('submit'); assert.equal(f.calls.some(call => call.method), false); assert.match(form.textContent, /完整替换时/);
  for (const label of ['商户私钥（PEM）', 'API v3 密钥', '商户证书序列号', '微信支付公钥 ID / 平台证书序列号', '微信支付公钥 / 平台证书（PEM）']) {
    form.querySelectorAll('label').find(node => node.children[0]?.textContent === label).querySelector('input,textarea').value = 'synthetic-credential';
  }
  f.replies.push({ merchant: { id: 2 } }, { items: [], currentMerchantId: 1 }); await form.emit('submit');
  const written = f.calls.find(call => call.method === 'PATCH'), payload = JSON.parse(written.body);
  assert.equal(payload.replaceCredentials, true); assert.equal(payload.code, 'merchant_2'); assert.equal(payload.credentials.appSecret, undefined);
  assert.equal(written.headers['X-Client-Protocol'], '2'); assert.ok(written.headers['X-Client-Version']);
}

// Only root can switch between current-merchant staff and unassigned platform consumers.
{
  const f = fixture('root'); const bar = f.spec.renderToolbar('users', { total: 0 });
  const scope = bar.querySelector('select'); assert.equal(scope.value, 'employees'); scope.value = 'platform'; await scope.emit('change'); assert.equal(f.spec.getUserScope(), 'platform');
  const adminer = fixture('adminer'); assert.equal(adminer.spec.renderToolbar('users', { total: 0 }).querySelector('select'), null);
}
console.log('Protocol gating, complete payment-credential recovery and employee/platform scopes verified.');
