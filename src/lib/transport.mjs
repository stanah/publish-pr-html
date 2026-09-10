// Decide how the HTML travels to the workflow.
// The decision is made on the byte length of the whole dispatch payload
// ({ref, inputs} as JSON), never on the file size alone.

export const INLINE_LIMIT_BYTES = 60_000;

export function buildDispatchPayload({ ref, prNumber, headSha, requestId, htmlSha256, transport, html, assetId }) {
  const inputs = {
    pr_number: String(prNumber),
    head_sha: headSha,
    request_id: requestId,
    html_sha256: htmlSha256,
    transport,
  };
  if (transport === 'inline') inputs.html = html;
  else inputs.asset_id = String(assetId);
  return { ref, inputs };
}

export function payloadByteLength(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Returns {transport: 'inline', payload, bytes} when the inline payload fits,
 * otherwise {transport: 'release', bytes} (payload is built after the upload).
 */
export function chooseTransport({ ref, prNumber, headSha, requestId, htmlSha256, html, limit = INLINE_LIMIT_BYTES }) {
  const payload = buildDispatchPayload({ ref, prNumber, headSha, requestId, htmlSha256, transport: 'inline', html });
  const bytes = payloadByteLength(payload);
  if (bytes <= limit) return { transport: 'inline', payload, bytes };
  return { transport: 'release', bytes };
}
