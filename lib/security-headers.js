import { createHash } from 'node:crypto';
const importMap = '{"imports":{"ethers":"/vendor/ethers.js"}}';
const cspHash = createHash('sha256').update(importMap).digest('base64');
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'sha256-" + cspHash + "'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://mm-sdk-relay.api.cx.metamask.io https://mm-sdk-relay.api.cx.metamask.io https://ethereum-rpc.publicnode.com https://ethereum-sepolia-rpc.publicnode.com https://ethereum-hoodi-rpc.publicnode.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});
