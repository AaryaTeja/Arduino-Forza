/**
 * Vehicle catalogue.
 *
 * Units are SI: kilograms, metres, newton-metres, radians.
 * Suspension stiffness/damping follow the Bullet raycast-vehicle convention that
 * Rapier's DynamicRayCastVehicleController inherits: `force = stiffness * compression * chassisMass`,
 * so stiffness is an acceleration-per-metre, and damping ≈ 2·sqrt(stiffness)·ζ.
 */

/** Normalised torque curve, sampled against rpm / redline. */
export const TORQUE_CURVE = [
  [0.00, 0.34], [0.10, 0.60], [0.20, 0.78], [0.32, 0.90],
  [0.45, 0.975], [0.58, 1.00], [0.70, 0.985], [0.82, 0.93],
  [0.93, 0.85], [1.00, 0.77], [1.10, 0.28],
];

export function torqueFactor(rpmFraction) {
  const c = TORQUE_CURVE;
  if (rpmFraction <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (rpmFraction <= c[i][0]) {
      const [x0, y0] = c[i - 1], [x1, y1] = c[i];
      const t = (rpmFraction - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return 0.15;
}

/** Lateral acceleration the shared racing line is solved at; AI rescale from this. */
export const REFERENCE_LAT_ACCEL = 11.5;

export const TYRE_COMPOUNDS = {
  street: { label: 'Street',  grip: 1.02, wetGrip: 0.78, offroad: 0.62, warmth: 0.9,  note: 'Long-wearing all-season rubber. Predictable but soft on grip.' },
  sport:  { label: 'Sport',   grip: 1.28, wetGrip: 0.92, offroad: 0.58, warmth: 1.0,  note: 'Semi-slick compound. Strong on tarmac, average in the wet.' },
  race:   { label: 'Race',    grip: 1.62, wetGrip: 0.86, offroad: 0.40, warmth: 1.15, note: 'Slick racing compound. Enormous dry grip, poor off the racing surface.' },
  rally:  { label: 'Rally',   grip: 1.12, wetGrip: 1.02, offroad: 1.05, warmth: 0.95, note: 'Knobbly gravel tyre. Transforms the car off-road, costs tarmac bite.' },
};

export const UPGRADE_DEFS = [
  { id: 'engine',  name: 'Engine',    max: 5, baseCost: 5200, effect: (l) => `+${(l * 6).toFixed(0)}% torque`,        note: 'Intake, exhaust, ECU, internals' },
  { id: 'gearbox', name: 'Gearbox',   max: 5, baseCost: 3600, effect: (l) => `−${(l * 14).toFixed(0)}% shift time`,   note: 'Closer ratios and a faster clutch' },
  { id: 'tyres',   name: 'Tyres',     max: 5, baseCost: 4100, effect: (l) => `+${(l * 5).toFixed(0)}% grip`,          note: 'Wider contact patch and stickier carcass' },
  { id: 'brakes',  name: 'Brakes',    max: 5, baseCost: 3100, effect: (l) => `+${(l * 8).toFixed(0)}% brake torque`,  note: 'Bigger discs, multi-piston calipers' },
  { id: 'weight',  name: 'Weight',    max: 5, baseCost: 6400, effect: (l) => `−${(l * 2.6).toFixed(1)}% mass`,        note: 'Carbon panels, stripped interior' },
  { id: 'aero',    name: 'Aero',      max: 5, baseCost: 4700, effect: (l) => `+${(l * 18).toFixed(0)}% downforce`,    note: 'Splitter, diffuser, adjustable wing' },
];

export function upgradeCost(def, level, car) {
  return Math.round(def.baseCost * Math.pow(level + 1, 1.45) * (0.7 + car.price / 220000));
}

export const TUNE_DEFS = [
  { id: 'finalDrive', name: 'Final drive',  min: 0, max: 1, fmt: (v) => `${(0.82 + v * 0.42).toFixed(2)}×`, note: 'Short = punchy acceleration. Long = higher top speed.' },
  { id: 'downforce',  name: 'Downforce',    min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%`,          note: 'More grip through fast corners, more drag on straights.' },
  { id: 'brakeBias',  name: 'Brake bias',   min: 0, max: 1, fmt: (v) => `${Math.round((0.36 + v * 0.38) * 100)}% front`, note: 'Rearward bias rotates the car; too much and it snaps.' },
  { id: 'rideHeight', name: 'Ride height',  min: 0, max: 1, fmt: (v) => `${(0.06 + v * 0.10).toFixed(3)} m`, note: 'Low lowers the roll centre. High survives kerbs and gravel.' },
  { id: 'arbFront',   name: 'ARB front',    min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%`,          note: 'Stiffer front = more understeer, flatter turn-in.' },
  { id: 'arbRear',    name: 'ARB rear',     min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)}%`,          note: 'Stiffer rear = livelier rotation, easier to provoke a slide.' },
  { id: 'steerLock',  name: 'Steering lock',min: 0, max: 1, fmt: (v) => `${Math.round((0.62 + v * 0.76) * 30)}°`, note: 'How far the front wheels can turn at full lock.' },
];

const suspensionDamping = (stiffness, zetaC = 0.72, zetaR = 0.86) => ({
  compression: 2 * Math.sqrt(stiffness) * zetaC,
  relaxation: 2 * Math.sqrt(stiffness) * zetaR,
});

export const CARS = [
  {
    id: 'kestrel',
    name: 'Kestrel Type-S',
    brand: 'Nomura',
    klass: 'Hot Hatch · FWD',
    price: 0,
    blurb: 'A 2.0-litre turbo hatch that punches far above its weight. Light, eager and forgiving — the ideal place to learn the Horizon loop before the money cars arrive.',
    drivetrain: 'fwd',
    mass: 1185,
    comHeight: -0.14,
    engine: { peakTorque: 320, redline: 6800, idle: 850, cylinders: 4, turbo: 0.75, revInertia: 0.24 },
    gears: [3.77, 2.10, 1.45, 1.09, 0.87, 0.72],
    reverseGear: 3.55,
    finalDrive: 4.10,
    driveEfficiency: 0.90,
    cdA: 0.74,
    downforceCoef: 0.28,
    brakeStrength: 0.34,
    brakeBias: 0.66,
    steerLock: 0.60,
    tyreGripBase: 1.0,
    body: {
      length: 4.28, width: 1.80, wheelbase: 2.62, trackF: 1.55, trackR: 1.53,
      wheelRadius: 0.315, wheelWidth: 0.225, rideHeight: 0.155,
      profile: 'hatch', wingSize: 0.35, colour: '#2f6fd6',
    },
    suspension: { stiffness: 34, travel: 0.19, rest: 0.30, ...suspensionDamping(34) },
    grid: { seatX: 0.36, seatZ: -0.16, seatY: 0.62 },
  },
  {
    id: 'aurelia',
    name: 'Aurelia GT',
    brand: 'Ferrante',
    klass: 'Grand Tourer · RWD',
    price: 55000,
    blurb: 'A front-mid V8 grand tourer. Long wheelbase, huge torque and a chassis that will hold a slide all day — the definitive Horizon cruiser.',
    drivetrain: 'rwd',
    mass: 1490,
    comHeight: -0.17,
    engine: { peakTorque: 505, redline: 7400, idle: 780, cylinders: 8, turbo: 0.0, revInertia: 0.30 },
    gears: [3.44, 2.21, 1.60, 1.24, 1.00, 0.80, 0.67],
    reverseGear: 3.10,
    finalDrive: 3.73,
    driveEfficiency: 0.92,
    cdA: 0.71,
    downforceCoef: 0.42,
    brakeStrength: 0.38,
    brakeBias: 0.62,
    steerLock: 0.55,
    tyreGripBase: 1.06,
    body: {
      length: 4.71, width: 1.94, wheelbase: 2.80, trackF: 1.66, trackR: 1.68,
      wheelRadius: 0.345, wheelWidth: 0.275, rideHeight: 0.135,
      profile: 'coupe', wingSize: 0.30, colour: '#c8102e',
    },
    suspension: { stiffness: 40, travel: 0.17, rest: 0.29, ...suspensionDamping(40) },
    grid: { seatX: 0.38, seatZ: -0.14, seatY: 0.60 },
  },
  {
    id: 'baron',
    name: 'Baron Trailmaster',
    brand: 'Kestrel Works',
    klass: 'Rally SUV · AWD',
    price: 72000,
    blurb: 'Long-travel dampers, a locking centre diff and enough ground clearance to ignore the road entirely. Slower on tarmac, untouchable across country.',
    drivetrain: 'awd',
    mass: 1905,
    comHeight: -0.05,
    engine: { peakTorque: 630, redline: 6200, idle: 700, cylinders: 6, turbo: 0.85, revInertia: 0.40 },
    gears: [3.90, 2.42, 1.68, 1.22, 0.94, 0.78],
    reverseGear: 3.60,
    finalDrive: 3.90,
    driveEfficiency: 0.87,
    cdA: 1.09,
    downforceCoef: 0.16,
    brakeStrength: 0.33,
    brakeBias: 0.60,
    steerLock: 0.62,
    tyreGripBase: 1.00,
    offroadBonus: 0.42,
    body: {
      length: 4.86, width: 2.02, wheelbase: 2.90, trackF: 1.72, trackR: 1.72,
      wheelRadius: 0.405, wheelWidth: 0.295, rideHeight: 0.285,
      profile: 'suv', wingSize: 0.20, colour: '#e0a02a',
    },
    suspension: { stiffness: 30, travel: 0.30, rest: 0.40, ...suspensionDamping(30, 0.62, 0.78) },
    grid: { seatX: 0.40, seatZ: -0.10, seatY: 0.86 },
  },
  {
    id: 'vulcan',
    name: 'Vulcan R8',
    brand: 'Ferrante',
    klass: 'Hypercar · AWD',
    price: 148000,
    blurb: 'Twin-turbo flat-plane V8, all-wheel drive and active aero. Absurdly fast in a straight line and nearly as quick through the corners — if you can hold it.',
    drivetrain: 'awd',
    mass: 1425,
    comHeight: -0.20,
    engine: { peakTorque: 790, redline: 8600, idle: 950, cylinders: 8, turbo: 0.95, revInertia: 0.22 },
    gears: [3.13, 2.29, 1.77, 1.41, 1.13, 0.92, 0.76],
    reverseGear: 2.90,
    finalDrive: 3.40,
    driveEfficiency: 0.93,
    cdA: 0.72,
    downforceCoef: 0.72,
    brakeStrength: 0.45,
    brakeBias: 0.63,
    steerLock: 0.52,
    tyreGripBase: 1.14,
    body: {
      length: 4.62, width: 2.03, wheelbase: 2.70, trackF: 1.71, trackR: 1.74,
      wheelRadius: 0.355, wheelWidth: 0.315, rideHeight: 0.110,
      profile: 'super', wingSize: 0.62, colour: '#f2b705',
    },
    suspension: { stiffness: 50, travel: 0.14, rest: 0.26, ...suspensionDamping(50, 0.78, 0.9) },
    grid: { seatX: 0.40, seatZ: -0.06, seatY: 0.52 },
  },
  {
    id: 'mistral',
    name: 'Mistral GT3-R',
    brand: 'Scuderia Volante',
    klass: 'GT Racer · RWD',
    price: 225000,
    blurb: 'A homologated GT3 car with a stripped tub, sequential box and a rear wing you could land a plane on. Merciless off the racing line, sublime on it.',
    drivetrain: 'rwd',
    mass: 1245,
    comHeight: -0.24,
    engine: { peakTorque: 640, redline: 8200, idle: 1200, cylinders: 6, turbo: 0.55, revInertia: 0.16 },
    gears: [2.92, 2.15, 1.72, 1.42, 1.19, 1.00],
    reverseGear: 2.70,
    finalDrive: 3.85,
    driveEfficiency: 0.95,
    cdA: 0.94,
    downforceCoef: 1.55,
    brakeStrength: 0.52,
    brakeBias: 0.64,
    steerLock: 0.48,
    tyreGripBase: 1.22,
    shiftTimeBase: 0.055,
    body: {
      length: 4.72, width: 2.05, wheelbase: 2.72, trackF: 1.78, trackR: 1.76,
      wheelRadius: 0.360, wheelWidth: 0.340, rideHeight: 0.085,
      profile: 'gt3', wingSize: 1.0, colour: '#f5f7fa',
    },
    suspension: { stiffness: 62, travel: 0.10, rest: 0.22, ...suspensionDamping(62, 0.85, 0.95) },
    grid: { seatX: 0.34, seatZ: -0.10, seatY: 0.50 },
  },
];

export const CAR_BY_ID = Object.fromEntries(CARS.map((c) => [c.id, c]));

export const PAINT_PRESETS = [
  '#c8102e', '#f2b705', '#1c8ae8', '#18b26b', '#f25c05', '#8c3fd6',
  '#0e1116', '#f5f7fa', '#7c8794', '#0b4f9e', '#00e0c6', '#e8dfd0',
  '#b8112a', '#2d3f52', '#d64ba0', '#5ee81f',
];

/**
 * Resolve a car + build into the concrete numbers the simulation and UI both use.
 */
export function resolveSpec(car, build) {
  const up = build.upgrades;
  const tune = build.tune;
  const tyre = TYRE_COMPOUNDS[build.tyre] || TYRE_COMPOUNDS.sport;

  const mass = car.mass * (1 - up.weight * 0.026);
  const peakTorque = car.engine.peakTorque * (1 + up.engine * 0.06);
  const finalDrive = car.finalDrive * (0.82 + tune.finalDrive * 0.42);
  const grip = car.tyreGripBase * tyre.grip * (1 + up.tyres * 0.05);
  const brakeStrength = car.brakeStrength * (1 + up.brakes * 0.08);
  const downforceCoef = car.downforceCoef * (1 + up.aero * 0.18) * (0.35 + tune.downforce * 1.3);
  const cdA = car.cdA * (1 + up.aero * 0.02 + tune.downforce * 0.10);
  const shiftTime = (car.shiftTimeBase ?? 0.19) * (1 - up.gearbox * 0.14);

  const power = estimatePeakPowerKw(peakTorque, car.engine.redline);

  return {
    car, build, tyre,
    mass, peakTorque, finalDrive, grip, brakeStrength, downforceCoef, cdA, shiftTime,
    powerKw: power,
    brakeBias: 0.36 + tune.brakeBias * 0.38,
    rideHeight: 0.06 + tune.rideHeight * 0.10,
    steerLock: car.steerLock * (0.62 + tune.steerLock * 0.76),
    arbFront: tune.arbFront,
    arbRear: tune.arbRear,
    wetGrip: tyre.wetGrip,
    offroadGrip: tyre.offroad + (car.offroadBonus || 0),
  };
}

export function estimatePeakPowerKw(peakTorque, redline) {
  let best = 0;
  for (let r = 0.2; r <= 1.0; r += 0.02) {
    const rpm = r * redline;
    const t = peakTorque * torqueFactor(r);
    const kw = (t * rpm * 2 * Math.PI) / 60 / 1000;
    if (kw > best) best = kw;
  }
  return best;
}

/** 100–999 performance index, Forza-style. */
export function performanceIndex(spec) {
  const pw = spec.powerKw / (spec.mass / 1000);           // kW per tonne
  const gripScore = spec.grip * 100;
  const aeroScore = Math.min(spec.downforceCoef, 2.2) * 26;
  const brakeScore = spec.brakeStrength * 190;
  const raw = pw * 1.42 + gripScore * 1.55 + aeroScore + brakeScore;
  return Math.max(100, Math.min(999, Math.round(raw)));
}

/** 0..1 bars for the garage readout. */
export function statBars(spec) {
  const topSpeed = estimateTopSpeed(spec);
  const accel = spec.powerKw / (spec.mass / 1000);
  return [
    { label: 'Speed',        value: Math.min(1, topSpeed / 105), text: `${Math.round(topSpeed * 3.6)} km/h` },
    { label: 'Acceleration', value: Math.min(1, accel / 420),     text: `${accel.toFixed(0)} kW/t` },
    { label: 'Handling',     value: Math.min(1, spec.grip / 1.95), text: `${spec.grip.toFixed(2)} μ` },
    { label: 'Braking',      value: Math.min(1, spec.brakeStrength / 0.62), text: `${(spec.brakeStrength * 3).toFixed(2)} g` },
    { label: 'Aero',         value: Math.min(1, spec.downforceCoef / 2.4),  text: `${spec.downforceCoef.toFixed(2)}` },
    { label: 'Off-road',     value: Math.min(1, spec.offroadGrip / 1.5),    text: `${spec.offroadGrip.toFixed(2)} μ` },
  ];
}

/** Solve drag-limited top speed in top gear. */
export function estimateTopSpeed(spec) {
  const { car } = spec;
  const topGear = car.gears[car.gears.length - 1];
  const r = car.body.wheelRadius;
  let best = 0;
  for (let v = 10; v < 140; v += 0.5) {
    const wheelRpm = (v / r) * (60 / (2 * Math.PI));
    const rpm = wheelRpm * topGear * spec.finalDrive;
    if (rpm > car.engine.redline * 1.02) break;
    const tf = torqueFactor(rpm / car.engine.redline);
    const force = (spec.peakTorque * tf * topGear * spec.finalDrive * car.driveEfficiency) / r;
    const drag = 0.5 * 1.225 * spec.cdA * v * v + spec.mass * 9.81 * 0.014;
    if (force <= drag) break;
    best = v;
  }
  return best || 40;
}
