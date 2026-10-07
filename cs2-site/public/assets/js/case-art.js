// Арт кейсов (ящик в духе оружейных кейсов CS) и карточка кейса — для страницы кейсов и главной.
import { $$, esc, lc, sized } from './core.js';

let artSeq = 0;
export function crateSvg(color, label) {
  const id = `cr${++artSeq}`;
  return `<svg class="crate" viewBox="0 0 220 150" aria-hidden="true">
    <defs>
      <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#0d0b08"/></linearGradient>
      <linearGradient id="${id}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".25" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".75"/></linearGradient>
      <linearGradient id="${id}m" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a352c"/><stop offset=".5" stop-color="#8a8172"/><stop offset="1" stop-color="#3a352c"/></linearGradient>
      <radialGradient id="${id}g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>
    </defs>
    <ellipse cx="110" cy="80" rx="105" ry="70" fill="url(#${id}g)"/>
    <ellipse cx="110" cy="138" rx="86" ry="8" fill="#000" opacity=".45"/>
    <path d="M24 54h172l-6 74a8 8 0 0 1-8 7H38a8 8 0 0 1-8-7z" fill="url(#${id}b)" stroke="#000" stroke-opacity=".5"/>
    <path d="M20 38a10 10 0 0 1 10-10h160a10 10 0 0 1 10 10v18H20z" fill="url(#${id}l)" stroke="#000" stroke-opacity=".5"/>
    <rect x="20" y="52" width="180" height="6" fill="#000" opacity=".35"/>
    <rect x="46" y="28" width="14" height="106" fill="url(#${id}m)" opacity=".9"/>
    <rect x="160" y="28" width="14" height="106" fill="url(#${id}m)" opacity=".9"/>
    <g fill="#d9cfb8" opacity=".85"><circle cx="53" cy="36" r="2"/><circle cx="53" cy="126" r="2"/><circle cx="167" cy="36" r="2"/><circle cx="167" cy="126" r="2"/></g>
    <rect x="96" y="46" width="28" height="16" rx="3" fill="#e9c46a" stroke="#6b4e12"/>
    <rect x="106" y="52" width="8" height="6" rx="1" fill="#6b4e12"/>
    <rect x="72" y="72" width="76" height="40" rx="6" fill="#0b0a07" fill-opacity=".72" stroke="${color}" stroke-width="2"/>
    <text x="110" y="89" text-anchor="middle" font-size="10" font-weight="700" letter-spacing="2" fill="#f3e3b5">LUXEDROP</text>
    <text x="110" y="104" text-anchor="middle" font-size="9" fill="${color}">${esc(label)}</text>
    <path d="M30 30h160" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

// Цвет кейса — через CSS-переменную (inline-стили запрещены CSP, а CSSOM — можно)
export function paint(root = document) {
  $$('[data-case-color]', root).forEach((el) => el.style.setProperty('--case', el.dataset.caseColor));
}

export const caseArt = (c, big = false) => {
  // Настоящий кейс CS2 — его родная картинка из Steam
  if (c.image) {
    return `<div class="case-art case-art-real${big ? ' case-art-lg' : ''}" data-case-color="${esc(c.color)}">
      <img src="${esc(sized(c.image))}" alt="" loading="lazy" decoding="async" width="256" height="192">
    </div>`;
  }
  const top = c.items[0];
  return `<div class="case-art${big ? ' case-art-lg' : ''}" data-case-color="${esc(c.color)}">
    ${top?.image ? `<img class="case-art-skin" src="${esc(sized(top.image))}" alt="" loading="lazy" decoding="async" width="256" height="192">` : ''}
    ${crateSvg(c.color, c.name.toUpperCase())}
  </div>`;
};

export const caseCard = (c) => `
    <a class="case-card" href="/cases/?c=${esc(c.slug)}" data-case="${esc(c.slug)}" data-case-color="${esc(c.color)}">
      ${caseArt(c)}
      <span class="case-name">${esc(c.name)}</span>
      <span class="case-top">до ${lc(c.items[0].price)}</span>
      <span class="case-price">${lc(c.price)}</span>
    </a>`;
