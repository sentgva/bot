// Профиль: вкладки, инвентарь на сайте, пополнение и вывод, история, апгрейды, настройки.
import {
  $, $$, api, confirmDialog, dateTime, emptyState, esc, icon, loginUrl, pct, refreshSession, rub, session, setBalance,
  skinCard, toast, toastError, withLoading,
} from './core.js';
import { TRADE_URL, formatCard, isCard, isPhone, liveValidate, maskPhone } from './forms.js';

let user;
let cfg;

// ── Вкладки (WAI-ARIA tabs: стрелки, Home/End, адрес #вкладка) ──

const tabs = $$('[role="tab"]');
const loaders = {};
const loaded = new Set();

function openTab(name, { focus = false, push = true } = {}) {
  const tab = tabs.find((t) => t.dataset.tab === name) || tabs[0];
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
  });
  if (focus) tab.focus();
  if (push) history.replaceState(null, '', `#${tab.dataset.tab}`);
  if (!loaded.has(tab.dataset.tab)) { loaded.add(tab.dataset.tab); loaders[tab.dataset.tab]?.(); }
}

tabs.forEach((t, i) => {
  t.addEventListener('click', () => openTab(t.dataset.tab));
  t.addEventListener('keydown', (e) => {
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    openTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
});
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-goto]');
  if (!link) return;
  e.preventDefault();
  openTab(link.dataset.goto, { focus: true });
  $('.tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
addEventListener('hashchange', () => openTab(location.hash.slice(1), { push: false }));

// ── Шапка профиля ──────────────────────────────────────────

function renderHead() {
  $('[data-name]').textContent = user.name;
  $('[data-steam-id]').textContent = user.steamId;
  $('[data-avatar]').innerHTML = user.avatar
    ? `<img class="avatar" src="${esc(user.avatar)}" alt="" width="72" height="72">`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${esc(user.name.slice(0, 1).toUpperCase())}</span>`;
  updateBalance(user.balance);
  $('[data-no-trade]').hidden = Boolean(user.tradeUrl);
  $('[data-admin-link]').hidden = !user.isAdmin;
}

function updateBalance(kop) {
  user.balance = kop;
  $('[data-balance-exact]').textContent = rub(kop, { exact: true });
  setBalance(kop);
  updateWithdrawSummary();
}

// ── Инвентарь ──────────────────────────────────────────────

let owned = [];
loaders.inventory = async () => {
  const grid = $('[data-owned]');
  owned = await api('/api/inventory').catch(() => []);
  grid.innerHTML = owned.length
    ? owned.map((i) => skinCard(i, {
      tag: i.status === 'withdrawing' ? '<span class="badge badge-warning">Выводится</span>' : '',
      actions: i.status === 'owned'
        ? `<button class="btn btn-secondary btn-sm" type="button" data-sell="${i.id}" aria-label="Продать ${esc(i.name)} за ${rub(i.sellPrice)}">Продать ${rub(i.sellPrice)}</button>
           <button class="btn btn-ghost btn-sm" type="button" data-withdraw="${i.id}" aria-label="Вывести ${esc(i.name)} в Steam">${icon('i-arrow-up-right')}<span class="sr-only">В Steam</span></button>`
        : '',
    })).join('')
    : `<div class="empty-wrap">${emptyState({
      iconName: 'i-package', title: 'Скинов на сайте пока нет',
      text: 'Купи скин в маркете или выиграй его в апгрейдере.',
      action: '<div class="row justify-center"><a class="btn btn-primary btn-sm" href="/market/">Маркет</a><a class="btn btn-secondary btn-sm" href="/upgrade/">Апгрейдер</a></div>',
    })}</div>`;
  const wd = await api('/api/me/skin-withdrawals').catch(() => []);
  const WD = { review: ['Готовим обмен', 'badge-warning'], processing: ['Отправляем', 'badge-blue'], sent: ['Отправлен', 'badge-success'], refunded: ['Возвращён на сайт', ''] };
  $('[data-skin-wd-box]').hidden = !wd.length;
  $('[data-skin-wd]').innerHTML = wd.map((w) => `
    <div class="list-item"><div class="grow"><p><b>${esc(w.hash_name)}</b></p><p class="small muted">${dateTime(w.created_at)}</p></div>
    <span class="amount">${rub(w.price)}</span><span class="badge ${WD[w.status]?.[1] || ''}">${WD[w.status]?.[0] || esc(w.status)}</span></div>`).join('');
};

$('[data-owned]').addEventListener('click', async (e) => {
  const sellBtn = e.target.closest('[data-sell]');
  const wdBtn = e.target.closest('[data-withdraw]');
  if (sellBtn) {
    const item = owned.find((i) => i.id === Number(sellBtn.dataset.sell));
    const ok = await confirmDialog({ title: `Продать ${item.name}?`, html: `<p>На баланс придёт <b>${rub(item.sellPrice)}</b> — сразу, без ожидания.</p>`, confirm: 'Продать' });
    if (!ok) return;
    await withLoading(sellBtn, async () => {
      try {
        const r = await api('/api/inventory/sell', { method: 'POST', body: { ids: [item.id] } });
        updateBalance(r.balance);
        toast(`Продано за ${rub(r.total)}`, 'success');
      } catch (err) { toastError(err); }
    });
    loaders.inventory();
  }
  if (wdBtn) {
    if (!user.tradeUrl) { openTab('settings', { focus: true }); $('#trade-url').focus(); toast('Сначала добавь трейд-ссылку', 'info'); return; }
    const item = owned.find((i) => i.id === Number(wdBtn.dataset.withdraw));
    const ok = await confirmDialog({
      title: `Вывести ${item.name} в Steam?`,
      html: '<p>Пришлём обмен на твою трейд-ссылку. Обычно это 5–30 минут. Принимай только обмен, где тебе <b>отдают</b> этот скин.</p>',
      confirm: 'Вывести',
    });
    if (!ok) return;
    await withLoading(wdBtn, async () => {
      try {
        await api('/api/inventory/withdraw', { method: 'POST', body: { id: item.id } });
        toast('Заявка на вывод создана. Статус — ниже, в «Выводы скинов»', 'success');
      } catch (err) { toastError(err); }
    });
    loaders.inventory();
  }
});

// ── Кошелёк ────────────────────────────────────────────────

const wdForm = $('#withdraw-form');
const PAY_STATUS = {
  pending: ['Ожидает оплаты', 'badge-blue'], review: ['На проверке', 'badge-warning'], processing: ['Отправляем', 'badge-blue'],
  sending: ['Отправляем', 'badge-blue'], paid: ['Готово', 'badge-success'], rejected: ['Отклонено', ''],
};
const PAY_METHOD = { crypto: 'Крипта', card: 'Карта', sbp: 'СБП', demo: 'Тестовое' };

function renderDeposit() {
  const p = cfg.payments;
  const box = $('[data-deposit]');
  let html = '';
  if (p.deposit.crypto) {
    html += `
      <form class="form" id="deposit-form" novalidate>
        <div class="field">
          <label for="dep-amount">Сумма</label>
          <div class="input-group"><input class="input num" id="dep-amount" name="amount" type="number" inputmode="decimal" min="${p.minDeposit / 100}" step="1" value="1000" aria-describedby="dep-amount-error"><span class="suffix" aria-hidden="true">₽</span></div>
          <p class="error" id="dep-amount-error" aria-live="polite"></p>
        </div>
        <div class="chips">${[500, 1000, 3000, 5000].map((v) => `<button type="button" class="chip" data-dep="${v}">${v.toLocaleString('ru-RU')} ₽</button>`).join('')}</div>
        <button class="btn btn-primary btn-block" type="submit" data-loading="Создаём счёт…">${icon('i-coins')}<span>Оплатить в USDT или TON</span></button>
        <p class="hint">Откроется @CryptoBot. Баланс пополнится автоматически сразу после оплаты.</p>
      </form>`;
  } else {
    html += `<div class="callout">${icon('i-info')}<p>Пополнение криптой скоро заработает. А пока можно <a href="/sell/">продать скины на баланс</a>.</p></div>`;
  }
  if (p.deposit.demo) {
    html += `<div class="callout callout-warning mt-4">${icon('i-circle-alert')}<div><p><b>Тестовый режим.</b> Кнопка начисляет 5 000 ₽ для проверки сайта. В боевом режиме её нет.</p>
      <button class="btn btn-secondary btn-sm mt-3" type="button" data-demo data-loading="Начисляем…">+5 000 ₽ тестовых</button></div></div>`;
  }
  html += `<p class="small muted mt-4">Или <a href="/sell/">продай скины из Steam</a> на баланс — до ${Math.round(cfg.market.buybackRate * 100)}% от рынка.</p>`;
  box.innerHTML = html;

  const form = $('#deposit-form');
  if (form) {
    form.addEventListener('click', (e) => { const c = e.target.closest('[data-dep]'); if (c) form.elements.amount.value = c.dataset.dep; });
    const v = liveValidate(form, { amount: (val) => (Number(val) * 100 >= p.minDeposit ? '' : `Минимум ${rub(p.minDeposit)}`) });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!v.validateAll()) return;
      // Окно открываем сразу по клику, иначе Safari заблокирует его как всплывающее
      const win = window.open('', '_blank');
      await withLoading(form.querySelector('[type="submit"]'), async () => {
        try {
          const r = await api('/api/deposit/crypto', { method: 'POST', body: { amount: form.elements.amount.value } });
          if (win) { win.opener = null; win.location.href = r.url; } else location.href = r.url;
          toast('Счёт открыт в новой вкладке. После оплаты баланс обновится сам', 'info', { timeout: 8000 });
          pollBalance();
        } catch (err) { win?.close(); toastError(err); }
      });
    });
  }
  $('[data-demo]')?.addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
    try {
      const r = await api('/api/deposit/demo', { method: 'POST' });
      updateBalance(r.balance);
      toast('Начислено 5 000 ₽ тестовых', 'success');
      loaders.wallet();
    } catch (err) { toastError(err); }
  }));
}

// После создания счёта проверяем баланс, пока игрок платит
let polling = false;
async function pollBalance() {
  if (polling) return;
  polling = true;
  const start = user.balance;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await refreshSession();
    if (s.user && s.user.balance !== start) { updateBalance(s.user.balance); toast('Баланс пополнен', 'success'); loaders.wallet(); break; }
  }
  polling = false;
}

function setupWithdraw() {
  const p = cfg.payments;
  for (const m of ['card', 'sbp', 'crypto']) $(`[data-method="${m}"]`, wdForm).hidden = !p[m].enabled;
  const bank = wdForm.elements.bank;
  bank.innerHTML = '<option value="">Выбери банк</option>' + p.banks.map((b) => `<option>${esc(b)}</option>`).join('');
  $('[data-limits]').textContent = `От ${rub(p.minWithdraw)} до ${rub(p.maxWithdraw)} за раз`;
  wdForm.elements.card.addEventListener('input', () => { wdForm.elements.card.value = formatCard(wdForm.elements.card.value); });
  maskPhone(wdForm.elements.phone);

  const method = () => wdForm.elements.method.value;
  const v = liveValidate(wdForm, {
    method: (val) => (val ? '' : 'Выбери способ вывода'),
    card: (val) => (method() !== 'card' || isCard(val) ? '' : 'Проверь номер карты'),
    phone: (val) => (method() !== 'sbp' || isPhone(val) ? '' : 'Телефон в формате +7 (999) 123-45-67'),
    bank: (val) => (method() !== 'sbp' || val ? '' : 'Выбери банк'),
    amount: (val) => {
      const kop = Math.round(Number(val) * 100);
      if (!kop) return 'Укажи сумму';
      if (kop < p.minWithdraw) return `Минимум ${rub(p.minWithdraw)}`;
      if (kop > p.maxWithdraw) return `Максимум ${rub(p.maxWithdraw)} за раз`;
      if (kop > user.balance) return `На балансе только ${rub(user.balance, { exact: true })}`;
      return '';
    },
  });

  wdForm.addEventListener('change', (e) => {
    if (e.target.name !== 'method') return;
    $$('[data-for]', wdForm).forEach((el) => { el.hidden = el.dataset.for !== method(); });
    updateWithdrawSummary();
  });
  wdForm.addEventListener('input', updateWithdrawSummary);
  $('[data-all]', wdForm).addEventListener('click', () => { wdForm.elements.amount.value = (user.balance / 100).toFixed(2); updateWithdrawSummary(); });

  wdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!v.validateAll()) return;
    const f = wdForm.elements;
    const body = { method: method(), amount: f.amount.value, card: f.card.value, phone: f.phone.value, bank: f.bank.value, asset: f.asset.value };
    await withLoading(wdForm.querySelector('[type="submit"]'), async () => {
      try {
        const r = await api('/api/withdraw', { method: 'POST', body });
        const s = await refreshSession();
        updateBalance(s.user.balance);
        if (r.checkUrl) {
          await confirmDialog({
            title: 'Готово! Чек создан',
            html: `<p>Забери монеты в @CryptoBot по ссылке. Ссылка также сохранится в истории ниже.</p><p class="mt-3"><a class="btn btn-primary btn-block" href="${esc(r.checkUrl)}" target="_blank" rel="noopener">Открыть чек в @CryptoBot</a></p>`,
            confirm: 'Понятно', cancel: 'Закрыть',
          });
        } else {
          toast('Заявка на вывод создана. Обычно выплачиваем в течение 15 минут с 10:00 до 23:00 МСК', 'success', { timeout: 8000 });
        }
        wdForm.reset();
        $$('[data-for]', wdForm).forEach((el) => { el.hidden = true; });
        $$('.touched', wdForm).forEach((el) => el.classList.remove('touched'));
        updateWithdrawSummary();
        loaders.wallet();
      } catch (err) {
        if (!(err.data?.field && v.setServerError(err.data.field, err.message))) toastError(err);
      }
    });
  });
}

function updateWithdrawSummary() {
  if (!cfg || !wdForm) return;
  const m = wdForm.elements.method.value;
  const kop = Math.round(Number(wdForm.elements.amount.value) * 100) || 0;
  const feeRate = m ? cfg.payments[m].fee : null;
  const fee = feeRate == null ? null : Math.ceil(kop * feeRate);
  $('[data-fee]').textContent = fee == null ? '—' : `${rub(fee, { exact: true })} (${Math.round(feeRate * 100)}%)`;
  $('[data-receive]').textContent = fee == null || !kop ? '—' : rub(kop - fee, { exact: true });
}

loaders.wallet = async () => {
  const list = await api('/api/me/payments').catch(() => []);
  $('[data-payments]').innerHTML = list.length
    ? list.map((p) => {
      const [label, cls] = PAY_STATUS[p.status] || [p.status, ''];
      const d = p.details || {};
      const where = d.card || (d.phone ? `${d.phone}, ${d.bank}` : '') || d.asset || '';
      const link = d.checkUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(d.checkUrl)}" target="_blank" rel="noopener">Открыть чек</a>`
        : d.url ? `<a class="btn btn-secondary btn-sm" href="${esc(d.url)}" target="_blank" rel="noopener">Оплатить</a>` : '';
      return `<div class="list-item">
        <span class="icon-tile">${icon(p.direction === 'in' ? 'i-plus' : 'i-banknote')}</span>
        <div class="grow"><p><b>${p.direction === 'in' ? 'Пополнение' : 'Вывод'}</b> · ${esc(PAY_METHOD[p.method] || p.method)} ${where ? `· <span class="muted">${esc(where)}</span>` : ''}</p>
        <p class="small muted">#${p.id} · ${dateTime(p.created_at)}${p.fee ? ` · комиссия ${rub(p.fee, { exact: true })}` : ''}</p></div>
        <span class="amount ${p.direction === 'in' ? 'plus' : ''}">${p.direction === 'in' ? '+' : '−'}${rub(p.amount, { exact: true })}</span>
        <span class="badge ${cls}">${label}</span>${link}
      </div>`;
    }).join('')
    : emptyState({ iconName: 'i-wallet', title: 'Операций пока нет', text: 'Здесь появятся пополнения и выводы.' });
};

