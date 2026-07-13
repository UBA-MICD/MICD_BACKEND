import axios from 'axios'
import { pool } from '../../db'
import * as zenodoService from '../zenodo.service'
import { publishStudy, retryFailedFiles, ZenodoPublishError } from '../zenodo-publish.service'

jest.mock('axios')
jest.mock('../../db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }))
jest.mock('../zenodo.service', () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ['sandbox', 'production'],
}))
jest.mock('../audit.service', () => ({
  AUDIT_ACTIONS: {
    ZENODO_STUDY_PUBLISHED: 'ZENODO_STUDY_PUBLISHED',
    ZENODO_PUBLISH_FAILED: 'ZENODO_PUBLISH_FAILED',
  },
  logActionWithClient: jest.fn(),
}))
jest.mock('../zenodo-rate-limit.service', () => ({
  throttle: jest.fn().mockResolvedValue(undefined),
  THROTTLE_AT: 50,
  FIFTY_GB: 50 * 1024 * 1024 * 1024,
}))

const mockedAxios = axios as jest.Mocked<typeof axios>
const poolQuery = pool.query as jest.Mock
const poolConnect = pool.connect as jest.Mock
const mockedGetStoredToken = zenodoService.getStoredToken as jest.Mock

const STUDY_ID = 'orthanc-study-abc'
const TOKEN = 'test-token-xyz'
const ZENODO_DEP_ID = 9999
const BUCKET_URL = 'https://sandbox.zenodo.org/api/files/bucket-id'
const DOI = '10.5281/zenodo.9999'

const INSTANCE_ROWS = [
  { orthanc_instance_id: 'inst-1', anonymized_at: new Date() },
  { orthanc_instance_id: 'inst-2', anonymized_at: new Date() },
]

const DICOM_BUFFER = Buffer.from('DICM fake dicom data')

function makeClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  }
}

function setupHappyPath() {
  mockedGetStoredToken.mockResolvedValue(TOKEN)

  // studies query
  poolQuery
    .mockResolvedValueOnce({ rows: INSTANCE_ROWS } as any)
    // orthanc file fetch via axios (inst-1, inst-2 size check)
    // createDeposition
    // setMetadata
    // INSERT deposition → returns id
    .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
    // INSERT file rows (2 files)
    .mockResolvedValueOnce({ rows: [] } as any)
    .mockResolvedValueOnce({ rows: [] } as any)
    // SELECT file rows
    .mockResolvedValueOnce({
      rows: [
        { id: 10, orthanc_instance_id: 'inst-1', filename: 'inst-1.dcm', deposition_id: 1 },
        { id: 11, orthanc_instance_id: 'inst-2', filename: 'inst-2.dcm', deposition_id: 1 },
      ],
    } as any)
    // UPDATE uploading inst-1
    .mockResolvedValueOnce({ rows: [] } as any)
    // UPDATE completed inst-1
    .mockResolvedValueOnce({ rows: [] } as any)
    // UPDATE uploading inst-2
    .mockResolvedValueOnce({ rows: [] } as any)
    // UPDATE completed inst-2
    .mockResolvedValueOnce({ rows: [] } as any)

  // axios calls: orthanc file fetches (size check x2), then upload x2, then publish
  mockedAxios.get
    .mockResolvedValueOnce({ data: DICOM_BUFFER } as any) // inst-1 size check
    .mockResolvedValueOnce({ data: DICOM_BUFFER } as any) // inst-2 size check
    .mockResolvedValueOnce({ data: DICOM_BUFFER } as any) // inst-1 upload fetch
    .mockResolvedValueOnce({ data: DICOM_BUFFER } as any) // inst-2 upload fetch

  mockedAxios.post
    .mockResolvedValueOnce({
      data: { id: ZENODO_DEP_ID, links: { bucket: BUCKET_URL } },
    } as any) // createDeposition
    .mockResolvedValueOnce({ data: { doi: DOI } } as any) // publish

  mockedAxios.put
    .mockResolvedValueOnce({ data: {} } as any) // setMetadata
    .mockResolvedValueOnce({ data: {} } as any) // upload inst-1
    .mockResolvedValueOnce({ data: {} } as any) // upload inst-2

  const client = makeClient()
  poolConnect.mockResolvedValue(client as any)

  return client
}

const PUBLISH_OPTS = {
  orthancStudyId: STUDY_ID,
  environment: 'sandbox' as const,
  metadata: {
    title: 'Test Dataset',
    description: 'A test DICOM dataset',
    authors: [{ name: 'Doe, John', affiliation: 'UBA' }],
    keywords: ['DICOM'],
    license: 'cc-by-4.0',
  },
  userId: 1,
  ip: '127.0.0.1',
}

beforeEach(() => jest.clearAllMocks())

