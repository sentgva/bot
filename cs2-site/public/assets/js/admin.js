// Админ-панель: сводка, игроки (карточка, выдача LC, бан), выводы денег и скинов, настройки экономики.
import { $, $$, api, confirmDialog, dateTime, emptyState, esc, lc, rub, session, setBalance, toast, toastError, withLoading } from './core.js';

let tab = 'users';
let me = null;
let currentUserId = null;
let status = 'open';
const STATUS_LABEL = {
  review: 'На проверке', processing: 'В обработке', sending: 'Отправляется (проверь чеки в @CryptoBot!)', paid: 'Выплачено', rejected: 'Отклонено',
  new: 'Новая', in_work: 'В работе', done: 'Завершена', sent: 'Отправлен', refunded: 'Возвращён',
};

async function overview() {
  const o = await api('/api/admin/overview');
  const stat = (label, value, hint = '', tone = '') => `<div class="adm-stat${tone ? ` is-${tone}` : ''}"><p class="adm-stat-label">${label}</p><p class="adm-stat-value">${esc(String(value))}</p>${hint ? `<p class="adm-stat-hint">${hint}</p>` : ''}</div>`;
  const profit = (v) => (v >= 0 ? 'good' : 'bad');
  $('[data-overview]').innerHTML = [
    stat('Игроков', o.users.toLocaleString('ru-RU'), `+${o.users_day} за сутки`),
    stat('Балансы игроков', lc(o.total_balance), 'сейчас на счетах'),
    stat('Пополнено', lc(o.deposits), 'звёзды и крипта'),
    stat('Выплачено', lc(o.payouts), `ждут вывода: ${o.withdrawals}`, o.withdrawals ? 'warn' : ''),
    stat('Доход с кейсов', lc(o.cases_profit), `открыто ${o.cases_opened.toLocaleString('ru-RU')}`, profit(o.cases_profit)),
    stat('Доход с апгрейдов', lc(o.upgrades_profit), `бросков ${o.upgrades.toLocaleString('ru-RU')}`, profit(o.upgrades_profit)),
    stat('Выдано вручную', lc(o.granted), 'бонусы и начисления'),
  ].join('');
  for (const k of ['withdrawals', 'skin_withdrawals']) $(`[data-count="${k}"]`).textContent = o[k] || '';
}

// Игрок: имя и ссылка на Telegram
const tgLink = (r) => (r.tg_username ? `<a href="https://t.me/${esc(r.tg_username)}" target="_blank" rel="noopener" class="small">@${esc(r.tg_username)}</a>` : r.telegram_id ? `<span class="small muted">TG ${esc(r.telegram_id)}</span>` : '');
const user = (r) => `${esc(r.user_name || 'гость')} ${tgLink(r)}`;
const btn = (action, label, cls = 'btn-secondary') => `<button class="btn ${cls} btn-sm" type="button" data-action="${action}">${label}</button>`;

const RENDER = {
  async withdrawals() {
    const list = await api(`/api/admin/withdrawals?status=${status}`);
    return list.map((p) => {
      const d = p.details;
      const where = p.method === 'card' ? `Карта: <b class="mono">${esc(d.cardFull || d.card)}</b>`
        : p.method === 'sbp' ? `СБП: <b>${esc(d.phone)}</b>, ${esc(d.bank)}` : `Крипта: ${esc(d.asset)}${d.checkUrl ? ` · <a href="${esc(d.checkUrl)}" target="_blank" rel="noopener">чек</a>` : ''}`;
      const open = ['review', 'processing', 'sending'].includes(p.status);
      return `<div class="list-item" data-id="${p.id}">
        <div class="grow"><p><b>#${p.id} · ${rub(p.amount - p.fee)} к выплате</b> <span class="small muted">(списано ${lc(p.amount)}, комиссия ${rub(p.fee)})</span></p>
        <p class="small">${where}</p><p class="small muted">${user(p)} · ${dateTime(p.created_at)} · ${esc(STATUS_LABEL[p.status] || p.status)}${d.error ? ` · ошибка: ${esc(d.error)}` : ''}</p></div>
        ${open ? `${p.method === 'crypto' && p.status !== 'sending' ? btn('send', 'Отправить чек', 'btn-primary') : ''}${btn('paid', 'Выплачено', p.method === 'crypto' ? 'btn-secondary' : 'btn-primary')}${btn('reject', 'Отклонить')}` : ''}
      </div>`;
    });
  },
  async skins() {
    const list = await api(`/api/admin/skin-withdrawals?status=${status}`);
    return list.map((w) => `<div class="list-item" data-id="${w.id}">
      <div class="grow"><p><b>#${w.id} · ${esc(w.hash_name)}</b> · ${lc(w.price)}</p>
      <p class="small"><a href="${esc(w.trade_url)}" target="_blank" rel="noopener">Трейд-ссылка</a>${w.error ? ` · ошибка: ${esc(w.error)}` : ''}</p>
      <p class="small muted">${user(w)} · ${dateTime(w.created_at)} · ${esc(STATUS_LABEL[w.status])}</p></div>
      ${['review', 'processing'].includes(w.status) ? `${btn('sent', 'Отправлен', 'btn-primary')}${btn('refunded', 'Вернуть на сайт')}` : ''}
    </div>`);
  },
  async users() {
    const list = await api(`/api/admin/users?q=${encodeURIComponent($('#u-q').value)}`);
    return list.map((u) => `<button type="button" class="list-item adm-row${String(u.id) === String(currentUserId) ? ' is-active' : ''}" data-user="${u.id}">
      <div class="grow"><p><b>${esc(u.name)}</b> ${u.is_banned ? '<span class="badge">Бан</span>' : ''}</p>
      <p class="small muted">ID ${u.id} · ${u.tg_username ? '@' + esc(u.tg_username) : 'TG ' + esc(u.telegram_id || '—')} · был ${dateTime(u.last_seen_at)}</p></div>
      <span class="amount">${lc(u.balance)}</span>
    </button>`);
  },
};

