(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = (tg && tg.initData) || '';
  const inTelegram = Boolean(initData);
  const ver = (v) => Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const svg = (d, cls) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    if (cls) el.setAttribute('class', cls);
    el.innerHTML = `<path d="${d}"/>`;
    return el;
  };
  const ICON = {
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    arrow: 'M9 5l7 7-7 7',
    out: 'M8 16L16 8M9.5 8H16v6.5',
    copy: 'M9 9h10v10H9zM15 9V5H5v10h4',
  };

  const state = {
    tab: 'home',
    info: null,
    me: null,
    isAdmin: false,
    canAdmin: false,
    restrict: null,
    sheet: false,
    ofilter: null,
    cart: new Map(),
    items: new Map(),
    threads: [],
    viewer: false,
  };

  /* ---------- Telegram ---------- */

  if (tg) {
    tg.ready();
    tg.expand();
    if (ver('6.1')) {
      tg.setHeaderColor('#0a0a0b');
      tg.setBackgroundColor('#0a0a0b');
    }
    if (ver('7.10')) tg.setBottomBarColor('#0a0a0b');
    if (ver('7.7')) tg.disableVerticalSwipes();
  }

  const haptic = {
    tap: () => ver('6.1') && tg.HapticFeedback.impactOccurred('light'),
    select: () => ver('6.1') && tg.HapticFeedback.selectionChanged(),
    ok: () => ver('6.1') && tg.HapticFeedback.notificationOccurred('success'),
    err: () => ver('6.1') && tg.HapticFeedback.notificationOccurred('error'),
  };

  function openLink(url) {
    if (!url) return;
    if (inTelegram && /^https:\/\/t\.me\//.test(url) && ver('6.1')) return tg.openTelegramLink(url);
    if (inTelegram) return tg.openLink(url);
    window.open(url, '_blank', 'noopener');
  }

  /* ---------- сеть ---------- */

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`api/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Нет связи с сервером');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
    return data;
  }

  /* ---------- форматирование ---------- */

  const nf = new Intl.NumberFormat('ru-RU');
  const rub = (n) => `${nf.format(n)} ₽`;
  const plural = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  };
  const priceLabel = (item) => (item.price === null ? 'договорная' : `${item.from ? 'от ' : ''}${rub(item.price)}`);
  const itemSum = (i) => (i.price === null ? 'договорная' : `${i.from ? 'от ' : ''}${rub(i.price * i.qty)}`);
  const displayName = (u) =>
    [u && u.firstName, u && u.lastName].filter(Boolean).join(' ') || (u && u.username ? `@${u.username}` : `ID ${u && u.id}`);
  const initials = (u) => {
    const s = [u && u.firstName, u && u.lastName].filter(Boolean).map((p) => p[0]).join('') || (u && u.username ? u.username[0] : '#');
    return s.slice(0, 2).toUpperCase();
  };

  const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => new Date(ts).toDateString();
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === yesterday.toDateString()) return 'Вчера';
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('ru-RU', opts);
  }
  function shortDate(ts) {
    const d = new Date(ts);
    if (d.toDateString() === new Date().toDateString()) return time(ts);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  }

  // Текст с кликабельными ссылками, без innerHTML
  function richText(text) {
    const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
    return parts.map((p, i) => {
      if (i % 2 === 0) return p;
      return h('a', { href: p, onclick: (e) => { e.preventDefault(); openLink(p); } }, p);
    });
  }

  let toastTimer;
  function toast(text, error = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('is-error', error);
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
    if (error) haptic.err();
  }

  /* ---------- интро ---------- */

  function flyTo(from, to) {
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    from.style.transition = 'transform 0.9s cubic-bezier(0.7, 0, 0.18, 1)';
    from.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${b.width / a.width})`;
  }

  // Крылья плавно возвращаются в покой с того места, где их застал переход
  function settleWings(root) {
    for (const w of $$('.wing', root)) {
      w.style.transform = getComputedStyle(w).transform;
      w.style.animation = 'none';
    }
    root.offsetWidth; // зафиксировать текущее положение
    for (const w of $$('.wing', root)) {
      w.style.transition = 'transform 0.7s cubic-bezier(0.3, 0, 0.2, 1)';
      w.style.transform = 'none';
    }
  }

  function playIntro(onLeave) {
    const intro = $('#intro');
    const fly = $('#introFly');
    const hero = $('#heroBfly');

    return new Promise((resolve) => {
      let done = false;
      const leave = async () => {
        if (done) return;
        done = true;
        // если нажали, пока бабочка ещё проявляется, доводим её плавно с текущего кадра
        const bfly = $('.bfly', fly);
        const cs = getComputedStyle(bfly);
        Object.assign(bfly.style, { opacity: cs.opacity, filter: cs.filter, transform: cs.transform, animation: 'none' });
        bfly.offsetWidth;
        Object.assign(bfly.style, {
          transition: 'opacity 0.5s, filter 0.5s, transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1)',
          opacity: '1',
          filter: 'none',
          transform: 'none',
        });

        settleWings(fly);
        onLeave();
        intro.classList.add('is-leaving');
        $('#app').classList.remove('is-pre');
        flyTo(fly, hero);
        await wait(900);
        hero.classList.add('is-on');
        intro.remove();
        resolve();
      };

      intro.addEventListener('pointerdown', () => { haptic.tap(); leave(); }, { once: true });

      const fonts = document.fonts ? document.fonts.load('300 52px "Unbounded"').catch(() => {}) : null;
      const img = $('img', fly);
      const imgReady = img.decode ? img.decode().catch(() => {}) : null;
      Promise.race([Promise.all([fonts, imgReady]), wait(1200)]).then(() => {
        if (done) return;
        intro.classList.add('is-playing');
        setTimeout(leave, 3000);
      });
    });
  }

  function skipIntro(onLeave) {
    onLeave();
    $('#intro').remove();
    $('#heroBfly').classList.add('is-on');
    requestAnimationFrame(() => $('#app').classList.remove('is-pre'));
    return Promise.resolve();
  }

  /* ---------- главная ---------- */

  function renderInfo(info) {
    state.info = info;
    $('[data-bind=tagline]').textContent = info.about.tagline;
    $('[data-bind=about]').textContent = info.about.text;
    $('[data-bind=foot]').textContent = `sovside ⚝ ${info.stats.since.slice(0, 4)} — ${new Date().getFullYear()}`;

    const third = $('[data-bind=thirdLabel]');
    if (info.stats.orders > 0) {
      third.innerHTML = 'заказов<br>выполнено';
    } else {
      const month = new Date(info.stats.since).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/^\d+\s/, '');
      third.innerHTML = `в деле<br>с ${month}`;
    }

    $('#services').replaceChildren(
      ...info.catalog.map((cat, i) => {
        const prices = cat.items.filter((it) => it.price !== null).map((it) => it.price);
        const meta = prices.length ? `от ${rub(Math.min(...prices))}` : 'договорная';
        return h('button', { class: 'row', type: 'button', onclick: () => { haptic.tap(); go('order', cat.id); } },
          h('span', { class: 'row-num', text: String(i + 1).padStart(2, '0') }),
          h('span', { class: 'row-body' }, h('b', { text: cat.title }), h('span', { text: cat.summary })),
          h('span', { class: 'row-meta', text: meta }),
          svg(ICON.arrow),
        );
      }),
    );

    $('#steps').replaceChildren(
      ...info.steps.map((s, i) =>
        h('li', {}, h('span', { text: String(i + 1).padStart(2, '0') }), h('div', {}, h('b', { text: s.title }), h('p', { text: s.text }))),
      ),
    );

    const links = [
      { title: 'Discord-сервер', sub: 'Новости, работы, общение', url: info.links.discord },
      info.links.telegram && { title: 'Telegram', sub: info.links.telegram.replace(/^https?:\/\//, ''), url: info.links.telegram },
      ...info.links.works,
      { title: 'Отзывы', sub: 'Что говорят клиенты', url: info.links.reviews },
    ].filter(Boolean);
    $('#links').replaceChildren(
      ...links.map((l) =>
        h('button', { class: 'row', type: 'button', onclick: () => { haptic.tap(); openLink(l.url); } },
          h('span', { class: 'row-body' }, h('b', { text: l.title }), h('span', { text: l.sub })),
          svg(ICON.out),
        ),
      ),
    );

    for (const key of ['members', 'online']) {
      if (typeof info.stats[key] === 'number') $(`[data-stat=${key}]`).textContent = '0';
    }
    $('[data-stat=third]').textContent = info.stats.orders > 0 ? '0' : info.stats.since.slice(0, 4);
    renderCatalog(info.catalog);
    renderPayment(info.payment);
  }

  function countUp(el, value) {
    if (typeof value !== 'number') return;
    if (reduceMotion) { el.textContent = nf.format(value); return; }
    const start = performance.now();
    const dur = 1400;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = nf.format(Math.round(value * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function runCounters() {
    const s = state.info && state.info.stats;
    if (!s) return;
    countUp($('[data-stat=members]'), s.members);
    countUp($('[data-stat=online]'), s.online);
    const third = $('[data-stat=third]');
    if (s.orders > 0) countUp(third, s.orders);
    else third.textContent = s.since.slice(0, 4);
  }

  /* ---------- оплата ---------- */

  const cardFormat = (n) => n.replace(/(\d{4})(?=\d)/g, '$1 ');

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { readonly: true });
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  function payRows(list) {
    return list.map((p) =>
      h('button', {
        class: 'pay-row',
        type: 'button',
        onclick: async (e) => {
          const row = e.currentTarget;
          haptic.tap();
          if (!p.card) return openLink(p.url);
          if (await copyText(p.card)) {
            haptic.ok();
            toast('Номер карты скопирован');
            row.classList.add('is-copied');
            setTimeout(() => row.classList.remove('is-copied'), 1800);
          } else {
            toast(cardFormat(p.card));
          }
        },
      },
        h('img', { class: 'pay-ico', src: p.icon, alt: '' }),
        h('span', { class: 'pay-body' },
          h('b', { text: p.card ? `${p.title} · ${p.sub}` : p.title }),
          h('span', { class: p.card ? 'pay-card' : '', text: p.card ? cardFormat(p.card) : p.sub }),
        ),
        h('span', { class: 'pay-act' }, p.card ? [svg(ICON.copy, 'i-copy'), svg(ICON.check, 'i-done')] : svg(ICON.out)),
      ),
    );
  }

  function renderPayment(list) {
    if (!list || !list.length) return;
    $('#payList').replaceChildren(...payRows(list));
    $('#payBlock').hidden = false;
    // заказы в чате могли отрисоваться раньше, чем пришли реквизиты
    for (const o of chat.orders.values()) refreshOrderCard(o);
  }

  /* ---------- заказ ---------- */

  function renderCatalog(catalog) {
    state.items.clear();
    $('#catalog').replaceChildren(
      ...catalog.map((cat, i) =>
        h('section', { class: 'cat', id: `cat-${cat.id}` },
          h('div', { class: 'cat-head' }, h('span', { class: 'num', text: String(i + 1).padStart(2, '0') }), h('h3', { text: cat.title })),
          cat.items.map((item) => {
            state.items.set(item.id, item);
            return itemRow(item);
          }),
        ),
      ),
    );
    renderCart();
  }

  function itemRow(item) {
    const row = h('div', { class: 'item', 'data-id': item.id, role: 'button', tabindex: '0' });
    let ctl;
    if (item.unit) {
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      ctl = h('div', { class: 'ctl ctl-step' },
        h('button', { class: 'minus', type: 'button', 'aria-label': 'Меньше', onclick: stop(() => setQty(item, (state.cart.get(item.id) || 0) - 1)) }, svg(ICON.minus)),
        h('span', { class: 'val', text: '1' }),
        h('button', { class: 'plus', type: 'button', 'aria-label': 'Больше', onclick: stop(() => setQty(item, (state.cart.get(item.id) || 0) + 1)) }, svg(ICON.plus)),
      );
    } else {
      ctl = h('span', { class: 'ctl ctl-toggle' }, svg(ICON.plus, 'i-plus'), svg(ICON.check, 'i-check'));
    }
    row.append(
      h('div', { class: 'item-main' }, h('div', { class: 'item-title', text: item.title }), item.desc && h('div', { class: 'item-desc', text: item.desc })),
      h('div', { class: 'item-side' },
        h('div', { class: 'item-price' }, priceLabel(item), item.unit && h('small', { text: 'за один ган' })),
        ctl,
      ),
    );
    row.addEventListener('click', () => setQty(item, state.cart.has(item.id) ? 0 : 1));
    return row;
  }

  function setQty(item, qty) {
    qty = Math.max(0, Math.min(99, qty));
    if (qty) state.cart.set(item.id, qty);
    else state.cart.delete(item.id);
    const row = $(`.item[data-id="${item.id}"]`);
    row.classList.toggle('is-on', qty > 0);
    const val = $('.val', row);
    if (val && qty) val.textContent = qty;
    haptic.select();
    renderCart();
  }

  function renderCart() {
    const lines = [...state.cart].map(([id, qty]) => ({ ...state.items.get(id), qty }));
    $('#cart').classList.toggle('is-on', lines.length > 0);
    if (!lines.length) return;
    const priced = lines.filter((l) => l.price !== null);
    const sum = priced.reduce((s, l) => s + l.price * l.qty, 0);
    const from = priced.some((l) => l.from);
    const negotiable = priced.length < lines.length;
    const n = lines.length;
    $('#cartCount').textContent = `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}${negotiable && sum ? ' · + договорная часть' : ''}`;
    $('#cartTotal').textContent = sum ? `${from ? 'от ' : ''}${rub(sum)}` : 'Цена договорная';
  }

  async function submitOrder() {
    if (!inTelegram) return toast('Заказ оформляется в Telegram', true);
    const btn = $('#submitOrder');
    btn.classList.add('is-loading');
    try {
      const { order } = await api('orders', {
        method: 'POST',
        body: {
          items: [...state.cart].map(([id, qty]) => ({ id, qty })),
          comment: $('#orderComment').value,
        },
      });
      haptic.ok();
      for (const id of [...state.cart.keys()]) {
        state.cart.delete(id);
        $(`.item[data-id="${id}"]`).classList.remove('is-on');
      }
      $('#orderComment').value = '';
      renderCart();
      toast(`Заказ #${order.id} отправлен`);
      go('chat');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.classList.remove('is-loading');
    }
  }

  /* ---------- чат ---------- */

  const chat = {
    userId: null,
    epoch: 0,
    lastId: 0,
    v: null,
    cleared: null,
    ids: new Set(),
    orders: new Map(),
    prev: null,
    lastDay: '',
    loaded: false,
    sending: 0,
    image: null,
  };
  const msgsEl = () => $('#msgs');
  const mySide = () => (state.isAdmin ? 'admin' : 'client');

  function resetChat(userId) {
    chat.userId = userId;
    chat.epoch++;
    chat.lastId = 0;
    chat.v = null;
    chat.cleared = null;
    chat.ids.clear();
    chat.orders.clear();
    chat.prev = null;
    chat.lastDay = '';
    chat.loaded = false;
    msgsEl().replaceChildren();
    $('#jump').classList.remove('is-on');
  }

  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  function toBottom(smooth) {
    const el = msgsEl();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
  }

  function orderCard(o) {
    const card = h('div', { class: 'order-card', 'data-order': o.id },
      h('div', { class: 'oc-head' }, h('b', { text: `Заказ #${o.id}` }), h('span', { class: `chip s-${o.status}`, text: o.statusLabel })),
      h('ul', { class: 'oc-items' },
        o.items.map((i) => h('li', {}, h('span', { text: i.title + (i.unit ? ` × ${i.qty}` : '') }), h('span', { text: itemSum(i) }))),
      ),
      h('div', { class: 'oc-total' }, h('span', { text: 'Итого' }), h('b', { text: o.total })),
      o.comment && h('p', { class: 'oc-comment', text: o.comment }),
    );
    // Клиенту в активном заказе показываем, куда платить
    const payment = state.info && state.info.payment;
    if (!state.isAdmin && payment && payment.length && (o.status === 'new' || o.status === 'work')) {
      card.append(h('div', { class: 'oc-pay' }, h('span', { class: 'oc-pay-label', text: 'Оплата' }), h('div', { class: 'pay' }, payRows(payment))));
    }
    if (state.isAdmin) {
      const seg = h('div', { class: 'seg' });
      for (const [status, label] of [['new', 'Новый'], ['work', 'В работе'], ['done', 'Готов'], ['cancel', 'Отмена']]) {
        seg.append(h('button', {
          type: 'button',
          class: o.status === status ? 'is-on' : '',
          text: label,
          onclick: () => changeStatus(o, status),
        }));
      }
      card.append(seg);
    }
    return card;
  }

  async function changeStatus(o, status) {
    if (o.status === status) return;
    haptic.select();
    try {
      const { order } = await api(`admin/orders/${o.id}`, { method: 'POST', body: { status } });
      updateOrders([order]);
      poll();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function refreshOrderCard(o) {
    for (const card of $$(`.order-card[data-order="${o.id}"]`)) card.replaceWith(orderCard(o));
  }

  function updateOrders(list) {
    for (const o of list) {
      const prev = chat.orders.get(o.id);
      chat.orders.set(o.id, o);
      if (prev && prev.status !== o.status) refreshOrderCard(o);
    }
  }

  function messageNode(m, animate) {
    const nodes = [];
    const day = dayKey(m.at);
    if (day !== chat.lastDay) {
      chat.lastDay = day;
      chat.prev = null;
      nodes.push(h('div', { class: 'day', text: dayLabel(m.at) }));
    }

    if (m.from === 'system') {
      chat.prev = null;
      const order = m.orderId && chat.orders.get(m.orderId);
      nodes.push(m.kind === 'order' && order ? orderCard(order) : h('div', { class: 'sys', text: m.text }));
      return nodes;
    }

    const side = m.from === mySide() ? 'me' : 'them';
    const el = h('div', { class: `msg ${side}${animate ? ' is-new' : ''}${m.pending ? ' is-pending' : ''}` });
    const prev = chat.prev;
    if (prev && prev.from === m.from && m.at - prev.at < 5 * 60e3) {
      el.classList.add('has-prev');
      prev.el.classList.add('has-next');
    }

    const bubble = h('div', { class: 'bubble' });
    const src = m.localImage || m.image;
    if (src) {
      bubble.classList.add('has-img');
      if (!m.text) bubble.classList.add('img-only');
      const img = h('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('click', () => openViewer(img.src));
      img.addEventListener('load', () => {
        if (nearBottom(msgsEl()) || !chat.loaded) toBottom(false);
      }, { once: true });
      bubble.append(img);
    }
    const stamp = h('span', { class: 'time', text: m.pending ? '···' : time(m.at) });
    if (m.text) bubble.append(h('div', { class: src ? 'cap' : 'body' }, h('span', { class: 'text' }, richText(m.text)), stamp));
    else bubble.append(stamp);
    el.append(bubble);

    chat.prev = { from: m.from, at: m.at, el };
    nodes.push(el);
    return nodes;
  }

  function appendMessages(list, animate) {
    const box = msgsEl();
    const stick = !chat.loaded || nearBottom(box);
    $('.empty', box)?.remove();
    const out = [];
    for (const m of list) {
      if (m.id) chat.ids.add(m.id);
      const nodes = messageNode(m, animate);
      box.append(...nodes);
      out.push(...nodes);
    }
    if (stick) requestAnimationFrame(() => toBottom(animate));
    else if (animate) $('#jump').classList.add('is-on');
    return out[out.length - 1];
  }

  function renderEmpty() {
    if (msgsEl().children.length) return;
    msgsEl().append(
      h('div', { class: 'empty' },
        h('img', { src: 'assets/butterfly.webp', alt: '' }),
        h('b', { text: 'Напиши, что хочешь сделать' }),
        h('p', { text: 'Отвечу здесь же.' }),
      ),
    );
  }

  async function poll() {
    if (chat.sending || !chat.userId) return;
    const epoch = chat.epoch;
    const q = new URLSearchParams();
    if (chat.lastId) q.set('after', chat.lastId);
    if (chat.v !== null) q.set('v', chat.v);
    if (state.isAdmin) q.set('user', chat.userId);
    const data = await api(`chat?${q}`);
    if (epoch !== chat.epoch || data.same) return;
    // переписку очистили (/clear в боте), пока приложение было открыто — перерисовываем с нуля
    if (chat.cleared !== null && data.cleared !== chat.cleared) {
      resetChat(chat.userId);
      return poll();
    }
    chat.cleared = data.cleared || 0;
    chat.v = data.v;

    if (data.peer) setPeer(data.peer, data.peerRestrict);
    updateOrders(data.orders);
    const fresh = data.messages.filter((m) => !chat.ids.has(m.id));
    for (const m of data.messages) chat.lastId = Math.max(chat.lastId, m.id);
    if (fresh.length) appendMessages(fresh, chat.loaded);
    if (!chat.loaded) {
      chat.loaded = true;
      if (!state.isAdmin) renderEmpty();
    }
    if (!state.isAdmin) setBadge(0);
  }

  async function send() {
    const input = $('#msgInput');
    const text = input.value.trim();
    const image = chat.image;
    if ((!text && !image) || !chat.userId) return;

    input.value = '';
    autosize();
    setAttachment(null);

    const el = appendMessages([{ from: mySide(), text, localImage: image, at: Date.now(), pending: true }], true);
    toBottom(true);
    chat.sending++;
    const epoch = chat.epoch;
    try {
      const { message } = await api('chat', { method: 'POST', body: { text, image, user: state.isAdmin ? chat.userId : undefined } });
      if (epoch !== chat.epoch) return;
      // сообщение уже успело прийти опросом
      if (chat.ids.has(message.id)) return el.remove();
      chat.ids.add(message.id);
      el.classList.remove('is-pending');
      $('.time', el).textContent = time(message.at);
    } catch (err) {
      el.remove();
      if (epoch === chat.epoch) {
        if (!input.value) input.value = text;
        if (image) setAttachment(image);
        autosize();
      }
      toast(err.message, true);
      lastMeAt = 0; // возможно, дали мут или бан — обновим профиль
    } finally {
      chat.sending--;
      schedule(300);
    }
  }

  function setAttachment(dataUrl) {
    chat.image = dataUrl;
    const box = $('#attached');
    box.hidden = !dataUrl;
    if (dataUrl) $('img', box).src = dataUrl;
    updateSend();
  }

  function updateSend() {
    $('#sendBtn').classList.toggle('is-ready', Boolean($('#msgInput').value.trim() || chat.image));
  }

  function autosize() {
    const ta = $('#msgInput');
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
    updateSend();
  }

  async function compressImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.86);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const restrictLabel = (r) => {
    if (!r) return '';
    if (r.banned) return 'забанен';
    if (!r.muted) return '';
    if (!r.mutedUntil) return 'мут навсегда';
    return `мут до ${new Date(r.mutedUntil).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  };

  function setPeer(u, restrict = chat.peerRestrict) {
    chat.peer = u;
    chat.peerRestrict = restrict || null;
    $('#chatTitle').textContent = displayName(u);
    const sub = $('#chatSub');
    const label = restrictLabel(restrict);
    sub.replaceChildren(
      u.username
        ? h('a', { href: `https://t.me/${u.username}`, onclick: (e) => { e.preventDefault(); openLink(`https://t.me/${u.username}`); } }, `@${u.username}`)
        : `ID ${u.id}`,
      label ? ' · ' : ' · клиент',
      ...(label ? [h('i', { class: 'rtag-inline', text: label })] : []),
    );
    $('#chatAvatar').replaceChildren(initials(u));
    $('#peerMenu').hidden = false;
  }

  /* нижняя шторка с действиями */

  let sheetResolve = null;
  function openSheet(title, actions) {
    if (sheetResolve) sheetResolve(null);
    return new Promise((resolve) => {
      sheetResolve = resolve;
      $('#sheetTitle').textContent = title;
      $('#sheetActions').replaceChildren(
        ...actions.map((a) =>
          a.sep
            ? h('p', { class: 'sheet-sep', text: a.sep })
            : h('button', {
                type: 'button',
                class: `sheet-btn${a.danger ? ' is-danger' : ''}${a.current ? ' is-current' : ''}`,
                disabled: a.current || null,
                onclick: () => closeSheet(a.key),
              }, h('span', { text: a.label }), a.current ? svg(ICON.check) : null),
        ),
      );
      $('#sheet').classList.add('is-on');
      state.sheet = true;
      updateBack();
      haptic.tap();
    });
  }

  function closeSheet(key = null) {
    $('#sheet').classList.remove('is-on');
    state.sheet = false;
    updateBack();
    const resolve = sheetResolve;
    sheetResolve = null;
    if (resolve) resolve(key);
  }

  /* бан и мут */

  async function restrictSheet(user, r) {
    const actions = [];
    if (r?.banned) actions.push({ key: 'unban', label: 'Разбанить' });
    if (r?.muted) actions.push({ key: 'unmute', label: 'Снять мут' });
    if (!r?.banned && !r?.muted) {
      actions.push(
        { sep: 'Мут — не сможет писать в чат' },
        { key: 'mute:1h', label: 'На 1 час' },
        { key: 'mute:1d', label: 'На сутки' },
        { key: 'mute:7d', label: 'На 7 дней' },
        { key: 'mute:forever', label: 'Навсегда' },
      );
    }
    if (!r?.banned) actions.push({ sep: 'Бан — не сможет писать и заказывать' }, { key: 'ban', label: 'Забанить', danger: true });

    const key = await openSheet(`${displayName(user)}${restrictLabel(r) ? ` · ${restrictLabel(r)}` : ''}`, actions);
    if (!key) return null;
    const [action, duration] = key.split(':');
    try {
      const res = await api(`admin/users/${user.id}/restrict`, { method: 'POST', body: { action, duration } });
      haptic.ok();
      toast({ ban: 'Забанен', unban: 'Разбанен', unmute: 'Мут снят' }[action] || `Мут ${restrictLabel(res.restrict).replace(/^мут /, '')}`);
      return res.restrict;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  }

  // У клиента: мут закрывает поле ввода, бан — весь чат
  function applyRestrict() {
    const r = state.restrict || {};
    const locked = !state.isAdmin && Boolean(r.muted);
    $('#composer').classList.toggle('is-locked', locked);
    const input = $('#msgInput');
    input.disabled = locked;
    input.placeholder = locked
      ? r.mutedUntil
        ? `Писать можно после ${new Date(r.mutedUntil).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
        : 'Писать в чат нельзя'
      : 'Сообщение';
    $('#fileInput').disabled = locked;
    if (!state.isAdmin && r.banned && state.tab === 'chat') enterChat();
  }

  function showGate(title, text, withButton) {
    $('#gateTitle').textContent = title;
    $('#gateText').textContent = text;
    $('#openBot').hidden = !withButton;
    showView('gate');
  }

  /* панель заказов */

  const STEPS = ['new', 'work', 'done'];
  const FILTER_LABEL = { new: 'Новые', work: 'В работе', done: 'Готовые', cancel: 'Отменённые' };

  function orderRow(o) {
    const step = STEPS.indexOf(o.status);
    const items = o.items.map((i) => i.title + (i.unit ? ` × ${i.qty}` : ''));
    const itemsText = items.slice(0, 2).join(' · ') + (items.length > 2 ? ` · ещё ${items.length - 2}` : '');
    return h('button', { class: 'orow', type: 'button', onclick: () => orderActions(o) },
      h('span', { class: 'orow-top' },
        h('b', { text: `#${o.id}` }),
        h('span', { class: 'orow-who', text: displayName(o.user) + (o.user.username ? ` · @${o.user.username}` : '') }),
        o.restrict ? h('span', { class: 'rtag', text: o.restrict.banned ? 'бан' : 'мут' }) : null,
        h('time', { text: shortDate(o.createdAt) }),
      ),
      h('span', { class: 'orow-items', text: itemsText }),
      h('span', { class: 'orow-bottom' },
        h('span', { class: `oprog${o.status === 'cancel' ? ' is-cancel' : ''}` }, STEPS.map((s, i) => h('i', { class: i <= step ? 'on' : '' }))),
        h('span', { class: 'orow-total', text: o.total }),
        h('span', { class: `chip s-${o.status}`, text: o.statusLabel }),
      ),
    );
  }

  async function orderActions(o) {
    const key = await openSheet(`Заказ #${o.id} · ${displayName(o.user)}`, [
      { key: 'chat', label: 'Открыть чат с клиентом' },
      { sep: 'Статус' },
      { key: 'st:new', label: 'Новый', current: o.status === 'new' },
      { key: 'st:work', label: 'В работе', current: o.status === 'work' },
      { key: 'st:done', label: 'Готов', current: o.status === 'done' },
      { key: 'st:cancel', label: 'Отменён', current: o.status === 'cancel' },
      { sep: 'Клиент' },
      { key: 'client', label: o.restrict ? `Ограничения · ${restrictLabel(o.restrict)}` : 'Бан или мут' },
    ]);
    if (!key) return;
    if (key === 'chat') {
      go('chat');
      return openThread(o.user.id, o.user);
    }
    if (key === 'client') {
      if (await restrictSheet(o.user, o.restrict)) loadOrders().catch(() => {});
      return;
    }
    try {
      await api(`admin/orders/${o.id}`, { method: 'POST', body: { status: key.slice(3) } });
      haptic.ok();
      toast(`Заказ #${o.id}: ${{ new: 'новый', work: 'в работе', done: 'готов', cancel: 'отменён' }[key.slice(3)]}`);
      loadOrders().catch(() => {});
    } catch (err) {
      toast(err.message, true);
    }
  }

  function setOrderBadge(n) {
    const b = $('#obadge');
    b.hidden = !n;
    if (n) b.textContent = n > 99 ? '99+' : String(n);
  }

  async function loadOrders() {
    const { counts, orders } = await api('admin/orders');
    setOrderBadge(counts.new);
    for (const b of $$('#pipe button')) {
      $('b', b).textContent = counts[b.dataset.f];
      b.classList.toggle('is-on', state.ofilter === b.dataset.f);
    }
    const list = state.ofilter ? orders.filter((o) => o.status === state.ofilter) : orders;
    $('#olabel').replaceChildren(
      h('span', { text: state.ofilter ? `${FILTER_LABEL[state.ofilter]}: ${list.length}` : `Все заказы: ${orders.length}` }),
      ...(state.ofilter ? [h('button', { type: 'button', class: 'link', onclick: () => setOrderFilter(null) }, 'показать все')] : []),
    );
    $('#olist').replaceChildren(
      ...(list.length
        ? list.map(orderRow)
        : [h('div', { class: 'empty' }, h('img', { src: 'assets/butterfly.webp', alt: '' }), h('b', { text: state.ofilter ? 'Здесь пусто' : 'Заказов пока нет' }), h('p', { text: state.ofilter ? 'В этом статусе заказов нет.' : 'Новые заказы появятся здесь.' }))]),
    );
  }

  function setOrderFilter(f) {
    state.ofilter = state.ofilter === f ? null : f;
    haptic.select();
    loadOrders().catch((err) => toast(err.message, true));
  }

  function setSovsideHeader() {
    $('#chatTitle').textContent = 'SOVSIDE';
    $('#chatSub').replaceChildren();
    $('#chatAvatar').replaceChildren(h('img', { src: 'assets/butterfly.webp', alt: '' }));
    $('#chatBack').hidden = true;
    $('#peerMenu').hidden = true;
  }

  /* режим: админ может смотреть и пользоваться всем как обычный клиент */

  function renderModeSwitch() {
    const sw = $('#modeSwitch');
    if (!state.canAdmin) {
      sw.hidden = true;
      return;
    }
    const mode = state.isAdmin ? 'admin' : 'client';
    sw.dataset.mode = mode;
    for (const b of $$('button', sw)) b.classList.toggle('is-on', b.dataset.mode === mode);
    const slot = $(state.isAdmin ? '#modeSlotInbox' : '#modeSlotChat');
    if (sw.parentElement !== slot) slot.append(sw);
    sw.hidden = false;
  }

  function applyMe(me) {
    const changed = Boolean(state.me) && state.isAdmin !== me.isAdmin;
    state.me = me.user;
    state.isAdmin = me.isAdmin;
    state.canAdmin = me.canAdmin;
    state.restrict = me.restrict || null;
    setBadge(me.unread);
    setOrderBadge(me.isAdmin ? me.newOrders : 0);
    $('#chatTabLabel').textContent = me.isAdmin ? 'Клиенты' : 'Чат';
    $('#orderTabLabel').textContent = me.isAdmin ? 'Заказы' : 'Заказ';
    renderModeSwitch();
    applyRestrict();
    if (changed) {
      resetChat(null);
      setSovsideHeader();
      if (state.tab === 'chat') enterChat();
      if (state.tab === 'order' || state.tab === 'orders') go('order');
      updateBack();
    }
  }

  let switching = false;
  async function switchMode(mode) {
    if (switching || (mode === 'admin') === state.isAdmin) return;
    switching = true;
    haptic.select();
    const sw = $('#modeSwitch');
    sw.dataset.mode = mode; // ползунок едет сразу, не дожидаясь сервера
    for (const b of $$('button', sw)) b.classList.toggle('is-on', b.dataset.mode === mode);
    try {
      applyMe(await api('mode', { method: 'POST', body: { mode } }));
      toast(mode === 'admin' ? 'Режим админа' : 'Режим клиента');
    } catch (err) {
      toast(err.message, true);
      renderModeSwitch();
    } finally {
      switching = false;
    }
  }

  /* админ: список клиентов */

  async function loadThreads() {
    const { threads } = await api('admin/threads');
    state.threads = threads;
    setBadge(threads.reduce((s, t) => s + t.unread, 0));
    const box = $('#threads');
    if (!threads.length) {
      box.replaceChildren(h('div', { class: 'empty' }, h('img', { src: 'assets/butterfly.webp', alt: '' }), h('b', { text: 'Пока тихо' }), h('p', { text: 'Когда клиент напишет или оформит заказ, он появится здесь.' })));
      return;
    }
    box.replaceChildren(
      ...threads.map((t) => {
        const last = t.last;
        let preview = last.text || (last.image ? 'Фото' : '');
        if (last.from === 'admin') preview = `Вы: ${preview}`;
        return h('button', { class: 'thread', type: 'button', onclick: () => { haptic.tap(); openThread(t.user.id, t.user, t.restrict); } },
          h('span', { class: 'avatar', text: initials(t.user) }),
          h('span', { class: 'thread-body' },
            h('span', { class: 'thread-top' },
              h('b', { text: displayName(t.user) }),
              t.restrict ? h('span', { class: 'rtag', text: t.restrict.banned ? 'бан' : 'мут' }) : null,
              h('time', { text: shortDate(t.updatedAt) }),
            ),
            h('span', { class: 'thread-bottom' },
              h('span', { class: 'thread-prev', text: preview }),
              t.order && h('span', { class: `chip s-${t.order.status}`, text: `#${t.order.id} ${t.order.statusLabel}` }),
              t.unread ? h('i', { class: 'count', text: String(t.unread) }) : null,
            ),
          ),
        );
      }),
    );
  }

  function showView(name) {
    for (const id of ['inbox', 'thread', 'gate']) {
      const el = $(`#${id}`);
      const on = id === name;
      if (on && el.hidden) {
        el.hidden = false;
        el.classList.remove('is-in');
        el.offsetWidth;
        el.classList.add('is-in');
      } else if (!on) {
        el.hidden = true;
      }
    }
    updateBack();
  }

  function openThread(userId, user, restrict = null) {
    resetChat(userId);
    lastMeAt = 0; // после прочтения обновим счётчик на вкладке
    if (user) setPeer(user, restrict);
    $('#chatBack').hidden = false;
    showView('thread');
    schedule(0);
  }

  function closeThread() {
    chat.userId = null;
    chat.epoch++;
    showView('inbox');
    schedule(0);
  }

  function enterChat() {
    if (!inTelegram) return showGate('Чат работает внутри Telegram', 'Открой приложение через бота, чтобы написать мне.', true);
    if (!state.me) return meReady.then(() => state.me && state.tab === 'chat' && enterChat());
    if (!state.isAdmin && state.restrict?.banned) return showGate('Доступ закрыт', 'Писать и оформлять заказы нельзя.', false);
    if (state.isAdmin) {
      showView(chat.userId ? 'thread' : 'inbox');
    } else {
      if (chat.userId !== state.me.id) {
        resetChat(state.me.id);
        setSovsideHeader();
      }
      showView('thread');
    }
    schedule(0);
  }

  /* ---------- навигация ---------- */

  function setBadge(n) {
    const b = $('#badge');
    b.hidden = !n;
    if (n) b.textContent = n > 99 ? '99+' : String(n);
  }

  function go(tab, anchor) {
    // вторая вкладка: у клиента оформление заказа, у админа панель заказов
    if (tab === 'order' && state.isAdmin) tab = 'orders';
    if (tab === 'orders' && !state.isAdmin) tab = 'order';
    const page = $(`.page[data-page="${tab}"]`);
    if (tab !== state.tab) {
      $(`.page[data-page="${state.tab}"]`).classList.remove('is-active');
      page.classList.add('is-active');
      for (const t of $$('.tab')) t.classList.toggle('is-active', t.dataset.tab === (tab === 'orders' ? 'order' : tab));
      state.tab = tab;
      if (tab === 'chat') enterChat();
      else if (tab === 'orders') {
        loadOrders().catch((err) => toast(err.message, true));
        schedule(8000);
      } else schedule(15000);
      updateBack();
    } else if (!anchor && tab !== 'chat') {
      page.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (anchor) {
      const target = $(`#cat-${anchor}`);
      if (target) setTimeout(() => page.scrollTo({ top: target.offsetTop - 12, behavior: reduceMotion ? 'auto' : 'smooth' }), 60);
    }
  }

  function openViewer(src) {
    $('#viewer img').src = src;
    $('#viewer').classList.add('is-on');
    state.viewer = true;
    updateBack();
  }
  function closeViewer() {
    $('#viewer').classList.remove('is-on');
    state.viewer = false;
    updateBack();
  }

  function updateBack() {
    if (!tg || !ver('6.1')) return;
    const need = state.viewer || state.sheet || (state.tab === 'chat' && state.isAdmin && Boolean(chat.userId));
    if (need) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  function back() {
    if (state.sheet) return closeSheet();
    if (state.viewer) return closeViewer();
    if (state.tab === 'chat' && state.isAdmin && chat.userId) return closeThread();
  }

  /* ---------- опрос сервера ---------- */

  let timer;
  let lastMeAt = 0;
  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  async function tick() {
    if (!inTelegram || !state.me) return;
    if (document.hidden) return schedule(5000);
    let next = 15000;
    try {
      if (state.tab === 'chat' && state.isAdmin && !chat.userId) {
        await loadThreads();
        next = 5000;
      } else if (state.tab === 'chat' && chat.userId) {
        await poll();
        next = 2500;
      } else if (state.tab === 'orders') {
        await loadOrders();
        next = 8000;
      }
      // раз в ~15 секунд сверяем профиль: счётчики, режим (мог смениться в боте), бан и мут
      if (Date.now() - lastMeAt > 14000) {
        lastMeAt = Date.now();
        applyMe(await api('me'));
      }
    } catch {
      next = 6000;
    }
    schedule(next);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule(0);
  });

  /* ---------- события ---------- */

  for (const t of $$('.tab')) {
    t.addEventListener('click', () => {
      haptic.select();
      go(t.dataset.tab);
    });
  }
  for (const b of $$('[data-go]')) b.addEventListener('click', () => { haptic.tap(); go(b.dataset.go); });
  for (const b of $$('[data-link]')) {
    b.addEventListener('click', () => state.info && openLink(state.info.links[b.dataset.link]));
  }

  $('#submitOrder').addEventListener('click', submitOrder);
  $('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });
  $('#sheetCancel').addEventListener('click', () => closeSheet());
  for (const b of $$('#pipe button')) b.addEventListener('click', () => setOrderFilter(b.dataset.f));
  $('#peerMenu').addEventListener('click', async () => {
    if (!chat.peer) return;
    const r = await restrictSheet(chat.peer, chat.peerRestrict);
    if (r) setPeer(chat.peer, r);
  });
  for (const b of $$('#modeSwitch button')) b.addEventListener('click', () => switchMode(b.dataset.mode));
  $('#chatBack').addEventListener('click', back);
  $('#viewer').addEventListener('click', closeViewer);
  $('#openBot').addEventListener('click', () => {
    const bot = state.info && state.info.bot;
    if (bot) openLink(`https://t.me/${bot}`);
  });
  if (tg) tg.BackButton.onClick(back);

  const input = $('#msgInput');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse) {
      e.preventDefault();
      send();
    }
  });
  // на телефоне прячем таббар, пока открыта клавиатура
  input.addEventListener('focus', () => {
    if (coarse) $('#app').classList.add('kb');
    setTimeout(() => toBottom(false), 250);
  });
  input.addEventListener('blur', () => $('#app').classList.remove('kb'));

  // не даём полю потерять фокус при нажатии «отправить», иначе клавиатура прыгает
  $('#sendBtn').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    haptic.tap();
    send();
  });

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Можно прикрепить только картинку', true);
    try {
      setAttachment(await compressImage(file));
    } catch {
      toast('Не получилось открыть картинку', true);
    }
  });
  $('#detach').addEventListener('click', () => setAttachment(null));

  const msgs = msgsEl();
  msgs.addEventListener('scroll', () => {
    if (nearBottom(msgs)) $('#jump').classList.remove('is-on');
  }, { passive: true });
  $('#jump').addEventListener('click', () => toBottom(true));

  /* ---------- старт ---------- */

  let meReady = Promise.resolve();

  async function boot() {
    const deepChat = Number(params.get('chat')) || null;
    const deepTab = params.get('tab');
    const deepLinked = Boolean(deepChat || deepTab);

    const infoReady = api('info').then(renderInfo).catch((err) => toast(err.message, true));
    meReady = inTelegram
      ? api('me')
          .then(applyMe)
          .catch((err) => toast(err.message, true))
      : Promise.resolve();

    let leaving;
    const introLeaving = new Promise((r) => (leaving = r));
    const introDone = deepLinked || reduceMotion ? skipIntro(leaving) : playIntro(leaving);
    Promise.all([introLeaving, infoReady]).then(() => setTimeout(runCounters, 300));

    await meReady;
    if (deepChat && state.isAdmin) {
      go('chat');
      openThread(deepChat);
    } else if (deepLinked && inTelegram) {
      go(deepTab && deepTab !== 'chat' && $(`.page[data-page="${deepTab}"]`) ? deepTab : 'chat');
    }

    await Promise.all([introDone, infoReady]);
    lastMeAt = Date.now();
    schedule(state.tab === 'chat' ? 0 : state.tab === 'orders' ? 8000 : 15000);
  }

  boot();
})();
