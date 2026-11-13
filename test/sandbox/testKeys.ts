// test/sandbox/testKeys.ts
// 测试用的 ed25519 密钥生成。
//
// 为什么不用 utils.generateKeyPairSync 直接生成:
// ssh2 1.17.0 生成 ed25519 私钥时,有约 0.5% 的概率把公钥密钥体截断
// (32 字节变成 31 或 30 字节)。截断的私钥连 ssh2 自己的 parseKey 都解析不了,
// 报 "Malformed OpenSSH private key"。这个概率落在"每次跑都可能撞上"的区间里,
// 会让 CI 偶发变红,而且和被测代码没关系。
//
// 这里生成后立刻用 ssh2 的 parseKey 校验一遍,失败就换一把重来。
// 换掉的概率约千分之五,重试几次一定拿到能用的。

import ssh2 from 'ssh2'

const { utils } = ssh2

/** ssh2 生成的密钥对形状。ssh2 返回的是 PEM 字符串,不是 Buffer。 */
export interface TestKeyPair {
  public: string
  private: string
}

/**
 * 生成一对能用的 ed25519 密钥。
 *
 * ssh2 的 parseKey 对私钥成功才返回对象,返回 Error 就是这把钥匙有问题。
 */
export function generateTestKeyPair(): TestKeyPair {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const keyPair = utils.generateKeyPairSync('ed25519')
    const parsed = utils.parseKey(keyPair.private)
    if (!(parsed instanceof Error)) return keyPair
  }
  // 20 次都失败说明不是概率问题,让测试直接报错,别继续往下跑
  throw new Error('连续 20 次生成的 ssh2 密钥都无法解析,上游库可能出问题了')
}
