// Preview sink: prints the draft, saves nothing.

/** @param {{out: (s: string) => void}} io */
export function createStdoutSink(io) {
  return {
    name: 'stdout',
    async createDraft(payload, meta) {
      io.out([
        `----- Draft for ${meta.personName} (preview only — nothing saved, nothing sent) -----`,
        `To:      ${payload.to.length ? payload.to.join(', ') : '(no recipient — add one before sending)'}`,
        `Subject: ${payload.subject}`,
        '',
        payload.body,
        '',
      ].join('\n'));
      return { status: 'previewed' };
    },
  };
}
