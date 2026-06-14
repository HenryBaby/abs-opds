import type { InternalUser } from '../types/internal.js'
import type { Request, Response } from 'express'
import axios, { type AxiosInstance } from 'axios'
import { serverURL, useProxy } from '../index.js'
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import {
    buildContentDisposition,
    getDownloadExtension,
    getDownloadMimeType,
    normalizeFormat,
    sanitizeFilenameBase
} from './download.js'

interface CachedToken {
    hashedToken: string
    expires: number
}

const tokenCache = new Map<string, CachedToken>()
const CACHE_TTL = 10 * 60 * 1000
const ABS_TIMEOUT_MS = parsePositiveInteger(process.env.ABS_TIMEOUT_MS, 15000)
const COVER_CACHE_TTL = 6 * 60 * 60 * 1000
const MAX_CACHED_COVERS = 200
const MAX_CACHED_COVER_BYTES = 2 * 1024 * 1024
let absClient: AxiosInstance | null = null

interface CachedCover {
    contentType: string
    data: Buffer
    etag: string
    expires: number
    lastModified?: string
}

const coverCache = new Map<string, CachedCover>()

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsedValue = Number.parseInt(value || '', 10)
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

function getAbsClient(): AxiosInstance {
    if (!absClient) {
        absClient = axios.create({
            baseURL: serverURL,
            timeout: ABS_TIMEOUT_MS,
            httpAgent: new http.Agent({ keepAlive: true }),
            httpsAgent: new https.Agent({ keepAlive: true })
        })
    }

    return absClient
}

// https://stackoverflow.com/questions/6953286/how-to-encrypt-data-that-needs-to-be-decrypted-in-node-js
function encryptTokenWithPassword(token: string, password: string): string {
    const key = crypto.scryptSync(password, 'salt', 32)
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update(token, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return iv.toString('hex') + ':' + encrypted
}

function decryptToken(hashedToken: string, password: string): string {
    const [ivHex, encrypted] = hashedToken.split(':')
    const key = crypto.scryptSync(password, 'salt', 32)
    const iv = Buffer.from(ivHex, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
}

function getCachedToken(username: string, password: string): string | null {
    const cached = tokenCache.get(username)
    if (!cached || Date.now() > cached.expires) {
        if (cached) tokenCache.delete(username)
        return null
    }
    try {
        return decryptToken(cached.hashedToken, password)
    } catch {
        tokenCache.delete(username)
        return null
    }
}

function setCachedToken(username: string, token: string, password: string): void {
    const hashedToken = encryptTokenWithPassword(token, password)
    tokenCache.set(username, {
        hashedToken,
        expires: Date.now() + CACHE_TTL
    })
}

export async function apiCall(path: string, user: InternalUser) {
    const request = await getAbsClient().get('/api' + path, {
        headers: {
            Authorization: `Bearer ${user.apiKey}`
        }
    })

    if (request.status !== 200) {
        throw new Error(`Error: ${request.status} ${request.statusText}`)
    }

    return request.data
}

export async function loginToAudiobookshelf(username: string, password: string): Promise<InternalUser | null> {
    try {
        const cachedToken = getCachedToken(username, password)
        if (cachedToken) {
            if (process.env.NODE_ENV === 'development') {
                console.log(`[DEBUG] Using cached token for user: ${username}`)
            }
            return {
                name: username,
                apiKey: cachedToken
            }
        }

        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] Attempting ABS login to: ${serverURL}/login`)
        }

        const response = await getAbsClient().post('/login', {
            username: username,
            password: password
        })

        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] ABS login response status: ${response.status}`)
        }

        if (response.status === 200 && response.data.user) {
            const userData = response.data.user
            if (process.env.NODE_ENV === 'development') {
                console.log(`[DEBUG] ABS login successful for user: ${userData.username}`)
            }

            setCachedToken(username, userData.accessToken, password)

            return {
                name: userData.username,
                apiKey: userData.accessToken
            }
        }
        return null
    } catch (error: any) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEBUG] ABS login failed:`, error.response?.status, error.response?.data || error.message)
        } else {
            console.error('Login failed:', error.response?.status || error.message)
        }
        return null
    }
}

export async function proxyToAudiobookshelf(req: Request, res: Response) {
    if (process.env.NODE_ENV === 'development') {
        console.log(`[DEBUG] Attempting ABS proxy for request: ${req.originalUrl}`)
    }

    if (!useProxy) {
        res.status(403).send('Forbidden')
        return
    }

    if (req.method !== 'GET') {
        res.status(405).send('Method Not Allowed')
        return
    }

    try {
        const target = new URL(req.originalUrl.replace(/^\/opds\/proxy/, ''), serverURL).toString()

        const response = await getAbsClient().get(target, {
            responseType: 'stream',
            headers: {
                'x-forwarded-proto': req.protocol,
                'x-forwarded-host': req.get('host') ?? ''
            },
            maxRedirects: 0,
            timeout: 15000,
            validateStatus: () => true
        })

        res.status(response.status)
        for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) {
                res.setHeader(key, value as any)
            }
        }

        response.data.pipe(res)
        response.data.on('error', () => {
            if (!res.headersSent) res.status(502)
            res.end()
        })
    } catch (err) {
        if (process.env.NODE_ENV === 'development') {
            console.error('[DEBUG] ABS proxy error:', err)
        }
        if (!res.headersSent) {
            res.status(502).send('Bad Gateway')
        } else {
            res.end()
        }
    }
}

function getQueryStringValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0]
    }

    return undefined
}

function getRequestHeaderValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value) && typeof value[0] === 'string') {
        return value[0]
    }

    return undefined
}

function buildAuthorizationHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`
    }
}

