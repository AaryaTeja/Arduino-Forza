import { Game } from './game/Game.js';

const canvas = document.getElementById('viewport');

function fatal(err) {
  console.error('[Apex Horizon] fatal:', err);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('active');
    const label = document.getElementById('load-label');
    const tip = document.getElementById('load-tip');
    if (label) label.textContent = 'Failed to start';
    if (tip) {
      tip.style.color = '#ff6b7f';
      tip.textContent = String(err?.message || err);
    }
  }
}

const game = new Game(canvas);
window.__APEX__ = game;   // handy for debugging from the console

game.boot().catch(fatal);

window.addEventListener('error', (e) => {
  if (e.error) console.error('[Apex Horizon]', e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[Apex Horizon] unhandled rejection:', e.reason);
});
