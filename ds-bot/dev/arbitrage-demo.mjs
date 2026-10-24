import { evaluateArbitrage } from '../src/host/arbitrage-math.js'

const observedAt = new Date(Date.now() - 1000).toISOString()
const result = evaluateArbitrage({
  dataKind: 'synthetic', chain: 'demo-chain', baseAsset: 'DEMO-BASE', quoteAsset: 'DEMO-QUOTE', baseAmount: 2,
  buy: { venue: 'Example A', price: 100, depthBase: 3, observedAt, source: 'https://example.org/a' },
  sell: { venue: 'Example B', price: 103, depthBase: 3, observedAt, source: 'https://example.org/b' },
  costs: { buyFeeBps: 10, sellFeeBps: 20, buySlippageBps: 5, sellSlippageBps: 5, gasQuote: 1, otherQuote: 0.5, bufferBps: 10 },
})
console.log(JSON.stringify(result, null, 2))
