// Stand-in for the cellguard RPC object while the daemon is not on the device.
//
// The dev server tries the device first and only falls back here when the
// device answers "method not found", so this disappears by itself the moment
// the real module is installed. State lives in memory for the life of the
// process -- enough to exercise add, remove and list from the browser.
let nextId = 1;

const state = {
  config: {
    enabled: false,
    interval: 5,
    dwell: 120,
    min_gain: 6,
    sinr_weight: 1.5,
    nr_bonus: 10,
    bw_weight: 0.5,
    unlock_when_no_candidate: true,
    blocks: []
  },
  serving: { rat: 'LTE', pci: 271, earfcn: 1850, cid: '1A2B3C4', rsrp: -95, sinr: 8, bw_mhz: 20 }
};

function addBlock({ pci, earfcn, cid, note }) {
  const id = `cfg${nextId++}`;
  state.config.blocks.push({
    id,
    pci: pci == null || pci === '' ? null : Number(pci),
    earfcn: earfcn == null || earfcn === '' ? null : Number(earfcn),
    cid: cid || '',
    note: note || ''
  });
  return { code: 0, id };
}

export function handle(method, params = {}) {
  switch (method) {
    case 'get_config':
      return { ...state.config, blocks: [...state.config.blocks] };
    case 'set_config':
      Object.assign(state.config, params);
      return { code: 0 };
    case 'get_status':
      return {
        running: true,
        serving: state.serving,
        candidates: [],
        locked: null,
        reason: 'mocked by the dev server',
        updated: Math.floor(Date.now() / 1000)
      };
    case 'add_block':
      if (params.pci == null && !params.cid) return { code: -1, msg: 'need a pci or a cid' };
      return addBlock(params);
    case 'block_current':
      return {
        ...addBlock({
          pci: state.serving.pci,
          earfcn: state.serving.earfcn,
          cid: state.serving.cid,
          note: params.note || 'blocked from the current connection'
        }),
        blocked: state.serving
      };
    case 'remove_block':
      state.config.blocks = state.config.blocks.filter((b) => b.id !== params.id);
      return { code: 0 };
    case 'unlock':
      return { code: 0 };
    case 'probe':
      return { output: 'mock: no modem attached to the dev server' };
    default:
      return null;
  }
}
