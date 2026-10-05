import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt 参数：N=16384 时内存约 16MiB，低于 scryptSync 默认 maxmem(32MiB)。
// 参数写入存储串，将来调参后旧哈希仍可验证。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

// 解析存储串时允许的参数上限，防脏数据让 scryptSync 申请超大内存或长时间阻塞
const MAX_N = 1 << 17;
const MAX_R = 32;
const MAX_P = 16;

/**
 * 生成密码哈希，格式 scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>。
 * 每次调用生成随机盐，同一密码哈希互不相同。
 * @param plain - 明文密码（原样哈希，不 trim——空格也是合法密码字符）。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

/**
 * 校验明文密码与存储串是否匹配。
 * 任何格式不符或异常一律返回 false（fail closed），不抛异常。
 * @param plain - 待校验的明文密码。
 * @param stored - {@link hashPassword} 生成的存储串。
 */
export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (n < 2 || n > MAX_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
    if ((n & (n - 1)) !== 0) return false; // N 必须是 2 的幂
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    // 显式传 maxmem：默认 32MiB 只够当前参数，将来调大 N/r 会直接抛错
    const actual = scryptSync(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    // timingSafeEqual 长度不等会抛 RangeError，先短路
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
