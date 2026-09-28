import { catalogItems } from './content.js';

export const STATUS = {
  new: 'Новый',
  work: 'В работе',
  done: 'Готов',
  cancel: 'Отменён',
};

const rub = (n) => `${n.toLocaleString('ru-RU')} ₽`;

// Собирает заказ из того, что прислал клиент. Цены берём только из каталога.
export function buildOrder(rawItems, rawComment) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 20) {
    throw new Error('Выбери хотя бы одну услугу');
  }

  const seen = new Set();
  const items = [];
  for (const raw of rawItems) {
    const item = catalogItems.get(raw?.id);
    if (!item || seen.has(item.id)) throw new Error('Неизвестная услуга');
    seen.add(item.id);
    const qty = item.unit ? Math.trunc(Number(raw.qty)) : 1;
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) throw new Error('Неверное количество');
    items.push({
      id: item.id,
      title: item.title,
      category: item.category,
      qty,
      unit: item.unit || null,
      price: item.price,
      from: Boolean(item.from),
    });
  }

  const comment = String(rawComment ?? '').trim().slice(0, 1500);
  return { items, comment, total: orderTotal(items) };
}

export function orderTotal(items) {
  const priced = items.filter((i) => i.price !== null);
  return {
    sum: priced.reduce((s, i) => s + i.price * i.qty, 0),
    from: priced.some((i) => i.from),
    negotiable: priced.length < items.length,
  };
}

export function totalLabel({ sum, from, negotiable }) {
  if (!sum) return 'договорная';
  const base = `${from ? 'от ' : ''}${rub(sum)}`;
  return negotiable ? `${base} + договорная часть` : base;
}

export function itemLabel(i) {
  const qty = i.unit ? ` × ${i.qty}` : '';
  const price = i.price === null ? 'договорная' : `${i.from ? 'от ' : ''}${rub(i.price * i.qty)}`;
  return `${i.title}${qty} — ${price}`;
}
