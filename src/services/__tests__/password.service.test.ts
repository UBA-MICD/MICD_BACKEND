import { hashPassword, verifyPassword } from '../password.service'

describe('password.service', () => {
  it('hashPassword never returns the plaintext password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toBe('correct horse battery staple')
  })

  it('hashPassword produces a bcrypt hash with cost factor >= 12', async () => {
    const hash = await hashPassword('correct horse battery staple')
    // bcrypt hash shape: $2a$<cost>$<22-char-salt><31-char-hash>
    const match = hash.match(/^\$2[aby]\$(\d{2})\$/)
    expect(match).not.toBeNull()
    const cost = Number(match![1])
    expect(cost).toBeGreaterThanOrEqual(12)
  })

  it('verifyPassword returns true for the correct password', async () => {
    const hash = await hashPassword('s3cr3t-p@ssword')
    await expect(verifyPassword('s3cr3t-p@ssword', hash)).resolves.toBe(true)
  })

  it('verifyPassword returns false for an incorrect password', async () => {
    const hash = await hashPassword('s3cr3t-p@ssword')
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false)
  })

  it('hashing the same password twice yields different hashes (random salt)', async () => {
    const a = await hashPassword('same-input')
    const b = await hashPassword('same-input')
    expect(a).not.toBe(b)
  })
})
