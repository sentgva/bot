// Всё, что видно в Mini App: тексты, ссылки и прайс.
// Правь здесь и перезапускай бота.

const GUILD = 'https://discord.com/channels/1307617792752881735';

export const discordInvite = 'sovside-mods-1307617792752881735';

// Дата создания Discord-сервера (из его ID), показывается на главной
export const since = '2024-11-17';

export const about = {
  name: 'SOVSIDE',
  tagline: 'Моды для GTA5RP и Majestic RP',
  text:
    'Делаю ганпаки, одежду и редуксы под тебя: от перекраса одного ствола до сборки с нуля. ' +
    'Все детали обсуждаем лично в чате.',
};

export const links = {
  discord: `https://discord.gg/${discordInvite}`,
  works: [
    { title: 'Мои работы', sub: 'Примеры готовых модов', url: `${GUILD}/1374800767218614383` },
    { title: 'Ещё работы', sub: 'Больше примеров', url: `${GUILD}/1363437497182584924` },
  ],
  reviews: `${GUILD}/1355534040798593074`,
  ticket: `${GUILD}/1377890729988456468`,
};

// Куда платить. Показывается на вкладке «Заказ» и в активных заказах в чате.
// url — откроется по нажатию, card — номер карты, по нажатию копируется.
export const payment = [
  { id: 'funpay', title: 'FunPay', sub: 'Профиль продавца', url: 'https://funpay.com/users/6024775/', icon: 'assets/pay/funpay.svg' },
  { id: 'sber', title: 'Сбербанк', sub: 'Роман', card: '2202209229054753', icon: 'assets/pay/sber.png?v=2' },
];

export const steps = [
  { title: 'Выбираешь услугу', text: 'Во вкладке «Заказ». Можно сразу несколько.' },
  { title: 'Обсуждаем в чате', text: 'Референсы, цвета, сроки и цену за сложные задачи.' },
  { title: 'Получаешь мод', text: 'Готовые файлы и помощь с установкой.' },
];

// price: число в рублях или null (обсуждается в чате)
// from: true, если цена «от»
// unit: 'gun', если цена за один ган (появится выбор количества)
export const catalog = [
  {
    id: 'gunpack',
    title: 'Gunpack',
    summary: 'Перекрас, визуальные моды, сборка с нуля',
    items: [
      { id: 'gp-recolor', title: 'Перекрас ганпака', price: 100, unit: 'gun' },
      { id: 'gp-visual', title: 'Визуальные моды на ган', price: 150, unit: 'gun' },
      { id: 'gp-scratch', title: 'Ганпак с нуля', desc: 'Обсуждаем в чате', price: null },
    ],
  },
  {
    id: 'clothes',
    title: 'Clothes',
    summary: 'Замененки и перекрас шмота',
    items: [
      { id: 'cl-replace', title: 'Замененка', desc: 'Например, кобура вместо бабочки', price: 200, from: true },
      { id: 'cl-recolor', title: 'Перекрас шмота', desc: 'Лого, принты и т.д.', price: 200, from: true },
    ],
  },
  {
    id: 'redux',
    title: 'Redux',
    summary: 'Доделать, подредачить, оптимизация',
    items: [
      { id: 'rx-edit', title: 'Доработка редукса', desc: 'Доделать, подредачить, заменить оптимизацию', price: null },
    ],
  },
  {
    id: 'other',
    title: 'Other',
    summary: 'Фото ганпака, 3D-лого',
    items: [
      { id: 'ot-photo', title: 'Фото ганпака', desc: 'Или любого другого мода', price: 200, from: true },
      { id: 'ot-logo', title: '3D-лого для брелка', price: 150 },
      { id: 'ot-logo-gun', title: 'Поставить 3D-лого на ган', price: 90, unit: 'gun' },
    ],
  },
];

export const catalogItems = new Map(
  catalog.flatMap((cat) => cat.items.map((item) => [item.id, { ...item, category: cat.title }])),
);
