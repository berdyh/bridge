// Test-only app: fake identities and real D1 + Hono + hibernating relay.
import { createRelayDurableObject, createDoRelayGateway } from './do-transport.ts';
import { createBridgeWorker } from './worker.ts';
import { createD1DeviceStore } from '../../server-d1/src/d1-store.ts';
const configFor = (env) => ({
  app: { id: 'test', name: 'Test bridge' }, origin: 'https://app.test',
  enrollPage: '/bridge/enroll',
  auth: { issuer: 'https://auth.test', clientId: 'client', deviceAuthorizationEndpoint: 'https://auth.test/device', tokenEndpoint: 'https://auth.test/token' },
  adapters: {
    relay: createDoRelayGateway(env.RELAY), store: createD1DeviceStore(env.DB),
    verifier: { verifyBrowser: async (token) => token === 'browser' ? { userId: 'alice' } : undefined, verifyRunner: async (token) => ['alice', 'bob'].includes(token) ? { userId: token, credentialId: 'key-' + token } : undefined },
  },
});
export const Relay = createRelayDurableObject(configFor);
export default createBridgeWorker(configFor);
