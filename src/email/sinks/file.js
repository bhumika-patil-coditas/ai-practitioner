// Staging sink (default): writes each draft as <dir>/<run>/<slug>.json (+ .txt preview).
// An agent or a human then relays the payloads to a mail client's *draft* API (see skills.md).
import fs from 'node:fs';
import path from 'node:path';
import { SinkError } from '../../errors.js';

/** @param {{dir: string, now: () => string}} opts */
export function createFileSink({ dir, now }) {
  const run = now().replace(/[:.]/g, '-');
  return {
    name: 'file',
    async createDraft(payload, meta) {
      const folder = path.join(dir, run);
      const jsonPath = path.join(folder, `${meta.slug}.json`);
      try {
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(jsonPath, `${JSON.stringify({ to: payload.to, subject: payload.subject, body: payload.body }, null, 2)}\n`);
        fs.writeFileSync(
          path.join(folder, `${meta.slug}.txt`),
          `To: ${payload.to.join(', ')}\nSubject: ${payload.subject}\n\n${payload.body}\n`,
        );
      } catch (err) {
        throw new SinkError(`cannot write draft for ${meta.personName} to ${folder}: ${err.message}`);
      }
      return { status: 'staged', location: jsonPath };
    },
  };
}
