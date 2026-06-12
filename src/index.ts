import express, { type Request, type Response, type NextFunction } from 'express'
import type { InternalUser } from './types/internal.js'
import 'dotenv/config'
import {
    buildCardEntries,
    buildCategoryEntries,
    buildCustomCardEntries,
    buildItemEntries,
    buildLibraryEntries,
    buildOPDSXMLSkeleton,
    buildSearchDefinition,
    OPDS_CATEGORY_TYPES,
    type OpdsCategory
} from './helpers/abs.js'
import {
    apiCall,
    coverFromAudiobookshelf,
    downloadItemFromAudiobookshelf,
    loginToAudiobookshelf,
    proxyToAudiobookshelf
} from './helpers/api.js'
import type { Author, Library, LibraryItem } from './types/library.js'
import { hash } from 'crypto'
import { loadLocalizations } from './i18n/i18n.js'

const app = express()
const port = process.env.PORT || 3010
export const useProxy = process.env.USE_PROXY === 'true' || false
export const serverURL = process.env.ABS_URL || 'http://localhost:3000'
const internalUsersString = process.env.OPDS_USERS || ''
const showAudioBooks = process.env.SHOW_AUDIOBOOKS === 'true' || false
const showCharCards = process.env.SHOW_CHAR_CARDS === 'true' || false
const enabledOPDSCategories = parseOPDSCategories(process.env.OPDS_CATEGORIES)
const opdsPageSize = parsePositiveInteger(process.env.OPDS_PAGE_SIZE, 20)
const feedCacheMaxAge = 60
const serverStartedAt = new Date().toISOString()
await loadLocalizations()

const internalUsers: InternalUser[] = internalUsersString.split(',').map((user) => {
    const [name, apiKey, password] = user.split(':')
    return { name, apiKey, password }
})

type FacetCategory = Exclude<OpdsCategory, 'all' | 'recent'>
type LibraryFacets = Record<FacetCategory, string[]>

interface CacheEntry<T> {
    timestamp: number
    data: T
}

interface LibrariesData {
    libraries: Library[]
    updatedAt: string
}

interface LibraryItemsData {
    facets: LibraryFacets
    itemsByRecent: LibraryItem[]
    itemsByTitle: LibraryItem[]
    updatedAt: string
    visible: boolean
}

const librariesCache: Record<string, CacheEntry<LibrariesData>> = {}
const libraryItemsCache: Record<string, CacheEntry<LibraryItemsData>> = {}
const CACHE_EXPIRATION = 60 * 60 * 1000 // 1 hour in milliseconds
const FACET_CATEGORIES: readonly FacetCategory[] = ['authors', 'narrators', 'genres', 'series']

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsedValue = Number.parseInt(value || '', 10)
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

function parseOPDSCategories(value?: string): OpdsCategory[] {
    if (!value?.trim()) {
        return [...OPDS_CATEGORY_TYPES]
    }

    const categories: OpdsCategory[] = []
    for (const category of value.split(',')) {
        const normalizedCategory = category.trim().toLowerCase()
        if ((OPDS_CATEGORY_TYPES as readonly string[]).includes(normalizedCategory)) {
            const opdsCategory = normalizedCategory as OpdsCategory
            if (!categories.includes(opdsCategory)) {
                categories.push(opdsCategory)
            }
        } else if (normalizedCategory) {
            console.warn(`Ignoring unknown OPDS category "${normalizedCategory}"`)
        }
    }

    return categories
}

function ensureOPDSCategoryIsEnabled(category: OpdsCategory, res: Response): boolean {
    if (enabledOPDSCategories.includes(category)) {
        return true
    }

    res.status(404).send('Category not found')
    return false
}

function getRouteCategory(type: string | string[]): OpdsCategory | null {
    if (Array.isArray(type)) {
        return null
    }
    return (OPDS_CATEGORY_TYPES as readonly string[]).includes(type) ? (type as OpdsCategory) : null
}

function getLibraryItemsCategory(req: Request): OpdsCategory | null {
    if (getQueryValue(req.query.sort) === 'recent') {
        return 'recent'
    }

    const type = getQueryValue(req.query.type)
    if (type) {
        return getRouteCategory(type)
    }

    if (
        getQueryValue(req.query.q) ||
        getQueryValue(req.query.author) ||
        getQueryValue(req.query.title)
    ) {
        return null
    }

    return 'all'
}

