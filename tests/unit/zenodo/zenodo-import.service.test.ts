import axios from 'axios'
import { pool } from '../../../src/db/pool'
import * as zenodoService from '../../../src/modules/zenodo/zenodo.service'
import { importFromZenodo } from '../../../src/modules/zenodo/zenodo-import.service'

jest.mock('axios')
jest.mock('../../../src/db/pool', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }))
jest.mock('../../../src/modules/zenodo/zenodo.service', () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ['sandbox', 'production'],
}))
jest.mock('../../../src/shared/audit', () => ({
  AUDIT_ACTIONS: {
    ZENODO_IMPORT_STARTED: 'ZENODO_IMPORT_STARTED',
    ZENODO_IMPORT_COMPLETED: 'ZENODO_IMPORT_COMPLETED',
  },
}))
jest.mock('../../../src/modules/zenodo/zenodo-rate-limit.service', () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}))

const mockedAxios = axios as jest.Mocked<typeof axios>
const poolQuery = pool.query as jest.Mock
const mockedGetStoredToken = zenodoService.getStoredToken as jest.Mock

const RECORD_ID = 1234567
const FAKE_STREAM = { pipe: jest.fn() }

const ORTHANC_OK = { ID: 'inst-abc', ParentStudy: 'study-xyz', Status: 'Success' }
const ORTHANC_ALREADY_STORED = { ID: 'inst-abc', ParentStudy: 'study-xyz', Status: 'AlreadyStored' }

const TAGS = {
  '0008,0018': { Value: 'sop-uid-123' },
  '0020,000d': { Value: 'study-uid-456' },
  '0010,0010': { Value: 'Doe^John' },
  '0010,0020': { Value: 'PAT001' },
  '0008,0020': { Value: '20240601' },
  '0008,1030': { Value: 'Chest CT' },
  '0008,0060': { Value: 'CT' },
  '0020,0013': { Value: [1] },
  '0028,0010': { Value: [512] },
  '0028,0011': { Value: [512] },
}

const IMPORT_OPTS = {
  recordId: RECORD_ID,
  environment: 'sandbox' as const,
  files: [{ fileKey: 'scan_001.dcm', fileSize: 2097152 }],
  overwriteDuplicates: false,
  userId: 1,
  ip: '127.0.0.1',
}

function setupHappyPath() {
  mockedGetStoredToken.mockResolvedValue(null)

  poolQuery
    .mockResolvedValueOnce({ rows: [{ id: 42 }] })          // INSERT zenodo_imports
    .mockResolvedValueOnce({ rows: [] })                    // audit log STARTED
    .mockResolvedValueOnce({ rows: [] })                    // INSERT import_file
    .mockResolvedValueOnce({ rows: [] })                    // UPDATE status=downloading
    .mockResolvedValueOnce({ rows: [] })                    // INSERT into studies
    .mockResolvedValueOnce({ rows: [] })                    // UPDATE import_file=imported
    .mockResolvedValueOnce({ rows: [] })                    // UPDATE zenodo_imports completed
    .mockResolvedValueOnce({ rows: [] })                    // audit log COMPLETED

  mockedAxios.get
    .mockResolvedValueOnce({ data: { doi: '10.5281/zenodo.1234567' } } as any)  // fetchRecordDoi
    .mockResolvedValueOnce({ data: FAKE_STREAM } as any)                         // stream download
    .mockResolvedValueOnce({ data: TAGS } as any)                                // fetchTags

  mockedAxios.post.mockResolvedValueOnce({ data: ORTHANC_OK } as any)           // Orthanc upload
}

beforeEach(() => jest.clearAllMocks())

