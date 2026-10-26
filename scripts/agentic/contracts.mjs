import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export async function contractHash(contract) {
  const payload = contract && typeof contract === 'object' && !Array.isArray(contract)
    ? Object.fromEntries(Object.entries(contract).filter(([key]) => key !== 'hash'))
    : contract;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function loadSchema(schemaName, schemaDir) {
  const file = isAbsolute(schemaName) ? schemaName : join(schemaDir, schemaName);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return true;
}

function equal(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function formatValid(value, format) {
  if (typeof value !== 'string') return false;
  if (format === 'date-time') return ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
  if (format === 'date') return ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === 'time') return ISO_TIME.test(value);
  return true;
}

function resolveRef(ref, schemaDir, rootSchema) {
  if (ref === '#' || ref === '#/') return rootSchema;
  if (ref.startsWith('#/')) {
    return ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema);
  }
  if (!schemaDir || ref.includes('://')) return undefined;
  return loadSchema(ref, schemaDir);
}

function check(value, schema, context, path, rootSchema) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, context.schemaDir, rootSchema);
    if (!resolved) return [{ path, message: `unresolvable $ref ${schema.$ref}` }];
    return check(value, resolved, context, path, resolved);
  }
  if (schema.allOf) for (const sub of schema.allOf) errors.push(...check(value, sub, context, path, rootSchema));
  if (schema.anyOf && !schema.anyOf.some(sub => check(value, sub, context, path, rootSchema).length === 0)) errors.push({ path, message: 'must match anyOf' });
  if (schema.oneOf && schema.oneOf.filter(sub => check(value, sub, context, path, rootSchema).length === 0).length !== 1) errors.push({ path, message: 'must match exactly one oneOf schema' });
  if (schema.not && check(value, schema.not, context, path, rootSchema).length === 0) errors.push({ path, message: 'must not match not schema' });
  if (schema.const !== undefined && !equal(value, schema.const)) errors.push({ path, message: 'must equal const' });
  if (schema.enum && !schema.enum.some(item => equal(value, item))) errors.push({ path, message: 'must be one of enum values' });
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) {
      errors.push({ path, message: `must be ${types.join(' or ')}` });
      return errors;
    }
  }
  if (schema.format && value !== null && !formatValid(value, schema.format)) errors.push({ path, message: `must match format ${schema.format}` });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: 'string is too short' });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: 'string is too long' });
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push({ path, message: 'string does not match pattern' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: 'number is below minimum' });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: 'number is above maximum' });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: 'array has too few items' });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: 'array has too many items' });
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) errors.push({ path, message: 'array items must be unique' });
    if (schema.items) value.forEach((item, index) => errors.push(...check(item, schema.items, context, `${path}[${index}]`, rootSchema)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = schema.required || [];
    for (const key of required) if (!(key in value)) errors.push({ path, message: `missing required property ${key}` });
    const properties = schema.properties || {};
    for (const [key, sub] of Object.entries(properties)) if (key in value) errors.push(...check(value[key], sub, context, `${path}.${key}`, rootSchema));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) errors.push({ path: `${path}.${key}`, message: 'additional property is not allowed' });
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) errors.push({ path, message: 'object has too few properties' });
  }
  return errors;
}

export function validate(value, schema, options = {}) {
  const errors = check(value, schema, { schemaDir: options.schemaDir }, '$', schema);
  return { valid: errors.length === 0, errors };
}

export function assertValid(value, schema, options = {}) {
  const result = validate(value, schema, options);
  if (!result.valid) {
    const error = new Error(`CONTRACT_INVALID: ${result.errors.map(item => `${item.path} ${item.message}`).join('; ')}`);
    error.code = 'CONTRACT_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return value;
}
