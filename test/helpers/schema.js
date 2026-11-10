/**
 * A tiny JSON Schema validator covering the subset dsh accepts for tool
 * parameters and outputs: type, properties, required, additionalProperties,
 * items, enum, const, oneOf.
 */

/**
 * @param {any} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} violations, empty when the value conforms
 */
export function validate(schema, value, path = '$') {
  const violations = [];

  if (schema === true || schema === undefined) return violations;
  if (schema.type === undefined && schema.oneOf === undefined && schema.properties === undefined) return violations;

  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.some((branch) => validate(branch, value, path).length === 0);
    if (!matched) violations.push(`${path} matches no oneOf branch`);
    return violations;
  }

  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`);
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} must be a string`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a number`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${path} must be an integer`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`);
      break;
    case 'null':
      if (value !== null) violations.push(`${path} must be null`);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`);
        break;
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => violations.push(...validate(schema.items, item, `${path}[${index}]`)));
      }
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`${path} must be an object`);
        break;
      }
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} is not declared`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(value, key) && value[key] !== undefined) {
          violations.push(...validate(child, value[key], `${path}.${key}`));
        }
      }
      break;
    }
    default:
      break;
  }

  return violations;
}