async function load() {
  $('[data-status-filter]').hidden = tab === 'users' || tab === 'settings';
  if (tab === 'settings') return loadSettings();
  const box = $(`[data-list="${tab}"]`);
  try {
    const rows = await RENDER[tab]();
    box.innerHTML = rows.length ? rows.join('') : emptyState({ iconName: 'i-circle-check', title: 'Пусто', text: 'Здесь ничего нет — можно выдохнуть.' });
  } catch (err) { toastError(err); }
}

const KIND = {
  deposit: 'Пополнение', withdraw: 'Вывод', refund: 'Возврат', buy: 'Покупка', sell: 'Продажа', upgrade: 'Апгрейд', buyback: 'Выкуп',
  admin: 'Админ', demo: 'Тест', bonus: 'Бонус', case: 'Кейс',
};
const QUICK = [100, 1000, 10000, 50000];

async function openUser(id) {
  currentUserId = id;
  $$('[data-user]').forEach((r) => r.classList.toggle('is-active', r.dataset.user === String(id)));
  const card = $('[data-user-card]');
  card.innerHTML = '<p class="muted">Загружаем…</p>';
  try {
    const { user: u, stats: st, ledger } = await api(`/api/admin/users/${id}`);
    const row = (l, v) => `<div><dt>${l}</dt><dd>${v}</dd></div>`;
    card.innerHTML = `
      <div class="adm-user-head">
        ${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="" width="48" height="48">` : `<span class="avatar avatar-fallback" aria-hidden="true">${esc(u.name.slice(0, 1).toUpperCase())}</span>`}
        <div class="grow"><p class="h3">${esc(u.name)} ${u.is_banned ? '<span class="badge">Бан</span>' : ''}${me && String(me.id) === String(u.id) ? ' <span class="badge badge-success">Это вы</span>' : ''}</p>
        <p class="small muted">ID ${u.id} · ${u.tg_username ? `<a href="https://t.me/${esc(u.tg_username)}" target="_blank" rel="noopener">@${esc(u.tg_username)}</a>` : 'без ника'} · TG ${esc(u.telegram_id || '—')}</p></div>
      </div>
      <p class="adm-balance">${lc(u.balance)}</p>
      <form class="adm-grant" data-grant novalidate>
        <div class="chips">${QUICK.map((v) => `<button type="button" class="chip" data-quick="${v}">+${v.toLocaleString('ru-RU')}</button>`).join('')}</div>
        <div class="row">
          <div class="input-group grow-1"><input class="input num" name="amount" type="number" inputmode="numeric" step="1" min="1" placeholder="Сумма" aria-label="Сумма в LC" required><span class="suffix" aria-hidden="true">LC</span></div>
          <input class="input grow-1" name="note" type="text" maxlength="200" value="Бонус от LuxeDrop" aria-label="Причина (игрок увидит в истории)">
        </div>
        <div class="row">
          <button class="btn btn-primary" type="submit" data-sign="1" data-loading="Начисляем…">Начислить</button>
          <button class="btn btn-secondary" type="submit" data-sign="-1" data-loading="Списываем…">Списать</button>
          <button class="btn btn-ghost" type="button" data-ban="${u.is_banned ? 'unban' : 'ban'}">${u.is_banned ? 'Разбанить' : 'Забанить'}</button>
        </div>
      </form>
      <dl class="adm-facts">
        ${row('Пополнил', lc(st.deposits))}${row('Вывел', lc(st.withdrawn))}${row('Выдано админом и бонусами', lc(st.granted))}
        ${row('Апгрейдов', `${st.upgrades} (побед ${st.upgrades_won})`)}${row('Кейсов открыто', st.cases)}${row('Скинов в инвентаре', `${st.items} · ${lc(st.items_value)}`)}
        ${row('Зарегистрирован', dateTime(u.created_at))}${row('Последний вход', dateTime(u.last_seen_at))}
      </dl>
      <h3 class="h3 mt-6 mb-2">История баланса</h3>
      <div class="adm-ledger">${ledger.length ? ledger.map((l) => `<div class="adm-ledger-row"><span class="badge">${esc(KIND[l.kind] || l.kind)}</span>
        <span class="grow small">${esc(l.note || '')} <span class="muted">${dateTime(l.created_at)}</span></span>
        <span class="amount ${l.amount > 0 ? 'is-plus' : 'is-minus'}">${l.amount > 0 ? '+' : '−'}${lc(Math.abs(l.amount))}</span></div>`).join('') : '<p class="muted small">Операций ещё не было</p>'}</div>`;
  } catch (err) { card.innerHTML = ''; toastError(err); }
}

// Выдача и списание LC, бан — внутри карточки игрока
$('[data-user-card]').addEventListener('click', async (e) => {
  const q = e.target.closest('[data-quick]');
  if (q) { $('[data-grant]').elements.amount.value = q.dataset.quick; return; }
  const ban = e.target.closest('[data-ban]');
  if (!ban) return;
  if (ban.dataset.ban === 'ban' && !(await confirmDialog({ title: 'Забанить игрока?', html: '<p>Он не сможет войти, пока вы его не разбаните.</p>', confirm: 'Забанить' }))) return;
  await withLoading(ban, async () => {
    try { await api(`/api/admin/users/${currentUserId}`, { method: 'POST', body: { action: ban.dataset.ban } }); toast('Готово', 'success'); openUser(currentUserId); load(); } catch (err) { toastError(err); }
  });
});
$('[data-user-card]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('[data-grant]');
  const btn = e.submitter;
  const value = Number(form.elements.amount.value);
  if (!Number.isInteger(value) || value <= 0) { toast('Введи целое число LC больше нуля', 'error'); form.elements.amount.focus(); return; }
  const note = form.elements.note.value.trim() || (btn.dataset.sign === '1' ? 'Бонус от LuxeDrop' : 'Корректировка');
  const amount = value * Number(btn.dataset.sign);
  await withLoading(btn, async () => {
    try {
      await api(`/api/admin/users/${currentUserId}`, { method: 'POST', body: { action: 'adjust', amount, note } });
      toast(`${amount > 0 ? 'Начислено' : 'Списано'} ${lc(Math.abs(amount) * 100)}`, 'success');
      if (me && String(me.id) === String(currentUserId)) setBalance((await api('/api/me')).user.balance);
      openUser(currentUserId);
      overview();
      load();
    } catch (err) { toastError(err); }
  });
});
$('[data-list="users"]').addEventListener('click', (e) => { const r = e.target.closest('[data-user]'); if (r) openUser(r.dataset.user); });
$('[data-me]').addEventListener('click', () => { if (me) openUser(me.id); });

// Действия по кнопкам в списках
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-list] [data-action]');
  if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  const action = b.dataset.action;
  const body = { action };
  const url = { withdrawals: `/api/admin/withdrawals/${id}`, skins: `/api/admin/skin-withdrawals/${id}` }[tab];
  if (!url) return;

  if (action === 'reject' || action === 'refunded') {
    const note = prompt('Причина (увидит игрок в истории):', '');
    if (note === null) return;
    body.note = note;
  } else if (action === 'paid' || action === 'send') {
    const ok = await confirmDialog({
      title: { paid: 'Отметить как выплачено?', send: 'Создать чек в @CryptoBot?' }[action],
      html: action === 'paid' ? '<p>Убедись, что деньги действительно отправлены. Отменить нельзя.</p>' : '',
    });
    if (!ok) return;
  }
  await withLoading(b, async () => {
    try {
      const r = await api(url, { method: 'POST', body });
      toast(r.checkUrl ? 'Чек создан и отправлен игроку' : 'Готово', 'success');
      overview();
      load();
    } catch (err) { toastError(err); }
  });
});

// Настройки экономики: в базе доли и сотые LC, в форме — проценты и LC
const SETTINGS = [
  ['Апгрейдер', [
    ['maxChance', 'Максимальный шанс', 'pct', 'Можно до 100%'], ['minChance', 'Минимальный шанс', 'pct', 'Можно 0% — без нижней границы'],
    ['houseEdge', 'Комиссия апгрейдера', 'pct', 'Шанс = ставка ÷ цель × (1 − комиссия)'], ['minUpgradeValue', 'Минимальная ставка', 'lc'],
    ['maxUpgradeItems', 'Скинов в одном апгрейде', 'num'],
  ]],
  ['Кейсы', [['caseEdge', 'Край кейсов', 'pct', '10% — средний дроп 90% цены кейса']]],
  ['Бонусы', [['signupBonus', 'Стартовый бонус новым игрокам', 'lc', '0 — выключен']]],
  ['Маркет', [['marketMarkup', 'Наценка маркета', 'pct'], ['siteSellRate', 'Продажа скина сайту', 'pct', 'Доля от цены скина']]],
  ['Пополнение и вывод', [
    ['lcPerStar', 'LC за 1 звезду', 'num'], ['minStars', 'Мин. пополнение звёздами', 'num'], ['maxStars', 'Макс. пополнение звёздами', 'num'],
    ['minDeposit', 'Мин. пополнение криптой', 'lc'], ['minWithdraw', 'Мин. вывод', 'lc'], ['maxWithdraw', 'Макс. вывод за раз', 'lc'],
    ['cardFee', 'Комиссия карта / СБП', 'pct'], ['cryptoFee', 'Комиссия крипта', 'pct'], ['cryptoAutoLimit', 'Авто-вывод крипты до', 'lc'],
  ]],
  ['Главная', [['bestDropMaxPrice', '«Лучший дроп» не дороже', 'lc'], ['statsMinPaid', 'Показывать «выплачено» от', 'lc']]],
];
const UNIT = { pct: '%', lc: 'LC', num: '' };
const toForm = (v, u) => (u === 'pct' ? Math.round(v * 1e6) / 1e4 : u === 'lc' ? v / 100 : v);
const fromForm = (v, u) => (u === 'pct' ? Number(v) / 100 : u === 'lc' ? Math.round(Number(v) * 100) : Number(v));

async function loadSettings() {
  const s = await api('/api/admin/settings');
  const form = $('[data-settings-form]');
  form.innerHTML = SETTINGS.map(([title, fields]) => `
    <fieldset class="card adm-group"><legend class="h3">${title}</legend><div class="grid grid-3">${fields.map(([k, label, u, hint]) => `
      <div class="field"><label for="s-${k}">${label}</label>
        <div class="input-group"><input class="input num" id="s-${k}" name="${k}" type="number" step="any" value="${esc(toForm(s[k], u))}" aria-describedby="s-${k}-error${hint ? ` s-${k}-hint` : ''}">${UNIT[u] ? `<span class="suffix" aria-hidden="true">${UNIT[u]}</span>` : ''}</div>
        ${hint ? `<p class="hint" id="s-${k}-hint">${hint}</p>` : ''}<p class="error" id="s-${k}-error"></p></div>`).join('')}</div></fieldset>`).join('')
    + '<div class="adm-save"><button class="btn btn-primary btn-lg" type="submit">Сохранить настройки</button></div>';
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(SETTINGS.flatMap(([, f]) => f).map(([k, , u]) => [k, fromForm(form.elements[k].value, u)]));
    try {
      const r = await api('/api/admin/settings', { method: 'POST', body });
      $$('.error', form).forEach((el) => { el.textContent = ''; });
      const unitOf = Object.fromEntries(SETTINGS.flatMap(([, f]) => f).map(([k, , u]) => [k, u]));
      for (const [k, msg] of Object.entries(r.errors)) {
        const [lo, hi] = msg.replace('от ', '').split(' до ').map(Number);
        $(`#s-${k}-error`).textContent = `Допустимо от ${toForm(lo, unitOf[k])} до ${toForm(hi, unitOf[k])} ${UNIT[unitOf[k]]}`;
      }
      const bad = Object.keys(r.errors).length;
      toast(bad ? 'Часть настроек не сохранена — проверь ошибки' : 'Настройки сохранены', bad ? 'error' : 'success');
    } catch (err) { toastError(err); }
  };
}

// Вкладки и фильтр
$$('[role="tab"]').forEach((t) => t.addEventListener('click', () => {
  tab = t.dataset.tab;
  $$('[role="tab"]').forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; $(`#${x.getAttribute('aria-controls')}`).hidden = !on; });
  load();
}));
$('[data-status-filter]').addEventListener('click', (e) => {
  const c = e.target.closest('[data-status]');
  if (!c) return;
  status = c.dataset.status;
  $$('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
  load();
});
$('[data-user-search]').addEventListener('submit', (e) => { e.preventDefault(); load(); });

({ user: me } = await session());
if (!me?.isAdmin) {
  $('[data-denied]').hidden = false;
} else {
  $('[data-app]').hidden = false;
  overview();
  load();
}
