import supertest from 'supertest';
import { CLIENT_PROTOCOL } from '../src/core/client-protocol';

/** The current client contract; upgrade tests use raw supertest explicitly. */
export default function request(app: Parameters<typeof supertest>[0]) {
  return supertest.agent(app).set('X-Client-Protocol', String(CLIENT_PROTOCOL));
}
