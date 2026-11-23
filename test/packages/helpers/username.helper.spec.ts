import { pickFreeUsername, usernameBase } from '@packages/helpers';

describe('usernameBase', () => {
  it('maps the Vietnamese d-stroke instead of dropping it', () => {
    expect(usernameBase('Đức', 'Nguyễn')).toBe('nguyenduc');
    expect(usernameBase('đạt', 'Đỗ')).toBe('dodat');
  });

  it('strips diacritics and non-alphanumerics, joining words with the separator', () => {
    expect(usernameBase('Văn Ánh', 'Nguyễn')).toBe('nguyenvananh');
    expect(usernameBase('Văn Ánh', 'Nguyễn', '_')).toBe('nguyenvan_anh');
  });

  it('never returns an empty username', () => {
    expect(usernameBase('日本', '中国')).toBe('user');
  });

  it('keeps the base within the VarChar(50) budget', () => {
    expect(usernameBase('a'.repeat(200), 'b'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('pickFreeUsername', () => {
  it('returns the base when it is free', async () => {
    await expect(pickFreeUsername('an', async () => false)).resolves.toBe('an');
  });

  it('goes past ten same-named people instead of giving up', async () => {
    const taken = new Set(['an', ...Array.from({ length: 9 }, (_, i) => `an${i + 1}`)]);
    const result = await pickFreeUsername('an', async (c) => taken.has(c));
    expect(result).toMatch(/^an[0-9a-f]{6}$/);
  });

  it('uses the joiner between the base and the suffix', async () => {
    const taken = new Set(['an']);
    await expect(pickFreeUsername('an', async (c) => taken.has(c), '_')).resolves.toBe('an_1');
  });

  it('returns null only when every candidate is taken', async () => {
    await expect(pickFreeUsername('an', async () => true)).resolves.toBeNull();
  });
});
