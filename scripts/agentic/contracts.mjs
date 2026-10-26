import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const OFFSET = String.raw`(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)`;
const ISO_DATE_TIME = new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?${OFFSET}$`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = new RegExp(String.raw`^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$`);

/** Serialize JSON values with recursively sorted object keys and stable array order. */
export function canonicalJson(value, inArray = false) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? 'null' : undefined;
  }
  if (typeof value === 'bigint') throw new TypeError('Cannot canonicalize a BigInt');
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, true)).join(',')}]`;
  const entries = Object.keys(value).sort().flatMap(key => {
    const serialized = canonicalJson(value[key]);
    return serialized === undefined ? [] : [[JSON.stringify(key), serialized]];
  });
  return `{${entries.map(([key, serialized]) => `${key}:${serialized}`).join(',')}}`;
}

/** Return the SHA-256 of a contract, excluding only its top-level self-hash. */
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

function calendarDateValid(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function formatValid(value, format) {
  if (typeof value !== 'string') return false;
  if (format === 'date-time') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
    return ISO_DATE_TIME.test(value)
      && match !== null
      && calendarDateValid(Number(match[1]), Number(match[2]), Number(match[3]))
      && !Number.isNaN(Date.parse(value));
  }
  if (format === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return ISO_DATE.test(value)
      && match !== null
      && calendarDateValid(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (format === 'time') return ISO_TIME.test(value);
  return true;
}

function decodePointerPart(part) {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function pointerValue(root, pointer) {
  if (pointer === '' || pointer === undefined) return root;
  if (!pointer.startsWith('/')) return undefined;
  return pointer.slice(1).split('/').reduce((value, part) => {
    if (value === null || value === undefined) return undefined;
    const key = decodePointerPart(part);
    return value[key];
  }, root);
}

function resolveRef(ref, schemaDir, rootSchema) {
  if (ref === '#') return { schema: rootSchema, rootSchema };
  if (ref.startsWith('#/')) {
    return { schema: pointerValue(rootSchema, ref.slice(1)), rootSchema };
  }
  if (!schemaDir || ref.includes('://')) return undefined;
  const [resource, fragment] = ref.split('#', 2);
  try {
    const externalRoot = loadSchema(resource, schemaDir);
    return {
      schema: pointerValue(externalRoot, fragment === undefined ? '' : fragment),
      rootSchema: externalRoot,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function error(path, message) {
  return { path, message };
}

function check(value, schema, context, path, rootSchema) {
  if (schema === true) return [];
  if (schema === false) return [error(path, 'schema is false')];
  if (!schema || typeof schema !== 'object') return [error(path, 'invalid schema')];

  const errors = [];
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, context.schemaDir, rootSchema);
    if (!resolved || resolved.schema === undefined) {
      errors.push(error(path, `unresolvable $ref ${schema.$ref}`));
    } else {
      errors.push(...check(value, resolved.schema, context, path, resolved.rootSchema));
    }
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) errors.push(...check(value, sub, context, path, rootSchema));
  }
  if (schema.anyOf && !schema.anyOf.some(sub => check(value, sub, context, path, rootSchema).length === 0)) {
    errors.push(error(path, 'must match anyOf'));
  }
  if (schema.oneOf && schema.oneOf.filter(sub => check(value, sub, context, path, rootSchema).length === 0).length !== 1) {
    errors.push(error(path, 'must match exactly one oneOf schema'));
  }
  if (schema.not && check(value, schema.not, context, path, rootSchema).length === 0) {
    errors.push(error(path, 'must not match not schema'));
  }
  if (schema.const !== undefined && !equal(value, schema.const)) errors.push(error(path, 'must equal const'));
  if (schema.enum && !schema.enum.some(item => equal(value, item))) errors.push(error(path, 'must be one of enum values'));

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) {
      errors.push(error(path, `must be ${types.join(' or ')}`));
      return errors;
    }
  }

  if (schema.format && value !== null && !formatValid(value, schema.format)) {
    errors.push(error(path, `must match format ${schema.format}`));
  }

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(error(path, 'string is too short'));
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(error(path, 'string is too long'));
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(error(path, 'string does not match pattern'));
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(error(path, 'number is below minimum'));
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(error(path, 'number is above maximum'));
    if (schema.exclusiveMinimum !== undefined) {
      const exclusiveMinimum = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : schema.minimum;
      if (schema.exclusiveMinimum === true && schema.minimum === undefined) errors.push(error(path, 'invalid exclusiveMinimum schema'));
      else if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) errors.push(error(path, 'number is not above exclusive minimum'));
    }
    if (schema.exclusiveMaximum !== undefined) {
      const exclusiveMaximum = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : schema.maximum;
      if (schema.exclusiveMaximum === true && schema.maximum === undefined) errors.push(error(path, 'invalid exclusiveMaximum schema'));
      else if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) errors.push(error(path, 'number is not below exclusive maximum'));
    }
    if (schema.multipleOf !== undefined && value / schema.multipleOf % 1 !== 0) errors.push(error(path, 'number is not a multiple'));
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(error(path, 'array has too few items'));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(error(path, 'array has too many items'));
    if (schema.uniqueItems && new Set(value.map(item => canonicalJson(item))).size !== value.length) {
      errors.push(error(path, 'array items must be unique'));
    }
    if (schema.prefixItems) {
      for (const [index, sub] of schema.prefixItems.entries()) {
        if (index < value.length) errors.push(...check(value[index], sub, context, `${path}[${index}]`, rootSchema));
      }
    }
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((sub, index) => {
          if (index < value.length) errors.push(...check(value[index], sub, context, `${path}[${index}]`, rootSchema));
        });
      } else {
        const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
        value.forEach((item, index) => {
          if (index >= start) errors.push(...check(item, schema.items, context, `${path}[${index}]`, rootSchema));
        });
      }
    }
    if (schema.contains && !value.some((item, index) => check(item, schema.contains, context, `${path}[${index}]`, rootSchema).length === 0)) {
      errors.push(error(path, 'array must contain a matching item'));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(error(path, `missing required property ${key}`));
    }
    const properties = schema.properties || {};
    const patterns = schema.patternProperties || {};
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) errors.push(...check(value[key], sub, context, `${path}.${key}`, rootSchema));
    }
    for (const [key, item] of Object.entries(value)) {
      const matchedPattern = Object.entries(patterns).filter(([pattern]) => new RegExp(pattern).test(key));
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (matchedPattern.length > 0) {
        for (const [, sub] of matchedPattern) errors.push(...check(item, sub, context, `${path}.${key}`, rootSchema));
      } else if (schema.additionalProperties === false) {
        errors.push(error(`${path}.${key}`, 'additional property is not allowed'));
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...check(item, schema.additionalProperties, context, `${path}.${key}`, rootSchema));
      }
    }
    if (schema.propertyNames) {
      for (const key of keys) errors.push(...check(key, schema.propertyNames, context, `${path}.${key}`, rootSchema));
    }
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) errors.push(error(path, 'object has too few properties'));
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) errors.push(error(path, 'object has too many properties'));
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
    const failure = new Error(`CONTRACT_INVALID: ${result.errors.map(item => `${item.path} ${item.message}`).join('; ')}`);
    failure.code = 'CONTRACT_INVALID';
    failure.errors = result.errors;
    throw failure;
  }
  return value;
}