// ── История баланса ────────────────────────────────────────

const KIND = {
  deposit: 'Пополнение', withdraw: 'Вывод', refund: 'Возврат', buy: 'Покупка скина', sell: 'Продажа скина',
  upgrade: 'Ставка в апгрейде', buyback: 'Выкуп скинов', admin: 'Корректировка', demo: 'Тестовое пополнение',
};
loaders.history = async () => {
  const list = await api('/api/me/ledger').catch(() => []);
  $('[data-ledger]').innerHTML = list.length
    ? list.map((l) => `<div class="list-item">
        <div class="grow"><p><b>${esc(KIND[l.kind] || l.kind)}</b>${l.note ? ` · <span class="muted">${esc(l.note)}</span>` : ''}</p><p class="small muted">${dateTime(l.created_at)}</p></div>
        <span class="amount ${l.amount > 0 ? 'plus' : ''}">${l.amount > 0 ? '+' : '−'}${rub(Math.abs(l.amount), { exact: true })}</span>
        <span class="small muted num">= ${rub(l.balance_after, { exact: true })}</span>
      </div>`).join('')
    : emptyState({ iconName: 'i-history', title: 'История пуста', text: 'Все движения по балансу будут здесь.' });
};

// ── Апгрейды ───────────────────────────────────────────────

