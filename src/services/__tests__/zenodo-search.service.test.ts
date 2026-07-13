import axios from 'axios'
import * as zenodoService from '../zenodo.service'
import { searchZenodo, getZenodoRecord } from '../zenodo-search.service'

jest.mock('axios')
jest.mock('../zenodo.service', () => ({
  getStoredToken: jest.fn(),
  ZENODO_ENVIRONMENTS: ['sandbox', 'production'],
}))

const mockedAxios = axios as jest.Mocked<typeof axios>
const mockedGetStoredToken = zenodoService.getStoredToken as jest.Mock

const RECORD_RAW = {
  id: 1234567,
  doi: '10.5281/zenodo.1234567',
  metadata: {
    title: 'CT Lung Dataset',
    description: 'A collection of lung CT scans.',
    creators: [{ name: 'Doe, John', affiliation: 'UBA' }],
    license: { id: 'cc-by-4.0' },
    keywords: ['CT', 'lung', 'DICOM'],
    publication_date: '2024-06-01',
  },
  files: [
    { key: 'scan_001.dcm', size: 2097152, checksum: 'abc123' },
    { key: 'scan_002.dcm', size: 3145728, checksum: 'def456' },
  ],
  links: { html: 'https://zenodo.org/record/1234567' },
}

const NON_IMPORTABLE_RECORD = {
  ...RECORD_RAW,
  id: 9999999,
  files: [{ key: 'readme.pdf', size: 12345 }],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedGetStoredToken.mockResolvedValue(null)
})

describe('searchZenodo', () => {
  it('returns parsed records and total on success', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [RECORD_RAW], total: 1 } },
    } as any)

    const result = await searchZenodo({ q: 'CT lung DICOM' })

    expect(result.total).toBe(1)
    expect(result.records).toHaveLength(1)

    const record = result.records[0]
    expect(record.id).toBe(1234567)
    expect(record.doi).toBe('10.5281/zenodo.1234567')
    expect(record.title).toBe('CT Lung Dataset')
    expect(record.authors).toEqual([{ name: 'Doe, John', affiliation: 'UBA' }])
    expect(record.license).toBe('cc-by-4.0')
    expect(record.numFiles).toBe(2)
    expect(record.totalSize).toBe(2097152 + 3145728)
    expect(record.importable).toBe(true)
  })

  it('returns empty records array when no results', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    const result = await searchZenodo({ q: 'xyznonexistent' })
    expect(result.records).toHaveLength(0)
    expect(result.total).toBe(0)
  })

  it('appends file_type to query when fileType filter is provided', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    await searchZenodo({ q: 'DICOM', fileType: 'dcm' })

    const callParams = mockedAxios.get.mock.calls[0][1]?.params
    expect(callParams?.q).toContain('file_type:dcm')
  })

  it('includes Authorization header when token is available', async () => {
    mockedGetStoredToken.mockResolvedValue('my-token')
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    await searchZenodo({ q: 'DICOM' })

    const callHeaders = mockedAxios.get.mock.calls[0][1]?.headers
    expect(callHeaders?.['Authorization']).toBe('Bearer my-token')
  })

  it('does not include Authorization header when no token', async () => {
    mockedGetStoredToken.mockResolvedValue(null)
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    await searchZenodo({ q: 'DICOM' })

    const callHeaders = mockedAxios.get.mock.calls[0][1]?.headers
    expect(callHeaders?.['Authorization']).toBeUndefined()
  })

  it('caps size at 100', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    await searchZenodo({ q: 'DICOM', size: 9999 })

    const callParams = mockedAxios.get.mock.calls[0][1]?.params
    expect(callParams?.size).toBe(100)
  })

  it('marks records without .dcm or .zip as not importable', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [NON_IMPORTABLE_RECORD], total: 1 } },
    } as any)

    const result = await searchZenodo({ q: 'dataset' })
    expect(result.records[0].importable).toBe(false)
  })

  it('uses sandbox base URL when environment is sandbox', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { hits: { hits: [], total: 0 } },
    } as any)

    await searchZenodo({ q: 'test' }, 'sandbox')

    const callUrl = mockedAxios.get.mock.calls[0][0]
    expect(callUrl).toContain('sandbox.zenodo.org')
  })
})

describe('getZenodoRecord', () => {
  it('returns full record detail including files and keywords', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: RECORD_RAW } as any)

    const detail = await getZenodoRecord(1234567)

    expect(detail.id).toBe(1234567)
    expect(detail.description).toBe('A collection of lung CT scans.')
    expect(detail.keywords).toEqual(['CT', 'lung', 'DICOM'])
    expect(detail.files).toHaveLength(2)
    expect(detail.files[0].key).toBe('scan_001.dcm')
    expect(detail.files[0].size).toBe(2097152)
    expect(detail.importable).toBe(true)
  })

  it('marks record as not importable when no DICOM or zip files', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: NON_IMPORTABLE_RECORD } as any)

    const detail = await getZenodoRecord(9999999)
    expect(detail.importable).toBe(false)
  })

  it('propagates axios errors for caller to handle (e.g. 404)', async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } })

    await expect(getZenodoRecord(0)).rejects.toMatchObject({ response: { status: 404 } })
  })
})
