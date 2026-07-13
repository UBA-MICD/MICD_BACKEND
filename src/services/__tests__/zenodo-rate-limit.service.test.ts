import { pool } from '../../db'
import {
  getRequestCount,
  throttle,
  getQuotaStatus,
  THROTTLE_AT,
} from '../zenodo-rate-limit.service'

jest.mock('../../db', () => ({ pool: { query: jest.fn() } }))

const poolQuery = pool.query as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()  // resets mockOnce queues between tests
})

describe('getRequestCount', () => {
  it('returns the count from DB', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ count: '42' }] })
    const count = await getRequestCount('production')
    expect(count).toBe(42)
    expect(poolQuery.mock.calls[0][1]).toEqual(['production'])
  })
})

describe('throttle', () => {
  it('records request without sleeping when under threshold', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })                   // prune
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })   // getRequestCount
      .mockResolvedValueOnce({ rows: [] })                   // recordRequest

    await throttle('production')

    expect(poolQuery).toHaveBeenCalledTimes(3)
    // No MIN(requested_at) query should have been made
    const minQuery = poolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('MIN(requested_at)'),
    )
    expect(minQuery).toBeUndefined()
  })

  it('queries MIN(requested_at) and records request when count is at THROTTLE_AT', async () => {
    jest.useFakeTimers()
    const oldestTime = new Date(Date.now() - 59_500) // expires in ~500ms
    poolQuery
      .mockResolvedValueOnce({ rows: [] })                                      // prune
      .mockResolvedValueOnce({ rows: [{ count: String(THROTTLE_AT) }] })       // getRequestCount
      .mockResolvedValueOnce({ rows: [{ oldest: oldestTime }] })               // MIN(requested_at)
      .mockResolvedValueOnce({ rows: [] })                                      // recordRequest

    const p = throttle('production')
    await jest.runAllTimersAsync()
    await p
    jest.useRealTimers()

    // MIN query must have been called
    const minQuery = poolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('MIN(requested_at)'),
    )
    expect(minQuery).toBeDefined()
    expect(minQuery![1]).toEqual(['production'])
    expect(poolQuery).toHaveBeenCalledTimes(4)
  })

  it('uses the environment parameter in all queries', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] })

    await throttle('sandbox')

    const calls = poolQuery.mock.calls
    const envCalls = calls.filter((c) => Array.isArray(c[1]) && c[1].includes('sandbox'))
    expect(envCalls.length).toBeGreaterThanOrEqual(1)
  })
})

describe('getQuotaStatus', () => {
  const originalEnv = process.env.ZENODO_QUOTA_LIMIT_GB

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.ZENODO_QUOTA_LIMIT_GB
    } else {
      process.env.ZENODO_QUOTA_LIMIT_GB = originalEnv
    }
  })

  it('calculates percent_used and alert=false when under 90%', async () => {
    process.env.ZENODO_QUOTA_LIMIT_GB = '50'
    const usedBytes = 40 * 1024 * 1024 * 1024 // 40 GB = 80%
    poolQuery.mockResolvedValueOnce({ rows: [{ total: String(usedBytes) }] })

    const status = await getQuotaStatus('production')

    expect(status.usedBytes).toBe(usedBytes)
    expect(status.limitBytes).toBe(50 * 1024 * 1024 * 1024)
    expect(status.percentUsed).toBeCloseTo(0.8)
    expect(status.alert).toBe(false)
    expect(status.alertMessage).toBeNull()
  })

  it('sets alert=true and alertMessage when at or above 90%', async () => {
    process.env.ZENODO_QUOTA_LIMIT_GB = '50'
    const usedBytes = 46 * 1024 * 1024 * 1024 // 92%
    poolQuery.mockResolvedValueOnce({ rows: [{ total: String(usedBytes) }] })

    const status = await getQuotaStatus('production')

    expect(status.alert).toBe(true)
    expect(status.alertMessage).toMatch(/⚠/)
    expect(status.alertMessage).toMatch(/92%/)
    expect(status.alertMessage).toMatch(/contactar/)
  })

  it('returns 0 used when no published depositions exist', async () => {
    process.env.ZENODO_QUOTA_LIMIT_GB = '50'
    poolQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] })

    const status = await getQuotaStatus('production')

    expect(status.usedBytes).toBe(0)
    expect(status.percentUsed).toBe(0)
    expect(status.alert).toBe(false)
  })

  it('respects ZENODO_QUOTA_LIMIT_GB env var', async () => {
    process.env.ZENODO_QUOTA_LIMIT_GB = '100'
    const usedBytes = 95 * 1024 * 1024 * 1024
    poolQuery.mockResolvedValueOnce({ rows: [{ total: String(usedBytes) }] })

    const status = await getQuotaStatus('production')

    expect(status.limitBytes).toBe(100 * 1024 * 1024 * 1024)
    expect(status.percentUsed).toBeCloseTo(0.95)
    expect(status.alert).toBe(true)
  })
})
