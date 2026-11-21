const API = '/api/v2';
const AUTH = '/rental/admin/auth';
const CLIENT_PROTOCOL = 2;
let clientBuild = 'admin-protocol2-dev', clientCapabilities = null, capabilitiesRequest = null;
async function requireClientProtocol() {
  if (!clientCapabilities) {
    if (!capabilitiesRequest) capabilitiesRequest = fetch(API + '/rental/capabilities', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Client-Protocol': String(CLIENT_PROTOCOL), 'X-Client-Version': clientBuild } }).then(async response => {
      if (!response.ok) throw new Error('无法核对后台版本，请刷新后重试');
      const value = await response.json();
      if (!Number.isSafeInteger(value.minClientProtocol) || !Number.isSafeInteger(value.currentClientProtocol)) throw new Error('后台版本响应无效，请刷新后重试');
      clientCapabilities = value;
    }).finally(() => { capabilitiesRequest = null; });
    await capabilitiesRequest;
  }
  if (CLIENT_PROTOCOL < clientCapabilities.minClientProtocol) { const error = new Error('当前后台需要更新，请刷新页面后重试。历史订单仍可查询。'); error.status = 426; error.code = 'CLIENT_UPGRADE_REQUIRED'; throw error; }
}
const app = document.querySelector('#app');
const state = { user: null, merchant: null, managementMerchant: null, merchants: [], merchantId: null, merchantGeneration: 0, merchantRefreshGeneration: 0, deviceVenue: { scope: '', items: [], selectedId: null }, page: 'overview', sequence: 0, timer: null, challenge: null, loginGeneration: 0, filters: { devices: { page: 1, search: '' }, orders: { page: 1, search: '', status: '' }, users: { page: 1, search: '', scope: 'employees' } } };
const deviceLabels = { AVAILABLE: ['可租赁', 'green'], RESERVED: ['待支付占用', 'amber'], RENTED: ['租赁中', 'blue'], SETTLING: ['结算中', 'amber'], DISABLED: ['已停租', ''] };
const orderLabels = { PENDING_PAYMENT: ['待支付', 'amber'], ACTIVE: ['租赁中', 'blue'], ENDED: ['已结束', 'green'], CANCELLED: ['已取消', ''], COMPENSATING: ['补偿退款中', 'amber'] };
const refundLabels = { PENDING: '待退款', PROCESSING: '退款处理中', SUCCESS: '退款成功', ABNORMAL: '退款异常', CLOSED: '退款关闭' };
const paymentLabels = { NOTPAY: '未支付', USERPAYING: '支付中', SUCCESS: '已支付', CLOSED: '已关闭', REVOKED: '已撤销', PAYERROR: '支付失败', REFUND: '转入退款' };
let dialogSequence = 0;
const pages = { overview: ['运营总览', 'OVERVIEW', '设备与租赁状态，一目了然。'], venues: ['场地', 'VENUES', '场地隶属当前商户，设备按所属场地的租金与押金收费。'], devices: ['设备管理', 'DEVICES', '设备绑定本商户场地，商户归属由场地继承；管理设备租赁开关。'], orders: ['租赁订单', 'RENTALS', '查看当前商户租赁记录及服务端确认的支付、退款状态。'], users: ['权限管理', 'ACCESS', '按当前商户及权限管理用户身份。'], merchants: ['商户管理', 'MERCHANTS', '管理商户资料及收款配置，统一使用平台小程序入口。'], branding: ['品牌设置', 'BRANDING', '设置本商户通用的小程序显示名称与 Logo。'] };
const roles = {
  user: { label: '普通用户', rank: 0, description: '可以租赁设备、查询自己的订单与退款进度，不能管理设备或办理退款。' },
  manager: { label: '设备管理员', rank: 1, description: '可在所属商户选择景点并查看该景点设备；在小程序管理设备、确认归还及退款。' },
  adminer: { label: '商户管理员', rank: 2, description: '管理所属商户的设备和业务，可在普通用户与设备管理员之间变更身份；不能修改商户管理员或 ROOT。' },
  root: { label: 'ROOT · 超级管理员', rank: 3, description: '最高管理权限，可将其他非 ROOT 账号设为普通用户、设备管理员或商户管理员。ROOT 身份仅由指定手机号验证确认，此页面不能授予或修改。' },
};
const roleLabel = role => (Object.hasOwn(roles, role) ? roles[role] : roles.user).label;
const canUseAdmin = role => ['manager', 'adminer', 'root'].includes(role);
const canManageUsers = role => ['adminer', 'root'].includes(role);
const canManageVenues = role => ['adminer', 'root'].includes(role);
const canManageBranding = role => ['adminer', 'root'].includes(role);
const canEditDeviceRemark = role => ['adminer', 'root'].includes(role);
const brandingThemes = { aero: ['晴空蓝', '清爽明亮，轻盈科技感'], forest: ['森林绿', '自然安静，适合户外场景'], sunset: ['落日橙', '温暖活力，适合文旅体验'], ink: ['曜石黑', '深色界面，简洁沉稳'] };
function canOpenPage(page) { return Boolean(pages[page]) && (page !== 'users' || canManageUsers(state.user?.role)) && (page !== 'branding' || canManageBranding(state.user?.role)); }
function managementMerchantId() {
  const value = state.user?.role === 'root' ? state.merchantId : ['manager', 'adminer'].includes(state.user?.role) ? state.managementMerchant?.id ?? state.user.merchantId : null;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function managementMerchant() {
  const id = managementMerchantId(); if (!id) return null;
  if (state.user?.role !== 'root' && state.managementMerchant?.id === id) return state.managementMerchant;
  const listed = state.merchants.find(value => value.id === id);
  return listed || (state.merchant?.id === id && (!state.merchants.length || state.user?.role !== 'root') ? state.merchant : null);
}
function merchantLabel(merchant) { return (merchant.name || '商户 #' + merchant.id) + '（' + (merchant.code ? merchant.code + ' / ' : '') + 'ID ' + merchant.id + '）'; }
function deviceContextScope() { return state.user ? [state.user.id, state.user.role, state.user.authVersion ?? state.user.auth_version ?? '', managementMerchantId(), state.loginGeneration, state.merchantGeneration].join(':') : ''; }
function managerDeviceScope() { return state.user?.role === 'manager' ? deviceContextScope() : ''; }
function managerDeviceVenue() {
  return state.deviceVenue.scope === managerDeviceScope() ? state.deviceVenue.items.find(venue => venue.id === state.deviceVenue.selectedId) || null : null;
}
function renderManagerVenuePrompt(content) {
  const card = el('div', 'card'), empty = el('div', 'empty');
  card.append(renderToolbar('devices', { total: 0 }));
  append(empty, el('h3', '', state.deviceVenue.items.length ? '请选择当前景点' : '当前商户暂无景点'), el('p', '', state.deviceVenue.items.length ? '选择后仅显示该景点的设备，可随时切换当前商户下的其他景点。' : '请由商户管理员先创建景点，再管理该景点的设备。'));
  card.append(empty); content.replaceChildren(card);
}
function merchantParentTitle() { return state.user?.role === 'root' ? '商户管理' : '我的商户'; }
function applyManagementSession(session) {
  state.user = session.user;
  // Root has no staff membership; the session merchant is the entry's default scope.
  const merchant = session.user.role === 'root' ? session.merchant : Object.hasOwn(session, 'managementMerchant') ? session.managementMerchant : session.merchant;
  state.managementMerchant = session.user.role === 'root' ? null : merchant || null;
  state.merchant = merchant || null; state.merchantId = merchant?.id || null; state.merchantGeneration++;
}
function selectManagementMerchant(merchant) {
  if (state.user?.role !== 'root' || !state.merchants.some(value => value.id === merchant?.id) || !Number.isSafeInteger(merchant?.id) || merchant.id < 1) return false;
  state.sequence++; state.merchantGeneration++;
  document.querySelectorAll('dialog').forEach(dialog => dialog.close());
  state.merchant = merchant; state.merchantId = merchant.id;
  for (const filters of Object.values(state.filters)) filters.page = 1;
  renderMerchantContext(); return true;
}
function openMerchantVenues(merchant = managementMerchant()) {
  if (state.user?.role === 'root') { if (!selectManagementMerchant(merchant)) { toast('请先选择场地所属商户'); return; } }
  else if (!managementMerchant() || merchant?.id !== managementMerchantId()) { toast('只能查看自己所属商户的场地'); return; }
  navigate('venues');
}
function assignableRoles(actor, target) {
  if (!actor || !target || String(actor.id) === String(target.id) || target.role === 'root' || !Object.hasOwn(roles, target.role)) return [];
  const allowed = actor.role === 'root' ? ['user', 'manager', 'adminer'] : actor.role === 'adminer' && ['user', 'manager'].includes(target.role) ? ['user', 'manager'] : [];
  return Array.isArray(target.allowedRoles) ? allowed.filter(role => target.allowedRoles.includes(role)) : allowed;
}
const money = cents => Number.isSafeInteger(Number(cents)) ? (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const time = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'; };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
function icon(name, tone = 'muted', className = '') { const node = el('img', 'icon ' + className); node.src = '/admin/assets/icons/' + name + '-' + tone + '.svg'; node.alt = ''; node.setAttribute('aria-hidden', 'true'); node.width = node.height = 20; return node; }
function button(label, action, className = '', iconName) { const node = el('button', className); node.type = 'button'; if (iconName) node.append(icon(iconName, className.includes('secondary') || className.includes('text-button') ? 'blue' : 'white')); node.append(el('span', '', label)); if (action) node.addEventListener('click', action); return node; }
function append(parent, ...nodes) { for (const node of nodes) if (node) parent.append(node); return parent; }
function badge(value, labels) { const pair = labels[value] || [value || '—', '']; return el('span', 'status ' + pair[1], pair[0]); }
function textCell(primary, secondary) { const cell = el('td'); append(cell, el('div', 'cell-main', primary)); if (secondary) append(cell, el('div', 'cell-sub', secondary)); return cell; }
function userAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return '';
  if (/^\/api\/v2\/rental\/profile\/avatars\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : '';
  } catch { return ''; }
}
function userAvatar(user, className = '') {
  const node = el('span', 'user-avatar ' + className); node.setAttribute('aria-hidden', 'true'); node.append(icon('user'));
  const source = userAvatarUrl(user.avatar);
  if (source) {
    const image = el('img', 'user-avatar-image'); image.alt = ''; image.width = image.height = 36; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true }); image.setAttribute('src', source); node.append(image);
  }
  return node;
}
function userCell(user) {
  const cell = el('td'), identity = el('div', 'user-identity'), copy = el('div', 'user-copy');
  const name = el('div', 'cell-main', userName(user)); name.title = name.textContent;
  append(copy, name, el('div', 'cell-sub', 'ID ' + user.id)); append(identity, userAvatar(user), copy); cell.append(identity); return cell;
}
function message(text, className = 'error') { const node = el('div', className, text); node.setAttribute('role', 'alert'); return node; }
function toast(text) { document.querySelector('.toast')?.remove(); const node = el('div', 'toast', text); node.setAttribute('role', 'status'); document.body.append(node); setTimeout(() => node.remove(), 4500); }
function stopPolling() { clearTimeout(state.timer); state.timer = null; }
async function api(path, options = {}) {
  if (options.method && options.method !== 'GET' && !path.startsWith(AUTH)) await requireClientProtocol();
  const { beforeDispatch, ...requestOptions } = options;
  if (beforeDispatch) beforeDispatch();
  let response;
    try { response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', ...requestOptions, headers: { Accept: 'application/json', 'X-Client-Protocol': String(CLIENT_PROTOCOL), 'X-Client-Version': clientBuild, ...(options.method ? { 'Content-Type': 'application/json' } : {}), ...(managementMerchantId() && !path.startsWith(AUTH) && !path.startsWith('/rental/admin/merchants') ? { 'X-Merchant-Id': String(managementMerchantId()) } : {}), ...options.headers } }); }
  catch { throw new Error('网络连接失败，请检查网络后重试'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('服务响应无效，请稍后重试'); }
  if (!response.ok) {
    const error = new Error(data.message || '操作未完成，请稍后重试');
    error.status = response.status;
    error.code = data.code || '';
    if (data.code === 'CLIENT_UPGRADE_REQUIRED') clientCapabilities = { minClientProtocol: data.minClientProtocol || CLIENT_PROTOCOL + 1, currentClientProtocol: data.currentClientProtocol || CLIENT_PROTOCOL + 1 };
    if (response.status === 401 && state.user) {
      state.user = null;
      document.querySelectorAll('dialog').forEach(dialog => dialog.close());
      showLogin('登录已过期，请重新扫码登录');
    }
    throw error;
  }
  return data;
}
const write = (path, body = {}, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
function brand() {
  const node = el('div', 'brand');
  const label = el('div');
  append(label, el('div', 'brand-name', 'AR设备租赁'), el('small', '', 'RENTAL CONSOLE'));
  return append(node, el('div', 'brand-mark', 'AR'), label);
}
async function boot() {
  stopPolling();
  state.loginGeneration++;
  app.replaceChildren(el('div', 'boot', '正在连接管理后台…'));
  fetch('/admin/version.json', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(value => { if (/^[a-f0-9]{40}$/.test(value?.gitCommit || '')) clientBuild = value.gitCommit; }).catch(() => {});
  requireClientProtocol().catch(error => toast(error.message));
  try {
    const result = await api(AUTH + '/session');
    if (!result.user || !canUseAdmin(result.user.role)) throw new Error('当前账号没有管理权限');
    applyManagementSession(result);
    shell();
  } catch (error) {
    if (error.status === 401) return showLogin();
    if (error.status === 403) return showLogin(error.message || '请使用已授权的微信账号重新扫码');
    const outer = el('div', 'boot');
    const box = el('div', 'session-error');
    append(box, el('h2', '', '暂时无法连接管理后台'), el('p', '', error.message), button('重新连接', boot));
    append(outer, box); app.replaceChildren(outer);
  }
}
function showLogin(reason = '') {
  document.title = '微信扫码登录 · AR设备租赁';
  state.user = null; state.merchant = null; state.managementMerchant = null; state.merchantId = null; state.merchants = []; state.merchantGeneration++; state.sequence++; stopPolling();
  const generation = ++state.loginGeneration;
  const login = el('main', 'login');
  const story = el('section', 'login-story');
  const intro = el('div', 'login-message');
  const title = el('h1'); append(title, document.createTextNode('让每一台设备，'), el('br'), document.createTextNode('有序流转。'));
  const features = el('div', 'login-features'); for (const label of ['设备配置', '租赁记录', '权限管理']) append(features, append(el('span'), icon('check', 'blue'), document.createTextNode(label)));
  const product = el('img', 'login-product'); product.src = '/admin/assets/aero-glasses.png'; product.alt = 'AR 智能眼镜'; product.width = 1881; product.height = 836;
  append(intro, el('div', 'eyebrow', 'AR RENTAL · MANAGEMENT'), title, el('p', '', '连接设备、租赁与运营。\n在一个清晰的工作台，掌握业务当前状态。'), product, features);
  append(story, brand(), intro, el('div', 'login-foot', 'AR设备租赁  /  管理工作台'));
  const side = el('section', 'login-side');
  const card = el('div', 'login-card');
  const qrFrame = el('div', 'qr-frame');
  const fallback = el('div', 'qr-fallback');
  const spinner = el('span', 'spin'); append(fallback, spinner, el('span', '', '正在生成微信小程序码…'));
  const image = el('img'); image.alt = '使用微信扫一扫，进入AR设备租赁小程序确认登录'; image.hidden = true;
  append(qrFrame, fallback, image);
  const status = el('p', 'qr-status', '使用微信扫一扫，在手机上确认登录'); status.setAttribute('role', 'status');
  const code = el('div', 'confirmation-code'); code.hidden = true;
  const refresh = button('刷新二维码', () => startChallenge(generation, controls), 'text-button'); refresh.disabled = true;
  const errorBox = message(reason, 'error login-error');
  append(card, el('h2', '', '微信扫码登录'), el('p', 'muted', '使用已授权的管理员微信账号'), qrFrame, status, code, refresh, errorBox, el('p', 'login-help', '扫码后在小程序确认手机号，再核对两端确认码。\n首次使用需完成管理员授权。'));
  append(side, card); append(login, story, side); app.replaceChildren(login);
  const controls = { image, fallback, status, code, refresh, errorBox };
  startChallenge(generation, controls);
}
async function startChallenge(generation, ui) {
  if (generation !== state.loginGeneration) return;
  stopPolling();
  const attempt = Symbol('challenge'); state.challenge = attempt;
  ui.refresh.disabled = true; ui.errorBox.textContent = ''; ui.image.hidden = true; ui.image.removeAttribute('src'); ui.fallback.hidden = false;
  ui.fallback.replaceChildren(el('span', 'spin'), el('span', '', '正在生成微信小程序码…'));
  ui.status.textContent = '使用微信扫一扫，在手机上确认登录'; ui.code.hidden = true;
  const current = () => generation === state.loginGeneration && state.challenge === attempt;
  try {
    const result = await write(AUTH + '/challenges');
    if (!current()) return;
    if (typeof result.id !== 'string' || !/^[a-f0-9]{32}$/.test(result.id) || typeof result.qrcodeUrl !== 'string') throw new Error('登录二维码响应无效，请重试');
    const url = new URL(result.qrcodeUrl, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith(API + AUTH + '/challenges/')) throw new Error('登录二维码地址无效');
    ui.code.replaceChildren(el('span', '', '登录确认码'), el('strong', '', result.confirmationCode || '—')); ui.code.hidden = false;
    ui.image.onload = () => {
      if (!current()) return;
      ui.image.hidden = false; ui.fallback.hidden = true; ui.refresh.disabled = false;
      pollChallenge(result, current, ui);
    };
    ui.image.onerror = () => {
      if (!current()) return;
      ui.fallback.replaceChildren(el('span', '', '二维码暂时无法生成')); ui.image.hidden = true; ui.refresh.disabled = false;
      ui.errorBox.textContent = '请确认微信服务和小程序发布状态，或刷新重试'; ui.status.textContent = '二维码加载失败';
    };
    ui.image.src = url.href;
  } catch (error) {
    if (!current()) return;
    ui.fallback.replaceChildren(el('span', '', '暂时无法生成登录码')); ui.errorBox.textContent = error.message; ui.refresh.disabled = false; ui.status.textContent = '请刷新二维码重试';
  }
}
function completeLogin(session, current) {
  if (!current()) return;
  if (!session.user || !canUseAdmin(session.user.role)) throw new Error('当前账号没有管理权限');
  applyManagementSession(session); stopPolling(); state.loginGeneration++; shell();
}
async function recoverLogin(current) {
  let session;
  try { session = await api(AUTH + '/session'); }
  catch (error) {
    if (error.status === 401 || error.status === 403) return false;
    throw new Error('暂时无法确认登录状态，请刷新页面重新连接');
  }
  if (!current()) return true;
  completeLogin(session, current);
  return true;
}
async function pollChallenge(challenge, current, ui) {
  if (!current()) return;
  if (Date.parse(challenge.expiresAt) <= Date.now()) { ui.status.textContent = '二维码已过期，请刷新'; ui.image.hidden = true; ui.fallback.replaceChildren(el('span', '', '二维码已过期')); ui.fallback.hidden = false; return; }
  try {
    const result = await api(AUTH + '/challenges/' + encodeURIComponent(challenge.id));
    if (!current()) return;
    if (result.status === 'confirmed') {
      ui.status.textContent = '已确认，正在安全登录…'; ui.refresh.disabled = true;
      try {
        const session = await write(AUTH + '/challenges/' + encodeURIComponent(challenge.id) + '/consume');
        return completeLogin(session, current);
      } catch (error) {
        if (!current()) return;
        // A lost response or another tab may have already established the cookie.
        // Read the session once; never retry this one-time consume operation.
        if (await recoverLogin(current)) return;
        throw error;
      }
    }
    if (result.status === 'consumed' && await recoverLogin(current)) return;
    if (!current()) return;
    if (['cancelled', 'expired', 'consumed'].includes(result.status)) {
      ui.status.textContent = result.status === 'cancelled' ? '手机已取消登录，请刷新二维码' : '二维码已失效，请刷新';
      ui.image.hidden = true; ui.fallback.hidden = false; ui.fallback.replaceChildren(el('span', '', ui.status.textContent)); ui.refresh.disabled = false; return;
    }
    ui.status.textContent = result.status === 'scanned' ? '已扫码，请在手机上核对确认码并确认' : '使用微信扫一扫，在手机上确认登录';
    state.timer = setTimeout(() => pollChallenge(challenge, current, ui), 3000);
  } catch (error) {
    if (!current()) return;
    ui.errorBox.textContent = error.message; ui.status.textContent = '登录状态暂时不可用，请刷新重试'; ui.refresh.disabled = false;
  }
}
function shell() {
  state.loginGeneration++; stopPolling();
  const shellNode = el('div', 'shell');
  const sidebar = el('aside', 'sidebar');
  const nav = el('nav', 'nav'); nav.setAttribute('aria-label', '管理后台导航');
  const navLink = (key, name, label = pages[key][0]) => {
    const link = el('a', 'nav-link'); link.href = '#' + key; link.dataset.page = key;
    const image = icon(name, 'white', 'nav-icon'); image.dataset.icon = name;
    append(link, image, el('span', '', label));
    link.addEventListener('click', event => {
      event.preventDefault();
      if (key === 'venues' && !managementMerchant()) { toast('请先选择场地所属商户'); navigate('merchants'); return; }
      navigate(key);
    }); return link;
  };
  for (const [key, name] of [['overview', 'home'], ['devices', 'cube'], ['orders', 'clipboard'], ['users', 'shield']]) {
    if (key === 'users' && !canManageUsers(state.user.role)) continue;
    nav.append(navLink(key, name));
  }
  const merchantGroup = el('div', 'nav-group'); merchantGroup.setAttribute('aria-label', merchantParentTitle());
  const merchantLink = navLink('merchants', 'settings', merchantParentTitle()); merchantLink.classList.add('nav-parent');
  const subnav = el('div', 'subnav'); subnav.setAttribute('aria-label', merchantParentTitle() + '子导航');
  const venuesLink = navLink('venues', 'chevron-right', '场地'); venuesLink.classList.add('venue-nav'); venuesLink.dataset.parent = 'merchants';
  append(subnav, el('span', 'nav-merchant-scope'), venuesLink);
  if (canManageBranding(state.user.role)) { const link = navLink('branding', 'settings', '品牌设置'); link.classList.add('venue-nav'); subnav.append(link); }
  append(merchantGroup, merchantLink, subnav); nav.append(merchantGroup);
  const sidebarFoot = el('div', 'sidebar-foot'); append(sidebarFoot, icon('shield', 'white'), el('span', '', roleLabel(state.user.role)));
  append(sidebar, brand(), el('div', 'nav-label', '管理工作台'), nav, sidebarFoot);
  const work = el('div', 'workspace');
  const top = el('header', 'topbar');
  const crumb = el('div', 'topbar-title'); append(crumb, el('span', 'topbar-brand', 'AR设备租赁'), el('strong', 'breadcrumb', '运营总览'));
  const account = el('div', 'account');
  const date = el('time', 'topbar-date', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())); date.dateTime = date.textContent;
  const accountName = el('div', 'account-name');
  append(accountName, el('div', '', state.user.nickname || '管理员 #' + state.user.id), el('div', '', roleLabel(state.user.role)));
  const merchantContext = el('div', 'merchant-context'); merchantContext.id = 'merchant-context';
  append(account, merchantContext, date, userAvatar(state.user, 'account-avatar'), accountName, button('退出', logout, 'text-button', 'logout'));
  const main = el('main', 'content'); main.id = 'main-content';
  append(top, crumb, account); append(work, top, main); append(shellNode, sidebar, work); app.replaceChildren(shellNode);
  const requested = location.hash.slice(1);
  state.page = canOpenPage(requested) ? requested : 'overview';
  renderMerchantContext();
  if (state.user.role === 'root') refreshMerchants().catch(() => { if (state.user) toast('商户列表暂时无法加载，请在商户管理中重试'); });
  loadPage();
}
async function logout(event) {
  const target = event?.currentTarget; if (target) target.disabled = true;
  try { await write(AUTH + '/logout'); showLogin('已安全退出'); }
  catch (error) { if (state.user) toast(error.message); }
  finally { if (target) target.disabled = false; }
}
window.addEventListener('hashchange', () => {
  if (!state.user) return;
  const page = location.hash.slice(1);
  if (canOpenPage(page)) { state.page = page; return loadPage(); }
});
function navigate(page) { if (!canOpenPage(page)) return; if (location.hash === '#' + page) { state.page = page; loadPage(); } else location.hash = page; }
function heading(page) {
  const node = el('div', 'page-heading' + (page === 'devices' ? ' device-hero' : ''));
  const scope = managementMerchant();
  const title = page === 'merchants' ? merchantParentTitle() : page === 'venues' ? (scope ? scope.name || '商户 #' + scope.id : '请选择商户') + ' / 场地' : pages[page][0];
  const text = el('div'); append(text, el('h1', '', title), el('p', '', pages[page][2])); node.append(text);
  if (page === 'devices') {
    const product = el('img', 'device-hero-image'); product.src = '/admin/assets/aero-glasses.png'; product.alt = 'AR 智能眼镜'; product.width = 1881; product.height = 836; node.append(product);
  } else if (page === 'merchants' && state.user.role === 'root') node.append(button('新建商户', () => merchantDialog(), '', 'plus'));
  else if (page === 'venues' || page === 'branding') {
    const actions = el('div', 'page-heading-actions');
    actions.append(button(state.user.role === 'root' ? '返回商户列表' : '返回我的商户', () => navigate('merchants'), 'secondary', 'arrow-left'));
    if (page === 'venues' && scope && canManageVenues(state.user.role)) actions.append(button('新建场地', () => venueDialog(), '', 'plus'));
    if (page === 'branding' && scope) actions.append(button('重新加载', () => loadPage(), 'secondary', 'refresh'));
    node.append(actions);
  } else node.append(button('刷新数据', () => loadPage(), 'secondary', 'refresh'));
  return node;
}
function renderPageBreadcrumb(page) {
  const breadcrumb = document.querySelector('.breadcrumb'); if (!breadcrumb) return;
  if (!['venues', 'branding'].includes(page)) { breadcrumb.textContent = page === 'merchants' ? merchantParentTitle() : pages[page][0]; return; }
  const parent = el('a', '', merchantParentTitle()); parent.href = '#merchants';
  parent.addEventListener('click', event => { event.preventDefault(); navigate('merchants'); });
  breadcrumb.replaceChildren(parent, document.createTextNode(' / ' + (managementMerchant()?.name || '请选择商户') + ' / ' + pages[page][0]));
}

async function loadPage() {
  if (!state.user) return;
  if (!canOpenPage(state.page)) state.page = 'overview';
  const page = state.page;
  const sequence = ++state.sequence;
  const selectedMerchantId = managementMerchantId();
  const deviceScope = page === 'devices' ? deviceContextScope() : '';
  const currentDevices = () => sequence === state.sequence && deviceScope && deviceScope === deviceContextScope();
  const managerScope = page === 'devices' ? managerDeviceScope() : '';
  const currentManagerDevices = () => currentDevices() && managerScope && managerScope === managerDeviceScope();
  const main = document.querySelector('#main-content'); if (!main) return;
  for (const link of document.querySelectorAll('.nav a')) {
    link.classList.toggle('active', link.dataset.page === page || link.classList.contains('nav-parent') && ['venues', 'branding'].includes(page));
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    const image = link.querySelector('.nav-icon'); if (image) image.src = '/admin/assets/icons/' + image.dataset.icon + '-white.svg';
  }
  renderPageBreadcrumb(page); document.title = (page === 'venues' ? merchantParentTitle() + ' / ' + merchantName() + ' / 场地' : page === 'merchants' ? merchantParentTitle() : pages[page][0]) + ' · AR设备租赁';
  const content = el('section'); content.setAttribute('aria-label', pages[page][0]);
  const loading = el('div', 'loading'); loading.setAttribute('role', 'status'); append(loading, el('span', 'spin'), document.createTextNode('正在加载数据…'));
  main.replaceChildren(heading(page), content); content.append(loading);
  if (page !== 'merchants' && !managementMerchant()) { content.replaceChildren(el('p', 'notice', '请先选择所属商户；场地与设备必须在商户下管理。'), button('前往' + merchantParentTitle(), () => navigate('merchants'), 'secondary')); return; }
  try {
    if (page === 'merchants') {
      if (state.user.role === 'root') await refreshMerchants();
      if (sequence === state.sequence && state.user) renderMerchants(content);
    } else if (page === 'venues') {
      const result = await api('/rental/admin/venues', { headers: { 'X-Merchant-Id': String(selectedMerchantId) } });
      if (sequence === state.sequence && state.user && selectedMerchantId === managementMerchantId()) renderVenues(content, result);
    } else if (page === 'branding') {
      const scope = deviceContextScope();
      const result = await api('/rental/admin/branding', { headers: { 'X-Merchant-Id': String(selectedMerchantId) } });
      if (sequence === state.sequence && state.user && scope === deviceContextScope() && canManageBranding(state.user.role)) renderBranding(content, result);
    } else if (page === 'overview') {
      const result = await api('/rental/admin/overview');
      if (sequence === state.sequence && result.merchant && result.merchant.id !== selectedMerchantId) throw new Error('商户范围已变化，请重新选择后加载');
      if (sequence === state.sequence && result.merchant) { state.merchant = result.merchant; state.merchantId = result.merchant.id; renderMerchantContext(); }
      if (sequence === state.sequence && state.user) renderOverview(content, result);
    } else if (page === 'devices' && managerScope) {
      if (state.deviceVenue.scope !== managerScope) {
        state.deviceVenue = { scope: managerScope, items: [], selectedId: null };
        state.filters.devices.page = 1;
      }
      const venues = await api('/rental/admin/venues', { headers: { 'X-Merchant-Id': String(selectedMerchantId) } });
      if (!currentManagerDevices()) return;
      if (!Array.isArray(venues.items) || venues.items.some(venue => !Number.isSafeInteger(venue.id) || venue.id < 1 || venue.merchantId !== selectedMerchantId || !['active', 'paused'].includes(venue.status))) throw new Error('景点列表暂时不可用，请重新加载');
      state.deviceVenue.items = venues.items;
      if (!managerDeviceVenue()) { state.deviceVenue.selectedId = venues.items.length === 1 ? venues.items[0].id : null; state.filters.devices.page = 1; }
      const venue = managerDeviceVenue();
      if (!venue) { renderManagerVenuePrompt(content); return; }
      const query = new URLSearchParams({ ...state.filters.devices, venueId: String(venue.id), 'per-page': '20' });
      const result = await api('/rental/admin/devices?' + query, { headers: { 'X-Merchant-Id': String(selectedMerchantId) } });
      if (!currentManagerDevices() || managerDeviceVenue()?.id !== venue.id) return;
      if (!Array.isArray(result.items) || result.items.some(item => (item.device?.venueId ?? item.venue?.id) !== venue.id)) throw new Error('设备景点范围已变化，请重新加载');
      renderList(content, page, result, null);
    } else {
      const filters = state.filters[page]; const query = new URLSearchParams({ ...filters, 'per-page': '20' });
      const [result, snapshot] = await Promise.all([api('/rental/admin/' + page + '?' + query), page === 'devices' ? api('/rental/admin/overview').catch(() => null) : Promise.resolve(null)]);
      if (sequence === state.sequence && state.user && (page !== 'devices' || currentDevices())) renderList(content, page, result, snapshot);
    }
  } catch (error) {
    if (sequence !== state.sequence || !state.user || page === 'devices' && !currentDevices()) return;
    const empty = el('div', 'empty card'); append(empty, el('h3', '', '数据暂时无法加载'), el('p', '', error.message), button('重新加载', () => loadPage(), 'secondary')); content.replaceChildren(empty);
  }
}
function renderOverview(content, data) {
  const devices = data.devices || {}, orders = data.orders || {};
  const metrics = el('div', 'metrics');
  for (const [label, value, foot] of [['设备总数', devices.total, '已登记的全部设备'], ['租赁中', devices.rented, '正在使用的设备'], ['可租赁', devices.available, '已开放且当前空闲'], ['租赁订单', orders.total, '全部历史租赁记录']]) {
    const metric = el('div', 'metric'); append(metric, el('div', 'metric-label', label), el('div', 'metric-value', value ?? '—'), el('div', 'metric-foot', foot)); metrics.append(metric);
  }
  const grid = el('div', 'overview-grid');
  const statusCard = el('section', 'card'); append(statusCard, append(el('div', 'card-heading'), el('h2', '', '设备状态'), el('span', 'snapshot-label', '本次查询')));
  const list = el('div', 'state-list card-body');
  for (const [key, value] of [['AVAILABLE', devices.available], ['RENTED', devices.rented], ['RESERVED', devices.reserved], ['SETTLING', devices.settling], ['DISABLED', devices.disabled]]) append(list, append(el('div', 'state-row'), badge(key, deviceLabels), el('strong', '', value ?? '—')));
  statusCard.append(list);
  const quick = el('section', 'card'); append(quick, append(el('div', 'card-heading'), el('h2', '', '管理入口')));
  const quickBody = el('div', 'card-body');
  for (const [title, description, page] of [['场地与收费', '查看场地信息、租金与押金。', 'venues'], ['设备与场地', '绑定设备场地、管理租赁开关。', 'devices'], ['租赁记录', '查看租赁详情与支付、退款进度。', 'orders'], ...(canManageUsers(state.user.role) ? [['用户身份与授权', '在当前权限范围内管理用户身份。', 'users']] : [])]) {
    const copy = el('div'); append(copy, el('h3', '', title), el('p', '', description));
    append(quickBody, append(el('div', 'shortcut'), copy, button('查看', () => navigate(page), 'text-button', 'chevron-right')));
  }
  const refunds = el('div', 'refund-summary');
  const refundsCopy = el('div');
  append(refundsCopy, el('h3', '', '待完成退款'), el('p', '', '尚未确认退款成功的订单'));
  append(refunds, refundsCopy, el('strong', '', String(orders.refunding ?? '—') + ' 笔'));
  append(quickBody, refunds, el('div', 'notice', data.paymentsEnabled ? '微信支付已启用。订单和退款状态以服务端确认结果为准。' : '微信支付当前未开放。设备管理可正常使用，租赁支付暂不可用。'));
  quick.append(quickBody); append(grid, statusCard, quick);
  content.replaceChildren(metrics, grid, el('p', 'footer-note', '状态为本次查询结果。退款未结算的设备会保持占用；办理归还与退款请使用小程序管理页面。'));
}
function renderToolbar(page, result) {
  const bar = el('div', 'toolbar'); const form = el('form', 'search-form'); form.setAttribute('role', 'search');
  const search = el('input'); search.type = 'search'; search.maxLength = 100; search.value = state.filters[page].search;
  search.placeholder = page === 'devices' ? '搜索设备' : page === 'orders' ? '搜索订单编号、设备名称或 UUID' : '搜索手机号或昵称';
  search.setAttribute('aria-label', page === 'devices' ? '搜索设备名称、备注或 UUID' : search.placeholder);
  const searchField = el('div', 'search-field'); append(searchField, icon('search'), search);
  const submit = button('搜索', null, 'secondary'); submit.type = 'submit'; append(form, searchField, submit);
  form.addEventListener('submit', event => { event.preventDefault(); state.filters[page].search = search.value.trim(); state.filters[page].page = 1; loadPage(); });
  bar.append(form);
  if (page === 'devices' && state.user.role === 'manager') {
    const scope = managerDeviceScope(), venue = el('select'); venue.setAttribute('aria-label', '选择当前景点');
    const placeholder = el('option', '', state.deviceVenue.items.length ? '请选择当前景点' : '当前商户暂无景点'); placeholder.value = ''; venue.append(placeholder);
    for (const value of state.deviceVenue.items) { const option = el('option', '', value.name + (value.status === 'paused' ? '（已暂停）' : '')); option.value = String(value.id); venue.append(option); }
    venue.value = managerDeviceVenue() ? String(state.deviceVenue.selectedId) : ''; venue.disabled = !state.deviceVenue.items.length;
    venue.addEventListener('change', async () => {
      if (!scope || scope !== managerDeviceScope() || state.page !== 'devices') return;
      const id = Number(venue.value);
      state.deviceVenue.selectedId = state.deviceVenue.items.some(value => value.id === id) ? id : null;
      state.filters.devices.page = 1;
      await loadPage();
    });
    bar.append(venue);
  }
  if (page === 'orders') {
    const select = el('select'); select.setAttribute('aria-label', '筛选订单状态');
    for (const [value, label] of [['', '全部订单状态'], ...Object.entries(orderLabels).map(([value, pair]) => [value, pair[0]])]) {
      const option = el('option', '', label); option.value = value; select.append(option);
    }
    select.value = state.filters.orders.status;
    select.addEventListener('change', () => { state.filters.orders.status = select.value; state.filters.orders.page = 1; loadPage(); }); bar.append(select);
  }
  if (page === 'users' && state.user.role === 'root') {
    const scope = el('select'); scope.setAttribute('aria-label', '用户管理范围');
    for (const [value, label] of [['employees', '本商户员工'], ['platform', '未分配商户的消费者']]) { const option = el('option', '', label); option.value = value; scope.append(option); }
    scope.value = state.filters.users.scope || 'employees'; scope.addEventListener('change', () => { state.filters.users.scope = scope.value; state.filters.users.page = 1; loadPage(); }); bar.append(scope);
  }
  if (page === 'devices') { const create = button('登记设备', createDeviceDialog, '', 'plus'); create.disabled = state.user.role === 'manager' && !managerDeviceVenue(); bar.append(create); }
  else bar.append(el('span', 'muted', '共 ' + Number(result.total || 0) + ' 条记录'));
  return bar;
}
function deviceSummary(snapshot) {
  const group = el('section', 'device-summary'); group.setAttribute('aria-label', '本次查询设备统计');
  const list = el('dl', 'summary-strip');
  for (const [label, key] of [['总设备', 'total'], ['可租', 'available'], ['租赁中', 'rented'], ['结算中', 'settling']]) append(list, append(el('div', 'summary-item'), el('dt', '', label), el('dd', '', snapshot?.devices?.[key] ?? '—')));
  const note = el('div', 'snapshot-label', snapshot ? '本次查询 · ' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()) : '统计暂时不可用');
  return append(group, list, note);
}
function renderList(content, page, result, snapshot) {
  if (!Array.isArray(result.items)) throw new Error('列表响应格式无效');
  const card = el('div', 'card'); card.append(renderToolbar(page, result));
  if (result.items.length) {
    const hint = append(el('div', 'table-scroll-hint'), document.createTextNode('左右滑动查看完整信息'), icon('chevron-right'));
    hint.id = 'table-scroll-hint-' + page;
    const wrap = el('div', 'table-wrap ' + page + '-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', pages[page][0] + '表格'); wrap.setAttribute('aria-describedby', hint.id);
    const table = el('table'); table.setAttribute('aria-label', pages[page][0]);
    const thead = el('thead'), tr = el('tr');
    for (const label of page === 'devices' ? ['设备', '设备型号', '所属场地', '租赁状态', '场地租金', '场地押金', '操作'] : page === 'orders' ? ['订单 / 设备 / 场地', '租赁状态', '订单金额', '退款状态', '创建时间', '操作'] : ['用户', '手机号', '当前身份', '操作']) { const th = el('th', '', label); th.scope = 'col'; tr.append(th); }
    thead.append(tr); const body = el('tbody');
    for (const item of result.items) body.append(page === 'devices' ? deviceRow(item) : page === 'orders' ? orderRow(item) : userRow(item));
    append(table, thead, body); append(wrap, table); append(card, hint, wrap);
  } else {
    const empty = el('div', 'empty');
    append(empty, icon(page === 'devices' ? 'cube' : page === 'orders' ? 'clipboard' : 'user', 'muted', 'empty-symbol'), el('h3', '', state.filters[page].search || state.filters[page].status ? '没有找到匹配的记录' : page === 'devices' ? '尚未登记设备' : page === 'orders' ? '暂无租赁订单' : '暂无可管理的用户'), el('p', '', page === 'devices' ? '先创建场地并设置租金、押金，再登记设备并绑定场地。' : '新的记录会在这里显示。'));
    if (page === 'devices' && !state.filters.devices.search) empty.append(button('登记第一台设备', createDeviceDialog, 'secondary'));
    card.append(empty);
  }
  card.append(pagination(page, result));
  const deviceScope = state.user.role === 'manager' ? el('p', 'notice', '当前景点：' + (managerDeviceVenue()?.name || '未选择') + ' · 本次查询 ' + Number(result.total || 0) + ' 台设备') : deviceSummary(snapshot);
  content.replaceChildren(...(page === 'devices' ? [deviceScope, card] : [card]));
  if (page === 'orders') content.append(el('p', 'footer-note', '此处仅查看订单。办理归还、退款和异常处理请使用小程序；支付与退款状态以服务端校验为准。'));
  if (page === 'users') content.append(el('p', 'footer-note', (state.user.role === 'root' ? '你可以将其他非 ROOT 账号设为普通用户、设备管理员或商户管理员。' : '你只能在普通用户与设备管理员之间变更身份；同级商户管理员与 ROOT 受保护。') + '当前账号不能修改自己的身份。普通用户无设备管理及退款权限，降级后的后续请求按最新身份校验。'));
}
function pagination(page, result) {
  const row = el('div', 'pagination'); const number = Number(result.page || 1), size = Number(result.pageSize || 20), total = Number(result.total || 0), pagesCount = Math.max(1, Math.ceil(total / size));
  row.append(el('span', '', '共 ' + total + ' 条 · 第 ' + number + ' / ' + pagesCount + ' 页 · 每页 ' + size + ' 条'));
  const controls = el('div', 'pagination-actions');
  const previous = button('上一页', () => { state.filters[page].page = number - 1; loadPage(); }, 'secondary'); previous.disabled = number <= 1;
  const next = button('下一页', () => { state.filters[page].page = number + 1; loadPage(); }, 'secondary'); next.disabled = number * size >= total;
  append(controls, previous, next); append(row, controls); return row;
}
function deviceRow(item) {
  const row = el('tr'); const pricing = item.pricing || {}; const device = item.device || {};
  const identity = el('td', 'device-identity');
  const name = device.remarkName || device.name;
  const hasDistinctName = Boolean(name && name !== device.uuid);
  if (hasDistinctName) identity.append(el('div', 'cell-main', name));
  identity.append(el('div', (hasDistinctName ? 'cell-sub' : 'cell-main') + ' device-uuid', device.uuid));
  const status = append(el('td'), badge(item.state, deviceLabels)); if (!pricing.enabled) status.append(el('div', 'cell-sub', '租赁未开放'));
  const actions = el('td', 'row-actions'); actions.append(button('配置', () => configureDialog(item), 'table-action'));
  if (canEditDeviceRemark(state.user.role)) actions.append(button('修改备注', () => deviceRemarkDialog(device), 'table-action'));
  actions.append(button('二维码', () => deviceQrDialog(item), 'table-action'));
  if (state.user.role === 'root') actions.append(button('调拨', () => transferDialog('devices', device), 'text-button'));
  append(row, identity, el('td', 'device-model', device.type || '—'), textCell(device.venueName || item.venue?.name || '待绑定场地'), status, el('td', 'numeric', '¥' + money(pricing.useFeeCents)), el('td', 'numeric', '¥' + money(pricing.depositCents)), actions);
  return row;
}
function orderRow(order) {
  const row = el('tr');
  const refund = refundSummary(order);
  const refundCell = textCell(refund.title, refund.detail); refundCell.className = 'order-refund';
  append(row, textCell('#' + order.id + '  ·  ' + (order.deviceName || order.uuid), [order.venueName, order.uuid].filter(Boolean).join(' · ')), append(el('td'), badge(order.status, orderLabels)), textCell('¥' + money(order.totalCents), '租金 ¥' + money(order.useFeeCents) + ' · 押金 ¥' + money(order.depositCents)), refundCell, el('td', 'numeric', time(order.createdAt)), append(el('td'), button('详情', () => orderDialog(order.id), 'text-button')));
  return row;
}
function refundSummary(order) {
  const mode = order.refundMode === 'deposit' ? '仅退押金' : order.refundMode === 'full' ? '全额退款' : order.refundStatus ? '退款方式未记录' : '—';
  const status = order.refundStatus === 'SUCCESS' && order.refundAmountCents === 0 ? '无需退款' : refundLabels[order.refundStatus] || (order.refundStatus ? '退款状态未知' : '—');
  if (!order.refundStatus) return { mode, status, title: '—', detail: '' };
  const amount = (status === '无需退款' ? '退款金额 ' : order.refundStatus === 'SUCCESS' ? '已退 ' : '应退 ') + '¥' + money(order.refundAmountCents);
  const scope = order.refundMode === 'deposit' ? '保留租金 ¥' + money(order.useFeeCents) : order.refundMode === 'full' ? '含租金和押金' : '';
  return { mode, status, title: mode + ' · ' + status, detail: amount + (scope ? ' · ' + scope : '') };
}
function verifiedUserPhone(user) {
  return user.phoneVerified === true && typeof user.phoneNumber === 'string' && /^\+[1-9][0-9]{6,14}$/.test(user.phoneNumber) ? user.phoneNumber : '';
}
function userName(user) { return user.nickname || verifiedUserPhone(user) || '用户 #' + user.id; }
function userIdentity(user) {
  const phone = verifiedUserPhone(user);
  return '目标账号：' + userName(user) + '（ID ' + user.id + '）。' + (phone ? '手机号：' + phone + '（微信已验证）。' : '未授权手机号，请由用户本人在小程序授权。');
}
function userRow(user) {
  const row = el('tr');
  const phone = verifiedUserPhone(user);
  append(row, userCell(user), textCell(phone || '未授权手机号', phone ? '微信已验证' : '需本人在小程序授权'), append(el('td'), badge(user.role, { root: [roleLabel('root'), 'green'], adminer: [roleLabel('adminer'), 'blue'], manager: [roleLabel('manager'), 'blue'], user: [roleLabel('user'), ''] })));
  const actions = el('td');
  const protectedLabel = user.role === 'root' ? 'ROOT 身份受保护' : String(user.id) === String(state.user.id) ? '当前账号' : user.role === 'adminer' ? '同级身份受保护' : '不可修改';
  actions.append(assignableRoles(state.user, user).length ? button('管理身份', () => roleDialog(user), 'text-button') : el('span', 'muted', protectedLabel));
  row.append(actions); return row;
}
function dialog(title) {
  const node = el('dialog'); const head = el('div', 'dialog-head'); const titleNode = el('h2', '', title); titleNode.id = 'dialog-title-' + ++dialogSequence; node.setAttribute('aria-labelledby', titleNode.id);
  const close = button('关闭', () => node.close(), 'text-button dialog-close', 'x'); close.setAttribute('aria-label', '关闭'); append(head, titleNode, close);
  const body = el('div', 'dialog-body'); append(node, head, body); document.body.append(node); node.addEventListener('close', () => node.remove(), { once: true }); node.showModal();
  return { node, body, close };
}
function deviceQrSvg(qr, uuid) {
  if (!Number.isInteger(qr?.size) || qr.size < 21 || qr.size > 177 || (qr.size - 21) % 4 !== 0
    || typeof qr.modules !== 'string' || qr.modules.length !== qr.size * qr.size || /[^01]/.test(qr.modules)) throw new Error('二维码响应无效，请重试');
  const ns = 'http://www.w3.org/2000/svg', extent = qr.size + 8;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('xmlns', ns); svg.setAttribute('class', 'device-qr-code'); svg.setAttribute('viewBox', '0 0 ' + extent + ' ' + extent);
  svg.setAttribute('width', '1024'); svg.setAttribute('height', '1024'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '设备 ' + uuid + ' 的租赁二维码'); svg.setAttribute('shape-rendering', 'crispEdges');
  const background = document.createElementNS(ns, 'rect'); background.setAttribute('width', extent); background.setAttribute('height', extent); background.setAttribute('fill', '#fff');
  const runs = [];
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size;) {
    if (qr.modules[y * qr.size + x] !== '1') { x++; continue; }
    const start = x; while (x < qr.size && qr.modules[y * qr.size + x] === '1') x++;
    runs.push('M' + (start + 4) + ' ' + (y + 4) + 'h' + (x - start) + 'v1h-' + (x - start) + 'z');
  }
  const path = document.createElementNS(ns, 'path'); path.setAttribute('fill', '#000'); path.setAttribute('d', runs.join(''));
  return append(svg, background, path);
}
function downloadQrFile(blob, filename) {
  const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function deviceQrDialog(item) {
  const ui = dialog('设备二维码'); ui.node.classList.add('device-qr-dialog');
  const merchantId = managementMerchantId(), generation = state.merchantGeneration;
  const current = () => ui.node.open && !!state.user && generation === state.merchantGeneration && merchantId === managementMerchantId();
  const status = el('p', 'muted', '正在生成设备二维码…'); status.setAttribute('role', 'status');
  const error = message(''), label = el('section', 'device-qr-label'); label.hidden = true;
  const linkField = el('label', 'field device-qr-link'); append(linkField, el('span', '', '扫码链接'));
  const linkInput = el('input'); linkInput.readOnly = true; linkInput.setAttribute('aria-label', '设备扫码链接'); linkField.append(linkInput); linkField.hidden = true;
  const help = el('p', 'notice device-qr-help', '打印标签后贴在对应设备上，用户用微信扫一扫或小程序扫码进入租赁。打印时保留二维码四周白边，建议使用原始大小。PNG / SVG 为纯二维码，可用于自行排版。');
  let result = null, svg = null;
  const fileName = () => 'device-' + result.device.id + '-' + result.device.uuid.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60);
  const originalTitle = document.title;
  const cleanPrint = () => { document.body.classList.remove('printing-device-qr'); ui.node.classList.remove('device-qr-print-target'); document.title = originalTitle; };
  ui.node.addEventListener('close', cleanPrint, { once: true });
  const print = button('打印标签', () => {
    if (!result || !current()) return;
    document.body.classList.add('printing-device-qr'); ui.node.classList.add('device-qr-print-target'); document.title = '设备标签 · ' + result.device.uuid;
    window.addEventListener('afterprint', cleanPrint, { once: true });
    try { window.print(); } catch { cleanPrint(); error.textContent = '无法打开打印，请下载 SVG 后打印'; }
  });
  const svgDownload = button('下载 SVG', () => {
    if (!result || !current()) return;
    try { downloadQrFile(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }), fileName() + '.svg'); }
    catch { error.textContent = 'SVG 下载失败，请重试'; }
  }, 'secondary');
  const pngDownload = button('下载 PNG', () => {
    if (!result || !current()) return;
    try {
      const qr = result.qr, extent = qr.size + 8, scale = Math.ceil(1024 / extent), canvas = el('canvas'); canvas.width = canvas.height = extent * scale;
      const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y * qr.size + x] === '1') context.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
      canvas.toBlob(blob => { if (!current()) return; if (blob) downloadQrFile(blob, fileName() + '.png'); else error.textContent = 'PNG 下载失败，请重试'; }, 'image/png');
    } catch { error.textContent = 'PNG 下载失败，请重试，或下载 SVG'; }
  }, 'secondary');
  const retry = button('重新生成', () => load(), 'secondary'); retry.hidden = true;
  const tools = append(el('div', 'device-qr-tools'), print, pngDownload, svgDownload, retry);
  append(ui.body, status, label, linkField, help, error, tools);
  async function load() {
    result = null; label.hidden = linkField.hidden = true; status.hidden = false; status.textContent = '正在生成设备二维码…'; error.textContent = ''; retry.hidden = true;
    for (const action of [print, pngDownload, svgDownload]) action.disabled = true;
    try {
      const value = await api('/rental/admin/devices/' + encodeURIComponent(item.device.id) + '/qrcode');
      if (!current()) return;
      if (!value.device || value.device.id !== item.device.id || typeof value.device.uuid !== 'string' || !value.device.uuid || typeof value.url !== 'string') throw new Error('设备二维码响应无效，请重试');
      const url = new URL(value.url);
      if (url.protocol !== 'https:' || url.pathname !== '/d' || url.searchParams.get('i') !== value.device.uuid) throw new Error('设备扫码链接无效，请重试');
      svg = deviceQrSvg(value.qr, value.device.uuid); result = value;
      label.replaceChildren(el('p', 'device-qr-brand', 'AR设备租赁'), el('h3', 'device-qr-heading', '微信扫一扫租赁'), svg, el('p', 'device-qr-name', value.device.name || value.device.uuid), el('p', 'device-qr-uuid', 'UUID：' + value.device.uuid), el('p', 'device-qr-model', value.device.type || ''));
      const location = [value.device.merchantName, value.device.venueName].filter(Boolean).join(' · '); if (location) label.append(el('p', 'device-qr-location', location));
      linkInput.value = value.url; label.hidden = linkField.hidden = false; status.hidden = true;
      for (const action of [print, pngDownload, svgDownload]) action.disabled = false;
    } catch (failure) { if (!current()) return; status.hidden = true; error.textContent = failure.message || '二维码生成失败，请重试'; retry.hidden = false; }
  }
  await load();
}
function field(form, label, options = {}) {
  const wrapper = el('label', 'field'); wrapper.append(el('span', '', label)); const input = el(options.tag || 'input');
  for (const [key, value] of Object.entries(options)) { if (['help', 'tag'].includes(key)) continue; input[key] = value; }
  wrapper.append(input); if (options.help) wrapper.append(el('small', '', options.help)); form.append(wrapper); return input;
}
function formDialog(title, saveLabel = '保存') {
  const base = dialog(title); const form = el('form', 'dialog-form'); const error = message('');
  const actions = el('div', 'dialog-actions');
  const cancel = button('取消', () => base.node.close(), 'secondary'); const submit = button(saveLabel); submit.type = 'submit';
  append(actions, cancel, submit); base.body.append(form);
  const ready = () => append(form, error, actions);
  const busy = value => { submit.disabled = value; cancel.disabled = value; base.close.disabled = value; for (const input of form.querySelectorAll('input,select,textarea')) input.disabled = value; };
  base.node.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
  return { ...base, form, error, ready, busy, submit };
}
function parseCents(value) {
  const text = value.trim();
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(text)) throw new Error('金额须为非负数字，最多保留两位小数');
  const [whole, decimal = ''] = text.split('.'); const result = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 2147483647) throw new Error('金额超出有效范围'); return result;
}
function renderVenues(content, result) {
  const scope = managementMerchant();
  if (!scope) { content.replaceChildren(el('p', 'notice', '请先选择场地所属商户')); return; }
  if (!Array.isArray(result.items)) throw new Error('场地列表响应无效');
  const list = el('div', 'merchant-grid');
  for (const venue of result.items) {
    const card = el('article', 'card merchant-card');
    append(card, append(el('div', 'card-heading'), el('h2', '', venue.name), badge(venue.status, { active: ['已启用', 'green'], paused: ['已暂停', 'amber'] })));
    const details = el('dl', 'details');
    for (const [label, value] of [['地址', venue.address || '未填写'], ['联系人', venue.contactName || '未填写'], ['联系电话', venue.contactPhone || '未填写'], ['场地说明', venue.description || '未填写'], ['每次租金', '¥' + money(venue.useFeeCents)], ['押金', '¥' + money(venue.depositCents)]]) append(details, el('dt', '', label), el('dd', '', value));
    card.append(details);
    if (canManageVenues(state.user.role)) card.append(append(el('div', 'merchant-actions'), button('编辑场地与收费', () => venueDialog(venue), 'secondary', 'settings'), button('样式设置', () => venueAppearanceDialog(venue), 'secondary', 'settings')));
    list.append(card);
  }
  content.replaceChildren(el('p', 'venue-owner', '所属商户：' + merchantLabel(scope)), el('p', 'notice', canManageVenues(state.user.role) ? '场地归属当前商户。设备绑定场地后使用该场地的租金与押金；调整收费仅影响新订单。' : '你可以查看本商户场地及收费。创建或编辑场地请联系商户管理员。'), list);
  if (!result.items.length) content.append(el('p', 'empty', canManageVenues(state.user.role) ? '暂无场地，请先新建场地、设置租金与押金，再登记设备。' : '本商户暂无场地，请联系商户管理员创建并启用场地。'));
}
function venueDialog(venue) {
  if (!canManageVenues(state.user?.role)) return;
  const selectedMerchant = managementMerchant();
  if (!selectedMerchant) { toast('请先选择场地所属商户'); return; }
  const selectedMerchantId = selectedMerchant.id, selectedGeneration = state.merchantGeneration, actorId = state.user.id;
  if (venue?.merchantId && venue.merchantId !== selectedMerchantId) { toast('该场地不属于当前商户，请重新加载'); return; }
  const ui = formDialog(venue ? '编辑场地与收费' : '新建场地', '保存场地');
  const sameScope = () => state.user?.id === actorId && canManageVenues(state.user?.role) && managementMerchantId() === selectedMerchantId && state.merchantGeneration === selectedGeneration;
  const assertDraftScope = () => { if (!ui.node.open || !sameScope()) throw new Error('当前商户已变化，请关闭后重新编辑场地'); };
  ui.form.append(el('p', 'notice venue-owner', '所属商户：' + merchantLabel(selectedMerchant) + '。场地内设备的款项由该商户收取。'));
  const name = field(ui.form, '场地名称', { required: true, maxLength: 128, value: venue?.name || '' });
  const address = field(ui.form, '场地地址', { maxLength: 512, value: venue?.address || '' });
  const contactName = field(ui.form, '联系人', { maxLength: 64, value: venue?.contactName || '' });
  const contactPhone = field(ui.form, '联系电话', { type: 'tel', maxLength: 64, value: venue?.contactPhone || '' });
  const description = field(ui.form, '场地说明', { tag: 'textarea', rows: 3, maxLength: 2000, value: venue?.description || '' });
  const prices = el('div', 'field-row');
  const use = field(prices, '每次租金（元）', { required: true, inputMode: 'decimal', maxLength: 13, value: venue ? money(venue.useFeeCents).replaceAll(',', '') : '' });
  const deposit = field(prices, '押金（元）', { required: true, inputMode: 'decimal', maxLength: 13, value: venue ? money(venue.depositCents).replaceAll(',', '') : '' });
  ui.form.append(prices);
  const status = field(ui.form, '场地状态', { tag: 'select' });
  for (const [value, label] of [['active', '已启用'], ['paused', '已暂停']]) { const option = el('option', '', label); option.value = value; status.append(option); }
  status.value = venue?.status || 'active';
  ui.form.append(el('p', 'notice', '租金与押金在场地统一设置。已有订单保留下单时的金额；暂停场地后不再接受新租赁。')); ui.ready();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled || !canManageVenues(state.user?.role)) return; ui.error.textContent = '';
    try { assertDraftScope(); } catch (error) { ui.error.textContent = error.message; return; }
    let payload;
    try {
      payload = { name: name.value.trim(), address: address.value.trim(), contactName: contactName.value.trim(), contactPhone: contactPhone.value.trim(), description: description.value.trim(), status: status.value, useFeeCents: parseCents(use.value), depositCents: parseCents(deposit.value), ...(venue ? { version: venue.version } : {}) };
      if (!payload.name || !['active', 'paused'].includes(payload.status)) throw new Error('请核对场地名称与状态');
      if (payload.useFeeCents + payload.depositCents > 2147483647) throw new Error('租金与押金合计超出有效范围');
    } catch (error) { ui.error.textContent = error.message; return; }
    ui.busy(true);
    try {
      await api('/rental/admin/venues' + (venue ? '/' + encodeURIComponent(venue.id) : ''), { method: venue ? 'PATCH' : 'POST', body: JSON.stringify(payload), headers: { 'X-Merchant-Id': String(selectedMerchantId) }, beforeDispatch: assertDraftScope });
      if (state.user?.id !== actorId) return;
      if (!sameScope() || !ui.node.open) { toast(selectedMerchant.name + '的场地已保存，请在该商户下查看。'); return; }
      ui.node.close(); toast(selectedMerchant.name + '的场地与收费已保存'); if (state.page === 'venues') loadPage(); else navigate('venues');
    } catch (error) { if (ui.node.open) ui.error.textContent = error.status === 409 ? '场地已被更新，请关闭后刷新场地列表再编辑。' : error.message; }
    finally { if (ui.node.open) ui.busy(false); }
  });
}
async function activeVenues(merchantId, currentVenueId) {
  const result = await api('/rental/admin/venues', merchantId ? { headers: { 'X-Merchant-Id': String(merchantId) } } : {});
  if (!Array.isArray(result.items)) throw new Error('场地列表响应无效');
  return result.items.filter(venue => (venue.status === 'active' || venue.id === currentVenueId) && Number.isSafeInteger(venue.id) && venue.id > 0);
}
function venueOptions(form, venues, currentId) {
  const select = field(form, '所属场地', { tag: 'select', required: true });
  const placeholder = el('option', '', '请选择本商户场地'); placeholder.value = ''; select.append(placeholder);
  for (const venue of venues) { const option = el('option', '', venue.name + (venue.status === 'paused' ? '（已暂停）' : '')); option.value = String(venue.id); select.append(option); }
  select.value = venues.some(venue => venue.id === currentId) ? String(currentId) : venues.length === 1 ? String(venues[0].id) : '';
  return select;
}
function noVenueGuidance(ui) {
  ui.form.replaceChildren(el('p', 'notice', '当前商户暂无可用场地。请先由商户管理员在「' + merchantParentTitle() + ' / ' + merchantName() + ' / 场地」中创建并启用场地、设置租金与押金，再登记设备。'));
  if (canManageVenues(state.user?.role)) ui.form.append(button('前往场地管理', () => { ui.node.close(); navigate('venues'); }, 'secondary'));
}
async function createDeviceDialog() {
  if (!canUseAdmin(state.user?.role)) return;
  const ui = formDialog('登记新设备', '确认登记');
  const selectedMerchantId = managementMerchantId(), scope = deviceContextScope();
  const current = () => ui.node.open && !!selectedMerchantId && scope === deviceContextScope();
  const assertDraftScope = () => { if (!current()) throw new Error('账号或绑定商户已变化，请关闭后重新登记'); };
  ui.form.append(el('div', 'loading', '正在读取本商户场地…'));
  let venues;
  try { venues = await activeVenues(); if (!ui.node.open) return; assertDraftScope(); }
  catch (error) { if (ui.node.open) ui.form.replaceChildren(message(error.message)); return; }
  if (!venues.length) { noVenueGuidance(ui); return; }
  ui.form.replaceChildren();
  ui.form.append(el('p', 'notice', '所属商户：' + merchantName() + '。设备绑定场地，商户归属由所选场地继承；该商户收取租赁款。'));
  const venue = venueOptions(ui.form, venues);
  const name = field(ui.form, '设备名称', { required: true, maxLength: 255, placeholder: '例如：AR眼镜 01' });
  const uuid = field(ui.form, '设备 UUID', { required: true, maxLength: 255, placeholder: '输入设备二维码中的 UUID', help: 'UUID 是设备的唯一标识，请核对后登记。' });
  const remark = field(ui.form, '备注名称（选填）', { value: '', maxLength: 255, placeholder: '例如：一楼前台备用机', help: '仅管理端可见。' });
  const type = field(ui.form, '设备类型', { tag: 'select', required: true, help: '请选择设备实际型号。' });
  for (const model of ['Rokid Studio', 'Rokid Studio2', 'Rokid Studio3']) {
    const option = el('option', '', model); option.value = model; type.append(option);
  }
  type.value = 'Rokid Studio2';
  ui.form.append(el('p', 'notice', '租金与押金使用所选场地的设置。新设备默认未开放租赁，核对场地后再开放。')); ui.ready();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled) return; ui.error.textContent = '';
    const payload = { name: name.value.trim(), uuid: uuid.value.trim(), type: type.value.trim(), venueId: Number(venue.value) };
    const remarkName = remark.value.trim();
    if (remarkName) payload.remarkName = remarkName;
    if (!payload.name || !payload.uuid || !payload.type || !venues.some(item => item.id === payload.venueId)) { ui.error.textContent = '请完整填写设备信息并选择本商户场地'; return; }
    ui.busy(true);
    try {
      assertDraftScope();
      const result = await api('/rental/devices', { method: 'POST', body: JSON.stringify(payload), beforeDispatch: assertDraftScope });
      if (!current()) return;
      ui.node.close(); toast(result.created === false ? '该设备已登记，请在列表中查看' : '设备已登记并绑定场地，请核对后开放租赁'); state.filters.devices = { page: 1, search: '' }; if (state.page === 'devices') loadPage(); else navigate('devices');
    } catch (error) { if (ui.node.open) ui.error.textContent = error.message; }
    finally { if (ui.node.open) ui.busy(false); }
  });
}
function deviceRemarkDialog(device) {
  if (!canEditDeviceRemark(state.user?.role)) return;
  const scope = deviceContextScope();
  const ui = formDialog('修改设备备注 · ' + device.uuid);
  const current = () => ui.node.open && scope === deviceContextScope();
  const remark = field(ui.form, '备注名称', { value: device.remarkName || '', maxLength: 255, help: '仅管理端可见，留空可清除备注。' });
  ui.ready();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled) return; ui.error.textContent = '';
    ui.busy(true);
    try {
      await api('/rental/devices/' + encodeURIComponent(device.id) + '/remark', {
        method: 'PATCH', body: JSON.stringify({ remarkName: remark.value.trim() }),
        beforeDispatch: () => { if (!current()) throw new Error('当前账号或商户已变化，请重新打开设备'); },
      });
      if (!current()) return;
      ui.node.close(); toast('设备备注已保存'); if (state.page === 'devices') loadPage();
    } catch (error) { if (ui.node.open) ui.error.textContent = error.message; }
    finally { if (ui.node.open) ui.busy(false); }
  });
}
async function configureDialog(item) {
  const ui = formDialog('租赁配置 · ' + (item.device.name || item.device.uuid)); const pricing = item.pricing || {};
  const selectedMerchantId = managementMerchantId(); ui.form.append(el('div', 'loading', '正在读取本商户场地…'));
  let venues;
  try { venues = await activeVenues(undefined, item.device.venueId); if (!ui.node.open) return; if (!selectedMerchantId || managementMerchantId() !== selectedMerchantId) throw new Error('当前商户已变化，请关闭后重新配置'); }
  catch (error) { if (ui.node.open) ui.form.replaceChildren(message(error.message)); return; }
  if (!venues.length) { noVenueGuidance(ui); return; }
  ui.form.replaceChildren();
  const venue = venueOptions(ui.form, venues, item.device.venueId);
  const priceSummary = el('p', 'notice'); ui.form.append(priceSummary);
  const enabledLabel = el('label', 'checkbox-field'); const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(pricing.deviceEnabled ?? pricing.enabled); append(enabledLabel, enabled, document.createTextNode('开放设备租赁')); ui.form.append(enabledLabel);
  const updateVenue = () => { const selected = venues.find(item => String(item.id) === venue.value); priceSummary.textContent = selected ? '场地租金 ¥' + money(selected.useFeeCents) + ' · 押金 ¥' + money(selected.depositCents) + '。收费请在场地管理中调整。' + (selected.status === 'paused' ? '当前场地已暂停，只能关闭设备或选择其他已启用场地。' : '') : '请选择有效场地。'; enabled.disabled = !!selected && (selected.id !== item.device.venueId || selected.status !== 'active'); if (enabled.disabled) enabled.checked = false; };
  venue.addEventListener('change', updateVenue); updateVenue();
  ui.form.append(el('p', 'notice', '设备有租赁占用或未完成退款时不能变更场地。变更后设备会暂停开放，核对新场地后再次开放租赁。')); ui.ready();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled) return; ui.error.textContent = '';
    if (!selectedMerchantId || managementMerchantId() !== selectedMerchantId) { ui.error.textContent = '当前商户已变化，请关闭后重新配置'; return; }
    const payload = { enabled: enabled.checked, venueId: Number(venue.value), version: Number(pricing.version || 0) };
    if (!venues.some(item => item.id === payload.venueId)) { ui.error.textContent = '请选择本商户的有效场地'; return; }
    ui.busy(true);
    try { await write('/rental/devices/' + encodeURIComponent(item.device.id) + '/config', payload, 'PATCH'); ui.node.close(); toast(payload.venueId !== item.device.venueId ? '设备场地已变更并停租，请核对后重新开放' : '租赁开关已保存'); loadPage(); }
    catch (error) { ui.error.textContent = error.status === 409 ? '设备配置已变化，请关闭此窗口并刷新列表后重新配置。' : error.message; }
    finally { ui.busy(false); updateVenue(); }
  });
}
async function orderDialog(id) {
  const ui = dialog('租赁订单 #' + id); ui.body.append(el('div', 'loading', '正在加载订单详情…'));
  try {
    const result = await api('/rentals/' + encodeURIComponent(id)); const order = result.rental;
    if (!ui.node.open) return;
    if (!order) throw new Error('订单详情格式无效');
    const details = el('dl', 'details');
    const refund = refundSummary(order);
    const entries = [['订单编号', '#' + order.id], ['商户', order.merchantName || merchantName()], ['场地', order.venueName || '—'], ['设备名称', order.deviceName || '—'], ['设备 UUID', order.uuid], ['租赁状态', orderLabels[order.status]?.[0] || order.status], ['支付状态', paymentLabels[order.paymentStatus] || order.paymentStatus], ['租金', '¥' + money(order.useFeeCents)], ['押金', '¥' + money(order.depositCents)], ['订单合计', '¥' + money(order.totalCents)], ['退款方式', refund.mode], ['退款金额', '¥' + money(order.refundAmountCents)], ['退款状态', refund.status], ...(order.refundStatus && order.refundMode === 'deposit' ? [['保留租金', '¥' + money(order.useFeeCents)]] : []), ['创建时间', time(order.createdAt)], ['支付时间', time(order.paidAt)], ['开始时间', time(order.startedAt)], ['结束时间', time(order.endedAt)], ['结算时间', time(order.settledAt)]];
    for (const [label, value] of entries) append(details, el('dt', '', label), el('dd', '', value ?? '—'));
    ui.body.replaceChildren(details, el('p', 'notice', '订单状态以服务端验证结果为准。办理归还和退款请使用小程序管理页面。'));
  } catch (error) { if (ui.node.open) ui.body.replaceChildren(message(error.message)); }
}
function merchantName() { return managementMerchant()?.name || '请先选择商户'; }
function brandingLogoUrl(value, uploaded = false, label = 'Logo') {
  if (!value) return '';
  if (uploaded && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (value.length > 2048 || /[\x00-\x20\x7f]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error();
    return url.href;
  } catch { throw new Error(label + '地址须为完整 HTTPS 图片地址'); }
}
function checkedBranding(result, merchantId) {
  const value = result?.branding;
  if (result?.merchant?.id !== merchantId || !value || typeof value.displayName !== 'string' || !value.displayName.trim() || typeof value.logoUrl !== 'string' || !Number.isSafeInteger(value.version) || value.version < 0) throw new Error('品牌配置响应无效，请重新加载');
  brandingLogoUrl(value.logoUrl); return { ...value };
}
function checkedVenueAppearance(result, merchantId, venueId) {
  const value = result?.appearance;
  if (result?.venue?.id !== venueId || result.venue.merchantId !== merchantId || !value || typeof value.heroImageUrl !== 'string' || !Object.hasOwn(brandingThemes, value.theme) || !Number.isSafeInteger(value.version) || value.version < 0) throw new Error('景点样式响应无效，请重新加载');
  brandingLogoUrl(value.heroImageUrl, false, 'AR 眼镜主图'); return { ...value };
}
function brandingPreview() {
  const node = el('aside', 'branding-preview'); node.setAttribute('aria-label', '小程序效果预览');
  append(node, el('p', 'eyebrow', 'LIVE PREVIEW'), el('h2', '', '小程序效果预览'));
  const phone = el('div', 'branding-phone'), nav = el('div', 'branding-phone-nav'), title = el('strong'); append(nav, title, el('span', 'branding-capsule', '•••  ◉'));
  const body = el('div', 'branding-phone-body'), identity = el('div', 'branding-preview-identity'), mark = el('div', 'branding-preview-logo'), image = el('img'), initials = el('span'); image.alt = '商户 Logo 预览'; image.referrerPolicy = 'no-referrer'; append(mark, image, initials);
  const name = el('h3'), subtitle = el('p'); append(identity, mark, name, subtitle);
  const hero = el('img', 'branding-preview-product'); hero.alt = 'AR 眼镜主图预览'; hero.referrerPolicy = 'no-referrer';
  append(body, identity, hero, el('div', 'branding-preview-scan', '扫一扫 · 开始体验'), el('div', 'branding-preview-tip', '扫描设备二维码，查看场地与租赁信息'), append(el('div', 'branding-preview-order'), el('span', '', '我的租赁'), el('span', '', '查看订单 ›')));
  append(phone, nav, body); const status = el('p', 'branding-preview-state'); status.setAttribute('role', 'status'); append(node, phone, status);
  let failedLogo = '', failedHero = ''; const defaultHero = '/admin/assets/aero-glasses.png';
  image.addEventListener('error', () => { failedLogo = image.getAttribute('src'); image.hidden = true; initials.hidden = false; });
  hero.addEventListener('error', () => { const source = hero.getAttribute('src'); if (source === defaultHero) { hero.hidden = true; return; } failedHero = source; hero.setAttribute('src', defaultHero); });
  return { node, update(brand, appearance = {}, changed = false, venueName = '') {
    const label = brand.displayName?.trim() || '你的品牌名称'; title.textContent = name.textContent = label; initials.textContent = [...label].slice(0, 2).join(''); subtitle.textContent = venueName || '欢迎体验 AR 设备租赁';
    phone.className = 'branding-phone branding-preview-theme-' + (Object.hasOwn(brandingThemes, appearance.theme) ? appearance.theme : 'aero');
    const logo = brand.logoUrl || ''; if (logo && logo !== failedLogo) { image.hidden = false; initials.hidden = true; if (image.getAttribute('src') !== logo) image.setAttribute('src', logo); } else { image.hidden = true; image.removeAttribute('src'); initials.hidden = false; }
    const source = appearance.heroImageUrl && appearance.heroImageUrl !== failedHero ? appearance.heroImageUrl : defaultHero; if (hero.getAttribute('src') !== source) { hero.hidden = false; hero.setAttribute('src', source); }
    status.textContent = changed ? '预览中 · 有未保存的修改' : '当前已保存的配置';
  } };
}
/** Image drafts have independent read generations and never replace an uploaded URL with itself. */
function brandingImageEditor(form, options) {
  let dataUrl = null, revision = 0, reading = false;
  const upload = field(form, options.uploadLabel, { type: 'file', accept: 'image/png,image/jpeg,image/webp', help: '支持 PNG、JPG、WebP，最大 ' + options.maxKB + ' KB。' });
  const url = field(form, options.urlLabel, { type: 'url', maxLength: 2048, value: options.value, placeholder: 'https://…', help: options.help });
  const actions = el('div', 'branding-logo-actions'), status = el('span', 'muted'); status.setAttribute('role', 'status');
  const clear = button(options.clearLabel, () => { if (!options.current() || options.locked()) return; control.reset(''); options.report(''); options.changed(); }, 'text-button'); append(actions, clear, status); form.append(actions);
  const control = { upload, url, get reading() { return reading; }, source() { try { return brandingLogoUrl(dataUrl || url.value.trim(), Boolean(dataUrl), options.label); } catch { return ''; } }, dirty(saved) { return dataUrl !== null || url.value.trim() !== saved; }, reset(value) { revision++; reading = false; dataUrl = null; url.value = value; upload.value = ''; status.textContent = ''; }, payload(saved, urlKey, dataKey) { if (dataUrl !== null) return { [dataKey]: dataUrl }; return url.value.trim() !== saved ? { [urlKey]: brandingLogoUrl(url.value.trim(), false, options.label) } : {}; } };
  url.addEventListener('input', () => { if (!options.current() || options.locked()) return; revision++; reading = false; dataUrl = null; upload.value = ''; status.textContent = ''; options.changed(); });
  upload.addEventListener('change', async () => {
    if (!options.current() || options.locked()) return; const file = upload.files?.[0]; if (!file) return;
    const generation = ++revision; options.report('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > options.maxKB * 1024) { options.report('请选择不超过 ' + options.maxKB + ' KB 的 PNG、JPG 或 WebP 图片'); upload.value = ''; reading = false; status.textContent = ''; options.changed(); return; }
    reading = true; status.textContent = '正在读取图片…'; options.changed();
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败，请重新选择')); reader.onabort = () => reject(new Error('图片读取已取消')); reader.readAsDataURL(file); });
      if (!options.current() || generation !== revision) return;
      if (typeof data !== 'string' || !data.startsWith('data:' + file.type + ';base64,')) throw new Error('图片格式无效，请重新选择');
      brandingLogoUrl(data, true, options.label); dataUrl = data; url.value = ''; status.textContent = '图片已就绪，保存后生效';
    } catch (failure) { if (options.current() && generation === revision) { options.report(failure.message || '图片读取失败，请重试'); upload.value = ''; status.textContent = ''; } }
    finally { if (options.current() && generation === revision) { reading = false; options.changed(); } }
  }); return control;
}
function renderBranding(content, result) {
  const merchantId = managementMerchantId(); if (!merchantId || !canManageBranding(state.user?.role)) return;
  let saved = checkedBranding(result, merchantId), saving = false, forbidden = false;
  const scope = deviceContextScope(), sequence = state.sequence, current = () => state.page === 'branding' && sequence === state.sequence && scope === deviceContextScope() && canManageBranding(state.user?.role);
  const layout = el('div', 'branding-layout'), card = el('section', 'card branding-editor'), form = el('form', 'branding-form'), error = message(''), success = el('p', 'branding-status'); success.setAttribute('role', 'status');
  const name = field(form, '小程序显示名称', { required: true, maxLength: 32, value: saved.displayName, placeholder: '输入面向用户的品牌名称', help: '最多 32 个字符，本商户下的景点共用此名称与 Logo。' });
  const logo = brandingImageEditor(form, { value: saved.logoUrl, uploadLabel: '上传 Logo', urlLabel: 'Logo 图片地址', label: 'Logo', maxKB: 256, clearLabel: '移除 Logo', help: '也可填写 HTTPS 图片地址。建议使用方形图片。', current, locked: () => saving || forbidden, report: text => { error.textContent = text; }, changed: () => refresh() });
  form.append(el('p', 'notice', '各景点的小程序风格与 AR 眼镜主图可在「场地」中分别设置。'));
  const preview = brandingPreview(); preview.node.append(el('p', 'muted', '此处预览商户通用名称与 Logo，景点样式由各景点自行设置。'));
  const submit = button('保存品牌设置', null, '', 'check'); submit.type = 'submit';
  const reset = button('撤销未保存修改', () => { if (!current() || saving || forbidden) return; name.value = saved.displayName; logo.reset(saved.logoUrl); error.textContent = success.textContent = ''; refresh(); }, 'secondary');
  const reload = button('重新加载最新配置', () => { if (current() && !saving) loadPage(); }, 'secondary'); reload.hidden = true;
  append(form, error, reload, append(el('div', 'branding-actions'), reset, submit), success);
  form.append(el('p', 'footer-note', '微信客户端显示的小程序注册名称和图标需在微信公众平台维护。'));
  append(card, append(el('div', 'card-heading'), el('h2', '', '商户通用品牌')), el('p', 'venue-owner', '所属商户：' + merchantLabel(result.merchant)), form); append(layout, card, preview.node); content.replaceChildren(layout);
  function refresh() { preview.update({ displayName: name.value, logoUrl: logo.source() }, {}, name.value.trim() !== saved.displayName || logo.dirty(saved.logoUrl)); for (const input of form.querySelectorAll('input,button')) input.disabled = saving || forbidden; submit.disabled = saving || forbidden || logo.reading; }
  name.addEventListener('input', () => { if (current() && !saving && !forbidden) refresh(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (saving || forbidden || !current()) return; error.textContent = success.textContent = '';
    if (logo.reading) { error.textContent = '图片正在读取，请稍后保存'; return; }
    const displayName = name.value.trim(); if (!displayName || [...displayName].length > 32 || /[\x00-\x1f\x7f]/.test(displayName)) { error.textContent = '请填写 1 至 32 个字符的显示名称'; return; }
    let payload; try { payload = { displayName, version: saved.version, ...logo.payload(saved.logoUrl, 'logoUrl', 'logoDataUrl') }; } catch (failure) { error.textContent = failure.message; return; }
    saving = true; refresh();
    try {
      const response = await api('/rental/admin/branding', { method: 'PATCH', headers: { 'X-Merchant-Id': String(merchantId) }, body: JSON.stringify(payload), beforeDispatch: () => { if (!current()) throw new Error('登录或商户范围已变化，请重新打开品牌设置'); } });
      if (!current()) return; saved = checkedBranding(response, merchantId); name.value = saved.displayName; logo.reset(saved.logoUrl); success.textContent = '品牌设置已保存' + (saved.updatedAt ? ' · ' + time(saved.updatedAt) : ''); reload.hidden = true;
    } catch (failure) { if (!current()) return; error.textContent = failure.status === 409 ? '品牌设置已被其他管理员修改。请重新加载最新配置后再编辑。' : failure.message; if (failure.status === 409) reload.hidden = false; if (failure.status === 403) forbidden = true; }
    finally { if (current()) { saving = false; refresh(); } }
  }); refresh();
}
async function venueAppearanceDialog(venue) {
  if (!canManageVenues(state.user?.role)) return;
  const merchant = managementMerchant(); if (!merchant || !Number.isSafeInteger(venue?.id) || venue.id < 1 || venue.merchantId !== merchant.id) { toast('请选择当前商户的景点'); return; }
  const merchantId = merchant.id, venueId = venue.id, scope = deviceContextScope(), sequence = state.sequence;
  const ui = formDialog('景点样式设置 · ' + venue.name, '保存景点样式'); ui.node.classList.add('venue-appearance-dialog');
  const current = () => ui.node.open && scope === deviceContextScope() && sequence === state.sequence && canManageVenues(state.user?.role);
  const path = '/rental/admin/venues/' + encodeURIComponent(venueId) + '/appearance', headers = { 'X-Merchant-Id': String(merchantId) };
  ui.submit.disabled = true; ui.form.append(el('p', 'loading', '正在读取景点样式…'));
  let saved, brand;
  try { const [appearance, branding] = await Promise.all([api(path, { headers }), api('/rental/admin/branding', { headers })]); if (!current()) return; saved = checkedVenueAppearance(appearance, merchantId, venueId); brand = checkedBranding(branding, merchantId); }
  catch (failure) { if (!current()) return; ui.form.replaceChildren(message(failure.message), button('重新加载', () => { if (current()) { ui.node.close(); venueAppearanceDialog(venue); } }, 'secondary')); return; }
  if (!current()) return; ui.form.replaceChildren(); let saving = false, forbidden = false;
  const layout = el('div', 'branding-layout'), preview = brandingPreview(); ui.body.replaceChildren(layout); append(layout, ui.form, preview.node); ui.form.classList.add('branding-form');
  ui.form.append(el('p', 'venue-owner', '所属商户：' + merchantLabel(merchant) + ' / 景点：' + venue.name), el('p', 'notice', '此配置仅用于当前景点。显示名称与 Logo 使用所属商户的通用品牌。'));
  const themes = el('fieldset', 'branding-themes'); themes.append(el('legend', '', '景点小程序风格')); const choices = [];
  for (const [key, [label, description]] of Object.entries(brandingThemes)) { const wrapper = el('label', 'branding-theme-option branding-theme-' + key), radio = el('input'); radio.type = 'radio'; radio.name = 'venue-theme'; radio.value = key; radio.checked = key === saved.theme; choices.push(radio); append(wrapper, radio, el('span', 'branding-swatch'), append(el('span'), el('strong', '', label), el('small', '', description))); themes.append(wrapper); radio.addEventListener('change', () => { if (!current() || saving || forbidden) return; if (radio.checked) for (const other of choices) if (other !== radio) other.checked = false; refresh(); }); } ui.form.append(themes);
  const hero = brandingImageEditor(ui.form, { value: saved.heroImageUrl, uploadLabel: 'AR 眼镜主图', urlLabel: '主图图片地址', label: 'AR 眼镜主图', maxKB: 512, clearLabel: '恢复默认主图', help: '填写 HTTPS 图片地址，或上传景点主图。留空使用默认 AR 眼镜图片。', current, locked: () => saving || forbidden, report: text => { ui.error.textContent = text; }, changed: () => refresh() });
  const success = el('p', 'branding-status'); success.setAttribute('role', 'status');
  const reset = button('撤销未保存修改', () => { if (!current() || saving || forbidden) return; hero.reset(saved.heroImageUrl); for (const radio of choices) radio.checked = radio.value === saved.theme; ui.error.textContent = success.textContent = ''; refresh(); }, 'secondary');
  const reload = button('重新加载最新配置', () => { if (current() && !saving) { ui.node.close(); venueAppearanceDialog(venue); } }, 'secondary'); reload.hidden = true; append(ui.form, reset, reload, success); ui.ready();
  const selectedTheme = () => choices.find(radio => radio.checked)?.value || '';
  function refresh() { preview.update(brand, { theme: selectedTheme(), heroImageUrl: hero.source() }, selectedTheme() !== saved.theme || hero.dirty(saved.heroImageUrl), venue.name); ui.busy(saving); for (const input of ui.form.querySelectorAll('input,button')) input.disabled = saving || forbidden; ui.submit.disabled = saving || forbidden || hero.reading; }
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (!current() || saving || forbidden) return; ui.error.textContent = success.textContent = '';
    if (hero.reading) { ui.error.textContent = '图片正在读取，请稍后保存'; return; }
    const theme = selectedTheme(); if (!Object.hasOwn(brandingThemes, theme)) { ui.error.textContent = '请选择有效景点风格'; return; }
    let payload; try { payload = { theme, version: saved.version, ...hero.payload(saved.heroImageUrl, 'heroImageUrl', 'heroDataUrl') }; } catch (failure) { ui.error.textContent = failure.message; return; }
    saving = true; refresh();
    try { const response = await api(path, { method: 'PATCH', headers, body: JSON.stringify(payload), beforeDispatch: () => { if (!current()) throw new Error('登录或景点所属商户已变化，请重新打开景点样式'); } }); if (!current()) return; saved = checkedVenueAppearance(response, merchantId, venueId); hero.reset(saved.heroImageUrl); for (const radio of choices) radio.checked = radio.value === saved.theme; success.textContent = '景点样式已保存' + (saved.updatedAt ? ' · ' + time(saved.updatedAt) : ''); reload.hidden = true; }
    catch (failure) { if (!current()) return; ui.error.textContent = failure.status === 409 ? '景点样式已被其他管理员修改。请重新加载最新配置后再编辑。' : failure.message; if (failure.status === 409) reload.hidden = false; if (failure.status === 403) forbidden = true; }
    finally { if (current()) { saving = false; refresh(); } }
  }); refresh();
}
function renderMerchantContext() {
  const container = document.querySelector('#merchant-context'); if (!container || !state.user) return;
  const scope = managementMerchant();
  for (const label of document.querySelectorAll('.nav-merchant-scope')) label.textContent = scope ? (scope.name || '商户 #' + scope.id) + ' · ' + (scope.code || 'ID ' + scope.id) : '请先选择所属商户';
  for (const link of document.querySelectorAll('.venue-nav')) {
    const unavailable = !managementMerchant(); link.classList.toggle('nav-unavailable', unavailable);
    if (unavailable) link.setAttribute('aria-disabled', 'true'); else link.removeAttribute('aria-disabled');
  }
  container.replaceChildren();
  if (state.user.role !== 'root' || !state.merchants.length) { container.append(el('span', 'merchant-name', merchantName())); return; }
  const select = el('select'); select.setAttribute('aria-label', '当前操作商户');
  const placeholder = el('option', '', '请选择商户'); placeholder.value = ''; select.append(placeholder);
  for (const merchant of state.merchants) { const option = el('option', '', merchant.name + ' · ' + (merchant.code || 'ID ' + merchant.id)); option.value = String(merchant.id); select.append(option); }
  select.value = String(state.merchantId || '');
  select.addEventListener('change', () => {
    const merchant = state.merchants.find(value => String(value.id) === select.value); if (!merchant || !selectManagementMerchant(merchant)) return;
    loadPage();
  });
  append(container, el('span', 'merchant-context-label', '当前商户'), select);
}
async function refreshMerchants() {
  if (state.user?.role !== 'root') return;
  const generation = ++state.merchantRefreshGeneration, actorId = state.user.id, loginGeneration = state.loginGeneration, merchantGeneration = state.merchantGeneration;
  const response = await api('/rental/admin/merchants');
  if (state.user?.role !== 'root' || state.user.id !== actorId || loginGeneration !== state.loginGeneration || generation !== state.merchantRefreshGeneration || merchantGeneration !== state.merchantGeneration) return;
  if (!Array.isArray(response.items)) throw new Error('商户列表响应无效');
  state.merchants = response.items;
  const merchant = state.merchants.find(value => String(value.id) === String(state.merchantId));
  if (merchant) state.merchant = merchant;
  else { if (state.merchantId) { if (state.page !== 'merchants') state.sequence++; state.merchantGeneration++; } state.merchant = null; state.merchantId = null; }
  renderMerchantContext();
}
function renderMerchants(content) {
  const list = el('div', 'merchant-grid');
  const statuses = { draft: ['待配置', 'amber'], active: ['已启用', 'green'], paused: ['已暂停', ''] };
  const merchants = state.user?.role === 'root' ? state.merchants : managementMerchant() ? [managementMerchant()] : [];
  for (const merchant of merchants) {
    const card = el('article', 'card merchant-card'); const head = el('div', 'card-heading');
    append(head, el('h2', '', merchant.name), badge(merchant.status, statuses));
    const details = el('dl', 'details');
    for (const [label, value] of [['商户编号', merchant.code], ['收款商户号', merchant.mchId || '待配置'], ['支付功能', merchant.paymentReady ? '已就绪' : '未就绪']]) append(details, el('dt', '', label), el('dd', '', value));
    const actions = el('div', 'merchant-actions');
    if (state.user.role === 'root') actions.append(button('编辑配置', () => merchantDialog(merchant.id), 'secondary', 'settings'));
    if (canManageBranding(state.user.role)) actions.append(button('品牌设置', () => { if (state.user.role === 'root' && !selectManagementMerchant(merchant)) return; navigate('branding'); }, 'secondary', 'settings'));
    actions.append(button(canManageVenues(state.user.role) ? '管理场地' : '查看场地', () => openMerchantVenues(merchant), 'secondary', 'home'));
    actions.append(button('进入商户', () => {
      if (state.user.role === 'root' && !selectManagementMerchant(merchant)) return;
      navigate('overview');
    }, 'text-button', 'chevron-right'));
    append(card, head, details, actions); list.append(card);
  }
  content.replaceChildren(el('p', 'notice', state.user.role === 'root' ? '商户下设场地，场地下绑定设备。请从商户卡片进入管理场地；各商户独立维护收款配置，统一使用平台小程序入口 d.4mr.cn。' : '这里只显示你所属商户。场地与设备均归属该商户，请在其下查看或管理场地。'), list);
  if (!merchants.length) content.append(el('p', 'empty', state.user.role === 'root' ? '尚未创建商户，请点击「新建商户」。' : '暂未取得所属商户，请重新登录后重试。'));
}
async function merchantDialog(id) {
  if (state.user?.role !== 'root') return;
  const ui = formDialog(id ? '编辑商户配置' : '新建商户', '保存商户');
  const actorId = state.user.id, loginGeneration = state.loginGeneration, merchantGeneration = state.merchantGeneration;
  const sameContext = () => state.user?.role === 'root' && state.user.id === actorId && state.loginGeneration === loginGeneration && state.merchantGeneration === merchantGeneration;
  const currentDraft = () => ui.node.open && sameContext();
  let merchant = {};
  if (id) {
    ui.form.append(el('div', 'loading', '正在读取商户配置…'));
    try { merchant = (await api('/rental/admin/merchants/' + encodeURIComponent(id))).merchant; if (!merchant) throw new Error('商户配置响应无效'); }
    catch (error) { ui.form.replaceChildren(message(error.message)); return; }
    if (!currentDraft()) return; ui.form.replaceChildren();
  }
  const name = field(ui.form, '商户名称', { required: true, maxLength: 128, value: merchant.name || '' });
  const code = field(ui.form, '商户编号', { required: true, maxLength: 64, value: merchant.code || '', placeholder: '例如 merchant2', help: '使用小写字母、数字、下划线或短横线。' });
  // Entry settings belong to an existing entry owner, never a business merchant
  // using that entry. Do not create irrelevant inputs or required constraints.
  const canManageEntry = Boolean(id) && !merchant.miniappOwnerId;
  const owners = canManageEntry ? state.merchants.filter(value => !value.miniappOwnerId && String(value.id) !== String(id)) : [];
  let entry, origin, appId, entryName, entryStatus;
  if (canManageEntry) {
    if (String(id) !== '1' && !owners.some(value => Number(value.id) === 1)) owners.unshift({ id: 1, name: '平台小程序', origin: 'https://d.4mr.cn', appId: 'wx03dbf50c15cac06f' });
    entry = field(ui.form, '小程序入口', { tag: 'select', help: '保留现有入口的维护能力；共用入口按设备绑定商户付款。' });
    for (const owner of owners) { const option = el('option', '', '共用：' + owner.name); option.value = String(owner.id); entry.append(option); }
    const independent = el('option', '', '独立小程序及域名（历史兼容）'); independent.value = ''; entry.append(independent); entry.value = '';
    origin = field(ui.form, '入口域名', { required: true, type: 'url', value: merchant.origin || '', placeholder: 'https://d.4mr.cn', help: '填写完整 HTTPS 来源，不含路径。' });
    appId = field(ui.form, '小程序 AppID', { required: true, maxLength: 32, value: merchant.appId || '', autoComplete: 'off' });
    entryName = field(ui.form, '入口名称', { maxLength: 128, value: merchant.entry?.name || merchant.name || '', placeholder: '默认使用商户名称，可独立维护' });
    entryStatus = field(ui.form, '新用户注册', { tag: 'select', help: '暂停仅限制新身份注册；已有身份仍可登录并查看历史。入口设置独立于商户经营状态。' });
    for (const [value, label] of [['active', '开放'], ['paused', '暂停']]) { const option = el('option', '', label); option.value = value; entryStatus.append(option); }
    entryStatus.value = merchant.entry?.status || 'active';
  } else {
    const sharedHost = (merchant.entry?.origin || merchant.origin || 'https://d.4mr.cn').replace(/^https:\/\//, '').replace(/\/$/, '');
    ui.form.append(el('p', 'notice', '共用平台小程序及 ' + sharedHost + '，无需配置域名、AppID、AppSecret。'));
  }
  const mchId = field(ui.form, '微信支付商户号', { maxLength: 32, value: merchant.mchId || '', autoComplete: 'off', help: '填写商户自己的收款账户。' });
  let status;
  if (id) {
    status = field(ui.form, '商户经营状态', { tag: 'select', help: '控制本商户经营服务，不影响平台小程序设置。' });
    for (const [value, label] of [['draft', '待配置'], ['active', '已启用'], ['paused', '已暂停']]) { const option = el('option', '', label); option.value = value; status.append(option); } status.value = merchant.status;
  }
  const enabledLabel = el('label', 'checkbox-field'); const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(merchant.payEnabled ?? merchant.paymentReady); append(enabledLabel, enabled, document.createTextNode('开放本商户微信支付')); ui.form.append(enabledLabel);
  const flags = merchant.configuration || {};
  ui.form.append(el('h3', '', canManageEntry ? '小程序入口与商户收款凭据' : '商户自己的收款账户及凭据'), el('p', 'notice', '支付商户号与支付凭据属于商户自己的收款账户。敏感凭据仅提交到服务端保存，页面不回显。编辑时留空保留原值；支付配置齐全后才能收款。'));
  const replacementLabel = el('label', 'checkbox-field'); const replacement = el('input'); replacement.type = 'checkbox'; append(replacementLabel, replacement, document.createTextNode('完整替换支付凭据（用于旧配置无法读取时恢复）')); ui.form.append(replacementLabel);
  const secretFields = {}, credentialFiles = [];
  let pendingCredentialFiles = 0;
  for (const [key, label, configured, multiline] of [
    ['appSecret', '小程序 AppSecret', flags.hasAppSecret],
    ['privateKey', '商户私钥（PEM）', flags.hasPrivateKey, true],
    ['apiV3Key', 'API v3 密钥', flags.hasApiV3Key],
    ['serialNo', '商户证书序列号', false],
    ['platformKeyId', '微信支付公钥 ID / 平台证书序列号', false],
    ['platformPublicKey', '微信支付公钥 / 平台证书（PEM）', flags.hasPlatformKeys, true],
  ]) {
    if (key === 'appSecret' && !canManageEntry) continue;
    secretFields[key] = field(ui.form, label, { ...(multiline ? { tag: 'textarea', rows: 4 } : { type: 'password' }), autoComplete: 'new-password', maxLength: multiline ? 16000 : 256, placeholder: configured ? '已配置；留空保留' : '填写配置值', help: configured ? '服务端已有配置。' : '' });
    if (!multiline) continue;
    const input = secretFields[key], upload = el('div', 'credential-upload'), fileInput = el('input'), feedback = el('small');
    fileInput.type = 'file'; fileInput.accept = key === 'privateKey' ? '.pem,.key' : '.pem,.crt,.cer';
    fileInput.setAttribute('aria-label', '从文件导入' + label);
    feedback.textContent = key === 'privateKey' ? '选择 apiclient_key.pem，或在上方粘贴私钥。' : '选择微信支付公钥或平台证书 PEM，并填写对应的 ID / 序列号。';
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    append(upload, fileInput, feedback); ui.form.append(upload); credentialFiles.push(fileInput);
    let readGeneration = 0;
    input.addEventListener('input', () => { readGeneration++; feedback.textContent = ''; fileInput.value = ''; });
    fileInput.addEventListener('change', async () => {
      const generation = ++readGeneration, file = fileInput.files?.[0];
      if (!file || !currentDraft() || ui.submit.disabled) return;
      const stillCurrent = () => generation === readGeneration && currentDraft() && !ui.submit.disabled;
      pendingCredentialFiles++; feedback.textContent = '正在读取文件…';
      try {
        if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16000) throw new Error('请选择不超过 16 KB 的 PEM 文本文件。');
        let value;
        try { value = await file.text(); } catch { throw new Error('无法读取文件，请重新选择或直接粘贴内容。'); }
        if (!stillCurrent()) return;
        value = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
        const pem = /^-----BEGIN ([A-Z ]+)-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----$/.exec(value);
        const allowed = key === 'privateKey' ? ['PRIVATE KEY', 'RSA PRIVATE KEY'] : ['PUBLIC KEY', 'RSA PUBLIC KEY', 'CERTIFICATE'];
        if (value.length > 16000 || !pem || !allowed.includes(pem[1])) throw new Error(key === 'privateKey' ? '请选择商户私钥 PEM 文件（apiclient_key.pem）。' : '请选择微信支付公钥或平台证书 PEM 文件。');
        input.value = value; feedback.textContent = '文件已读入，点击「保存商户」后提交。';
      } catch (error) { if (stillCurrent()) feedback.textContent = error.message; }
      finally { pendingCredentialFiles--; if (generation === readGeneration) fileInput.value = ''; }
    });
  }
  let updateEntry = () => {};
  if (canManageEntry) {
    const entryNotice = el('p', 'notice'); ui.form.append(entryNotice);
    let ownOrigin = origin.value, ownAppId = appId.value, ownEntryName = entryName.value, ownEntryStatus = entryStatus.value, shared = false;
    updateEntry = () => {
      if (!shared) { ownOrigin = origin.value; ownAppId = appId.value; ownEntryName = entryName.value; ownEntryStatus = entryStatus.value; }
      shared = entry.value !== '';
      const owner = owners.find(value => String(value.id) === entry.value);
      origin.disabled = appId.disabled = secretFields.appSecret.disabled = entryName.disabled = entryStatus.disabled = shared;
      origin.required = appId.required = !shared;
      origin.value = shared ? owner?.entry?.origin || owner?.origin || '' : ownOrigin;
      appId.value = shared ? owner?.entry?.appId || owner?.appId || '' : ownAppId;
      entryName.value = shared ? owner?.entry?.name || owner?.name || '' : ownEntryName;
      entryStatus.value = shared ? owner?.entry?.status || 'active' : ownEntryStatus;
      if (shared) secretFields.appSecret.value = '';
      entryNotice.textContent = shared ? '小程序登录由所选平台入口统一提供；商户自己的收款账户仍需单独配置。' : '入口 AppID、AppSecret 和域名仅由入口所属商户维护；收款账户仍按设备绑定的商户确定。';
    };
    entry.addEventListener('change', updateEntry); updateEntry();
  }
  ui.ready();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled || state.user?.role !== 'root') return; ui.error.textContent = '';
    if (!currentDraft()) { ui.error.textContent = '登录或商户范围已变化，请关闭后重新打开商户配置。'; return; }
    if (pendingCredentialFiles) { ui.error.textContent = '文件正在读取，请稍后保存。'; return; }
    const miniappOwnerId = canManageEntry ? entry.value === '' ? null : Number(entry.value) : id ? merchant.miniappOwnerId : 1;
    if (canManageEntry && miniappOwnerId !== null && (!Number.isSafeInteger(miniappOwnerId) || !owners.some(value => Number(value.id) === miniappOwnerId))) { ui.error.textContent = '请选择有效的小程序入口'; return; }
    let normalizedOrigin;
    if (miniappOwnerId === null) {
      try { const parsed = new URL(origin.value.trim()); if (parsed.protocol !== 'https:' || parsed.origin !== origin.value.trim() || parsed.username || parsed.password) throw Error(); normalizedOrigin = parsed.origin; }
      catch { ui.error.textContent = '入口域名须为完整 HTTPS 来源，例如 https://d.4mr.cn'; return; }
      if (!['active', 'paused'].includes(entryStatus.value)) { ui.error.textContent = '请选择有效的新用户注册状态'; return; }
    }
    if (!name.value.trim() || !/^[a-z][a-z0-9_-]{0,63}$/.test(code.value.trim()) || miniappOwnerId === null && !/^wx[a-f0-9]{16}$/.test(appId.value.trim())) { ui.error.textContent = miniappOwnerId === null ? '请核对商户名称、编号和小程序 AppID' : '请核对商户名称和编号'; return; }
    const credentials = {}; for (const [key, input] of Object.entries(secretFields)) if (!(miniappOwnerId !== null && key === 'appSecret') && input.value.trim()) credentials[key] = input.value.trim();
    if (replacement.checked && ['privateKey', 'apiV3Key', 'serialNo', 'platformKeyId', 'platformPublicKey'].some(key => !credentials[key])) { ui.error.textContent = '完整替换时请填写全部私钥、API v3密钥、证书序列号和微信支付验签公钥配置。'; return; }
    const payload = { name: name.value.trim(), code: code.value.trim(), miniappOwnerId, ...(miniappOwnerId === null ? { origin: normalizedOrigin, appId: appId.value.trim(), entryName: entryName.value.trim() || name.value.trim(), entryStatus: entryStatus.value } : {}), mchId: mchId.value.trim(), payEnabled: enabled.checked, ...(replacement.checked ? { replaceCredentials: true } : {}), ...(status ? { status: status.value } : {}), ...(Object.keys(credentials).length ? { credentials } : {}) };
    ui.busy(true);
    try {
      await api('/rental/admin/merchants' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload), beforeDispatch: () => { if (!currentDraft()) throw new Error('登录或商户范围已变化，请重新打开商户配置。'); } });
      for (const input of Object.values(secretFields)) input.value = '';
      if (!currentDraft()) return;
      ui.node.close(); toast(id ? '商户配置已保存' : '商户已创建，请完成商户自己收款账户的授权与支付配置'); await refreshMerchants(); if (!sameContext()) return; if (state.page === 'merchants') loadPage(); else navigate('merchants');
    } catch (error) { if (currentDraft()) ui.error.textContent = error.message; }
    finally { ui.busy(false); updateEntry(); }
  });
  ui.node.addEventListener('close', () => { for (const input of [...Object.values(secretFields), ...credentialFiles]) input.value = ''; }, { once: true });
}
async function transferDialog(kind, target) {
  if (kind !== 'devices' || state.user?.role !== 'root') return;
  const ui = formDialog('调拨设备', '确认分配');
  try { await refreshMerchants(); } catch (error) { ui.form.append(message(error.message)); return; }
  if (!ui.node.open || state.user?.role !== 'root') return;
  const sourceMerchant = state.merchantId;
  ui.form.append(el('p', 'notice', '当前商户：' + merchantName() + '。历史订单与资金记录保留原商户归属。'));
  const merchant = field(ui.form, '目标商户', { tag: 'select', required: true });
  for (const value of state.merchants.filter(value => String(value.id) !== String(sourceMerchant))) { const option = el('option', '', value.name + ' · ' + value.code); option.value = String(value.id); merchant.append(option); }
  merchant.value = merchant.querySelectorAll('option')[0]?.value || '';
  const venue = field(ui.form, '目标场地', { tag: 'select', required: true }), venueMessage = el('p', 'notice'); ui.form.append(venueMessage);
  let venueItems = [], venueGeneration = 0, venueLoading = false, loadedMerchantId = null;
  const loadTargetVenues = async () => {
    const generation = ++venueGeneration, targetId = Number(merchant.value); venueLoading = true; loadedMerchantId = null; venueItems = [];
    venue.replaceChildren(); venue.disabled = true; ui.submit.disabled = true;
    const placeholder = el('option', '', '正在读取目标商户场地…'); placeholder.value = ''; venue.append(placeholder); venue.value = ''; venueMessage.textContent = '';
    try {
      const items = await activeVenues(targetId);
      if (!ui.node.open || generation !== venueGeneration || Number(merchant.value) !== targetId) return;
      loadedMerchantId = targetId; venueItems = items; venue.replaceChildren();
      const empty = el('option', '', items.length ? '请选择目标商户场地' : '目标商户暂无可用场地'); empty.value = ''; venue.append(empty);
      for (const item of items) { const option = el('option', '', item.name); option.value = String(item.id); venue.append(option); }
      venue.value = items.length === 1 ? String(items[0].id) : '';
      venueMessage.textContent = items.length ? '设备调入所选场地，使用该场地的租金与押金。' : '请先切换至目标商户，在场地管理中创建并启用场地，再调拨设备。';
    } catch (error) { if (ui.node.open && generation === venueGeneration) venueMessage.textContent = error.message; }
    finally { if (ui.node.open && generation === venueGeneration) { venueLoading = false; venue.disabled = !venueItems.length; ui.submit.disabled = !venueItems.length; } }
  };
  merchant.addEventListener('change', loadTargetVenues);
  ui.form.append(el('p', 'notice', '设备须无进行中的租赁、待确认支付或未完成退款。调拨后暂停开放；共用同一小程序入口可保留二维码，切换独立入口需更换二维码。核对目标商户及费用后重新开放。'));
  const reason = field(ui.form, '分配原因', { tag: 'textarea', rows: 3, required: true, maxLength: 255 }); ui.ready();
  ui.submit.disabled = !merchant.querySelectorAll('option').length;
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled || state.user?.role !== 'root') return; ui.error.textContent = '';
    if (String(state.merchantId) !== String(sourceMerchant)) { ui.error.textContent = '当前商户已变化，请关闭后重新操作'; return; }
    const merchantId = Number(merchant.value), venueId = Number(venue.value);
    if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || merchantId === Number(sourceMerchant) || !reason.value.trim()) { ui.error.textContent = '请选择目标商户并填写原因'; return; }
    if (venueLoading || loadedMerchantId !== merchantId || !venueItems.some(item => item.id === venueId)) { ui.error.textContent = '请选择目标商户的有效场地'; return; }
    ui.busy(true);
    try {
      const result = await write('/rental/admin/devices/' + encodeURIComponent(target.id) + '/merchant', { merchantId, venueId, reason: reason.value.trim() });
      ui.node.close(); toast(result.requiresNewQr === false ? '设备已调拨并暂停开放，原二维码可继续使用；请核对目标商户及费用后重新开放' : '设备已调拨并暂停开放，请更换目标入口二维码、核对费用后重新开放'); loadPage();
    } catch (error) { ui.error.textContent = error.message; }
    finally { ui.busy(false); venue.disabled = !venueItems.length; ui.submit.disabled = venueLoading || !venueItems.length; }
  });
  if (merchant.value) await loadTargetVenues();
}
function roleDialog(user) {
  const allowed = assignableRoles(state.user, user);
  if (!allowed.length) { toast('当前身份不能修改该账号'); return; }
  const root = state.user.role === 'root', actorId = state.user.id, actorRole = state.user.role, loginGeneration = state.loginGeneration, merchantGeneration = state.merchantGeneration;
  const ui = formDialog('管理用户身份', '确认变更');
  const currentDraft = () => ui.node.open && state.user?.id === actorId && state.user?.role === actorRole && state.loginGeneration === loginGeneration && state.merchantGeneration === merchantGeneration;
  ui.form.append(el('p', 'role-copy', userIdentity(user) + '当前身份：' + roleLabel(user.role) + '。' + (root ? '选择所属商户与身份后直接生效，无需员工确认。历史订单与资金记录保留原商户归属。' : '你只能在普通用户与设备管理员之间变更身份，所属商户保持不变。')));
  const target = field(ui.form, '目标身份', { tag: 'select', required: true });
  for (const role of allowed) { const option = el('option', '', roleLabel(role)); option.value = role; target.append(option); }
  target.value = user.role;
  let merchant;
  const merchantChoices = (state.merchants.length ? state.merchants : state.merchant ? [state.merchant] : []).filter(value => value.status === 'active');
  if (root) {
    merchant = field(ui.form, '所属商户', { tag: 'select', required: true, help: '设备管理员与商户管理员仅管理所选商户；普通用户不保留员工归属。' });
    const placeholder = el('option', '', merchantChoices.length ? '请选择所属商户' : '暂无可用商户，请先启用商户'); placeholder.value = ''; merchant.append(placeholder);
    for (const value of merchantChoices) { const option = el('option', '', merchantLabel(value)); option.value = String(value.id); merchant.append(option); }
    const preferred = merchantChoices.find(value => value.id === user.merchantId) || merchantChoices.find(value => value.id === state.merchantId);
    merchant.value = preferred ? String(preferred.id) : '';
  }
  const permission = el('p', 'role-copy'); ui.form.append(permission);
  const effect = el('p', 'notice role-change-notice'); ui.form.append(effect);
  const reason = field(ui.form, '变更原因', { tag: 'textarea', maxLength: 255, rows: 3, required: true, placeholder: '填写授权、调整归属或撤销原因，将记录到操作审计' });
  const acknowledgement = el('label', 'checkbox-field'); const checked = el('input'); checked.type = 'checkbox'; checked.required = true;
  append(acknowledgement, checked, el('span', '', root ? '我已核对目标账号、所属商户及身份权限。' : '我已核对目标账号及所选身份的权限范围。')); ui.form.append(acknowledgement); ui.ready();
  const validMerchant = () => !root || target.value === 'user' || merchantChoices.some(value => value.id === Number(merchant.value));
  const changed = () => allowed.includes(target.value) && (target.value !== user.role || root && target.value !== 'user' && Number(merchant.value) !== Number(user.merchantId));
  const update = () => {
    const next = Object.hasOwn(roles, target.value) ? roles[target.value] : null, hasChange = changed();
    const demotion = hasChange && next.rank < roles[user.role].rank;
    permission.textContent = next ? next.description : '请选择当前权限允许的身份。';
    if (merchant) merchant.disabled = target.value === 'user';
    const selected = root && merchantChoices.find(value => value.id === Number(merchant.value));
    effect.textContent = !hasChange ? '选择新的身份或所属商户后，核对权限范围并填写变更原因。' : '将从「' + roleLabel(user.role) + '」调整为「' + roleLabel(target.value) + '」。' + (root ? target.value === 'user' ? '确认后撤销员工归属。' : '所属商户：' + (selected ? selected.name : '待选择') + '。' : '') + (demotion ? '确认后，该账号的后续请求将立即按降低后的权限校验。' : '确认后直接生效，请只向可信任人员授权。');
    ui.submit.querySelector('span').textContent = hasChange ? demotion ? '确认降低权限' : root ? '确认商户与身份' : '确认提升权限' : '确认变更';
    ui.submit.classList.toggle('danger-button', demotion);
    ui.submit.disabled = !currentDraft() || !hasChange || !validMerchant() || !checked.checked;
  };
  const change = () => { checked.checked = false; update(); };
  target.addEventListener('change', change); if (merchant) merchant.addEventListener('change', change); checked.addEventListener('change', update); update();
  ui.form.addEventListener('submit', async event => {
    event.preventDefault(); if (ui.submit.disabled) return; ui.error.textContent = '';
    const nextRole = target.value;
    if (!currentDraft()) { ui.error.textContent = '登录或商户范围已变化，请重新打开身份管理。'; return; }
    if (!assignableRoles(state.user, user).includes(nextRole) || !changed() || !validMerchant() || !checked.checked) { ui.error.textContent = '请重新核对所属商户、目标身份与权限范围'; return; }
    if (!reason.value.trim()) { ui.error.textContent = '请填写权限变更原因'; return; }
    const path = '/rental/admin/users/' + encodeURIComponent(user.id) + (root ? '/merchant' : '/role');
    const payload = { role: nextRole, reason: reason.value.trim(), ...(root ? { merchantId: nextRole === 'user' ? Number(user.merchantId || state.merchantId) : Number(merchant.value) } : {}) }; ui.busy(true);
    try {
      await api(path, { method: root ? 'POST' : 'PUT', body: JSON.stringify(payload), beforeDispatch: () => { if (!currentDraft()) throw new Error('登录或商户范围已变化，请重新打开身份管理。'); } });
      if (!currentDraft()) return;
      ui.node.close(); toast(root ? nextRole === 'user' ? '已撤销员工身份' : '所属商户与身份已更新' : '已调整为' + roleLabel(nextRole)); loadPage();
    } catch (error) { if (currentDraft()) ui.error.textContent = error.message; }
    finally { ui.busy(false); update(); }
  });
}
boot();
