// Stand-in for the rssiguard RPC object while the daemon is not on the device.
//
// Same contract as cellguard-mock: the dev server asks the device first and
// only lands here on "method not found". Clients drift a few dB per poll so
// the weak-client highlighting and the strike counter can actually be watched.
const config = {
  enabled: false,
  min_rssi: -75,
  interval: 10,
  strikes: 3,
  ban_time: 30,
  grace: 30,
  exempt: []
};

const clients = [
  { mac: '02:00:00:00:01:01', iface: 'wlan0', signal: -52, noise: -95, snr: 43 },
  { mac: '02:00:00:00:01:02', iface: 'wlan0', signal: -71, noise: -95, snr: 24 },
  { mac: '02:00:00:00:01:03', iface: 'wlan1', signal: -79, noise: -93, snr: 14 }
];

const recent = [];
let nextId = 1;

function drift(value, spread) {
  return Math.round(value + (Math.random() * 2 - 1) * spread);
}

function snapshot() {
  return clients.map((c) => {
    const signal = drift(c.signal, 3);
    const weak = signal < config.min_rssi;
    c.strikes = weak ? (c.strikes || 0) + 1 : 0;
    if (config.enabled && c.strikes >= config.strikes) {
      recent.unshift({ mac: c.mac, iface: c.iface, signal, at: Math.floor(Date.now() / 1000) });
      recent.length = Math.min(recent.length, 20);
      c.strikes = 0;
    }
    return {
      ...c,
      signal,
      strikes: c.strikes,
      exempt: config.exempt.some((e) => e.mac === c.mac),
      settling: false,
      banned: false
    };
  });
}

export function handle(method, params = {}) {
  switch (method) {
    case 'get_config':
      return { ...config, exempt: [...config.exempt] };
    case 'set_config':
      Object.assign(config, params);
      return { code: 0 };
    case 'get_status':
      return {
        running: true,
        clients: snapshot(),
        recent: [...recent],
        error: null,
        updated: Math.floor(Date.now() / 1000)
      };
    case 'add_exempt': {
      const mac = String(params.mac || '').toUpperCase();
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
        return { code: -1, msg: 'mac must look like AA:BB:CC:DD:EE:FF' };
      }
      const id = `cfg${nextId++}`;
      config.exempt.push({ id, mac, note: params.note || '' });
      return { code: 0, id };
    }
    case 'remove_exempt':
      config.exempt = config.exempt.filter((e) => e.id !== params.id);
      return { code: 0 };
    case 'clear_bans':
      return { code: 0 };
    default:
      return null;
  }
}
