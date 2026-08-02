import { clamp01, lerp, formatTime, formatGap, damp } from '../core/MathUtils.js';

const $ = (id) => document.getElementById(id);

/* ═══════════════════════════ tachometer ═══════════════════════════ */

class Tacho {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    this.needle = 0;
  }

  resize() {
    const cssSize = this.c.clientWidth || 180;
    const px = Math.round(cssSize * this.dpr);
    if (this.c.width !== px) { this.c.width = px; this.c.height = px; }
    this.size = px;
  }

  draw(rpm, redline, gearLabel, throttle, brake, limiter, dt) {
    this.resize();
    const ctx = this.ctx;
    const s = this.size;
    const r = s * 0.42;
    const cx = s / 2, cy = s / 2;
    ctx.clearRect(0, 0, s, s);

    const START = Math.PI * 0.78;
    const SWEEP = Math.PI * 1.44;
    const frac = clamp01(rpm / redline);
    this.needle = damp(this.needle, frac, 26, Math.max(dt, 1e-3));

    // backplate
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,11,16,0.58)';
    ctx.fill();

    // track
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = s * 0.055;
    ctx.stroke();

    // redline zone
    const rlFrac = 0.88;
    ctx.beginPath();
    ctx.arc(cx, cy, r, START + SWEEP * rlFrac, START + SWEEP);
    ctx.strokeStyle = 'rgba(255,59,88,0.5)';
    ctx.lineWidth = s * 0.055;
    ctx.stroke();

    // ticks
    ctx.save();
    ctx.translate(cx, cy);
    const steps = Math.max(6, Math.round(redline / 1000));
    for (let i = 0; i <= steps; i++) {
      const a = START + SWEEP * (i / steps);
      const major = true;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(r * 0.80, 0);
      ctx.lineTo(r * (major ? 0.90 : 0.87), 0);
      ctx.strokeStyle = (i / steps) >= rlFrac ? 'rgba(255,90,110,0.9)' : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = s * 0.008;
      ctx.stroke();
      ctx.restore();

      const lx = Math.cos(a) * r * 0.68, ly = Math.sin(a) * r * 0.68;
      ctx.fillStyle = (i / steps) >= rlFrac ? 'rgba(255,120,135,0.85)' : 'rgba(255,255,255,0.42)';
      ctx.font = `600 ${Math.round(s * 0.055)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i), lx, ly);
    }
    ctx.restore();

    // value arc
    const grad = ctx.createLinearGradient(0, 0, s, s);
    if (limiter) { grad.addColorStop(0, '#ff3b58'); grad.addColorStop(1, '#ff8a4a'); }
    else if (this.needle > rlFrac) { grad.addColorStop(0, '#ff7a1a'); grad.addColorStop(1, '#ff3b58'); }
    else { grad.addColorStop(0, '#14b6ff'); grad.addColorStop(1, '#29e0a8'); }
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP * Math.max(this.needle, 0.001));
    ctx.strokeStyle = grad;
    ctx.lineWidth = s * 0.055;
    ctx.shadowColor = this.needle > rlFrac ? 'rgba(255,80,60,0.75)' : 'rgba(41,224,168,0.55)';
    ctx.shadowBlur = s * 0.05;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // pedal arcs
    const inner = r * 0.80;
    ctx.lineWidth = s * 0.020;
    ctx.beginPath();
    ctx.arc(cx, cy, inner, START, START + SWEEP * clamp01(throttle));
    ctx.strokeStyle = 'rgba(41,224,168,0.75)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, inner - s * 0.028, START, START + SWEEP * clamp01(brake));
    ctx.strokeStyle = 'rgba(255,59,88,0.75)';
    ctx.stroke();
  }
}

/* ═══════════════════════════ minimap ═══════════════════════════ */

class Minimap {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.range = 300;
    this.built = false;
  }

  build(world) {
    this.world = world;
    this.built = true;
  }

  resize() {
    const css = this.c.clientWidth || 190;
    const px = Math.round(css * this.dpr);
    if (this.c.width !== px) { this.c.width = px; this.c.height = px; }
    this.size = px;
  }

  draw(player, entrants, race) {
    if (!this.built) return;
    this.resize();
    const ctx = this.ctx;
    const s = this.size;
    const R = s / 2;
    const sp = this.world.spline;
    ctx.clearRect(0, 0, s, s);

    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(9,12,17,0.55)';
    ctx.fillRect(0, 0, s, s);

    const px = player.position.x, pz = player.position.z;
    const yaw = Math.atan2(player.forward.x, player.forward.z);
    const scale = R / this.range;

    ctx.translate(R, R);
    ctx.rotate(yaw);          // rotate world so the player always faces up
    ctx.scale(scale, -scale); // canvas +y is down; world +z should be up-screen
    ctx.translate(-px, -pz);

    // nearby track ribbon
    const q = sp.query(px, pz, {});
    const centre = q.far ? 0 : q.index;
    const per = sp.length / sp.count;
    const span = Math.ceil((this.range * 1.5) / per);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = -span; k <= span; k++) {
      const i = (centre + k + sp.count * 4) % sp.count;
      if (k === -span) ctx.moveTo(sp.x[i], sp.z[i]);
      else ctx.lineTo(sp.x[i], sp.z[i]);
    }
    ctx.strokeStyle = 'rgba(150,168,190,0.30)';
    ctx.lineWidth = 17 / 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(210,225,240,0.55)';
    ctx.lineWidth = 2.4;
    ctx.setLineDash([9, 9]);
    ctx.stroke();
    ctx.setLineDash([]);

    // checkpoints
    if (race && race.mode !== 'freeroam' && this.world.checkpoints) {
      const pe = race.player;
      for (const cp of this.world.checkpoints) {
        const dx = cp.position.x - px, dz = cp.position.z - pz;
        if (dx * dx + dz * dz > (this.range * 1.4) ** 2) continue;
        const isNext = pe && cp.index === pe.nextCp;
        ctx.beginPath();
        ctx.arc(cp.position.x, cp.position.z, isNext ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = cp.isFinish ? '#ffc94a' : (isNext ? '#29e0a8' : 'rgba(41,224,168,0.35)');
        ctx.fill();
      }
    }

    // rivals
    for (const e of entrants) {
      if (e.isPlayer || !e.vehicle.isAlive) continue;
      const v = e.vehicle;
      const dx = v.position.x - px, dz = v.position.z - pz;
      if (dx * dx + dz * dz > (this.range * 1.3) ** 2) continue;
      ctx.save();
      ctx.translate(v.position.x, v.position.z);
      ctx.rotate(-Math.atan2(v.forward.x, v.forward.z));
      ctx.beginPath();
      ctx.moveTo(0, 9);
      ctx.lineTo(-5.5, -6);
      ctx.lineTo(5.5, -6);
      ctx.closePath();
      ctx.fillStyle = e.colour || '#ff7a1a';
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // player marker at centre, always pointing up
    ctx.save();
    ctx.translate(R, R);
    ctx.beginPath();
    ctx.moveTo(0, -R * 0.085);
    ctx.lineTo(-R * 0.055, R * 0.055);
    ctx.lineTo(0, R * 0.025);
    ctx.lineTo(R * 0.055, R * 0.055);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();

    // north indicator
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(yaw);
    ctx.fillStyle = 'rgba(255,120,120,0.8)';
    ctx.font = `700 ${Math.round(s * 0.055)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -R * 0.84);
    ctx.restore();
  }
}

