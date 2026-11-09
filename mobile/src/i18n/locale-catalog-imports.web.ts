import * as z from 'zod'
import type { SupportedUiLocale } from '../../../src/shared/ui-locale'
import { SHA256_PATTERN } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD } from '../../../src/shared/mobile-web-bundle/locale-catalog-contract'
import {
  decodeDeviceStoreValue,
  encodeDeviceStoreValue
} from '../device-store/device-store-value-codec'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { PageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'
import { captureRpcOperationSettlement, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'

// The page build carries no catalogs: the desktop serves the active one, and the phone keeps a copy per host.
export type LocaleCatalog = Readonly<Record<string, unknown>>
type CatalogLocale = Exclude<SupportedUiLocale, 'en'>
type HeldCatalog = { readonly sha256: string; readonly catalog: LocaleCatalog }
type CatalogClient = Pick<
  BridgeRpcClient,
  'getState' | 'getGeneration' | 'onStateChange' | 'sendRequest'
>
type CatalogSource = { readonly client: CatalogClient; readonly store: PageDeviceStore }
type ArrivalListener = (locale: CatalogLocale, catalog: LocaleCatalog) => void

const catalogSchema = z.record(z.string(), z.unknown())
const storedCatalogSchema = z.object({
  v: z.literal(1),
  sha256: z.string().regex(SHA256_PATTERN),
  catalog: catalogSchema
})

const localeCatalogRead = defineRpcOperation({
  name: 'mobileWeb.bundle-locale-catalog',
  method: MOBILE_WEB_BUNDLE_LOCALE_CATALOG_METHOD,
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant(
    'mobile-web-bundle-locale-catalog',
    z.looseObject({ sha256: z.string().regex(SHA256_PATTERN), catalog: catalogSchema.nullable() })
  )
})

let source: CatalogSource | null = null
const held = new Map<CatalogLocale, HeldCatalog>()
// Locales the host confirmed this page session; switching back to one asks nothing.
const confirmed = new Set<CatalogLocale>()
const syncing = new Set<CatalogLocale>()
const arrivalListeners = new Set<ArrivalListener>()
// The stored read plus a relay round trip with the largest catalog fit well inside; past it the page opens in English.
const FIRST_PAINT_CATALOG_WAIT_MS = 3_000

export function publishPageLocaleCatalogSource(next: CatalogSource): void {
  source = next
}

// A catalog that arrives after activation settled: a newer copy, or the first one after an offline start.
export function onLocaleCatalogArrival(listener: ArrivalListener): () => void {
  arrivalListeners.add(listener)
  return () => {
    arrivalListeners.delete(listener)
  }
}

function announce(locale: CatalogLocale, catalog: LocaleCatalog): void {
  for (const listener of arrivalListeners) {
    listener(locale, catalog)
  }
}

const storeKey = (locale: CatalogLocale): string => `i18n-catalog:${locale}`

async function readStoredCatalog(
  store: PageDeviceStore,
  locale: CatalogLocale
): Promise<HeldCatalog | null> {
  if (!store.available()) {
    return null
  }
  const read = await store.read('cache', [storeKey(locale)]).catch(() => null)
  const raw = read?.status === 'ok' ? read.values[0] : null
  if (!raw) {
    return null
  }
  const parsed = storedCatalogSchema.safeParse(decodeDeviceStoreValue(raw))
  return parsed.success ? { sha256: parsed.data.sha256, catalog: parsed.data.catalog } : null
}

function writeStoredCatalog(
  store: PageDeviceStore,
  locale: CatalogLocale,
  next: HeldCatalog
): void {
  if (store.available()) {
    const value = encodeDeviceStoreValue({ v: 1, ...next })
    void store.write('cache', [{ key: storeKey(locale), value }]).catch(() => undefined)
  }
}

// A send the host never answered, as opposed to a refusal or an unreadable reply.
class CatalogSendFailed extends Error {
  constructor(
    message: string,
    readonly generation: number | null = null
  ) {
    super(message)
  }
}

const generationOf = (client: CatalogClient): number | null => client.getGeneration?.() ?? null

// After a failed send, wait for a reconnect or a cutover to another connection, which is often connected already.
function whenConnected(client: CatalogClient, failedGeneration: number | null): Promise<void> {
  let reconnected = failedGeneration === null || client.getState() !== 'connected'
  const ready = (): boolean =>
    client.getState() === 'connected' && (reconnected || generationOf(client) !== failedGeneration)
  if (ready()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const stop = client.onStateChange((state) => {
      reconnected ||= state !== 'connected'
      if (ready()) {
        stop()
        resolve()
      }
    })
  })
}

// Rejects when the connection drops first, so a first paint never waits on a reply that can't come.
function beforeConnectionLoss<T>(client: CatalogClient, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = client.onStateChange((state) => {
      if (state !== 'connected') {
        stop()
        reject(new CatalogSendFailed('[i18n] connection lost before the catalog arrived'))
      }
    })
    work.then(
      (value) => {
        stop()
        resolve(value)
      },
      (error: unknown) => {
        stop()
        reject(error)
      }
    )
  })
}

