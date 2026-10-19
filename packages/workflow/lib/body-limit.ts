// Request body limit for the routes that carry SDK payloads: event writes
// (step inputs/outputs, errors) and stream chunks. One value keeps them aligned;
// a step that writes a payload to one must not be rejected by the other.
// Fastify's own default is 1 MB, too small for e.g. a base64 image.
export const DEFAULT_BODY_LIMIT_BYTES = 20 * 1024 * 1024

export function getBodyLimit (): number {
  const value = Number(process.env.WF_BODY_LIMIT_BYTES)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_BODY_LIMIT_BYTES
}