describe('importFromZenodo', () => {
  it('imports a .dcm file successfully and returns imported=1', async () => {
    setupHappyPath()
    const result = await importFromZenodo(IMPORT_OPTS)

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.results[0].status).toBe('imported')
    expect(result.results[0].orthancStudyId).toBe('study-xyz')
    expect(result.results[0].sopInstanceUid).toBe('sop-uid-123')
  })

  it('sets largeSizeWarning=true when total file size > 10 GB', async () => {
    setupHappyPath()
    const result = await importFromZenodo({
      ...IMPORT_OPTS,
      files: [{ fileKey: 'huge.dcm', fileSize: 11 * 1024 * 1024 * 1024 }],
    })

    expect(result.largeSizeWarning).toBe(true)
  })

  it('returns status=duplicate when file already stored and overwrite=false', async () => {
    mockedGetStoredToken.mockResolvedValue(null)

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })          // INSERT zenodo_imports
      .mockResolvedValueOnce({ rows: [] })                    // audit STARTED
      .mockResolvedValueOnce({ rows: [] })                    // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE downloading
      .mockResolvedValueOnce({ rows: [{ orthanc_study_id: 'study-existing' }] }) // check existing
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE import_file=duplicate
      .mockResolvedValueOnce({ rows: [] })                    // UPDATE zenodo_imports
      .mockResolvedValueOnce({ rows: [] })                    // audit COMPLETED

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)  // fetchRecordDoi
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)    // stream download
      .mockResolvedValueOnce({ data: TAGS } as any)           // fetchTags

    mockedAxios.post.mockResolvedValueOnce({ data: ORTHANC_ALREADY_STORED } as any)

    const result = await importFromZenodo({ ...IMPORT_OPTS, overwriteDuplicates: false })

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.results[0].status).toBe('duplicate')
    expect(result.results[0].existingStudyId).toBe('study-existing')
  })

  it('skips .zip files and marks them as skipped', async () => {
    mockedGetStoredToken.mockResolvedValue(null)

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] })  // audit STARTED
      .mockResolvedValueOnce({ rows: [] })  // INSERT import_file (zip)
      .mockResolvedValueOnce({ rows: [] })  // UPDATE zenodo_imports
      .mockResolvedValueOnce({ rows: [] })  // audit COMPLETED

    mockedAxios.get.mockResolvedValueOnce({ data: { doi: null } } as any) // fetchRecordDoi

    const result = await importFromZenodo({
      ...IMPORT_OPTS,
      files: [{ fileKey: 'dataset.zip', fileSize: 5000 }],
    })

    expect(result.results[0].status).toBe('skipped')
    expect(result.results[0].error).toContain('ZIP')
    expect(result.imported).toBe(0)
  })

  it('returns status=failed when Orthanc rejects the file as non-DICOM (400)', async () => {
    mockedGetStoredToken.mockResolvedValue(null)

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] })  // audit STARTED
      .mockResolvedValueOnce({ rows: [] })  // INSERT import_file
      .mockResolvedValueOnce({ rows: [] })  // UPDATE downloading
      .mockResolvedValueOnce({ rows: [] })  // UPDATE import_file=failed
      .mockResolvedValueOnce({ rows: [] })  // UPDATE zenodo_imports
      .mockResolvedValueOnce({ rows: [] })  // audit COMPLETED

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      // 3 retry attempts, each needs a fresh stream mock
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)
      .mockResolvedValueOnce({ data: FAKE_STREAM } as any)

    mockedAxios.post.mockRejectedValue({ response: { status: 400 } })

    const result = await importFromZenodo(IMPORT_OPTS)

    expect(result.failed).toBe(1)
    expect(result.results[0].status).toBe('failed')
    expect(result.results[0].error).toContain('DICOM válido')
  })

  it('retries on network failure and fails after 3 attempts', async () => {
    mockedGetStoredToken.mockResolvedValue(null)

    poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    mockedAxios.get
      .mockResolvedValueOnce({ data: { doi: null } } as any)
      .mockRejectedValue(new Error('network timeout'))  // all stream attempts fail

    const result = await importFromZenodo(IMPORT_OPTS)

    expect(result.failed).toBe(1)
    expect(result.results[0].status).toBe('failed')
    // 3 retries = 3 stream GET calls (after the initial fetchRecordDoi)
    const streamCalls = mockedAxios.get.mock.calls.filter((c) => String(c[0]).includes('/content'))
    expect(streamCalls.length).toBe(3)
  }, 15000)

  it('stores source DOI in importResult', async () => {
    setupHappyPath()
    const result = await importFromZenodo(IMPORT_OPTS)
    expect(result.sourceDoi).toBe('10.5281/zenodo.1234567')
  })
})
