// Маркет: фильтры (синхронизируются с адресом страницы), сетка скинов, покупка с подтверждением.
import {
  $, api, confirmDialog, emptyState, esc, loginUrl, rub, session, setBalance, skeletonCards, skinCard, toast, toastError, withLoading,
} from './core.js';

const PAGE = 30;
const form = $('[data-filters]');
const grid = $('[data-grid]');
const more = $('[data-more]');
const count = $('[data-count]');
const state = { items: [], offset: 0, total: 0, seq: 0 };

// Фильтры ↔ адрес (?q=&rarity=…), чтобы ссылкой можно было поделиться
function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const name of ['q', 'rarity', 'sort']) if (p.get(name)) form.elements[name].value = p.get(name);
  for (const name of ['min', 'max']) if (p.get(name)) form.elements[name].value = String(Math.round(Number(p.get(name)) / 100) || '');
}
function params() {
  const f = form.elements;
  const p = new URLSearchParams();
  if (f.q.value.trim()) p.set('q', f.q.value.trim());
  if (f.rarity.value) p.set('rarity', f.rarity.value);
  if (f.sort.value !== 'popular') p.set('sort', f.sort.value);
  if (Number(f.min.value) > 0) p.set('min', String(Math.round(Number(f.min.value) * 100)));
  if (Number(f.max.value) > 0) p.set('max', String(Math.round(Number(f.max.value) * 100)));
  return p;
}

const plural = (n, [one, few, many]) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

async function load(reset) {
  const seq = ++state.seq;
  const p = params();
  if (reset) {
    state.items = [];
    state.offset = 0;
    grid.innerHTML = skeletonCards(10);
    history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
  }
  p.set('offset', String(state.offset));
  p.set('limit', String(PAGE));
  try {
    const data = await api(`/api/items?${p}`);
    if (seq !== state.seq) return;
    state.items.push(...data.items);
    state.total = data.total;
    state.offset += data.items.length;
    render();
  } catch (err) {
    if (seq === state.seq) grid.innerHTML = emptyState({ iconName: 'i-circle-alert', title: 'Не удалось загрузить маркет', text: esc(err.message) });
  }
}

function render() {
  count.textContent = `${state.total.toLocaleString('ru-RU')} ${plural(state.total, ['скин', 'скина', 'скинов'])}`;
  grid.innerHTML = state.items.length
    ? state.items.map((i, idx) => skinCard(i, {
      price: i.buyPrice,
      actions: `<button class="btn btn-primary btn-sm" type="button" data-buy="${idx}" aria-label="Купить ${esc(i.name)} за ${rub(i.buyPrice)}">Купить</button>`,
    })).join('')
    : emptyState({ iconName: 'i-search', title: 'Ничего не нашлось', text: 'Попробуй убрать часть фильтров или изменить запрос.' });
  more.hidden = state.offset >= state.total;
  injectSchema();
}

// Разметка schema.org Product для загруженных скинов
function injectSchema() {
  let tag = $('#schema-products');
  if (!tag) {
    tag = document.createElement('script');
    tag.type = 'application/ld+json';
    tag.id = 'schema-products';
    document.head.append(tag);
  }
  tag.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: state.items.slice(0, 30).map((i, n) => ({
      '@type': 'ListItem',
      position: n + 1,
      item: {
        '@type': 'Product',
        name: i.hashName,
        category: 'Скины CS2',
        ...(i.image && { image: i.image }),
        offers: { '@type': 'Offer', price: (i.buyPrice / 100).toFixed(2), priceCurrency: 'RUB', availability: 'https://schema.org/InStock' },
      },
    })),
  });
}

grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-buy]');
  if (!btn) return;
  const item = state.items[Number(btn.dataset.buy)];
  const { user } = await session();
  if (!user) {
    location.href = loginUrl(location.pathname + location.search);
    return;
  }
  const after = user.balance - item.buyPrice;
  const ok = await confirmDialog({
    title: `Купить ${item.name}?`,
    html: `<p>Цена: <b>${rub(item.buyPrice)}</b>. ${after >= 0
      ? `После покупки на балансе останется ${rub(after, { exact: true })}.`
      : `На балансе ${rub(user.balance, { exact: true })} — не хватает ${rub(-after, { exact: true })}.`}</p>`,
    confirm: after >= 0 ? 'Купить' : 'Пополнить баланс',
  });
  if (!ok) return;
  if (after < 0) { location.href = '/profile/#wallet'; return; }
  await withLoading(btn, async () => {
    try {
      const r = await api('/api/market/buy', { method: 'POST', body: { hashName: item.hashName, price: item.buyPrice } });
      user.balance = r.balance;
      setBalance(r.balance);
      toast(`${esc(item.name)} в твоём инвентаре. <a href="/upgrade/">Апгрейдить</a> · <a href="/profile/#inventory">Профиль</a>`, 'success', { html: true, timeout: 8000 });
    } catch (err) {
      if (err.status === 409 && err.data.price) {
        item.buyPrice = err.data.price;
        render();
      }
      toastError(err);
    }
  });
});

let timer;
form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(true), 300); });
form.addEventListener('submit', (e) => { e.preventDefault(); load(true); });
more.querySelector('button').addEventListener('click', (e) => withLoading(e.currentTarget, () => load(false)));

readUrl();
load(true);
