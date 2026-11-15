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
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  get classList() {
    const node = this;
    return {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      add(name) { const names = new Set(node.className.split(/\s+/).filter(Boolean)); names.add(name); node.className = [...names].join(' '); },
      remove(name) { node.className = node.className.split(/\s+/).filter(value => value && value !== name).join(' '); },
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
  close() { this.open = false; return this.emit('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}

function fixture(role = 'root') {
  const body = new Element('body'), app = new Element('div'); app.id = 'app'; body.append(app);
  const document = { body, createElement: tag => new Element(tag), createElementNS: (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI }), createTextNode: text => new Element('#text', text), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector), title: '' };
  const calls = [], fetches = [], replies = [], windowEvents = new Map();
  const location = { origin: 'https://admin.example.test' }; let hash = '#overview';
  Object.defineProperty(location, 'hash', { get: () => hash, set: value => { hash = '#' + String(value).replace(/^#/, ''); } });
  const window = { addEventListener: (type, handler) => windowEvents.set(type, handler), printCalls: 0, print() { this.printCalls++; } };
  const context = vm.createContext({ document, window, location, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, fetch: async (path, options = {}) => { fetches.push({ path, ...options }); if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; calls.push({ path, ...options }); return { ok: true, json: async () => replies.length ? replies.shift() : path.startsWith('/api/v2/rental/admin/venues') ? { items: [{ id: 11, name: 'Synthetic venue', status: 'active', useFeeCents: 2000, depositCents: 10000, version: 3 }] } : ({ id: 11, role: JSON.parse(options.body || '{}').role }) }; }, pageLoads: 0 });
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '') + '\nconst originalLoadPage = loadPage; loadPage = () => { pageLoads++; }; globalThis.spec = { loadPage: originalLoadPage, useRealPages: () => { loadPage = originalLoadPage; }, heading, renderMerchants, renderMerchantContext, selectManagementMerchant, openMerchantVenues, refreshMerchants, managementMerchantId, managementMerchant, renderBranding, checkedBranding, venueAppearanceDialog, canManageBranding, canOpenPage, setPage: page => { state.page = page; }, api, merchantDialog, transferDialog, createDeviceDialog, configureDialog, venueDialog, renderVenues, renderToolbar, canManageVenues, canUseAdmin, canManageUsers, assignableRoles, roleLabel, completeLogin, boot, shell, deviceRow, deviceQrDialog, userRow, roleDialog, setContext: (merchant, merchants = []) => { state.merchantGeneration++; state.merchant = merchant; state.merchantId = merchant?.id || null; state.merchants = merchants; }, setUser: value => { state.user = value; }, advanceLogin: () => { state.loginGeneration++; }, getUser: () => state.user, getPage: () => state.page, getUserScope: () => state.filters.users.scope };', context);
  context.spec.setUser({ id: 10, role });
  return { context, spec: context.spec, document, app, calls, fetches, replies, windowEvents };
}
function controls(fixture) {
  const dialog = fixture.document.querySelector('dialog'), form = dialog.querySelector('form');
  return { dialog, form, select: form.querySelector('select'), reason: form.querySelector('textarea'), checked: form.querySelector('input'), submit: form.querySelectorAll('button').find(button => button.type === 'submit') };
}
function roleMerchantContext(fixture) {
  const first = { id: 1, code: 'first', name: 'First', status: 'active' }, second = { id: 2, code: 'second', name: 'Second', status: 'active' };
  fixture.spec.setContext(first, [first, second]); return { first, second };
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
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
// These are deliberately synthetic PEM-shaped strings, never usable payment keys.
const syntheticPem = (kind, body = 'U1lOVEhFVElDLU9OTFk=') => `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
async function credentialFixture() {
  const f = fixture('root'), first = { id: 2, code: 'merchant_2', name: 'First' }, second = { id: 3, code: 'merchant_3', name: 'Second' };
  f.spec.setContext(first, [first, second]);
  f.replies.push({ merchant: { ...first, miniappOwnerId: 1, mchId: '2000000002', status: 'draft', payEnabled: false, configuration: {} } });
  await f.spec.merchantDialog(2);
  const dialog = f.document.querySelector('dialog'), form = dialog.querySelector('form'), uploads = form.querySelectorAll('input').filter(input => input.type === 'file');
  assert.equal(uploads.length, 2);
  return { ...f, first, second, dialog, form, privateFile: uploads[0], platformFile: uploads[1], privateKey: merchantField(form, '商户私钥（PEM）'), platformPublicKey: merchantField(form, '微信支付公钥 / 平台证书（PEM）') };
}
function chooseCredentialFile(input, text, options = {}) {
  input.files = [{ size: text.length, text: async () => text, ...options }]; input.value = 'C:\\fakepath\\synthetic.pem';
  return input.emit('change');
}

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
  const root = fixture('root'); roleMerchantContext(root); root.spec.roleDialog({ id: 11, role: 'manager', merchantId: 1, allowedRoles: ['user', 'manager', 'admin', 'adminer'] }); const c = controls(root);
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
  assert.equal(root.spec.userRow({ id: 11, role: 'adminer' }).querySelectorAll('button').length, 1);
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

// Root assigns the merchant and role together after identifying the target by the verified phone.
for (const verified of [true, false]) {
  const user = { id: 11, role: 'user', nickname: 'Synthetic renter', tel: '+8613900139000', phoneVerified: verified, phoneNumber: verified ? '+8613800138000' : null };
  const checkIdentity = node => {
    assert.match(node.textContent, /Synthetic renter（ID 11）/); assert.doesNotMatch(node.textContent, /13900139000/);
    if (verified) { assert.match(node.textContent, /手机号：\+8613800138000（微信已验证）/); assert.doesNotMatch(node.textContent, /未授权手机号/); }
    else { assert.match(node.textContent, /未授权手机号，请由用户本人在小程序授权/); assert.doesNotMatch(node.textContent, /微信已验证/); }
  };
  const role = fixture('root'); const { second } = roleMerchantContext(role); role.spec.roleDialog(user); const c = controls(role); checkIdentity(c.form);
  const merchant = merchantField(c.form, '所属商户'); assert.equal(merchant.value, '1');
  merchant.value = '2'; await merchant.emit('change'); await selectRole(c, 'manager'); c.reason.value = 'Synthetic assignment';
  role.replies.push({ user: { ...user, role: 'manager', merchantId: 2 }, merchant: second });
  await c.form.emit('submit'); assert.equal(role.document.querySelector('dialog'), null); assert.equal(role.context.pageLoads, 1);
  assert.match(role.document.querySelector('.toast').textContent, /所属商户与身份已更新/);
  const written = role.calls.find(call => call.method === 'POST');
  assert.equal(written.path, '/api/v2/rental/admin/users/11/merchant');
  assert.deepEqual(JSON.parse(written.body), { merchantId: 2, reason: 'Synthetic assignment', role: 'manager' });
}

// Actual form submission grants only the selected, explicitly acknowledged role.
{
  const f = fixture('adminer'); f.spec.roleDialog({ id: 11, role: 'user', allowedRoles: ['user', 'manager'] }); const c = controls(f);
  assert.equal(merchantField(c.form, '所属商户'), null);
  assert.deepEqual(c.select.querySelectorAll('option').map(option => option.value), ['user', 'manager']);
  assert.equal(c.submit.disabled, true);
  await selectRole(c, 'manager'); assert.match(c.submit.textContent, /提升权限/);
  await c.form.emit('submit');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/v2/rental/admin/users/11/role'); assert.equal(f.calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[0].body), { role: 'manager', reason: 'Synthetic role-change test' });
  assert.equal(f.calls[0].credentials, 'same-origin');
}
{
  const f = fixture('root'); roleMerchantContext(f); f.spec.roleDialog({ id: 11, role: 'manager', merchantId: 1, allowedRoles: ['user', 'manager', 'adminer'] }); const c = controls(f);
  assert.deepEqual(c.select.querySelectorAll('option').map(option => option.value), ['user', 'manager', 'adminer']);
  await selectRole(c, 'adminer'); await c.form.emit('submit');
  assert.equal(f.calls[0].path, '/api/v2/rental/admin/users/11/merchant'); assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { role: 'adminer', merchantId: 1, reason: 'Synthetic role-change test' });
}

// Changing only the merchant preserves the role, defaults to the employee's current merchant and requires fresh acknowledgement.
{
  const f = fixture('root'); roleMerchantContext(f); f.spec.roleDialog({ id: 11, role: 'manager', merchantId: 2 }); const c = controls(f);
  const merchant = merchantField(c.form, '所属商户'); assert.equal(merchant.value, '2');
  c.checked.checked = true; await c.checked.emit('change'); assert.equal(c.submit.disabled, true);
  merchant.value = '1'; await merchant.emit('change'); assert.equal(c.checked.checked, false);
  c.checked.checked = true; await c.checked.emit('change'); c.reason.value = 'Synthetic merchant reassignment';
  assert.equal(c.submit.disabled, false); await c.form.emit('submit');
  assert.deepEqual(JSON.parse(f.calls[0].body), { merchantId: 1, role: 'manager', reason: 'Synthetic merchant reassignment' });
}

// Removing staff access does not require an active destination merchant or transfer the employee's old scope.
{
  const f = fixture('root'); f.spec.setContext({ id: 2, code: 'paused', name: 'Paused', status: 'paused' }, [{ id: 2, code: 'paused', name: 'Paused', status: 'paused' }]);
  f.spec.roleDialog({ id: 11, role: 'adminer', merchantId: 2 }); const c = controls(f), merchant = merchantField(c.form, '所属商户');
  assert.equal(merchant.value, ''); await selectRole(c, 'user'); assert.equal(merchant.disabled, true); assert.equal(c.submit.disabled, false);
  await c.form.emit('submit'); assert.deepEqual(JSON.parse(f.calls[0].body), { role: 'user', merchantId: 2, reason: 'Synthetic role-change test' });
}

// Scope, actor and session changes during capability checks cannot send an old identity assignment.
for (const invalidation of ['merchant', 'actor', 'login', 'close']) {
  const f = fixture('root'), { second } = roleMerchantContext(f), check = deferred(), started = deferred();
  f.spec.roleDialog({ id: 11, role: 'user' }); const c = controls(f); await selectRole(c, 'manager');
  f.context.fetch = async (path, options = {}) => {
    if (path.endsWith('/rental/capabilities')) { started.resolve(); await check.promise; return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; }
    f.calls.push({ path, ...options }); return { ok: true, json: async () => ({}) };
  };
  const pending = c.form.emit('submit'); await started.promise;
  if (invalidation === 'merchant') f.spec.selectManagementMerchant(second);
  if (invalidation === 'actor') f.spec.setUser({ id: 12, role: 'root' });
  if (invalidation === 'login') f.spec.advanceLogin();
  if (invalidation === 'close') await c.dialog.close();
  check.resolve(); await pending; assert.equal(f.calls.some(call => call.method), false); assert.equal(f.context.pageLoads, 0);
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

// Root enters the session's default merchant before the merchant list finishes loading.
// Both QR login and restoring the cookie session use that same initial scope.
for (const entryPoint of ['login', 'session']) {
  const f = fixture('root'), first = { id: 1, code: 'default', name: '默认商户', status: 'active' }, second = { id: 2, code: 'second', name: 'Second', status: 'active' };
  const session = { user: { id: 10, role: 'root', merchantId: null }, managementMerchant: null, merchant: first };
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    if (path.endsWith('/admin/merchants')) await delayed;
    return { ok: true, json: async () => path.endsWith('/auth/session') ? session : path.endsWith('/admin/merchants') ? { items: [second, first], currentMerchantId: 1 } : path.endsWith('/admin/overview') ? { merchant: options.headers['X-Merchant-Id'] === '2' ? second : first, devices: {}, orders: {} } : { currentClientProtocol: 2, minClientProtocol: 2 } };
  };
  f.spec.useRealPages();
  if (entryPoint === 'login') f.spec.completeLogin(session, () => true);
  else await f.spec.boot();
  assert.equal(f.spec.managementMerchantId(), 1);
  assert.equal(f.calls.find(call => call.path.endsWith('/admin/overview')).headers['X-Merchant-Id'], '1');
  assert.doesNotMatch(f.app.textContent, /请先选择所属商户/);
  release(); await new Promise(resolve => setImmediate(resolve));
  const select = f.app.querySelector('#merchant-context').querySelector('select');
  assert.equal(select.value, '1');
  assert.equal(f.app.querySelector('.nav-merchant-scope').textContent, '默认商户 · default');
  select.value = '2'; await select.emit('change');
  await f.spec.refreshMerchants();
  assert.equal(f.spec.managementMerchantId(), 2);
  assert.equal(f.app.querySelector('#merchant-context').querySelector('select').value, '2');
  assert.equal(f.calls.filter(call => call.path.endsWith('/admin/overview')).at(-1).headers['X-Merchant-Id'], '2');
  await f.spec.boot(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.spec.managementMerchantId(), 1);
  assert.equal(f.app.querySelector('#merchant-context').querySelector('select').value, '1');
  assert.equal(f.calls.filter(call => call.path.endsWith('/admin/overview')).at(-1).headers['X-Merchant-Id'], '1');
}
{
  const f = fixture('adminer');
  f.spec.completeLogin({ user: { id: 10, role: 'adminer', merchantId: null }, managementMerchant: null, merchant: { id: 1, name: '默认商户' } }, () => true);
  await f.spec.loadPage();
  assert.equal(f.spec.managementMerchantId(), null);
  assert.equal(f.calls.some(call => call.path.endsWith('/admin/overview')), false);
  assert.match(f.app.textContent, /请先选择所属商户/);
}

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

// Managers choose a venue inside their fixed merchant before querying devices.
const deviceVenueFixtures = [
  { id: 21, merchantId: 2, name: 'North scenic venue', status: 'active' },
  { id: 22, merchantId: 2, name: 'South scenic venue', status: 'paused' },
];
const venueDevice = (venueId, label = 'Venue device') => ({ device: { id: venueId, uuid: label, venueId, venueName: 'Venue ' + venueId, type: 'Rokid Studio2' }, venue: { id: venueId }, state: 'DISABLED', pricing: { enabled: false, useFeeCents: 100, depositCents: 500 } });
function managerDevicesFixture(role = 'manager') {
  const f = fixture(role), own = { id: 2, name: 'Own merchant', code: 'own' };
  f.spec.completeLogin({ user: { id: 10, role, merchantId: 2, authVersion: 1 }, managementMerchant: own, merchant: own }, () => true);
  f.spec.setPage('devices'); f.spec.useRealPages();
  return f;
}
const currentVenueSelect = f => f.app.querySelectorAll('select').find(select => select.getAttribute('aria-label') === '选择当前景点');
async function until(condition) {
  for (let step = 0; step < 60 && !condition(); step++) await Promise.resolve();
  assert.ok(condition(), 'Expected asynchronous page state was not reached.');
}
{
  const f = managerDevicesFixture();
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    const query = new URL(path, f.context.location.origin).searchParams;
    return { ok: true, json: async () => path.endsWith('/venues') ? { items: deviceVenueFixtures } : { items: [venueDevice(Number(query.get('venueId')))], page: Number(query.get('page')), pageSize: 20, total: 41 } };
  };
  await f.spec.loadPage();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/v2/rental/admin/venues'); assert.equal(f.calls[0].headers['X-Merchant-Id'], '2');
  assert.match(f.app.textContent, /请选择当前景点/); assert.equal(f.app.querySelector('.devices-table'), null);
  const select = currentVenueSelect(f); assert.equal(select.value, '');
  assert.deepEqual(select.querySelectorAll('option').map(option => option.value), ['', '21', '22']); assert.match(select.textContent, /South scenic venue（已暂停）/);
  select.value = '21'; await select.emit('change');
  const requested = f.calls.find(call => call.path.includes('/devices?')); assert.equal(new URL(requested.path, f.context.location.origin).searchParams.get('venueId'), '21'); assert.equal(requested.headers['X-Merchant-Id'], '2');
  assert.match(f.app.textContent, /当前景点：North scenic venue/); assert.equal(f.app.querySelector('.device-summary'), null); assert.equal(f.calls.some(call => call.path.endsWith('/overview')), false);
  const searchForm = f.app.querySelector('.search-form'); searchForm.querySelector('input').value = 'scenic'; await searchForm.emit('submit');
  await until(() => !!f.app.querySelector('.devices-table'));
  let query = new URL(f.calls.filter(call => call.path.includes('/devices?')).at(-1).path, f.context.location.origin).searchParams;
  assert.equal(query.get('venueId'), '21'); assert.equal(query.get('search'), 'scenic'); assert.equal(query.get('page'), '1');
  await f.app.querySelector('.pagination-actions').querySelectorAll('button').find(button => button.textContent === '下一页').emit('click');
  await until(() => !!f.app.querySelector('.devices-table'));
  query = new URL(f.calls.filter(call => call.path.includes('/devices?')).at(-1).path, f.context.location.origin).searchParams;
  assert.equal(query.get('venueId'), '21'); assert.equal(query.get('page'), '2');
  const paused = currentVenueSelect(f); paused.value = '22'; await paused.emit('change');
  query = new URL(f.calls.filter(call => call.path.includes('/devices?')).at(-1).path, f.context.location.origin).searchParams;
  assert.equal(query.get('venueId'), '22'); assert.equal(query.get('page'), '1'); assert.match(f.app.textContent, /当前景点：South scenic venue/);
  const injected = currentVenueSelect(f), before = f.calls.filter(call => call.path.includes('/devices?')).length;
  injected.value = '999'; await injected.emit('change');
  assert.equal(f.calls.filter(call => call.path.includes('/devices?')).length, before); assert.equal(f.app.querySelector('.devices-table'), null);
}

// A newer venue selection clears old rows immediately and cannot be overwritten by a late response.
{
  const f = managerDevicesFixture(), delayed = deferred(), started = deferred();
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    if (path.endsWith('/venues')) return { ok: true, json: async () => ({ items: deviceVenueFixtures }) };
    const venueId = Number(new URL(path, f.context.location.origin).searchParams.get('venueId'));
    if (venueId === 21) { started.resolve(); await delayed.promise; }
    return { ok: true, json: async () => ({ items: [venueDevice(venueId, venueId === 21 ? 'Old venue device' : 'Current venue device')], page: 1, total: 1 }) };
  };
  await f.spec.loadPage(); const select = currentVenueSelect(f);
  select.value = '21'; const first = select.emit('change'); await started.promise; assert.equal(f.app.querySelector('.devices-table'), null);
  select.value = '22'; await select.emit('change'); assert.match(f.app.textContent, /Current venue device/);
  delayed.resolve(); await first; assert.match(f.app.textContent, /Current venue device/); assert.doesNotMatch(f.app.textContent, /Old venue device/);
}

// Selection is revalidated on every query; empty, failed or foreign venue lists never fall back to all devices.
for (const mode of ['empty', 'foreign', 'failed']) {
  const f = managerDevicesFixture();
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    if (mode === 'failed') throw Error('Synthetic venue network failure');
    return { ok: true, json: async () => ({ items: mode === 'empty' ? [] : [{ ...deviceVenueFixtures[0], merchantId: 3 }] }) };
  };
  await f.spec.loadPage(); assert.equal(f.calls.length, 1); assert.equal(f.app.querySelector('.devices-table'), null);
  assert.match(f.app.textContent, mode === 'empty' ? /当前商户暂无景点/ : /数据暂时无法加载/);
}
{
  const f = managerDevicesFixture(); let venues = deviceVenueFixtures;
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options }); return { ok: true, json: async () => path.endsWith('/venues') ? { items: venues } : { items: [venueDevice(21)], page: 1, total: 1 } };
  };
  await f.spec.loadPage(); const select = currentVenueSelect(f); select.value = '21'; await select.emit('change');
  const before = f.calls.filter(call => call.path.includes('/devices?')).length;
  venues = [{ ...deviceVenueFixtures[1] }, { ...deviceVenueFixtures[1], id: 23 }]; await f.spec.loadPage();
  assert.equal(f.calls.filter(call => call.path.includes('/devices?')).length, before); assert.equal(currentVenueSelect(f).value, ''); assert.equal(f.app.querySelector('.devices-table'), null);
}

// Account, role, authorization, merchant and login changes reject a device response from the old context.
for (const invalidation of ['account', 'role', 'authorization', 'merchant', 'login']) {
  const f = managerDevicesFixture(), delayed = deferred(), started = deferred();
  f.context.fetch = async (path, options = {}) => {
    f.calls.push({ path, ...options });
    if (path.endsWith('/venues')) return { ok: true, json: async () => ({ items: [deviceVenueFixtures[0]] }) };
    started.resolve(); await delayed.promise; return { ok: true, json: async () => ({ items: [venueDevice(21, 'Old scoped device')], page: 1, total: 1 }) };
  };
  const pending = f.spec.loadPage(); await started.promise;
  if (invalidation === 'account') f.spec.setUser({ id: 11, role: 'manager', merchantId: 2, authVersion: 1 });
  if (invalidation === 'role') f.spec.setUser({ id: 10, role: 'adminer', merchantId: 2, authVersion: 1 });
  if (invalidation === 'authorization') f.spec.setUser({ id: 10, role: 'manager', merchantId: 2, authVersion: 2 });
  if (invalidation === 'merchant') f.spec.setContext({ id: 3, name: 'Other merchant' });
  if (invalidation === 'login') f.spec.advanceLogin();
  delayed.resolve(); await pending; assert.doesNotMatch(f.app.textContent, /Old scoped device/); assert.equal(f.app.querySelector('.devices-table'), null);
}

// An unfiltered merchant response cannot be displayed as one selected venue.
{
  const f = managerDevicesFixture();
  f.context.fetch = async (path, options = {}) => { f.calls.push({ path, ...options }); return { ok: true, json: async () => path.endsWith('/venues') ? { items: [deviceVenueFixtures[0]] } : { items: [venueDevice(22, 'Out-of-venue device')], page: 1, total: 1 } }; };
  await f.spec.loadPage(); assert.equal(f.app.querySelector('.devices-table'), null); assert.doesNotMatch(f.app.textContent, /Out-of-venue device/); assert.match(f.app.textContent, /设备景点范围已变化/);
}

// Adminer keeps the whole merchant device view and does not need a venue picker.
{
  const f = managerDevicesFixture('adminer');
  f.context.fetch = async (path, options = {}) => { f.calls.push({ path, ...options }); return { ok: true, json: async () => path.endsWith('/overview') ? { devices: { total: 2 } } : { items: [venueDevice(21), venueDevice(22)], page: 1, total: 2 } }; };
  await f.spec.loadPage(); assert.equal(currentVenueSelect(f), undefined); assert.equal(f.calls.some(call => call.path.endsWith('/venues')), false);
  const query = new URL(f.calls.find(call => call.path.includes('/devices?')).path, f.context.location.origin).searchParams;
  assert.equal(query.has('venueId'), false); assert.equal(f.app.querySelector('tbody').querySelectorAll('tr').length, 2); assert.ok(f.app.querySelector('.device-summary'));
}
console.log('Manager venue selection, fixed merchant scope, filtered devices and delayed-response isolation verified.');

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

// PEM imports stay local, support both allowed formats and leave scalar credentials manual.
for (const [privateKind, platformKind] of [['PRIVATE KEY', 'PUBLIC KEY'], ['RSA PRIVATE KEY', 'CERTIFICATE'], ['PRIVATE KEY', 'RSA PUBLIC KEY']]) {
  const f = await credentialFixture(), before = f.fetches.length;
  const privatePem = syntheticPem(privateKind), platformPem = syntheticPem(platformKind);
  await chooseCredentialFile(f.privateFile, '\uFEFF' + privatePem.replace(/\n/g, '\r\n') + '\r\n');
  await chooseCredentialFile(f.platformFile, platformPem);
  assert.equal(f.privateKey.value, privatePem); assert.equal(f.platformPublicKey.value, platformPem);
  assert.equal(f.privateFile.value, ''); assert.equal(f.platformFile.value, ''); assert.equal(f.fetches.length, before);
  for (const label of ['API v3 密钥', '商户证书序列号', '微信支付公钥 ID / 平台证书序列号']) assert.equal(merchantField(f.form, label).type, 'password');
}

// Reject wrong blocks, malformed/multiple blocks, oversized files and unreadable files without erasing a draft.
{
  const f = await credentialFixture(), before = f.fetches.length;
  f.privateKey.value = syntheticPem('PRIVATE KEY'); f.platformPublicKey.value = syntheticPem('PUBLIC KEY');
  for (const [file, field, value] of [
    [f.privateFile, f.privateKey, syntheticPem('PUBLIC KEY')],
    [f.platformFile, f.platformPublicKey, syntheticPem('PRIVATE KEY')],
    [f.privateFile, f.privateKey, syntheticPem('PRIVATE KEY').replace('END PRIVATE KEY', 'END RSA PRIVATE KEY')],
    [f.privateFile, f.privateKey, syntheticPem('PRIVATE KEY') + '\n' + syntheticPem('PRIVATE KEY')],
    [f.platformFile, f.platformPublicKey, syntheticPem('CERTIFICATE') + '\n' + syntheticPem('CERTIFICATE')],
    [f.privateFile, f.privateKey, syntheticPem('PRIVATE KEY', 'invalid body!')],
  ]) {
    const previous = field.value; await chooseCredentialFile(file, value);
    assert.equal(field.value, previous); assert.match(file.parent.textContent, /请选择/);
  }
  let reads = 0;
  await chooseCredentialFile(f.privateFile, syntheticPem('PRIVATE KEY'), { size: 16001, text: async () => { reads++; return syntheticPem('PRIVATE KEY'); } });
  assert.equal(reads, 0); assert.equal(f.privateKey.value, syntheticPem('PRIVATE KEY')); assert.match(f.privateFile.parent.textContent, /16 KB/);
  await chooseCredentialFile(f.privateFile, syntheticPem('PRIVATE KEY', 'A'.repeat(16000)), { size: 1 });
  assert.equal(f.privateKey.value, syntheticPem('PRIVATE KEY'));
  await chooseCredentialFile(f.platformFile, syntheticPem('PUBLIC KEY'), { text: async () => { throw new Error('Synthetic file-read failure'); } });
  assert.equal(f.platformPublicKey.value, syntheticPem('PUBLIC KEY')); assert.match(f.platformFile.parent.textContent, /无法读取/);
  assert.equal(f.fetches.length, before);
}

// Reads have independent field revisions; a later file or manual edit wins over a delayed earlier file.
{
  const f = await credentialFixture(), privateRead = deferred(), platformRead = deferred(), before = f.fetches.length;
  const privatePending = chooseCredentialFile(f.privateFile, '', { size: 100, text: () => privateRead.promise });
  const platformPending = chooseCredentialFile(f.platformFile, '', { size: 100, text: () => platformRead.promise });
  platformRead.resolve(syntheticPem('CERTIFICATE')); await platformPending;
  assert.equal(f.platformPublicKey.value, syntheticPem('CERTIFICATE')); assert.equal(f.privateKey.value, '');
  privateRead.resolve(syntheticPem('RSA PRIVATE KEY')); await privatePending;
  assert.equal(f.privateKey.value, syntheticPem('RSA PRIVATE KEY')); assert.equal(f.fetches.length, before);
  for (const [file, field, kind] of [[f.privateFile, f.privateKey, 'PRIVATE KEY'], [f.platformFile, f.platformPublicKey, 'PUBLIC KEY']]) {
    const earlier = deferred(), pending = chooseCredentialFile(file, '', { size: 100, text: () => earlier.promise });
    const newer = syntheticPem(kind, 'TkVXRVItU1lOVEhFVElD'); await chooseCredentialFile(file, newer);
    earlier.resolve(syntheticPem(kind, 'T0xERVItU1lOVEhFVElD')); await pending; assert.equal(field.value, newer);
    const delayed = deferred(), reading = chooseCredentialFile(file, '', { size: 100, text: () => delayed.promise });
    field.value = 'Manually pasted synthetic draft'; await field.emit('input');
    delayed.resolve(syntheticPem(kind)); await reading; assert.equal(field.value, 'Manually pasted synthetic draft');
  }
  assert.equal(f.fetches.length, before);
}

// Closing, changing actor/session, or switching away and back prevents delayed imports from filling an obsolete draft.
for (const invalidation of ['close', 'merchant', 'actor', 'login']) {
  const f = await credentialFixture(), read = deferred(), before = f.fetches.length;
  f.privateKey.value = 'Previous synthetic draft'; f.platformPublicKey.value = 'Other synthetic draft';
  const pending = chooseCredentialFile(f.privateFile, '', { size: 100, text: () => read.promise });
  if (invalidation === 'close') {
    f.platformFile.value = 'C:\\fakepath\\synthetic-platform.pem'; await f.dialog.close();
    assert.equal(f.privateKey.value, ''); assert.equal(f.platformPublicKey.value, '');
    assert.equal(f.privateFile.value, ''); assert.equal(f.platformFile.value, '');
  }
  if (invalidation === 'merchant') { f.spec.setContext(f.second, [f.first, f.second]); f.spec.setContext(f.first, [f.first, f.second]); }
  if (invalidation === 'actor') f.spec.setUser({ id: 11, role: 'root' });
  if (invalidation === 'login') f.spec.advanceLogin();
  read.resolve(syntheticPem('PRIVATE KEY')); await pending;
  assert.equal(f.privateKey.value, invalidation === 'close' ? '' : 'Previous synthetic draft'); assert.equal(f.fetches.length, before);
  if (invalidation === 'close') { assert.equal(f.platformPublicKey.value, ''); assert.equal(f.privateFile.value, ''); assert.equal(f.platformFile.value, ''); assert.equal(f.document.querySelector('dialog'), null); }
}

// A pending read blocks save; after it completes the ordinary JSON request carries the original credential fields.
{
  const f = await credentialFixture(), read = deferred(), before = f.fetches.length;
  const privatePem = syntheticPem('PRIVATE KEY'), platformPem = syntheticPem('PUBLIC KEY');
  await chooseCredentialFile(f.platformFile, platformPem);
  const pending = chooseCredentialFile(f.privateFile, '', { size: 100, text: () => read.promise });
  await f.form.emit('submit'); assert.equal(f.fetches.length, before); assert.match(f.form.textContent, /文件正在读取/);
  read.resolve(privatePem); await pending;
  const manual = { apiV3Key: 'synthetic-manually-entered-key', serialNo: 'AABBCCDDEEFF', platformKeyId: 'PUB_KEY_ID_SYNTHETIC' };
  for (const [label, value] of [['API v3 密钥', manual.apiV3Key], ['商户证书序列号', manual.serialNo], ['微信支付公钥 ID / 平台证书序列号', manual.platformKeyId]]) merchantField(f.form, label).value = value;
  f.replies.push({ merchant: f.first }, { items: [f.first, f.second], currentMerchantId: 2 }); await f.form.emit('submit');
  const writes = f.calls.filter(call => call.method); assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH'); assert.equal(writes[0].path, '/api/v2/rental/admin/merchants/2');
  assert.deepEqual(JSON.parse(writes[0].body).credentials, { privateKey: privatePem, ...manual, platformPublicKey: platformPem });
  assert.equal(writes[0].headers['Content-Type'], 'application/json'); assert.equal(writes[0].beforeDispatch, undefined);
  assert.equal(f.fetches.length, before + 3); assert.equal(f.privateKey.value, ''); assert.equal(f.platformPublicKey.value, '');
}

// Protocol checks must not dispatch a merchant save after the draft's scope, actor, session or open state changes.
for (const invalidation of ['merchant', 'actor', 'login', 'close']) {
  const f = await credentialFixture(), check = deferred(), started = deferred();
  f.context.fetch = async (path, options = {}) => {
    if (path.endsWith('/rental/capabilities')) { started.resolve(); await check.promise; return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) }; }
    f.calls.push({ path, ...options }); return { ok: true, json: async () => ({}) };
  };
  const pending = f.form.emit('submit'); await started.promise;
  if (invalidation === 'merchant') f.spec.selectManagementMerchant(f.second);
  if (invalidation === 'actor') f.spec.setUser({ id: 11, role: 'root' });
  if (invalidation === 'login') f.spec.advanceLogin();
  if (invalidation === 'close') await f.dialog.close();
  check.resolve(); await pending; assert.equal(f.calls.some(call => call.method), false);
  assert.equal(f.context.pageLoads, 0); assert.equal(f.document.querySelector('.toast'), null);
}

// A dispatched save cannot duplicate or refresh/navigate a newly selected merchant when its response arrives late.
{
  const f = await credentialFixture(), response = deferred(), started = deferred(), before = f.calls.length;
  f.context.fetch = async (path, options = {}) => {
    if (path.endsWith('/rental/capabilities')) return { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) };
    f.calls.push({ path, ...options }); started.resolve(); await response.promise; return { ok: true, json: async () => ({ merchant: f.first }) };
  };
  const pending = f.form.emit('submit'); await started.promise; await f.form.emit('submit');
  f.spec.selectManagementMerchant(f.second); f.spec.setPage('venues'); f.context.location.hash = '#venues';
  response.resolve(); await pending;
  assert.equal(f.calls.length, before + 1); assert.equal(f.calls[before].method, 'PATCH');
  assert.equal(f.spec.managementMerchantId(), 3); assert.equal(f.spec.getPage(), 'venues'); assert.equal(f.context.location.hash, '#venues');
  assert.equal(f.context.pageLoads, 0); assert.equal(f.document.querySelector('.toast'), null);
}
console.log('Local PEM imports, credential-read races and merchant-save context guards verified.');

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

// Both staff roles take their scope from managementMerchant and cannot switch merchants.
for (const role of ['adminer', 'manager']) {
  const f = fixture(role), own = { id: 2, code: 'own', name: 'Own merchant' }, other = { id: 3, code: 'other', name: 'Other merchant' };
  f.spec.completeLogin({ user: { id: 10, role, merchantId: 99 }, managementMerchant: own, merchant: { id: 1, name: 'Entry legacy alias' } }, () => true);
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
  f.spec.venueDialog();
  if (role === 'adminer') assert.match(f.document.querySelector('dialog').textContent, /所属商户：Own merchant（own \/ ID 2）/);
  else { assert.equal(f.document.querySelector('dialog'), null); f.spec.roleDialog({ id: 11, role: 'user' }); assert.equal(f.document.querySelector('dialog'), null); }
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

const qrDevice = { id: 7, uuid: 'camera%2F+01', name: '<img src=x onerror=alert(1)>', type: 'Rokid Studio2', merchantId: 2, merchantName: 'Synthetic merchant', venueName: 'Synthetic venue' };
const qrReply = () => ({ device: { ...qrDevice }, url: 'https://d.4mr.cn/d?i=camera%252F%2B01&t=rs2', qr: { size: 21, modules: '1' + '0'.repeat(440) } });
const qrButton = (dialog, label) => dialog.querySelectorAll('button').find(node => node.textContent === label);
function qrFixture(role = 'root') {
  const f = fixture(role);
  f.spec.setUser({ id: 10, role, merchantId: role === 'root' ? null : 2 });
  f.spec.setContext({ id: 2, name: 'Synthetic merchant' });
  return f;
}

// Every device-management role can request a persisted device's code in its current scope.
for (const role of ['manager', 'adminer', 'root']) {
  const f = qrFixture(role);
  f.replies.push(qrReply());
  const row = f.spec.deviceRow({ device: qrDevice, pricing: {} });
  const trigger = row.querySelectorAll('button').find(node => node.textContent === '二维码');
  assert.ok(trigger, 'Missing device QR action for ' + role);
  await trigger.emit('click');
  const request = f.calls.find(call => call.path.endsWith('/devices/7/qrcode'));
  assert.ok(request); assert.equal(request.method, undefined); assert.equal(request.headers['X-Merchant-Id'], '2'); assert.equal(request.credentials, 'same-origin');
  assert.equal(f.calls.some(call => call.method), false);
  const dialog = f.document.querySelector('.device-qr-dialog'), label = dialog.querySelector('.device-qr-label');
  assert.match(label.textContent, /微信扫一扫租赁/); assert.ok(label.textContent.includes(qrDevice.uuid)); assert.ok(label.textContent.includes(qrDevice.name));
  assert.equal(label.querySelector('img'), null); assert.equal(label.querySelector('script'), null);
  assert.equal(label.querySelector('svg').namespaceURI, 'http://www.w3.org/2000/svg');
  for (const label of ['打印标签', '下载 PNG', '下载 SVG']) assert.equal(qrButton(dialog, label).disabled, false);
  await qrButton(dialog, '打印标签').emit('click'); assert.equal(f.context.window.printCalls, 1);
  assert.equal(dialog.classList.contains('device-qr-print-target'), true); assert.ok(f.document.title.includes(qrDevice.uuid));
  f.windowEvents.get('afterprint')(); assert.equal(dialog.classList.contains('device-qr-print-target'), false); assert.equal(f.document.title, '');
}

// Loading or a failed QR response cannot produce a printable placeholder; retry uses the same device.
{
  const f = qrFixture(), response = deferred();
  f.context.fetch = async () => response.promise;
  const pending = f.spec.deviceQrDialog({ device: qrDevice });
  const dialog = f.document.querySelector('.device-qr-dialog');
  for (const label of ['打印标签', '下载 PNG', '下载 SVG']) assert.equal(qrButton(dialog, label).disabled, true);
  response.resolve({ ok: false, status: 503, json: async () => ({ message: 'Synthetic QR failure' }) }); await pending;
  assert.match(dialog.textContent, /Synthetic QR failure/); assert.equal(dialog.querySelector('.device-qr-code'), null);
  for (const label of ['打印标签', '下载 PNG', '下载 SVG']) assert.equal(qrButton(dialog, label).disabled, true);
  f.context.fetch = async (path, options = {}) => { f.calls.push({ path, ...options }); return { ok: true, json: async () => qrReply() }; };
  const retry = dialog.querySelectorAll('button').find(node => /重试|重新生成/.test(node.textContent)); assert.ok(retry); await retry.emit('click');
  assert.equal(f.calls.at(-1).path, '/api/v2/rental/admin/devices/7/qrcode'); assert.ok(dialog.querySelector('.device-qr-code')); assert.equal(qrButton(dialog, '打印标签').disabled, false);
}

// A late response cannot populate a closed dialog or revive a different merchant's QR preview.
for (const changeScope of [false, true]) {
  const f = qrFixture(), response = deferred();
  f.context.fetch = async () => response.promise;
  const pending = f.spec.deviceQrDialog({ device: qrDevice });
  const dialog = f.document.querySelector('.device-qr-dialog');
  if (changeScope) f.spec.setContext({ id: 3, name: 'Other merchant' });
  else await dialog.close();
  response.resolve({ ok: true, json: async () => qrReply() }); await pending;
  assert.equal(dialog.querySelector('.device-qr-code'), null);
  assert.equal(qrButton(dialog, '打印标签').disabled, true);
}

// A mismatched device or broken response must never become a printable code for the selected row.
for (const corrupt of [reply => { reply.device.id = 8; }, reply => { reply.url = 'https://d.4mr.cn/d?i=other-device&t=rs2'; }, reply => { reply.qr.modules = '1'; }]) {
  const f = qrFixture(), reply = qrReply(); corrupt(reply); f.replies.push(reply);
  await f.spec.deviceQrDialog({ device: qrDevice });
  const dialog = f.document.querySelector('.device-qr-dialog');
  assert.equal(dialog.querySelector('.device-qr-code'), null); assert.equal(qrButton(dialog, '打印标签').disabled, true);
  await qrButton(dialog, '打印标签').emit('click'); assert.equal(f.context.window.printCalls, 0);
}
console.log('Device QR scope, safe labels, print readiness, retry and delayed-response isolation verified.');

const brandingReply = (changes = {}) => ({ merchant: { id: 2, code: 'synthetic', name: 'Synthetic merchant' }, branding: { displayName: 'Synthetic brand', logoUrl: 'https://admin.example.test/api/v2/rental/branding/2/logo?v=4', version: 4, updatedAt: '2026-11-15T12:00:00.000Z', ...changes } });
const appearanceReply = (changes = {}, venueChanges = {}) => ({ venue: { id: 11, merchantId: 2, name: 'Synthetic venue', ...venueChanges }, appearance: { theme: 'aero', heroImageUrl: 'https://admin.example.test/api/v2/rental/venues/11/hero?v=4', version: 4, updatedAt: '2026-11-15T12:00:00.000Z', ...changes } });
function brandingFixture(role = 'adminer', render = true) {
  const f = fixture(role), first = { id: 2, code: 'synthetic', name: 'Synthetic merchant' }, second = { id: 3, code: 'other', name: 'Other merchant' };
  f.spec.setUser({ id: 10, role, merchantId: role === 'root' ? null : 2 }); f.spec.setContext(first, [first, second]); f.spec.setPage('branding');
  const content = f.document.createElement('section'); f.app.append(content); if (render) f.spec.renderBranding(content, brandingReply());
  const form = content.querySelector('form');
  return { ...f, first, second, content, form, name: form?.querySelectorAll('input')[0], upload: form?.querySelectorAll('input').find(node => node.type === 'file'), logo: form?.querySelectorAll('input').find(node => node.type === 'url'), submit: form?.querySelectorAll('button').find(node => node.type === 'submit') };
}
async function appearanceFixture(role = 'adminer', appearance = appearanceReply()) {
  const f = brandingFixture(role, false); f.spec.setPage('venues'); f.replies.push(appearance, brandingReply());
  await f.spec.venueAppearanceDialog({ id: 11, merchantId: 2, name: 'Synthetic venue' });
  const dialog = f.document.querySelector('.venue-appearance-dialog'), form = dialog?.querySelector('form');
  return { ...f, dialog, form, hero: form?.querySelectorAll('input').find(node => node.type === 'url'), upload: form?.querySelectorAll('input').find(node => node.type === 'file'), submit: form?.querySelectorAll('button').find(node => node.type === 'submit') };
}

// Merchant-wide identity and venue-specific appearance have distinct administrators and forms.
for (const role of ['manager', 'adminer', 'root']) {
  const f = fixture(role); f.context.location.hash = '#branding'; f.spec.shell();
  assert.equal(f.spec.canManageBranding(role), role !== 'manager'); assert.equal(f.app.querySelector('nav').querySelectorAll('a').some(node => node.dataset.page === 'branding'), role !== 'manager'); assert.equal(f.spec.getPage(), role === 'manager' ? 'overview' : 'branding');
  const scoped = brandingFixture(role); scoped.spec.renderVenues(scoped.content, { items: [{ id: 11, merchantId: 2, name: 'Synthetic venue' }] }); assert.equal(scoped.content.querySelectorAll('button').some(node => node.textContent === '样式设置'), role !== 'manager');
}
{
  const f = brandingFixture('manager'); assert.equal(f.form, null); await f.spec.venueAppearanceDialog({ id: 11, merchantId: 2, name: 'Synthetic venue' }); assert.equal(f.document.querySelector('dialog'), null);
  const root = fixture('root'); root.spec.setPage('branding'); const main = root.document.createElement('main'); main.id = 'main-content'; root.app.append(main); await root.spec.loadPage(); assert.equal(root.calls.length, 0); assert.match(main.textContent, /请先选择所属商户/);
}
for (const role of ['adminer', 'root']) {
  const f = brandingFixture(role); assert.equal(f.form.querySelectorAll('input').some(node => node.type === 'radio'), false); assert.equal(f.form.querySelectorAll('input').filter(node => node.type === 'file').length, 1); assert.doesNotMatch(f.form.textContent, /恢复默认主图/);
  assert.equal(f.content.querySelector('.branding-phone').classList.contains('branding-preview-theme-aero'), true); assert.equal(f.content.querySelector('.branding-preview-product').getAttribute('src'), '/admin/assets/aero-glasses.png');
  f.name.value = '<img src=x>'; await f.name.emit('input'); assert.equal(f.content.querySelector('.branding-preview-identity').querySelector('h3').textContent, '<img src=x>'); assert.equal(f.content.querySelector('.branding-preview-identity').querySelector('h3').querySelector('img'), null);
  f.replies.push(brandingReply({ displayName: '<img src=x>', version: 5 })); await f.form.emit('submit');
  const request = f.calls.find(call => call.method === 'PATCH'); assert.equal(request.headers['X-Merchant-Id'], '2'); assert.deepEqual(JSON.parse(request.body), { displayName: '<img src=x>', version: 4 }); assert.match(f.form.textContent, /品牌设置已保存/);
}
{
  const f = brandingFixture(); f.logo.value = 'javascript:alert(1)'; await f.logo.emit('input'); await f.form.emit('submit'); assert.equal(f.calls.length, 0); assert.match(f.form.textContent, /HTTPS/);
  f.logo.value = ''; await f.logo.emit('input'); f.context.fetch = async path => path.endsWith('/rental/capabilities') ? { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) } : { ok: false, status: 409, json: async () => ({ message: 'Conflict' }) }; await f.form.emit('submit'); assert.match(f.form.textContent, /其他管理员修改/); assert.equal(f.form.querySelectorAll('button').find(node => node.textContent === '重新加载最新配置').hidden, false);
}
{
  const f = brandingFixture(), data = deferred(); f.context.FileReader = class { readAsDataURL() { data.promise.then(value => { this.result = value; this.onload(); }); } };
  f.upload.files = [{ size: 20, type: 'image/png' }]; const pending = f.upload.emit('change'); assert.equal(f.submit.disabled, true); f.logo.value = 'https://images.example.test/new.png'; await f.logo.emit('input'); data.resolve('data:image/png;base64,c3ludGhldGlj'); await pending;
  f.replies.push(brandingReply({ logoUrl: f.logo.value, version: 5 })); await f.form.emit('submit'); const payload = JSON.parse(f.calls.find(call => call.method === 'PATCH').body); assert.equal(payload.logoUrl, 'https://images.example.test/new.png'); assert.equal(payload.logoDataUrl, undefined); assert.equal(payload.theme, undefined); assert.equal(payload.heroImageUrl, undefined);
}
{
  const f = brandingFixture(), data = deferred(); f.context.FileReader = class { readAsDataURL() { data.promise.then(value => { this.result = value; this.onload(); }); } }; f.upload.files = [{ size: 20, type: 'image/png' }]; const pending = f.upload.emit('change'); data.resolve('data:image/png;base64,c3ludGhldGlj'); await pending; f.replies.push(brandingReply({ version: 5 })); await f.form.emit('submit'); const payload = JSON.parse(f.calls.find(call => call.method === 'PATCH').body); assert.equal(payload.logoDataUrl, 'data:image/png;base64,c3ludGhldGlj'); assert.equal(payload.logoUrl, undefined);
  f.upload.files = [{ size: 256 * 1024 + 1, type: 'image/png' }]; await f.upload.emit('change'); assert.match(f.form.textContent, /256 KB/);
}
for (const changed of ['merchant', 'role']) {
  const f = brandingFixture('root'), pending = f.form.emit('submit'); if (changed === 'merchant') f.spec.setContext(f.second, [f.first, f.second]); else f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); await pending; assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
}
console.log('Merchant-wide name/logo scope, default previews, safe uploads and permission guards verified.');

// Each venue has its own version, palette, hero image and scoped entry path; merchant identity is read-only.
for (const role of ['adminer', 'root']) {
  const f = await appearanceFixture(role); assert.match(f.form.textContent, /Synthetic merchant.*Synthetic venue/); assert.equal(f.form.querySelectorAll('input').find(node => node.readOnly).value, 'pages/index/index?merchantId=2&venueId=11');
  assert.equal(f.dialog.querySelector('.branding-preview-identity').querySelector('h3').textContent, 'Synthetic brand'); assert.equal(f.form.querySelectorAll('input').filter(node => node.type === 'file').length, 1);
  const radio = f.form.querySelectorAll('input').find(node => node.type === 'radio' && node.value === 'forest'); radio.checked = true; await radio.emit('change'); assert.equal(f.dialog.querySelector('.branding-phone').classList.contains('branding-preview-theme-forest'), true);
  f.replies.push(appearanceReply({ theme: 'forest', version: 5 })); await f.form.emit('submit'); const request = f.calls.find(call => call.method === 'PATCH'); assert.equal(request.path, '/api/v2/rental/admin/venues/11/appearance'); assert.equal(request.headers['X-Merchant-Id'], '2'); assert.deepEqual(JSON.parse(request.body), { theme: 'forest', version: 4 }); assert.match(f.form.textContent, /景点样式已保存/);
}
{
  const f = await appearanceFixture('adminer', appearanceReply({ theme: 'aero', heroImageUrl: '', version: 0 })); assert.equal(f.dialog.querySelector('.branding-preview-product').getAttribute('src'), '/admin/assets/aero-glasses.png'); assert.equal(f.dialog.querySelector('.branding-phone').classList.contains('branding-preview-theme-aero'), true);
}
{
  const f = await appearanceFixture(), image = f.dialog.querySelector('.branding-preview-product'); assert.equal(image.getAttribute('src'), appearanceReply().appearance.heroImageUrl);
  await f.form.querySelectorAll('button').find(node => node.textContent === '恢复默认主图').emit('click'); assert.equal(f.hero.value, ''); assert.equal(image.getAttribute('src'), '/admin/assets/aero-glasses.png'); assert.match(f.dialog.querySelector('.branding-preview-state').textContent, /未保存/);
  f.replies.push(appearanceReply({ heroImageUrl: '', version: 5 })); await f.form.emit('submit'); const payload = JSON.parse(f.calls.find(call => call.method === 'PATCH').body); assert.equal(payload.heroImageUrl, ''); assert.equal(payload.logoUrl, undefined);
}
{
  const f = await appearanceFixture(), image = f.dialog.querySelector('.branding-preview-product'); f.hero.value = 'https://images.example.test/hero.webp'; await f.hero.emit('input'); assert.equal(image.getAttribute('src'), f.hero.value); await image.emit('error'); assert.equal(image.getAttribute('src'), '/admin/assets/aero-glasses.png'); await image.emit('error'); assert.equal(image.hidden, true);
  f.hero.value = 'data:image/svg+xml,test'; await f.hero.emit('input'); await f.form.emit('submit'); assert.equal(f.calls.some(call => call.method === 'PATCH'), false); assert.match(f.form.textContent, /AR 眼镜主图地址须为完整 HTTPS/);
}
{
  const f = await appearanceFixture(), data = deferred(); f.context.FileReader = class { readAsDataURL() { data.promise.then(value => { this.result = value; this.onload(); }); } }; f.upload.files = [{ size: 300 * 1024, type: 'image/webp' }]; const pending = f.upload.emit('change'); assert.equal(f.submit.disabled, true); await f.form.emit('submit'); assert.equal(f.calls.some(call => call.method === 'PATCH'), false); data.resolve('data:image/webp;base64,aGVyby1zeW50aGV0aWM='); await pending; assert.equal(f.submit.disabled, false);
  f.replies.push(appearanceReply({ version: 5 })); await f.form.emit('submit'); const payload = JSON.parse(f.calls.find(call => call.method === 'PATCH').body); assert.equal(payload.heroDataUrl, 'data:image/webp;base64,aGVyby1zeW50aGV0aWM='); assert.equal(payload.heroImageUrl, undefined); assert.equal(payload.displayName, undefined); assert.equal(payload.logoDataUrl, undefined);
}
for (const change of ['url', 'reset', 'merchant', 'role', 'close']) {
  const f = await appearanceFixture('root'), data = deferred(); f.context.FileReader = class { readAsDataURL() { data.promise.then(value => { this.result = value; this.onload(); }); } }; f.upload.files = [{ size: 20, type: 'image/jpeg' }]; const pending = f.upload.emit('change');
  if (change === 'url') { f.hero.value = 'https://images.example.test/new-hero.jpg'; await f.hero.emit('input'); } if (change === 'reset') await f.form.querySelectorAll('button').find(node => node.textContent === '撤销未保存修改').emit('click'); if (change === 'merchant') f.spec.setContext(f.second, [f.first, f.second]); if (change === 'role') f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); if (change === 'close') await f.dialog.close();
  data.resolve('data:image/jpeg;base64,c3ludGhldGlj'); await pending; assert.equal(f.hero.value, change === 'url' ? 'https://images.example.test/new-hero.jpg' : appearanceReply().appearance.heroImageUrl); assert.notEqual(f.dialog.querySelector('.branding-preview-product').getAttribute('src'), 'data:image/jpeg;base64,c3ludGhldGlj'); assert.equal(f.calls.some(call => call.method === 'PATCH'), false);
}
for (const file of [{ size: 512 * 1024 + 1, type: 'image/png' }, { size: 20, type: 'image/svg+xml' }]) { const f = await appearanceFixture(); f.upload.files = [file]; await f.upload.emit('change'); assert.match(f.form.textContent, /512 KB/); assert.equal(f.hero.value, appearanceReply().appearance.heroImageUrl); }
{
  const f = await appearanceFixture(); f.context.fetch = async path => path.endsWith('/rental/capabilities') ? { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) } : { ok: false, status: 409, json: async () => ({ message: 'Conflict' }) }; await f.form.emit('submit'); assert.match(f.form.textContent, /其他管理员修改/); assert.equal(f.form.querySelectorAll('button').find(node => node.textContent === '重新加载最新配置').hidden, false);
}
for (const change of ['merchant', 'role']) { const f = await appearanceFixture('root'), pending = f.form.emit('submit'); if (change === 'merchant') f.spec.setContext(f.second, [f.first, f.second]); else f.spec.setUser({ id: 10, role: 'manager', merchantId: 2 }); await pending; assert.equal(f.calls.some(call => call.method === 'PATCH'), false); }
// Both initial reads and save responses must stay bound to the original venue and merchant.
{
  const f = brandingFixture('root', false), response = deferred(); f.spec.setPage('venues'); f.context.fetch = async path => path.endsWith('/branding') ? { ok: true, json: async () => brandingReply() } : response.promise;
  const pending = f.spec.venueAppearanceDialog({ id: 11, merchantId: 2, name: 'Synthetic venue' }); f.spec.setContext(f.second, [f.first, f.second]); response.resolve({ ok: true, json: async () => appearanceReply() }); await pending; assert.equal(f.document.querySelector('.venue-appearance-dialog').querySelector('input'), null);
}
{
  const f = await appearanceFixture('root'), response = deferred(); f.context.fetch = async path => path.endsWith('/rental/capabilities') ? { ok: true, json: async () => ({ currentClientProtocol: 2, minClientProtocol: 2 }) } : response.promise; const pending = f.form.emit('submit'); await Promise.resolve(); await Promise.resolve(); f.spec.setContext(f.second, [f.first, f.second]); response.resolve({ ok: true, json: async () => appearanceReply({ theme: 'sunset', version: 5 }) }); await pending; assert.doesNotMatch(f.form.textContent, /景点样式已保存/);
}
for (const corrupt of [response => { response.venue.id = 12; }, response => { response.venue.merchantId = 3; }]) { const reply = appearanceReply(); corrupt(reply); const f = await appearanceFixture('root', reply); assert.match(f.form.textContent, /景点样式响应无效/); assert.equal(f.form.querySelector('input'), null); }
console.log('Venue appearance scope, default styling, safe independent hero uploads, conflicts and delayed-response isolation verified.');
