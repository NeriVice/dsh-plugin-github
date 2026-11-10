/**
 * Schema normalization for tool definitions.
 *
 * dsh accepts author-facing schemas where a property marks itself required with
 * `required: true`, and compiles them to raw JSON Schema. This plugin writes its
 * schemas inline, so it normalizes them at registration time: `required: true`
 * annotations move into the owning object's `required` array, and every branch
 * is cloned so the registry cannot observe or mutate shared literals.
 */

/**
 * @template T
 * @param {T} node author-style or raw JSON Schema node
 * @returns {T} raw JSON Schema
 */
export function normalizeSchema(node) {
  return /** @type {T} */ (normalize(node));
}

/**
 * @param {unknown} node
 * @returns {unknown}
 */
function normalize(node) {
  if (Array.isArray(node)) return node.map((child) => normalize(child));
  if (node === null || typeof node !== 'object') return node;

  const source = /** @type {Record<string, unknown>} */ (node);
  /** @type {Record<string, unknown>} */
  const target = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'required' && typeof value === 'boolean') continue;
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {Record<string, unknown>} */
      const properties = {};
      for (const [name, child] of Object.entries(value)) properties[name] = normalize(child);
      target.properties = properties;
      continue;
    }
    if (key === 'items' || key === 'oneOf') {
      target[key] = normalize(value);
      continue;
    }
    target[key] = value;
  }

  if (source.properties !== null && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const required = Array.isArray(source.required)
      ? [...source.required]
      : Object.entries(/** @type {Record<string, unknown>} */ (source.properties))
        .filter(([, child]) => child !== null && typeof child === 'object' && /** @type {Record<string, unknown>} */ (child).required === true)
        .map(([name]) => name);
    if (required.length > 0) target.required = required;
  }

  return target;
}
