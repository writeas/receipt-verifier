import reduct from 'reduct'
import fetch from 'node-fetch'
import * as Long from 'long'
import * as raw from 'raw-body'
import { Receipts, ReceiptResponse } from './Receipts'
import { Config } from './Config'
import { Redis } from './Redis'
import { createReceipt, RECEIPT_VERSION } from 'ilp-protocol-stream'
import { generateReceiptSecret, hmac, randomBytes } from '../util/crypto'

const RECEIPT_LENGTH_BASE64 = 80

describe('Receipts', () => {
  let receipts: Receipts
  let config: Config
  let redis: Redis

  const nonce = Buffer.alloc(16)

  process.env.SPSP_ENDPOINT = 'http://localhost:3000'

  beforeAll(async () => {
    const deps = reduct()
    receipts = deps(Receipts)
    config = deps(Config)
    redis = deps(Redis)
    redis.start()
    receipts.start()
    await redis.flushdb()
  })

  beforeEach(async () => {
    await redis.setReceiptTTL(nonce.toString('base64'))
  })

  afterEach(async () => {
    await redis.flushdb()
  })

  afterAll(() => {
    receipts.stop()
    redis.stop()
  })

  function makeReceipt(amount: Long, seed: Buffer, streamId = 1, receiptNonce = nonce): string {
    return createReceipt({
      nonce: receiptNonce,
      streamId,
      totalReceived: amount.toUnsigned(),
      secret: generateReceiptSecret(seed, receiptNonce)
    }).toString('base64')
  }

  function makeReceiptResponse (amount: Long, streamId = 1, receiptNonce = nonce): ReceiptResponse {
    return {
      nonce: nonce.toString('base64'),
      streamId: streamId.toString(),
      totalReceived: amount.toString()
    }
  }

  describe('POST /receipts', () => {
    it('returns decoded valid receipt', async () => {
      const amount = Long.fromNumber(10)
      const receipt = makeReceipt(amount, config.receiptSeed)
      const resp = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt
      })
      expect(resp.status).toBe(200)
      const decodedReceipt = await resp.json()
      expect(decodedReceipt).toStrictEqual(makeReceiptResponse(amount))
    })

    it('returns total received for subsequent receipt', async () => {
      const amount1 = Long.fromNumber(10)
      const receipt1 = makeReceipt(amount1, config.receiptSeed)
      const amount2 = Long.fromNumber(15)
      const receipt2 = makeReceipt(amount2, config.receiptSeed)

      const resp1 = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt1
      })
      expect(resp1.status).toBe(200)

      const resp2 = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt2
      })
      expect(resp2.status).toBe(200)
      const decodedReceipt = await resp2.json()
      expect(decodedReceipt).toStrictEqual(makeReceiptResponse(amount2))
    })

    it('returns 400 for invalid receipt', async () => {
      const amount = Long.fromNumber(10)
      const badSeed = Buffer.alloc(32)
      const receipt = makeReceipt(amount, badSeed)
      const resp = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt
      })
      expect(resp.status).toBe(400)
      const error = await resp.text()
      expect(error).toBe('invalid hmac')
    })

    it('returns 400 for expired receipt', async () => {
      const amount = Long.fromNumber(10)
      const expiredNonce = randomBytes(16)
      const receipt = makeReceipt(amount, config.receiptSeed, 1, expiredNonce)
      const resp = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt
      })
      expect(resp.status).toBe(400)
      const error = await resp.text()
      expect(error).toBe('expired receipt')
    })

    it('returns 400 for receipt with lower amount', async () => {
      const amount1 = Long.fromNumber(15)
      const receipt1 = makeReceipt(amount1, config.receiptSeed)
      const amount2 = Long.fromNumber(10)
      const receipt2 = makeReceipt(amount2, config.receiptSeed)

      const resp1 = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt1
      })
      expect(resp1.status).toBe(200)

      const resp2 = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt2
      })
      expect(resp2.status).toBe(400)
      const error = await resp2.text()
      expect(error).toBe('expired receipt')
    })

    it('returns 409 for receipt amount greater than max 64 bit signed integer', async () => {
      const amount = Long.MAX_VALUE.toUnsigned().add(1)
      const receipt = makeReceipt(amount, config.receiptSeed)
      const resp = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt
      })
      expect(resp.status).toBe(409)
      const error = await resp.text()
      expect(error).toBe('receipt amount exceeds max 64 bit signed integer')
    })

    it('returns 413 for body with length greater than RECEIPT_LENGTH_BASE64', async () => {
      const receipt = Buffer.alloc(RECEIPT_LENGTH_BASE64+1).toString()
      const resp = await fetch(`http://localhost:${config.port}/receipts`, {
        method: 'POST',
        body: receipt
      })
      expect(resp.status).toBe(413)
      const error = await resp.text()
      expect(error).toBe('request entity too large')
    })
  })
})
