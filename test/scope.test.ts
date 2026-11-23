import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Config, type Payload, type PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readSignupRequest, signupPlugin, submitSignup, verifySignup } from '../src/index.js'

// A link works only on the site it was asked on (K5040): with `scopeField`, every token lookup also matches the site
// from `scopeFor`. Made-up people at example.com, two made-up sites, on a throwaway in-memory database.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const mail: { to: string; subject: string; text: string }[] = []
const PW = 'correct horse battery'

/** A request from a site: `x-site` is what `scopeFor` reads. `throw` makes `scopeFor` throw; null sends no site. */
const on = (site: string | null) => ({ headers: new Headers({ 'x-forwarded-for': '203.0.113.7', ...(site ? { 'x-site': site } : {}) }) }) as Partial<PayloadRequest>
const tokenFrom = (to: string) => {
  const m = [...mail].reverse().find((x) => x.to === to && x.subject.startsWith('Confirm'))
  return decodeURIComponent(/token=([^\s]+)/.exec(m?.text ?? '')?.[1] ?? '')
}
const users = async (email: string) => (await payload.find({ collection: 'users', where: { email: { equals: email } }, depth: 0, overrideAccess: true })).docs as Doc[]
const requests = async (email: string) => (await payload.find({ collection: 'signup-requests' as never, where: { email: { equals: email } }, depth: 0, overrideAccess: true })).docs as Doc[]
let n = 0
const fresh = () => `scoped${++n}@example.com`

/** Gives the requests collection the site field, as a multi-site plugin would. */
const siteField = (config: Config): Config => ({
  ...config,
  collections: (config.collections ?? []).map((c) => (c.slug === 'signup-requests' ? { ...c, fields: [...c.fields, { name: 'site', type: 'text' as const, index: true }] } : c)),
})

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://site.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('signup-scope'), ensureIndexes: true }),
      email: (() => ({
        name: 'test',
        defaultFromAddress: 'noreply@example.com',
        defaultFromName: 'Test',
        sendEmail: async (m: { to: string; subject: string; text: string }) => void mail.push({ to: m.to, subject: m.subject, text: m.text }),
      })) as never,
      collections: [{ slug: 'users', auth: true, access: { read: () => true }, fields: [{ name: 'name', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        signupPlugin({
          fields: [{ name: 'name', type: 'text', required: true }],
          confirmShows: ['name'],
          access: { manage: (() => false) as never },
          rateLimit: async () => true,
          scopeField: 'site',
          scopeFor: (r) => {
            const site = r.headers?.get('x-site') ?? null
            if (site === 'throw') throw new Error('made-up site lookup failure')
            return site
          },
        }),
        siteField,
      ],
    }),
  })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  await payload.create({ collection: 'users', data: { email: 'staff@example.com', password: 'staff password long', name: 'Staff' } as never, overrideAccess: true })
  await payload.updateGlobal({ slug: 'signup-settings' as never, data: { mode: 'approval' } as never, overrideAccess: true })
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('a sign-up link works only on its own site (K5040)', () => {
  it('records the site it was asked on', async () => {
    const email = fresh()
    await submitSignup(payload, { email, details: { name: 'Made Up' } }, on('site-a'))
    expect((await requests(email))[0]?.site).toBe('site-a')
  })

  it('neither shows nor confirms on another site, makes nothing, and still works on its own site after', async () => {
    const email = fresh()
    await submitSignup(payload, { email, details: { name: 'Made Up' } }, on('site-a'))
    const token = tokenFrom(email)
    await expect(readSignupRequest(payload, { token }, on('site-b'))).rejects.toMatchObject({ code: 'badLink' })
    await expect(verifySignup(payload, { token, password: PW }, on('site-b'))).rejects.toMatchObject({ code: 'badLink' })
    expect(await users(email)).toEqual([])
    expect((await requests(email))[0]?.status).toBe('unverified')
    expect((await readSignupRequest(payload, { token }, on('site-a'))).email).toBe(email)
    expect(await verifySignup(payload, { token, password: PW }, on('site-a'))).toEqual({ status: 'pending' })
    expect(await users(email)).toHaveLength(1)
  })

  it('refuses the link as unknown when the site can’t be told (no site, or the lookup throws): fails closed', async () => {
    const email = fresh()
    await submitSignup(payload, { email, details: { name: 'Made Up' } }, on('site-a'))
    const token = tokenFrom(email)
    for (const site of [null, 'throw']) {
      await expect(readSignupRequest(payload, { token }, on(site))).rejects.toMatchObject({ code: 'badLink' })
      await expect(verifySignup(payload, { token, password: PW }, on(site))).rejects.toMatchObject({ code: 'badLink' })
    }
    expect(await users(email)).toEqual([])
    expect((await requests(email))[0]?.status).toBe('unverified')
  })
})