async function authenticateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization

    if (process.env.NODE_ENV === 'development') {
        console.log(`[DEBUG] Auth attempt for ${req.method} ${req.path}`)
        console.log(`[DEBUG] Auth header present: ${!!authHeader}`)
    }

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        if (process.env.NODE_ENV === 'development') {
            console.log('[DEBUG] No valid Basic Auth header found')
        }
        res.set('WWW-Authenticate', 'Basic realm="OPDS"')
        res.status(401).send('Authentication required')
        return
    }

    try {
        const base64Credentials = authHeader.split(' ')[1]
        const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii')
        const [username, password] = credentials.split(':')

        if (!username || !password) {
            if (process.env.NODE_ENV === 'development') {
                console.log('[DEBUG] Invalid credentials format')
            }
            res.set('WWW-Authenticate', 'Basic realm="OPDS"')
            res.status(401).send('Invalid credentials format')
            return
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] Attempting authentication for user: ${username}`)
        }

        // First try internal users (for backwards compatibility)
        const internalUser = internalUsers.find(
            (u) => u.name.toLowerCase() === username.toLowerCase() && u.password === password
        )

        if (internalUser) {
            if (process.env.NODE_ENV === 'development') {
                console.log(`[DEBUG] Internal user authenticated: ${username}`)
            }
            req.user = internalUser
            next()
            return
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] Trying Audiobookshelf authentication for: ${username}`)
        }

        const user = await loginToAudiobookshelf(username, password)
        if (user) {
            if (process.env.NODE_ENV === 'development') {
                console.log(`[DEBUG] Audiobookshelf user authenticated: ${username}`)
            }
            req.user = user
            next()
            return
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] Authentication failed for user: ${username}`)
        }
        res.set('WWW-Authenticate', 'Basic realm="OPDS"')
        res.status(401).send('Invalid username or password')
        return
    } catch (error) {
        console.error('Authentication error:', error)
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] Authentication exception: ${error}`)
        }
        res.set('WWW-Authenticate', 'Basic realm="OPDS"')
        res.status(401).send('Authentication failed')
        return
    }
}

declare global {
    namespace Express {
        interface Request {
            user?: InternalUser
        }
    }
}

app.get('/opds/proxy/{*any}', (req, res) => proxyToAudiobookshelf(req, res))
app.get('/opds/download/:itemId/:filename', (req, res) => downloadItemFromAudiobookshelf(req, res))
app.get('/opds/cover/:itemId', (req, res) => coverFromAudiobookshelf(req, res))

function getQueryValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0]
    }

    return undefined
}

function getHeaderValue(value: unknown): string | undefined {
    return getQueryValue(value)
}

function getUserCacheKey(user: InternalUser): string {
    return hash('sha1', `${user.name}:${user.apiKey}`)
}

function getCacheEntry<T>(cache: Record<string, CacheEntry<T>>, key: string): T | undefined {
    const cacheEntry = cache[key]
    if (!cacheEntry) {
        return undefined
    }

    if (Date.now() - cacheEntry.timestamp >= CACHE_EXPIRATION) {
        delete cache[key]
        return undefined
    }

    return cacheEntry.data
}

function setCacheEntry<T>(cache: Record<string, CacheEntry<T>>, key: string, data: T): T {
    cache[key] = {
        timestamp: Date.now(),
        data
    }
    return data
}

function splitAuthors(value?: string): Author[] {
    return splitMetadataList(value).map((name) => ({ name }))
}