/* ═══════════════════════════ HUD ═══════════════════════════ */

export class HUD {
  constructor() {
    this.root = $('hud');
    this.tacho = new Tacho($('tacho'));
    this.minimap = new Minimap($('minimap'));
    this.el = {
      pos: $('hud-pos'), lap: $('hud-lap'),
      posWrap: $('hud-pos-wrap'), lapWrap: $('hud-lap-wrap'),
      time: $('hud-time'), last: $('hud-last'), best: $('hud-best'),
      delta: $('hud-delta'), deltaRow: $('hud-delta-row'),
      speed: $('speed-value'), unit: $('speed-unit'), gear: $('gear-value'),
      standings: $('hud-standings'),
      countdown: $('countdown'), banner: $('banner'), cpPop: $('checkpoint-pop'),
      dmgValue: $('dmg-value'), hint: $('hud-hint'), pips: $('assist-pips'),
    };
    this.dmgParts = {
      front: $('dmg-front'), rear: $('dmg-rear'),
      left: $('dmg-left'), right: $('dmg-right'), core: $('dmg-core'),
    };
    this._hintTimer = 0;
    this._bannerTimer = 0;
    this._cpTimer = 0;
    this._smoothSpeed = 0;
    this._standingsHtml = '';
    this._pipHtml = '';
    this._lastDmg = -1;
    this.visible = false;
  }

