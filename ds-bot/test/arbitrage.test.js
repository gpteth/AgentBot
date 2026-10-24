import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-arbitrage-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  let sessions = 0
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async path => {
        const workspace = { id: 'workspace', path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
    },
    sessionController: {
      create: async () => ({ sessionId: `session-${++sessions}` }),
      resolveAgent: async id => ({ agent: { session: { id }, followup() {} } }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.bootstrap()
  const main = rt.state.mainBotIds[0]
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const tool = async (name, args = {}, id = main) => {
    const registered = ctx.registeredTools.get(name)
    assert.ok(registered, `${name} is available`)
    return JSON.parse(await registered.execute(args, { agent: { id } }))
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  return { rt, tool, main, saved, home, ctx }
}

const snapshot = () => ({
  chain: 'ethereum', baseAsset: 'WETH', quoteAsset: 'USDC', baseAmount: 2, dataKind: 'synthetic',
  buy: { venue: 'Pool A', price: 100, depthBase: 3, observedAt: new Date(Date.now() - 1000).toISOString(), source: 'https://example.org/a' },
  sell: { venue: 'Pool B', price: 103, depthBase: 3, observedAt: new Date(Date.now() - 1000).toISOString(), source: 'https://example.org/b' },
  costs: { buyFeeBps: 10, sellFeeBps: 20, buySlippageBps: 5, sellSlippageBps: 5, gasQuote: 1, otherQuote: 0.5, bufferBps: 10 },
})

test('team setup creates ordinary specialists and one admin-led group, once', async t => {
  const { rt, tool, main, saved } = await start(t)
  const results = await Promise.all([tool('setup_arbitrage_team'), tool('setup_arbitrage_team')])
  assert.equal(results[0].ok, true)
  assert.equal(results[0].room.id, results[1].room.id)
  assert.equal(Object.keys(saved().bots).length, 4)
  assert.deepEqual(saved().mainBotIds, [main])
  const room = rt.roomOf(results[0].room.id)
  assert.equal(room.mode, 'admin')
  assert.equal(room.admin, main)
  assert.equal(room.members.length, 4)
  const scout = rt.botOf(results[0].bots.scout.id)
  await rt.updateBot(scout.id, { name: 'My Scout', instructions: 'Custom research instructions' })
  const again = await tool('setup_arbitrage_team')
  assert.equal(again.bots.scout.name, 'My Scout')
  assert.equal(rt.botOf(scout.id).instructions, 'Custom research instructions')
})

test('only a Main Bot can set up the team, and readonly hosts cannot write records', async t => {
  const { rt, tool, saved } = await start(t)
  const member = await rt.createBot({ name: 'Researcher' })
  assert.equal((await tool('setup_arbitrage_team', {}, member.id)).ok, false)
  assert.equal(Object.keys(saved().bots).length, 2)
  rt.readOnly = () => 'The team is open elsewhere'
  assert.match((await tool('setup_arbitrage_team')).error, /open elsewhere/)
  assert.match((await tool('evaluate_arbitrage', snapshot())).error, /open elsewhere/)
  assert.equal(saved().arbitrage?.records?.length ?? 0, 0)
})

test('existing names are refused before any specialist is created', async t => {
  const { rt, tool, saved } = await start(t)
  const original = await rt.createBot({ name: 'Arb Analyst', instructions: 'Keep this job' })
  const result = await tool('setup_arbitrage_team')
  assert.equal(result.ok, false)
  assert.match(result.error, /Arb Analyst/)
  assert.equal(Object.keys(saved().bots).length, 2)
  assert.equal(rt.botOf(original.id).instructions, 'Keep this job')
})

test('a partially completed setup resumes without duplicating the saved specialist', async t => {
  const { rt, tool, saved } = await start(t)
  const create = rt.createBot
  rt.createBot = options => options.name === 'Arb Analyst' ? Promise.reject(new Error('temporary failure')) : create(options)
  assert.equal((await tool('setup_arbitrage_team')).ok, false)
  const scoutId = saved().arbitrage.team.bots.scout
  assert.ok(scoutId)
  rt.createBot = create
  const result = await tool('setup_arbitrage_team')
  assert.equal(result.ok, true)
  assert.equal(result.bots.scout.id, scoutId)
  assert.equal(Object.keys(saved().bots).length, 4)
})

test('evaluations retain cost assumptions, evidence, and rejected scenarios in the journal', async t => {
  const { tool, main, saved } = await start(t)
  const first = await tool('evaluate_arbitrage', snapshot())
  assert.equal(first.ok, true)
  assert.equal(first.record.result.netProfitQuote, 3.485)
  assert.equal(first.record.botId, main)
  assert.equal(first.record.result.costAssumptions.buyFeeBps, 10)
  const bad = snapshot()
  bad.buy.depthBase = 0
  const second = await tool('evaluate_arbitrage', bad)
  assert.equal(second.record.result.status, 'rejected')
  assert.notEqual(first.record.id, second.record.id)
  const history = await tool('list_arbitrage_records', { limit: 1 })
  assert.equal(history.records.length, 1)
  assert.equal(history.records[0].id, second.record.id)
  assert.equal(history.total, 2)
  assert.equal(history.nextBefore, second.record.id)
  const earlier = await tool('list_arbitrage_records', { limit: 1, before: history.nextBefore })
  assert.equal(earlier.records[0].id, first.record.id)
  assert.equal(earlier.nextBefore, null)
  assert.equal((await tool('list_arbitrage_records', { before: 'missing-record' })).ok, false)
  assert.equal(saved().arbitrage.records.length, 2)
  assert.equal((await tool('evaluate_arbitrage', { ...snapshot(), baseAmount: -1 })).ok, false)
  assert.equal(saved().arbitrage.records.length, 2)
})

test('a failed journal save rolls back the record and does not report success', async t => {
  const { rt, tool, saved } = await start(t)
  const save = rt.save
  rt.save = () => Promise.reject(new Error('disk full'))
  const result = await tool('evaluate_arbitrage', snapshot())
  assert.equal(result.ok, false)
  assert.match(result.error, /disk full/)
  assert.equal(rt.state.arbitrage?.records?.length ?? 0, 0)
  rt.save = save
  assert.equal((await tool('evaluate_arbitrage', snapshot())).ok, true)
  assert.equal(saved().arbitrage.records.length, 1)
})

test('the bounded journal survives restarting the plugin and can be read without write access', async t => {
  const { rt, tool, saved, ctx, home, main } = await start(t)
  rt.state.arbitrage = { records: Array.from({ length: 200 }, (_, index) => ({ id: `older-${index}` })) }
  const fresh = await tool('evaluate_arbitrage', snapshot())
  assert.equal(saved().arbitrage.records.length, 200)
  assert.equal(saved().arbitrage.records[0].id, 'older-1')
  await ctx.dispose()
  const nextContext = fakeContext()
  const next = createRuntime(nextContext, { home })
  try {
    await next.load()
    next.readOnly = () => 'Read only'
    const result = JSON.parse(await nextContext.registeredTools.get('list_arbitrage_records').execute({ limit: 1 }, { agent: { id: main } }))
    assert.equal(result.ok, true)
    assert.equal(result.total, 200)
    assert.equal(result.records[0].id, fresh.record.id)
    assert.equal(result.records[0].result.buy.source, 'https://example.org/a')
    assert.equal((await tool('list_arbitrage_records', { limit: 51 })).ok, false)
  } finally {
    await nextContext.dispose()
  }
})

test('non-Bot sessions cannot read or write the simulation journal', async t => {
  const { tool, saved } = await start(t)
  assert.equal((await tool('list_arbitrage_records', {}, 'outside-session')).ok, false)
  assert.equal((await tool('evaluate_arbitrage', snapshot(), 'outside-session')).ok, false)
  assert.equal(saved().arbitrage?.records?.length ?? 0, 0)
})
