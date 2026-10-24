import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateArbitrage } from '../src/host/arbitrage-math.js'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const snapshot = () => ({
  chain: 'ethereum', baseAsset: 'WETH', quoteAsset: 'USDC', baseAmount: 2,
  buy: { venue: 'Pool A', price: 100, depthBase: 3, observedAt: '2026-10-24T11:59:58Z', source: 'https://example.org/pool-a' },
  sell: { venue: 'Pool B', price: 103, depthBase: 4, observedAt: '2026-10-24T11:59:59Z', source: 'https://example.org/pool-b' },
  costs: { buyFeeBps: 10, sellFeeBps: 20, buySlippageBps: 5, sellSlippageBps: 5, gasQuote: 1, otherQuote: 0.5, bufferBps: 10 },
})

async function evaluate(input) {
  return evaluateArbitrage(input, NOW)
}

test('paper evaluation subtracts both legs, fixed costs, and the safety buffer', async () => {
  const result = await evaluate(snapshot())
  assert.equal(result.mode, 'simulation')
  assert.equal(result.status, 'paper-candidate')
  assert.equal(result.grossProfitQuote, 6)
  assert.deepEqual(result.costs, { buyFeeQuote: 0.2, sellFeeQuote: 0.412, buySlippageQuote: 0.1, sellSlippageQuote: 0.103, gasQuote: 1, otherQuote: 0.5, bufferQuote: 0.2, totalQuote: 2.515 })
  assert.equal(result.netProfitQuote, 3.485)
  assert.equal(result.netBps, 174.25)
  assert.deepEqual(result.reasons, [])
})

test('malformed policies and impossible calendar dates cannot silently change evidence rules', async () => {
  for (const change of [
    input => { input.policy = [] },
    input => { input.policy = { maxQuoteAge: 100 } },
    input => { input.buy.observedAt = '2026-02-30T11:59:58Z' },
    input => { input.dataKind = 'live' },
  ]) {
    const input = snapshot()
    change(input)
    await assert.rejects(evaluate(input), /Invalid/)
  }
})

test('a spread is rejected when costs or the minimum profit consume it', async () => {
  const costly = snapshot()
  costly.costs.gasQuote = 5
  assert.deepEqual((await evaluate(costly)).reasons, ['below-minimum-profit'])
  const thin = snapshot()
  thin.policy = { minProfitQuote: 4 }
  assert.equal((await evaluate(thin)).status, 'rejected')
  const flat = snapshot()
  flat.sell.price = 100
  flat.policy = { minProfitQuote: 0 }
  assert.equal((await evaluate(flat)).status, 'rejected')
})

test('stale, future, unsynchronized, and shallow quotes cannot become paper candidates', async () => {
  for (const [change, reason] of [
    [input => { input.buy.observedAt = '2026-10-24T11:59:20Z' }, 'stale-quote'],
    [input => { input.sell.observedAt = '2026-10-24T12:00:01Z' }, 'future-quote'],
    [input => { input.buy.observedAt = '2026-10-24T11:59:50Z' }, 'quote-time-skew'],
    [input => { input.buy.depthBase = 1.99 }, 'insufficient-depth'],
    [input => { input.sell.depthBase = 1.99 }, 'insufficient-depth'],
  ]) {
    const input = snapshot()
    change(input)
    const result = await evaluate(input)
    assert.equal(result.status, 'rejected')
    assert.ok(result.reasons.includes(reason), reason)
  }
})

test('quotes at the age and depth boundaries remain usable', async () => {
  const input = snapshot()
  input.buy.observedAt = input.sell.observedAt = '2026-10-24T11:59:30Z'
  input.buy.depthBase = input.sell.depthBase = 2
  assert.equal((await evaluate(input)).status, 'paper-candidate')
})

test('missing cost evidence and invalid numeric inputs are refused', async () => {
  for (const change of [
    input => { delete input.costs.gasQuote }, input => { delete input.costs.otherQuote },
    input => { input.costs.buyFeeBps = -1 }, input => { input.costs.sellSlippageBps = 10000 },
    input => { input.costs.bridgeQuote = 1 }, input => { input.baseAmount = '2' },
    input => { input.baseAmount = 0 }, input => { input.buy.price = Infinity },
    input => { input.sell.depthBase = NaN }, input => { input.buy.price = Number.MAX_VALUE },
    input => { input.policy = { maxAgeSeconds: 301 } }, input => { input.policy = { minProfitQuote: -1 } },
  ]) {
    const input = snapshot()
    change(input)
    await assert.rejects(evaluate(input), /Invalid/)
  }
})

test('quotes require distinct venues, an asset pair, timestamps, and public sources', async () => {
  for (const change of [
    input => { input.sell.venue = 'pool a' }, input => { input.baseAsset = 'USDC' },
    input => { input.chain = '' }, input => { input.buy.observedAt = 'yesterday' },
    input => { input.sell.source = '' }, input => { input.buy.source = 'file:///private/data' },
    input => { input.buy.source = 'https://name:password@example.org' },
  ]) {
    const input = snapshot()
    change(input)
    await assert.rejects(evaluate(input), /Invalid/)
  }
})
