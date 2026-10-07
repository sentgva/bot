// Админка: выводы, заявки на продажу, выводы скинов, игроки, настройки экономики.
import { $, $$, api, confirmDialog, dateTime, emptyState, esc, lc, rub, session, toast, toastError, withLoading } from './core.js';

let tab = 'withdrawals';
let status = 'open';
const STATUS_LABEL = {
  review: 'На проверке', processing: 'В обработке', sending: 'Отправляется (проверь чеки в @CryptoBot!)', paid: 'Выплачено', rejected: 'Отклонено',
  new: 'Новая', in_work: 'В работе', done: 'Завершена', sent: 'Отправлен', refunded: 'Возвращён',
};

async function overview() {
  const o = await api('/api/admin/overview');
  $('[data-overview]').innerHTML = [
    ['Выводов ждут', o.withdrawals], ['Выводов скинов', o.skin_withdrawals],
    ['Балансы игроков', lc(o.total_balance)], ['Пополнено', lc(o.deposits)], ['Выплачено', lc(o.payouts)], ['Игроков', o.users],
  ].map(([l, v]) => `<div class="stat"><p class="stat-value">${esc(String(v))}</p><p class="stat-label">${l}</p></div>`).join('');
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
    return list.map((u) => `<div class="list-item" data-id="${u.id}">
      <div class="grow"><p><b>${esc(u.name)}</b> ${u.is_banned ? '<span class="badge">Бан</span>' : ''}</p>
      <p class="small muted">ID ${u.id} · ${tgLink(u)} · был ${dateTime(u.last_seen_at)}</p></div>
      <span class="amount">${lc(u.balance)}</span>
      ${btn('adjust', 'Начислить / списать LC')}${btn(u.is_banned ? 'unban' : 'ban', u.is_banned ? 'Разбанить' : 'Забанить')}
    </div>`);
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

// Действия по кнопкам в списках
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  const action = b.dataset.action;
  let body = { action };
  let url = { withdrawals: `/api/admin/withdrawals/${id}`, skins: `/api/admin/skin-withdrawals/${id}`, users: `/api/admin/users/${id}` }[tab];

  if (action === 'reject' || action === 'refunded') {
    const note = prompt('Причина (увидит игрок в истории):', '');
    if (note === null) return;
    body.note = note;
  } else if (action === 'adjust') {
    const amount = prompt('Сколько LC начислить? Целое число, минус — списать (например 5000 или -300):', '1000');
    if (!amount) return;
    const lcAmount = Number(amount.replace(/\s/g, ''));
    if (!Number.isInteger(lcAmount) || lcAmount === 0) { toast('Нужно целое число LC', 'error'); return; }
    const note = prompt('Причина (игрок увидит её в истории баланса):', lcAmount > 0 ? 'Бонус от LuxeDrop' : 'Корректировка');
    if (!note) return;
    body = { action, amount: lcAmount, note };
  } else if (action === 'paid' || action === 'send' || action === 'ban') {
    const ok = await confirmDialog({
      title: { paid: 'Отметить как выплачено?', send: 'Создать чек в @CryptoBot?', ban: 'Забанить игрока?' }[action],
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

// Настройки экономики
const SETTINGS = [
  ['houseEdge', 'Комиссия апгрейдера (доля, 0.05 = 5%)'], ['maxChance', 'Максимальный шанс (доля)'], ['minChance', 'Минимальный шанс (доля)'],
  ['maxUpgradeItems', 'Скинов в одном апгрейде'], ['minUpgradeValue', 'Мин. ставка апгрейда, коп.'], ['marketMarkup', 'Наценка маркета (доля)'],
  ['siteSellRate', 'Продажа скина с сайта (доля цены)'], ['cardFee', 'Комиссия карта/СБП (доля)'],
  ['cryptoFee', 'Комиссия крипта (доля)'], ['minWithdraw', 'Мин. вывод, коп.'], ['maxWithdraw', 'Макс. вывод, коп.'], ['minDeposit', 'Мин. пополнение, коп.'],
  ['cryptoAutoLimit', 'Авто-вывод крипты до, коп.'], ['statsMinPaid', 'Показывать «выплачено» от, коп.'], ['bestDropMaxPrice', '«Лучший дроп» не дороже, коп.'],
];
async function loadSettings() {
  const s = await api('/api/admin/settings');
  const form = $('[data-settings-form]');
  form.innerHTML = `<div class="grid grid-3">${SETTINGS.map(([k, label]) => `
    <div class="field"><label for="s-${k}">${label}</label><input class="input num" id="s-${k}" name="${k}" type="number" step="any" value="${esc(s[k])}" aria-describedby="s-${k}-error"><p class="error" id="s-${k}-error"></p></div>`).join('')}</div>
    <button class="btn btn-primary" type="submit">Сохранить настройки</button>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(SETTINGS.map(([k]) => [k, form.elements[k].value]));
    try {
      const r = await api('/api/admin/settings', { method: 'POST', body });
      $$('.error', form).forEach((el) => { el.textContent = ''; });
      for (const [k, msg] of Object.entries(r.errors)) $(`#s-${k}-error`).textContent = `Допустимо ${msg}`;
      toast(Object.keys(r.errors).length ? 'Часть настроек не сохранена — проверь ошибки' : 'Настройки сохранены', Object.keys(r.errors).length ? 'error' : 'success');
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

const { user: me } = await session();
if (!me?.isAdmin) {
  $('[data-denied]').hidden = false;
} else {
  $('[data-app]').hidden = false;
  overview();
  load();
}
