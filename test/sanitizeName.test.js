import { describe, it, expect } from 'vitest';

import { sanitizeName } from '../src/instances.mjs';

describe('sanitizeName', () => {
  it('lowercases the input', () => {
    expect(sanitizeName('HelloWorld')).toBe('helloworld');
  });

  it('trims whitespace', () => {
    expect(sanitizeName('  demo  ')).toBe('demo');
  });

  it('replaces non-alphanumeric characters with hyphens', () => {
    expect(sanitizeName('My Store')).toBe('my-store');
    expect(sanitizeName('foo_bar-baz')).toBe('foo-bar-baz');
  });

  it('removes leading and trailing hyphens', () => {
    expect(sanitizeName('--test--')).toBe('test');
  });

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeName(long)).toHaveLength(40);
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeName(null)).toBe('');
    expect(sanitizeName(undefined)).toBe('');
  });

  it('returns empty string for numeric input', () => {
    expect(sanitizeName(123)).toBe('123');
  });

  it('handles multiple consecutive special characters', () => {
    expect(sanitizeName('foo   bar')).toBe('foo-bar');
  });

  it('handles empty string', () => {
    expect(sanitizeName('')).toBe('');
  });
});
