// Профиль: вкладки, инвентарь на сайте, пополнение и вывод, история, апгрейды, настройки.
import {
  $, $$, api, confirmDialog, dateTime, emptyState, esc, icon, loginUrl, pct, refreshSession, lc, rub, session, setBalance, setToken,
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
  $('[data-account]').textContent = `Telegram: ${user.telegram?.username ? '@' + user.telegram.username : `ID ${user.telegram?.id ?? user.id}`}`;
  $('[data-avatar]').innerHTML = user.avatar
    ? `<img class="avatar" src="${esc(user.avatar)}" alt="" width="72" height="72">`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${esc(user.name.slice(0, 1).toUpperCase())}</span>`;
  updateBalance(user.balance);
  $('[data-no-trade]').hidden = Boolean(user.tradeUrl);
  $('[data-admin-link]').hidden = !user.isAdmin;
}

function updateBalance(kop) {
  user.balance = kop;
  $('[data-balance-exact]').textContent = lc(kop);
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
        ? `<button class="btn btn-secondary btn-sm" type="button" data-sell="${i.id}" aria-label="Продать ${esc(i.name)} за ${lc(i.sellPrice)}">Продать ${lc(i.sellPrice)}</button>
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
    <span class="amount">${lc(w.price)}</span><span class="badge ${WD[w.status]?.[1] || ''}">${WD[w.status]?.[0] || esc(w.status)}</span></div>`).join('');
};

$('[data-owned]').addEventListener('click', async (e) => {
  const sellBtn = e.target.closest('[data-sell]');
  const wdBtn = e.target.closest('[data-withdraw]');
  if (sellBtn) {
    const item = owned.find((i) => i.id === Number(sellBtn.dataset.sell));
    const ok = await confirmDialog({ title: `Продать ${item.name}?`, html: `<p>На баланс придёт <b>${lc(item.sellPrice)}</b> — сразу, без ожидания.</p>`, confirm: 'Продать' });
    if (!ok) return;
    await withLoading(sellBtn, async () => {
      try {
        const r = await api('/api/inventory/sell', { method: 'POST', body: { ids: [item.id] } });
        updateBalance(r.balance);
        toast(`Продано за ${lc(r.total)}`, 'success');
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
const PAY_METHOD = { stars: 'Звёзды Telegram', crypto: 'Крипта', card: 'Карта', sbp: 'СБП', demo: 'Тестовое' };

function renderDeposit() {
  const p = cfg.payments;
  const box = $('[data-deposit]');
  let html = '';
  if (p.deposit.stars) {
    const rate = String(p.stars.lcPerStar).replace('.', ',');
    html += `
      <form class="form" id="stars-form" novalidate>
        <div class="field">
          <label for="stars-amount">Звёзды Telegram</label>
          <div class="input-group"><input class="input num" id="stars-amount" name="stars" type="number" inputmode="numeric" min="${p.stars.min}" max="${p.stars.max}" step="1" value="250" aria-describedby="stars-amount-hint stars-amount-error"><span class="suffix" aria-hidden="true">⭐</span></div>
          <p class="hint" id="stars-amount-hint">Курс: 1 ⭐ = ${rate} LC, округляем вниз до целого LC.</p>
          <p class="error" id="stars-amount-error" aria-live="polite"></p>
        </div>
        <div class="chips">${[100, 250, 500, 1000, 2500].map((v) => `<button type="button" class="chip" data-stars="${v}">${v.toLocaleString('ru-RU')} ⭐</button>`).join('')}</div>
        <div class="summary"><div class="total"><span>Получишь</span><span class="num" data-stars-lc>—</span></div></div>
        <button class="btn btn-primary btn-block" type="submit" data-loading="Создаём счёт…">${icon('i-star')}<span>Оплатить звёздами</span></button>
        <p class="hint">Оплата проходит в Telegram. LuxeCoin зачислятся сразу после оплаты.</p>
      </form>`;
  }
  if (p.deposit.crypto) {
    html += `
      <form class="form${p.deposit.stars ? ' mt-6' : ''}" id="deposit-form" novalidate>
        <div class="field">
          <label for="dep-amount">Криптой: USDT или TON</label>
          <div class="input-group"><input class="input num" id="dep-amount" name="amount" type="number" inputmode="numeric" min="${p.minDeposit / 100}" step="1" value="1000" aria-describedby="dep-amount-error"><span class="suffix" aria-hidden="true">LC</span></div>
          <p class="error" id="dep-amount-error" aria-live="polite"></p>
        </div>
        <div class="chips">${[500, 1000, 3000, 5000].map((v) => `<button type="button" class="chip" data-dep="${v}">${v.toLocaleString('ru-RU')} LC</button>`).join('')}</div>
        <button class="btn btn-secondary btn-block" type="submit" data-loading="Создаём счёт…">${icon('i-coins')}<span>Оплатить в USDT или TON</span></button>
        <p class="hint">Счёт в рублях: 1 LC = 1 ₽. Откроется @CryptoBot, баланс пополнится сам.</p>
      </form>`;
  }
  if (!p.deposit.stars && !p.deposit.crypto) {
    html += `<div class="callout">${icon('i-info')}<p>Пополнение скоро заработает. Следи за новостями в нашем Telegram-канале.</p></div>`;
  }
  if (p.deposit.demo) {
    html += `<div class="callout callout-warning mt-4">${icon('i-circle-alert')}<div><p><b>Тестовый режим.</b> Кнопка начисляет 5 000 LC для проверки сайта. В боевом режиме её нет.</p>
      <button class="btn btn-secondary btn-sm mt-3" type="button" data-demo data-loading="Начисляем…">+5 000 LC тестовых</button></div></div>`;
  }
  box.innerHTML = html;
  setupStars(p);

  const form = $('#deposit-form');
  if (form) {
    form.addEventListener('click', (e) => { const c = e.target.closest('[data-dep]'); if (c) form.elements.amount.value = c.dataset.dep; });
    const v = liveValidate(form, { amount: (val) => (Number(val) * 100 >= p.minDeposit ? '' : `Минимум ${lc(p.minDeposit)}`) });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!v.validateAll()) return;
      // В Telegram счёт открываем средствами Telegram; на сайте — окно сразу по клику, иначе Safari его заблокирует
      const tg = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;
      const win = tg ? null : window.open('', '_blank');
      await withLoading(form.querySelector('[type="submit"]'), async () => {
        try {
          const r = await api('/api/deposit/crypto', { method: 'POST', body: { amount: form.elements.amount.value } });
          if (tg) { if (r.url.startsWith('https://t.me/')) tg.openTelegramLink(r.url); else tg.openLink(r.url); }
          else if (win) { win.opener = null; win.location.href = r.url; } else location.href = r.url;
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
      toast('Начислено 5 000 LC тестовых', 'success');
      loaders.wallet();
    } catch (err) { toastError(err); }
  }));
}

// Пополнение звёздами: счёт Telegram. В Mini App открывается прямо в приложении, на сайте — в Telegram.
function setupStars(p) {
  const form = $('#stars-form');
  if (!form) return;
  const input = form.elements.stars;
  const preview = () => {
    const n = Math.floor(Number(input.value) || 0);
    $('[data-stars-lc]').textContent = n > 0 ? lc(Math.floor(n * p.stars.lcPerStar) * 100) : '—';
  };
  form.addEventListener('click', (e) => { const c = e.target.closest('[data-stars]'); if (c) { input.value = c.dataset.stars; preview(); } });
  input.addEventListener('input', preview);
  preview();
  const v = liveValidate(form, {
    stars: (val) => {
      const n = Number(val);
      if (!Number.isInteger(n)) return 'Целое число звёзд';
      if (n < p.stars.min) return `Минимум ${p.stars.min} ⭐`;
      if (n > p.stars.max) return `Максимум ${p.stars.max.toLocaleString('ru-RU')} ⭐`;
      return '';
    },
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!v.validateAll()) return;
    const tg = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;
    const win = tg ? null : window.open('', '_blank'); // на сайте окно открываем сразу по клику (Safari)
    await withLoading(form.querySelector('[type="submit"]'), async () => {
      try {
        const r = await api('/api/deposit/stars', { method: 'POST', body: { stars: Number(input.value) } });
        if (tg?.openInvoice) {
          tg.openInvoice(r.url, (status) => {
            if (status === 'paid') { toast(`Оплачено! Зачисляем ${lc(r.amount)}`, 'success'); pollBalance(); }
            else if (status === 'failed') toast('Оплата не прошла. Попробуй ещё раз', 'error');
          });
        } else {
          if (win) { win.opener = null; win.location.href = r.url; } else location.href = r.url;
          toast('Счёт открыт в Telegram. После оплаты баланс обновится сам', 'info', { timeout: 8000 });
          pollBalance();
        }
      } catch (err) {
        win?.close();
        if (!(err.data?.field && v.setServerError(err.data.field, err.message))) toastError(err);
      }
    });
  });
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
  $('[data-limits]').textContent = `От ${lc(p.minWithdraw)} до ${lc(p.maxWithdraw)} за раз`;
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
      if (!Number.isInteger(Number(val))) return 'Целое число LC';
      if (kop < p.minWithdraw) return `Минимум ${lc(p.minWithdraw)}`;
      if (kop > p.maxWithdraw) return `Максимум ${lc(p.maxWithdraw)} за раз`;
      if (kop > user.balance) return `На балансе только ${lc(user.balance)}`;
      return '';
    },
  });

  wdForm.addEventListener('change', (e) => {
    if (e.target.name !== 'method') return;
    $$('[data-for]', wdForm).forEach((el) => { el.hidden = el.dataset.for !== method(); });
    updateWithdrawSummary();
  });
  wdForm.addEventListener('input', updateWithdrawSummary);
  $('[data-all]', wdForm).addEventListener('click', () => { wdForm.elements.amount.value = String(Math.floor(user.balance / 100)); updateWithdrawSummary(); });

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
  $('[data-fee]').textContent = fee == null ? '—' : `${rub(fee)} (${Math.round(feeRate * 100)}%)`;
  $('[data-receive]').textContent = fee == null || !kop ? '—' : rub(kop - fee); // 1 LC = 1 ₽
}

loaders.wallet = async () => {
  const list = await api('/api/me/payments').catch(() => []);
  $('[data-payments]').innerHTML = list.length
    ? list.map((p) => {
      const [label, cls] = PAY_STATUS[p.status] || [p.status, ''];
      const d = p.details || {};
      const where = d.card || (d.phone ? `${d.phone}, ${d.bank}` : '') || d.asset || (d.stars ? `${d.stars} ⭐` : '');
      const link = d.checkUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(d.checkUrl)}" target="_blank" rel="noopener">Открыть чек</a>`
        : d.url ? `<a class="btn btn-secondary btn-sm" href="${esc(d.url)}" target="_blank" rel="noopener">Оплатить</a>` : '';
      return `<div class="list-item">
        <span class="icon-tile">${icon(p.direction === 'in' ? 'i-plus' : 'i-banknote')}</span>
        <div class="grow"><p><b>${p.direction === 'in' ? 'Пополнение' : 'Вывод'}</b> · ${esc(PAY_METHOD[p.method] || p.method)} ${where ? `· <span class="muted">${esc(where)}</span>` : ''}</p>
        <p class="small muted">#${p.id} · ${dateTime(p.created_at)}${p.fee ? ` · комиссия ${lc(p.fee)}` : ''}</p></div>
        <span class="amount ${p.direction === 'in' ? 'plus' : ''}">${p.direction === 'in' ? '+' : '−'}${lc(p.amount)}</span>
        <span class="badge ${cls}">${label}</span>${link}
      </div>`;
    }).join('')
    : emptyState({ iconName: 'i-wallet', title: 'Операций пока нет', text: 'Здесь появятся пополнения и выводы.' });
};

