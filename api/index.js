// Точка входа на Vercel: весь /api/* (включая вебхук Telegram) обрабатывает одна функция
import { createApp } from '../src/app.js';

export default createApp({ webhook: true }).server;