  show(v) {
    this.visible = v;
    this.root.classList.toggle('hidden', !v);
  }

  setWorld(world) { this.minimap.build(world); }

  showCountdown(text, isGo = false) {
    const el = this.el.countdown;
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.toggle('go', isGo);
    // restart the pop animation
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this._countdownTimer = isGo ? 1.1 : 0.95;
  }

  hideCountdown() { this.el.countdown.classList.add('hidden'); }

  showBanner(html, seconds = 2.6) {
    this.el.banner.innerHTML = html;
    this.el.banner.classList.remove('hidden');
    this._bannerTimer = seconds;
  }

  showCheckpoint(text) {
    this.el.cpPop.textContent = text;
    this.el.cpPop.classList.remove('hidden');
    this.el.cpPop.style.animation = 'none';
    void this.el.cpPop.offsetWidth;
    this.el.cpPop.style.animation = '';
    this._cpTimer = 1.0;
  }

  showHint(html, seconds = 4) {
    if (this._hintHtml !== html) {
      this.el.hint.innerHTML = html;
      this._hintHtml = html;
    }
    this.el.hint.classList.add('show');
    this._hintTimer = seconds;
  }

  clearHint() {
    this._hintTimer = 0;
    this.el.hint.classList.remove('show');
  }

  update(dt, state) {
    if (!this.visible) return;
    const { vehicle, race, entrant, units, assists, world } = state;
    const t = vehicle.telemetry;

    // ── speed + gear ──
    const raw = units === 'mph' ? t.speedKmh * 0.621371 : t.speedKmh;
    this._smoothSpeed = damp(this._smoothSpeed, raw, 24, dt);
    this.el.speed.textContent = String(Math.round(this._smoothSpeed));
    this.el.unit.textContent = units === 'mph' ? 'mph' : 'km/h';
    this.el.gear.textContent = t.gearLabel;
    const nearRedline = t.rpm / vehicle.car.engine.redline > 0.93;
    this.el.gear.parentElement.classList.toggle('shift', nearRedline);

    this.tacho.draw(t.rpm, vehicle.car.engine.redline, t.gearLabel, t.throttle, t.brake, t.limiter, dt);

    // ── damage ──
    const dmgPct = Math.round(t.damage * 100);
    if (dmgPct !== this._lastDmg) {
      this._lastDmg = dmgPct;
      this.el.dmgValue.textContent = String(dmgPct);
      const z = vehicle.damageZones;
      const paint = (el, v) => {
        if (!el) return;
        const a = clamp01(v);
        const r = Math.round(lerp(255, 255, a));
        const g = Math.round(lerp(255, 60, a));
        const b = Math.round(lerp(255, 70, a));
        el.style.fill = a < 0.02 ? 'rgba(255,255,255,0.13)' : `rgba(${r},${g},${b},${0.22 + a * 0.65})`;
      };
      paint(this.dmgParts.front, z.front);
      paint(this.dmgParts.rear, z.rear);
      paint(this.dmgParts.left, z.left);
      paint(this.dmgParts.right, z.right);
      paint(this.dmgParts.core, t.damage);
    }

    // ── race info ──
    const isRace = race && race.mode !== 'freeroam';
    this.el.posWrap.style.display = isRace ? '' : 'none';
    this.el.lapWrap.style.display = isRace ? '' : 'none';
    this.el.standings.parentElement.style.display = race && race.mode === 'race' ? '' : 'none';

    if (entrant) {
      if (isRace) {
        this.el.pos.textContent = `${entrant.position}/${race.entrants.length}`;
        this.el.lap.textContent = `${Math.min(entrant.lap + 1, race.laps)}/${race.laps}`;
      }
      const lapTime = race.state === 'running' || race.state === 'finished'
        ? Math.max(0, race.time - entrant.lapStart) : 0;
      this.el.time.textContent = formatTime(lapTime);
      this.el.last.textContent = entrant.lapTimes.length ? formatTime(entrant.lapTimes[entrant.lapTimes.length - 1]) : '—';
      this.el.best.textContent = entrant.bestLap != null ? formatTime(entrant.bestLap) : '—';

      if (isRace && entrant.position > 1) {
        this.el.deltaRow.style.display = '';
        this.el.delta.textContent = formatGap(entrant.gapAhead);
        this.el.delta.className = 'pos';
      } else if (isRace && entrant.position === 1 && race.entrants.length > 1) {
        this.el.deltaRow.style.display = '';
        const second = race.standings?.[1];
        this.el.delta.textContent = second ? formatGap(-second.gapToLeader) : '—';
        this.el.delta.className = 'neg';
      } else {
        this.el.deltaRow.style.display = 'none';
      }
    }

    // ── standings ──
    if (race && race.mode === 'race' && race.standings) {
      let html = '';
      for (const e of race.standings) {
        const gap = e.position === 1 ? 'LEADER' : formatGap(e.gapToLeader);
        html += `<div class="st-row${e.isPlayer ? ' me' : ''}">`
          + `<span class="st-pos">${e.position}</span>`
          + `<span class="st-dot" style="background:${e.colour}"></span>`
          + `<span class="st-name">${e.name}</span>`
          + `<span class="st-gap">${e.finished ? 'FIN' : gap}</span></div>`;
      }
      if (html !== this._standingsHtml) {
        this.el.standings.innerHTML = html;
        this._standingsHtml = html;
      }
    }

    // ── assist pips ──
    const pips = [];
    if (assists) {
      pips.push(`<span class="a-pip${assists.tcs ? ' on' : ''}">TC</span>`);
      pips.push(`<span class="a-pip${assists.abs ? ' on' : ''}">ABS</span>`);
      pips.push(`<span class="a-pip${assists.stability ? ' on' : ''}">ESC</span>`);
      pips.push(`<span class="a-pip${assists.autoGearbox ? ' on' : ''}">AUTO</span>`);
    }
    if (entrant?.wrongWay) pips.push('<span class="a-pip warn">WRONG WAY</span>');
    if (t.damage > 0.55) pips.push('<span class="a-pip warn">DAMAGE</span>');
    const pipHtml = pips.join('');
    if (pipHtml !== this._pipHtml) {
      this.el.pips.innerHTML = pipHtml;
      this._pipHtml = pipHtml;
    }

    // ── minimap ──
    this.minimap.draw(vehicle, race ? race.entrants : [], race);

    // ── timed elements ──
    if (this._countdownTimer > 0) {
      this._countdownTimer -= dt;
      if (this._countdownTimer <= 0) this.hideCountdown();
    }
    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.el.banner.classList.add('hidden');
    }
    if (this._cpTimer > 0) {
      this._cpTimer -= dt;
      if (this._cpTimer <= 0) this.el.cpPop.classList.add('hidden');
    }
    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.el.hint.classList.remove('show');
    }
  }
}

/* ═══════════════════════════ toasts ═══════════════════════════ */

const toastStack = () => document.getElementById('toast-stack');

export function toast(message, kind = '', seconds = 2.6) {
  const stack = toastStack();
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, seconds * 1000);
}
