// src/abi/grad.ts
export const factoryAbi = [
  // event CurveCreated(address indexed curve, address indexed token, address indexed creator);
  { type: 'event', name: 'CurveCreated', inputs: [
    { indexed: true, name: 'curve',  type: 'address' },
    { indexed: true, name: 'token',  type: 'address' },
    { indexed: true, name: 'creator',type: 'address' },
  ]},
] as const;

export const curveGradAbi = [
  // true if 100% and not graduated yet
  { type:'function', name:'isGraduatable', stateMutability:'view', inputs:[], outputs:[{type:'bool'}] },
  // some curves expose an explicit graduated flag
  { type:'function', name:'graduated', stateMutability:'view', inputs:[], outputs:[{type:'bool'}] },
  // progress in basis points, optional but nice for logs
  { type:'function', name:'progressBps', stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
  // claim / execute the graduation
  { type:'function', name:'graduate', stateMutability:'nonpayable', inputs:[], outputs:[] },

  // events (optional, for bookkeeping)
  { type:'event', name:'Graduated', inputs:[
    { indexed:true,  name:'token',  type:'address' },
    { indexed:false, name:'caller', type:'address' }
  ]},
] as const;

// LFG factory (mainnet)
export const LFG_FACTORY = '0xb19219AF8a65522f13B51f6401093c8342E27e9D' as const;