function buildDownloadRequestHeaders(req: Request, token: string): Record<string, string> {
    const headers = buildAuthorizationHeaders(token)
    const range = getRequestHeaderValue(req.headers.range)
    const ifRange = getRequestHeaderValue(req.headers['if-range'])

    if (range) {
        headers.Range = range
    }
    if (ifRange) {
        headers['If-Range'] = ifRange
    }

    return headers
}

function setProxyHeaders(responseHeaders: Record<string, any>, res: Response): void {
    const excludedHeaders = new Set([
        'connection',
        'content-disposition',
        'content-type',
        'keep-alive',
        'transfer-encoding'
    ])

    for (const [key, value] of Object.entries(responseHeaders)) {
        if (value !== undefined && !excludedHeaders.has(key.toLowerCase())) {
            res.setHeader(key, value as any)
        }
    }
}

function buildCoverCacheKey(itemId: string, token: string): string {
    const tokenHash = crypto.createHash('sha1').update(token).digest('hex')
    return `${itemId}:${tokenHash}`
}

function buildBufferEtag(data: Buffer): string {
    return `"${crypto.createHash('sha1').update(data).digest('hex')}"`
}

function setCoverHeaders(res: Response, cover: CachedCover): void {
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('Content-Type', cover.contentType)
    res.setHeader('Content-Length', cover.data.byteLength.toString())
    res.setHeader('ETag', cover.etag)

    if (cover.lastModified) {
        res.setHeader('Last-Modified', cover.lastModified)
    }
}

function clientHasFreshCover(req: Request, cover: CachedCover): boolean {
    return getRequestHeaderValue(req.headers['if-none-match']) === cover.etag
}

function getCachedCover(cacheKey: string): CachedCover | undefined {
    const cachedCover = coverCache.get(cacheKey)
    if (!cachedCover) {
        return undefined
    }

    if (Date.now() > cachedCover.expires) {
        coverCache.delete(cacheKey)
        return undefined
    }

    coverCache.delete(cacheKey)
    coverCache.set(cacheKey, cachedCover)
    return cachedCover
}

function cacheCover(cacheKey: string, cover: CachedCover): void {
    if (cover.data.byteLength > MAX_CACHED_COVER_BYTES) {
        return
    }

    coverCache.set(cacheKey, cover)
    while (coverCache.size > MAX_CACHED_COVERS) {
        const oldestKey = coverCache.keys().next().value
        if (!oldestKey) {
            return
        }
        coverCache.delete(oldestKey)
    }
}

