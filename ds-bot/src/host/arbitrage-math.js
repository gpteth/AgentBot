const COST_KEYS = ['buyFeeBps', 'sellFeeBps', 'buySlippageBps', 'sellSlippageBps', 'gasQuote', 'otherQuote', 'bufferBps']
const invalid = field => new Error(`Invalid ${field}`)
const rounded = value => Number(value.toPrecision(12))

function number(value, field, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0) || value > max) throw invalid(field)
  return value
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw invalid(field)
  return value.trim()
}

function quote(input, side) {
  const venue = text(input?.venue, `${side}.venue`)
  const price = number(input?.price, `${side}.price`, { positive: true })
  const depthBase = number(input?.depthBase, `${side}.depthBase`)
  const observedAt = text(input?.observedAt, `${side}.observedAt`)
  const time = Date.parse(observedAt)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(observedAt) || !Number.isFinite(time)) throw invalid(`${side}.observedAt`)
  if (new Date(time).toISOString().slice(0, 19) !== observedAt.slice(0, 19)) throw invalid(`${side}.observedAt`)
  const source = text(input?.source, `${side}.source`)
  let url
  try { url = new URL(source) } catch { throw invalid(`${side}.source`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid(`${side}.source`)
  return { venue, price, depthBase, observedAt, source, time }
}

// Prices are fee-exclusive averages for the full baseAmount in one quote asset.
// Slippage budgets cover further adverse moves, not price impact already in the quote.
export function evaluateArbitrage(input, now = Date.now()) {
  const chain = text(input?.chain, 'chain')
  const baseAsset = text(input?.baseAsset, 'baseAsset')
  const quoteAsset = text(input?.quoteAsset, 'quoteAsset')
  if (baseAsset.toLowerCase() === quoteAsset.toLowerCase()) throw invalid('asset pair')
  const dataKind = input.dataKind ?? 'synthetic'
  if (!['synthetic', 'observed'].includes(dataKind)) throw invalid('dataKind')
  const baseAmount = number(input?.baseAmount, 'baseAmount', { positive: true })
  const buy = quote(input?.buy, 'buy')
  const sell = quote(input?.sell, 'sell')
  if (buy.venue.toLowerCase() === sell.venue.toLowerCase()) throw invalid('venues: use two different venues')
  const costs = input?.costs
  if (!costs || typeof costs !== 'object' || Array.isArray(costs) || Object.keys(costs).some(key => !COST_KEYS.includes(key))) throw invalid('costs')
  for (const key of COST_KEYS) number(costs[key], `costs.${key}`, { max: key.endsWith('Bps') ? 9999 : Number.MAX_SAFE_INTEGER })
  if (input.policy !== undefined && (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy)
    || Object.keys(input.policy).some(key => !['maxAgeSeconds', 'maxSkewSeconds', 'minProfitQuote'].includes(key)))) throw invalid('policy')
  const policy = {
    maxAgeSeconds: input.policy?.maxAgeSeconds ?? 30,
    maxSkewSeconds: input.policy?.maxSkewSeconds ?? 5,
    minProfitQuote: input.policy?.minProfitQuote ?? 1,
  }
  number(policy.maxAgeSeconds, 'policy.maxAgeSeconds', { positive: true, max: 300 })
  number(policy.maxSkewSeconds, 'policy.maxSkewSeconds', { max: policy.maxAgeSeconds })
  number(policy.minProfitQuote, 'policy.minProfitQuote')
  number(now, 'evaluation time', { positive: true })
  const buyNotionalQuote = number(baseAmount * buy.price, 'buy notional', { positive: true })
  const sellNotionalQuote = number(baseAmount * sell.price, 'sell notional', { positive: true })
  const breakdown = {
    buyFeeQuote: buyNotionalQuote * costs.buyFeeBps / 10000,
    sellFeeQuote: sellNotionalQuote * costs.sellFeeBps / 10000,
    buySlippageQuote: buyNotionalQuote * costs.buySlippageBps / 10000,
    sellSlippageQuote: sellNotionalQuote * costs.sellSlippageBps / 10000,
    gasQuote: costs.gasQuote,
    otherQuote: costs.otherQuote,
    bufferQuote: buyNotionalQuote * costs.bufferBps / 10000,
  }
  const totalQuote = number(Object.values(breakdown).reduce((sum, cost) => sum + cost, 0), 'total costs')
  const grossProfitQuote = sellNotionalQuote - buyNotionalQuote
  const netProfitQuote = grossProfitQuote - totalQuote
  const netBps = netProfitQuote / buyNotionalQuote * 10000
  if (![netProfitQuote, netBps].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)) throw invalid('calculated profit')
  const reasons = []
  if ([buy, sell].some(item => now - item.time > policy.maxAgeSeconds * 1000)) reasons.push('stale-quote')
  if ([buy, sell].some(item => item.time > now)) reasons.push('future-quote')
  if (Math.abs(buy.time - sell.time) > policy.maxSkewSeconds * 1000) reasons.push('quote-time-skew')
  if ([buy, sell].some(item => item.depthBase < baseAmount)) reasons.push('insufficient-depth')
  if (netProfitQuote <= 0 || netProfitQuote < policy.minProfitQuote) reasons.push('below-minimum-profit')
  const evidence = ({ time: _time, ...item }) => item
  return {
    version: 1, mode: 'simulation', dataKind, status: reasons.length ? 'rejected' : 'paper-candidate', reasons,
    chain, baseAsset, quoteAsset, baseAmount, evaluatedAt: new Date(now).toISOString(), policy,
    buy: evidence(buy), sell: evidence(sell), costAssumptions: { ...costs },
    buyNotionalQuote: rounded(buyNotionalQuote), sellNotionalQuote: rounded(sellNotionalQuote),
    grossProfitQuote: rounded(grossProfitQuote),
    costs: Object.fromEntries(Object.entries({ ...breakdown, totalQuote }).map(([key, value]) => [key, rounded(value)])),
    netProfitQuote: rounded(netProfitQuote), netBps: rounded(netBps),
  }
}