loaders.upgrades = async () => {
  const list = await api('/api/me/upgrades').catch(() => []);
  $('[data-upgrades]').innerHTML = list.length
    ? list.map((u) => {
      const verify = u.server_seed
        ? `<a class="btn btn-secondary btn-sm" href="/fair/?${new URLSearchParams({ server: u.server_seed, client: u.client_seed, nonce: u.nonce, chance: u.chance_ppm })}">Проверить</a>`
        : '<span class="small muted">Сид ещё не раскрыт</span>';
      return `<div class="list-item">
        <span class="badge ${u.won ? 'badge-success' : ''}">${u.won ? 'Победа' : 'Мимо'}</span>
        <div class="grow"><p><b>${esc(u.target_hash_name)}</b></p>
        <p class="small muted">${dateTime(u.created_at)} · ставка ${rub(u.input_value)} · шанс ${pct(u.chance_ppm)} · бросок ${u.roll.toLocaleString('ru-RU')} · nonce ${u.nonce}</p></div>
        <span class="amount">${rub(u.target_price)}</span>${verify}
      </div>`;
    }).join('')
    : emptyState({ iconName: 'i-trending-up', title: 'Апгрейдов ещё не было', action: '<a class="btn btn-primary btn-sm" href="/upgrade/">Открыть апгрейдер</a>' });
};

