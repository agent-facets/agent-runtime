import { describe, expect, test } from 'bun:test';
import { asPersistenceError, PersistenceError, sqlStateOf } from './errors.ts';
import { jsonText, parseJsonText } from './json.ts';

describe('JSON text codec', () => {
  test('preserves false, null, zero and empty values', () => {
    for (const value of [false, null, 0, '', [], {}, { answer: false, choice: null }]) {
      expect(parseJsonText(jsonText(value)) as unknown).toEqual(value);
    }
  });

  test('refuses values that JSON would silently change', () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, [() => 1], new Date(0)]) {
      expect(() => jsonText(value)).toThrow();
    }
  });

  test('refuses non-text database values', () => {
    expect(() => parseJsonText(null)).toThrow();
  });
});

describe('persistence errors', () => {
  test('retain only a SQLSTATE from driver errors', () => {
    const driverError = Object.assign(new Error('password=secret host=db'), { errno: '23505' });
    const error = asPersistenceError(driverError, 'migration_failed', 'migration failed');
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error.sqlState).toBe('23505');
    expect(error.message).toBe('migration failed');
    expect(sqlStateOf({ code: 'ERR_POSTGRES_CONNECTION_CLOSED' })).toBeUndefined();
  });
});
