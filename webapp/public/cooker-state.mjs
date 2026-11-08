// Turn both cloud state formats into the values shown by a dashboard card.
export function view(d) {
  const s = d.state ?? {};
  if (s.job || s['temperature-info'] || s['job-status']) {
    const job = s.job ?? {}, status = s['job-status'] ?? {}, pins = s['pin-info'] ?? {};
    const mode = String(job.mode ?? '').toUpperCase(), phase = String(status.state ?? '').toUpperCase();
    const total = Number(job['cook-time-seconds']) || 0;
    let left = status['cook-time-remaining'];
    // The cooker reports what is left every few seconds; count down in between while the timer runs.
    if (left != null && phase === 'COOKING' && d.receivedAt) left -= (Date.now() - d.receivedAt) / 1000;
    const lowWater = Boolean(pins['water-level-low'] || pins['water-level-critical']) || mode === 'LOW WATER';
    const alert = { 'LOW WATER': 'Low water', 'HIGH TEMP': 'Too hot', 'DEVICE FAILURE': 'Needs attention' }[mode] ?? null;
    const cooking = mode === 'COOK';
    return {
      unit: String(job['temperature-unit'] ?? 'C').toUpperCase() === 'F' ? 'F' : 'C',
      current: s['temperature-info']?.['water-temperature'],
      target: job['target-temperature'],
      cooking,
      timer: total ? { total, left: left ?? total, running: phase === 'COOKING' } : null,
      done: phase === 'TIMER EXPIRED',
      lowWater,
      alert,
    };
  }
  const n = s.nodes ?? {}, mode = s.state?.mode, t = n.timer;
  let timer = null;
  if (t?.initial) {
    let left = t.initial;
    if (t.mode === 'running' && t.startedAtTimestamp) left -= (Date.now() - Date.parse(t.startedAtTimestamp)) / 1000;
    timer = { total: t.initial, left, running: t.mode === 'running' };
  }
  const lowWater = Boolean(n.lowWater?.warning || n.lowWater?.empty) || mode === 'lowWater';
  const alert = { lowWater: 'Low water', highTemp: 'Too hot', motorStuck: 'Motor stuck', waterLeak: 'Water leak' }[mode] ?? null;
  const cooking = mode === 'cook';
  return {
    unit: s.state?.temperatureUnit === 'F' ? 'F' : 'C',
    current: n.waterTemperatureSensor?.current?.celsius,
    target: n.waterTemperatureSensor?.setpoint?.celsius,
    cooking,
    timer,
    done: t?.mode === 'completed',
    lowWater,
    alert,
    online: s.systemInfo?.online,
  };
}
