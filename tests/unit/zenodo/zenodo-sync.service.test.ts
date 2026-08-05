import axios from 'axios'
import { pool } from '../../../src/db/pool'
import * as zenodoService from '../../../src/modules/zenodo/zenodo.service'
import {
  getSyncConfig,
  setSyncConfig,
  shouldRunSync,
  runSync,
  getSyncLogs,
  isValidInterval,
} from '../../../src/modules/zenodo/zenodo-sync.service'

jest.mock('axios')
jest.mock('../../../src/db/pool', () => ({ pool: { query: jest.fn() } }))
jest.mock('../../../src/modules/zenodo/zenodo.service', () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ['sandbox', 'production'],
}))
jest.mock('../../../src/modules/zenodo/zenodo-rate-limit.service', () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}))

const mockedAxios = axios as jest.Mocked<typeof axios>
const poolQuery = pool.query as jest.Mock
const mockedGetStoredToken = zenodoService.getStoredToken as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockedGetStoredToken.mockResolvedValue(null)
})

describe('isValidInterval', () => {
  it.each([6, 12, 24, 168])('accepts %i as valid', (v) => expect(isValidInterval(v)).toBe(true))
  it.each([0, 1, 48, null, 'daily'])('rejects %s as invalid', (v) => expect(isValidInterval(v)).toBe(false))
})

describe('getSyncConfig', () => {
  it('returns config from DB', async () => {
    const now = new Date()
    poolQuery.mockResolvedValueOnce({
      rows: [{ interval_hours: 24, last_run_at: now, updated_at: now }],
    })
    const cfg = await getSyncConfig()
    expect(cfg.intervalHours).toBe(24)
    expect(cfg.lastRunAt).toBe(now)
  })
})

describe('setSyncConfig', () => {
  it('upserts and returns new config', async () => {
    const now = new Date()
    poolQuery
      .mockResolvedValueOnce({ rows: [] })                                          // INSERT/UPDATE
      .mockResolvedValueOnce({ rows: [{ interval_hours: 12, last_run_at: null, updated_at: now }] }) // getSyncConfig
    const cfg = await setSyncConfig(12)
    expect(cfg.intervalHours).toBe(12)
    const upsertCall = poolQuery.mock.calls[0]
    expect(upsertCall[1]).toContain(12)
  })

  it('accepts null to disable sync', async () => {
    const now = new Date()
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ interval_hours: null, last_run_at: null, updated_at: now }] })
    const cfg = await setSyncConfig(null)
    expect(cfg.intervalHours).toBeNull()
  })
})

describe('shouldRunSync', () => {
  it('returns false when interval is null (disabled)', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ interval_hours: null, last_run_at: null, updated_at: new Date() }],
    })
    expect(await shouldRunSync()).toBe(false)
  })

  it('returns true when never run before', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ interval_hours: 24, last_run_at: null, updated_at: new Date() }],
    })
    expect(await shouldRunSync()).toBe(true)
  })

  it('returns false when last run was recent', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
    poolQuery.mockResolvedValueOnce({
      rows: [{ interval_hours: 24, last_run_at: recent, updated_at: new Date() }],
    })
    expect(await shouldRunSync()).toBe(false)
  })

  it('returns true when last run was long enough ago', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago
    poolQuery.mockResolvedValueOnce({
      rows: [{ interval_hours: 24, last_run_at: old, updated_at: new Date() }],
    })
    expect(await shouldRunSync()).toBe(true)
  })
})

describe('runSync', () => {
  function setupSync(records: object[], zenodoResponses: object[]) {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })     // INSERT sync_log
      .mockResolvedValueOnce({ rows: [] })                // logAction SYNC_STARTED
      .mockResolvedValueOnce({ rows: records })           // getImportedRecords
    for (const resp of zenodoResponses) {
      mockedAxios.get.mockResolvedValueOnce({ data: resp } as any)
    }
    // remaining pool calls (UPDATE for new_version, UPDATE sync_log, UPDATE config, logAction COMPLETED)
    poolQuery.mockResolvedValue({ rows: [] })
  }

  it('detects new version via links.latest mismatch', async () => {
    setupSync(
      [{ record_id: 100, environment: 'production', version: '1.0', concept_record_id: 999 }],
      [{ links: { latest: 'https://zenodo.org/api/records/101' } }],
    )

    const result = await runSync()
    expect(result.recordsChecked).toBe(1)
    expect(result.newVersions).toBe(1)
    expect(result.errors).toBe(0)

    const updateCall = poolQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('zenodo_new_version_available = TRUE'),
    )
    expect(updateCall).toBeDefined()
    expect(updateCall![1]).toContain(100)
  })

  it('does not mark as new version when links.latest matches current', async () => {
    setupSync(
      [{ record_id: 100, environment: 'production', version: '1.0', concept_record_id: 999 }],
      [{ links: { latest: 'https://zenodo.org/api/records/100' } }],
    )

    const result = await runSync()
    expect(result.newVersions).toBe(0)
  })

  it('detects new version via metadata.version change', async () => {
    setupSync(
      [{ record_id: 100, environment: 'production', version: '1.0', concept_record_id: null }],
      [{ metadata: { version: '2.0' } }],
    )

    const result = await runSync()
    expect(result.newVersions).toBe(1)
  })

  it('counts errors when Zenodo is unreachable and does not mark studies', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })     // INSERT sync_log
      .mockResolvedValueOnce({ rows: [] })                // logAction SYNC_STARTED
      .mockResolvedValueOnce({
        rows: [{ record_id: 100, environment: 'production', version: '1.0', concept_record_id: null }],
      })
    mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'))
    poolQuery.mockResolvedValue({ rows: [] })

    const result = await runSync()
    expect(result.errors).toBe(1)
    expect(result.newVersions).toBe(0)

    const updateNew = poolQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('zenodo_new_version_available = TRUE'),
    )
    expect(updateNew).toBeUndefined()
  })

  it('handles zero imported records gracefully', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] })

    const result = await runSync()
    expect(result.recordsChecked).toBe(0)
    expect(result.newVersions).toBe(0)
  })
})

describe('getSyncLogs', () => {
  it('returns logs ordered by started_at DESC', async () => {
    const logs = [
      { id: 2, started_at: new Date(), status: 'completed', records_checked: 5, new_versions: 1 },
      { id: 1, started_at: new Date(), status: 'completed', records_checked: 3, new_versions: 0 },
    ]
    poolQuery.mockResolvedValueOnce({ rows: logs })
    const result = await getSyncLogs()
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(2)
  })
})
