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
type CatalogClient = Pick<BridgeRpcClient, 'getState' | 'onStateChange' | 'sendRequest'>
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
const syncs = new Map<CatalogLocale, Promise<HeldCatalog>>()
const arrivalListeners = new Set<ArrivalListener>()

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

// After a failed send on a live connection, wait for the next one rather than resend at once.
function whenConnected(client: CatalogClient, afterFailure: boolean): Promise<void> {
  const connected = client.getState() === 'connected'
  if (connected && !afterFailure) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let left = !connected
    const stop = client.onStateChange((state) => {
      if (state !== 'connected') {
        left = true
      } else if (left) {
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
        reject(new Error('[i18n] connection lost before the catalog arrived'))
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

// Retries a failed send on the next connection; a refusal or an unreadable reply ends the sync.
async function syncFromHost(
  { client, store }: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined
): Promise<HeldCatalog> {
  for (let afterFailure = false; ; afterFailure = true) {
    await whenConnected(client, afterFailure)
    const settled = await captureRpcOperationSettlement(client, localeCatalogRead, {
      locale,
      ...(known ? { knownSha256: known.sha256 } : {})
    })
    if (settled.status === 'rejected') {
      continue
    }
    const { outcome } = settled
    if (outcome.kind === 'decoded') {
      const { sha256, catalog } = outcome.value
      if (catalog === null && known?.sha256 === sha256) {
        return known
      }
      if (catalog !== null) {
        const next = { sha256, catalog }
        writeStoredCatalog(store, locale, next)
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
}

function syncOnce(
  current: CatalogSource,
  locale: CatalogLocale,
  known: HeldCatalog | undefined
): Promise<HeldCatalog> {
  const running = syncs.get(locale)
  if (running) {
    return running
  }
  const sync = syncFromHost(current, locale, known).then((next) => {
    held.set(locale, next)
    confirmed.add(locale)
    return next
  })
  syncs.set(locale, sync)
  const forget = (): void => {
    syncs.delete(locale)
  }
  sync.then(forget, forget)
  return sync
}

// Same contract as the bundled imports: resolve the catalog or reject so activation falls back to English.
export async function importLocaleCatalog(locale: CatalogLocale): Promise<LocaleCatalog> {
  const current = source
  if (current === null) {
    throw new Error('[i18n] no catalog source outside a shell page')
  }
  const known = held.get(locale) ?? (await readStoredCatalog(current.store, locale)) ?? undefined
  if (known) {
    held.set(locale, known)
    if (!confirmed.has(locale)) {
      // Show the stored copy now; a newer one replaces it when the host answers.
      void syncOnce(current, locale, known).then(
        (next) => {
          if (next !== known) {
            announce(locale, next.catalog)
          }
        },
        () => undefined
      )
    }
    return known.catalog
  }
  const sync = syncOnce(current, locale, undefined)
  if (current.client.getState() === 'connected') {
    try {
      return (await beforeConnectionLoss(current.client, sync)).catalog
    } catch {
      // Fall through: activation shows English and the sync announces the catalog later.
    }
  }
  void sync.then(
    (next) => {
      announce(locale, next.catalog)
    },
    () => undefined
  )
  throw new Error(`[i18n] no ${locale} catalog on this phone yet`)
}