function splitMetadataList(value?: string): string[] {
    return value
        ? value
              .split(',')
              .map((entry) => entry.replace(/#.*$/, '').trim())
              .filter(Boolean)
        : []
}

function parseItems(items: any): LibraryItem[] {
    return (items?.results || [])
        .map((item: any) => ({
            id: item.id,
            title: item.media.metadata.title,
            subtitle: item.media.metadata.subtitle,
            description: item.media.metadata.description,
            genres: item.media.metadata.genres || [],
            tags: item.media.metadata.tags || [],
            publisher: item.media.metadata.publisher,
            isbn: item.media.metadata.isbn,
            language: item.media.metadata.language,
            publishedYear: item.media.metadata.publishedYear,
            authors: splitAuthors(item.media.metadata?.authorName),
            narrators: splitAuthors(item.media.metadata?.narratorName),
            series: splitMetadataList(item.media.metadata?.seriesName),
            addedAt: item.addedAt,
            format: item.media.ebookFormat
        }))
        .filter((item: LibraryItem) => item.format !== undefined || showAudioBooks)
}

function compareItemsByTitle(a: LibraryItem, b: LibraryItem): number {
    return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
}

function compareItemsByRecent(a: LibraryItem, b: LibraryItem): number {
    const dateA = new Date(a.addedAt || 0).getTime()
    const dateB = new Date(b.addedAt || 0).getTime()
    return dateB - dateA
}

function sortedByTitle(items: LibraryItem[]): LibraryItem[] {
    return [...items].sort(compareItemsByTitle)
}

function sortedByRecent(items: LibraryItem[]): LibraryItem[] {
    return [...items].sort(compareItemsByRecent)
}

function emptyFacets(): Record<FacetCategory, Set<string>> {
    return {
        authors: new Set<string>(),
        narrators: new Set<string>(),
        genres: new Set<string>(),
        series: new Set<string>()
    }
}

function sortedFacetItems(items: Set<string>): string[] {
    return Array.from(items).sort((a, b) => a.localeCompare(b))
}

function addFacetValue(items: Set<string>, value: string): void {
    const normalizedValue = value.trim()
    if (normalizedValue) {
        items.add(normalizedValue)
    }
}

function buildFacets(items: LibraryItem[]): LibraryFacets {
    const facets = emptyFacets()

    for (const item of items) {
        item.authors.forEach((author) => addFacetValue(facets.authors, author.name))
        item.narrators.forEach((narrator) => addFacetValue(facets.narrators, narrator.name))
        item.genres.forEach((genre) => addFacetValue(facets.genres, genre))
        item.tags.forEach((tag) => addFacetValue(facets.genres, tag))
        item.series.forEach((series) => addFacetValue(facets.series, series))
    }

    return {
        authors: sortedFacetItems(facets.authors),
        narrators: sortedFacetItems(facets.narrators),
        genres: sortedFacetItems(facets.genres),
        series: sortedFacetItems(facets.series)
    }
}

function buildLibraryItemsData(items: any): LibraryItemsData {
    const parsedItems = parseItems(items)

    return {
        facets: buildFacets(parsedItems),
        itemsByRecent: sortedByRecent(parsedItems),
        itemsByTitle: sortedByTitle(parsedItems),
        updatedAt: new Date().toISOString(),
        visible: parsedItems.length > 0
    }
}

function getLibraryItemsCacheKey(libraryId: string, user: InternalUser): string {
    return `${getUserCacheKey(user)}:${libraryId}`
}

function getLibrariesCacheKey(user: InternalUser): string {
    return getUserCacheKey(user)
}

function parseLibraries(libraries: any): Library[] {
    return libraries.libraries.map((library: any) => ({
        id: library.id,
        name: library.name,
        icon: library.icon
    }))
}

async function getLibrariesData(user: InternalUser): Promise<LibrariesData> {
    const cacheKey = getLibrariesCacheKey(user)
    const cachedLibraries = getCacheEntry(librariesCache, cacheKey)
    if (cachedLibraries) {
        return cachedLibraries
    }

    const libraries = await apiCall(`/libraries`, user)
    return setCacheEntry(librariesCache, cacheKey, {
        libraries: parseLibraries(libraries),
        updatedAt: new Date().toISOString()
    })
}

async function getLibrary(libraryId: string | string[], user: InternalUser): Promise<Library | null> {
    if (Array.isArray(libraryId)) {
        return null
    }

    const librariesData = await getLibrariesData(user)
    const library = librariesData.libraries.find((item) => item.id === libraryId)
    if (library) {
        return library
    }

    return apiCall(`/libraries/${libraryId}`, user)
}

async function getLibraryItemsData(
    libraryId: string | string[],
    user: InternalUser
): Promise<LibraryItemsData | null> {
    if (Array.isArray(libraryId)) {
        return null
    }

    const cacheKey = getLibraryItemsCacheKey(libraryId, user)
    const cachedItems = getCacheEntry(libraryItemsCache, cacheKey)
    if (cachedItems) {
        return cachedItems
    }

    const items = await apiCall(`/libraries/${libraryId}/items`, user)
    return setCacheEntry(libraryItemsCache, cacheKey, buildLibraryItemsData(items))
}

async function libraryHasVisibleItems(libraryId: string | string[], user: InternalUser): Promise<boolean> {
    if (Array.isArray(libraryId)) {
        return false
    }
    if (showAudioBooks) return true

    const libraryData = await getLibraryItemsData(libraryId, user)
    return Boolean(libraryData?.visible)
}

async function ensureLibraryIsVisible(
    libraryId: string | string[],
    user: InternalUser,
    res: Response
): Promise<boolean> {
    if (Array.isArray(libraryId)) {
        return false
    }

    if (await libraryHasVisibleItems(libraryId, user)) {
        return true
    }

    res.status(404).send('Library not found')
    return false
}

function normalizeText(value?: string): string {
    return (value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function textIncludes(value: string | undefined, search: string): boolean {
    return normalizeText(value).includes(search)
}

function authorsInclude(authors: Author[], search: string): boolean {
    return authors.some((author) => textIncludes(author.name, search))
}

function stringsInclude(values: string[], search: string): boolean {
    return values.some((value) => textIncludes(value, search))
}

function itemMatchesCategory(item: LibraryItem, category: OpdsCategory | null, search: string): boolean {
    if (!search) {
        return false
    }

    switch (category) {
        case 'authors':
            return authorsInclude(item.authors, search)
        case 'narrators':
            return authorsInclude(item.narrators, search)
        case 'genres':
            return stringsInclude(item.genres, search) || stringsInclude(item.tags, search)
        case 'series':
            return stringsInclude(item.series, search)
        default:
            return false
    }
}

function itemMatchesSearch(item: LibraryItem, search: string): boolean {
    return (
        textIncludes(item.title, search) ||
        textIncludes(item.subtitle, search) ||
        textIncludes(item.description, search) ||
        textIncludes(item.publisher, search) ||
        textIncludes(item.isbn, search) ||
        textIncludes(item.language, search) ||
        textIncludes(item.publishedYear, search) ||
        authorsInclude(item.authors, search) ||
        stringsInclude(item.genres, search) ||
        stringsInclude(item.tags, search)
    )
}

function filterItemsForRequest(items: LibraryItem[], req: Request): LibraryItem[] {
    let filteredItems = items
    const type = getQueryValue(req.query.type)
    const name = normalizeText(getQueryValue(req.query.name))
    const query = normalizeText(getQueryValue(req.query.q))
    const author = normalizeText(getQueryValue(req.query.author))
    const title = normalizeText(getQueryValue(req.query.title))

    if (type) {
        const category = getRouteCategory(type)
        filteredItems = filteredItems.filter((item) => itemMatchesCategory(item, category, name))
    }
    if (query) {
        filteredItems = filteredItems.filter((item) => itemMatchesSearch(item, query))
    }
    if (author) {
        filteredItems = filteredItems.filter((item) => authorsInclude(item.authors, author))
    }
    if (title) {
        filteredItems = filteredItems.filter(
            (item) => textIncludes(item.title, title) || textIncludes(item.subtitle, title)
        )
    }

    return filteredItems
}

function getItemsForRequest(libraryData: LibraryItemsData, req: Request): LibraryItem[] {
    const items = getQueryValue(req.query.sort) === 'recent' ? libraryData.itemsByRecent : libraryData.itemsByTitle
    return filterItemsForRequest(items, req)
}

function getPage(req: Request): number {
    const page = Number.parseInt(getQueryValue(req.query.page) || '', 10)
    return Number.isFinite(page) && page > 0 ? page : 0
}

function getLatestUpdatedAt(...updatedValues: string[]): string {
    const timestamps = updatedValues.map((value) => Date.parse(value)).filter((value) => Number.isFinite(value))
    if (timestamps.length === 0) {
        return serverStartedAt
    }

    return new Date(Math.max(...timestamps)).toISOString()
}

function requestHasMatchingEtag(req: Request, etag: string): boolean {
    return (getHeaderValue(req.headers['if-none-match']) || '')
        .split(',')
        .map((value) => value.trim())
        .includes(etag)
}

function sendOPDSXML(req: Request, res: Response, xml: string, updatedAt: string): void {
    const etag = `"${hash('sha1', xml)}"`
    res.set('Cache-Control', `private, max-age=${feedCacheMaxAge}`)
    res.set('ETag', etag)
    res.set('Last-Modified', new Date(updatedAt).toUTCString())

    if (requestHasMatchingEtag(req, etag)) {
        res.status(304).end()
        return
    }

    res.type('application/xml').send(xml)
}

function normalizeStartLetter(item: string): string {
    const startLetter = item.charAt(0).toUpperCase()
    const normalizedStartLetter = startLetter.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    return 'A' <= normalizedStartLetter && normalizedStartLetter <= 'Z' ? normalizedStartLetter : ''
}

function buildStartLetterCards(
    items: string[],
    libraryId: string,
    type: string
): { item: string; link: string }[] {
    const countByStartLetter = new Map<string, number>()
    for (const item of items) {
        const startLetter = normalizeStartLetter(item)
        if (startLetter) {
            countByStartLetter.set(startLetter, (countByStartLetter.get(startLetter) || 0) + 1)
        }
    }

    return Array.from(countByStartLetter.entries()).map(([letter, count]) => {
        const query = new URLSearchParams({
            start: letter.toLowerCase()
        })
        const baseUrl = `/opds/libraries/${encodeURIComponent(libraryId)}/${encodeURIComponent(type)}`

        return {
            item: `${letter} (${count})`,
            link: `${baseUrl}?${query.toString()}`
        }
    })
}

function getFacetItems(libraryData: LibraryItemsData, category: OpdsCategory): string[] {
    return FACET_CATEGORIES.includes(category as FacetCategory)
        ? libraryData.facets[category as FacetCategory]
        : []
}

app.get('/opds', authenticateUser, async (req: Request, res: Response) => {
    const user = req.user!

    const librariesData = await getLibrariesData(user)
    const visibleLibraryResults = showAudioBooks
        ? librariesData.libraries.map((library) => ({ library, updatedAt: librariesData.updatedAt, visible: true }))
        : await Promise.all(
              librariesData.libraries.map(async (library) => {
                  const libraryData = await getLibraryItemsData(library.id, user)
                  return {
                      library,
                      updatedAt: libraryData?.updatedAt || librariesData.updatedAt,
                      visible: Boolean(libraryData?.visible)
                  }
              })
          )
    const visibleLibraries = visibleLibraryResults.filter(({ visible }) => visible).map(({ library }) => library)
    const updatedAt = getLatestUpdatedAt(
        librariesData.updatedAt,
        ...visibleLibraryResults.map((library) => library.updatedAt)
    )

    //Skip listing libraries if only a single library is visible.
    if (visibleLibraries.length === 1) {
        const library = visibleLibraries[0]
        sendOPDSXML(
            req,
            res,
            buildOPDSXMLSkeleton(
                `urn:uuid:${library.id}`,
                `Categories`,
                buildCategoryEntries(
                    library.id,
                    user,
                    req.headers['accept-language'],
                    enabledOPDSCategories,
                    updatedAt
                ),
                { updated: updatedAt }
            ),
            updatedAt
        )
        return
    }

    sendOPDSXML(
        req,
        res,
        buildOPDSXMLSkeleton(
            hash('sha1', user.name),
            `${user.name}'s Libraries`,
            buildLibraryEntries(visibleLibraries, user, updatedAt),
            { updated: updatedAt }
        ),
        updatedAt
    )
})

app.get('/opds/libraries/:libraryId', authenticateUser, async (req: Request, res: Response) => {
    const user = req.user!
    const lang = req.headers['accept-language']
    const libraryId = getQueryValue(req.params.libraryId)

    if (!libraryId) {
        res.status(400).send('Invalid library')
        return
    }

    if (!(await ensureLibraryIsVisible(libraryId, user, res))) {
        return
    }

    if (req.query.categories) {
        const updatedAt = serverStartedAt
        sendOPDSXML(
            req,
            res,
            buildOPDSXMLSkeleton(
                `urn:uuid:${libraryId}`,
                `Categories`,
                buildCategoryEntries(libraryId, user, lang, enabledOPDSCategories, updatedAt),
                { updated: updatedAt }
            ),
            updatedAt
        )
        return
    }

    const requestedCategory = getLibraryItemsCategory(req)
    if (requestedCategory && !ensureOPDSCategoryIsEnabled(requestedCategory, res)) {
        return
    }

    const libraryData = await getLibraryItemsData(libraryId, user)
    const library = await getLibrary(libraryId, user)
    if (!libraryData || !library) {
        res.status(404).send('Library not found')
        return
    }

    const parsedItems = getItemsForRequest(libraryData, req)

    // Pagination
    const page = getPage(req)
    const startIndex = page * opdsPageSize
    const endIndex = Math.min(startIndex + opdsPageSize, parsedItems.length)
    const paginatedItems = parsedItems.slice(startIndex, endIndex)
    const endOfPage = endIndex >= parsedItems.length

    sendOPDSXML(
        req,
        res,
        buildOPDSXMLSkeleton(
            `urn:uuid:${libraryId}`,
            `${library.name}`,
            buildItemEntries(paginatedItems, user, libraryData.updatedAt),
            {
                endOfPage,
                library,
                pageSize: opdsPageSize,
                request: req,
                totalItems: parsedItems.length,
                updated: libraryData.updatedAt,
                user
            }
        ),
        libraryData.updatedAt
    )
})

app.get('/opds/libraries/:libraryId/search-definition', authenticateUser, async (req: Request, res: Response) => {
    const user = req.user!
    const libraryId = getQueryValue(req.params.libraryId)

    if (!libraryId) {
        res.status(400).send('Invalid library')
        return
    }

    if (!(await ensureLibraryIsVisible(libraryId, user, res))) {
        return
    }

    sendOPDSXML(req, res, buildSearchDefinition(libraryId, user), serverStartedAt)
})

app.get('/opds/libraries/:libraryId/:type', authenticateUser, async (req: Request, res: Response) => {
    const user = req.user!
    const libraryId = getQueryValue(req.params.libraryId)
    const routeType = getQueryValue(req.params.type)

    if (!libraryId || !routeType) {
        res.status(400).send('Invalid request')
        return
    }

    if (!(await ensureLibraryIsVisible(libraryId, user, res))) {
        return
    }

    const category = getRouteCategory(routeType)
    if (!category || category === 'all' || category === 'recent') {
        res.status(400).send('Invalid type')
        return
    }

    if (!ensureOPDSCategoryIsEnabled(category, res)) {
        return
    }

    const libraryData = await getLibraryItemsData(libraryId, user)
    const library = await getLibrary(libraryId, user)
    if (!libraryData || !library) {
        res.status(404).send('Library not found')
        return
    }

    let distinctTypeArray = getFacetItems(libraryData, category)

    if (!req.query.start && showCharCards) {
        sendOPDSXML(
            req,
            res,
            buildOPDSXMLSkeleton(
                `urn:uuid:${libraryId}`,
                `${library.name}`,
                buildCustomCardEntries(
                    buildStartLetterCards(distinctTypeArray, library.id, routeType),
                    libraryData.updatedAt
                ),
                { updated: libraryData.updatedAt }
            ),
            libraryData.updatedAt
        )
        return
    }
    if (showCharCards) {
        distinctTypeArray = distinctTypeArray.filter((item: string) => {
            return normalizeStartLetter(item).toLowerCase() === getQueryValue(req.query.start)
        })
    }

    sendOPDSXML(
        req,
        res,
        buildOPDSXMLSkeleton(
            `urn:uuid:${libraryId}`,
            `${library.name}`,
            buildCardEntries(distinctTypeArray, routeType, user, libraryId, libraryData.updatedAt),
            { updated: libraryData.updatedAt }
        ),
        libraryData.updatedAt
    )
})

app.listen(port, () => {
    console.log(`OPDS server running at http://localhost:${port}/opds`)
    console.log(`OPDS authentication: HTTP Basic Auth`)
    console.log(`Server URL: ${serverURL}`)
})