// ── Настройки ──────────────────────────────────────────────

loaders.settings = () => {
  const trade = $('#trade-form');
  trade.elements.tradeUrl.value = user.tradeUrl || '';
  const tv = liveValidate(trade, { tradeUrl: (val) => (TRADE_URL.test(val.trim()) ? '' : 'Ссылка вида https://steamcommunity.com/tradeoffer/new/?partner=…&token=…') });
  trade.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!tv.validateAll()) return;
    await withLoading(trade.querySelector('[type="submit"]'), async () => {
      try {
        const r = await api('/api/me', { method: 'PATCH', body: { tradeUrl: trade.elements.tradeUrl.value.trim() } });
        user = r.user;
        renderHead();
        toast('Трейд-ссылка сохранена', 'success');
      } catch (err) { if (!(err.data?.field && tv.setServerError(err.data.field, err.message))) toastError(err); }
    });
  });

  renderSeeds();
  const seedForm = $('#client-seed-form');
  const sv = liveValidate(seedForm, { clientSeed: (val) => (/^[\w-]{1,32}$/.test(val) ? '' : 'Латиница, цифры, - и _, до 32 символов') });
  seedForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sv.validateAll()) return;
    await withLoading(seedForm.querySelector('[type="submit"]'), async () => {
      try {
        const r = await api('/api/me', { method: 'PATCH', body: { clientSeed: seedForm.elements.clientSeed.value } });
        user = r.user;
        renderSeeds();
        toast('Клиентский сид сохранён', 'success');
      } catch (err) { toastError(err); }
    });
  });

  $('[data-rotate]').addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: 'Сменить серверный сид?', html: '<p>Текущий сид раскроется — по нему можно будет проверить все прошлые броски. Новый сид начнёт счёт бросков с нуля.</p>', confirm: 'Сменить' });
    if (!ok) return;
    await withLoading(e.currentTarget, async () => {
      try {
        const r = await api('/api/me/seed/rotate', { method: 'POST' });
        user.fair = { ...user.fair, serverSeedHash: r.serverSeedHash, nonce: 0 };
        renderSeeds();
        $('[data-revealed]').innerHTML = `<div class="callout">${icon('i-circle-check')}<div><p><b>Старый сид раскрыт</b> (бросков: ${r.revealed.lastNonce})</p>
          <p class="mono small mt-2">${esc(r.revealed.serverSeed)}</p><p class="small mt-2">Теперь у прошлых апгрейдов появилась кнопка «Проверить».</p></div></div>`;
        loaded.delete('upgrades');
      } catch (err) { toastError(err); }
    });
  });

  $('[data-logout]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/';
  });
};

function renderSeeds() {
  $('[data-seed-hash]').textContent = user.fair.serverSeedHash;
  $('[data-seed-nonce]').textContent = String(user.fair.nonce);
  $('#client-seed').value = user.fair.clientSeed;
}

// ── Старт ──────────────────────────────────────────────────

const s = await session();
user = s.user;
cfg = s.config;
if (!user) {
  $('[data-guest]').hidden = false;
  $('[data-login-link]').href = loginUrl('/profile/');
} else {
  $('[data-app]').hidden = false;
  renderHead();
  renderDeposit();
  setupWithdraw();
  openTab(location.hash.slice(1) || 'inventory', { push: false });
}