// One request. On an answer the copy becomes the page's and the store's.
async function askHost(
  { client, store }: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined
): Promise<HeldCatalog> {
  const generation = generationOf(client)
  const settled = await captureRpcOperationSettlement(client, localeCatalogRead, {
    locale,
    ...(known ? { knownSha256: known.sha256 } : {})
  })
  if (settled.status === 'rejected') {
    throw new CatalogSendFailed(`[i18n] the ${locale} catalog request got no answer`, generation)
  }
  const { outcome } = settled
  if (outcome.kind === 'decoded') {
    const { sha256, catalog } = outcome.value
    // A null catalog only confirms the copy the phone named.
    const next = catalog !== null ? { sha256, catalog } : known?.sha256 === sha256 ? known : null
    if (next) {
      if (next !== known) {
        writeStoredCatalog(store, locale, next)
      }
      held.set(locale, next)
      confirmed.add(locale)
      return next
    }
  }
  const refusal = outcome.kind === 'outer-refused' ? outcome.error : undefined
  throw new Error(
    isMobileMethodUnavailableError(refusal?.code, refusal?.message)
      ? '[i18n] this desktop serves no language catalogs'
      : `[i18n] the desktop answered no ${locale} catalog`
  )
}

// Asks until the host answers, resending once per new connection; a refusal ends it.
async function syncFromHost(
  current: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined,
  failedGeneration: number | null
): Promise<HeldCatalog> {
  for (;;) {
    await whenConnected(current.client, failedGeneration)
    try {
      return await askHost(current, locale, known)
    } catch (error) {
      if (!(error instanceof CatalogSendFailed)) {
        throw error
      }
      failedGeneration = error.generation
    }
  }
}

// One sync per locale, announcing a copy other than the one the page already shows.
function syncOnce(
  current: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined,
  failedGeneration: number | null = null
): void {
  if (syncing.has(locale)) {
    return
  }
  syncing.add(locale)
  syncFromHost(current, locale, known, failedGeneration).then(
    (next) => {
      syncing.delete(locale)
      if (next !== known) {
        announce(locale, next.catalog)
      }
    },
    () => {
      syncing.delete(locale)
    }
  )
}

// What a first paint may wait for: the stored copy, else one request while connected.
async function firstCatalog(current: CatalogSource, locale: CatalogLocale): Promise<HeldCatalog> {
  const known = held.get(locale) ?? (await readStoredCatalog(current.store, locale))
  if (known) {
    held.set(locale, known)
    if (!confirmed.has(locale)) {
      // Show the stored copy now; a newer one replaces it when the host answers.
      syncOnce(current, locale, known)
    }
    return known
  }
  if (current.client.getState() !== 'connected') {
    throw new CatalogSendFailed('[i18n] no connection for the catalog yet')
  }
  return beforeConnectionLoss(current.client, askHost(current, locale, undefined))
}

function withinFirstPaintWait<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('[i18n] the catalog took too long for the first paint'))
    }, FIRST_PAINT_CATALOG_WAIT_MS)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// Same contract as the bundled imports: resolve the catalog or reject so activation falls back to English.
export async function importLocaleCatalog(locale: CatalogLocale): Promise<LocaleCatalog> {
  const current = source
  if (current === null) {
    throw new Error('[i18n] no catalog source outside a shell page')
  }
  const first = firstCatalog(current, locale)
  try {
    return (await withinFirstPaintWait(first)).catalog
  } catch (error) {
    // Activation shows English meanwhile; whatever comes later switches the page in place.
    first.then(
      (late) => {
        announce(locale, late.catalog)
      },
      (failure: unknown) => {
        if (failure instanceof CatalogSendFailed) {
          syncOnce(current, locale, undefined, failure.generation)
        }
      }
    )
    throw error
  }
}
