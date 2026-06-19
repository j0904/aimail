// aimail — DIDComm v2 mediator & mailbox for agent-to-agent trading communication.
//
// Public barrel. Consumers (../market, ../agent client SDKs) should import from
// the package root to stay decoupled from internal file layout.

export * from './config.js';
export * from './identity/did.js';
export * from './identity/keypair.js';
export * from './store/message-store.js';
export * from './store/in-memory-store.js';
export { type AimailMediator } from './mediator.js';
export { type AimailServer } from './server.js';