describe('publishStudy', () => {
  it('returns DOI and filesUploaded on success', async () => {
    setupHappyPath()
    const result = await publishStudy(PUBLISH_OPTS)
    expect(result.doi).toBe(DOI)
    expect(result.filesUploaded).toBe(2)
    expect(result.totalBytes).toBeGreaterThanOrEqual(0)
  })

  it('throws not_anonymized when any instance has null anonymized_at', async () => {
    mockedGetStoredToken.mockResolvedValue(TOKEN)
    poolQuery.mockResolvedValueOnce({
      rows: [
        { orthanc_instance_id: 'inst-1', anonymized_at: null },
      ],
    } as any)

    await expect(publishStudy(PUBLISH_OPTS)).rejects.toMatchObject({
      code: 'not_anonymized',
    })
  })

  it('throws study_not_found when study does not exist in DB', async () => {
    mockedGetStoredToken.mockResolvedValue(TOKEN)
    poolQuery.mockResolvedValueOnce({ rows: [] } as any)

    await expect(publishStudy(PUBLISH_OPTS)).rejects.toMatchObject({
      code: 'study_not_found',
    })
  })

  it('throws no_credentials when token is not configured', async () => {
    mockedGetStoredToken.mockResolvedValue(null)
    poolQuery.mockResolvedValueOnce({ rows: INSTANCE_ROWS } as any)
    mockedAxios.get
      .mockResolvedValueOnce({ data: DICOM_BUFFER } as any)
      .mockResolvedValueOnce({ data: DICOM_BUFFER } as any)

    await expect(publishStudy(PUBLISH_OPTS)).rejects.toMatchObject({
      code: 'no_credentials',
    })
  })

  it('throws upload_failed and marks deposition failed when upload errors', async () => {
    mockedGetStoredToken.mockResolvedValue(TOKEN)

    poolQuery
      .mockResolvedValueOnce({ rows: INSTANCE_ROWS } as any)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({
        rows: [{ id: 10, orthanc_instance_id: 'inst-1', filename: 'inst-1.dcm', deposition_id: 1 }],
      } as any)
      .mockResolvedValue({ rows: [] } as any)

    mockedAxios.get
      .mockResolvedValueOnce({ data: DICOM_BUFFER } as any)
      .mockResolvedValueOnce({ data: DICOM_BUFFER } as any)
      .mockResolvedValueOnce({ data: DICOM_BUFFER } as any)

    mockedAxios.post.mockResolvedValueOnce({
      data: { id: ZENODO_DEP_ID, links: { bucket: BUCKET_URL } },
    } as any)
    mockedAxios.put
      .mockResolvedValueOnce({ data: {} } as any) // setMetadata
      .mockRejectedValue(new Error('network timeout')) // upload fails all 3 retries

    await expect(publishStudy(PUBLISH_OPTS)).rejects.toMatchObject({
      code: 'upload_failed',
    })
  })

  it('is a ZenodoPublishError instance for known error codes', async () => {
    mockedGetStoredToken.mockResolvedValue(TOKEN)
    poolQuery.mockResolvedValueOnce({ rows: [] } as any)

    const err = await publishStudy(PUBLISH_OPTS).catch((e) => e)
    expect(err).toBeInstanceOf(ZenodoPublishError)
  })
})

describe('retryFailedFiles', () => {
  it('throws deposition_not_found when deposition does not exist', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] } as any)

    await expect(retryFailedFiles(999, 1, '127.0.0.1')).rejects.toMatchObject({
      code: 'deposition_not_found',
    })
  })

  it('throws already_published when deposition is already published', async () => {
    poolQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: 'published', environment: 'sandbox' }],
    } as any)

    await expect(retryFailedFiles(1, 1, '127.0.0.1')).rejects.toMatchObject({
      code: 'already_published',
    })
  })

  it('retries failed files and returns counts', async () => {
    mockedGetStoredToken.mockResolvedValue(TOKEN)

    poolQuery
      // getDeposition
      .mockResolvedValueOnce({
        rows: [{
          id: 1, status: 'failed', environment: 'sandbox',
          zenodo_id: ZENODO_DEP_ID, bucket_url: BUCKET_URL,
          orthanc_study_id: STUDY_ID,
        }],
      } as any)
      // failed files
      .mockResolvedValueOnce({
        rows: [{ id: 10, orthanc_instance_id: 'inst-1', filename: 'inst-1.dcm', deposition_id: 1 }],
      } as any)
      // UPDATE uploading
      .mockResolvedValueOnce({ rows: [] } as any)
      // UPDATE completed
      .mockResolvedValueOnce({ rows: [] } as any)
      // remaining count check
      .mockResolvedValueOnce({ rows: [{ count: '0' }] } as any)
      // publish → client queries
      .mockResolvedValue({ rows: [] } as any)

    mockedAxios.get.mockResolvedValueOnce({ data: DICOM_BUFFER } as any)
    mockedAxios.put.mockResolvedValueOnce({ data: {} } as any)
    mockedAxios.post.mockResolvedValueOnce({ data: { doi: DOI } } as any)

    const client = makeClient()
    poolConnect.mockResolvedValue(client as any)

    const result = await retryFailedFiles(1, 1, '127.0.0.1')
    expect(result.retried).toBe(1)
    expect(result.failed).toBe(0)
  })
})