// ── История баланса ────────────────────────────────────────

const KIND = {
  deposit: 'Пополнение', withdraw: 'Вывод', refund: 'Возврат', buy: 'Покупка скина', sell: 'Продажа скина',
  upgrade: 'Ставка в апгрейде', buyback: 'Выкуп скинов', admin: 'Корректировка', demo: 'Тестовое пополнение', bonus: 'Бонус', case: 'Открытие кейса',
};
loaders.history = async () => {
  const list = await api('/api/me/ledger').catch(() => []);
  $('[data-ledger]').innerHTML = list.length
    ? list.map((l) => `<div class="list-item">
        <div class="grow"><p><b>${esc(KIND[l.kind] || l.kind)}</b>${l.note ? ` · <span class="muted">${esc(l.note)}</span>` : ''}</p><p class="small muted">${dateTime(l.created_at)}</p></div>
        <span class="amount ${l.amount > 0 ? 'plus' : ''}">${l.amount > 0 ? '+' : '−'}${lc(Math.abs(l.amount))}</span>
        <span class="small muted num">= ${lc(l.balance_after)}</span>
      </div>`).join('')
    : emptyState({ iconName: 'i-history', title: 'История пуста', text: 'Все движения по балансу будут здесь.' });
};

// ── Апгрейды ───────────────────────────────────────────────

loaders.upgrades = async () => {
  const list = await api('/api/me/upgrades').catch(() => []);
  $('[data-upgrades]').innerHTML = list.length
    ? list.map((u) => {
      return `<div class="list-item">
        <span class="badge ${u.won ? 'badge-success' : ''}">${u.won ? 'Победа' : 'Мимо'}</span>
        <div class="grow"><p><b>${esc(u.target_hash_name)}</b></p>
        <p class="small muted">${dateTime(u.created_at)} · ставка ${lc(u.input_value)} · шанс ${pct(u.chance_ppm)}</p></div>
        <span class="amount">${lc(u.target_price)}</span>
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


  $('[data-logout]').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    location.href = '/';
  });
};

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
