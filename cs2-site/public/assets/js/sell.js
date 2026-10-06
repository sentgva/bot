// Продажа: инвентарь Steam с ценами выкупа, выбор скинов, заявка, история заявок.
import { $, $$, api, dateTime, emptyState, esc, icon, loginUrl, rub, session, skinCard, withLoading } from './core.js';
import { initSellForm } from './forms.js';

const box = $('[data-inventory]');
const refreshBtn = $('[data-refresh]');
const selected = new Set();
let items = [];

const STATUS = { new: ['Новая', 'badge-blue'], in_work: ['В работе', 'badge-warning'], done: ['Выплачено', 'badge-success'], rejected: ['Отклонена', ''] };
const METHOD = { balance: 'на баланс', card: 'на карту', sbp: 'по СБП', crypto: 'в крипту' };

function renderSummary() {
  const sel = items.filter((i) => selected.has(i.assetId));
  $('[data-summary]').hidden = !sel.length;
  $('[data-sel-count]').textContent = String(sel.length);
  $('[data-sel-total]').textContent = rub(sel.reduce((s, i) => s + i.buyback, 0));
}

function renderInventory() {
  if (!items.length) {
    box.innerHTML = emptyState({ iconName: 'i-package', title: 'В инвентаре нет скинов CS2', text: 'Если скины есть — проверь, что инвентарь открыт, и нажми «Обновить».' });
    return;
  }
  const sellable = items.filter((i) => i.buyback);
  box.innerHTML = `
    <p class="small muted mb-4">Можно продать: ${sellable.length} из ${items.length}. Остальные пока не обмениваются или у них нет рыночной цены.</p>
    <div class="upg-scroll"><div class="skin-grid" role="group" aria-label="Скины из Steam">${items.map((i) => skinCard(i, {
      mode: 'select', selected: selected.has(i.assetId), disabled: !i.buyback, price: i.buyback,
      tag: !i.tradable ? '<span class="badge badge-warning">Трейд-бан</span>' : '',
      attrs: `data-asset="${esc(i.assetId)}"`,
    })).join('')}</div></div>`;
}

async function loadInventory(refresh = false) {
  try {
    const data = await api(`/api/steam-inventory${refresh ? '?refresh=1' : ''}`);
    items = data.items;
    for (const id of selected) if (!items.some((i) => i.assetId === id)) selected.delete(id);
    renderInventory();
    renderSummary();
  } catch (err) {
    box.innerHTML = emptyState({ iconName: 'i-circle-alert', title: 'Не получилось загрузить инвентарь', text: esc(err.message) });
  }
}

box.addEventListener('click', (e) => {
  const card = e.target.closest('[data-asset]');
  if (!card || card.getAttribute('aria-disabled') === 'true') return;
  const id = card.dataset.asset;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  card.setAttribute('aria-pressed', String(selected.has(id)));
  renderSummary();
});

refreshBtn.addEventListener('click', () => withLoading(refreshBtn, () => loadInventory(true)));

async function loadRequests() {
  const list = await api('/api/me/sell-requests').catch(() => []);
  $('[data-requests-box]').hidden = !list.length;
  $('[data-requests]').innerHTML = list.map((r) => {
    const [label, cls] = STATUS[r.status] || [r.status, ''];
    return `<div class="list-item">
      <span class="icon-tile">${icon('i-hand-coins')}</span>
      <div class="grow"><p><b>Заявка #${r.id}</b> · ${esc(METHOD[r.method] || r.method)}</p><p class="small muted">${dateTime(r.created_at)} · ${r.items.length ? `${r.items.length} скин(ов)` : 'оценка менеджером'}</p></div>
      <span class="amount">${r.amount ? rub(r.amount) : r.estimate ? `≈ ${rub(r.estimate)}` : ''}</span>
      <span class="badge ${cls}">${label}</span>
    </div>`;
  }).join('');
}

const { user } = await session();
if (!user) {
  box.innerHTML = emptyState({
    iconName: 'i-user', title: 'Войди, чтобы увидеть цены своих скинов',
    text: 'Мы покажем выкупную цену каждого скина из твоего инвентаря Steam.',
    action: `<a class="btn btn-primary" href="${esc(loginUrl())}">${icon('b-steam')}<span>Войти через Steam</span></a>`,
  });
} else {
  $('[data-guest-note]').hidden = true;
  refreshBtn.hidden = false;
  loadInventory();
  loadRequests();
}

initSellForm($('#sell-form'), {
  getAssetIds: () => [...selected],
  onDone: () => {
    selected.clear();
    $$('[data-asset]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    renderSummary();
    if (user) loadRequests();
  },
});
