import axios from 'axios'
import { validateToken } from '../zenodo.service'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

describe('zenodo.service.validateToken', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('returns { valid: true } for a valid token (200)', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: {} })

    const result = await validateToken('good-token', 'sandbox')

    expect(result).toEqual({ valid: true })
  })

  it("returns { valid: false, reason: 'invalid_token' } on 401", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 401 } })

    const result = await validateToken('bad-token', 'sandbox')

    expect(result).toEqual({ valid: false, reason: 'invalid_token' })
  })

  it("returns { valid: false, reason: 'insufficient_permissions' } on 403", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 403 } })

    const result = await validateToken('restricted-token', 'production')

    expect(result).toEqual({ valid: false, reason: 'insufficient_permissions' })
  })

  it("does not crash on timeout and returns { valid: false, reason: 'timeout' }", async () => {
    mockedAxios.get.mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' })

    const result = await validateToken('any-token', 'sandbox')

    expect(result).toEqual({ valid: false, reason: 'timeout' })
  })
})