export async function downloadItemFromAudiobookshelf(req: Request, res: Response) {
    if (req.method !== 'GET') {
        res.status(405).send('Method Not Allowed')
        return
    }

    const token = getQueryStringValue(req.query.token)
    if (!token) {
        res.status(401).send('Authentication required')
        return
    }

    const itemId = getQueryStringValue(req.params.itemId)
    const filenameParam = getQueryStringValue(req.params.filename)
    if (!itemId || !filenameParam) {
        res.status(400).send('Invalid download request')
        return
    }

    const requestedFilename = sanitizeFilenameBase(filenameParam)
    const format = normalizeFormat(getQueryStringValue(req.query.format))
    const extension = getDownloadExtension(format)
    const filename = requestedFilename.toLowerCase().endsWith(`.${extension}`)
        ? requestedFilename
        : `${requestedFilename}.${extension}`
    const target = new URL(`/api/items/${encodeURIComponent(itemId)}/ebook`, serverURL).toString()

    try {
        const response = await getAbsClient().get(target, {
            responseType: 'stream',
            headers: buildDownloadRequestHeaders(req, token),
            maxRedirects: 0,
            validateStatus: () => true
        })

        res.status(response.status)
        setProxyHeaders(response.headers, res)

        if (response.status >= 200 && response.status < 300) {
            res.setHeader('Content-Type', getDownloadMimeType(format))
            res.setHeader('Content-Disposition', buildContentDisposition(filename))
        }

        response.data.pipe(res)
        response.data.on('error', () => {
            if (!res.headersSent) res.status(502)
            res.end()
        })
    } catch (err) {
        if (process.env.NODE_ENV === 'development') {
            console.error('[DEBUG] ABS download proxy error:', err)
        }
        if (!res.headersSent) {
            res.status(502).send('Bad Gateway')
        } else {
            res.end()
        }
    }
}

export async function coverFromAudiobookshelf(req: Request, res: Response) {
    if (req.method !== 'GET') {
        res.status(405).send('Method Not Allowed')
        return
    }

    const token = getQueryStringValue(req.query.token)
    if (!token) {
        res.status(401).send('Authentication required')
        return
    }

    const itemId = getQueryStringValue(req.params.itemId)
    if (!itemId) {
        res.status(400).send('Invalid cover request')
        return
    }

    const cacheKey = buildCoverCacheKey(itemId, token)
    const cachedCover = getCachedCover(cacheKey)
    if (cachedCover) {
        if (clientHasFreshCover(req, cachedCover)) {
            res.status(304).end()
            return
        }

        setCoverHeaders(res, cachedCover)
        res.status(200).send(cachedCover.data)
        return
    }

    const target = new URL(`/api/items/${encodeURIComponent(itemId)}/cover`, serverURL).toString()

    try {
        const response = await getAbsClient().get(target, {
            responseType: 'arraybuffer',
            headers: buildAuthorizationHeaders(token),
            maxRedirects: 0,
            validateStatus: () => true
        })
        const data = Buffer.from(response.data)

        if (response.status < 200 || response.status >= 300) {
            res.status(response.status).send(data)
            return
        }

        const cover: CachedCover = {
            contentType: getRequestHeaderValue(response.headers['content-type']) || 'image/webp',
            data,
            etag: buildBufferEtag(data),
            expires: Date.now() + COVER_CACHE_TTL,
            lastModified: getRequestHeaderValue(response.headers['last-modified'])
        }

        cacheCover(cacheKey, cover)
        setCoverHeaders(res, cover)
        res.status(response.status).send(cover.data)
    } catch (err) {
        if (process.env.NODE_ENV === 'development') {
            console.error('[DEBUG] ABS cover proxy error:', err)
        }
        if (!res.headersSent) {
            res.status(502).send('Bad Gateway')
        } else {
            res.end()
        }
    }
}
