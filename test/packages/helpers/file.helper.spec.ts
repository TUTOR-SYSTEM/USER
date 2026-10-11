import { decodeMulterFilename } from 'src/packages/helpers/file.helper';

describe('decodeMulterFilename', () => {
  it('passes ASCII names through unchanged', () => {
    expect(decodeMulterFilename('lecture-01.pdf')).toBe('lecture-01.pdf');
  });

  it('repairs a UTF-8 name that multer decoded as latin1', () => {
    const real = 'Bài giảng.pdf';
    const mojibake = Buffer.from(real, 'utf8').toString('latin1');
    expect(mojibake).not.toBe(real);
    expect(decodeMulterFilename(mojibake)).toBe(real);
  });

  it('returns an empty string for an empty name', () => {
    expect(decodeMulterFilename('')).toBe('');
  });

  it('is idempotent for already-correct ASCII input', () => {
    const once = decodeMulterFilename('a b.txt');
    expect(decodeMulterFilename(once)).toBe('a b.txt');
  });
});
