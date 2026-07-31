/**
 * Horizon Ridge circuit — a ~4.9 km closed loop that leaves the start straight in
 * open country, crosses the gorge on the arch bridge, sweeps the northern
 * plateau, bores through Ridgeline tunnel on the east side, then drops into the
 * city grid before the run back to the line.
 */
export const TRACK_CONTROL_POINTS = [
  [-560, -640],
  [-700, -400],
  [-780, -120],
  [-760, 160],
  [-660, 380],   // gorge crossing — bridge
  [-420, 640],
  [-100, 620],
  [250, 580],
  [520, 430],
  [700, 200],
  [760, -60],    // Ridgeline tunnel
  [700, -300],
  [520, -470],   // city
  [300, -560],
  [60, -600],
  [-180, -700],
  [-400, -760],
];

/** World-space anchor used to locate the tunnel section on the spline. */
export const TUNNEL_ANCHOR = { x: 752, z: -30, halfLength: 105 };

export const TRACK_NAME = 'Horizon Ridge';
export const CHECKPOINT_COUNT = 18;
